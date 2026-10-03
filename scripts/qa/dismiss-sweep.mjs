// Dismissal sweep (manual QA — needs a real browser, so it is not in CI).
//
// For every popover / menu / modal the app draws, assert the three ways out an operator
// expects: (1) a pointerdown outside puts it away, (2) Escape puts it away, (3) a
// pointerdown INSIDE leaves it alone. A trigger re-click must still toggle.
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, open the app in a tab, then
//        W=390 H=844 node scripts/qa/dismiss-sweep.mjs     # phone
//        W=1440 H=900 node scripts/qa/dismiss-sweep.mjs    # desktop
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`${CDP}/json/list`)).json();
const tab = list.find((t) => t.type === 'page' && t.url.includes('8787'));
if (!tab) { console.log('no app tab on :9222 — nothing to measure'); process.exit(1); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); } };
const send = (m, p = {}, t = 20000) => new Promise((res, rej) => {
  const mid = ++id; const to = setTimeout(() => { waiting.delete(mid); rej(new Error('TIMEOUT ' + m)); }, t);
  waiting.set(mid, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method: m, params: p }));
});
const ev = async (expr, t = 20000) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, t);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};

const W = Number(process.env.W || 390), H = Number(process.env.H || 844);
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: W < 700 });
await sleep(300);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);
console.log(`== dismissal sweep @ ${W}x${H} ==`);

// helpers injected into the page: synthetic pointerdown + click, and an Escape
const HELPERS = `
window.__out = (sel) => {                       // 真·点外面：取一个面板之外的落点，谁在最上面就点谁
  const p = sel ? document.querySelector(sel) : null;
  const r = p && p.getBoundingClientRect();
  const cands = [[innerWidth / 2, 30], [innerWidth / 2, innerHeight / 2], [16, innerHeight - 16], [innerWidth - 16, innerHeight - 16]];
  let t = null;
  for (const [x, y] of cands) {
    if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) continue;   // 落在面板里，换一个点
    const el = document.elementFromPoint(x, y); if (el) { t = el; break; }
  }
  t = t || document.body;
  t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return t.tagName + '.' + String(t.className).split(' ')[0]; };
window.__esc = () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; };
window.__click = (sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; };
window.__setText = (txt) => { const ta = document.querySelector('.composer textarea');
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, txt); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; };
window.__byText = (txt) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().toLowerCase().startsWith(txt));
`;
await ev(`(() => { ${HELPERS} return true; })()`);

const results = [];
const rec = (name, ok, detail) => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`); };

/** one overlay: how to open, how to see it, an element inside it, whether a trigger exists */
async function check(name, opts) {
  const present = (sel) => `!!document.querySelector(${JSON.stringify(sel)})`;
  const clear = async () => {
    // make sure we start closed (Escape is now the universal way out)
    for (let i = 0; i < 3; i++) { await ev(`window.__esc()`); await sleep(120); }
    if (opts.clear) await ev(opts.clear);
  };
  await clear();
  if (opts.open) { await ev(opts.open); } else { await ev(`window.__click(${JSON.stringify(opts.trigger)})`); }
  await sleep(350);
  const opened = await ev(present(opts.panel));
  rec(`${name} · open`, opened, `panel ${opened ? 'present' : 'MISSING'}`);
  if (!opened) return;

  if (opts.insideFirst) {
    // a pointerdown inside must NOT close it
    await ev(`(() => { const el = document.querySelector(${JSON.stringify(opts.panel)});
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true; })()`);
    await sleep(200);
    rec(`${name} · click inside keeps it`, await ev(present(opts.panel)), 'still open');
  }

  if (opts.noOutside) { rec(`${name} · click outside closes`, true, 'n/a — full-screen sheet'); }
  else {
  const hit = await ev(`window.__out(${JSON.stringify(opts.geom || opts.panel)})`);
  await sleep(300);
  rec(`${name} · click outside closes`, !(await ev(present(opts.panel))), `hit ${hit} → ${await ev(present(opts.panel)) ? 'still open' : 'closed'}`);
  }

  // reopen, then Escape (a sheet that was never dismissed is still open: use it as-is)
  let reopened;
  if (opts.noOutside) { reopened = await ev(present(opts.panel)); }
  else {
    if (opts.reopen) await ev(opts.reopen);
    else if (opts.open) await ev(opts.open);
    else await ev(`window.__click(${JSON.stringify(opts.trigger)})`);
    await sleep(350);
    reopened = await ev(present(opts.panel));
  }
  if (reopened) {
    await ev(`window.__esc()`);
    await sleep(300);
    rec(`${name} · Escape closes`, !(await ev(present(opts.panel))), 'closed by Escape');
  } else {
    rec(`${name} · reopen for Escape`, false, 'could not reopen');
  }

  // and the trigger still toggles
  if (opts.trigger && !opts.noToggle) {
    await clear();
    await ev(`window.__click(${JSON.stringify(opts.trigger)})`); await sleep(300);
    const a = await ev(present(opts.panel));
    await ev(`window.__click(${JSON.stringify(opts.trigger)})`); await sleep(300);
    const b = await ev(present(opts.panel));
    rec(`${name} · trigger toggles`, a && !b, `open=${a} → closed=${!b}`);
  }
}

await check('ctx window popover', { trigger: '.usage-text', panel: '.usage-detail', insideFirst: true });
await check('chat settings popover', { trigger: 'button[aria-label="chat settings"]', panel: '.settings-pop', insideFirst: true });
await check('model picker', { trigger: 'button[data-testid="tb-model"]', panel: '.tb-list', insideFirst: true });
await check('depth picker', { trigger: 'button[data-testid="tb-effort"]', panel: '.tb-list', insideFirst: true });
await check('slash palette', {
  open: '(window.__setText(""), window.__setText("/"), true)', panel: '.slash-palette', insideFirst: true,
  reopen: '(window.__setText(""), window.__setText("/"), true)',
  clear: 'window.__setText("")',
});
await check('new-session modal', {
  open: '(window.__click(window.__byText("new session")), true)', panel: '.modal-bg', geom: '.modal', noToggle: true,
});
if (W < 700) {
  // the drawer has no toggle: the menu button only opens, the scrim / Escape close it
  await check('session drawer', { trigger: '.menu-btn', panel: '.scrim', geom: '.sidebar', noToggle: true });
  // a full-screen sheet has no "outside"; opening and Escape are what can be checked
  await check('tool panel sheet', { trigger: 'button[aria-label="workspace panel"]', panel: '.tool-panel', noToggle: true, noOutside: true });
}

const bad = results.filter((r) => !r[1]);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length) console.log('failing:', bad.map((b) => b[0]).join(', '));
process.exit(bad.length ? 1 : 0);
