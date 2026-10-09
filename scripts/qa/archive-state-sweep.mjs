// QA: 归档 is a STORAGE STATE, not "has no process" — and 工作空间 keeps its cold rows / 已归档 keeps
// only what the operator put there.
//
// The operator's ask (2026-10-10): 「我设想的点击归档是一种存储态啊，不是说不存在活跃进程就算归档了啊」.
// Before this it was exactly that: `archived` was derived from "not in the manager's live map", so a
// crashed slot, a closed one and a deliberately archived one all landed in 已归档 together.
//
// What this asserts, against the mock backend and the real page:
//   1. a CLOSED slot (no process, never archived) sits in 工作空间 as a cold row — NOT in 已归档;
//   2. an ARCHIVED slot sits in 已归档 with a row and the section count matches the API;
//   3. the row menu states the truth per row: 恢复会话 + 归档会话 for the cold one, 取消归档并恢复 + 删除
//      for the archived one;
//   4. 归档会话 from the menu moves the row between sections and sets the flag server-side;
//   5. 取消归档并恢复 brings an archived row back to 工作空间 as a LIVE row (a real resume, real pid);
//   6. purge removes the row from disk.
//
// Usage: PORT=8903 AGENTUS_DATA=/tmp/agentus-qa-arch node scripts/qa/archive-state-sweep.mjs
//        (needs a browser with --remote-debugging-port=9222)
import { authHeaders } from "../lib/auth.mjs";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const PORT = Number(process.env.PORT || 8903);
const BASE = process.env.AGENTUS_BASE || `http://127.0.0.1:${PORT}`;
// The PAGE needs a login (the REST calls above use the machine token); the dev/QA instance's own
// credentials come from dev.sh, so the defaults match it.
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

/** The three buckets, by id. */
const buckets = async () => {
  const d = await (await api("/api/sessions")).json();
  const ids = (list) => (list || []).map((s) => s.id);
  const all = [...(d.live || []), ...(d.cold || []), ...(d.archived || [])];
  return { live: ids(d.live), cold: ids(d.cold), archived: ids(d.archived), byId: new Map(all.map((s) => [s.id, s])) };
};

// ---- server-side setup ---------------------------------------------------------------
// Self-cleaning: a run that dies midway leaves its rows behind, and the next run must not inherit
// them (per the sweep rules: a suite establishes its OWN preconditions).
{
  const d = await (await api("/api/sessions")).json();
  const mine = [...(d.live || []), ...(d.cold || []), ...(d.archived || [])].filter((s) => String(s.title).startsWith("sweep · "));
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

const coldId = await mk("sweep · 关掉的（无进程、未归档）");
// "closed" is what DELETE means on a LIVE slot: the process stops, the record stays. It must land in
// 工作空间's cold rows — the whole point of the round.
const closed = await api(`/api/sessions/${coldId}`, { method: "DELETE" });
check(closed.ok, "closed a live slot (DELETE on a live session)", `HTTP ${closed.status}`);

const archId = await mk("sweep · 归档的");
const archived = await api(`/api/sessions/${archId}/archive`, { method: "POST" });
check(archived.ok, "archived a slot (POST /archive)", `HTTP ${archived.status}`);

const b0 = await buckets();
check(!b0.live.includes(coldId) && b0.cold.includes(coldId), "a closed slot is COLD (工作空间), not archived", `cold=${b0.cold.length}`);
check(!b0.archived.includes(coldId), "…and it is NOT in the 已归档 bucket");
check(b0.archived.includes(archId) && !b0.cold.includes(archId) && !b0.live.includes(archId), "an archived slot is in 已归档 only");
check(b0.byId.get(coldId)?.cold === true && !b0.byId.get(coldId)?.archivedAt, "the cold row says cold=true and carries no archivedAt", JSON.stringify({ cold: b0.byId.get(coldId)?.cold, archivedAt: b0.byId.get(coldId)?.archivedAt ?? null }));
check(b0.byId.get(archId)?.cold === true && typeof b0.byId.get(archId)?.archivedAt === "number", "the archived row carries archivedAt", String(b0.byId.get(archId)?.archivedAt));

// ---- the page -----------------------------------------------------------------------
const tab = await (await fetch(`${CDP}/json/new?${encodeURIComponent(BASE)}`, { method: "PUT" })).json();
await sleep(2600);
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const waiting = new Map();
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
const closeTab = () => { try { send("Target.closeTarget", { targetId: tab.id }); } catch { /* closed */ } };
process.on("exit", closeTab);

send("Page.enable");
send("Runtime.enable");
send("Page.navigate", { url: BASE });
for (let i = 0; i < 80; i++) {
  await sleep(500);
  if (await ev(`document.readyState === 'complete' && location.href.includes(':${PORT}')`)) break;
}
// Sign in from the page itself (the tab is a fresh profile — the REST token above is not a cookie).
await ev(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(U)},password:${JSON.stringify(P)}})}).then((r)=>r.status)`);
await ev(`location.reload()`);
await until(`document.readyState === 'complete'`, 20000);
check(await until(`document.querySelectorAll('.sidebar .session-item').length > 0`, 30000), "the rail rendered rows");
await sleep(800);

/** Row info for one session id, straight off the DOM (which section, which classes, what it says). */
const rowOf = (sid) => ev(`(() => {
  const el = document.querySelector('.session-item[data-session=' + ${JSON.stringify(JSON.stringify(sid))} + ']');
  if (!el) return null;
  const inArch = Boolean(el.closest('#rail-archived'));
  return { inArch, inWs: Boolean(el.closest('#rail-workspaces')), cold: el.classList.contains('cold'), title: el.getAttribute('title') || '' };
})()`);

const coldRow = await rowOf(coldId);
check(Boolean(coldRow && coldRow.inWs && !coldRow.inArch), "the closed slot renders under 工作空间", JSON.stringify(coldRow));
check(Boolean(coldRow?.cold), "…wearing the cold class (no process, and the rail says so)");
check(Boolean(coldRow && !/已归档/.test(coldRow.title)), "…and its tooltip does NOT claim it is archived", coldRow?.title ?? "");

const archRow = await rowOf(archId);
check(Boolean(archRow && archRow.inArch && !archRow.inWs), "the archived slot renders under 已归档", JSON.stringify(archRow));
const count = await ev(`(() => { const c = document.querySelector('.rail-section[data-section="archived"] .rail-section-count'); return c ? Number(c.textContent) : -1; })()`);
check(count === (await buckets()).archived.length, "the section count matches the API's archived bucket", `count=${count} api=${(await buckets()).archived.length}`);

// ---- the menu must state each row's own truth ---------------------------------------
/** Open the row's menu and read its items. */
const menuItems = async (sid) => {
  await ev(`(() => { const el = document.querySelector('.session-item[data-session=' + ${JSON.stringify(JSON.stringify(sid))} + ']');
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 10 })); })()`);
  await until(`Boolean(document.querySelector('.sess-menu'))`, 5000);
  const items = await ev(`[...document.querySelectorAll('.sess-menu .sess-menu-item span')].map((s) => s.textContent)`);
  return items || [];
};
const closeMenu = () => ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), Boolean(document.querySelector('.sess-menu'))`);

const coldMenu = await menuItems(coldId);
await closeMenu();
check(coldMenu.includes("恢复会话") && coldMenu.includes("归档会话"), "a cold row offers 恢复会话 + 归档会话", JSON.stringify(coldMenu));
check(!coldMenu.includes("取消归档并恢复"), "…and nothing about un-archiving (it was never archived)");

const archMenu = await menuItems(archId);
check(archMenu.includes("取消归档并恢复") && archMenu.includes("删除会话（连记录）"), "an archived row offers 取消归档并恢复 + 删除", JSON.stringify(archMenu));
check(!archMenu.includes("归档会话"), "…and not 归档会话 again");

// ---- 归档会话 from the menu (the cold row) ------------------------------------------
const clickItem = (label) => ev(`(() => { const b = [...document.querySelectorAll('.sess-menu .sess-menu-item')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  if (!b) return false; b.click(); return true; })()`);
// The menu confirms first; auto-accept for the sweep and remember the prompt so we can assert it.
await ev(`window.__confirmText = ''; window.confirm = (m) => { window.__confirmText = String(m); return true; };`);
await menuItems(coldId);
check(await clickItem("归档会话"), "clicked 归档会话 on the cold row");
check(await until(`window.__confirmText.includes('归档')`, 5000), "the action asked for confirmation first", await ev(`window.__confirmText.slice(0, 40)`));
const b1 = await buckets();
check(b1.archived.includes(coldId) && !b1.cold.includes(coldId), "the row moved to 已归档 server-side", JSON.stringify({ cold: b1.cold.length, archived: b1.archived.length }));
check(b1.byId.get(coldId)?.archivedAt != null, "the archive flag is set on the row");
check(await until(`(() => { const el = document.querySelector('.session-item[data-session=' + ${JSON.stringify(JSON.stringify(coldId))} + ']'); return Boolean(el && el.closest('#rail-archived')); })()`, 10000),
  "…and the rail drew it under 已归档 without a reload");

// ---- 取消归档并恢复 (the other row) --------------------------------------------------
await menuItems(archId);
check(await clickItem("取消归档并恢复"), "clicked 取消归档并恢复 on the archived row");
const restored = await (async () => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const b = await buckets();
    if (b.live.includes(archId) && b.byId.get(archId)?.pid) return b;
    await sleep(600);
  }
  return await buckets();
})();
check(!restored.archived.includes(archId), "…it left 已归档");
check(restored.live.includes(archId), "…and it is LIVE again (a real resume, not just a flag flip)");
check(Number(restored.byId.get(archId)?.pid) > 0, "…with a real agent process", `pid=${restored.byId.get(archId)?.pid}`);
check(await until(`(() => { const el = document.querySelector('.session-item[data-session=' + ${JSON.stringify(JSON.stringify(archId))} + ']'); return Boolean(el && el.closest('#rail-workspaces')); })()`, 10000),
  "…and the rail moved it back to 工作空间");

// ---- 设置 → 智能体 → 槽位空闲回收 (the card the reaper reads) ----------------------
// The feature is only real if the operator can SET it from the page: assert the card exists, that its
// bounds are the ones we promise, and that a typed value really reaches the server (the read side of
// this setting is covered by idle-reap-sweep, which drives the API).
await ev(`document.querySelector('.rail-gear')?.click()`);
check(await until(`Boolean(document.querySelector('[data-set-scroll]'))`, 15000), "the settings page opens");
await ev(`(() => { const c = [...document.querySelectorAll('.set-nav-cat')].find((x) => (x.textContent || '').includes('智能体')); c?.click(); })()`);
check(await until(`Boolean(document.querySelector('#set-lifecycle'))`, 10000), "设置 → 智能体 holds a 槽位空闲回收 card");
const card = await ev(`(() => {
  const s = document.querySelector('#set-lifecycle');
  if (!s) return null;
  const row = [...s.querySelectorAll('.set-row')].find((r) => (r.querySelector('label')?.textContent || '').includes('Agent 空闲超时'));
  const inp = row?.querySelector('input[type=number]');
  return { title: s.querySelector('h3')?.textContent ?? '', label: row?.querySelector('label')?.textContent ?? '',
    min: inp?.getAttribute('min'), max: inp?.getAttribute('max'), step: inp?.getAttribute('step'), value: inp?.value,
    saysOff: (s.textContent || '').includes('0 = 关闭'),
    saysNotArchive: (s.textContent || '').includes('不是「归档会话」') };
})()`);
check(card?.title === "槽位空闲回收", "the card is titled 槽位空闲回收", JSON.stringify(card));
check(card?.label === "Agent 空闲超时（分钟）", "…and its control wears AionUi's own label", String(card?.label));
check(card?.min === "0" && card?.max === "60" && card?.step === "5", "…with the promised bounds (0–60, step 5)", `${card?.min}–${card?.max}/${card?.step}`);
check(card?.saysOff === true && card?.saysNotArchive === true,
  "…and it says 0 = 关闭 AND that reclaiming is not archiving (the distinction the operator asked for)");
const before2 = card?.value;
// Type into it and blur: a controlled input needs the native setter, and React's onBlur rides focusout,
// so the honest gesture is focus() → set → input event → blur(). Guarded so that a build WITHOUT the card
// reports failures instead of dying with a stack trace (a sweep that crashes reports no count at all).
const typeIdle = (v) => ev(`(() => {
  const inp = document.querySelector('#set-lifecycle .set-row input[type=number]');
  if (!inp) return false;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  inp.focus(); set.call(inp, ${JSON.stringify(String(v))}); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.blur();
  return true; })()`);
const apiIdle = async () => Number((await (await api("/api/settings")).json())?.agent?.idleKillMin);
let saved = null, back = null;
if (await typeIdle("15")) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { saved = await apiIdle(); if (saved === 15) break; await sleep(400); }
  await typeIdle(before2 ?? 5);
  await sleep(1200);
  back = await apiIdle();
}
check(saved === 15, "typing 15 and leaving the field really saves it (the page drives the setting)", `before=${before2} → ${saved}`);
check(saved !== null && back === Number(before2), "…and it is restored to what the sweep found", `${back}`);

// ---- cleanup: purge both ------------------------------------------------------------
const b2 = await buckets();
for (const sid of [coldId, archId]) {
  const inLive = b2.live.includes(sid);
  if (inLive) await api(`/api/sessions/${sid}`, { method: "DELETE" }); // close first (live → closed)
  const del = await api(`/api/sessions/${sid}`, { method: "DELETE" });
  check(del.ok, `purged ${sid.slice(0, 8)}…`, `HTTP ${del.status}`);
}
const b3 = await buckets();
check(!b3.live.includes(coldId) && !b3.live.includes(archId) && !b3.cold.includes(coldId) && !b3.cold.includes(archId)
  && !b3.archived.includes(coldId) && !b3.archived.includes(archId), "both rows are gone from disk");

closeTab();
ws.close();
console.log(`\n${fail ? "FAIL" : "PASS"} archive-state-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
