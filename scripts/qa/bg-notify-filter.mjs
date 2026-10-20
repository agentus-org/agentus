// QA (issue #35) — 后台任务行只显示「会唤醒 agent」的进程，静默进程收进设置开关。
//
// 这条链的三段都要一起成立，所以整条都测：
//   fork:   `_rows()` 每行带 `notifyOnComplete`（真进程用 tests/acp_adapter/test_background_relay.py 验）；
//   server: `backgroundTasksOf()` 默认把 `notifyOnComplete !== true` 的行丢掉（unit: bg-notify-flag.mts）；
//   页面:   留下的那一行呼吸、rail 出 ⚡ 角标、绿点保持呼吸、未读蓝点不发 —— 静默进程则什么都不出现。
//
// mock 的两个 fixture 就是这两种形状：
//   `[bg]`      — 跑完会发 completion 唤醒会话（notifyOnComplete: true）
//   `[bgquiet]` — 只发一次 running 快照，永不唤醒（agent 自己轮询的那种）
//
// Usage: PORT=8901 node scripts/qa/bg-notify-filter.mjs
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
  while (Date.now() < deadline) { if (await ev(expr)) return true; await sleep(250); }
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

// The page's own socket: these are the frames the operator's UI acts on, not a second source of truth.
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
  body: JSON.stringify({ backend: 'mock', cwd: '/tmp', title: 'bg 分流（自动创建）' }) })
  .then(async (r) => r.status + ' ' + await r.text())`);
const sid = JSON.parse(String(made).slice(4))?.id;
check(Boolean(sid), "created a mock session", String(made).slice(0, 120));
if (!sid) { console.log("      cannot continue without a session"); process.exit(1); }
const S = JSON.stringify(sid);
// CSS needs a QUOTED attribute value: `.session-item[data-session="…"]`.
const SEL = JSON.stringify(`.session-item[data-session="${sid}"]`);

const opened = await until(`(() => {
  const row = document.querySelector(${SEL});
  if (!row) return false;
  row.click();
  return true;
})()`, 8000);
check(opened, "the session is the one on screen");

const promptApi = (text) => ev(`fetch('/api/sessions/' + ${S} + '/prompt', { method: 'POST', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: ${JSON.stringify(text)} }) }).then((r) => r.status)`);
const ready = await until(`fetch('/api/sessions', { credentials: 'same-origin' }).then((r) => r.json())
  .then((d) => (d.live || []).some((s) => s.id === ${S} && s.status === 'ready'))`, 20000);
check(ready, "the slot is ready before we talk to it");

const setSilent = (on) => ev(`fetch('/api/settings', { method: 'PUT', credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ agent: { showSilentBackground: ${on} } }) }).then((r) => r.status)`);

const rowState = () => ev(`(() => {
  const pane = document.querySelector('.bg-row');
  const badge = document.querySelector(${SEL} + ' .badge.bg');
  const dot = pane ? pane.querySelector('.bg-dot') : null;
  return JSON.stringify({
    row: Boolean(pane),
    text: pane ? (pane.querySelector('.bg-text')?.textContent || '') : '',
    wake: dot ? dot.getAttribute('data-wake') : null,
    badge: Boolean(badge),
    badgeText: badge ? badge.textContent : '',
  });
})()`).then((s) => JSON.parse(String(s)));

// ---- ① default: a silent process draws nothing -------------------------------------------
const off = await setSilent(false);
check(off === 200, "开关关是默认（写入被接受）", `status ${off}`);
await promptApi("[bgquiet] 静默后台进程");
await sleep(3500);
const quietFrames = await frames(`f => f.t === 'background' && f.sessionId === ${S}`);
const quietTasks = quietFrames.flatMap((f) => f.tasks || []);
check(quietTasks.length === 0, "静默行在服务端就被滤掉了（帧里 0 行）", `tasks=${JSON.stringify(quietTasks.map((t) => t.id))}`);
const q = await rowState();
check(q.row === false, "页面上不出现后台任务行", JSON.stringify(q));
check(q.badge === false, "rail 上不长 ⚡ 角标", JSON.stringify(q));

// ---- ② the wake shape: row + breathing + badge -------------------------------------------
await promptApi("[bg] 会唤醒会话的后台进程");
const seen = await until(`(() => {
  const r = document.querySelector('.bg-row');
  return Boolean(r && r.querySelector('.bg-dot[data-wake="1"]'));
})()`, 8000);
check(seen, "唤醒型立刻出现一行，且色点带 data-wake=1（呼吸）");
const w = await rowState();
check(/完成后会唤醒会话/.test(w.text), "行文案说明「完成后会唤醒会话」", w.text);
check(w.badge === true, "rail 上出现 ⚡ 角标", JSON.stringify(w));
check(/完成后会唤醒会话/.test(w.badgeText) || w.badgeText.trim() !== "", "角标写着数量", w.badgeText);
// rail avatar must keep the live halo while the turn is already over (that is the whole point)
const halo = await ev(`(() => {
  const row = document.querySelector(${SEL});
  const av = row ? row.querySelector('.be-avatar') : null;
  return Boolean(av && av.classList.contains('live'));
})()`);
check(halo === true, "回合已结束、进程还在跑时，rail 头像仍是呼吸态（.be-avatar.live）");
const unread = await ev(`Boolean(document.querySelector(${SEL} + ' .unread-dot'))`);
check(unread === false, "此时未读蓝点压住不显（等唤醒 ≠ 跑完等你看）");

// ---- ③ the toggle brings silent rows back ------------------------------------------------
const on = await setSilent(true);
check(on === 200, "打开开关", `status ${on}`);
await sleep(600);
await promptApi("[bgquiet] 开关打开后的静默进程");
const back = await until(`Boolean(document.querySelector('.bg-row'))`, 8000);
check(back, "开关打开后静默行出现");
// The frame can land a beat after the row redraws; poll rather than sampling once.
const gotQuiet = await until(`JSON.stringify((window.__bg || [])
  .filter((f) => f.t === 'background' && f.sessionId === ${S})
  .flatMap((f) => f.tasks || [])
  .filter((t) => /^bgq-/.test(String(t.id)))) !== '[]'`, 8000);
const backTasks = (await frames(`f => f.t === 'background' && f.sessionId === ${S}`)).flatMap((f) => f.tasks || []);
check(gotQuiet, "帧里带上静默任务（开关打开后）", JSON.stringify(backTasks.map((t) => t.id)));

// ---- ④ put the setting back where we found it --------------------------------------------
const offAgain = await setSilent(false);
check(offAgain === 200, "开关恢复为关", `status ${offAgain}`);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
