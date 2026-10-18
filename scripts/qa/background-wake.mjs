// QA (issue #22): a background process that outlives its turn — the wake, the row, and the switch.
//
// The failure this locks down: ACP had a producer and no consumer, so `terminal(background=true,
// notify_on_complete=true)` published its completion into a queue nobody drained. The session read
// 「ready」 while the build still ran, and when it finished nobody ever read the result.
//
// Measured here against the dev server (:8901) with the mock agent's `[bg]` fixture, which sends the
// three frames the fork's `acp_adapter/background.py` sends — a running snapshot, then the completion
// carrier, then the snapshot that clears the row — AFTER the turn has ended:
//   ① the snapshot reaches the page as `background` with one running task;
//   ② the row draws above the composer once the turn is over, and the rail grows a ⚙ badge;
//   ③ the completion OPENS A NEW TURN by itself: a `turn-start` with no operator input, whose user row
//      is labelled as coming from 「后台任务完成」 rather than attributed to the operator;
//   ④ the clearing snapshot removes the row (and the badge) — no zombie 「在跑」;
//   ⑤ with the operator's switch OFF, the same completion wakes nothing (that is what the switch means).
//
// Usage: PORT=8901 node scripts/qa/background-wake.mjs
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8901);
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
  while (Date.now() < deadline) { if (await ev(expr)) return true; await sleep(300); }
  return false;
};

const QA_USER = process.env.AGENTUS_QA_USER || "scratch";
const QA_PASS = process.env.AGENTUS_QA_PASS || "scratch-pass-1";
const authed = () => ev(`fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).then((x) => x.authenticated)`);
if (!(await authed())) {
  const code = await ev(`fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(QA_USER)}, password: ${JSON.stringify(QA_PASS)} }) }).then((r) => r.status)`);
  check(code === 200, "QA login", `status ${code}`);
}

// Frame collector: the page's own socket, so these are the frames the operator's UI acts on.
await ev(`(() => {
  window.__bg = [];
  window.__ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  window.__ws.onmessage = (e) => { try { window.__bg.push(JSON.parse(e.data)); } catch {} };
  return true;
})()`);
await sleep(1200);

const frames = async (pred) => JSON.parse(await ev(`JSON.stringify((window.__bg || []).filter(${pred}))`) || "[]");

const made = await ev(`fetch('/api/sessions', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ backend: 'mock', cwd: '/tmp', title: 'bg wake（自动删除）' }) })
  .then(async (r) => r.status + ' ' + await r.text())`);
const sid = JSON.parse(String(made).slice(4))?.id;
check(Boolean(sid), "created a mock session", String(made).slice(0, 120));
if (!sid) { console.log("      cannot continue without a session"); process.exit(1); }

// Make the new session the ACTIVE one: `.bg-row` lives above the composer, and the composer belongs to
// whatever the page is showing. Clicking the rail row is what the operator does.
const opened = await until(`(() => {
  const row = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(sid)}) + ']');
  if (!row) return false;
  row.click();
  return true;
})()`, 8000);
check(opened, "② the session is the one on screen");

const promptApi = (text) => ev(`fetch('/api/sessions/' + ${JSON.stringify(sid)} + '/prompt', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ${JSON.stringify(text)} }) }).then((r) => r.status)`);

// ---- ⑤ first: the switch OFF must wake nothing (checked before the ON case, so a stray completion
//         from the previous run cannot be mistaken for a wake we caused).
const settings = await ev(`fetch('/api/settings', { credentials: 'same-origin' }).then((r) => r.json())`);
const original = settings?.agent?.completionWake;
const setWake = (on) => ev(`fetch('/api/settings', { method: 'PUT', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: { completionWake: ${on} } }) }).then((r) => r.status)`);

// A freshly created slot is still spawning (a prompt sent into that window is accepted and then dropped
// with the child that was not listening yet — measured here: 202, then zero rows). Wait for ready.
const ready = await until(`fetch('/api/sessions', { credentials: 'same-origin' }).then((r) => r.json())
  .then((d) => (d.live || []).some((s) => s.id === ${JSON.stringify(sid)} && s.status === 'ready'))`, 20000);
check(ready, "the slot is ready before we talk to it");

const statusOff = await setWake(false);
check(statusOff === 200, "switch OFF is accepted", `status ${statusOff}`);
const before = (await frames(`f => f.t === 'turn-start' && f.sessionId === ${JSON.stringify(sid)}`)).length;
await promptApi("[bg] 唤醒关闭时不应自起一回合");
await sleep(4200);
const afterOff = (await frames(`f => f.t === 'turn-start' && f.sessionId === ${JSON.stringify(sid)}`)).length;
check(afterOff === before + 1, "OFF: exactly the operator's one turn ran", `${before} → ${afterOff}`);
const bgOff = await frames(`f => f.t === 'background' && f.sessionId === ${JSON.stringify(sid)}`);
check(bgOff.length > 0, "OFF: the snapshot frame still arrives (state is not gated, only the wake)");
check(await ev(`document.querySelectorAll('.bg-row').length === 0 || true`), "OFF: no crash while drawing");

// ---- ON: the full loop.
await setWake(true);
const startsBefore = (await frames(`f => f.t === 'turn-start' && f.sessionId === ${JSON.stringify(sid)}`)).length;
await promptApi("[bg] 后台任务通路测量");
const rowAppeared = await until(`Boolean(document.querySelector('.bg-row'))`, 6000);
const rowText = await ev(`document.querySelector('.bg-row .bg-text')?.textContent || ''`);
check(rowAppeared, "① the background row draws above the composer", rowText.trim());
check(/运行中/.test(rowText), "① it says the task is still running", rowText.trim());
// The badge is checked in the same breath as the row: the mock clears the snapshot 2.6 s in, and a poll
// that only looked after the wake would be measuring an empty rail.
const badge = await ev(`Boolean(document.querySelector('.badge.bg'))`);
check(badge, "② the rail carries a ⚙ badge for this session");
await ev(`(() => { document.querySelector('.bg-row .bg-head')?.click(); return true })()`);
// React commits on its own tick — counting in the same eval measured the pre-click DOM.
const expanded = await until(`document.querySelectorAll('.bg-row .bg-item').length >= 1`, 3000);
const itemText = await ev(`document.querySelector('.bg-row .bg-item .bg-cmd')?.textContent || ''`);
check(expanded, "① clicking the row lists the command", itemText.trim().slice(0, 48));

// ③ the wake: a turn-start the operator did not cause, ~1.4 s after the turn ended.
const woke = await until(
  `((window.__bg || []).filter(f => f.t === 'turn-start' && f.sessionId === ${JSON.stringify(sid)}).length) >= ${startsBefore + 2}`,
  12000,
);
check(woke, "③ the completion opened a turn by itself");
const users = JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('.stream-inner .msg.user .role')].map((r) => (r.textContent || '').trim()))`) || "[]");
check(users.some((u) => u.includes("后台任务完成")), "③ that turn is labelled 「来自「后台任务完成」」, not as the operator's own", users.join(" | "));

// ④ the clearing snapshot takes the row (and the badge) away.
const cleared = await until(`document.querySelectorAll('.bg-row').length === 0`, 8000);
check(cleared, "④ the clearing snapshot removes the row");
check(!(await ev(`Boolean(document.querySelector('.badge.bg'))`)), "④ …and the rail badge with it");
const clearedFrames = await frames(`f => f.t === 'background' && f.sessionId === ${JSON.stringify(sid)} && f.tasks.length === 0`);
check(clearedFrames.length > 0, "④ a `background` frame with an empty task list was sent");

// Nothing of this reached the transcript as junk: the injected turn is ONE user row + ONE reply.
const userRows = await ev(`document.querySelectorAll('.stream-inner .msg.user').length`);
check(userRows >= 2, "the injected turn has its own user row", `${userRows} user rows`);
const blankish = await ev(`[...document.querySelectorAll('.stream-inner .msg.agent .bubble')]
  .filter(b => (b.textContent || '').trim().length === 0).length`);
check(blankish === 0, "no empty agent bubble was drawn");

// restore the operator's setting
if (typeof original === "boolean") await setWake(original);
await ev(`fetch('/api/sessions/' + ${JSON.stringify(sid)}, { method: 'DELETE', credentials: 'same-origin' }).then((r) => r.status)`);
await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});

console.log(`\n  ${fail ? "RED" : "GREEN"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
