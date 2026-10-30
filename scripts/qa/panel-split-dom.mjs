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
await ev(`localStorage.removeItem('agentus.panel-split'); localStorage.removeItem('agentus.panel-split-ide-top'); true`);
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
const panes = `JSON.stringify([...document.querySelectorAll('.panel-stack .stack-pane')].map(p => ({
  cls: p.className, hidden: p.hidden, top: Math.round(p.getBoundingClientRect().top),
  h: Math.round(p.getBoundingClientRect().height), iframe: Boolean(p.querySelector('iframe')),
  xterm: Boolean(p.querySelector('.xterm')) })))`;

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
check("clicking the terminal tab puts the terminal on top", swapped[1]?.top < swapped[0]?.top,
  JSON.stringify(swapped.map((p) => ({ cls: p.cls, top: p.top }))));
const kept = await ev(`(() => ({ iframe: document.querySelector('.pane-ide iframe').dataset.mark === 'keep',
  xterm: document.querySelector('.pane-term .xterm').dataset.mark === 'keep' }))()`);
check("swapping does NOT reload the IDE frame (a re-mount would restart code-server)", kept.iframe === true, JSON.stringify(kept));
check("swapping does NOT open a new pty (the terminal element survives)", kept.xterm === true, JSON.stringify(kept));
check("the choice is remembered", await ev(`localStorage.getItem('agentus.panel-split-ide-top')`) === "0", await ev(`localStorage.getItem('agentus.panel-split-ide-top')`));

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
  reopened.filter((p) => !p.hidden).length === 2 && reopened[1]?.top < reopened[0]?.top,
  JSON.stringify(reopened.map((p) => ({ cls: p.cls, hidden: p.hidden, top: p.top }))));

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
