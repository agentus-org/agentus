// Model-switch refusal sweep (manual QA — needs a real browser, so it is not in CI).
//
// Why it exists: on the live cockpit a refused model switch reported exactly
// "model switch failed: Invalid params" — the protocol title — while the sentence that says WHY
// sat unused in the ACP error's `data.details` (track §61). The model list the operator picks
// from is also wider than the set the agent will accept (live listing ∪ curated ∪ models.dev vs
// live listing ∪ curated), so "it is in the picker" does not mean "it can be selected": 33 of 503
// entries on the live slot were listed-but-refused.
//
// The mock's `mock:gone` is that fixture (advertised, always refused, refusal shaped like the
// real one, `data.details` and all). This sweep asserts the operator can READ the reason and
// recover: the picker stays open, the offending row is marked, the agent's own sentence is shown,
// and picking a good model right after works and clears the error.
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, then
//        PORT=8901 W=1440 H=900 node scripts/qa/model-switch-sweep.mjs
//
const CDP = 'http://127.0.0.1:9222';
const PORT = Number(process.env.PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, total = 0;
const check = (name, ok, extra = '') => {
  total++; if (ok) pass++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
};

// Our own tab: measuring a page in an unknown state reports failures that are setup problems.
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

const W = Number(process.env.W || 1440), H = Number(process.env.H || 900);
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: W < 700 });
await sleep(400);
console.log(`== model-switch refusal @ ${BASE} ${W}x${H} ==`);

// A dev instance is authenticated: the tab's profile usually has no cookie for :8901, so the app
// is behind its login form and every later step would "fail" as a setup problem (that is exactly
// how this sweep first read: `could not create a session`, with a login form on screen). The
// credentials here are the QA account dev.sh creates for its own throwaway data dir — not secrets.
const loggedIn = await ev(`Boolean(document.querySelector('button[data-testid="tb-model"]') || document.querySelector('.usage-text'))`);
if (!loggedIn) {
  const user = process.env.QA_USER || 'scratch';
  const pass = process.env.QA_PASS || 'scratch-pass-1';
  const res = await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({username:${JSON.stringify(user)},password:${JSON.stringify(pass)}})})
    .then(async r => ({status:r.status, body:(await r.text()).slice(0,120)}))`);
  console.log(`   (login: ${JSON.stringify(res)})`);
  await send('Page.reload', { ignoreCache: false });
  await sleep(3000);
}

// A FRESH mock session (an adopted one may be mid-turn or behind a permission dialog).
let SESSION_ID = '';
for (let i = 0; i < 10 && !SESSION_ID; i++) {
  SESSION_ID = await ev(`fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({backend:'mock',cwd:'/tmp'})}).then(r=>r.json()).then(d=>d.id||'')`);
  if (!SESSION_ID) await sleep(700);
}
if (!SESSION_ID) { console.log('could not create a session'); process.exit(2); }
await ev(`location.href = ${JSON.stringify(BASE + '/?session=')} + ${JSON.stringify(String(SESSION_ID))}`);
await sleep(3200);
for (let i = 0; i < 40; i++) {
  if (await ev(`Boolean(document.querySelector('button[data-testid="tb-model"]'))`)) break;
  await sleep(250);
}

const modelButton = () => ev(`(() => {
  const b = document.querySelector('button[data-testid="tb-model"]');
  return b ? b.textContent.trim() : '';
})()`);
const openPicker = () => ev(`(() => {
  const b = document.querySelector('button[data-testid="tb-model"]');
  if (!b) return 'no button';
  if (!document.querySelector('.tb-list')) b.click();
  return 'clicked';
})()`);

check('the toolbar offers a model picker', Boolean(await modelButton()), await modelButton());

// ---- 1. the advertised-but-refused model must report WHY, in place --------------------
await openPicker();
await sleep(400);
check('the picker opens with the agent\'s list',
  await ev(`Boolean(document.querySelector('.tb-list')) && Boolean(document.querySelector('button[data-model="mock:gone"]'))`));

const before = await modelButton();
await ev(`document.querySelector('button[data-model="mock:gone"]').click()`);
await sleep(1200);

const errText = await ev(`(() => { const e = document.querySelector('.tb-err'); return e ? e.textContent.trim() : ''; })()`);
const rowBad = await ev(`(() => { const b = document.querySelector('button[data-model="mock:gone"]'); return Boolean(b && b.classList.contains('bad')); })()`);
const stillOpen = await ev(`Boolean(document.querySelector('.tb-list'))`);
const banner = await ev(`(() => { const e = document.querySelector('.composer-note.err'); return e ? e.textContent.trim() : ''; })()`);

check('the refusal carries the agent\'s sentence, not the protocol title',
  /not found in this provider's model listing/.test(errText) && /Similar models/.test(errText),
  JSON.stringify(errText.slice(0, 120)));
// The whole failure this sweep guards: the report used to BE the title and nothing else.
check('...and the report does not stop at the title',
  !/^\s*Invalid params\s*$/.test(errText) && !/^Invalid params:/.test(errText) && errText.length > 40,
  `len=${errText.length}`);
check('the offending row is marked', rowBad);
check('the picker stays open so another model can be picked now', stillOpen);
check('the reason also reaches the banner under the composer',
  /model switch failed/.test(banner) && /not found in this provider's model listing/.test(banner),
  JSON.stringify(banner.slice(0, 80)));
check('a refused switch leaves the session on its old model', (await modelButton()) === before, `${before} -> ${await modelButton()}`);

// ---- 2. picking a working model right after succeeds and clears the error -------------
await ev(`document.querySelector('button[data-model="mock:deep"]').click()`);
await sleep(1500);
check('picking a switchable model switches (toolbar shows it)',
  /Mock Deep/.test(await modelButton()), await modelButton());
check('the picker closes on success', (await ev(`Boolean(document.querySelector('.tb-list'))`)) === false);
check('the refusal note is gone', (await ev(`Boolean(document.querySelector('.tb-err'))`)) === false);
check('the banner is cleared too', (await ev(`Boolean(document.querySelector('.composer-note.err'))`)) === false);

// ---- 3. the mark STICKS for this session: one attempt teaches the list ------------------
await openPicker();
await sleep(400);
check('a refused pick stays marked after the note is gone',
  await ev(`(() => { const b = document.querySelector('button[data-model="mock:gone"]');
    return Boolean(b && b.classList.contains('bad') && b.dataset.modelRefused === '1'); })()`));
check('...and its tooltip still carries the reason',
  /this agent refused it/.test(await ev(`document.querySelector('button[data-model="mock:gone"]')?.title || ''`)),
  await ev(`document.querySelector('button[data-model="mock:gone"]')?.title || ''`));
check('the mark is not the note (the in-place box is gone)',
  (await ev(`Boolean(document.querySelector('.tb-err'))`)) === false);
await ev(`document.querySelector('button[data-testid="tb-model"]')?.click()`);
await sleep(300);

// the switch really happened agent-side, not just in the label
const current = await ev(`fetch('/api/sessions').then(r=>r.json()).then(d=>{
  const row = (d.live||[]).concat(d.archived||[]).find(s => s.id === ${JSON.stringify(String(SESSION_ID))});
  return row && row.models ? row.models.currentModelId : '';
})`);
check('the server agrees the session is on mock:deep', current === 'mock:deep', String(current));

await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
