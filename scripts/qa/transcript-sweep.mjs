// QA: the transcript's own shape — one stretch of the agent's WORK (thinking + tool calls)
// folds into ONE row; while it is live that row is open in a BOUNDED, self-scrolling box with
// only the newest burst windowed; when the agent moves on, the whole thing folds to its header.
//
//   node scripts/qa/transcript-sweep.mjs
//
// The failures this sweep exists for (operator reports, 2026-10-06):
//   ① "工具执行老是刷屏" — ten calls were ten lines.
//   ② "现在全是思考刷屏了" — folding only the calls left ten 思考 rows behind: 20 rows became 11.
//   ③ "后面执行的那些怎么直接折叠到最前面去" — the run was anchored at the FIRST call, so calls that
//     ran later rendered ABOVE reasoning that came after them; the transcript read out of order.
// The mock's `[tools:10]` produces exactly that shape (10 bursts + 10 calls, interleaved), no
// tokens spent. Reference: hermes-studio's ToolRunSummary (count + names + status, children
// behind a click), extended to the reasoning, which studio keeps as separate rows.

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
await ev(`location.href = ${JSON.stringify(BASE + "/?session=" + sid)}`);
await sleep(3200);

// --- ① one turn that does real work: 10 calls + 10 bursts, interleaved -----------------
const started = await prompt("[tools:10]");
check("the work turn was accepted", started === 202 || started === 200, `HTTP ${started}`);

// while it runs: ONE row, open, in a bounded box, with only the newest burst windowed.
let lastLive = null, overflowed = null, peakLines = 0, peakBodyRatio = 0, strayThoughts = 0;
for (let i = 0; i < 300; i++) {
  await sleep(150);
  const sample = await ev(`(() => {
    const box = document.querySelector('.work-run-items .work-thought.live');
    const items = document.querySelector('.work-run-items');
    const head = document.querySelector('.work-run-head');
    const st = box ? getComputedStyle(box) : null;
    const lh = st ? (parseFloat(st.lineHeight) || 20) : 20;
    return {
      head: (head?.textContent || '').replace(/\\s+/g, ' ').trim(),
      expanded: head?.getAttribute('aria-expanded') ?? '',
      rows: document.querySelectorAll('.work-run').length,
      stray: document.querySelectorAll('.stream-inner > .msg.thought').length,
      bodyH: items ? items.clientHeight : 0,
      bodyMax: items ? parseFloat(getComputedStyle(items).maxHeight) || 0 : 0,
      lines: box ? +(box.clientHeight / lh).toFixed(1) : 0,
      h: box ? box.clientHeight : 0,
      scroll: box ? box.scrollHeight : 0,
      top: box ? box.scrollTop : 0,
      chars: box ? box.textContent.length : 0,
    }; })()`);
  if (!sample || !sample.head) {
    // between bursts the live mark moves; keep watching while the turn runs
    if (i % 10 === 9 && (await status()) !== "running") break;
    continue;
  }
  strayThoughts = Math.max(strayThoughts, sample.stray);
  if (sample.bodyH) peakBodyRatio = Math.max(peakBodyRatio, sample.bodyH / 900);
  if (!sample.lines) continue;
  lastLive = sample;
  peakLines = Math.max(peakLines, sample.lines);
  if (sample.scroll > sample.h + 8) { overflowed = sample; break; }
}

check("while it works, the thinking+calls are ONE row (not ten 思考 rows)", lastLive?.rows === 1 && strayThoughts === 0,
  JSON.stringify({ rows: lastLive?.rows, strayThoughtRows: strayThoughts }));
check("…that row is OPEN while the run is live (studio: expanded = override ?? active)",
  lastLive?.expanded === "true", JSON.stringify({ expanded: lastLive?.expanded }));
check("…and its header counts both kinds of work",
  /工具调用/.test(lastLive?.head || "") && /段思考/.test(lastLive?.head || ""), lastLive?.head ?? "");
check("…the box is BOUNDED — a 20-step turn cannot push the composer off screen",
  peakBodyRatio > 0 && peakBodyRatio <= 0.5, `body/viewport = ${peakBodyRatio.toFixed(2)}`);
check("…the newest burst sits in a SMALL window (≈6 lines) and really scrolls",
  Boolean(overflowed) && peakLines > 1 && peakLines <= 7.5,
  JSON.stringify({ peakLines, scroll: overflowed?.scroll, h: overflowed?.h }));
check("…and it follows its own tail while the text arrives (auto-scrolled, not stuck at the top)",
  Boolean(overflowed) && overflowed.top > 4, JSON.stringify(overflowed ? { top: overflowed.top } : null));

const end = await idle(90000);
check("the work turn finished (otherwise the folding below is about a running turn)",
  end !== "running" && end !== "starting", `status=${end}`);
await sleep(700);

const after = await ev(`(() => ({\n  runs: document.querySelectorAll('.work-run').length,\n  head: (document.querySelector('.work-run-head')?.textContent || '').replace(/\\\\s+/g, ' ').trim(),\n  expanded: document.querySelector('.work-run-head')?.getAttribute('aria-expanded') ?? '',\n  cards: document.querySelectorAll('.tool-card').length,\n  stray: document.querySelectorAll('.stream-inner > .msg.thought').length,\n  inner: document.querySelectorAll('.work-run-items').length,\n  rows: document.querySelectorAll('.stream-inner > *').length,\n  agent: document.querySelectorAll('.stream-inner > .msg.agent').length,\n  user: document.querySelectorAll('.stream-inner > .msg.user').length,\n}))()`);
check("20 rows of work are ONE row now — thinking and calls TOGETHER", after.runs === 1 && after.user === 1 && after.agent === 1,
  JSON.stringify(after));
check("…the header says what happened: 10 calls AND 10 bursts",
  /10 次工具调用/.test(after.head) && /10 段思考/.test(after.head), after.head);
check("…it is folded to that line — nothing open, no cards, no stray thought rows",
  after.expanded === "false" && after.cards === 0 && after.inner === 0 && after.stray === 0, JSON.stringify(after));
check("…and the whole transcript reads in order: prompt, work, answer",
  after.rows <= 6, `rows=${after.rows}`);
await shot("transcript-folded.png");

// the two levels of detail are behind clicks (run → call → its I/O)
check("clicking the row opens the whole run", await clickSel(".work-run-head"));
const opened = await ev(`(() => ({\n  expanded: document.querySelector('.work-run-head')?.getAttribute('aria-expanded') ?? '',\n  cards: document.querySelectorAll('.work-run-items .tool-card').length,\n  thoughts: document.querySelectorAll('.work-run-items .work-thought').length,\n  first: document.querySelector('.work-run-items > *')?.className ?? '',\n  order: [...document.querySelectorAll('.work-run-items > *')].map((x) => x.className.includes('work-thought') ? 'thought' : 'tool'),\n  bodyMax: parseFloat(getComputedStyle(document.querySelector('.work-run-items')).maxHeight) || 0,\n  windowed: document.querySelectorAll('.work-run-items .work-thought.live').length,\n}))()`);
check("…every burst and every call is inside, in the order they happened",
  opened.thoughts === 10 && opened.cards === 10 && opened.order[0] === "thought" && opened.order[1] === "tool",
  JSON.stringify({ thoughts: opened.thoughts, cards: opened.cards, order: opened.order.slice(0, 4) }));
check("…the opened body is bounded and scrolls (it is not 20 rows tall on screen)",
  opened.bodyMax > 0 && opened.bodyMax < 700, `max-height=${opened.bodyMax}px`);
check("…and none of the finished bursts is windowed any more (the window is for the live one)",
  opened.windowed === 0, `windowed=${opened.windowed}`);
check("then clicking a call opens ITS details", await clickSel(".work-run-items .tool-head"));
const detail = await ev(`(() => { const b = document.querySelector('.work-run-items .tool-body');\n  return { open: Boolean(b), text: (b?.textContent || '').replace(/\\\\s+/g, ' ').slice(0, 90) }; })()`);
check("…the call shows its own input/output (studio's second level)", detail.open && /done|step/.test(detail.text), JSON.stringify(detail));
await shot("transcript-run-open.png", false);

// --- ② a lone burst: no run to fold it into, but it must still fold when it ends ---------
const single = await prompt("[think]");
check("a lone-thinking turn was accepted", single === 202 || single === 200, `HTTP ${single}`);
await idle(60000);
await sleep(600);
const lone = await ev(`(() => {\n  const all = [...document.querySelectorAll('.stream-inner > .msg.thought')];\n  const t = all[all.length - 1];\n  return { rows: all.length,\n    head: (t?.querySelector('.thought-head')?.textContent || '').trim(),\n    open: Boolean(t?.querySelector('.bubble')),\n    runs: document.querySelectorAll('.work-run').length }; })()`);
check("a single burst is NOT folded into a run (fewer than two items reads better as itself)",
  lone.rows === 1 && lone.runs === 1, JSON.stringify(lone));
check("…and it folded itself when the turn ended, with a readable header",
  !lone.open && /思考/.test(lone.head) && /字/.test(lone.head), JSON.stringify(lone));

// --- ③ "load earlier messages" ----------------------------------------------------------
// Folding makes the transcript short, so a page can leave room on screen with history still
// on disk. The invariant: never offer "load earlier" while the screen has empty space.
const older = await ev(`(() => { const btn = document.querySelector('.load-earlier button');\n  const s = document.querySelector('.stream');\n  return { button: Boolean(btn), scroll: s.scrollHeight, client: s.clientHeight }; })()`);
check("“load earlier” is only offered when the screen is already full",
  !older.button || older.scroll > older.client + 80, JSON.stringify(older));

console.log(`\n${pass} passed, ${fail} failed`);
console.log("shots: transcript-folded.png, transcript-run-open.png");
await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
process.exit(fail ? 1 : 0);
