// QA (issue #22) — the REAL fork, not the mock: a live `hermes` slot starts a background command,
// ends its turn, and the completion wakes it by itself.
//
// This is the end-to-end proof for the pair of patches in `acp_adapter/background.py`:
//   fork: drain `process_registry.completion_queue` at the turn boundary + idle tick, and push the
//         running snapshot from `list_sessions()`;
//   server: turn `_meta.hermes.kind = "completion"` into a synthetic prompt (idle) or hold it (busy),
//         and render `kind="background"` as the row above the composer.
// The mock sweep (`background-wake.mjs`) proves the server half against frames it controls; this one
// proves the fork actually emits them, from a real child process, with real polling.
//
// Usage: PORT=8901 node scripts/qa/background-real.mjs
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
const send = (method, params = {}, timeout = 30000) => new Promise((res, rej) => {
  const mid = ++id; const t = setTimeout(() => { waiting.delete(mid); rej(new Error("TIMEOUT " + method)); }, timeout);
  waiting.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const ev = async (expr, timeout = 30000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval err");
  return r.result.value;
};
const until = async (expr, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await ev(expr)) return true; await sleep(400); }
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

await ev(`(() => {
  window.__bg = [];
  window.__ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  window.__ws.onmessage = (e) => { try { window.__bg.push(JSON.parse(e.data)); } catch {} };
  return true;
})()`);
await sleep(1200);

const made = await ev(`fetch('/api/sessions', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ backend: 'hermes', cwd: '/tmp', title: 'bg real（自动删除）' }) })
  .then(async (r) => r.status + ' ' + await r.text())`);
const sid = JSON.parse(String(made).slice(4))?.id;
check(Boolean(sid), "created a live hermes session", String(made).slice(0, 120));
if (!sid) process.exit(1);

// A real agent takes seconds to boot (spawn + initialize + session/new).
const ready = await until(`fetch('/api/sessions', { credentials: 'same-origin' }).then((r) => r.json())
  .then((d) => (d.live || []).some((s) => s.id === ${JSON.stringify(sid)} && s.status === 'ready'))`, 90000);
check(ready, "the hermes slot came up");
if (!ready) { await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {}); process.exit(1); }

await until(`(() => { const r = document.querySelector('.session-item[data-session="${sid}"]'); if (!r) return false; r.click(); return true })()`, 15000);
await sleep(600);

const prompt = [
  "请严格按这几步做，不要多做：",
  "1) 用 terminal 工具执行这条命令，必须带 background=true 和 notify_on_complete=true：",
  "   `sleep 6 && echo BG-REAL-DONE`",
  "2) 拿到返回后立刻结束本轮，只回一句「已放后台」。不要等待它结束，不要 poll，不要读输出。",
].join("\n");
const sent = await ev(`fetch('/api/sessions/${sid}/prompt', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ${JSON.stringify(prompt)} }) }).then((r) => r.status)`);
check(sent === 202, "the prompt was accepted", `status ${sent}`);

// ① the fork emits `background` with the real command, and the row draws.
const sawFrame = await until(`((window.__bg || []).some((f) => f.t === 'background' && f.sessionId === '${sid}' && f.tasks.length > 0))`, 60000);
const frames = JSON.parse(await ev(`JSON.stringify((window.__bg || []).filter((f) => f.t === 'background' && f.sessionId === '${sid}'))`) || "[]");
check(sawFrame, "① the fork sent a non-empty background snapshot", frames.length ? JSON.stringify(frames.at(-1).tasks).slice(0, 140) : "none");
const cmd = frames.flatMap((f) => f.tasks).map((t) => String(t.command || "")).join(" | ");
check(/sleep 6/.test(cmd), "① it carries the command the agent actually ran", cmd.slice(0, 80));

const rowSeen = await until(`Boolean(document.querySelector('.bg-row'))`, 20000);
check(rowSeen, "① the row drew above the composer");

// ② the completion wakes the agent: a turn-start with no operator input.
const woke = await until(`fetch('/api/sessions', { credentials: 'same-origin' }).then((r) => r.json())
  .then(async (d) => {
    const s = (d.live || []).find((x) => x.id === '${sid}');
    return Boolean(s) && s.status === 'running';
  })`, 60000);
check(woke, "② the session started a turn by itself after the process exited");

const fromLabel = await until(`[...document.querySelectorAll('.stream-inner .msg.user .role')].some((r) => (r.textContent || '').includes('后台任务完成'))`, 60000);
check(fromLabel, "② that turn is labelled 「来自「后台任务完成」」");

// ③ the row clears once the wake turn reports nothing left running.
const cleared = await until(`document.querySelectorAll('.bg-row').length === 0`, 90000);
check(cleared, "③ the row cleared after the wake turn");

// The agent must actually have READ the result, not merely woken: its reply mentions the marker or the
// exit. We accept either — the point is that the completion text reached the model.
await until(`fetch('/api/sessions/${sid}/messages', { credentials: 'same-origin' }).then((r) => r.json())
  .then((d) => (d.messages || []).length >= 3)`, 60000);
const texts = await ev(`fetch('/api/sessions/${sid}/messages', { credentials: 'same-origin' }).then((r) => r.json())
  .then((d) => JSON.stringify((d.messages || []).map((m) => JSON.stringify(m.payload))))`);
const mentions = /BG-REAL-DONE|后台进程已结束|exit 0/.test(String(texts));
check(mentions, "③ the transcript carries the completion result", String(texts).slice(0, 120));

await ev(`fetch('/api/sessions/${sid}', { method: 'DELETE', credentials: 'same-origin' }).then((r) => r.status)`);
await fetch(`${CDP}/json/close/${tab.id}`).catch(() => {});
console.log(`\n  ${fail ? "RED" : "GREEN"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
