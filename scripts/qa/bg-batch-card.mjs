// QA (2026-11-08): a FINISHED background process belongs to the transcript, not to the row above the
// composer.
//
// What went wrong: Hermes 0.23 hands the viewer its process registry, which keeps a finished process
// for 30 minutes (`tools/process_registry.FINISHED_TTL_SECONDS`). The cockpit drew that list as-is, so
// 「7 个后台任务已结束」 sat above the input box for half an hour — and the batched completion prompt
// (gateway `_fold_completion`) rendered raw, so the transcript said nothing readable.
//
// What this pins:
//   ① while a process runs: `.bg-row` says 运行中 — the only thing that row is for;
//   ② a snapshot of ALREADY-finished rows draws NO row (that is the 30-minute zombie);
//   ③ the batched wake becomes ONE folded card in the transcript (`.bg-notice[data-batch]`), whose
//      header counts the tasks and whose body lists each one, failures marked;
//   ④ the card is collapsed by default — expanded only when clicked.
//
// Usage: PORT=8932 node scripts/qa/bg-batch-card.mjs
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8932);
const BASE = process.env.AGENTUS_BASE || `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ""}`); }
};

const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
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
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, timeout);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, timeout = 20000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval err");
  return r.result.value;
};
const until = async (expr, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await ev(expr)) return true; await sleep(250); }
  return false;
};

const QA_USER = process.env.AGENTUS_QA_USER || "admin";
const QA_PASS = process.env.AGENTUS_QA_PASS || "123456";
const authed = () => ev(`fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).then((x) => x.authenticated)`);
if (!(await authed())) {
  const code = await ev(`fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(QA_USER)}, password: ${JSON.stringify(QA_PASS)} }) }).then((r) => r.status)`);
  check(code === 200, "QA login", `status ${code}`);
}

const made = await ev(`fetch('/api/sessions', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ backend: 'mock', cwd: '/tmp', title: 'bg 批量卡片（自动删除）' }) })
  .then(async (r) => r.status + ' ' + await r.text())`);
const sid = JSON.parse(String(made).slice(4))?.id;
check(Boolean(sid), "created a mock session", String(made).slice(0, 120));
if (!sid) process.exit(1);

// Reload first: a session created by fetch() while the page is open is not guaranteed to reach the rail
// on its own (the WS list frame is coarse), and the operator's path is 「打开这个会话」, not 「等它自己出现」.
await ev(`location.reload(); true`);
await sleep(2200);
const opened = await until(`(() => {
  const row = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(sid)}) + ']');
  if (!row) return false;
  row.click();
  return true;
})()`, 15000);
check(opened, "① the session is the one on screen");

const prompt = (text) => ev(`fetch('/api/sessions/${sid}/prompt', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ${JSON.stringify(text)} }) })
  .then((r) => r.status)`);

// ---------------------------------------------------------------- ① running row, then no zombie row
await prompt("[bg-exited]");
check(await until(`Boolean(document.querySelector('.bg-row'))`, 15000), "② the running process draws the row");
const runningText = await ev(`document.querySelector('.bg-row .bg-text')?.textContent || ''`);
check(/运行中/.test(runningText), "② the head line says 运行中", runningText);
check(!/已结束/.test(runningText), "② …and never 已结束", runningText);

// The snapshot that reports the finished rows (the 0.23 retention shape) must leave nothing behind.
const goneFast = await until(`document.querySelectorAll('.bg-row').length === 0`, 12000);
check(goneFast, "② a snapshot of finished rows draws NO row (no 30-minute zombie)");
const stillThere = await ev(`document.querySelector('.bg-row .bg-text')?.textContent || ''`);
check(!/已结束/.test(stillThere), "② …and the transcript area never grew a 已结束 count", stillThere || "(none)");

// ---------------------------------------------------------------- ③ the batched wake, folded
// Let the first turn finish before the second prompt: sending into a session that is still settling makes
// the cockpit queue and re-send the text, which folds two identical batches into one card (seen: 6 tasks
// out of two 3-block arrivals). The card under test is ONE batch.
check(await until(`document.body.innerText.includes("后台进程已结束")`, 15000), "① a single completion arrives as one plain row (no card needed)");
check((await ev(`document.querySelectorAll('.bg-notice[data-batch]').length`)) === 0, "① …and it is not mistaken for a batch");
await sleep(1500);
await prompt("[bg-batch]");
const card = await until(`Boolean(document.querySelector('.bg-notice[data-batch]'))`, 30000);
check(card, "③ the batched completion becomes ONE card in the transcript");
const head = await ev(`(() => {
  const c = document.querySelector('.bg-notice[data-batch]');
  if (!c) return null;
  return { title: c.querySelector('.bg-notice-title')?.textContent || '',
           cmd: c.querySelector('.bg-notice-cmd')?.textContent || '',
           code: c.querySelector('.bg-notice-code')?.textContent || '',
           open: c.classList.contains('open'),
           items: c.querySelectorAll('.bg-notice-item').length };
})()`);
check(head?.title === "后台任务完成", "③ the card is titled 后台任务完成", String(head?.title));
check(/3 个任务/.test(head?.cmd || ""), "③ the header counts the folded tasks", String(head?.cmd));
check(/1 个失败/.test(head?.code || ""), "③ failures are counted on the head line", String(head?.code));
check(head?.open === false, "④ collapsed by default");
check(head?.items === 0, "④ …so no per-task row is rendered yet", String(head?.items));

await ev(`(() => { document.querySelector('.bg-notice[data-batch] .bg-notice-head')?.click(); return true })()`);
const expanded = await until(`document.querySelectorAll('.bg-notice[data-batch] .bg-notice-item').length === 3`, 5000);
check(expanded, "④ expanding lists one row per task");
const items = await ev(`JSON.stringify([...document.querySelectorAll('.bg-notice[data-batch] .bg-notice-item')].map((el) => ({
  ok: el.getAttribute('data-ok'),
  text: (el.querySelector('.bg-notice-label')?.textContent || '').trim(),
  out: (el.querySelector('.bg-notice-pre')?.textContent || '').trim(),
})))`);
const rows = JSON.parse(items || "[]");
check(rows.filter((r) => r.ok === "fail").length === 1, "④ the failing task is marked", JSON.stringify(rows.map((r) => r.ok)));
check(rows.some((r) => /npm run backend-smoke/.test(r.text)), "④ the commands are readable", String(rows[1]?.text || ""));
check(rows.some((r) => /6 check\(s\) FAILED/.test(r.out)), "④ the output is one click away", String(rows[1]?.out || ""));
check((await ev(`document.querySelectorAll('.bg-row').length`)) === 0, "③ nothing finished leaks back above the composer");

await ev(`fetch('/api/sessions/${sid}', { method: 'DELETE', credentials: 'same-origin' }).then((r) => r.status)`);
ws.close();
console.log(fail ? `\n RED — ${pass} passed, ${fail} failed` : `\n GREEN — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
