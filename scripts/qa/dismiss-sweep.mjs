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
const PORT = Number(process.env.PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Open our OWN tab (like transcript-sweep): adopting whatever tab is open measures a page in an
// unknown state — every panel then reads MISSING and the helpers throw on an absent composer,
// which looks like a UI failure instead of a setup problem.
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json();
await sleep(2600);
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
  // awaitPromise: the sweeps post prompts/sessions with fetch(); without it CDP serialises the
  // pending Promise as `{}`, which then looks like a (truthy!) session id.
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, t);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};

const W = Number(process.env.W || 390), H = Number(process.env.H || 844);
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: W < 700 });
await sleep(300);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);
console.log(`== dismissal sweep @ ${W}x${H} on :${PORT} ==`);

// Every panel here hangs off the COMPOSER, so a page on the session list has nothing to measure:
// pick a session in-page (this tab shares the profile's login) and wait for the composer.
// The app CONSUMES `?session=` and strips it from the URL (state.ts #openTarget), so remember the
// id ourselves instead of reading location.search again later — a later read is always null.
let SESSION_ID = await ev(`new URLSearchParams(location.search).get('session')`);
if (!SESSION_ID) {
  // Create a FRESH mock session rather than adopting one: an adopted session may be mid-turn (a
  // prompt then 409s) or carry a pending permission dialog, and this sweep needs a quiet composer
  // that can still produce usage.
  for (let i = 0; i < 10 && !SESSION_ID; i++) {
    SESSION_ID = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp'})}).then(r => r.json()).then(d => d.id || '')`);
    if (!SESSION_ID) await sleep(700);
  }
  if (!SESSION_ID) { console.log('could not create a session to measure'); process.exit(2); }
  await ev(`location.href = ${JSON.stringify(BASE + '/?session=')} + ${JSON.stringify(String(SESSION_ID))}`);
  await sleep(3500);
}
for (let i = 0; i < 40; i++) {
  if (await ev(`Boolean(document.querySelector('.composer textarea'))`)) break;
  await sleep(250);
}

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

  if (opts.outsideStaysOpen) {
    // Some overlays have no scrim ON PURPOSE (the new-session dialog carries a folder choice;
    // a stray click outside must not drop a half-set-up session). Assert that, rather than the
    // generic "outside closes" the other panels honour.
    const hit = await ev(`window.__out(${JSON.stringify(opts.geom || opts.panel)})`);
    await sleep(300);
    rec(`${name} · outside leaves it open`, await ev(present(opts.panel)), `hit ${hit} — no scrim by design`);
  } else if (opts.noOutside) { rec(`${name} · click outside closes`, true, 'n/a — full-screen sheet'); }
  else {
  const hit = await ev(`window.__out(${JSON.stringify(opts.geom || opts.panel)})`);
  await sleep(300);
  rec(`${name} · click outside closes`, !(await ev(present(opts.panel))), `hit ${hit} → ${await ev(present(opts.panel)) ? 'still open' : 'closed'}`);
  }

  // reopen, then Escape (a sheet that was never dismissed is still open: use it as-is)
  let reopened;
  if (opts.noOutside || opts.outsideStaysOpen) { reopened = await ev(present(opts.panel)); }
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

// The ctx-window popover only exists once the session HAS usage (the row is hidden without it),
// so give the session one mock turn before measuring. The usage can land while the page is still
// wiring its socket up, so reload once the turn is done and let the app read usage from the
// server — otherwise the panel reads MISSING and the sweep's own subject is untested.
const sidInUrl = SESSION_ID;
const warmStatus = await ev(`fetch('/api/sessions/' + ${JSON.stringify(String(sidInUrl))} + '/prompt',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'dismissal sweep warmup' }) }).then(r => r.status)`);
console.log(`warmup: session=${sidInUrl} prompt HTTP ${warmStatus}`);
await sleep(2500);
await send('Page.reload', { ignoreCache: false });
await sleep(3000);
for (let i = 0; i < 40; i++) {
  if (await ev(`Boolean(document.querySelector('.usage-text'))`)) break;
  await sleep(300);
}
// A reload wipes the injected helpers with the old document — put them back.
await ev(`(() => { ${HELPERS} return true; })()`);

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
  outsideStaysOpen: true,
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
