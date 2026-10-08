// QA: a turn must reach its FINISHED shape on its own — no stale live window, no lingering
// 「turn in progress」 — and it must do so while the transcript is BIG.
//
// The failures this guards (operator report 2026-10-08, reproduced and fixed the same day):
//   ① 「这轮已经结束了，通知我都收到了，但页面还在一直刷新并渲染工具执行和思考过程，还没到最后的大模型输出」
//      — measured: the live 「思考中…」 window and the 「▸ turn in progress…」 line stayed on screen for
//      150s+ AFTER the server said ready, and only a hard reload cleared them. Root cause: the marking
//      was inferred from the row's POSITION in the fold ("the last row, while busy"), so it pointed at
//      a block that never arrives again; and every delta frame re-opened the `open` flag even after
//      turn-end. Fix: `open` is data (set while busy, cleared by turn-end / a history read) and the
//      renderer reads it from the row, never from position.
//   ② 「强制刷新下页面才会刷新到最后的完结状态」 — a reload must never be the only way out.
//
// Drives the user's Edge over CDP. Requires the scratch instance on :8901 (with auth) and mock backend.
//   node scripts/qa/render-lag-sweep.mjs        (BATCH=<n> turns, SEED=<rows> transcript size)
import { DatabaseSync } from "node:sqlite";

const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const QADB = process.env.AGENTUS_DATA ? `${process.env.AGENTUS_DATA}/agentus.sqlite` : "/tmp/agentus-qa-account/agentus.sqlite";
const SEED = Number(process.env.SEED ?? 300);   // rows of history before the measured turn
const BATCH = Number(process.env.BATCH ?? 4);   // how many turns to check
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// A probe that leaks its tab leaves a LIVE page behind: nineteen of them left the renderer with no
// headroom and made the NEXT run time out on `Page.navigate` — a failure that looks like the product
// crawling when it is only the test bench full. Sweep our own leftovers first.
{
  const tabs = await (await fetch(`${CDP}/json/list`)).json().catch(() => []);
  const mine = tabs.filter((x) => x.type === "page" && String(x.url).startsWith(BASE));
  for (const x of mine) await fetch(`${CDP}/json/close/${x.id}`).catch(() => { });
  if (mine.length) console.log(`closed ${mine.length} leftover QA tab(s) before starting`);
}

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2000);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res) => { ws.onopen = res; });
let id = 0; const w = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); } };
const send = (m, p = {}, to = 20000) => new Promise((res, rej) => { const mid = ++id; const timer = setTimeout(() => { w.delete(mid); rej(new Error("TIMEOUT " + m)); }, to); w.set(mid, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: BASE });
await sleep(2500);
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };

// ---- fixture: one session with a transcript as big as a working slot's -------------------------
const { authHeaders } = await import("../lib/auth.mjs");
const auth = { ...authHeaders() };
const sid = await fetch(`${BASE}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ backend: "mock", cwd: "/tmp" }),
}).then((r) => r.json()).then((s) => s.id);
// Wait until the fixture is REAL before judging anything: the page opens by reading the transcript,
// and rows written after that read are not in the picture (an earlier version of this script judged a
// 300-row fixture whose rows the page had never seen — a false red about the product).
const fixtureRows = async () => {
  const r = await fetch(`${BASE}/api/sessions/${sid}/messages?tail=1`, { headers: auth }).catch(() => null);
  if (!r || !r.ok) return 0;
  return ((await r.json()).messages ?? []).length;
};
console.log(`fixture session ${sid} (seeding ${SEED} rows)`);
{
  const db = new DatabaseSync(QADB);
  const ins = db.prepare("insert into messages (seq, session_id, kind, payload, tool_call_id, block_key, created_at) values (?,?,?,?,?,?,?)");
  const now = Date.now();
  const body = (i) => `第 ${i} 段回答：这一整段文字故意写长一点，让每个气泡都有真实的高度，`
    + `这样页面渲染一屏就有真正的工作量——短行会让渲染成本看起来比实际小得多。`.replace(/\s+/g, "");
  let seq = 0;
  const n = Math.ceil(SEED / 4);
  for (let i = 1; i <= n; i++) {
    ins.run(++seq, sid, "user", JSON.stringify({ text: `问题 ${i}` }), null, null, now - (SEED - seq) * 1000);
    ins.run(++seq, sid, "thought", JSON.stringify({ sessionUpdate: "agent_thought_chunk", messageId: `seed-th-${i}`, content: { type: "text", text: body(i) } }), null, `thought:seed-th-${i}`, now - (SEED - seq) * 1000);
    ins.run(++seq, sid, "tool", JSON.stringify({ sessionUpdate: "tool_call", toolCallId: `seed-tc-${i}`, title: `terminal: node scripts/probe-${i}.mjs`, status: "completed", rawOutput: "ok" }), `seed-tc-${i}`, null, now - (SEED - seq) * 1000);
    ins.run(++seq, sid, "agent", JSON.stringify({ sessionUpdate: "agent_message_chunk", messageId: `seed-m-${i}`, content: { type: "text", text: body(i) } }), null, `agent:seed-m-${i}`, now - (SEED - seq) * 1000);
  }
  db.close();
}
await ev(`fetch(${JSON.stringify(BASE + "/api/auth/login")},{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then((r)=>r.status)`);
{
  const want = Math.floor(SEED / 4); // one user row per seeded group is enough to prove the write
  for (let i = 0; i < 40; i++) {
    const n = await fixtureRows();
    if (n >= want * 4) break;
    await sleep(250);
  }
  const n = await fixtureRows();
  if (n < want * 4) { console.error(`fixture never landed: ${n} rows`); process.exit(1); }
}
await ev(`location.href = ${JSON.stringify(BASE + "/?session=")} + ${JSON.stringify(sid)}`);
// Wait for the FIXTURE to be on screen, not just for a quiet moment: a new tab lands on whatever slot
// the app opens by default, so "the page has rows" proves nothing until those rows are the fixture's.
let mounted = 0;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  mounted = await ev("document.querySelectorAll('.stream-inner > *').length").catch(() => 0);
  if (mounted > 50) break;
}
if (mounted <= 50) {
  console.error(`the fixture never opened in the page (rows=${mounted}); refusing to judge the product on an empty screen`);
  process.exit(1);
}
await ev(`window.__sid = ${JSON.stringify(sid)}`);

/** one snapshot of what the operator would see */
const shape = () => ev([
  "(() => {",
  "  const inner = [...document.querySelectorAll('.stream-inner > *')];",
  "  const last = inner[inner.length - 1];",
  "  return { rows: inner.length, sid: window.__sid,",
  "    live: Boolean(document.querySelector('.msg.thought.live, .msg.agent.live')) || /思考中|thinking/i.test((document.querySelector('.thought-head') || {}).textContent || ''),",
  "    hint: /turn in progress|still waiting/i.test(document.body.innerText),",
  "    dom: document.querySelectorAll('*').length,",
  "    lastText: last ? (last.textContent || '').replace(/\\\\s+/g, ' ').trim() : '' };",
  "})()",
].join("\n"));
let pageSays = async () => {
  const r = await fetch(`${BASE}/api/sessions/${sid}`, { headers: auth }).catch(() => null);
  if (!r || !r.ok) return "?";
  return (await r.json()).status;
};
const idle = () => new Promise((r) => setTimeout(r, 250));

// The page counts its own frames and watches its OWN main thread: from the wire it learns when the
// server said the turn is over, and from its render loop when the finished shape actually appeared.
// Polling from Node instead cannot tell "the page is behind" from "my poll is late".
await ev([
  "(() => {",
  "  window.__lag = { frames: 0, first: 0, last: 0, done: 0, started: 0, word: '', live: false, hint: false, rows: 0, lastText: '' };",
  "  const shape = () => {",
  "    const inner = [...document.querySelectorAll('.stream-inner > *')];",
  "    const last = inner[inner.length - 1];",
  "    return { live: Boolean(document.querySelector('.msg.thought.live, .msg.agent.live')),",
  "      hint: Boolean(document.querySelector('.stream-hint')), rows: inner.length,",
  "      lastText: last ? (last.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : '' };",
  "  };",
  "  window.__shape = shape;",
  "  const tick = (t) => { const g = window.__lag; g.frames++; g.last = t; if (!g.first) g.first = t;",
  "    const s = shape(); g.live = s.live; g.hint = s.hint; g.rows = s.rows; g.lastText = s.lastText;",
  "    if (s.live || s.hint) { g.started = t; }",
  "    const answered = Boolean(g.word) && String(s.lastText).includes(g.word);",
  "    if (g.started && !s.live && !s.hint && answered && !g.done) g.done = t;",
  "    window.requestAnimationFrame(tick); };",
  "  window.requestAnimationFrame(tick);",
  "  return 'armed';",
  "})()",
].join("\n"));

const opened = await shape();
const seededRows = await fixtureRows();
// A folded transcript shows FEWER rows than the store holds — one work row stands for a turn's
// thinking + calls — so the bar is "most of what the reader can show", not "most of what was seeded".
// (Demanding 90% of the seeded count was a false red: 300 stored rows fold into ~225 screen rows.)
check("a big transcript really opened (the lag only shows itself at size)",
  opened.rows >= Math.min(seededRows, 500) * 0.6, `rows=${opened.rows} shown of ${seededRows} seeded, dom=${opened.dom}`);
check("…and a finished transcript has no live window or waiting line",
  !opened.live && !opened.hint, JSON.stringify(opened));

// ---- the measured turns: does each one END on its own? ----------------------------------------
let worstClear = -1;   // -1 = "never observed a clean hand-off"; a passing run proves otherwise
let everStuck = "";
for (let run = 1; run <= BATCH; run++) {
  const word = `probe-${run}-${Date.now() % 100000}`;
  // Arm the run: forget the previous turn's hand-off so this run is measured on its own evidence.
  await ev(`Object.assign(window.__lag, { done: 0, started: 0, word: ${JSON.stringify(word)} });`);
  await ev(`fetch(${JSON.stringify(BASE + "/api/sessions/")} + ${JSON.stringify(sid)} + '/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:${JSON.stringify("[think] " + word)}})}).then((r)=>r.status)`);
  // the finish line: the page is showing the answer, with the live window and the waiting line gone.
  let sawLive = false;
  const readLag = () => ev("({ ...window.__lag })");
  for (let i = 0; i < 900; i++) {
    await sleep(100);
    const g = await readLag();
    if (g.live) sawLive = true;
    if (g.done && String(g.lastText).includes(word)) break;
  }
  const g = await readLag();
  // How long the STREAMING SHAPE lingered past the moment the reply was on screen. That interval is
  // the operator's complaint: "早就结束了的轮次还一直在渲染中间过程".
  const clearSec = g.done && g.started ? (g.done - g.started) / 1000 : -1;
  if (clearSec >= 0) worstClear = Math.max(worstClear, clearSec);
  const ok = Boolean(g.done);
  if (!ok) everStuck = `run ${run}: the page never left the streaming shape (live=${g.live} hint=${g.hint} last=${String(g.lastText).slice(0, 40)})`;
  console.log(`  run ${run}: streamed=${sawLive} frames=${g.frames}`
    + `, settled ${clearSec < 0 ? "NEVER" : clearSec.toFixed(2) + "s after the turn began"}`);
  await idle();
}
check("every turn ended on its own — the page never needed a reload", !everStuck, everStuck);
check("…and it left the streaming shape within 20s of the turn beginning", worstClear >= 0 && worstClear <= 20,
  `worst = ${worstClear < 0 ? "never" : worstClear.toFixed(1) + "s"}`);
check("…with the live window and the waiting line both gone", !(await shape()).live && !(await shape()).hint,
  JSON.stringify(await shape()));

// ---- and a reload shows the same thing (the two paths must agree) -----------------------------
await send("Page.navigate", { url: `${BASE}/?session=${sid}` });
// Same rule as the opening read: wait for the fixture to be ON SCREEN, not just for the navigation to
// finish. 3.5s was enough on an idle machine and not on a busy one — a flaky fixture check, not a bug.
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if ((await ev("document.querySelectorAll('.stream-inner > *').length").catch(() => 0)) > 50) break;
}
const after = await shape();
check("a reload shows the same finished shape (the cheap path and the streamed path agree)",
  !after.live && !after.hint && after.rows >= 6, JSON.stringify(after));

try { await fetch(`${CDP}/json/close/${t.id}`); } catch { /* tab already gone */ }
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
