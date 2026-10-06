// QA: the transcript's own shape — a turn's tool calls fold into ONE row, finished thinking
// folds to a line, and only the live burst is open in a small scrolling window.
//
//   node scripts/qa/transcript-sweep.mjs
//
// The failure this sweep exists for (operator report, 2026-10-06): "工具执行老是刷屏…思考也
// 老是刷屏". Ten calls were ten lines and every reasoning burst stayed open for the rest of
// the session. The mock's `[tools:10]` produces exactly that shape, with no tokens spent.
// Reference: hermes-studio's ToolRunSummary (count + names + status, children behind a click).

const CDP = "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";   // dev instance (scripts/dev.sh start)
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS ?? new URL("../../../../tasks/20261001-agentslot/screens", import.meta.url).pathname;
const fs = await import("node:fs");

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
const setViewport = async (W, H) => {
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: W < 700 });
  await send("Emulation.setTouchEmulationEnabled", { enabled: W < 700, maxTouchPoints: 5 }).catch(() => {});
  await sleep(400);
};
/** Answer an option the way a THUMB or a mouse does: real pointer events at the button's
 *  centre. A programmatic `.click()` succeeds even when something transparent covers the
 *  button — exactly the failure the operator reported ("弹窗点击不了") and exactly why the
 *  first version of this sweep was green while the surface was unusable for him. */
const clickAt = async (sel, re) => {
  const box = await ev(`(() => {
    const host = document.querySelector('.perm-dialog') ?? document.querySelector('.perm-card');
    if (!host) return null;
    const b = ${sel ? `host.querySelector(${JSON.stringify(sel)})` : `[...host.querySelectorAll('button')].find((x) => ${re}.test(x.textContent || ''))`};
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
  })()`);
  if (!box) return false;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(350);
  return true;
};
const clickOption = (re) => clickAt("", re);

/** The same on a touch screen: a phone taps, it does not move a mouse. */
const tapOption = async (re) => {
  const box = await ev(`(() => {
    const host = document.querySelector('.perm-dialog') ?? document.querySelector('.perm-card');
    const b = host && [...host.querySelectorAll('button')].find((x) => ${re}.test(x.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
  })()`);
  if (!box) return false;
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(350);
  return true;
};


await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

/** A real pointer click on a selector — no `.click()`, so a covered element fails here.
 *  Scrolls it into view first: a coordinate off the viewport (a row above the fold in a long
 *  transcript) is a click into nothing, which reads as "the click does not work" (this sweep
 *  reported exactly that before the scroll was added). */
const clickSel = async (sel) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const box = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)});
      if (!b) return null;
      b.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const x = Math.round((r.left + r.right) / 2), y = Math.round((r.top + r.bottom) / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, onScreen: r.top >= 0 && r.bottom <= innerHeight,
        reachable: Boolean(hit) && (b.contains(hit) || hit.contains(b)) }; })()`);
    if (!box) return false;
    await sleep(150);
    if (!box.reachable) continue;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await sleep(400);
    return true;
  }
  return false;
};
const shot = async (name, bottom = true) => {
  // the tail is where the folded rows are: shoot with the newest output in view. The expanded
  // run shot passes bottom=false — its row was just scrolled to the middle by the click.
  if (bottom) {
    await ev(`(() => { const s = document.querySelector('.stream'); if (s) s.scrollTop = s.scrollHeight; })()`);
    await sleep(350);
  }
  const s = await send("Page.captureScreenshot", { format: "png" }, 25000);
  fs.writeFileSync(`${SHOTS}/${name}`, Buffer.from(s.data, "base64"));
};

// --- login + a session on the MOCK backend -------------------------------------------
await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
const sess = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'transcript sweep'})}).then(r=>r.json())`);
check("the sweep could open a mock session (no tokens are spent by this sweep)", Boolean(sess?.id), JSON.stringify(sess).slice(0, 160));
const sid = sess.id;
const status = async () => ev(`fetch('/api/sessions').then(r=>r.json()).then(d=>(d.live||[]).find(s=>s.id===${JSON.stringify(sid)})?.status||'')`).catch(() => "");
const idle = async (ms = 60000) => {
  const t0 = Date.now();
  for (;;) {
    const st = await status();
    if (st !== "running" && st !== "starting") return st;
    if (Date.now() - t0 > ms) return st;
    await sleep(300);
  }
};
await ev(`location.href = ${JSON.stringify(BASE + "/?session=" + sid)}`);
await sleep(3200);

// --- one turn that does real work: 10 tool calls, 10 reasoning bursts ------------------
// This is the operator's "老是刷屏": every call its own line, every burst open for good.
const started = await ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'[tools:10]'})}).then(r=>r.status)`);
check("the work turn was accepted", started === 202 || started === 200, `HTTP ${started}`);

// while it runs: the live block, its window, and the already-finished ones. Keep sampling
// until the window actually overflows (the burst starts two lines tall, so one early sample
// would "prove" there is nothing to scroll).
let live = null;
let lastLive = null;
let peakLines = 0;
let overflowed = null;
for (let i = 0; i < 300; i++) {
  await sleep(150);
  const sample = await ev(`(() => {
    const box = document.querySelector('.msg.thought.live .bubble.live');
    if (!box) return null;
    const st = getComputedStyle(box);
    const lh = parseFloat(st.lineHeight) || 20;
    const all = [...document.querySelectorAll('.msg.thought')];
    return {
      lines: +(box.clientHeight / lh).toFixed(1),
      h: box.clientHeight, scroll: box.scrollHeight, top: box.scrollTop,
      head: (document.querySelector('.msg.thought.live .thought-head')?.textContent || '').trim(),
      bursts: all.length,
      openFinished: all.filter((t) => !t.classList.contains("live") && t.querySelector(".bubble")).length,
      chars: box.textContent.length,
    }; })()`);
  if (!sample) {
    // between bursts the live mark moves to the next block: keep watching while the turn runs
    if (i % 10 === 9 && (await status()) !== "running") break;
    continue;
  }
  live = sample;
  lastLive = sample;
  peakLines = Math.max(peakLines, sample.lines);
  if (sample.scroll > sample.h + 8) { overflowed = sample; break; }
}
check("while the agent is thinking, the live burst is open in a SMALL window (≈6 lines)",
  Boolean(lastLive) && peakLines > 1 && peakLines <= 7.5, JSON.stringify({ peakLines, head: lastLive?.head }));
check("…the burst grows taller than that window, so the window really scrolls",
  Boolean(overflowed), JSON.stringify(overflowed ? { scroll: overflowed.scroll, h: overflowed.h } : { chars: lastLive?.chars }));
check("…and it follows its own tail while the text arrives (auto-scrolled, not stuck at the top)",
  Boolean(overflowed) && overflowed.top > 4, JSON.stringify(overflowed ? { top: overflowed.top, scroll: overflowed.scroll, h: overflowed.h } : null));
check("…the finished bursts above are ALREADY folded while this one streams",
  Boolean(lastLive) && lastLive.openFinished === 0, JSON.stringify(lastLive ? { bursts: lastLive.bursts, openFinished: lastLive.openFinished } : null));
check("…and its header says so, with a size, not just an arrow",
  Boolean(lastLive) && /思考中/.test(lastLive.head) && /字/.test(lastLive.head), lastLive?.head ?? "");

const end = await idle(90000);
check("the work turn finished (otherwise the folding below is about a running turn)",
  end !== "running" && end !== "starting", `status=${end}`);
await sleep(600);

const after = await ev(`(() => ({
  runs: document.querySelectorAll('.tool-run-head').length,
  runText: (document.querySelector('.tool-run-head')?.textContent || '').replace(/\\s+/g, ' ').trim(),
  runExpanded: document.querySelector('.tool-run-head')?.getAttribute('aria-expanded') ?? "",
  cards: document.querySelectorAll('.tool-card').length,
  bursts: document.querySelectorAll('.msg.thought').length,
  openBursts: [...document.querySelectorAll('.msg.thought')].filter((t) => t.querySelector('.bubble')).length,
  burstHead: (document.querySelector('.msg.thought .thought-head')?.textContent || '').trim(),
  rows: document.querySelectorAll('.stream-inner > *').length,
  msgs: document.querySelectorAll('.msg').length,
}))()`);
check("ten finished tool calls are ONE row now (the whole point)", after.runs === 1 && /10 次工具调用/.test(after.runText),
  JSON.stringify(after));
check("…and the row is collapsed to start with — no tool card on screen",
  after.runExpanded === "false" && after.cards === 0, JSON.stringify({ expanded: after.runExpanded, cards: after.cards }));
check("…it names what the turn touched and how it went",
  /read_file|grep|bash/.test(after.runText) && /[✓✗]/.test(after.runText), after.runText);
check("every finished reasoning burst is folded to its header line",
  after.bursts === 10 && after.openBursts === 0, JSON.stringify({ bursts: after.bursts, openBursts: after.openBursts }));
check("…and that header is readable text, not a bare arrow",
  /思考/.test(after.burstHead) && /字/.test(after.burstHead), after.burstHead);
await shot("transcript-folded.png");

// the two levels of detail are behind clicks (row → call → its I/O)
check("clicking the run row opens it", await clickSel(".tool-run-head"));
const opened = await ev(`(() => ({
  expanded: document.querySelector('.tool-run-head')?.getAttribute('aria-expanded') ?? "",
  cards: document.querySelectorAll('.tool-run-items .tool-card').length,
  rows: document.querySelectorAll('.tool-run-items .msg').length,
}))()`);
check("…every call is inside, one row each", opened.cards === 10 && opened.rows === 10, JSON.stringify(opened));
check("then clicking a call opens ITS details", await clickSel(".tool-run-items .tool-head"));
const detail = await ev(`(() => { const b = document.querySelector('.tool-run-items .tool-body');
  return { open: Boolean(b), text: (b?.textContent || '').replace(/\\s+/g, ' ').slice(0, 90) }; })()`);
check("…the call shows its own input/output (studio's second level)", detail.open && /done|step/.test(detail.text), JSON.stringify(detail));
await shot("transcript-run-open.png", false);

check("clicking a folded burst opens the full text", await clickSel(".msg.thought .thought-head"));
const burst = await ev(`(() => { const b = document.querySelector('.msg.thought .bubble');
  if (!b) return null; const st = getComputedStyle(b);
  return { maxH: st.maxHeight, h: b.clientHeight, scroll: b.scrollHeight, chars: b.textContent.length }; })()`);
check("…and that one is NOT windowed (the window is only for the live burst)",
  Boolean(burst) && (burst.maxH === "none" || parseFloat(burst.maxH) > 300), JSON.stringify(burst));

// --- "load earlier messages" ----------------------------------------------------------
// Folding makes the transcript short, so a page can leave room on screen with history still
// on disk. The invariant: never offer "load earlier" while the screen has empty space.
const older = await ev(`(() => { const btn = document.querySelector('.load-earlier button');
  const s = document.querySelector('.stream');
  return { button: Boolean(btn), scroll: s.scrollHeight, client: s.clientHeight }; })()`);
check("“load earlier” is only offered when the screen is already full",
  !older.button || older.scroll > older.client + 80, JSON.stringify(older));

console.log(`\n${pass} passed, ${fail} failed`);
console.log("shots: transcript-folded.png, transcript-run-open.png");
await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
process.exit(fail ? 1 : 0);
