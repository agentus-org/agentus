// QA: the plan service — the card's TRUTH must be the server's plan object, not the transcript's
// frames.
//
//   node scripts/qa/plan-service-sweep.mjs
//
// Why this sweep exists (measured 2026-10-08, see tasks/20261001-agentus/design-plan-service.md §1):
// the operator finished a whole multi-step job and the card still read 0/5. The plan was never lost
// in the UI — it was never THERE: an agent's todo state lives in its process (Hermes' `todo_list`
// writes nothing to disk), so after a cockpit restart the frames in the transcript were the only
// copy left, and the newest of them was a stale "in progress" snapshot.
//
// What this sweep proves, in order:
//   1. an ACP plan frame reaches the SERVER's plan object (and the row is readable over the API);
//   2. the turn lifecycle closes it (terminal stamp) without the agent's help;
//   3. the pinned bar renders from that object — with the transcript's frames DELETED, which is the
//      state a restart leaves behind;
//   4. the plan's own remark (Studio's `plan-explanation`) renders from the object too.
//
// Costs no tokens: the MOCK backend emits a plan for a prompt containing `[plan]`.
const CDP = "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";   // dev instance (scripts/dev.sh start)
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const DATA = process.env.AGENTUS_DATA ?? "/tmp/agentus-qa-account";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { DatabaseSync } = await import("node:sqlite");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (m, p = {}, to = 25000) => new Promise((res, rej) => {
  const mid = ++id; const timer = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to);
  w.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
const ev = async (x, to = 25000) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, to);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};

// --- a session on the MOCK backend ---------------------------------------------------
await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
// This sweep drives the FRAME path, which is now an OPT-IN: every backend defaults to MCP-driven,
// where a frame is dropped at the door (session-manager `#framesAccepted`). Declare it on the mock
// row BEFORE opening the session — the channel rides the handshake — and put the row back at the end.
const mockRowBefore = await ev(`fetch('/api/backends/mock').then(r=>r.json())`);
await ev(`fetch('/api/backends/mock',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign(${JSON.stringify(mockRowBefore)},{nativePlanSource:'acp'}))}).then(r=>r.status)`);
const sess = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'plan sweep'})}).then(r=>r.json())`);
check("the sweep could open a mock session (no tokens are spent by this sweep)", Boolean(sess?.id), JSON.stringify(sess).slice(0, 200));
const sid = sess.id;

const status = async () => ev(`fetch('/api/sessions').then(r=>r.json()).then(d=>(d.live||[]).find(s=>s.id===${JSON.stringify(sid)})?.status||'')`).catch(() => "");
const idle = async (ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const st = await status();
    if (st !== "running" && st !== "starting") return st;
    if (Date.now() - t0 > ms) return st;
    await sleep(300);
  }
};
const promptText = async (text) => {
  await idle();
  const code = await ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:${JSON.stringify(text)}})}).then(r=>r.status)`);
  await idle(60000);
  await sleep(400);
  return code;
};
await idle();
await ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[plan] three steps, please'})}).then(r=>r.status)`);
await idle(60000);
await sleep(400);

// --- 1: the frame reached the OBJECT, which is readable over the API -----------------
const plan = await ev(`fetch('/api/sessions/${sid}/plan').then(r=>r.json()).then(d=>d.plan)`);
check("an ACP plan frame lands in the server's plan object",
  Boolean(plan) && Array.isArray(plan.items) && plan.items.length === 3, JSON.stringify(plan)?.slice(0, 220));
check("the object records who wrote it (a native frame, not the transcript)",
  plan?.source === "acp", `source=${plan?.source}`);
check("the revision moves on every write (a client can use it as a cursor)",
  typeof plan?.revision === "number" && plan.revision >= 2, `revision=${plan?.revision}`);

// --- 2: the turn lifecycle closes the card without the agent's help ------------------
check("the turn lifecycle stamps the terminal state (the agent cannot)",
  plan?.terminal === "ended", `terminal=${plan?.terminal}`);
check("no step is left pretending to run after the turn closed",
  !plan?.items.some((i) => i.status === "in_progress"),
  JSON.stringify(plan?.items?.map((i) => i.status)));

// --- 3: the bar renders from the OBJECT, with the frames GONE ------------------------
await ev(`location.href = ${JSON.stringify(BASE + "/?session=" + sid)}`);
await sleep(3200);
const barOf = () => ev(`(() => {
  const bar = document.querySelector('.plan-bar');
  const box = document.querySelector('.composer-box') ?? document.querySelector('textarea');
  const r = bar?.getBoundingClientRect(), b = box?.getBoundingClientRect();
  return {
    bar: Boolean(bar),
    count: bar?.querySelector('.plan-count')?.textContent ?? "",
    dots: bar?.querySelectorAll('.plan-dots .dot').length ?? 0,
    state: bar?.querySelector('.plan-state')?.textContent ?? "",
    aboveComposer: Boolean(r && b && r.bottom <= b.top),
    archived: document.querySelectorAll('.plan-card').length,
  };
})()`);
const waitBar = async (ms = 25000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await barOf();
    if (s.bar || Date.now() - t0 > ms) return s;
    await sleep(400);
  }
};
// Poll instead of sleeping a guessed amount: a fixed wait made this sweep flake once (the bar was
// simply not there yet 3.2s after the navigation, and the run reported "the card does not render" —
// a lie about a working feature, which is worse than no check at all).
const withFrames = await waitBar();
check("the pinned bar renders the plan", withFrames.bar, JSON.stringify(withFrames));
check("the bar counts the steps the agent listed", withFrames.dots === 3, `dots=${withFrames.dots}`);
check("the bar sits ABOVE the composer (where the operator asked for it)", withFrames.aboveComposer === true, JSON.stringify(withFrames));
check("the live plan is NOT duplicated into the transcript", withFrames.archived === 0, `cards=${withFrames.archived}`);

// Now the restart state: the transcript's frames are gone, the object is not.
// Pick the database by EVIDENCE, not by env: an inherited AGENTUS_DATA (a shell that has pointed at
// another tree all along) must not silently redirect a DB-mutating sweep at that instance's data.
// The candidate that actually holds the session we just created is the one under test. (Measured
// 2026-10-08: with a stale AGENTUS_DATA this sweep opened a database with no `plans` table at all —
// its delete matched nothing by luck, not by design.)
const { existsSync } = await import("node:fs");
const candidates = [...new Set([DATA, "/tmp/agentus-qa-account"].map((d) => `${d}/agentus.sqlite`))];
const dbPath = candidates.find((p) => {
  if (!existsSync(p)) return false;
  try {
    return Boolean(new DatabaseSync(p).prepare("select id from sessions where id = ?").get(sid)?.id);
  } catch {
    return false;
  }
});
check(`the sweep found the database of the instance under test`,
  Boolean(dbPath), `looked in ${candidates.join(", ")}`);
if (!dbPath) {
  console.log("\nplan-service-sweep: refusing to touch a database that does not hold the session it is testing");
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
db.exec(`delete from messages where session_id='${sid}' and kind='plan'`);
const REMARK = "范围改了：先只修计时断言，不再重构 harness";
db.prepare("update plans set explanation=? where session_id=?").run(REMARK, sid);
const left = db.prepare("select count(*) c from messages where session_id=? and kind='plan'").get(sid).c;
check("the sweep really removed the frames it claims to have removed", left === 0, `frames left=${left}`);

await ev(`location.href = ${JSON.stringify(BASE + "/?session=" + sid)}`);
await sleep(1500);
const noFrames = await waitBar();
check("with every plan frame deleted, the card still renders (it reads the object)",
  noFrames.bar === true, JSON.stringify(noFrames));
check("…and it renders the same plan, not an empty one", noFrames.dots === 3, `dots=${noFrames.dots}`);

// --- 4: the plan's own remark -------------------------------------------------------
await ev(`document.querySelector('.plan-bar .plan-head')?.click()`);
await sleep(600);
const remark = await ev(`document.querySelector('.plan-bar .plan-explanation')?.textContent ?? ""`);
check("the plan's own remark (why this update / scope change) renders under the steps",
  remark === REMARK, JSON.stringify(remark).slice(0, 120));

// --- 5: a RESTARTED agent is handed the plan, exactly once ---------------------------
// The point of the whole service: the agent's own todo state dies with its process, so without this
// hand-over a resumed agent starts from nothing and quietly re-does (or abandons) the work. The
// block is ACP's own `resource` — structured and attributable, NOT a line of fake user speech.
// `POST /restart` swaps the agent process under the slot, which is the same code path a cockpit
// restart takes (a fresh LiveSession arms `planReminderPending`), without this sweep having to kill
// the server it is testing.
const blocksOfLastTurn = async () => {
  const { messages } = await ev(`fetch('/api/sessions/${sid}/messages?tail=1').then(r=>r.json())`);
  for (const m of [...(messages ?? [])].reverse()) {
    const t = typeof m?.payload?.content?.text === "string" ? m.payload.content.text : "";
    if (!t.startsWith("BLOCKS ")) continue;
    try { return JSON.parse(t.slice(7)); } catch { return []; }
  }
  return null;
};
await ev(`fetch('/api/sessions/${sid}/restart',{method:'POST'})`);
await sleep(2500);
await promptText("[blocks] carry on");
const handed = await blocksOfLastTurn();
check("a restarted agent receives the plan hand-over",
  Array.isArray(handed) && handed.some((b) => b.type === "resource"), JSON.stringify(handed)?.slice(0, 240));
const res1 = Array.isArray(handed) ? handed.find((b) => b.type === "resource") : null;
check("…as a STRUCTURED resource block, not as fake user speech (the uri names the plan)",
  String(res1?.resourceUri ?? "").startsWith("agentus://plan/"), `uri=${res1?.resourceUri}`);
check("…carrying the steps still owed",
  /patch the flaky timing assert/.test(String(res1?.body ?? "")), String(res1?.body ?? "").slice(0, 140));
check("…tagged in `_meta` so we can tell it from the operator's own words",
  res1?.meta?.["agentus/plan-reminder"] === true, JSON.stringify(res1?.meta));
await promptText("[blocks] again");
const second = await blocksOfLastTurn();
check("the hand-over happens ONCE per agent process, not on every turn",
  Array.isArray(second) && second.length === 1, JSON.stringify(second)?.slice(0, 180));

await ev(`fetch('/api/backends/mock',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign(${JSON.stringify(mockRowBefore)},{nativePlanSource:${JSON.stringify(mockRowBefore?.nativePlanSource ?? "none")}}))}).then(r=>r.status)`).catch(() => null);
console.log(`\nplan-service-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
