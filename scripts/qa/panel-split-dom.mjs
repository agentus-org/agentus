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
  /* #80 §2: the panel's door is now the head's ONE folder button (`aria-label="file browser"`); the
   * old /workspace panel/ title went away with the merged icon. Both are tried so the script still
   * runs against an older build. */
  const open = async () => ev(`(() => { const b = document.querySelector('button[aria-label="file browser"]')
      || [...document.querySelectorAll('button')].find(x=>/workspace panel/i.test(x.getAttribute('title')||''));
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
const panesOf = () => ev(`JSON.stringify([...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')]
  .map(p => ({ pane: p.dataset.pane, top: Math.round(p.getBoundingClientRect().top),
    h: Math.round(p.getBoundingClientRect().height), xterm: Boolean(p.querySelector('.xterm')),
    explorer: Boolean(p.querySelector('.explorer-col')) })).sort((a, b) => a.top - b.top))`);

/* ── The no-IDE machine (AGENTUS_NO_IDE=1) ────────────────────────────────────────────────────────
 * 优化 2 was the operator's own report: 「现在没有ide时不能支持上下分屏吗」. A box with no
 * AGENTUS_IDE_UPSTREAM has exactly two panes — files and terminal — and the split has to work on that
 * pair. This branch runs the same kind of claims against such an instance and stops; the main body
 * below is the IDE machine's suite. */
if (process.env.AGENTUS_NO_IDE === "1") {
  check("no IDE is offered here (the ide button is absent from the head)",
    await ev(`document.querySelectorAll('.chat-head [aria-label="ide"]').length === 0`),
    await ev(`[...document.querySelectorAll('.chat-head button')].map(b => b.getAttribute('aria-label') ?? b.title).join(',')`));
  check("the head still offers the file browser and the terminal",
    await ev(`Boolean(document.querySelector('.chat-head [aria-label="file browser"]')
      && document.querySelector('.chat-head [aria-label="terminal"]'))`), "");
  await ev(`document.querySelector('${splitBtn}').click(); true`);
  await sleep(5000);
  const noIde = JSON.parse(await panesOf());
  check("the split runs on [files, terminal] — the one pair this machine has",
    noIde.length === 2 && noIde.map((p) => p.pane).join("+") === "files+terminal", JSON.stringify(noIde));
  check("…files on top with its tree, terminal under it with a real pty",
    noIde[0]?.explorer === true && noIde[1]?.xterm === true, JSON.stringify(noIde));
  check("…and they share the height", Math.abs((noIde[0]?.h ?? 0) - (noIde[1]?.h ?? 0)) <= 8,
    `${noIde[0]?.h} vs ${noIde[1]?.h}`);
  check("the pair is stored, files first",
    (await ev(`localStorage.getItem('agentus.panel-pair')`)) === JSON.stringify(["files", "terminal"]),
    await ev(`localStorage.getItem('agentus.panel-pair')`));
  const noIdePair = JSON.parse(await ev(`(() => { const vis = [...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')].map(p => p.dataset.pane);
    return JSON.stringify({ count: vis.length, vis }); })()`));
  check("#79 still holds: exactly the pair is visible, never three rows", noIdePair.count === 2, JSON.stringify(noIdePair));
  await ev(`document.querySelector('${splitBtn}').click(); true`);
  await sleep(2000);
  check("the split switch closes it back to one pane",
    JSON.parse(await panesOf()).length <= 1, await panesOf());
  ws.close();
  console.log(`\n${pass} passed / ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
/* Rows come back VISUALLY ordered (by `top`), never in DOM order: since #78 the panes live at a
 * fixed position in the tree and the pair order is CSS `order`, so `[0]` in the DOM is whichever
 * pane the component renders first — not the top of the screen. (The same trap bit twice during
 * this issue; the assertion shape is the fix for it.) */
/* Only VISIBLE rows: a pane that has been mounted once stays in the DOM hidden (that is the #77
 *  no-remount rule), so "what the operator sees" is `.stack-pane:not([hidden])`. Written this way the
 *  suite keeps working when the registry grows past two panes — counting every row is what made the
 *  first three-pane run fail for the wrong reason. */
const panes = `JSON.stringify([...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')].map(p => ({
  pane: p.dataset.pane, cls: p.className, hidden: p.hidden, top: Math.round(p.getBoundingClientRect().top),
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

/* #79: the invariant the 0.15.11 code broke. In split mode the panel shows the PAIR and nothing else.
 *  The old rule per row was `!(splitActive || tab === id)` — "in split mode, show me too" — which is
 *  exactly right while the registry holds only the two panes a pair can hold, and exactly wrong once
 *  a third pane exists: `tab` can be that third pane, and `tab === id` released it as a THIRD row
 *  (measured on a three-pane beta: pair ["ide","terminal"], three visible rows).
 *
 *  Written as a COUNT plus a MEMBERSHIP test, not as "the two known panes are visible": it holds for
 *  any registry size, so it is the assertion that keeps holding when the next pane is added. */
const inPair = JSON.parse(await ev(`(() => { const pair = JSON.parse(localStorage.getItem('agentus.panel-pair') || 'null');
  const vis = [...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')].map(p => p.dataset.pane);
  return JSON.stringify({ count: vis.length, vis, pair }); })()`));
check("in split mode the panel shows exactly the pair — a third pane cannot sneak in (#79)",
  inPair.count === 2 && inPair.vis.every((p) => inPair.pair?.includes(p)), JSON.stringify(inPair));

// Tag both elements, then swap: the tags are the proof that nothing was re-created.
await ev(`(() => { document.querySelector('[data-pane="ide"] iframe').dataset.mark='keep';
  document.querySelector('[data-pane="terminal"] .xterm').dataset.mark='keep'; return true; })()`);
await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/terminal/.test(t.textContent)).click(); true`);
await sleep(1500);
const swapped = JSON.parse(await ev(panes));
check("clicking the terminal tab puts the terminal on top", swapped[0]?.xterm === true && swapped[0]?.top < swapped[1]?.top,
  JSON.stringify(swapped.map((p) => ({ cls: p.cls, top: p.top }))));
const kept = await ev(`(() => ({ iframe: document.querySelector('[data-pane="ide"] iframe').dataset.mark === 'keep',
  xterm: document.querySelector('[data-pane="terminal"] .xterm').dataset.mark === 'keep' }))()`);
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

/* `files` is a PANE since 2026-10-30 (「现在没有ide时不能支持上下分屏吗」): the tab bar now means the
   same thing for every entry — click = put me on top — and the way out of the split is the ⇅ toggle,
   one control with one meaning. Previously the files tab silently left the split, which was the price
   of it being a special case outside the registry. */
await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/^files/.test(t.textContent.trim())).click(); true`);
await sleep(1200);
const afterFiles = JSON.parse(await ev(`(() => { const vis=[...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')]
  .map(p => ({ pane: p.dataset.pane, top: Math.round(p.getBoundingClientRect().top) })).sort((a,b)=>a.top-b.top);
  return JSON.stringify({ vis, explorer: Boolean(document.querySelector('.explorer-col')),
    split: document.querySelector('${splitBtn}')?.getAttribute('aria-pressed'),
    pair: localStorage.getItem('agentus.panel-pair') }); })()`));
check("clicking the files tab shows the BROWSER full height and keeps the pair stored",
  afterFiles.split === "false" && afterFiles.explorer === true
  && afterFiles.vis.length === 1 && afterFiles.vis[0].pane === "files"
  && afterFiles.pair === JSON.stringify(["terminal","ide"]), JSON.stringify(afterFiles));
await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/^terminal/.test(t.textContent.trim())).click(); true`);
await sleep(1200);
const afterTerm = JSON.parse(await ev(`(() => { const vis=[...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')]
  .map(p => ({ pane: p.dataset.pane, top: Math.round(p.getBoundingClientRect().top) })).sort((a,b)=>a.top-b.top);
  return JSON.stringify({ vis }); })()`));
check("…and going back to a pane brings the stored split back, untouched",
  afterTerm.vis.length === 2 && afterTerm.vis[0].pane === "terminal", JSON.stringify(afterTerm));

/* Reopen: the mode comes back without re-choosing it. The door used here is the head's TERMINAL
   button, not 📁 — since #80 the folder button means "show me files", and the stored split is what
   the panel lands on when the operator opens one of its panes (App seeds its first tab from the
   pair; letting a restore effect pull `files` back to the pair is what made that button useless). */
await goto(BASE);
await sleep(1500);
await openSessionAndPanel();
await sleep(2500);
const landedOnFiles = await ev(`Boolean(document.querySelector('.explorer-col'))`);
check("#80 …and the head's 📁 opens the FILE BROWSER even when a split is stored (no restore overruling it)",
  landedOnFiles === true, String(landedOnFiles));
await ev(`document.querySelector('.chat-head [aria-label="terminal"]').click(); true`);
await sleep(2500);
const reopened = JSON.parse(await ev(panes));
check("opening a pane after a reload lands back in the split, in the remembered order",
  reopened.filter((p) => !p.hidden).length === 2 && reopened[0]?.xterm === true,
  JSON.stringify(reopened.map((p) => ({ cls: p.cls, hidden: p.hidden, top: p.top }))));

/* #78: the 0.15.10 preferences (two booleans + a global ratio) migrate into the pair model, so an
   operator who had the terminal on top and a dragged height keeps both after the upgrade. */
await ev(`(() => { for (const k of Object.keys(localStorage)) if (/panel-split|panel-pair/.test(k)) localStorage.removeItem(k);
  localStorage.setItem('agentus.panel-split','1'); localStorage.setItem('agentus.panel-split-ide-top','0');
  localStorage.setItem('agentus.panel-split-ratio','300'); return true; })()`);
await goto(BASE);
await sleep(1500);
/* the migrated pair is now the head's SEED for the panel's first tab, so the panel opens straight
   into it — no need to click through a pane button here. */
await openSessionAndPanel();
await sleep(2000);
/* the shared opener clicks 📁 (files); the migrated pair is what the panel lands on when a PANE is
   opened, so click through the head's terminal button. */
await ev(`document.querySelector('.chat-head [aria-label="terminal"]').click(); true`);
await sleep(1500);
const migrated = JSON.parse(await ev(`JSON.stringify({pair: localStorage.getItem('agentus.panel-pair'),
  rows: [...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')].map(p => ({cls: p.dataset.pane, top: Math.round(p.getBoundingClientRect().top), h: Math.round(p.getBoundingClientRect().height)})).sort((a,b)=>a.top-b.top),
  perPair: localStorage.getItem('agentus.panel-split-ratio:ide+terminal')})`));
check("the stored booleans migrate into a pair with the terminal on top",
  migrated.pair === JSON.stringify(["terminal","ide"]) && migrated.rows[0]?.cls === "terminal", JSON.stringify(migrated));
check("the global ratio migrates into the pair's key", Number(migrated.perPair) === 300 || Math.abs((migrated.rows[0]?.h ?? 0) - 300) <= 80,
  JSON.stringify({perPair: migrated.perPair, topH: migrated.rows[0]?.h}));

/* #80 §1: on a wide window the tool windows are reachable from the HEAD. The operator's complaint was
   that a terminal costs 「先点 ▤，再点 terminal」 — two clicks for a window opened all day — and that the
   panel is width-tuned for files, not for a shell. */
const headWide = JSON.parse(await ev(`(() => { const h = document.querySelector('.chat-head');
  const n = (sel) => h.querySelectorAll(sel).length;
  return JSON.stringify({ folder: n('[aria-label="file browser"]'), term: n('[aria-label="terminal"]'),
    ide: n('[aria-label="ide"]'), swap: n('[aria-label="workspace"], [aria-label="change workspace"]') }); })()`));
check("#80 a wide head carries one file-browser button (the 📁/◫ pair collapsed into it)",
  headWide.folder === 1, JSON.stringify(headWide));
check("#80 …plus a terminal and an IDE button of their own",
  headWide.term === 1 && headWide.ide === 1, JSON.stringify(headWide));
check("#80 …and no second folderish workspace button up there (the switcher moved into the tree)",
  headWide.swap === 0, JSON.stringify(headWide));

/* The head's button opens the panel ON that pane — one click, not panel-then-tab. Close it first:
   since the toggle landed, a click on the pane the panel is ALREADY on closes it (checked below). */
await ev(`(() => { const c = document.querySelector('.tool-panel [aria-label="close panel"]'); if (c) c.click(); return Boolean(c); })()`);
await sleep(1000);
await ev(`document.querySelector('.chat-head [aria-label="terminal"]').click(); true`);
await sleep(1200);
const fromHead = JSON.parse(await ev(`JSON.stringify({ open: Boolean(document.querySelector('.tool-panel')),
  onTerm: Boolean(document.querySelector('.tool-tab.active')?.textContent?.includes('terminal')),
  visible: [...document.querySelectorAll('.panel-stack .stack-pane:not([hidden])')].map(p => p.dataset.pane) })`));
check("#80 the head's terminal button lands on the terminal (panel opened, that pane selected)",
  fromHead.open && fromHead.onTerm && fromHead.visible.includes("terminal"), JSON.stringify(fromHead));

/* The operator, 2026-10-30: 「按钮二次点击时应该关闭啊」. A head button that only ever opens leaves the
   panel's own × as the only way back, and the × is at the other end of the panel from where the
   operator's attention is. */
await ev(`document.querySelector('.chat-head [aria-label="terminal"]').click(); true`);
await sleep(1000);
check("#80 clicking the same head button again CLOSES the panel (a toggle, not an opener)",
  await ev(`!document.querySelector('.tool-panel')`), "");
const afterReopen = JSON.parse(await ev(`(() => { const b = document.querySelector('.chat-head [aria-label="file browser"]');
  const before = { panel: Boolean(document.querySelector('.tool-panel')), pressed: b?.getAttribute('aria-expanded') };
  b?.click();
  return JSON.stringify(before); })()`));
await sleep(1500);
check("#80 …and the next click opens it again, on that button's pane",
  (await ev(`Boolean(document.querySelector('.explorer-col'))`)),
  JSON.stringify({ before: afterReopen, panel: await ev(`Boolean(document.querySelector('.tool-panel'))`),
    tabs: await ev(`[...document.querySelectorAll('.tool-tab')].map(t=>t.textContent.trim())`) }));

/* The switcher lives in the FILE browser, so look at the files tab (the head just put us on the
   terminal — that is the point of the previous check). */
await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/files/.test(t.textContent)).click(); true`);
await sleep(1500);

/* #80 §2: the workspace switcher lives at the root of the tree — where "walk up to the parent" and
   "point the session somewhere else" are the same kind of move. */
check("#80 the workspace switcher sits in the file browser's own top, not in the tab bar",
  await ev(`Boolean(document.querySelector('.explorer-col button[aria-label="change workspace"]'))`), "");
check("#80 …and the panel's tab-bar no longer carries a second one",
  await ev(`!document.querySelector('.tool-tabs [aria-label="change workspace"]')`), "");

// A phone keeps the sheet: no switch, one pane. Put the panel back on a PANE first — the files tab
// (where the switcher checks left it) shows zero rows, which would make "one pane" vacuous.
await ev(`[...document.querySelectorAll('.tool-tab')].find(t=>/terminal/.test(t.textContent)).click(); true`);
await sleep(1200);
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await sleep(1500);
const phone = await ev(`(() => { const h = document.querySelector('.chat-head');
  const n = (sel) => h.querySelectorAll(sel).length;
  return { btn: Boolean(document.querySelector('${splitBtn}')),
    folder: n('[aria-label="file browser"]'), term: n('[aria-label="terminal"]'), ide: n('[aria-label="ide"]'),
    tabs: [...document.querySelectorAll('.tool-tab')].map(t => t.textContent.trim()),
    visible: document.querySelectorAll('.panel-stack .stack-pane:not([hidden])').length,
    overflow: document.documentElement.scrollWidth - innerWidth }; })()`);
check("a phone offers no split switch", phone.btn === false, JSON.stringify(phone));
/* #80 §1, the other half: a phone's head keeps ONE button. 「手机上 head 那排已经很挤了，再加两个就放不下了」
   — terminal and IDE retreat into the panel's tab bar, where a phone already looks for panes. */
check("#80 a phone's head keeps the file browser and nothing else",
  phone.folder === 1 && phone.term === 0 && phone.ide === 0, JSON.stringify({ folder: phone.folder, term: phone.term, ide: phone.ide }));
check("#80 …and terminal/IDE stay reachable from the panel's tab bar there",
  phone.tabs.some((t) => /terminal/.test(t)) && phone.tabs.some((t) => /ide/.test(t)), JSON.stringify(phone.tabs));
check("a phone still shows exactly one pane", phone.visible === 1, `visible=${phone.visible}`);
check("…and nothing overflows horizontally", phone.overflow === 0, `overflow=${phone.overflow}`);

await send("Emulation.clearDeviceMetricsOverride");
ws.close();
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
