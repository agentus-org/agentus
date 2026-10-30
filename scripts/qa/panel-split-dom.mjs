// The workspace panel's desktop split, driven through a real browser (2026-10-30).
//
// The operator asked for one thing — 「电脑的时候可以把 code-server 分屏放上面，终端放下面，支持点击放上面还是下面」
// — and a phone must keep the single full-screen sheet. Those are the claims below, plus the two
// invariants that make the split usable at all:
//
//  1. SWAPPING MUST NOT REMOUNT. Move the panes in the DOM and the iframe reloads code-server's whole
//     front end (unsaved buffers, extension host) while the terminal opens a NEW pty. The test tags
//     both elements before the swap and asserts the tags survive — an implementation that reorders
//     DOM nodes passes a screenshot check and fails this one.
//  2. THE MODE IS A PREFERENCE. Close and reopen the panel, reload the page: the split and which pane
//     is on top come back.
//
//   AGENTUS_BASE=http://127.0.0.1:8901 CDP_URL=http://127.0.0.1:9222 node scripts/qa/panel-split-dom.mjs
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const BASE = process.env.AGENTUS_BASE || "http://127.0.0.1:8901";
const USER = process.env.AGENTUS_USER || "scratch";
const PASS = process.env.AGENTUS_PASS || "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2000);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const x = waiting.get(m.id); waiting.delete(m.id);
    m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; waiting.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const goto = async (url) => { await send("Page.navigate", { url }); await sleep(3500); };

// Login (the route is behind the cookie; the page itself is public) and start from a known state.
await goto(BASE);
const status = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({username:${JSON.stringify(USER)},password:${JSON.stringify(PASS)}})}).then(r=>r.status)`);
check("logged in (the panel lives behind the login)", status === 200, `status ${status}`);
await ev(`(() => { for (const k of Object.keys(localStorage)) if (/panel-split|panel-pair/.test(k)) localStorage.removeItem(k); return true; })()`);
await goto(BASE);

/* The panel's toggle only exists once a session is on screen. The cockpit remembers the last one, so
 *  most runs start there; if it does not, the first rail row is a session (its ⋯ menu is the marker —
 *  the rail's own buttons are not it). */
const openSessionAndPanel = async () => {
  const open = async () => ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/workspace panel/i.test(x.getAttribute('title')||''));
    if (!b) return false; b.click(); return true; })()`);
  if (await open()) { await sleep(3000); return true; }
  await ev(`(() => { const menu=document.querySelector('[title^="会话设置"], [aria-label^="会话设置"]');
    const row=menu?.closest('li, .rail-item, .item, [role="treeitem"]'); if (row) row.click(); return Boolean(row); })()`);
  await sleep(3000);
  const ok = await open();
  await sleep(3000);
  return ok;
};
check("a session's panel opens", await openSessionAndPanel(), "");

const splitBtn = `[aria-label="toggle the vertical split"]`;
/* Rows come back VISUALLY ordered (by `top`), never in DOM order: since #78 the panes live at a
 * fixed position in the tree and the pair order is CSS `order`, so `[0]` in the DOM is whichever
 * pane the component renders first — not the top of the screen. (The same trap bit twice during
 * this issue; the assertion shape is the fix for it.) */
const panes = `JSON.stringify([...document.querySelectorAll('.panel-stack .stack-pane')].map(p => ({
  cls: p.className, hidden: p.hidden, top: Math.round(p.getBoundingClientRect().top),
  h: Math.round(p.getBoundingClientRect().height), iframe: Boolean(p.querySelector('iframe')),
  xterm: Boolean(p.querySelector('.xterm')) })).sort((a, b) => a.top - b.top))`;

check("the split switch is offered on a desktop window", await ev(`Boolean(document.querySelector('${splitBtn}'))`), "");
await ev(`document.querySelector('${splitBtn}').click(); true`);
await sleep(6000);
const split = JSON.parse(await ev(panes));
check("splitting shows BOTH panes at once", split.length === 2 && split.every((p) => !p.hidden), await ev(panes));
check("the IDE is the top pane and the terminal the bottom one (default)",
  split[0]?.iframe && split[1]?.xterm && split[0].top < split[1].top,
  JSON.stringify(split.map((p) => ({ cls: p.cls, top: p.top }))));
check("the two panes share the height", Math.abs((split[0]?.h ?? 0) - (split[1]?.h ?? 0)) <= 8, `${split[0]?.h} vs ${split[1]?.h}`);

// Tag both elements, then swap: the tags are the proof that nothing was re-created.
await ev(`(() => { document.querySelector('.pane-ide iframe').dataset.mark='keep';
  document.querySelector('.pane-term .xterm').dataset.mark='keep'; return true; })()`);
await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/terminal/.test(t.textContent)).click(); true`);
await sleep(1500);
const swapped = JSON.parse(await ev(panes));
check("clicking the terminal tab puts the terminal on top", swapped[0]?.xterm === true && swapped[0]?.top < swapped[1]?.top,
  JSON.stringify(swapped.map((p) => ({ cls: p.cls, top: p.top }))));
const kept = await ev(`(() => ({ iframe: document.querySelector('.pane-ide iframe').dataset.mark === 'keep',
  xterm: document.querySelector('.pane-term .xterm').dataset.mark === 'keep' }))()`);
check("swapping does NOT reload the IDE frame (a re-mount would restart code-server)", kept.iframe === true, JSON.stringify(kept));
check("swapping does NOT open a new pty (the terminal element survives)", kept.xterm === true, JSON.stringify(kept));
check("the choice is remembered as a pair, terminal first", await ev(`localStorage.getItem('agentus.panel-pair')`) === JSON.stringify(["terminal","ide"]), await ev(`localStorage.getItem('agentus.panel-pair')`));

/* #78, the geometry assertion that the old suite lacked: the divider must sit BETWEEN the two rows.
   CSS `order` is an <integer> — the 1.5 shipped in 0.15.10 was a discarded declaration, the divider
   fell back to order 0 and painted above both panes. It still DRAGGED, so every "does resize work"
   test passed while the line was visibly in the wrong place. Presence-by-class-name is not position. */
const between = JSON.parse(await ev(`(() => {
  const d = document.querySelector('.row-divider').getBoundingClientRect();
  const rows = [...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')].map(p => p.getBoundingClientRect()).sort((a, b) => a.top - b.top);
  return JSON.stringify({ dTop: Math.round(d.top), dBottom: Math.round(d.bottom),
    topBottom: Math.round(rows[0].bottom), bottomTop: Math.round(rows[1].top),
    stackTop: Math.round(document.querySelector('.panel-stack').getBoundingClientRect().top) }); })()`));
check("the divider sits BETWEEN the two rows, not at the top of the panel (order must be an integer)",
  between.dTop >= between.topBottom - 1 && between.dBottom <= between.bottomTop + 1 && between.dTop > between.stackTop,
  JSON.stringify(between));

// The divider is the rail's gesture turned 90°: drag it and the TOP row grows, and the split is
// remembered as a height. Double-click puts it back to half and half.
const dividerBox = JSON.parse(await ev(`(() => { const r=document.querySelector('.row-divider .pane-handle-row').getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), cursor: getComputedStyle(document.querySelector('.row-divider .pane-handle-row')).cursor }); })()`));
check("the row divider is a real handle (row-resize, like the rail's col-resize)", dividerBox.cursor === "row-resize", dividerBox.cursor);
/* #78 §1: a bare 2px line reads as a border. The divider carries a visible grip — a knob in its
   middle that is there BEFORE you hover — so "this is draggable" is something you can see. */
check("the divider shows a grip (not just a hairline)", await ev(`Boolean(document.querySelector('.row-divider .pane-handle-row-grip'))`), "");
/* The VISUALLY topmost pane, not the first in DOM order: the panes sit in a fixed tree order and are
 *  placed by CSS `order`, so after a swap the first child is the bottom row. Measuring DOM order here
 *  is what made an earlier version of this test report a resize that went the wrong way. */
const topH = async () => ev(`(() => { const h=[...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')]
  .map(p => p.getBoundingClientRect()).sort((a, b) => a.top - b.top);
  return Math.round(h[0].height); })()`);
const heightBefore = await topH();
const drag = async (dy) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: dividerBox.x, y: dividerBox.y, button: "left", clickCount: 1 });
  for (const step of [0.3, 0.6, 1]) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dividerBox.x, y: dividerBox.y + Math.round(dy * step), button: "left", buttons: 1 });
    await sleep(120);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dividerBox.x, y: dividerBox.y + dy, button: "left", clickCount: 1 });
  await sleep(600);
};
await drag(90);
const heightAfter = await topH();
check("dragging the divider resizes the top row", heightAfter > heightBefore + 40, `${heightBefore} → ${heightAfter}`);
check("…and the height is remembered under THIS PAIR's key (#78 §2)",
  Number(await ev(`localStorage.getItem('agentus.panel-split-ratio:ide+terminal')`)) > heightBefore + 40,
  await ev(`JSON.stringify(Object.keys(localStorage).filter(k=>k.includes('split-ratio')))`) );
const sum = JSON.parse(await ev(`(() => { const st = document.querySelector('.panel-stack').getBoundingClientRect();
  const kids = [...document.querySelectorAll('.panel-stack > *')].map(e => e.getBoundingClientRect().height);
  return JSON.stringify({ stack: Math.round(st.height), sum: Math.round(kids.reduce((a, b) => a + b, 0)) }); })()`));
check("the rows never overflow the panel (a fixed top row + a fixed bottom row would)", sum.sum <= sum.stack + 1, JSON.stringify(sum));
await ev(`(() => { const h = document.querySelector('.row-divider .pane-handle-row');
  h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
await sleep(700);
check("double-click on the divider goes back to half and half", await ev(`localStorage.getItem('agentus.panel-split-ratio:ide+terminal')`) === null,
  String(await ev(`localStorage.getItem('agentus.panel-split-ratio:ide+terminal')`)));

// The files tab leaves the split, and coming back returns to it.
await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/files/.test(t.textContent)).click(); true`);
await sleep(1200);
check("the files tab leaves the split (one pane at a time)",
  await ev(`document.querySelector('${splitBtn}').getAttribute('aria-pressed') === 'false'`), "");
await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/terminal/.test(t.textContent)).click(); true`);
await sleep(1200);
check("…and going back to a pane restores it", (await ev(`document.querySelectorAll('.panel-stack .stack-pane:not([hidden])').length`)) === 2, "");

// Reopen: the mode comes back without re-choosing it.
await goto(BASE);
await openSessionAndPanel();
await sleep(2500);
const reopened = JSON.parse(await ev(panes));
check("reopening the panel lands back in the split, in the remembered order",
  reopened.filter((p) => !p.hidden).length === 2 && reopened[0]?.xterm === true,
  JSON.stringify(reopened.map((p) => ({ cls: p.cls, hidden: p.hidden, top: p.top }))));

/* #78: the 0.15.10 preferences (two booleans + a global ratio) migrate into the pair model, so an
   operator who had the terminal on top and a dragged height keeps both after the upgrade. */
await ev(`(() => { for (const k of Object.keys(localStorage)) if (/panel-split|panel-pair/.test(k)) localStorage.removeItem(k);
  localStorage.setItem('agentus.panel-split','1'); localStorage.setItem('agentus.panel-split-ide-top','0');
  localStorage.setItem('agentus.panel-split-ratio','300'); return true; })()`);
await goto(BASE);
await openSessionAndPanel();
await sleep(3000);
const migrated = JSON.parse(await ev(`JSON.stringify({pair: localStorage.getItem('agentus.panel-pair'),
  rows: [...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')].map(p => ({cls: p.className.replace('stack-pane ',''), top: Math.round(p.getBoundingClientRect().top), h: Math.round(p.getBoundingClientRect().height)})).sort((a,b)=>a.top-b.top),
  perPair: localStorage.getItem('agentus.panel-split-ratio:ide+terminal')})`));
check("the stored booleans migrate into a pair with the terminal on top",
  migrated.pair === JSON.stringify(["terminal","ide"]) && migrated.rows[0]?.cls === "pane-term", JSON.stringify(migrated));
check("the global ratio migrates into the pair's key", Number(migrated.perPair) === 300 || Math.abs((migrated.rows[0]?.h ?? 0) - 300) <= 80,
  JSON.stringify({perPair: migrated.perPair, topH: migrated.rows[0]?.h}));

// A phone keeps the sheet: no switch, one pane.
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await sleep(1500);
const phone = await ev(`(() => ({ btn: Boolean(document.querySelector('${splitBtn}')),
  visible: document.querySelectorAll('.panel-stack .stack-pane:not([hidden])').length,
  overflow: document.documentElement.scrollWidth - innerWidth }))()`);
check("a phone offers no split switch", phone.btn === false, JSON.stringify(phone));
check("a phone still shows exactly one pane", phone.visible === 1, `visible=${phone.visible}`);
check("…and nothing overflows horizontally", phone.overflow === 0, `overflow=${phone.overflow}`);

await send("Emulation.clearDeviceMetricsOverride");
ws.close();
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
