// QA: opening a cold slot RENDERS FIRST and wakes the agent process BEHIND the view.
//
// Operator ask (2026-10-10): 「acp 的启动是不是可以异步啊，我感觉点击会话时要等好一会，是在阻塞等待 acp
// 启动吗，这个可以做成异步的吧，先渲染出来」. The transcript is OUR OWN rows (store), so nothing about
// reading it needs a live agent — only sending does.
//
// The assertion is about ORDER, not speed, so this sweep does not depend on how slow a spawn happens
// to be: CDP holds the POST …/resume at the network layer and the page is inspected WHILE it is held.
// A fast mock backend would otherwise close the window before the DOM could be read (and a slow one
// would make the suite take a minute).
//
//   1. we start on ANOTHER session, so the switch is really what is being measured;
//   2. while /resume is frozen the clicked session's OWN transcript is already on screen;
//   3. …and the composer says 正在唤醒 agent 进程… with the send key DISABLED even with a draft typed;
//   4. a second click plus Enter during the wake do NOT start a second spawn (one agent, one rail row);
//   5. once the request is released the slot goes live and the composer returns to normal.
//
//   PORT=8911 node scripts/qa/resume-async-sweep.mjs
const CDP = process.env.CDP ?? "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 8911}`;
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const CWD = process.env.QA_CWD ?? "/tmp";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// ---- CDP plumbing (same shape as the other sweeps) ----------------------------------------------
const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const w = new Map();
/** resume requests the browser has been told to HOLD: the frozen window this sweep reads through. */
const held = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && w.has(m.id)) {
    const x = w.get(m.id); w.delete(m.id);
    m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result);
    return;
  }
  if (m.method === "Fetch.requestPaused") held.push(m.params);
};
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
const until = async (pred, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() > deadline) return false;
    await sleep(400);
  }
};
await send("Page.enable"); await send("Runtime.enable"); await send("DOM.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(400);

const PROBE = `RESUME-ASYNC-${Date.now() % 1000000}`;
const login = `await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then((r)=>r.status);`;

// ---- fixture: A (to be woken by a click) and B (where we start) ---------------------------------
const made = await ev(`(async () => { ${login}
  const mk = async () => (await fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({backend:'mock',cwd:${JSON.stringify(CWD)}})}).then((r)=>r.json())).id;
  const a = await mk(); const b = await mk();
  await fetch('/api/sessions/'+a+'/prompt',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({text:${JSON.stringify(PROBE)}})});
  await fetch('/api/sessions/'+b+'/prompt',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({text:'B 的对话'})});
  return { a, b };
})()`);
const A = made.a, B = made.b;
console.log(`fixture: A=${A} (will be woken by a click)  B=${B} (where we start)  ${CWD}`);
const answered = await until(async () => {
  const d = await ev(`fetch('/api/sessions/${A}/messages?tail=1').then((r)=>r.json())`);
  return (d.messages ?? []).length >= 2; // the operator's line AND the agent's answer
}, 20000);
check("fixture A has a transcript of its own (so there is something to render before the process exists)", answered);
// Cold it. DELETE on a LIVE slot closes it — the process stops, the rows stay (that is what makes it
// the reported case: 「不是从外面点进来…进程已经被 kill 掉了」).
await ev(`fetch('/api/sessions/${A}',{method:'DELETE'}).then((r)=>r.status)`);
const coldNow = await until(async () => {
  const d = await ev(`fetch('/api/sessions').then((r)=>r.json())`);
  return (d.cold ?? []).some((s) => s.id === A) && !(d.live ?? []).some((s) => s.id === A);
}, 15000);
check("…and it is COLD now: a row with no agent process (the click has to wake it)", coldNow);

await send("Page.reload", { ignoreCache: true });
await sleep(3600);

// ---- we start somewhere else, so "the view switched" means something ----------------------------
await ev(`document.querySelector('.session-item[data-session="${B}"]').click()`);
await sleep(900);
const startOn = await ev(`document.querySelector('.session-item.active')?.dataset.session ?? null`);
check("we start on the OTHER session", startOn === B, `active=${startOn}`);

// ---- freeze the resume: the deterministic version of 「等好一会」 --------------------------------
await send("Fetch.enable", { patterns: [{ urlPattern: "*/resume", requestStage: "Request" }] });
const t0 = Date.now();
await ev(`document.querySelector('.session-item[data-session="${A}"]').click()`);
const gotHeld = await until(async () => held.length > 0, 5000);
check("the click really asked the server for a resume (held at the network layer)", gotHeld, `held=${held.length}`);
await sleep(1400); // every chance for the page to catch up — while the handshake is frozen

const snap = await ev(`(() => ({
  active: document.querySelector('.session-item.active')?.dataset.session ?? null,
  probeOnScreen: (document.querySelector('.stream')?.innerText ?? '').includes(${JSON.stringify(PROBE)}),
  placeholder: document.querySelector('.composer-box textarea')?.getAttribute('placeholder') ?? '',
  rows: document.querySelectorAll('.session-item').length,
}))()`);
check("the clicked session's OWN transcript is on screen while its agent process is still starting",
  snap.active === A && snap.probeOnScreen,
  `active=${snap.active} transcript=${snap.probeOnScreen} after ${Date.now() - t0}ms, resume still held`);
check("…and the composer says it is waking, not that it is ready",
  /正在唤醒/.test(snap.placeholder), JSON.stringify(snap.placeholder));

// A draft typed DURING the wake: the box keeps it (nothing is lost) but the send key must not offer
// a send into a session with no process — that is the 「再点发送就报错」 half of the old bug.
await ev(`document.querySelector('.composer-box textarea').focus()`);
await send("Input.insertText", { text: "draft while waking" });
await sleep(500);
const withDraft = await ev(`(() => ({
  text: document.querySelector('.composer-box textarea')?.value ?? '',
  disabled: Boolean(document.querySelector('.send-btn')?.disabled),
  title: document.querySelector('.send-btn')?.getAttribute('title') ?? '',
}))()`);
check("a draft typed while it wakes stays in the box (nothing is lost)", withDraft.text.includes("draft while waking"), JSON.stringify(withDraft.text));
check("…and the send key is disabled, so it cannot fire into a session with no process yet",
  withDraft.disabled === true, JSON.stringify({ disabled: withDraft.disabled, title: withDraft.title }));

// ---- one spawn, however many ways the operator asks --------------------------------------------
await ev(`document.querySelector('.session-item[data-session="${A}"]').click()`);
await ev(`(() => { const ta = document.querySelector('.composer-box textarea');
  ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
await sleep(1200);
check("a second click and an Enter while it is waking do NOT start a second spawn",
  held.length === 1, `held=${held.length}`);

// ---- release, and watch it finish --------------------------------------------------------------
for (const h of held) await send("Fetch.continueRequest", { requestId: h.requestId });
await send("Fetch.disable");
const liveAgain = await until(async () => {
  const d = await ev(`fetch('/api/sessions').then((r)=>r.json())`);
  return (d.live ?? []).some((s) => s.id === A);
}, 30000);
check("releasing the request completes the handshake and the slot goes live", liveAgain);
await sleep(1500);
const after = await ev(`(() => ({
  placeholder: document.querySelector('.composer-box textarea')?.getAttribute('placeholder') ?? '',
  disabled: Boolean(document.querySelector('.send-btn')?.disabled),
  probeOnScreen: (document.querySelector('.stream')?.innerText ?? '').includes(${JSON.stringify(PROBE)}),
}))()`);
check("…the composer returns to normal (no 「正在唤醒」 left behind)", !/正在唤醒/.test(after.placeholder), JSON.stringify(after.placeholder));
check("…the transcript is the same one (the wake did not reset what was on screen)", after.probeOnScreen === true);
check("…and the draft is still in the box, now sendable", after.disabled === false, JSON.stringify({ disabled: after.disabled }));

// ---- cleanup -----------------------------------------------------------------------------------
for (const x of [A, B]) {
  await ev(`fetch('/api/sessions/${x}',{method:'DELETE'}).then((r)=>r.status)`); // live: closes
  await ev(`fetch('/api/sessions/${x}',{method:'DELETE'}).then((r)=>r.status)`); // cold: purges
}
check("cleaned up both fixture rows", true, "A + B deleted (close, then purge)");
await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});

console.log(`\n${fail ? "FAIL" : "PASS"} resume-async-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
