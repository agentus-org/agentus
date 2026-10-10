// QA: 设置 → 槽位回收与热备 — the agent-process knobs are editable from the page, and what they say is
// true. Both live in settings.agent and BOTH are read by the reaper on every tick, so a number that
// looks saved but never reaches the server is the failure this sweep exists to catch.
//
// What this asserts, against a REAL browser:
//   ① the card renders with all three controls and the server's current values in them;
//   ② 热备槽位 writes through on blur (the API echoes it) and the hint follows the number — including
//      the one value whose meaning is a sentence rather than a number (0 = 没有保底名额);
//   ③ 热备最长闲置 writes through too, and 0 reads as 不过期 (the operator's own wording);
//   ④ an out-of-range number is clamped by the SERVER's range (999 → 20), and the input shows the
//      clamped value afterwards — a page that silently keeps an impossible number is worse than one
//      that refuses it;
//   ⑤ the defaults are put back at the end (5 slots / 24 h), so the instance is left as found.
//
// Usage: browser with --remote-debugging-port=9222 signed in to the instance, then
//          PORT=8907 AGENTUS_BASE=http://localhost:8907 node scripts/qa/lifecycle-settings-sweep.mjs
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

/** The card as the operator sees it: label + input value + the hint under it, in DOM order. */
const card = async () => JSON.parse(await ev(`JSON.stringify(
  [...document.querySelectorAll('#set-lifecycle .set-row')].map((r) => ({
    label: (r.querySelector('label') || {}).textContent || '',
    value: (r.querySelector('input.set-num') || {}).value ?? null,
    hint: (r.querySelector('.set-hint') || {}).textContent || '',
  })))`) || "[]");
const settings = () => ev(`fetch('/api/settings', { credentials: 'same-origin' }).then((r) => r.json()).then((d) => d.agent)`);
/** A pollable expression about the SERVER's stored knobs — Runtime.evaluate has no top-level await,
 *  so it has to be wrapped rather than written as a bare `(await fetch(...))`. */
const agentIs = (expr) => `(async () => { const a = (await fetch('/api/settings', { credentials: 'same-origin' }).then((r) => r.json())).agent; return ${expr}; })()`;
/** Type a number into the Nth control of the card and let it "blur" — which is what saves it.
 *  The focusout dispatch is deliberate: React's onBlur is wired to the bubbling focusout event, and a
 *  programmatic `el.blur()` does NOT fire it in a background tab (measured: the hint updated from local
 *  state while the server was never told — the page looked saved and nothing was stored). */
const setField = (index, value) => ev(`(() => {
  const row = document.querySelectorAll('#set-lifecycle .set-row')[${index}];
  const el = row?.querySelector('input.set-num');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  el.focus();
  setter.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  return true;
})()`);

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
const me = await ev(`fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => r.json()).then((x) => x.authenticated)`);
check(me === true, "the browser is signed in to this instance");

// ---- ① the card renders with the server's values --------------------------------------------------
console.log("== ① 设置 → 槽位回收与热备 ==");
{
  check(await ev(`(() => { const b = document.querySelector('button[aria-label="settings"]'); if (!b) return false; b.click(); return true })()`),
    "the 设置 button opens the page");
  check(await until(`Boolean(document.querySelector('#set-lifecycle'))`, 15000), "the 槽位回收与热备 card is there");
  const rows = await card();
  check(rows.length === 3, "it holds three controls: 空闲超时 / 热备槽位 / 热备最长闲置", `${rows.length} row(s)`);
  check(/空闲超时/.test(rows[0]?.label ?? ""), "the first is 空闲超时（分钟）", rows[0]?.label);
  check(/热备槽位/.test(rows[1]?.label ?? ""), "the second is 热备槽位（最近 N 个）", rows[1]?.label);
  check(/热备最长闲置/.test(rows[2]?.label ?? ""), "the third is 热备最长闲置（小时）", rows[2]?.label);
  const a = await settings();
  check(rows[0]?.value === String(a.idleKillMin), "…and each input shows the server's own value",
    JSON.stringify({ idle: rows[0]?.value, warm: rows[1]?.value, ttl: rows[2]?.value, api: a }));
  check(await ev(`[...document.querySelectorAll('#set-lifecycle p.set-hint')].some((p) => /保底，不是上限/.test(p.textContent))`),
    "the card SAYS the floor is 保底 (not 上限) — the distinction the operator insisted on");
}

// ---- ② the floor writes through, hint included ----------------------------------------------------
console.log("== ② 热备槽位：改一下就生效 ==");
{
  check(await setField(1, 3), "typed 3 into 热备槽位 and blurred");
  const echoed = await until(agentIs("a.warmSlots === 3"), 10000);
  check(echoed, "the server took it (no 保存 button involved — a number field saves on blur)");
  const rows = await card();
  check(/最近 3 个会话即使空闲也不回收/.test(rows[1]?.hint ?? ""), "…and the hint now reads 最近 3 个会话即使空闲也不回收", rows[1]?.hint);
  check(await setField(1, 0), "set it to 0");
  await until(agentIs("a.warmSlots === 0"), 10000);
  const off = await card();
  check(/没有保底名额/.test(off[1]?.hint ?? ""), "…and 0 explains itself instead of showing a sentence with a number in it", off[1]?.hint);
}

// ---- ③ the TTL writes through, 0 = 不过期 ----------------------------------------------------------
console.log("== ③ 热备最长闲置：0 = 不过期 ==");
{
  check(await setField(2, 6), "typed 6 into 热备最长闲置");
  check(await until(agentIs("a.warmTtlHours === 6"), 10000), "the server took it");
  const rows = await card();
  check(/闲置超过 6 小时/.test(rows[2]?.hint ?? ""), "…and the hint names the number", rows[2]?.hint);
  check(await setField(2, 0), "set it to 0");
  await until(agentIs("a.warmTtlHours === 0"), 10000);
  check(/不过期/.test((await card())[2]?.hint ?? ""), "…and 0 reads as 不过期", (await card())[2]?.hint);
}

// ---- ④ out of range is clamped by the server ------------------------------------------------------
console.log("== ④ 超范围：服务端夹住 ==");
{
  check(await setField(1, 999), "typed 999 into 热备槽位");
  const clamped = await until(agentIs("a.warmSlots === 20"), 10000);
  check(clamped, "the server clamped it to the range's top (20), not stored an impossible number");
  check(await until(`document.querySelectorAll('#set-lifecycle .set-num')[1].value === '20'`, 8000),
    "…and the input shows the clamped value", await ev(`document.querySelectorAll('#set-lifecycle .set-num')[1].value`));
}

// ---- ⑤ leave it as we found it --------------------------------------------------------------------
console.log("== ⑤ 还原默认 ==");
{
  await setField(1, 5);
  await setField(2, 24);
  const back = await until(`(async () => { const a = (await fetch('/api/settings', { credentials: 'same-origin' }).then((r) => r.json())).agent;
    return a.warmSlots === 5 && a.warmTtlHours === 24 })()`, 10000);
  check(back, "热备槽位 5 / 热备最长闲置 24 restored", JSON.stringify(await settings()));
  const final = await card();
  check(/最近 5 个会话即使空闲也不回收/.test(final[1]?.hint ?? "") && /闲置超过 24 小时/.test(final[2]?.hint ?? ""),
    "…and the hints agree", `${final[1]?.hint} | ${final[2]?.hint}`);
}

console.log(`\n${fail ? "FAIL" : "PASS"} lifecycle-settings-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
