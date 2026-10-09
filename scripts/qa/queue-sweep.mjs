// Message-queue sweep (manual QA — needs a real browser and a LIVE agent turn, so it is not in CI).
//
// One report from the operator, and this file is its evidence:
//   「大模型正在执行的时候…回车后，加到消息队列中，然后等待回合完成会自动发送出去，消息右边也加个
//     两个按钮，一个箭头（代表立即发送，即停止当前的，立即发送出去），一个叉，表示撤销，再加个笔的
//     编辑图标吧，加到箭头和叉的中间」(Studio's queue is the reference)
//
// What it does: sends a real prompt to a real session, then files a second prompt WHILE the agent is
// working and watches the queue carry it to the transcript by itself. The ✕ and ✎ rows are exercised
// on their own extra rows so the drain assertions stay honest.
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, then
//        PORT=8901 node scripts/qa/queue-sweep.mjs
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const PORT = Number(process.env.PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ''}`); }
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const w = waiting.get(m.id); waiting.delete(m.id);
    m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
  }
};
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
  while (Date.now() < deadline) { if (await ev(expr)) return true; await sleep(300); }
  return false;
};

/** File a prompt through the composer, exactly the way the operator does: type, then Enter.
 *  Returns false when the box was not there — an unasserted no-op here makes every later assertion
 *  measure the PREVIOUS state (measured: a 3 s sleep after navigation is not enough when the browser
 *  is loaded, the composer never appeared and the whole ⑩ suite failed against a stale page). */
const typeAndEnter = async (text) => {
  if (!(await until(`Boolean(document.querySelector('.composer-box textarea'))`, 20000))) return false;
  const typed = await ev(`(() => {
    const ta = document.querySelector('.composer-box textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return ta.value === ${JSON.stringify(text)};
  })()`);
  if (!typed) return false;
  await sleep(300);
  await send('Input.dispatchKeyEvent', ENTER[0]);
  await send('Input.dispatchKeyEvent', ENTER[1]);
  await sleep(400);
  return true;
};

// Enter as the BROWSER sees it: a keyDown carrying the character it produces. Without `text` set to
// the carriage return the key stands for, the event is delivered but the app's handler never sees a
// real Enter press (measured: the prompt stayed in the box and no turn started, which then read as
// "the queue refused it").
const ENTER = [
  { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
];
const userRows = async () => ev(`document.querySelectorAll('.stream-inner .msg.user').length`);

const queueRows = async () => JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('.queue-row')].map((r) => ({
    id: r.getAttribute('data-queue-id'),
    text: (r.querySelector('.queue-text') || {}).textContent || '',
    editing: Boolean(r.querySelector('.queue-edit')),
    buttons: [...r.querySelectorAll('.queue-btn')].map((b) => b.getAttribute('aria-label')),
  })))`));

/** Click a button inside the queue row that holds `text`. */
const clickRowButton = async (text, label) => ev(`(() => {
  const row = [...document.querySelectorAll('.queue-row')].find((r) => ((r.querySelector('.queue-text') || {}).textContent || '').trim() === ${JSON.stringify(text)});
  if (!row) return 'no row';
  const b = [...row.querySelectorAll('.queue-btn')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(label)});
  if (!b) return 'no button';
  b.click();
  return 'clicked';
})()`);

const transcript = async () => ev(`JSON.stringify([...document.querySelectorAll('.stream-inner .msg.user .bubble')]
  .map((b) => (b.textContent || '').trim()))`);

await send('Page.enable');
await sleep(1500);
check(await until(`Boolean(document.querySelector('.sidebar .session-item'))`), 'the cockpit rendered with sessions');

const sid = await ev(`(async () => { const me = await fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.json());
  if (!me.authenticated) return 'UNAUTHED';
  const r = await fetch('/api/sessions',{credentials:'same-origin'}).then(r=>r.json());
  const l = r.live || []; return (l[0] && l[0].id) || ''; })()`);
check(sid && sid !== 'UNAUTHED', 'a live session to drive', String(sid));
await ev(`location.href = ${JSON.stringify(`${BASE}/?session=`)} + ${JSON.stringify(String(sid))}`);
await sleep(3200);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(400);

// A clean queue: this session is a shared QA slot and an earlier run may have left rows behind.
await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('agentus.queue.')) localStorage.removeItem(k); return true })()`);
await ev(`location.reload()`);
await sleep(3000);
await ev(`location.href = ${JSON.stringify(`${BASE}/?session=`)} + ${JSON.stringify(String(sid))}`);
await sleep(3000);
check((await queueRows()).length === 0, 'the queue starts empty');
// The agent may still be finishing a turn from another sweep — start from an idle session so the
// FIRST prompt is the turn whose end the drain waits for.
check(await until(`!document.querySelector('.send-btn.stop')`, 180000), 'the agent is idle before we start');

// ---------------------------------------------------------------- the queue itself
console.log('== ⑩ a prompt written mid-turn waits in the queue instead of bouncing ==');
// `[slow]` is the mock's own trigger for a long turn (900 ms per chunk): the queue test needs the
// first turn to still be RUNNING while the next prompts are typed, which the 60 ms default does not give.
// Every text carries the run id: this QA slot's history holds the previous runs' prompts, and "the
// queued text is not in the transcript yet" is meaningless against a transcript that already has it.
const RUN = Math.random().toString(36).slice(2, 7);
const FIRST = `[slow] 第一条-${RUN}：请只回复两个字`;
const SECOND = `第二条-${RUN}：队列自动发送测试`;
const THIRD = `第三条-${RUN}：这条要被删掉`;
const FOURTH = `第四条-${RUN}：这条要编辑`;
const EDITED = `第四条-${RUN}：已经编辑过`;
const before1 = await userRows();
check(await typeAndEnter(FIRST), 'the first prompt was typed into a real composer');
check(await until(`document.querySelectorAll('.stream-inner .msg.user').length > ${before1}`, 20000),
  'and it went out as a real turn', `${before1} → ${await userRows()} user rows`);
check(await until(`Boolean(document.querySelector('.send-btn.stop'))`, 15000),
  'the send button is a stop button — the turn is running');

const before2 = await userRows();
check(await typeAndEnter(SECOND), 'the second prompt was typed while the agent was working');
await sleep(600);
let rows = await queueRows();
check(rows.length === 1, 'Enter while busy files the prompt in the queue (it was not refused)', JSON.stringify(rows.map((r) => r.text)));
check(rows[0] && rows[0].text.includes('第二条'), 'and the queued row carries exactly what he typed', rows[0] && rows[0].text);
check(rows[0] && rows[0].buttons.length === 3, 'the row has three buttons', JSON.stringify(rows[0] && rows[0].buttons));
check(rows[0] && rows[0].buttons[0] === 'send this one now', 'first is the arrow: send now');
check(rows[0] && rows[0].buttons[1] === 'edit this queued message', 'then the pencil: edit');
check(rows[0] && rows[0].buttons[2] === 'drop this queued message', 'then the cross: drop');
check(await ev(`Boolean(document.querySelector('.queue-list'))`), 'the queue is visible in the composer');
check((await transcript()).includes(SECOND) === false, 'and it is NOT in the transcript yet — it is waiting');

// ---------------------------------------------------------------- ✕ drops
console.log('== ⑩ the ✕ drops a queued row, the ✎ rewrites one in place ==');
check(await typeAndEnter(THIRD), 'a third prompt is typed into the queue');
await sleep(500);
rows = await queueRows();
check(rows.length === 2, 'a second queued row joins the line', `${rows.length} rows`);
check((await clickRowButton(THIRD, 'drop this queued message')) === 'clicked', 'clicking the cross');
await sleep(300);
rows = await queueRows();
check(rows.length === 1 && !rows.some((r) => r.text.includes('第三条')), 'drops it, keeps the other',
  JSON.stringify(rows.map((r) => r.text)));
const stored = await ev(`localStorage.getItem('agentus.queue.${String(sid)}')`);
check(Boolean(stored) && JSON.parse(stored).length === 1, 'and localStorage agrees with the screen (a reload cannot lose it)');

check(await typeAndEnter(FOURTH), 'and a fourth, which we will edit');
await sleep(500);
check((await clickRowButton(FOURTH, 'edit this queued message')) === 'clicked', 'clicking the pencil opens the editor');
await sleep(300);
check(await ev(`Boolean(document.querySelector('.queue-row .queue-edit'))`), 'the row became an editable field');
await ev(`(() => {
  const ta = document.querySelector('.queue-row .queue-edit');
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(EDITED)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  return true;
})()`);
await sleep(200);
await send('Input.dispatchKeyEvent', ENTER[0]);
await send('Input.dispatchKeyEvent', ENTER[1]);
await sleep(400);
rows = await queueRows();
check(rows.length === 2 && rows.some((r) => r.text.trim() === EDITED), 'Enter keeps the edit in place',
  JSON.stringify(rows.map((r) => r.text)));

// ---------------------------------------------------------------- the drain
console.log('== ⑩ the turn ends and the queue goes out by itself, in order ==');
const drained = await until(`(() => {
  const t = [...document.querySelectorAll('.stream-inner .msg.user .bubble')].map((b) => (b.textContent || '')).join('\\n');
  return t.includes(${JSON.stringify(SECOND)}) && t.includes(${JSON.stringify(EDITED)});
})()`, 180000);
check(drained, 'both queued prompts became real messages without another keypress');
check(await until(`document.querySelectorAll('.queue-row').length === 0`, 15000), 'and the queue emptied itself',
  JSON.stringify((await queueRows()).map((r) => r.text)));
const said = JSON.parse(await transcript());
const iSecond = said.findIndex((t) => t.includes('第二条'));
const iEdited = said.findIndex((t) => t.includes('已经编辑过'));
check(iSecond >= 0 && iEdited > iSecond, 'in the order he wrote them', `#${iSecond} then #${iEdited}`);

await send('Page.enable');
console.log(`\n${pass} ok, ${fail} failed`);
await ev(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('agentus.queue.')) localStorage.removeItem(k); return true })()`);
ws.close();
process.exit(fail ? 1 : 0);
