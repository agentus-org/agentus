// Table sweep (manual QA — needs a real browser, so it is not in CI).
//
// §3 asked for two things about a table in a reply: sortable headers, and a way to read a wide
// table on a phone. Both are DOM work done after the paint (tableSort.ts), so both need a real
// browser — and this drives them through a REAL agent bubble: the mock's `[table]` trigger
// replies with an unsorted 6-row table (numeric + text cells), a local file link and a relative
// image, so nothing here is injected by the sweep itself.
//
// The assertions that matter:
//   · "clicking a header reorders the rows" — compared against the expected orders, including
//     the one that catches string sorting (2 before 10 before 100, not "10" < "100" < "2");
//   · aria-sort says which way the column points;
//   · the filter hides exactly the non-matching rows;
//   · the file chip in the REPLY opens the panel (the reply path, not a hand-built fixture);
//   · `![](shot.png)` inside the reply resolves against the session workspace;
//   · on a 390x844 viewport the full-screen reader rotates the table (iOS cannot lock
//     orientation, so rotating the content is the whole answer).
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, then
//        PORT=8901 node scripts/qa/table-sweep.mjs
import fs from 'node:fs';
import path from 'node:path';

const CDP = 'http://127.0.0.1:9222';
const PORT = Number(process.env.PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const WORK = process.env.FIXTURE_DIR || '/tmp/agentus-qa-files';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ''}`); }
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAZ7lYbQAAAAASUVORK5CYII=', 'base64');
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'shot.png'), PNG);
if (!fs.existsSync(path.join(WORK, 'note.md'))) fs.writeFileSync(path.join(WORK, 'note.md'), '# Note\n\nline two\n');
if (!fs.existsSync(path.join(WORK, 'app.py'))) fs.writeFileSync(path.join(WORK, 'app.py'), 'def hi():\n    return "hi"\n');

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json();
await sleep(2600);
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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval err');
  return r.result.value;
};
const until = async (expr, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(300);
  }
  return false;
};

const U = process.env.DEV_USER || 'scratch';
const P = process.env.DEV_PASS || 'scratch-pass-1';
await sleep(200);
if (!(await ev(`fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.authenticated)`))) {
  const code = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  if (code !== 200) { console.log('login failed'); process.exit(2); }
  await ev(`location.reload()`);
  await sleep(3000);
}

let SID = '';
for (let i = 0; i < 10 && !SID; i++) {
  SID = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:${JSON.stringify(WORK)}})}).then(r => r.json()).then(d => d.id || '')`);
  if (!SID) await sleep(700);
}
if (!SID) { console.log('could not create a session'); process.exit(2); }
await ev(`location.href = ${JSON.stringify(BASE + '/?session=')} + ${JSON.stringify(SID)}`);
await sleep(3200);
if (!(await until(`Boolean(document.querySelector('.composer'))`, 20000))) { console.log('no composer'); process.exit(2); }

console.log(`== table sweep @ :${PORT} ==`);
await ev(`fetch('/api/sessions/' + ${JSON.stringify(SID)} + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '[table]' }) }).then(r => r.status)`);
const gotTable = await until(`Boolean([...document.querySelectorAll('.msg.agent')].find(b => b.textContent.includes('table fixture') && b.querySelector('table')))`, 30000);
check(gotTable, 'the mock replied with a table (a real agent bubble, nothing injected)');
if (!gotTable) { await send('Target.closeTarget', { targetId: tab.id }).catch(() => {}); console.log('cannot continue'); process.exit(1); }

const BUBBLE = `[...document.querySelectorAll('.msg.agent')].find(b => b.textContent.includes('table fixture'))`;
const names = () => ev(`(() => {
  const b = ${BUBBLE};
  return [...b.querySelectorAll('.md table tbody tr')].map(r => r.cells[0].textContent.trim()).join(',');
})()`);

console.log('== sortable headers ==');
check(await ev(`(${BUBBLE}).querySelectorAll('.md table th .md-table-sort').length`) === 3,
  'every header cell has a sort button', String(await ev(`(${BUBBLE}).querySelectorAll('.md table th .md-table-sort').length`)));
check(await ev(`Boolean((${BUBBLE}).querySelector('.md-table-filter'))`), 'a 6-row table gets a filter box');
check((await names()) === 'zeta,alpha,mu,beta,kappa,gamma', 'the rows start in the order the agent wrote them', await names());

const clickHeader = (i) => ev(`(() => { const b = ${BUBBLE}; const th = b.querySelectorAll('.md table th')[${i}]; const btn = th.querySelector('.md-table-sort'); btn.click(); return th.getAttribute('aria-sort'); })()`);
const asc = await clickHeader(1);
await sleep(400);
check((await names()) === 'beta,gamma,alpha,zeta,kappa,mu', 'sorting "count" ascending is NUMERIC (2,7,9,10,33,100)', await names());
check(asc === 'ascending', 'aria-sort reports the direction', String(asc));
check(await ev(`(${BUBBLE}).querySelectorAll('.md table th')[1].querySelector('.md-table-sort-indicator').textContent`) === '▲',
  'the arrow points up');
const desc = await clickHeader(1);
await sleep(400);
check((await names()) === 'mu,kappa,zeta,alpha,gamma,beta', 'clicking again reverses it', await names());
check(desc === 'descending', 'aria-sort follows', String(desc));
await clickHeader(0);
await sleep(400);
check((await names()) === 'alpha,beta,gamma,kappa,mu,zeta', 'sorting "name" is alphabetical');
check(await ev(`(${BUBBLE}).querySelectorAll('.md table th')[1].getAttribute('aria-sort')`) === 'none',
  'the previous column no longer claims to be sorted');

console.log('== filter ==');
await ev(`(() => { const f = (${BUBBLE}).querySelector('.md-table-filter'); f.value = 'ka'; f.dispatchEvent(new Event('input', { bubbles: true })); return true })()`);
await sleep(400);
check(await ev(`(() => { const b = ${BUBBLE}; const rows = [...b.querySelectorAll('.md table tbody tr')]; return rows.filter(r => !r.hidden).map(r => r.cells[0].textContent.trim()).join(',') })()`) === 'kappa',
  'the filter hides every non-matching row');
await ev(`(() => { const f = (${BUBBLE}).querySelector('.md-table-filter'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); return true })()`);
await sleep(300);
check(await ev(`(() => { const b = ${BUBBLE}; return [...b.querySelectorAll('.md table tbody tr')].filter(r => !r.hidden).length })()`) === 6,
  'clearing the filter brings them all back');

console.log('== the reply\'s own file link and image ==');
check(await ev(`Boolean((${BUBBLE}).querySelector('a.md-file-link[data-file-path="${path.join(WORK, 'note.md')}"]'))`),
  'the file:// link in the reply is a chip for the right path');
check(await ev(`(${BUBBLE}).querySelector('a.md-file-link[data-file-path="${path.join(WORK, 'note.md')}"]')?.dataset.fileLine`) === '2',
  'and it kept #L2');
check(await ev(`Boolean((${BUBBLE}).querySelector('img.md-img[src="/api/fs/raw?path=${encodeURIComponent(path.join(WORK, 'shot.png'))}"]'))`),
  'the RELATIVE image resolved against the session workspace');
check(await ev(`(async () => { const r = await fetch((${BUBBLE}).querySelector('img.md-img').getAttribute('src')); return r.status })()`) === 200,
  'and that image really loads');
await ev(`(${BUBBLE}).querySelector('a.md-file-link').click()`);
await sleep(1600);
check(await ev(`Boolean(document.querySelector('.tool-panel .file-preview'))`),
  'clicking the chip in the REPLY opened the panel on that file');
check(await ev(`(document.querySelector('.tool-panel .file-preview .file-name')?.textContent || '').includes('note.md')`),
  'and it is the file the chip named',
  await ev(`document.querySelector('.tool-panel .file-preview .file-name')?.textContent || ''`));
await ev(`(() => { const b = document.querySelector('.tool-panel .file-preview-head .icon-btn'); b && b.click(); return true })()`);
await sleep(300);

console.log('== the full-screen reader (desktop) ==');
check(await ev(`(() => { const b = ${BUBBLE}; const btn = b.querySelector('.md-table-bar .md-table-btn'); btn.click(); return Boolean(document.querySelector('.md-table-overlay')) })()`),
  '⤢ opens the reader');
check(await ev(`document.querySelectorAll('.md-table-overlay table tbody tr').length`) === 6, 'the reader shows all 6 rows');
check(await ev(`document.querySelectorAll('.md-table-overlay table th .md-table-sort').length`) === 3,
  'the reader\'s table is sortable too');
check(await ev(`!document.querySelector('.md-table-zoom').classList.contains('rot')`), 'no rotation needed on a wide viewport');
await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await sleep(300);
check(await ev(`!document.querySelector('.md-table-overlay')`), 'Escape closes it');

console.log('== the full-screen reader on a phone (390x844) ==');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(800);
check(await ev(`(() => { const b = ${BUBBLE}; const btn = b.querySelector('.md-table-bar .md-table-btn'); btn.click(); return true })()`), 'opened on the phone');
await sleep(600);
check(await ev(`Boolean(document.querySelector('.md-table-zoom.rot'))`),
  'a portrait phone gets the rotated view (iOS cannot lock orientation, so the CONTENT rotates)');
{
  // The point of the rotation is LAYOUT, so measure layout: the box the table lives in is sized
  // to the phone's LONG edge (offsetWidth is pre-transform, i.e. the space the table actually
  // gets). The rotated box is then just the same box turned 90°, which is what makes the table
  // read upright once the operator turns the phone — iOS cannot lock orientation for us.
  const g = await ev(`(() => {
    const z = document.querySelector('.md-table-zoom');
    const t = z.querySelector('table').getBoundingClientRect();
    return JSON.stringify({
      layoutW: z.offsetWidth, layoutH: z.offsetHeight,
      vw: innerWidth, vh: innerHeight,
      inside: t.left >= -1 && t.top >= -1 && t.right <= innerWidth + 1 && t.bottom <= innerHeight + 1,
      tableW: Math.round(t.width),
    });
  })()`);
  const o = JSON.parse(g);
  check(o.layoutW > o.vw, 'the table is laid out on the phone\'s LONG edge, not its portrait width',
    `${o.layoutW}x${o.layoutH} content box on a ${o.vw}x${o.vh} viewport`);
  check(o.layoutW > o.layoutH, 'the content box itself is landscape-shaped');
  check(o.inside, 'and the rotated table stays inside the viewport', `visible table ${o.tableW}px`);
}
check(await ev(`(() => { const b = document.querySelector('.md-table-overlay .md-table-btn'); b.click(); return !document.querySelector('.md-table-zoom').classList.contains('rot') })()`),
  'the rotate button turns the rotation off again');
await ev(`[...document.querySelectorAll('.md-table-overlay .md-table-btn')].find(b => /close/i.test(b.textContent)).click()`);
await sleep(300);
check(await ev(`!document.querySelector('.md-table-overlay')`), 'close dismisses the reader');

await send('Emulation.clearDeviceMetricsOverride').catch(() => {});
await send('Target.closeTarget', { targetId: tab.id }).catch(() => {});
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
