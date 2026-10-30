// #74 端到端：新建会话时，对话框的选择与第一句话是**背靠背两帧**发出去的。
//
// 这一条跑的是真槽位、真 agent（dev :8901 上跑的是 fork 源码），复刻页面在 `ready` 那一刻做的事：
//   set-model(fromReplay) → prompt
// 然后只问三件事（都是操作者能看见的东西）：
//   1. 有没有出现「Queued for the next turn.」那一句假回答；
//   2. 这一轮有没有 turn-start / turn-end（停止按钮、rail 呼吸、未读点、完成通知都靠这一对帧）；
//   3. 挑的模型有没有真的生效（会话的 currentModelId 等于挑的那个），而不是静默跑回默认。
//
// 判据取自服务端自己的账：/api/sessions/:id/messages 里必须有 turn-usage 行且 available，
// 会话行 status 必须回到 ready（fake turn 之后 status 也会 ready，所以必须同时看 turn-usage）。
//
//   node scripts/qa/first-turn-pick.mjs            # 默认 8901，跑 3 轮
//   AGENTUS_QA_ROUNDS=5 node scripts/qa/first-turn-pick.mjs
//
// 依赖：dev 实例在跑、/tmp/agentus-qa-account/auth.token 可读（scripts/dev.sh 起的默认数据目录）。
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const BASE = process.env.AGENTUS_QA_BASE ?? "http://127.0.0.1:8901";
const DATA = process.env.AGENTUS_QA_DATA ?? "/tmp/agentus-qa-account";
const ROUNDS = Number(process.env.AGENTUS_QA_ROUNDS ?? 3);
const CWD = process.env.AGENTUS_QA_CWD ?? "/tmp/agentus-first-turn-qa";
const PICK = process.env.AGENTUS_QA_MODEL ?? "";

fs.mkdirSync(CWD, { recursive: true });
const token = fs.readFileSync(path.join(DATA, "auth.token"), "utf8").trim();
const auth = { Authorization: `Bearer ${token}` };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const api = async (p, init = {}) => {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: { ...auth, "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
};

/** What the start page would replay: the backend's cached handshake for the picker. */
async function pickerModel() {
  if (PICK) return PICK;
  const { body } = await api("/api/backends");
  const rows = Array.isArray(body) ? body : (body.backends ?? []);
  const hermes = rows.find((r) => r.id === "hermes");
  const hs = hermes?.handshake?.models;
  const list = hs?.available ?? [];
  /* Prefer a NON-default entry: the bug is "your pick was dropped", which a default pick hides.
   *
   * …but prefer a CHEAP one among them. This script runs REAL prompts against a ~97k-token system
   * prompt, and "the first non-default" was `deepseek:deepseek-v4-pro`: 13 QA sessions on
   * 2026-10-29/30, 121 calls, ~10.7M input tokens billed to the operator's DeepSeek account — found
   * on his invoice, not in any log he reads. A picker only has to be non-default; it does not have
   * to be the expensive one. Override with AGENTUS_QA_MODEL when a specific model is under test. */
  const others = list.filter((id) => id !== hs?.currentModelId);
  /* Rank, don't take the first: a QA run must exercise a NON-DEFAULT pick, and nothing else. Cheapest
   * first — subscription/local providers (qoder, lab, the coding plan) before metered ones, `flash`/
   * `mini`-class before everything else. */
  const LOCAL = ["custom:qoder:", "custom:lab:", "alibaba-coding-plan:"];
  // a WHOLE segment, so `MiniMax` is not read as "mini" (it was, and it won the cheap slot)
  const CHEAP = /(?:^|[:_/.-])(flash|mini|turbo|lite)(?:$|[:_/.-])/i;
  // same provider first (that is the routing the page would exercise), then subscription/local, then
  // the rest; inside each band, the cheap family first.
  const provider = (id) => (id.startsWith("custom:") ? id.split(":").slice(0, 2).join(":") : id.split(":")[0]);
  const here = provider(hs?.currentModelId ?? "");
  const band = (id) => (provider(id) === here ? 0 : LOCAL.some((p) => id.startsWith(p)) ? 2 : 4);
  const rank = (id) => band(id) + (CHEAP.test(id) ? 0 : 1);
  return [...others].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] ?? list[0] ?? "";
}

async function oneRound(n, pick) {
  const text = `第 ${n} 轮：只回答 OK 两个字母，不要用工具。`;
  const frames = [];
  const pid = `qa-first-turn-${n}-${Date.now()}`;

  // LISTEN FIRST: a cold spawn can reach `ready` before the POST returns, and a probe that only
  // starts listening afterwards waits forever for a transition that already happened.
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?token=${encodeURIComponent(token)}`);
  let closed = "";
  // Attach BEFORE waiting for `open`: the server sends `hello` + `sessions` the instant the socket
  // is up, and a listener attached after that promise resolves can miss them.
  ws.on("message", (raw) => {
    try { frames.push(JSON.parse(String(raw))); } catch { /* not a frame we care about */ }
  });
  ws.on("close", (code, reason) => { closed = `${code} ${String(reason)}`; });
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", resolve);
  });

  const created = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "hermes", cwd: CWD }) });
  if (created.status !== 201) {
    check(`round ${n}: session created`, false, `${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);
    ws.close();
    return;
  }
  const id = created.body.id;

  // The page waits for its own `ready` row, then replays the picks and releases the queue — two
  // frames in one tick, which is exactly the interleaving ACP does not preserve on its own.
  const ready = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 180_000);
    const tick = setInterval(() => {
      // A `session` row, or the snapshot the socket opens with: the spawn may be ready before we
      // connect, and a probe that only listens for the transition would wait forever.
      const hit = frames.find((f) => f.t === "session" && f.session?.id === id && f.session?.status === "ready")
        ?? frames.find((f) => f.t === "sessions" && (f.sessions ?? []).some((s) => s.id === id && s.status === "ready"));
      if (hit) { clearInterval(tick); clearTimeout(t); resolve(true); }
    }, 100);
  });
  if (!ready) {
    check(`round ${n}: the slot came up`, false,
      `no ready frame in 180s (frames=${frames.length}${closed ? `, closed=${closed}` : ""})`);
    ws.close();
    return;
  }

  if (pick) ws.send(JSON.stringify({ t: "set-model", sessionId: id, modelId: pick, fromReplay: true }));
  ws.send(JSON.stringify({ t: "prompt", sessionId: id, text, pid }));

  // Wait for the turn to end (or for the fake-turn shape to show up).
  const ended = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), 180_000);
    const tick = setInterval(() => {
      if (frames.some((f) => f.t === "turn-end" && f.sessionId === id)) {
        clearInterval(tick); clearTimeout(t); resolve("end");
      }
    }, 100);
  });

  // Give the fake-turn path a beat to land its 'Queued' bubble, then read the server's own ledger.
  await new Promise((r) => setTimeout(r, 1200));
  const msgs = await api(`/api/sessions/${id}/messages`);
  const rows = msgs.body?.messages ?? [];
  const texts = rows.map((m) => JSON.stringify(m.payload ?? {})).join("\n");

  const queuedBubble = /Queued for the next turn/i.test(texts);
  // The prompt is tagged with a pid; the turn that answers it must echo it (that is what proves the
  // operator's frame landed) — and if the server held it behind the model switch, it said so.
  const heldFrames = frames.filter((f) => f.t === "prompt-held" && f.sessionId === id).length;
  const pidEchoed = frames.some((f) => f.t === "turn-start" && f.sessionId === id && f.pid === pid);
  const usage = rows.filter((m) => m.kind === "turn-usage").pop();
  const turnStarts = frames.filter((f) => f.t === "turn-start" && f.sessionId === id).length;
  const userRows = rows.filter((m) => m.kind === "user");
  const info = (await api("/api/sessions")).body;
  const row = [...(info.live ?? []), ...(info.cold ?? [])].find((s) => s.id === id);

  console.log(`  · round ${n}: turn-end=${ended} starts=${turnStarts} usage=${JSON.stringify(usage?.payload ?? null)} ` +
    `current=${row?.models?.currentModelId ?? "?"} pick=${pick || "(none)"}`);

  check(`round ${n}: the first message was not "queued" (no fake turn)`, !queuedBubble);
  check(`round ${n}: the turn had a start frame`, turnStarts >= 1, String(turnStarts));
  check(`round ${n}: the turn billed a usage row`, Boolean(usage && usage.payload?.available !== false),
    JSON.stringify(usage?.payload ?? null));
  check(`round ${n}: the operator's sentence is in the transcript exactly once`, userRows.length === 1,
    String(userRows.length));
  check(`round ${n}: the turn proves it belongs to this prompt (pid echoed)`, pidEchoed);
  if (heldFrames) console.log(`  · round ${n}: the server held the prompt behind the pick (${heldFrames} frame(s))`);
  if (pick && row) {
    check(`round ${n}: the picked model is the one in force`, row.models?.currentModelId === pick,
      `${row.models?.currentModelId} vs ${pick}`);
  }

  ws.close();
  // Leave the QA slot cold so the next round starts clean: close (not purge) keeps the transcript,
  // which is the evidence above.
  await api(`/api/sessions/${id}`, { method: "DELETE" });
}

const pick = await pickerModel();
console.log(`target ${BASE} · pick=${pick || "(nothing cached)"} · rounds=${ROUNDS}`);
for (let i = 1; i <= ROUNDS; i += 1) await oneRound(i, pick);

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
