// QA (2026-11-09): #96 — a turn the last restart lost must be a BUTTON, not a 500.
//
// Hermes 0.23 fences a turn interrupted by a restart as `unknown` and refuses every idle-only
// control for that session until someone acknowledges it. The cockpit used to read the refusal
// ("Internal error" + details `unknown_execution`) as transient: three 5 s retries, then a bare
// 500 and nothing clickable in the page.
//
// What this pins, in a real browser against a real server + mock backend:
//   ① recovering a cold session whose turn was lost shows the 「上一轮在重启时丢了」 dialog — not a toast;
//   ② it offers exactly one action, 「丢弃上一轮并继续」, and no delete;
//   ③ pressing it acknowledges the lost turn through the backend's own CLI and the slot comes back
//      ready, with the mode the row asks for.
//
// Usage: PORT=8957 CDP_URL=http://127.0.0.1:9222 node scripts/qa/lost-turn-dialog.mjs
// (needs a server on PORT whose mock backend carries MOCK_LOST_TURN_FILE, and an Edge/Chrome with
// remote debugging — CMD in the header of scripts/qa/bg-batch-card.mjs)
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8957);
const BASE = process.env.AGENTUS_BASE || `http://127.0.0.1:${PORT}`;
const MARKER = process.env.MOCK_LOST_TURN_FILE || "/tmp/agentus-96-markers/lost.marker";
const fs = await import("node:fs");
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
const until = async (expr, ms = 25000) => {
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

// A session on the mock backend that carries MOCK_LOST_TURN_FILE, created while nothing is lost.
fs.mkdirSync(MARKER.replace(/\/[^/]+$/, ""), { recursive: true });
fs.rmSync(MARKER, { force: true });
const made = await ev(`fetch('/api/sessions', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ backend: 'mock', cwd: '/tmp', title: '丢失的一轮（自动删除）' }) })
  .then(async (r) => r.status + ' ' + await r.text())`);
const sid = JSON.parse(String(made).slice(4))?.id;
check(Boolean(sid), "created a mock session", String(made).slice(0, 120));
if (!sid) process.exit(1);
await until(`fetch('/api/sessions', { credentials: 'same-origin' }).then((r) => r.json())
  .then((x) => (x.live || []).some((s) => s.id === ${JSON.stringify(sid)} && s.status === 'ready'))`, 25000);

// Cold, then fence a lost turn the way a restart does.
await ev(`fetch('/api/sessions/${sid}', { method: 'DELETE', credentials: 'same-origin' }).then((r) => r.status)`);
await sleep(1200);
fs.writeFileSync(MARKER, "unknown\n");
await ev(`location.reload(); true`);
await sleep(2400);

// The operator's path: open the cold slot from the rail, press 恢复.
const opened = await until(`(() => {
  const row = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(sid)}) + ']');
  if (row) { row.click(); return true; }
  return false;
})()`, 15000);
check(opened, "the cold slot is in the rail — opening it resumes it");

// ① the refusal is a decision, not a toast: the dialog owns the screen and says what happened.
const dialog = await until(`document.body.innerText.includes('上一轮在重启时丢了')`, 15000);
check(dialog, "① a lost turn opens the 「上一轮在重启时丢了」 dialog");
const body = dialog ? await ev(`document.querySelector('.modal')?.innerText || ''`) : "";
check(/挡住/.test(body) && /不会重放/.test(body),
  "① …and names the consequence (the agent blocks the conversation until someone decides)",
  body.replace(/\s+/g, " ").slice(0, 120));

// ② one action, and it is not 「删除会话」.
const buttons = dialog ? await ev(`[...document.querySelectorAll('.modal button')].map((b) => b.textContent.trim())`) : [];
check(Array.isArray(buttons) && buttons.includes("丢弃上一轮并继续") && !buttons.some((b) => /删除/.test(b)),
  "② the only action offered is 「丢弃上一轮并继续」", JSON.stringify(buttons));

// ③ pressing it discards through the agent's own CLI and the slot comes back ready in dont_ask.
const early = await ev(`document.body.innerText.includes('丢弃上一轮并继续')`);
check(early, "③ the button is still there before pressing");
await ev(`(() => {
  const b = [...document.querySelectorAll('.modal button')].find((x) => /丢弃上一轮并继续/.test(x.textContent || ''));
  if (b) b.click();
  return true;
})()`);
const gone = await until(`!document.body.innerText.includes('上一轮在重启时丢了')`, 20000);
check(gone, "③ the dialog closes once the turn is discarded");
const ready = await until(`fetch('/api/sessions', { credentials: 'same-origin' }).then((r) => r.json())
  .then((x) => {
    const s = [...(x.live || []), ...(x.cold || [])].find((y) => y.id === ${JSON.stringify(sid)});
    return Boolean(s && s.status === 'ready' && s.modes && s.modes.currentModeId === 'dont_ask');
  })`, 30000);
const finalState = await ev(`fetch('/api/sessions', { credentials: 'same-origin' }).then((r) => r.json())
  .then((x) => { const s = [...(x.live || []), ...(x.cold || [])].find((y) => y.id === ${JSON.stringify(sid)}); return s ? s.status + '/' + (s.modes || {}).currentModeId : 'gone'; })`);
check(ready, "③ …and the session is ready in the mode the row asks for", String(finalState));

// cleanup
await ev(`fetch('/api/sessions/${sid}', { method: 'DELETE', credentials: 'same-origin' }).then((r) => r.status)`);
fs.rmSync(MARKER, { force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
