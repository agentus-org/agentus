// Popover screen-fit sweep (manual QA — needs a real browser, so it is not in CI).
//
// Why it exists: the ctx-window popover was "verified" three times by reading its textContent
// and clicking its buttons from JS, while it was in fact laid out ABOVE the document top
// (y = -178 on a 390x844 viewport, whose offsetParent was BODY) and therefore invisible.
// Presence in the DOM is not visibility: this asserts geometry — every popover must land
// INSIDE the viewport, and its offsetParent must be a real positioned ancestor.
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, open the app in a tab, then
//        W=390 H=844 node scripts/qa/popover-sweep.mjs     # phone
//        W=1440 H=900 node scripts/qa/popover-sweep.mjs    # desktop
//
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`${CDP}/json/list`)).json();
const tab = list.find((t) => t.type === 'page' && t.url.includes('8787'));
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); } };
const send = (method, params = {}, timeout = 20000) => new Promise((res, rej) => {
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error('TIMEOUT ' + method)); }, timeout);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, timeout = 20000) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err');
  return r.result.value;
};

const W = Number(process.env.W || 390), H = Number(process.env.H || 844);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: W < 700 });
await sleep(500);
console.log(`== viewport ${W}x${H} ==`);

const MEASURE = (sel) => `(() => {
  const d = document.querySelector(${JSON.stringify(sel)});
  if (!d) return { found: false };
  const r = d.getBoundingClientRect(), cs = getComputedStyle(d);
  const op = d.offsetParent;
  let hit = null;
  try { const cx = Math.min(Math.max(r.x + r.width/2, 1), innerWidth - 1), cy = Math.min(Math.max(r.y + r.height/2, 1), innerHeight - 1);
    if (Number.isFinite(cx) && Number.isFinite(cy)) { const el = document.elementFromPoint(cx, cy); hit = el ? (d.contains(el) || el.contains(d) ? 'ok' : el.tagName + '.' + String(el.className).split(' ')[0]) : 'none'; } }
  catch (e) { hit = 'err'; }
  return { found: true, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    vw: innerWidth, vh: innerHeight,
    inside: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
    offTop: Math.round(r.top), offBottom: Math.round(r.bottom - innerHeight), offLeft: Math.round(r.left), offRight: Math.round(r.right - innerWidth),
    offsetParent: op ? op.tagName + '.' + String(op.className).split(' ').slice(0,2).join('.') : 'null',
    display: cs.display, vis: cs.visibility, z: cs.zIndex, hitAtCentre: hit };
})()`;

const openers = [
  ['ctx window', `(() => { const b = document.querySelector('.usage-text'); if (!b) return 'no button'; if (!document.querySelector('.usage-detail')) b.click(); return 'clicked'; })()`, '.usage-detail'],
  ['chat settings', `(() => { const b = document.querySelector('button[aria-label="chat settings"]'); if (!b) return 'no button'; if (!document.querySelector('.settings-pop')) b.click(); return 'clicked'; })()`, '.settings-pop'],
  ['model picker', `(() => { const b = document.querySelector('button[data-testid="tb-model"]'); if (!b) return 'no button'; if (!document.querySelector('.tb-list')) b.click(); return 'clicked'; })()`, '.tb-list'],
  ['depth picker', `(() => { const b = document.querySelector('button[data-testid="tb-effort"]'); if (!b) return 'no button'; if (!document.querySelector('.tb-list')) b.click(); return 'clicked'; })()`, '.tb-list'],
];

for (const [name, open, sel] of openers) {
  const closers = [' .usage-detail', '.settings-pop', '.tb-list'];
  await ev(`(() => { const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }); document.dispatchEvent(esc);
     document.querySelectorAll('.usage-detail, .settings-pop, .tb-list').forEach(el => { const btn = el.closest('.usage-row, .composer-bar, .tb-wrap'); void btn; });
     const b = document.querySelector('.usage-text'); if (b && document.querySelector('.usage-detail')) b.click();
     return true; })()`);
  await sleep(150);
  const st = await ev(open);
  await sleep(400);
  const m = await ev(MEASURE(sel));
  const verdict = !m.found ? 'MISSING' : m.inside ? 'INSIDE  ✔' : 'OUTSIDE ✘';
  console.log(`${name.padEnd(14)} ${verdict}  open=${st}  ${JSON.stringify(m)}`);
  // leave things tidy for the next one
  await ev(`document.querySelectorAll('.usage-detail').forEach(() => document.querySelector('.usage-text')?.click())`);
  await sleep(200);
}
process.exit(0);
