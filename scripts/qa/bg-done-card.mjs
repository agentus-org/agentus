// QA (2026-11-09, issue #97): 「后台任务结束了」这件事必须从 Hermes 读出来，不能靠客户端猜。
//
// What was wrong: 0.22.2 filtered `exited` rows out of the server's background frame (to stop a
// 30-minute zombie above the composer) — and with them the real `exitCode`. The transcript had no card
// at all for a single completion on a finished turn, and the subagent kind never reached any ACP client
// because the adapter projected none of `subagent.*`.
//
// What this pins:
//   ① the running row still appears while the process runs (that row is STATE);
//   ② when the finished rows arrive, each one becomes a `.bg-notice[data-source="bg-done"]` card in the
//      transcript — success and failure told apart by Hermes's own exit code, not by reading prose;
//   ③ nothing finished leaks back above the composer;
//   ④ the card is persisted: a reload shows the same two cards (no duplicates, no disappearance);
//   ⑤ a delegation (subagent) end is a card of its own kind (子代理完成), not a process row.
//
// Usage: PORT=8933 node scripts/qa/bg-done-card.mjs
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8933);
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
  body: JSON.stringify({ backend: 'mock', cwd: '/tmp', title: 'bg 结束卡片（自动删除）' }) })
  .then(async (r) => r.status + ' ' + await r.text())`);
const sid = JSON.parse(String(made).slice(4))?.id;
check(Boolean(sid), "created a mock session", String(made).slice(0, 120));
if (!sid) process.exit(1);

await ev(`location.reload(); true`);
await sleep(2200);
const opened = await until(`(() => {
  const row = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(sid)}) + ']');
  if (!row) return false;
  row.click();
  return true;
})()`, 15000);
check(opened, "the session is the one on screen");

const prompt = (text) => ev(`fetch('/api/sessions/${sid}/prompt', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ${JSON.stringify(text)} }) })
  .then((r) => r.status)`);
const cards = () => ev(`JSON.stringify([...document.querySelectorAll('.bg-notice[data-source="bg-done"]')].map((c) => ({
  title: c.querySelector('.bg-notice-title')?.textContent || '',
  cmd: c.querySelector('.bg-notice-cmd')?.textContent || '',
  code: c.querySelector('.bg-notice-code')?.textContent || '',
  ok: c.getAttribute('data-ok'),
  open: c.classList.contains('open'),
})))`);

// ---------------------------------------------------------------- ① running, then ② cards
await prompt("[bg-exited]");
check(await until(`Boolean(document.querySelector('.bg-row'))`, 15000), "① the running process draws the row above the composer");
check(await until(`document.querySelectorAll('.bg-notice[data-source="bg-done"]').length === 2`, 20000),
  "② each finished row becomes a card in the transcript");
const rows = JSON.parse(await cards());
check(rows[0]?.title === "后台任务完成", "② the card is titled 后台任务完成", String(rows[0]?.title));
check(rows[0]?.code === "exit 0" && rows[0]?.ok === "ok", "② exit 0 reads as success", `${rows[0]?.code} / ${rows[0]?.ok}`);
check(rows[1]?.code === "exit 1" && rows[1]?.ok === "fail", "② exit 1 reads as failure — from Hermes's code, not prose",
  `${rows[1]?.code} / ${rows[1]?.ok}`);
check(rows[0]?.open === false && rows[1]?.open === false, "② both cards are collapsed by default");
check(await until(`document.querySelectorAll('.bg-row').length === 0`, 12000),
  "③ nothing finished leaks back above the composer");

// ---------------------------------------------------------------- ④ persisted across a reload
await ev(`location.reload(); true`);
await sleep(2400);
await until(`(() => {
  const row = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(sid)}) + ']');
  if (!row) return false;
  row.click();
  return true;
})()`, 15000);
const afterReload = JSON.parse(await cards());
check(afterReload.length === 2, "④ the cards are history: a reload still shows both", String(afterReload.length));
check(afterReload[1]?.code === "exit 1", "④ …with the same verdict", String(afterReload[1]?.code));

// Expanding shows the command and how long it ran (the facts behind the verdict).
await ev(`(() => { document.querySelectorAll('.bg-notice[data-source="bg-done"]')[1]?.querySelector('.bg-notice-head')?.click(); return true })()`);
const detail = await until(`(() => {
  const c = document.querySelectorAll('.bg-notice[data-source="bg-done"]')[1];
  return Boolean(c?.classList.contains('open') && /npm run backend-smoke/.test(c.innerText || ''));
})()`, 6000);
check(detail, "④ expanding shows the real command");
const foot = await ev(`[...document.querySelectorAll('.bg-notice[data-source="bg-done"]')][1]?.innerText || ''`);
check(/用时/.test(foot), "④ …and how long it ran", foot.replace(/\n/g, " · ").slice(0, 90));

// ---------------------------------------------------------------- ⑤ the subagent kind
await prompt("[bg-delegation]");
check(await until(`[...document.querySelectorAll('.bg-notice[data-source="bg-done"]')]
  .some((c) => (c.querySelector('.bg-notice-title')?.textContent || '') === '子代理完成')`, 20000),
  "⑤ a finished subagent is its own kind of card (子代理完成)");
const sub = await ev(`(() => {
  const c = [...document.querySelectorAll('.bg-notice[data-source="bg-done"]')]
    .find((el) => (el.querySelector('.bg-notice-title')?.textContent || '') === '子代理完成');
  if (!c) return null;
  return { code: c.querySelector('.bg-notice-code')?.textContent || '',
           cmd: c.querySelector('.bg-notice-cmd')?.textContent || '', ok: c.getAttribute('data-ok') };
})()`);
check(/exit 0/.test(sub?.code || "") && sub?.ok === "ok", "⑤ the child's exit code comes through", JSON.stringify(sub));
check(/检索链路/.test(sub?.cmd || ""), "⑤ the row carries the GOAL, not a command line", String(sub?.cmd));

await ev(`fetch('/api/sessions/${sid}', { method: 'DELETE', credentials: 'same-origin' }).then((r) => r.status)`);
ws.close();
console.log(fail ? `\n RED — ${pass} passed, ${fail} failed` : `\n GREEN — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
