// QA: the transcript's own shape — one stretch of the agent's WORK (thinking + tool calls) keeps
// its NEWEST 5 items on screen in the OLD shape (a `💭 思考 · N 字` line that folds itself, a
// one-line tool card that opens), and folds every older item into a single
// `⚙ N 次工具调用 · M 段思考` row. When the operator starts the NEXT round, the kept 5 are
// absorbed into that row too.
//
//   node scripts/qa/transcript-sweep.mjs
//
// The failures this sweep exists for (operator reports, 2026-10-06):
//   ① "工具执行老是刷屏" — ten calls were ten lines.
//   ② "现在全是思考刷屏了" — folding only the calls left ten 思考 rows behind: 20 rows became 11.
//   ③ "后面执行的那些怎么直接折叠到最前面去" — the run was anchored at the FIRST call, so calls that
//     ran later rendered ABOVE reasoning that came after them; the transcript read out of order.
//   ④ "保留最后 5 条…下一轮开始的时候那 5 条自动合并到那一行里去…最后一条动态思考用小窗口滚动"
//     — and the 5 must look exactly like they always did, not like a second panel.
// The mock's `[tools:10]` produces exactly that shape (10 bursts + 10 calls, interleaved), no
// tokens spent. Reference: hermes-studio's ToolRunSummary (count + names + status, children
// behind a click), extended to the reasoning, which studio keeps as separate rows.

const CDP = "http://127.0.0.1:9222";
const BASE = process.env.BASE ?? "http://127.0.0.1:8901";   // dev instance (scripts/dev.sh start)
const U = process.env.QA_USER ?? "scratch", P = process.env.QA_PASS ?? "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS ?? new URL("../../../../tasks/20261001-agentus/screens", import.meta.url).pathname;
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
      return { x, y, reachable: Boolean(hit) && (b.contains(hit) || hit.contains(b)) }; })()`);
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
const shot = async (name) => {
  const s = await send("Page.captureScreenshot", { format: "png" }, 25000);
  fs.writeFileSync(`${SHOTS}/${name}`, Buffer.from(s.data, "base64"));
};
/** Shoot with one row at the TOP of the stream — the aggregate row, the kept tail and the live
 *  burst in one frame, which is what the operator needs to look at. */
const shotRow = async (sel, name) => {
  await ev(`(() => { const s = document.querySelector('.stream'); const r = document.querySelector(${JSON.stringify(sel)});
    if (s && r) s.scrollTop += r.getBoundingClientRect().top - s.getBoundingClientRect().top - 8; })()`);
  await sleep(400);
  await shot(name);
};

// --- login + a session on the MOCK backend -------------------------------------------
await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
const sess = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp',title:'transcript sweep'})}).then(r=>r.json())`);
check("the sweep could open a mock session (no tokens are spent by this sweep)", Boolean(sess?.id), JSON.stringify(sess).slice(0, 160));
const sid = sess.id;
const status = async () => ev(`fetch('/api/sessions').then(r=>r.json()).then(d=>(d.live||[]).find(s=>s.id===${JSON.stringify(sid)})?.status||'')`).catch(() => "");
const idle = async (ms = 90000) => {
  const t0 = Date.now();
  for (;;) {
    const st = await status();
    if (st !== "running" && st !== "starting") return st;
    if (Date.now() - t0 > ms) return st;
    await sleep(300);
  }
};
const prompt = async (text) => ev(`fetch('/api/sessions/${sid}/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:${JSON.stringify(text)}})}).then(r=>r.status)`);

/** One snapshot of the transcript's shape. "Kept" = the work rows OUTSIDE the fold (they keep the
 *  old shape: one `.msg.thought` per burst line, one tool card per call), counted per kind so both
 *  halves of the rule can be asserted. */
const shape = () => ev(`(() => {
  const inner = [...document.querySelectorAll('.stream-inner > *')];
  const head = document.querySelector('.work-run-head');
  const liveBox = document.querySelector('.msg.thought.live .bubble.live');
  const st = liveBox ? getComputedStyle(liveBox) : null;
  const lh = st ? (parseFloat(st.lineHeight) || 20) : 20;
  const keptThoughts = inner.filter((x) => x.classList.contains('thought'));
  const last = keptThoughts[keptThoughts.length - 1];
  return {
    head: (head?.textContent || '').replace(/\\s+/g, ' ').trim(),
    expanded: head?.getAttribute('aria-expanded') ?? '',
    runs: document.querySelectorAll('.work-run').length,
    inFoldCards: document.querySelectorAll('.work-run-items .tool-card').length,
    inFoldBursts: document.querySelectorAll('.work-run-items > .msg.thought').length,
    keptThoughts: keptThoughts.length,
    keptTools: inner.filter((x) => x.querySelector(':scope > .tool-card')).length,
    keptBurstHead: (last?.querySelector('.thought-head')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    keptBurstOpen: keptThoughts.filter((x) => x.querySelector('.bubble')).length,
    rows: inner.length,
    agent: inner.filter((x) => x.classList.contains('agent')).length,
    user: inner.filter((x) => x.classList.contains('user')).length,
    lines: liveBox ? +(liveBox.clientHeight / lh).toFixed(1) : 0,
    h: liveBox ? liveBox.clientHeight : 0,
    scroll: liveBox ? liveBox.scrollHeight : 0,
    top: liveBox ? liveBox.scrollTop : 0,
    liveHead: (document.querySelector('.msg.thought.live .thought-head')?.textContent || '').trim(),
  }; })()`);

await ev(`location.href = ${JSON.stringify(BASE + "/?session=" + sid)}`);
await sleep(3200);

// --- ① one turn that does real work: 10 calls + 10 bursts, interleaved -----------------
const started = await prompt("[tools:10]");
check("the work turn was accepted", started === 202 || started === 200, `HTTP ${started}`);

// --- ①a the live thinking window, measured WHILE the turn streams ----------------------
// Order matters and it is not cosmetic: the whole point of the fix is that this window CLOSES the
// moment the turn ends, so a page inspected afterwards has nothing left to look at. Everything about
// the window — how tall it is, whether it follows its tail, whether a gesture detaches it — is
// therefore gathered first, while it is still on screen.
let peakLines = 0, maxKept = 0, liveHead = "", sawLive = false;
const liveProbe = () => ev(`(() => {
  const b = document.querySelector('.msg.thought.live .bubble.live');
  const w = document.querySelector('.msg.thought.live');
  return { there: Boolean(b),
    sh: b ? b.scrollHeight : 0, ch: b ? b.clientHeight : 0, top: b ? b.scrollTop : 0,
    len: b ? (b.textContent || '').length : 0,
    head: w ? (w.querySelector('.thought-head')?.textContent || '').trim() : '' };
})()`);
// ONE lookup for the live window, before its turn is over: first sample what it looks like (height,
// follow), then judge the gesture on it — in that order, because the window only exists while the
// turn streams and the fix's whole job is to close it when the turn ends.
let window1 = null;
for (let i = 0; i < 160; i++) {
  await sleep(120);
  const live = await liveProbe();
  if (live.there) { sawLive = true; liveHead = live.head; peakLines = Math.max(peakLines, Math.round(live.ch / 20)); window1 = live; break; }
}
check("…the newest burst is a `💭 思考中…` row in a SMALL window (≈6 lines), not a wall of text",
  sawLive && /思考中/.test(liveHead) && peakLines >= 1 && peakLines <= 7.5,
  JSON.stringify({ sawLive, peakLines, liveHead, window1 }));

// --- ①b the reader is in charge of that window ------------------------------------------
// Operator report (2026-10-08): 「输出思考的时候…我上滑要滑到很上面，它才会停止刷新到最下面」. The window sits
// INSIDE the transcript, so a gesture that landed on it never reached the transcript at all — and the
// window kept yanking itself back on every chunk. So: a gesture detaches NOW, it STAYS detached while
// text keeps arriving, and the way back is a click (「回到最新」), never a yank.
//
// One question per moment, all inside a single page evaluation (the window can close mid-check, and a
// round-trip between "find it" and "scroll it" is exactly how that race is lost):
//   · if this mock's burst is shorter than the cap, pin the cap so the box can scroll at all — the
//     subject is the GESTURE contract, not how tall the burst happens to be;
//   · let the text grow, then read the follow state (a following window is at its tail);
//   · wheel-up detaches; it must STAY detached while the text keeps arriving;
//   · 「回到最新」 puts it back and takes itself away.
const gesture = sawLive ? await ev(`(async () => {
  const find = () => document.querySelector('.msg.thought.live .bubble.live');
  let box = find();
  if (!box) return { error: 'the window closed before the gesture' };
  // a tight cap: one line tall makes the box scroll with even a short burst, and if the burst is a
  // single line there is nothing to follow — the check accepts that case explicitly below.
  box.style.maxHeight = '20px';
  await new Promise((r) => setTimeout(r, 700));
  box = find() || box;
  const followed = { sh: box.scrollHeight, ch: box.clientHeight, top: box.scrollTop };
  box.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
  box.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 250));
  box.scrollTop = 0;
  const at250 = box.scrollTop;
  await new Promise((r) => setTimeout(r, 800));
  const still = find() || box;
  const out = { at250, top: still.scrollTop, h: still.scrollHeight, client: still.clientHeight,
    followed, stick: Boolean(document.querySelector('.thought-stick')),
    stickText: (document.querySelector('.thought-stick')?.textContent || '').trim() };
  const btn = document.querySelector('.thought-stick');
  if (btn) {
    btn.click();
    await new Promise((r) => setTimeout(r, 400));
    const b2 = find();
    out.backTop = b2 ? b2.scrollTop : -1;
    out.backMax = b2 ? b2.scrollHeight - b2.clientHeight : -1;
    out.backStick = Boolean(document.querySelector('.thought-stick'));
  }
  return out;
})()`, 30000) : { error: "no live window (the turn ended before it could be tested)" };

check("…and it follows its own tail while the text arrives (auto-scrolled, not stuck at the top)",
  !gesture.error && Boolean(gesture.followed)
    && (gesture.followed.sh <= gesture.followed.ch + 8 || gesture.followed.top > 4),
  JSON.stringify(gesture.followed ?? gesture));
check("a wheel-up on the live window detaches it (no yank back to the tail)",
  !gesture.error && gesture.top <= 4, JSON.stringify(gesture));
check("…and it STAYS where the reader left it while text keeps arriving",
  !gesture.error && gesture.top <= 4 && gesture.h > gesture.client, JSON.stringify(gesture));
check("…with a way back on screen, not a yank",
  !gesture.error && gesture.stick && /回到最新/.test(gesture.stickText),
  JSON.stringify({ stick: gesture.stick, text: gesture.stickText, error: gesture.error }));
check("…and the click puts it back on the tail (the button goes away again)",
  !gesture.error && gesture.backTop >= gesture.backMax - 24 && !gesture.backStick,
  JSON.stringify({ top: gesture.backTop, max: gesture.backMax, stick: gesture.backStick, error: gesture.error }));

// --- ①c the transcript's own fold, while the turn's rows are still there ---------------
for (let i = 0; i < 300; i++) {
  await sleep(150);
  const s = await shape();
  if (s.head) maxKept = Math.max(maxKept, s.keptThoughts + s.keptTools);
  if (!s.head && (await status()) !== "running") break;
  if (s.head && (await status()) !== "running" && i > 20) break;
}

const end = await idle(90000);
check("the work turn finished (otherwise the folding below is about a running turn)",
  end !== "running" && end !== "starting", `status=${end}`);
await sleep(700);

// --- ② the finished stretch: newest 5 in the OLD shape, everything older in one row ------
const after = await shape();
const foldedTools = Number(after.head.match(/(\d+) 次工具调用/)?.[1] ?? -1);
const foldedBursts = Number(after.head.match(/(\d+) 段思考/)?.[1] ?? -1);
check("the newest 5 items stayed OUT of the fold, in the old shape: 2 burst lines + 3 tool cards",
  after.keptThoughts === 2 && after.keptTools === 3,
  JSON.stringify({ keptThoughts: after.keptThoughts, keptTools: after.keptTools }));
check("…each burst line folded ITSELF to a readable header when the burst ended",
  after.keptBurstOpen === 0 && /思考/.test(after.keptBurstHead) && /字/.test(after.keptBurstHead),
  JSON.stringify({ open: after.keptBurstOpen, head: after.keptBurstHead }));
check("the other 15 items are ONE closed row: 7 calls + 8 bursts (the 3+2 on screen are the rest of the 10+10)",
  after.runs === 1 && foldedTools === 7 && foldedBursts === 8 && after.expanded === "false",
  JSON.stringify({ runs: after.runs, head: after.head, expanded: after.expanded }));
check("…so the transcript is: prompt, one folded row, the kept 5 rows, the answer",
  after.user === 1 && after.agent === 1 && after.rows <= 9, `rows=${after.rows}`);
await shotRow(".work-run-head", "transcript-folded.png");

// --- ③ opening the fold shows the SAME rows, in order ----------------------------------
check("clicking the folded row opens it", await clickSel(".work-run-head"));
const opened = await ev(`(() => ({
  expanded: document.querySelector('.work-run-head')?.getAttribute('aria-expanded') ?? '',
  cards: document.querySelectorAll('.work-run-items .tool-card').length,
  bursts: document.querySelectorAll('.work-run-items > .msg.thought').length,
  order: [...document.querySelectorAll('.work-run-items > *')].map((x) => x.querySelector('.tool-card') ? 'tool' : 'thought'),
  bodyMax: parseFloat(getComputedStyle(document.querySelector('.work-run-items')).maxHeight) || 0,
}))()`);
check("…inside are the 7 calls and 8 burst lines, in the order they happened",
  opened.expanded === "true" && opened.cards === 7 && opened.bursts === 8 &&
  opened.order[0] === "thought" && opened.order[1] === "tool",
  JSON.stringify({ ...opened, order: opened.order.slice(0, 4) }));
check("…and the box is bounded, so 40 steps could not push the composer off screen",
  opened.bodyMax > 0 && opened.bodyMax < 700, `max-height=${opened.bodyMax}px`);
check("…a burst line inside opens its text, and a call opens ITS input/output",
  (await clickSel(".work-run-items > .msg.thought .thought-head")) && (await clickSel(".work-run-items .tool-head")));
const deep = await ev(`(() => ({ burst: document.querySelector('.work-run-items > .msg.thought .bubble')?.textContent?.length ?? 0,
  io: document.querySelector('.work-run-items .tool-body')?.textContent?.replace(/\\s+/g, ' ').slice(0, 80) ?? '' }))()`);
check("…three layers, all reachable: run → burst / call → the call's I/O",
  deep.burst > 40 && /done|step/.test(deep.io), JSON.stringify(deep));
await shotRow(".work-run-head", "transcript-run-open.png");

// --- ④ the NEXT round absorbs the kept tail -------------------------------------------
// "下一轮开始的时候，那最后 5 条就自动合并到之前那一行里去". The clicks above left rows open by
// hand, so reload first: this must be the DEFAULT state of a fresh page, not leftover state.
// NOT `location.reload()`: the app consumes `?session=` and rewrites the address bar to `/`, so a
// reload lands on whatever slot the app opens by DEFAULT — the sweep then measures a different
// session and reports the fixture as empty (head="", kept=0). Re-open by URL.
await ev(`location.href = ${JSON.stringify(BASE + "/?session=")} + ${JSON.stringify(sid)}`);
// WAIT for the FIXTURE to be on screen — a re-open by URL is not instant, and a page that has not
// finished loading its history renders ZERO rows. Measuring then reports the fixture as empty
// (head="", kept=0) and reads as a product failure. Same rule as the other sweeps.
{
  let mounted = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    mounted = await ev("document.querySelectorAll('.stream-inner > *').length").catch(() => 0);
    if (mounted > 5) break;
  }
  if (mounted <= 5) { console.error(`the fixture never came back on screen (rows=${mounted})`); process.exit(1); }
}
await sleep(800);
// The page keeps a WINDOW of history and offers "load earlier" for the rest, so pull the whole
// round back in first — otherwise this step would be measuring the window, not the folding.
for (let i = 0; i < 30; i++) {
  const more = await ev(`(() => { const b = document.querySelector('.load-earlier button');
    if (!b) return false; b.click(); return true; })()`);
  if (!more) break;
  await sleep(700);
}
const reloaded = await shape();
check("…the whole previous round is back on the page (20 work items, nothing left to load)",
  reloaded.keptThoughts + reloaded.keptTools === 5 && !(await ev(`Boolean(document.querySelector('.load-earlier button'))`)),
  JSON.stringify({ kept: reloaded.keptThoughts + reloaded.keptTools, head: reloaded.head.slice(0, 60) }));
const single = await prompt("[think]");
check("a second round was accepted (a lone burst, no tools)", single === 202 || single === 200, `HTTP ${single}`);
await idle(60000);
await sleep(700);
const next = await shape();
const prevExpanded = await ev(`document.querySelector('.work-run-head')?.getAttribute('aria-expanded') ?? ''`);
check("…the previous round's kept tail was absorbed: the row now counts the whole 10 + 10",
  next.runs === 1 && next.keptTools === 0 && prevExpanded === "false" &&
  /10 次工具调用/.test(next.head) && /10 段思考/.test(next.head),
  JSON.stringify({ runs: next.runs, keptTools: next.keptTools, head: next.head, prevExpanded }));
check("…while the new round's lone burst is its OWN row (fewer than two items never folds)",
  next.rows === 6 && next.user === 2 && next.agent === 2, JSON.stringify({ rows: next.rows, user: next.user, agent: next.agent }));
check("…and that burst folded itself when it ended, with a readable header",
  next.keptThoughts === 1 && next.keptBurstOpen === 0 && /思考/.test(next.keptBurstHead) && /字/.test(next.keptBurstHead),
  JSON.stringify({ kept: next.keptThoughts, open: next.keptBurstOpen, head: next.keptBurstHead }));

// --- ⑤ "load earlier messages" ---------------------------------------------------------
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
