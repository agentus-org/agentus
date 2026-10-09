// Local-file rendering sweep (manual QA — needs a real browser, so it is not in CI).
//
// What it covers, all of it end-to-end through the real app on :8901:
//   §2b  a local path in a reply — `[x.md](file:///…#L3)`, `[x.md](/abs/x.md)` and a bare path —
//        becomes a chip carrying the path+line, NOT a link that navigates away.
//   §2c  `![](/abs/shot.png)` renders as a real <img> served from /api/fs/raw.
//   §2d  the workspace panel renders markdown / image / csv / code as themselves, edits and
//        SAVES a file, and the raw endpoint is behind the auth gate.
//
// The clicks are dispatched at REAL elements: React attaches the markdown handlers as native
// listeners on the `.md` node, so a click on a chip inside it goes through the shipping code
// path rather than through a reimplementation of it in the sweep.
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, then
//        PORT=8901 node scripts/qa/render-files-sweep.mjs
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

// ---- fixtures ---------------------------------------------------------------------------
const PNG_2x2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAZ7lYbQAAAAASUVORK5CYII=',
  'base64',
);
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'shot.png'), PNG_2x2);
fs.writeFileSync(path.join(WORK, 'shot2.png'), PNG_2x2);
fs.writeFileSync(path.join(WORK, 'data.csv'), 'a,b\n1,2\n3,4\n');
fs.writeFileSync(path.join(WORK, 'app.py'), 'def hi():\n    return "hi"\n');
fs.writeFileSync(path.join(WORK, 'note.md'), '# Note\n\nsee ![shot](shot.png)\n\nbody text\n');
const FIXTURE_MD = [
  '## files',
  '',
  '- [note.md](file://' + path.join(WORK, 'note.md') + '#L3)',
  '- [csv](' + path.join(WORK, 'data.csv') + ')',
  '- bare ' + path.join(WORK, 'app.py') + ':2 and ~/not/here.md',
  '- outside [docs](https://example.com/x)',
  '',
  '![local shot](' + path.join(WORK, 'shot.png') + ')',
  '',
  '![](shot2.png)',
  '',
  'plain https://example.com/page text',
].join('\n');

// ---- CDP harness (same shape as popover-sweep) ------------------------------------------
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
const until = async (expr, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(300);
  }
  return false;
};

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(400);
console.log(`== render/files sweep @ :${PORT} (fixtures in ${WORK}) ==`);

// Log in unless this tab already is: the dev instance has its own cookie (the profile's live
// login does not cover a second port), and every other sweep logs in the same way.
const U = process.env.DEV_USER || 'scratch';
const P = process.env.DEV_PASS || 'scratch-pass-1';
const me = await ev(`fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.authenticated)`);
if (!me) {
  const code = await ev(`fetch('/api/auth/login',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then(r=>r.status)`);
  console.log(`logged in as ${U} (${code})`);
  if (code !== 200) { console.log('login failed — check DEV_USER/DEV_PASS'); process.exit(2); }
  await ev(`location.reload()`);
  await sleep(3000);
}

// A FRESH mock session rooted at the fixture dir: the panel's tree and the relative-path base
// both come from the session workspace, so this is what makes `![](shot2.png)` resolvable.
let SID = '';
for (let i = 0; i < 10 && !SID; i++) {
  SID = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:${JSON.stringify(WORK)}})}).then(r => r.json()).then(d => d.id || '')`);
  if (!SID) await sleep(700);
}
if (!SID) { console.log('could not create a session'); process.exit(2); }
await ev(`location.href = ${JSON.stringify(BASE + '/?session=')} + ${JSON.stringify(SID)}`);
await sleep(3200);
if (!(await until(`Boolean(document.querySelector('.composer'))`, 20000))) {
  console.log('no composer — is the dev instance up and this browser logged in?');
  process.exit(2);
}

// ---- §2b/§2c: the renderer ---------------------------------------------------------------
const hasFn = await ev(`typeof window.__renderMarkdown === 'function'`);
if (!hasFn) { console.log('window.__renderMarkdown missing — the QA handle was not shipped'); process.exit(2); }
await ev(`window.__QA_MD = window.__renderMarkdown(${JSON.stringify(FIXTURE_MD)}, ${JSON.stringify(WORK)})`);
const html = await ev(`window.__QA_MD`);

console.log('== §2b a local path becomes a chip, not a link out ==');
check(!/\[note\.md\]/.test(html), 'no raw brackets left for the file:// link');
check(html.includes(`data-file-path="${path.join(WORK, 'note.md')}"`), 'file:// link carries its path',
  path.join(WORK, 'note.md'));
check(html.includes('data-file-line="3"'), 'the #L3 anchor is kept');
check(html.includes(`data-file-path="${path.join(WORK, 'data.csv')}"`), 'an absolute-path link is a chip too');
check(html.includes(`data-file-path="${path.join(WORK, 'app.py')}"`) && html.includes('data-file-line="2"'),
  'a BARE path with :2 is linkified with its line');
check(html.includes('data-file-path="~/not/here.md"'), 'a ~ path is passed through for the server to expand');
check(html.includes('href="https://example.com/x"') && html.includes('target="_blank"'),
  'a real URL still opens in a new tab');
check(!html.match(/class="md-file-link"[^>]*target="_blank"/), 'a local chip never gets target=_blank');

console.log('== §2c a local image renders inline from the byte endpoint ==');
check(html.includes(`src="/api/fs/raw?path=${encodeURIComponent(path.join(WORK, 'shot.png'))}"`),
  'absolute image src → /api/fs/raw');
check(html.includes(`src="/api/fs/raw?path=${encodeURIComponent(path.join(WORK, 'shot2.png'))}"`),
  'RELATIVE image src resolves against the session workspace');
check((html.match(/class="md-img"/g) || []).length === 2, 'both images are marked md-img',
  String((html.match(/class="md-img"/g) || []).length));
check(!/<a[^>]*>\s*<a/.test(html) && (await ev(`(() => { const d = document.createElement('div'); d.innerHTML = window.__QA_MD; return d.querySelectorAll('a a').length })()`)) === 0,
  'no <a> nested inside an <a>');

console.log('== §2b the chip click opens the workspace panel (the shipping handler) ==');
// A mock turn gives us a real agent bubble, i.e. a `.md` node that React wired a click listener
// onto — injecting the fixture INTO that node is how the sweep clicks through the real handler.
await ev(`fetch('/api/sessions/' + ${JSON.stringify(SID)} + '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'render sweep warmup' }) }).then(r => r.status)`);
await until(`Boolean(document.querySelector('.msg.agent .md'))`, 25000);
const injected = await ev(`(() => {
  const md = document.querySelector('.msg.agent .md');
  if (!md) return false;
  md.insertAdjacentHTML('beforeend', '<div id="qa-fixture">' + window.__QA_MD + '</div>');
  return Boolean(document.querySelector('#qa-fixture a.md-file-link'));
})()`);
check(injected, 'fixture injected into a real agent bubble');
if (injected) {
  const clicked = await ev(`(() => { const a = document.querySelector('#qa-fixture a.md-file-link[data-file-path$="shot.png"]') || document.querySelector('#qa-fixture a.md-file-link'); a.click(); return true })()`);
  await sleep(1500);
  check(clicked && await ev(`Boolean(document.querySelector('.tool-panel'))`), 'the panel opened');
  check(await ev(`Boolean(document.querySelector('.tool-panel .file-preview'))`), 'a file preview is showing');
}

// ---- §2d: the panel's renderers, and an edit that really saves ---------------------------
console.log('== §2d the panel renders per file type ==');
const openRow = async (name) => ev(`(() => {
  const row = [...document.querySelectorAll('.tool-panel .file-row')].find(r => (r.getAttribute('title') || '').endsWith(${JSON.stringify(name)}));
  if (!row) return false;
  row.click();
  return true;
})()`);
const rows = await (async () => {
  await until(`document.querySelectorAll('.tool-panel .file-row').length > 0`, 8000);
  return ev(`document.querySelectorAll('.tool-panel .file-row').length`);
})();
check(rows > 0, 'the tree lists the fixture directory', `${rows} entries`);
if (!rows) {
  console.log('  panel text:', await ev(`(document.querySelector('.tool-panel')?.textContent || '').slice(0, 300)`));
  console.log('  panel root:', await ev(`(document.querySelector('.tool-panel .ws-root-name')?.textContent || '')`));
}

check(await openRow('shot.png'), 'clicked shot.png');
await until(`Boolean(document.querySelector('.file-preview .file-image'))`, 8000);
check(await ev(`Boolean(document.querySelector('.file-preview .file-image'))`), 'PNG → <img class="file-image">');
check(await ev(`(document.querySelector('.file-image')?.getAttribute('src') || '').startsWith('/api/fs/raw?path=')`),
  'the image is served by the raw endpoint',
  await ev(`document.querySelector('.file-image')?.getAttribute('src') || ''`));
check(await ev(`(async () => { const r = await fetch(document.querySelector('.file-image').getAttribute('src')); return r.status + ' ' + r.headers.get('content-type') })()`)
  === '200 image/png', 'the raw endpoint answers 200 image/png');
check(await ev(`(async () => { const r = await fetch('/api/fs/raw?path=' + encodeURIComponent(${JSON.stringify(path.join(WORK, 'shot.png'))}), { credentials: 'omit' }); return r.status })()`) === 401,
  'the raw endpoint is behind the auth gate (401 without a cookie)');

check(await openRow('note.md'), 'clicked note.md');
await until(`Boolean(document.querySelector('.file-preview .file-md'))`, 8000);
check(await ev(`Boolean(document.querySelector('.file-preview .file-md'))`), 'markdown → RENDERED (not raw text)');
check(await ev(`Boolean(document.querySelector('.file-preview .file-md h1'))`), 'and it really parsed (h1 present)');
check(await ev(`Boolean(document.querySelector('.file-preview .file-md img[src^="/api/fs/raw"]'))`),
  'a RELATIVE image inside the .md resolves against the file\'s own directory');
check(await ev(`(() => { const b = [...document.querySelectorAll('.file-view-toggle .tool-tab')].find(x => /source/i.test(x.textContent)); if (!b) return false; b.click(); return true })()`),
  'the source toggle exists and clicks');
await sleep(400);
check(await ev(`document.querySelectorAll('.file-preview .file-source .file-line').length`) === 6,
  'source view shows one row per line',
  String(await ev(`document.querySelectorAll('.file-preview .file-source .file-line').length`)));

check(await openRow('data.csv'), 'clicked data.csv');
await until(`Boolean(document.querySelector('.file-preview .file-source'))`, 8000);
{
  // A file that ends in a newline has a final EMPTY line, and that is what the source view
  // shows (as every editor does) — so the expected count comes from the file, not a constant.
  const expect = fs.readFileSync(path.join(WORK, 'data.csv'), 'utf8').split('\n').length;
  const got = await ev(`document.querySelectorAll('.file-preview .file-source .file-line').length`);
  check(got === expect, 'CSV renders one source row per line (final newline included)', `${got} rows of ${expect}`);
}
check(await openRow('app.py'), 'clicked app.py');
await until(`/def hi/.test(document.querySelector('.file-preview')?.textContent || '')`, 8000);
check(/def hi/.test(await ev(`document.querySelector('.file-preview')?.textContent || ''`)), 'code file shows its source');

console.log('== §2d edit + save really writes the file ==');
check(await openRow('data.csv'), 'reopened data.csv');
await until(`Boolean(document.querySelector('.file-preview textarea.file-edit')) || Boolean([...document.querySelectorAll('.file-preview-head .icon-btn')].find(b => /edit/i.test(b.getAttribute('aria-label') || '')))`, 8000);
const editBtn = await ev(`(() => { const b = [...document.querySelectorAll('.file-preview-head .icon-btn')].find(x => (x.getAttribute('aria-label') || '') === 'edit'); if (!b) return false; b.click(); return true })()`);
check(editBtn, 'the file marked editable offers an edit button');
await sleep(400);
check(await ev(`Boolean(document.querySelector('.file-preview textarea.file-edit'))`), 'edit mode shows a textarea');
const NEW = 'a,b\n9,9\n10,10\n';
await ev(`(() => {
  const ta = document.querySelector('.file-preview textarea.file-edit');
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, ${JSON.stringify(NEW)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta.value.length;
})()`);
await sleep(200);
check(await ev(`Boolean(document.querySelector('.file-dirty'))`), 'unsaved changes are marked');
const saved = await ev(`(() => { const b = [...document.querySelectorAll('.file-preview-head .icon-btn')].find(x => (x.getAttribute('aria-label') || '') === 'save'); if (!b) return false; b.click(); return true })()`);
check(saved, 'the save button is offered');
await until(`!document.querySelector('.file-preview textarea.file-edit') || !document.querySelector('.file-dirty')`, 8000);
await sleep(600);
check(fs.readFileSync(path.join(WORK, 'data.csv'), 'utf8') === NEW, 'the file ON DISK now holds the edit',
  JSON.stringify(fs.readFileSync(path.join(WORK, 'data.csv'), 'utf8')));
check(!(await ev(`Boolean(document.querySelector('.file-dirty'))`)), 'the dirty mark cleared after saving');

await send('Target.closeTarget', { targetId: tab.id }).catch(() => {});
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
