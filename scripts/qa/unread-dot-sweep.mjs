// QA: 「跑完了，还没看」 — the rail's completion dot (AionUi's 未读点 + 手动未读).
//
// The operator's ask (2026-10-10): 「任务完成后，在会话列表右边加个点的标识表示已经完成，多会话时就知道
// 某个会话已经完成了但还没点进去决策；点进会话时点消失。参考 aionui，但还要加一个：会话菜单支持『设为未
// 读』—— 有时候点进去看了但其实是要决策的，当时没决策，右键设成未读，点又出现了」.
//
// What this asserts, against the mock backend and the real page:
//   1. a turn that ends in a session the operator is NOT in dots ITS row (and only its row);
//   2. opening that row is the acknowledgement — the dot goes;
//   3. a turn that ends in the session you ARE looking at never dots (nothing to acknowledge);
//   4. the row menu's 「设为未读」 brings the dot back and it stays back across a reload
//      (the manual half is persisted, the completion half is not);
//   5. the menu says 「设为已读」 while the dot is up, and clearing it takes the dot down.
//
// Usage: PORT=8903 AGENTUS_DATA=/tmp/agentus-qa-unread node scripts/qa/unread-dot-sweep.mjs
//        (needs a browser with --remote-debugging-port=9222)
import { authHeaders } from "../lib/auth.mjs";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8903);
const BASE = process.env.AGENTUS_BASE || `http://127.0.0.1:${PORT}`;
const U = process.env.AGENTUS_USERNAME || "scratch";
const P = process.env.AGENTUS_PASSWORD || "scratch-pass-1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ""}`); }
};

const api = (p, init = {}) =>
  fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...authHeaders(), ...(init.headers || {}) } });

// ---- server-side setup (self-cleaning: the suite establishes its own preconditions) ----
{
  const d = await (await api("/api/sessions")).json();
  const mine = [...(d.live || []), ...(d.cold || []), ...(d.archived || [])].filter((s) => String(s.title).startsWith("unread · "));
  for (const s of mine) {
    if (!s.cold) await api(`/api/sessions/${s.id}`, { method: "DELETE" });
    await api(`/api/sessions/${s.id}`, { method: "DELETE" });
  }
  if (mine.length) console.log(`  (cleaned ${mine.length} leftover row(s) from an earlier run)`);
}

const mk = async (title) => {
  const r = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: process.cwd(), title }) });
  if (!r.ok) { console.error("create failed:", r.status, await r.text()); process.exit(1); }
  return (await r.json()).id;
};

const here = await mk("unread · 我在这里（看这个）");
const away = await mk("unread · 那边跑完了（该有点）");

// ---- the page, opened ON `here` ------------------------------------------------------
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(`${BASE}/?session=${here}`)}`, { method: "PUT" })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const { res, rej } = waiting.get(m.id);
    waiting.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const send = (method, params = {}, timeout = 20000) => new Promise((res, rej) => {
  const id = ++msgId;
  const timer = setTimeout(() => { waiting.delete(id); rej(new Error(`timeout ${method}`)); }, timeout);
  waiting.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr, timeout = 20000) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval err");
  return r.result.value;
};
const until = async (expr, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ev(expr).catch(() => false)) return true; await sleep(250); }
  return false;
};
const closeTab = () => { try { send("Target.closeTarget", { targetId: tab.id }); } catch { /* closed */ } };

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: `${BASE}/?session=${here}` });
await until(`location.href.includes(':${PORT}')`, 20000);
// the page needs a login (the REST calls above use the machine token; the PAGE needs its cookie)
await ev(`(async () => {
  const me = await fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.json());
  if (me.authenticated) return 'already';
  const r = await fetch('/api/auth/login',{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})});
  return r.status;
})()`);
await ev(`location.reload()`);
check(await until(`document.querySelectorAll('.sidebar .session-item').length > 0`, 30000), "the rail rendered rows");

/** Does this row wear the dot? Reads the DOM, not the store — the dot is the thing being tested. */
const dotted = (sid) => ev(`(() => {
  const row = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(sid)}) + ']');
  return Boolean(row && row.querySelector('.unread-dot'));
})()`);
const openMenu = async (sid) => {
  await ev(`(() => {
    const row = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(sid)}) + ']');
    row.querySelector('.row-menu').click();
    return true; })()`);
  return until(`Boolean(document.querySelector('.sess-menu'))`, 8000);
};
const menuLabels = () => ev(`[...document.querySelectorAll('.sess-menu .sess-menu-item span')].map((s) => s.textContent)`);
const clickMenu = async (label) => {
  const hit = await ev(`(() => {
    const b = [...document.querySelectorAll('.sess-menu .sess-menu-item')].find((x) => (x.textContent || '').includes(${JSON.stringify(label)}));
    if (!b) return false; b.click(); return true; })()`);
  await sleep(700);
  return hit;
};

// ---- 1. a turn ending ELSEWHERE dots that row ----------------------------------------
check(!(await dotted(away)), "the far row starts without a dot");
check(!(await dotted(here)), "…and so does the one we are looking at");

const prompted = await api(`/api/sessions/${away}/prompt`, { method: "POST", body: JSON.stringify({ text: "sweep: 跑一轮" }) });
check(prompted.status === 202, "prompted the FAR session straight through the API", `HTTP ${prompted.status}`);
check(await until(`(() => { const r = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(away)}) + ']'); return Boolean(r && r.querySelector('.unread-dot')); })()`, 25000),
  "its row got the dot when the turn finished");
check(!(await dotted(here)), "…and the row we are IN stayed clean (nothing to acknowledge there)");

// ---- 2. opening the row is the acknowledgement ---------------------------------------
await ev(`(() => { const r = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(away)}) + ']'); r.click(); return true; })()`);
check(await until(`Boolean(document.querySelector('.session-item.active[data-session=' + JSON.stringify(${JSON.stringify(away)}) + ']'))`, 15000),
  "clicking the dotted row opened that session");
check(await until(`(() => { const r = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(away)}) + ']'); return Boolean(r && !r.querySelector('.unread-dot')); })()`, 10000),
  "…and the dot went away with it");

// ---- 3. a turn ending in the session you ARE in never dots ---------------------------
const second = await api(`/api/sessions/${away}/prompt`, { method: "POST", body: JSON.stringify({ text: "sweep: 再来一轮" }) });
check(second.status === 202, "ran another turn in the session we are now looking at", `HTTP ${second.status}`);
await sleep(4000);
check(!(await dotted(away)), "no dot for a turn that finished in front of the operator");

// ---- 4. the menu: 设为未读, and it survives a reload ------------------------------------
check(await openMenu(away), "the row menu opens");
const labelsBefore = await menuLabels();
check(labelsBefore.includes("设为未读"), "…and offers 设为未读", JSON.stringify(labelsBefore.slice(0, 4)));
check(await clickMenu("设为未读"), "clicked 设为未读");
check(await until(`(() => { const r = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(away)}) + ']'); return Boolean(r && r.querySelector('.unread-dot')); })()`, 10000),
  "the dot is back — on the row we are sitting in, which is the whole point");
check(await openMenu(away), "the menu opens again on the dotted row");
check((await menuLabels()).includes("设为已读"), "…and now says 设为已读 (a switch, not a new state)");
await ev(`document.body.click()`);
await sleep(400);

await ev(`location.reload()`);
check(await until(`document.querySelectorAll('.sidebar .session-item').length > 0`, 30000), "the page reloaded");
await sleep(1500);
check(await dotted(away), "the manual mark SURVIVED the reload (persisted, unlike the completion dot)");
check(!(await dotted(here)), "…and it did not spread to other rows");

// ---- 5. clearing it takes the dot down ------------------------------------------------
check(await openMenu(away), "open the menu once more");
check(await clickMenu("设为已读"), "clicked 设为已读");
check(await until(`(() => { const r = document.querySelector('.session-item[data-session=' + JSON.stringify(${JSON.stringify(away)}) + ']'); return Boolean(r && !r.querySelector('.unread-dot')); })()`, 10000),
  "the dot is gone again");
const stored = await ev(`localStorage.getItem('agentus.unread')`);
check(stored === null || !String(stored).includes(away), "…and nothing is left behind in storage", String(stored));

// ---- cleanup -------------------------------------------------------------------------
for (const sid of [here, away]) {
  const b = await (await api("/api/sessions")).json();
  if ((b.live || []).some((s) => s.id === sid)) await api(`/api/sessions/${sid}`, { method: "DELETE" });
  const del = await api(`/api/sessions/${sid}`, { method: "DELETE" });
  check(del.ok, `purged ${sid.slice(0, 8)}…`, `HTTP ${del.status}`);
}

closeTab();
ws.close();
console.log(`\n${fail ? "FAIL" : "PASS"} unread-dot-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
