// QA: 冷槽位唤醒 — ONE Enter wakes the session AND delivers the message.
//
// The operator's report (2026-10-10): 「回车的话，第一次你去回车的时候，它还没反应，要过一会儿还要再去点一次
// 回车，它才会把消息发送出去」. Two separate defects made that true, and this file is the evidence for both:
//   (a) App.tsx's cold branch woke the slot and then RETURNED — the prompt was never filed anywhere, and
//       nothing ever sent it, so the words he had typed were simply dropped;
//   (b) even had it been filed, the client queue only drained on a turn-END, and a slot that was just
//       woken runs no turn — so the message would have sat there until he pressed 强制发送.
// The fix is one Enter: the prompt is filed the moment it is written (idempotently, so a retry press
// cannot double-send) and the store drains a slot's queue the instant it reports ready.
//
// What this asserts, against a REAL browser (manual QA — it needs the operator's own signed-in Edge,
// so it is not in CI):
//   ① a cold slot is opened cold: the composer says 无 ACP 进程 / 回车唤醒, and the API agrees (cold);
//   ② ONE Enter files the message immediately — a queue row appears holding exactly those words, and
//      the box is cleared (they belong to the queue now, ✕/✎/↑ included);
//   ③ the wake is VISIBLE while it runs (the placeholder says 正在唤醒 agent 进程…), so 「没反应」 is
//      no longer an accurate description of what is happening;
//   ④ the message then goes out BY ITSELF, into the transcript, with no second Enter and no 强制发送;
//   ⑤ a SECOND Enter inside that window (the operator retrying a click that looked dead — same words)
//      still produces exactly ONE message: the queue row was reused, not appended;
//   ⑥ a cold slot with an EMPTY box + Enter still just wakes it (no empty prompt is ever filed).
//
// Usage: start Edge/Chrome with --remote-debugging-port=9222, then
//          PORT=8907 node scripts/qa/cold-send-sweep.mjs
//        Env: CDP_URL (default http://127.0.0.1:9222), PORT (default 8901 = dev).
//
// NOTE: run this against an instance whose mock agent has a BOOT LATENCY — `MOCK_SPAWN_MS=6000` on
// the server's env. ③ and ⑤ measure the wake window, and an instant agent closes it in 80 ms, so the
// assertions can only observe an empty frame. With a slow boot the window is seconds wide and every
// assertion below is about something the operator can actually see.
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

// Enter as the BROWSER sees it: a keyDown carrying the carriage return it produces (see queue-sweep).
const ENTER = [
  { type: "keyDown", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
];
/** Type into the composer and press Enter once, the way the operator does. Returns false when the box
 *  was not there — an unasserted no-op here would make every later assertion measure a stale page. */
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
  await send("Input.dispatchKeyEvent", ENTER[0]);
  await send("Input.dispatchKeyEvent", ENTER[1]);
  await sleep(400);
  return true;
};
const placeholder = () => ev(`document.querySelector('.composer-box textarea')?.placeholder || ''`);
const boxValue = () => ev(`document.querySelector('.composer-box textarea')?.value || ''`);
const queueRows = async () => JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('.queue-row')].map((r) => ({
    id: r.getAttribute('data-queue-id'),
    text: ((r.querySelector('.queue-text') || {}).textContent || '').trim(),
    hint: ((document.querySelector('.queue-hint') || {}).textContent || '').trim(),
  })))`) || "[]");
const transcript = async () => JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('.stream-inner .msg.user .bubble')].map((b) => (b.textContent || '').trim()))`) || "[]");
const userRows = async () => (await transcript()).length;
const apiJson = async (path, init) => ev(`(async () => await fetch(${JSON.stringify(path)}, ${JSON.stringify({
  ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...(init?.headers || {}) },
})}).then((r) => r.json()))()`);
const purge = (sid) => ev(`(async () => { await fetch(${JSON.stringify(`/api/sessions/`)} + ${JSON.stringify(sid)}, {method:'DELETE', credentials:'same-origin'}); return true })()`);

/** Sign in the way docs/dev/02-verify.md prescribes for page-driving sweeps: the operator's Edge
 *  profile holds the cookie for the LIVE port, so an unattended tab on a QA port renders the login
 *  wall and every step after reads as a 401-induced "product failure". Fixture credentials (the
 *  DEV_USER / DEV_PASS defaults) and overridable; the value is never printed. */
const QA_USER = process.env.AGENTUS_QA_USER || "scratch";
const QA_PASS = process.env.AGENTUS_QA_PASS || "scratch-pass-1";
const authed = () => ev(`fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).then((x) => x.authenticated)`);
if (!(await authed())) {
  const code = await ev(`fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(QA_USER)}, password: ${JSON.stringify(QA_PASS)} }) }).then((r) => r.status)`);
  await ev(`location.reload()`);
  await sleep(3000);
  console.log(`  (signed in as ${QA_USER}: HTTP ${code})`);
}

// ---- preflight ------------------------------------------------------------------------------------
check(await until(`Boolean(document.querySelector('.sidebar .session-item'))`, 25000),
  "the cockpit rendered with sessions");
const who = await apiJson("/api/auth/me");
check(who?.authenticated === true,
  "the browser is signed in to this instance (browser sweeps run where the operator already is)",
  String(who?.kind ?? who?.error));

/** Build a session, then close it: DELETE on a live slot stops the process and keeps the row, so the
 *  slot ends up COLD — the state the operator is in when he comes back to a session he left. */
const makeCold = async (title) => {
  const created = await apiJson("/api/sessions", {
    method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title }),
  });
  if (!created?.id) { console.error("create failed:", JSON.stringify(created)); process.exit(1); }
  await purge(created.id); // live → cold
  return created.id;
};
/** Make that cold slot the ACTIVE one without waking it: `?session=` is the app's own open-target, and
 *  it deliberately only switches the view (a rail click would resume). */
const openCold = async (sid) => {
  await ev(`location.href = ${JSON.stringify(`${BASE}/?session=`)} + ${JSON.stringify(sid)}`);
  await sleep(3200);
  return await until(`/无 ACP 进程|回车唤醒/.test(document.querySelector('.composer-box textarea')?.placeholder || '')`, 25000);
};

const RUN = Math.random().toString(36).slice(2, 7);
const TEXT = `冷唤醒一次回车-${RUN}：请只回复两个字`;

// ---- ① a cold slot is opened cold ----------------------------------------------------------------
console.log("== ① 冷槽位（离开浏览器之后的那个状态）==");
const cold = await makeCold(`sweep · 冷唤醒一次回车-${RUN}`);
{
  const listing = await apiJson("/api/sessions");
  check((listing?.cold || []).some((s) => s.id === cold),
    "the session is cold (no agent process) — that is where the reaper leaves a slot he left",
    JSON.stringify((listing?.cold || []).map((s) => s.status)));
  check(await openCold(cold), "opening it does NOT wake it: the composer offers 回车唤醒这个会话");
  check((await queueRows()).length === 0, "and its queue starts empty");
}

// ---- ② ONE Enter files the message ----------------------------------------------------------------
console.log("== ② 一次回车：消息立刻入队 ==");
{
  const before = await userRows();
  check(await typeAndEnter(TEXT), "the message was typed into the real composer and Enter was pressed ONCE");
  const filed = await until(`document.querySelectorAll('.queue-row').length === 1`, 6000);
  const rows = await queueRows();
  check(filed, "…and the message was FILED at once (queue row) instead of being dropped",
    JSON.stringify(rows));
  check(rows[0]?.text === TEXT, "…holding exactly the words that were typed", rows[0]?.text ?? "(none)");
  check((await boxValue()) === "", "…with the box cleared — those words are the queue's now (✕/✎/↑ live there)");
  check(before === (await userRows()), "…and nothing was sent yet (the agent is not up)");
}

// ---- ③ the wake is visible ------------------------------------------------------------------------
console.log("== ③ 唤醒过程可见 ==");
{
  const waking = await until(`/正在唤醒/.test(document.querySelector('.composer-box textarea')?.placeholder || '')`, 8000);
  check(waking, "the composer says 正在唤醒 agent 进程… while the spawn runs",
    String(await placeholder()));
  const hint = (await queueRows())[0]?.hint ?? "";
  check(/waking|唤醒/.test(hint), "…and the queue row says what it is waiting for", hint);
}

// ---- ④ it goes out by itself ----------------------------------------------------------------------
console.log("== ④ 无需第二次回车：消息自己发出去 ==");
{
  const landed = await until(`document.querySelectorAll('.stream-inner .msg.user').length > 0`, 120000);
  check(landed, "the message reached the transcript with NO second Enter");
  // The bubble carries a trailing time label, so match INSIDE the row, never on equality.
  check((await transcript()).some((t) => t.includes(TEXT)),
    "…and it is the message that was typed", (await transcript()).join(" | "));
  check(await until(`document.querySelectorAll('.queue-row').length === 0`, 20000),
    "…and the queue row is gone (it settled into a real message)");
  await purge(cold);
}

// ---- ⑤ a second Enter inside the window is the SAME message ---------------------------------------
console.log("== ⑤ 唤醒中再按一次回车：还是一条消息 ==");
const TEXT2 = `冷唤醒重复回车-${RUN}：请只回复两个字`;
{
  const cold2 = await makeCold(`sweep · 冷唤醒重复回车-${RUN}`);
  check(await openCold(cold2), "a second cold slot is open (the retry case)");
  check(await typeAndEnter(TEXT2), "Enter #1");
  const stillWaking = await until(`/正在唤醒/.test(document.querySelector('.composer-box textarea')?.placeholder || '')`, 8000);
  check(stillWaking, "the slot is still coming up when he presses again (that window is the whole bug)",
    String(await placeholder()));
  check(await typeAndEnter(TEXT2), "Enter #2 — the operator retrying a click that looked dead (same words)");
  const rows = await queueRows();
  check(rows.length === 1, "the words are in line exactly ONCE (the retry reused the row, it did not append)",
    JSON.stringify(rows.map((r) => r.text)));
  check(await until(`document.querySelectorAll('.stream-inner .msg.user').length > 0`, 120000),
    "…and they do go out");
  const mine = (await transcript()).filter((t) => t.includes(TEXT2));
  check(mine.length === 1, "…as ONE message: two Enters did not send the same words twice", `${mine.length} row(s)`);
  await purge(cold2);
}

// ---- ⑥ Enter on an empty box just wakes it --------------------------------------------------------
console.log("== ⑥ 空输入框回车：只唤醒，不发空消息 ==");
{
  const cold3 = await makeCold(`sweep · 冷唤醒空回车-${RUN}`);
  check(await openCold(cold3), "a third cold slot is open");
  const before = await queueRows();
  await send("Input.dispatchKeyEvent", ENTER[0]);
  await send("Input.dispatchKeyEvent", ENTER[1]);
  await sleep(1500);
  check((await queueRows()).length === 0 && before.length === 0,
    "Enter with an empty box filed NOTHING (an empty prompt is never queued)");
  check(await until(`/正在唤醒|无 ACP 进程/.test(document.querySelector('.composer-box textarea')?.placeholder || '')`, 8000),
    "…and the slot is being woken all the same");
  await purge(cold3);
}

console.log(`\n${fail ? "FAIL" : "PASS"} cold-send-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
