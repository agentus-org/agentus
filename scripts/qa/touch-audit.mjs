// Touch/layout audit at a phone viewport: tap-target sizes, horizontal overflow, and the
// session actions inside the drawer. Manual QA, needs a browser on :9222.
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`${CDP}/json/list`)).json();
// the cockpit's ports: live 8788, dev 8901, the tunnel entry 38788, vite's own 5173.
const tab = list.find((t) => t.type === 'page' && /:(8788|8901|38788|5173)\b/.test(t.url));
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
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await sleep(300);
await send('Page.reload', { ignoreCache: true });
await sleep(3500);
console.log(`== touch audit @ ${W}x${H} ==`);

const MEASURE = `(() => {
  const out = [];
  for (const [label, sel] of [['ctx readout', '.usage-text'], ['tb btn (model)', 'button[data-testid="tb-model"]'],
      ['tb btn (depth)', 'button[data-testid="tb-effort"]'], ['gear', 'button[aria-label="chat settings"]'],
      ['attach', 'button[aria-label="attach"]'], ['mic', 'button[aria-label="dictate"]'],
      ['menu', '.menu-btn'], ['send', '.send-btn'], ['session fork', '.session-item .item-btn']]) {
    let el = document.querySelector(sel);
    if (!el && sel === '.session-item .item-btn') {           // only inside the opened drawer
      document.querySelector('.menu-btn')?.click(); el = null;
    }
    if (!el) { out.push([label, null, 'missing']); continue; }
    const r = el.getBoundingClientRect();
    out.push([label, [Math.round(r.width), Math.round(r.height)], r.width < 30 || r.height < 24 ? 'SMALL' : 'ok']);
  }
  return out;
})()`;

// 1) the composer toolbar / composer controls, closed state
console.log('--- 触控目标（关闭态）---');
for (const [label, size, verdict] of await ev(MEASURE)) {
  const dim = size ? size.join('x') : '-';
  console.log(`  ${String(label).padEnd(18)} ${dim.padStart(9)}  ${verdict}`);
}

// 2) the drawer: session actions available on a touch device?
await ev(`(() => { const b = document.querySelector('.menu-btn'); if (b) b.click(); return true; })()`);
await sleep(500);
const drawer = await ev(`(() => {
  const s = document.querySelector('.sidebar'); if (!s) return { open: false };
  const r = s.getBoundingClientRect();
  const items = [...s.querySelectorAll('.session-item')].slice(0, 3).map((it) => {
    const ir = it.getBoundingClientRect();
    const acts = [...it.querySelectorAll('button')].map((b) => { const br = b.getBoundingClientRect();
      return [b.getAttribute('aria-label') || b.className.split(' ')[0], Math.round(br.width), Math.round(br.height), getComputedStyle(b).opacity, getComputedStyle(b).visibility]; });
    return { h: Math.round(ir.height), acts };
  });
  const first = s.querySelector('.side-item');
  return { open: true, rect: [Math.round(r.x), Math.round(r.height)], items,
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth };
})()`);
console.log('--- 抽屉（侧栏）---');
console.log(' ', JSON.stringify(drawer).slice(0, 700));
await ev(`window.__esc ? window.__esc() : document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
await sleep(300);

// 2b) the settings page controls (they only exist there)
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'settings'); if (b) b.click(); return true; })()`);
await sleep(900);
console.log('--- 设置页触控目标 ---');
for (const [label, size, verdict] of await ev(`(() => {
  const out = [];
  for (const [l, sel] of [['theme mode btn', '.set-seg button'], ['accent swatch', '.set-swatch'],
      ['colour input', '.set-color'], ['save', '.set-save'], ['mini (默认)', '.set-mini']]) {
    const el = document.querySelector(sel);
    if (!el) { out.push([l, null, 'missing']); continue; }
    const r = el.getBoundingClientRect();
    out.push([l, [Math.round(r.width), Math.round(r.height)], r.width < 30 || r.height < 24 ? 'SMALL' : 'ok']);
  }
  return out; })()`)) {
  const dim = size ? size.join('x') : '-';
  console.log(`  ${String(label).padEnd(18)} ${dim.padStart(9)}  ${verdict}`);
}
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'settings'); if (b) b.click(); return true; })()`);
await sleep(600);

// 3) the settings page at this width: overflow + reachable sections
await ev(`(() => { const b = document.querySelector('button[aria-label="settings"]') || [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'settings'); if (b) b.click(); return true; })()`);
await sleep(900);
const page = await ev(`(() => {
  const root = document.querySelector('.settings-page, .set-page, .main'); if (!root) return { found: false };
  const wide = [...root.querySelectorAll('*')].map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > innerWidth + 1 && r.height > 4).slice(0, 5).map((r) => [Math.round(r.x), Math.round(r.width)]);
  const btns = [...root.querySelectorAll('button')].slice(0, 14).map((b) => { const r = b.getBoundingClientRect();
    return [b.textContent.trim().slice(0, 12), Math.round(r.width), Math.round(r.height)]; });
  return { found: true, scrollWidth: document.documentElement.scrollWidth, innerWidth, tooWide: wide, buttons: btns,
    text: document.body.innerText.slice(0, 120).split(String.fromCharCode(10)).join(' | ') };
})()`);
console.log('--- 设置页 ---');
console.log(' ', JSON.stringify(page).slice(0, 900));
process.exit(0);
