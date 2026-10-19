// QA: both "cards that ask" must SURVIVE as transcript rows — the approval a request made and the
// decision that answered it, and the project-skills notice a repo earned.
//
//   node scripts/qa/cards-persist.mjs <untrusted-repo>
//
// Two earlier defects this pins down:
//   1. an approval lived only in `v.perms` (a transient event): the modal covered the screen, the
//      operator answered, and NOTHING was left in the conversation — no later way to see what had
//      been asked or what had been allowed;
//   2. the project-skills notice was a status line that flashed once at session open.
//
// Runs against the DEV instance (:8901) with the MOCK backend for the approval half (a `[tool]`
// prompt makes the mock send a real `session/request_permission`), so it costs no tokens.
import fs from "node:fs";
import WebSocket from "ws";

const TOKEN = fs.readFileSync("/tmp/agentus-qa-account/auth.token", "utf8").trim();
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const repo = process.argv[2];
if (!repo) throw new Error("usage: node scripts/qa/cards-persist.mjs <untrusted-repo-with-skills>");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const ws = new WebSocket(`ws://127.0.0.1:8901/ws?token=${encodeURIComponent(TOKEN)}`);
const frames = [];
ws.on("message", (raw) => { try { frames.push(JSON.parse(String(raw))); } catch {} });
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

const until = async (fn, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(200); }
  return null;
};
const rows = async (sid) =>
  (await (await fetch(`${BASE}/api/sessions/${sid}/messages?tail=1`, { headers: auth })).json()).messages ?? [];

// ---------------------------------------------------------------- approval: row + decision
const mk = async (backend, cwd, title) =>
  (await (await fetch(`${BASE}/api/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ backend, cwd, title }) })).json());

const a = await mk("mock", "/tmp", "cards sweep");
console.log("mock session:", a.id, a.status);
// A freshly created session is `starting` for a moment; a prompt sent that early is refused
// ("session not ready") and the turn is simply lost.
await until(() => frames.some((f) => f.t === "session" && f.session?.id === a.id && f.session?.status !== "starting"), 20_000);
ws.send(JSON.stringify({ t: "prompt", sessionId: a.id, text: "[tool] write the file" }));

const asked = await until(() => frames.find((f) => f.t === "message" && f.message?.sessionId === a.id && f.message.kind === "approval"));
check("审批请求一到就写成一条消息帧", Boolean(asked), asked ? `seq=${asked.message.seq}` : "没有 message 帧");
check("这条帧里带着待答的请求本身", Boolean(asked?.message.payload?.requestId && asked?.message.payload?.options?.length),
  JSON.stringify(asked?.message.payload?.options?.map((o) => o.kind)));
check("决定还没发生时为 null（不是猜一个）", asked?.message.payload?.decision === null, String(asked?.message.payload?.decision));

const stored = await rows(a.id);
const storedRow = stored.find((m) => m.kind === "approval" && m.payload.requestId === asked?.message.payload.requestId);
check("刷新/换设备读回来的历史里有这一行", Boolean(storedRow), `rows=${stored.length}`);
check("历史里的 payload 与推送的一致", storedRow?.seq === asked?.message.seq, `${storedRow?.seq} vs ${asked?.message.seq}`);

// answer it, the way the card's button does
const opt = asked.message.payload.options.find((o) => o.kind === "allow_once") ?? asked.message.payload.options[0];
ws.send(JSON.stringify({
  t: "respond-permission", sessionId: a.id, requestId: asked.message.payload.requestId,
  decision: { outcome: "selected", optionId: opt.optionId },
  optionKind: opt.kind,
}));
const decided = await until(() => frames.find((f) => f.t === "message" && f.message?.sessionId === a.id
  && f.message.kind === "approval" && f.message.payload?.decision));
check("答复落在同一行（seq 不变，不是新加一行）", decided?.message.seq === asked.message.seq, `${decided?.message.seq} vs ${asked.message.seq}`);
check("行上记着答的是哪个选项", decided?.message.payload.decision?.optionId === opt.optionId, JSON.stringify(decided?.message.payload.decision));

const after = (await rows(a.id)).filter((m) => m.kind === "approval");
check("库里只有这一行审批卡（没有堆第二张）", after.length === 1, `${after.length} rows`);
check("库里的决定不是 null", Boolean(after[0]?.payload?.decision), JSON.stringify(after[0]?.payload?.decision));

// ---------------------------------------------------------------- project skills: card + decision
const p = await mk("hermes", repo, "skills sweep");
console.log("hermes session:", p.id, p.status);

const notice = await until(() => frames.find((f) => f.t === "message" && f.message?.sessionId === p.id && f.message.kind === "project-skills"), 40_000);
check("未启用的项目 skill 也落成一条消息帧", Boolean(notice), notice ? JSON.stringify(notice.message.payload) : "没有");
check("它带着 root / count / 初始 state=ask", notice?.message.payload?.state === "ask" && typeof notice?.message.payload?.count === "number",
  `${notice?.message.payload?.root} count=${notice?.message.payload?.count}`);
check("不再发那条一闪而过的 status 帧", !frames.some((f) => f.t === "status" && f.statusKind === "project-skills"));

ws.send(JSON.stringify({ t: "set-config", sessionId: p.id, configId: "project_skills", value: "trusted" }));
const flipped = await until(() => frames.find((f) => f.t === "message" && f.message?.sessionId === p.id
  && f.message.kind === "project-skills" && f.message.payload?.state === "trusted"), 20_000);
check("信任之后卡本身改口（同一 seq）", flipped?.message.seq === notice.message.seq, `${flipped?.message.seq} vs ${notice?.message.seq}`);

const prow = (await rows(p.id)).filter((m) => m.kind === "project-skills");
check("库里的那张卡也是 trusted（重开还看得见）", prow[0]?.payload?.state === "trusted", `${prow.length} rows`);

ws.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
