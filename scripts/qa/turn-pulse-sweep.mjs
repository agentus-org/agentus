// QA: the turn's state in the chat head — a breathing dot beside the session title.
//
// THE LINE AT THE TRANSCRIPT TAIL IS A DIFFERENT SWEEP. Two static text lines used to sit at the end
// of every transcript (`▸ turn in progress…`, `⏳ still waiting for the agent…`); the operator deleted
// them (「太占地方了… 下面的按钮显示终止态其实就能看出来在运行」) and a zero-height dot took over the half
// worth keeping — «this turn has gone QUIET». He then asked for the tail line back as ONE row carrying
// the elapsed time (see `turn-line-sweep.mjs` for that, content and clock included).
//
// This one asserts the DOT: its GREEN/AMBER decision is unit-tested with an injected clock
// (`scripts/qa/turn-pulse.mts`) — a browser sweep cannot wait 60s — so the render side is checked
// here, plus the fact that the two DELETED strings are really gone from the page (a deletion is a
// claim about what is NOT there, so it needs its own check).
//
//   PORT=8901 node scripts/qa/turn-pulse-sweep.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8901}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2000);
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
await send("Page.enable"); await send("Runtime.enable");

try {
  const login = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`QA login returned ${login} — is this the QA/dev instance? (AGENTUS_DATA)`);
  const sid = (await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp'})}).then(r=>r.json())`))?.id;
  if (!sid) throw new Error("could not create the probe session");
  await sleep(400);
  await ev(`location.href = ${JSON.stringify(BASE)} + '/?session=' + ${JSON.stringify(sid)}`).catch(() => {});
  const waitFor = async (expr, ms = 12_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await ev(expr).catch(() => 0)) return true; await sleep(300); }
    return false;
  };
  check("the probe session is open (a failure here is setup, not the dot)", await waitFor(`document.querySelector('.composer textarea') && document.querySelector('[data-session="' + ${JSON.stringify(sid)} + '"].active') ? 1 : 0`));

  // ---- before the turn: no dot, and the tail carries no hint line ------------------------------
  const idle = await ev(`(() => ({ dot: document.querySelectorAll('.chat-head .turn-pulse').length,
    hints: document.querySelectorAll('.stream-hint').length,
    tailText: (document.querySelector('.stream-inner')?.textContent ?? '') }))()`);
  check("an idle session draws no turn dot", idle.dot === 0, `${idle.dot}`);
  check("…and its transcript tail has no turn-hint line", idle.hints === 0 && !/turn in progress|still waiting for the agent/.test(idle.tailText), `hints=${idle.hints}`);

  // ---- while the turn runs: the dot is there, breathing, and the head does not grow ------------
  const sent = await ev(`fetch('/api/sessions/'+${JSON.stringify(sid)}+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[slow] turn pulse'})}).then(r=>r.status)`);
  check("the probe turn was accepted", sent === 202, `HTTP ${sent}`);
  const appeared = await waitFor(`document.querySelector('.chat-head .turn-pulse') ? 1 : 0`, 10_000);
  check("a running turn puts the dot in the chat head", appeared);
  const live = await ev(`(() => {
    const d = document.querySelector('.chat-head .turn-pulse');
    if (!d) return {};
    const head = document.querySelector('.chat-head');
    return { anim: getComputedStyle(d).animationName, cls: d.className, bg: getComputedStyle(d).backgroundColor,
             said: d.getAttribute('title') ?? '', aria: d.getAttribute('aria-label') ?? '',
             headH: Math.round(head.getBoundingClientRect().height),
             rows: document.querySelectorAll('.stream-hint').length };
  })()`);
  check("the dot breathes (house `pulse`, not a new animation)", (live.anim ?? "").includes("pulse"), `animation=${live.anim}`);
  check("it starts in the working state", !/quiet/.test(live.cls ?? ""), live.cls);
  check("its tooltip names the state (no numbers while output flows)", /正在工作/.test(live.said ?? ""), live.said);
  check("it is exposed to assistive tech (role=status + a label)", (live.aria ?? "").length > 0 && /正在工作/.test(live.aria), live.aria);
  // The tail carries ONE line again — the operator asked for it back (「显示处理中，并显示已经处理的时长」),
  // so this sweep's job is the DOT: the line's own content, its spinner and the way its clock counts
  // from the send are asserted in `scripts/qa/turn-line-sweep.mjs`. What must stay true HERE is that
  // the two DELETED strings never come back.
  check("the tail carries one hint line, not the deleted pair", live.rows === 1, `hints=${live.rows}`);
  check("…and neither deleted string appears anywhere on the page",
    !/turn in progress|still waiting for the agent/.test((await ev(`document.body.textContent`)) ?? ""));
  check("the head did not grow because of it (one row, 46px floor)", live.headH <= 60, `head=${live.headH}px`);

  // ---- the ESCALATION, with the page's own clock advanced -------------------------------------
  // The state is `turnPulseState(v.lastAt, Date.now())` — a function of MEASURED silence — and its
  // 60s boundary is unit-tested with an injected `now` (`turn-pulse.mts`). Here the same injection is
  // done to the page's clock, which is the only way to see the amber dot without waiting a real
  // minute: nothing is faked, the clock is MOVED. Then it is restored and the dot must go back to
  // green — that is what proves the colour rides the silence rather than a one-shot timer.
  const quiet = await ev(`(() => {
    window.__realNow = Date.now;
    Date.now = () => window.__realNow() + 90_000;
    return 1;
  })()`);
  check("the page clock was advanced (the injection landed)", quiet === 1);
  await sleep(1400); // one tick of the dot's own interval
  const amber = await ev(`(() => { const d = document.querySelector('.chat-head .turn-pulse'); return d ? { cls: d.className, bg: getComputedStyle(d).backgroundColor, said: d.getAttribute('title') ?? '' } : {}; })()`);
  check("silence past the threshold turns the dot amber (colour, not a second element)", /quiet/.test(amber.cls ?? ""), `${amber.cls} bg=${amber.bg}`);
  check("…with the silence named in the tooltip", /1 分 3\d 秒/.test(amber.said ?? "") && /停止/.test(amber.said ?? ""), amber.said);
  {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const dir = process.env.SHOTS ?? "/Users/liang/Workspace/agent-dev-workspace/tasks/20261001-agentus/screens";
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/turn-pulse-quiet.png`, Buffer.from(shot.data, "base64"));
    console.log(`      screenshot ${dir}/turn-pulse-quiet.png`);
  }
  await ev(`Date.now = window.__realNow; 1`);
  await sleep(1400);
  const back = await ev(`(() => { const d = document.querySelector('.chat-head .turn-pulse'); return d ? d.className : ''; })()`);
  check("restoring the clock brings it back to green (the state is measured, not latched)", !/quiet/.test(back ?? ""), back);
  try {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const dir = process.env.SHOTS ?? "/Users/liang/Workspace/agent-dev-workspace/tasks/20261001-agentus/screens";
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/turn-pulse.png`, Buffer.from(shot.data, "base64"));
    console.log(`      screenshot ${dir}/turn-pulse.png`);
  } catch (e) { console.log(`      (screenshot skipped: ${e.message})`); }

  // ---- the turn ends: the dot leaves ----------------------------------------------------------
  const deadline = Date.now() + 45_000;
  let status = "";
  while (Date.now() < deadline) {
    status = await ev(`fetch('/api/sessions').then(r=>r.json()).then(j=>((j.live||[]).find(s=>s.id===${JSON.stringify(sid)})||{}).status ?? 'gone')`);
    if (status !== "running") break;
    await sleep(700);
  }
  check("the probe turn really ended (fixture precondition)", status !== "running", `status=${status}`);
  await sleep(800);
  check("the dot is gone once the turn is over (no stale 'still working')",
    (await ev(`document.querySelectorAll('.chat-head .turn-pulse').length`)) === 0);

  await ev(`fetch('/api/sessions/'+${JSON.stringify(sid)},{method:'DELETE'})`).catch(() => {});
} finally {
  await fetch(`${CDP}/json/close/${t.id}`, { method: "PUT" }).catch(() => {});
  ws.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
