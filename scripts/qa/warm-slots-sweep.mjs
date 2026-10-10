// QA: 热备槽位 (settings.agent.warmSlots / warmTtlHours) — the reaper's SECOND deadline.
//
// The operator's report (2026-10-10): 「我的会话还放在这里，我只是离开浏览器，但是这个 ACP 经常就不可用了，
// 然后要回车唤醒这个会话」 — the pure time rule (settings.agent.idleKillMin) reclaimed the agent of the
// session he had been in a minute ago, because leaving the browser is not the same as being done with a
// session. His ask, twice and in his own words: 「5 个最低保留在那里。就这 5 个的那个寿命是比较长的。就是
// 他即使空闲，也保留在那里」 and 「这五个热备的呢，如果 24 小时还没活跃也可以停了吧」.
//
// So the warm set is a FLOOR (保底), not a cap: the most recently USED N sessions keep their process no
// matter how quiet they go, and only their own, much longer deadline expires them. What this asserts:
//   1. the section ships warmSlots=5 / warmTtlHours=24 and both round-trip without a restart;
//   2. WITH a 3 s idle threshold, the 2 most recent of 3 slots survive and the third is reaped — the
//      floor is real AND narrow (not a blanket exemption from 回收);
//   3. the seat follows USE, not creation: touching an older slot takes the seat and the one it
//      displaces becomes reapable (LRU, same clock as the sweep: max(touchedAt, lastMessage, createdAt));
//   4. warmSlots = 0 turns the floor off (no seat, everything obeys the idle rule);
//   5. warmTtlHours is a SEPARATE deadline: with idleKillMin = 0 (回收关闭) a warm slot is still
//      reclaimed once its own TTL passes — 「24 小时没活跃也可以停」 — and not before it;
//   6. warmTtlHours = 0 = 不过期: with the idle rule also off, nothing is ever reclaimed;
//   7. the guards win over EVERY deadline: a slot waiting on a human is not reclaimed even when its
//      warm TTL has expired (it is waiting for the operator, not idle);
//   8. an ARCHIVED row never takes a seat — 归档 is 「收起来」, its process is meant to go, so the seat
//      passes to the next most recent session instead of being held by a row he put away;
//   9. reclaiming still is NOT archiving: the row lands in 工作空间 cold wearing `reaped`.
//
// Driven over the API on purpose: that is also the proof that all three numbers are read from settings
// on every tick (no restart — a restart would kill exactly the slots this feature exists to keep).
// Fractions are used where the UI offers whole units (0.05 min = 3 s, 0.003 h = 10.8 s) — the API takes
// real numbers inside the ranges, which is what makes hours-scale behaviour testable in seconds.
//
//   cd worktrees/agentus-dev
//   env AGENTUS_PORT=8907 AGENTUS_DATA=/tmp/agentus-qa-warm AGENTUS_USERNAME=scratch \
//       AGENTUS_PASSWORD=scratch-pass-1 AGENTUS_TLS_PORT=0 AGENTUS_IDLE_SWEEP_MS=2000 \
//       NODE_ENV=development node_modules/.bin/tsx packages/server/src/index.ts &
//   PORT=8907 node scripts/qa/warm-slots-sweep.mjs
import { authHeaders } from "../lib/auth.mjs";

const PORT = Number(process.env.PORT || 8907);
const BASE = process.env.AGENTUS_BASE || `http://127.0.0.1:${PORT}`;
const IDLE_MIN = Number(process.env.WARM_IDLE_MIN || 0.05); // 3 s — the idle rule, when it is on
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ""}`); }
};

const api = (p, init = {}) =>
  fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...authHeaders(), ...(init.headers || {}) } });

const settings = async () => (await api("/api/settings").then((r) => r.json()));
const putAgent = async (patch) => {
  const r = await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: patch }) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, agent: d?.agent, error: d?.error };
};
/** One knob, checked for acceptance AND for the echo (the read-live proof). */
const set = async (patch) => {
  const res = await putAgent(patch);
  const echoed = await settings();
  const mismatched = Object.entries(patch).filter(([k, v]) => echoed?.agent?.[k] !== v).map(([k]) => k);
  return { ...res, echoed: echoed?.agent, mismatched };
};

const row = async (id) => {
  const d = await (await api("/api/sessions")).json();
  const find = (l) => (l || []).find((s) => s.id === id);
  return {
    live: find(d.live), cold: find(d.cold), archived: find(d.archived),
    inLive: Boolean(find(d.live)), inCold: Boolean(find(d.cold)), inArchived: Boolean(find(d.archived)),
    archivedCount: (d.archived || []).length,
  };
};
const mk = async (title) => {
  const r = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: process.cwd(), title }) });
  if (!r.ok) { console.error("create failed:", r.status, await r.text()); process.exit(1); }
  return (await r.json()).id;
};
const until = async (pred, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
};
const presence = (sessionId, visible = true) =>
  api("/api/notify/presence", { method: "POST", body: JSON.stringify({ sessionId, visible }) });
/** Close a live slot (DELETE on a live session = stop its process, keep the row). */
const close = (id) => api(`/api/sessions/${id}`, { method: "DELETE" });
/** Purge a row for good (DELETE on a cold/archived row). */
const purge = (id) => api(`/api/sessions/${id}`, { method: "DELETE" });
const purgeAll = async (ids) => { for (const id of ids) { await close(id); await purge(id); } };

// ---- 0. preconditions the sweep owns -------------------------------------------------------------
await presence(null, false); // nobody is watching: every guard that could save a slot must be OFF
const s0 = await settings();
check(s0?.agent?.warmSlots === 5, "the section ships warmSlots = 5 (最近 5 个保底)", String(s0?.agent?.warmSlots));
check(s0?.agent?.warmTtlHours === 24, "…and warmTtlHours = 24 (热备也不是永生)", String(s0?.agent?.warmTtlHours));
check(Array.isArray(s0?.agentWarmRange) && Array.isArray(s0?.agentWarmTtlRange),
  "both ranges ride the settings view (the page clamps with them)",
  JSON.stringify({ warm: s0?.agentWarmRange, ttl: s0?.agentWarmTtlRange }));
const before = (await row("nope")).archivedCount;

// ---- 1. the floor, and its narrowness ------------------------------------------------------------
// 2 seats, 3 slots, idle threshold 3 s: the two most recent live on, the third is reaped.
const set1 = await set({ idleKillMin: IDLE_MIN, warmSlots: 2, warmTtlHours: 24 });
check(set1.ok && set1.mismatched.length === 0,
  `idleKillMin=${IDLE_MIN} + warmSlots=2 + warmTtlHours=24 stored and echoed (no restart)`,
  JSON.stringify({ agent: set1.echoed, error: set1.error }));
const a1 = await mk("sweep · 热备外（必须回收）");
const b1 = await mk("sweep · 热备第 2 位（保底）");
await sleep(1200); // gaps the clocks: the ranking has to be readable
const c1 = await mk("sweep · 热备第 1 位（保底）");
{
  await sleep(12000); // 6 sweep ticks at 2 s, 4× the idle threshold
  const a = await row(a1), b = await row(b1), c = await row(c1);
  check(a.inLive === false && a.cold?.status === "reaped",
    "a slot OUTSIDE the floor with no activity is reclaimed by the idle rule",
    `status=${a.cold?.status ?? a.live?.status}`);
  check(b.inLive && b.live?.status !== "reaped",
    "…while 热备第 2 位 is kept, even though it is just as idle",
    `status=${b.live?.status ?? b.cold?.status}`);
  check(c.inLive && c.live?.status !== "reaped",
    "…and 热备第 1 位 too — so the floor is real, not a free pass for everything",
    `status=${c.live?.status ?? c.cold?.status}`);
}

// ---- 2. the seat follows USE (LRU), not creation --------------------------------------------------
// One seat, two live slots. Touching the OLDER one must move the seat: it survives and the newer,
// previously-warm one becomes the odd one out. Without a moved clock this flips exactly.
const set2 = await set({ warmSlots: 1 });
check(set2.ok && set2.echoed?.warmSlots === 1, "warmSlots lowered to 1 without a restart", String(set2.echoed?.warmSlots));
{
  // b1 is the older of the two survivors; make it the most recently USED one.
  await presence(b1, true);
  await sleep(1500);
  await presence(null, false); // the click counted; he is looking elsewhere again
  await sleep(1000);
  const seenAt = await row(b1);
  check(seenAt.inLive, "the slot the operator just touched is live before the observation window",
    `status=${seenAt.live?.status ?? seenAt.cold?.status}`);
  await sleep(12000); // past the 3 s idle threshold many times over: only the SEAT can save b1
  const b = await row(b1), c = await row(c1);
  check(b.inLive && b.live?.status !== "reaped",
    "the most recently USED slot keeps the seat (using a slot IS activity)",
    `status=${b.live?.status ?? b.cold?.status}`);
  check(!c.inLive && c.cold?.status === "reaped",
    "…and the slot it displaced loses it — the seat MOVED, it is not just \"the 2 newest by creation\"",
    `status=${c.cold?.status ?? c.live?.status}`);
  await purgeAll([b1, c1]);
}

// ---- 3. warmSlots = 0 turns the floor off ---------------------------------------------------------
const set3 = await set({ warmSlots: 0, warmTtlHours: 24 });
check(set3.ok && set3.echoed?.warmSlots === 0, "warmSlots = 0 accepted (热备关闭)", String(set3.echoed?.warmSlots));
{
  const p = await mk("sweep · 关掉热备后（必须回收）");
  const q = await mk("sweep · 关掉热备后（也必须回收）");
  await sleep(12000);
  const rp = await row(p), rq = await row(q);
  check(!rp.inLive && rp.cold?.status === "reaped" && !rq.inLive && rq.cold?.status === "reaped",
    "with 0 seats every idle slot is reclaimed — the floor is off, not silently 5",
    `${rp.cold?.status ?? rp.live?.status} / ${rq.cold?.status ?? rq.live?.status}`);
  await purgeAll([p, q]);
}

// ---- 4. warmTtlHours is a SEPARATE deadline -------------------------------------------------------
// The idle rule OFF (0) and a 10.8 s warm TTL: the only thing that can reclaim these slots is the TTL
// itself. 「如果 24 小时还没活跃也可以停」 — and it must not fire early.
const TTL_H = 0.003; // 10.8 s
const set4 = await set({ idleKillMin: 0, warmSlots: 5, warmTtlHours: TTL_H });
check(set4.ok && set4.mismatched.length === 0,
  `idleKillMin=0 (回收关闭) + warmTtlHours=${TTL_H} (${TTL_H * 3600}s) accepted`, JSON.stringify(set4.echoed));
const t1 = await mk("sweep · 热备没过期（还留着）");
{
  await sleep(4000); // ~2 ticks: it is idle, but its hour-scale deadline has not passed
  const warm = await row(t1);
  check(warm.inLive && warm.live?.status !== "reaped",
    "a warm slot is NOT reclaimed before its own TTL passes, even with 回收关闭",
    `status=${warm.live?.status ?? warm.cold?.status}, ttl=${TTL_H * 3600}s`);
  const expired = await until(async () => !(await row(t1)).inLive, 40000);
  const after = await row(t1);
  check(expired && after.cold?.status === "reaped",
    "…and it IS reclaimed once the warm TTL passes — the second deadline exists and is the only one at work here",
    `ttl=${TTL_H * 3600}s, status=${after.cold?.status ?? after.live?.status}`);
}

// ---- 5. warmTtlHours = 0 = 不过期 ------------------------------------------------------------------
const set5 = await set({ idleKillMin: 0, warmSlots: 2, warmTtlHours: 0 });
check(set5.ok && set5.echoed?.warmTtlHours === 0, "warmTtlHours = 0 accepted (不过期)", String(set5.echoed?.warmTtlHours));
const n1 = await mk("sweep · 不过期（一直留着）");
{
  await sleep(12000);
  const r = await row(n1);
  check(r.inLive && r.live?.status !== "reaped",
    "with 回收关闭 and 不过期 nothing is reclaimed at all",
    `status=${r.live?.status ?? r.cold?.status}`);
  await purgeAll([n1]);
}

// ---- 6. the guards win over every deadline --------------------------------------------------------
// A 3 s warm TTL, but this slot is waiting on a HUMAN: it must survive long past its TTL.
const set6 = await set({ idleKillMin: IDLE_MIN, warmSlots: 1, warmTtlHours: 0.0003 }); // ~1 s
check(set6.ok, "a ~1 s warm TTL is accepted for the guard case", JSON.stringify(set6.echoed));
{
  const asking = await mk("sweep · 等着人批的（热备过期也不回收）");
  await api(`/api/sessions/${asking}/prompt`, { method: "POST", body: JSON.stringify({ text: "[tool]" }) });
  const pending = await until(async () => {
    const d = await (await api("/api/sessions")).json();
    return (d.pending || []).some((p) => p.sessionId === asking);
  }, 20000);
  check(pending, "the mock agent raised a permission request (a human is being waited on)");
  await sleep(12000); // 12× its warm TTL
  const r = await row(asking);
  check(r.inLive && r.live?.status !== "reaped",
    "a slot waiting on the operator is NOT reclaimed even with its warm TTL long expired",
    `status=${r.live?.status ?? r.cold?.status}`);
  await purgeAll([asking, t1]);
}

// ---- 7. an archived row never takes a seat --------------------------------------------------------
// 2 seats, 3 slots, the NEWEST archived: the seat it would have taken has to fall through to the
// older survivor. (Ranking archived rows in would reap that older one instead.)
const set7 = await set({ idleKillMin: IDLE_MIN, warmSlots: 2, warmTtlHours: 24 });
check(set7.ok, "back to 2 seats for the archive case", JSON.stringify(set7.echoed));
{
  const old = await mk("sweep · 归档占位测试（最老）");
  await sleep(1200);
  const mid = await mk("sweep · 归档占位测试（中间）");
  await sleep(1200);
  const arch = await mk("sweep · 归档占位测试（最新，被归档）");
  await sleep(1000);
  const ar = await api(`/api/sessions/${arch}/archive`, { method: "POST" });
  check(ar.ok, "a slot can be archived (收起来)", `HTTP ${ar.status}`);
  await sleep(12000);
  const o = await row(old), m = await row(mid);
  check(o.inLive && o.live?.status !== "reaped",
    "an archived row does NOT hold a seat: the older slot inherits it and is kept",
    `status=${o.live?.status ?? o.cold?.status}`);
  check(m.inLive && m.live?.status !== "reaped",
    "…and the other seat is still held by the middle slot",
    `status=${m.live?.status ?? m.cold?.status}`);
  const a = await row(arch);
  check(a.archivedCount === before + 1 && a.inArchived,
    "…while the archived row is in 已归档 and holds no process",
    `status=${a.archived?.status ?? a.live?.status ?? a.cold?.status}`);
  await purgeAll([old, mid, arch]);
  // Un-archive/purge can leave the list as it was: assert it below, with the defaults restored.
}

// ---- cleanup -------------------------------------------------------------------------------------
const restoreIdle = await set({ idleKillMin: 5 });
const restore = await set({ warmSlots: 5, warmTtlHours: 24 });
check(restoreIdle.ok && restore.ok && restore.mismatched.length === 0,
  "defaults restored (idleKillMin 5 / warmSlots 5 / warmTtlHours 24)", JSON.stringify(restore.echoed));
const all = await (await api("/api/sessions")).json();
const mine = [...(all.live || []), ...(all.cold || []), ...(all.archived || [])].filter((s) => String(s.title).startsWith("sweep · "));
for (const s of mine) { await close(s.id); await purge(s.id); }
check(true, `cleaned up ${mine.length} sweep row(s)`);
const after = await (await api("/api/sessions")).json();
check((after.archived || []).length === before, "the archive list is exactly as we found it", `${before} -> ${(after.archived || []).length}`);

console.log(`\n${fail ? "FAIL" : "PASS"} warm-slots-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
