// QA: 槽位空闲回收 — the reaper stops an IDLE slot's agent process to reclaim memory (AionUi parity:
// 设置 → 系统 → 「Agent 空闲超时（分钟）」, default 5, 1–60; Agentus adds 0 = 关闭).
//
// This is the half the operator asked about (2026-10-10: 「活跃进程这个是不是要做超过几分钟没动作就自动
// kill进程啊」) and it must be provably narrow. What this asserts:
//   1. 0 = off: with the setting at 0 nothing is ever reclaimed (a long-running slot is safe);
//   2. a fresh threshold is read LIVE from settings — no restart, no cached number;
//   3. a session the operator is WATCHING is never reaped (a reply arriving while he reads it must not
//      be killed under him) — and it IS reaped the moment he stops watching;
//   4. a session with a PENDING permission is never reaped (it is waiting on a human: the AionUi
//      changelog's "protect active ACP tasks from idle cleanup", learned the hard way there);
//   5. reaping is NOT archiving: the row lands in `cold` (工作空间), never in 已归档, keeps its
//      transcript, and wears status `reaped`;
//   6. one resume brings it back with a real process;
//   7. USING a slot moves the clock even with nothing written in it: the click that wakes a cold slot
//      (a fresh process) and the page reporting it as the one on screen both count as activity, while
//      an untouched slot of the same age IS reclaimed — the positive control that keeps 7. honest
//      (operator report 2026-10-10: 「刚点进去的会话…换个会话过一分钟 acp 就被回收掉了」).
//
// It drives the setting over the API instead of an env override, which is also the proof that the
// threshold is read from settings on every tick. Run it against an instance whose sweep tick is short
// (AGENTUS_IDLE_SWEEP_MS=2000) so the test takes seconds:
//
//   cd worktrees/agentus-arch
//   env AGENTUS_PORT=8905 AGENTUS_DATA=/tmp/agentus-qa-reap AGENTUS_USERNAME=scratch \
//       AGENTUS_PASSWORD=scratch-pass-1 AGENTUS_TLS_PORT=0 AGENTUS_IDLE_SWEEP_MS=2000 \
//       NODE_ENV=development node_modules/.bin/tsx packages/server/src/index.ts &
//   PORT=8905 AGENTUS_DATA=/tmp/agentus-qa-reap node scripts/qa/idle-reap-sweep.mjs
//
// NOTE: the fractional threshold (0.05 min = 3s) is deliberate and used only here — the settings page
// offers whole minutes; the API accepts a real number in 0…60, which is what makes the reclaim path
// testable without waiting five minutes.
//
// NOTE 2: this sweep pins settings.agent.warmSlots = 0 and restores it afterwards. Since 2026-10-10
// the reaper has TWO deadlines and the shipped floor (warmSlots = 5, the most recent sessions kept
// regardless of quiet time) shelters exactly the slots every assertion below is about — with the floor
// on, 「没有被回收」 here means the feature works, not that the rule broke. The floor is asserted in
// scripts/qa/warm-slots-sweep.mjs.
import { authHeaders } from "../lib/auth.mjs";

const PORT = Number(process.env.PORT || 8905);
const BASE = process.env.AGENTUS_BASE || `http://127.0.0.1:${PORT}`;
const THRESHOLD_MIN = Number(process.env.REAP_MIN || 0.05); // 3 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (ok, what, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ""}`); }
};

const api = (p, init = {}) =>
  fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...authHeaders(), ...(init.headers || {}) } });

const row = async (id) => {
  const d = await (await api("/api/sessions")).json();
  const find = (l) => (l || []).find((s) => s.id === id);
  return {
    raw: d,
    live: find(d.live), cold: find(d.cold), archived: find(d.archived),
    inLive: Boolean(find(d.live)), inCold: Boolean(find(d.cold)), inArchived: Boolean(find(d.archived)),
    archivedCount: (d.archived || []).length,
  };
};
const setThreshold = async (min, warmSlots = 0) => {
  // 热备 (settings.agent.warmSlots) is pinned OFF here on purpose: the subject of this sweep is the
  // IDLE rule, and with the shipped floor on (5) the most recent sessions are sheltered from exactly
  // the rule being asserted — the sweep would read 「回收坏了」 when the feature is working. The floor
  // has its own sweep (scripts/qa/warm-slots-sweep.mjs); every assertion below is about a slot that a
  // floor would cover, so 0 seats is the honest precondition.
  const r = await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { idleKillMin: min, warmSlots } }) });
  const d = await r.json();
  return { ok: r.ok, value: d?.agent?.idleKillMin, warm: d?.agent?.warmSlots, error: d?.error };
};
const mk = async (title) => {
  const r = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: process.cwd(), title }) });
  if (!r.ok) { console.error("create failed:", r.status, await r.text()); process.exit(1); }
  return (await r.json()).id;
};
/** Wait until `pred` holds, or give up after `ms`. */
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

// ---- 0. preconditions the sweep owns -------------------------------------------------------------
const setting0 = await setThreshold(5); // documented default, whatever the instance was left at
check(setting0.ok, "the instance answers the agent settings section", JSON.stringify(setting0));
check(setting0.value === 5, "…and the shipped default is 5 minutes (AionUi's own default)", String(setting0.value));
check(setting0.warm === 0, "…with the 热备 floor pinned off for this sweep (its own sweep covers the floor)", String(setting0.warm));
await presence(null, false); // nobody is watching anything: this sweep sets its own preconditions
const before = (await row("nope")).archivedCount;

// ---- 1. 0 = off --------------------------------------------------------------------------------
check((await setThreshold(0)).value === 0, "idleKillMin: 0 is accepted (关闭)");
{
  const id = await mk("sweep · 不回收（0 关闭）");
  // The session is idle from the moment it is created: its lastAt is its creation time. With a 2 s
  // sweep tick, three ticks = ~6 s of being genuinely idle with the threshold at 0.
  await sleep(7000);
  const r = await row(id);
  check(r.inLive, "with the threshold at 0 an idle slot is NOT reclaimed", `status=${r.live?.status}`);
  await api(`/api/sessions/${id}`, { method: "DELETE" });
}

// ---- 2. the threshold is read live from settings ------------------------------------------------
const set2 = await setThreshold(THRESHOLD_MIN);
check(set2.ok && set2.value === THRESHOLD_MIN, `idleKillMin: ${THRESHOLD_MIN} accepted (${THRESHOLD_MIN * 60}s)`, JSON.stringify(set2));
const echoed = (await api("/api/settings").then((r) => r.json()))?.agent?.idleKillMin;
check(Math.abs((echoed ?? NaN) - THRESHOLD_MIN) < 1e-9,
  "…and the value is stored/echoed without a restart", String(echoed));

// ---- 3. the operator is watching it -------------------------------------------------------------
const watched = await mk("sweep · 正在看的（不回收）");
{
  await presence(watched, true);
  await sleep(12000); // 4× the threshold: only the presence guard can be saving it
  const r = await row(watched);
  check(r.inLive && r.live?.status !== "reaped", "a slot the operator is WATCHING is never reclaimed", `status=${r.live?.status}`);
  // …and the moment he looks away it is fair game again.
  await presence(null, false);
  const reaped = await until(async () => !(await row(watched)).inLive, 30000);
  check(reaped, "…and it IS reclaimed once nobody is watching", reaped ? "reaped within 30s" : "still live after 30s");
  const r2 = await row(watched);
  check(r2.inCold && !r2.inArchived, "the reclaimed row lands in 工作空间's cold list, NOT in 已归档", JSON.stringify({ cold: r2.inCold, archived: r2.inArchived }));
  check(r2.cold?.status === "reaped", "…wearing the honest status (reaped ≠ closed ≠ error)", String(r2.cold?.status));
  check(r2.cold?.pid == null, "…and no process", String(r2.cold?.pid));
  check(r2.archivedCount === before, "reclaiming did not archive anything", `archived ${before} -> ${r2.archivedCount}`);
  const msgs = await (await api(`/api/sessions/${watched}/messages?tail=1`)).json();
  check(Array.isArray(msgs.messages), "its transcript is still readable after the reap");
  const res = await api(`/api/sessions/${watched}/resume`, { method: "POST" });
  check(res.ok, "…and one resume brings it back", `HTTP ${res.status}`);
  const back = await row(watched);
  check(back.inLive && Number(back.live?.pid) > 0, "…with a real process again", `pid=${back.live?.pid}`);
  check(back.archivedCount === before, "…and it is still not archived", `archived=${back.archivedCount}`);
}

// ---- 3b. USING a slot moves the clock (a slot is not idle just because nobody WROTE in it) ------
// The operator's report (2026-10-10): 「刚点进去的会话，虽然我没操作啥，也没发消息，但换个会话，过一分钟刚才
// 点进去的会话 acp 就被回收掉了」. The clock used to be the store's last-MESSAGE time alone, so a slot he
// had just opened — fresh process, days-old transcript — was over the threshold the moment it appeared
// and the next tick killed the process he had just asked for. Two ways of USING a slot have to move
// that clock, and both are asserted here against a positive control (§3c) which proves the reaper is
// genuinely running at this threshold: without it, "still live" would be a free pass.
const USE_MIN = 0.25; // 15 s: outlives a 2 s-tick observation, short enough to age a clock in a sweep
const useSet = await setThreshold(USE_MIN);
check(useSet.value === USE_MIN, `idleKillMin: ${USE_MIN} accepted for the use-clock case`, String(useSet.value));
const WARM_MS = 9_000;   // still under the threshold: nothing can be reaped yet, so no race
const WATCH_MS = 11_000; // past it: only a MOVED clock can keep a slot alive here
const opened = await mk("sweep · 刚点开的（不回收）");       // (a) a click that wakes a cold slot
const looked = await mk("sweep · 刚点进去看的（不回收）");   // (b) the page reporting it as the one on screen
const ignored = await mk("sweep · 一直没人搭理的（必须回收）"); // the control: created with them, never used
const away = await mk("sweep · 换过去的那个会话");           // where the operator switches TO
await sleep(WARM_MS);
{
  // (b) he looks at it, then switches to another session — presence follows him away, exactly as the
  // browser reports it (one sessionId at a time).
  await presence(looked, true);
  await presence(away, true);
  // (a) a cold slot woken by a click: it has to be CLOSED first, so the resumed process inherits the
  // old message clock the way the reported case did (a fresh create would carry a fresh stamp and
  // prove nothing).
  await api(`/api/sessions/${opened}`, { method: "DELETE" }); // DELETE on a live slot = close it
  const coldBefore = await row(opened);
  const re = await api(`/api/sessions/${opened}/resume`, { method: "POST" });
  check(coldBefore.inCold && re.ok,
    "the clicked slot was cold and came back (the reported case: a click wakes a cold slot)",
    `cold=${coldBefore.inCold} resume=HTTP ${re.status}`);
  await sleep(WATCH_MS); // crosses the threshold in here — for all four
  const a = await row(opened), b = await row(looked);
  check(a.inLive && a.live?.status !== "reaped",
    "opening a slot is activity: a just-woken slot is NOT reclaimed while its last MESSAGE is older than the threshold",
    `message clock ${Math.round((WARM_MS + WATCH_MS) / 1000)}s old, status=${a.live?.status ?? a.cold?.status}`);
  check(b.inLive && b.live?.status !== "reaped",
    "…and so is looking at it: switching away still leaves the slot a full threshold",
    `status=${b.live?.status ?? b.cold?.status}`);
  // 3c. the control — same age, never opened, never on screen: nothing but the message clock can save
  //     it, and that clock says "reap". If this one survives too, the two above proved nothing.
  const reapedControl = await until(async () => !(await row(ignored)).inLive, 15000);
  const c = await row(ignored);
  check(reapedControl && c.cold?.status === "reaped",
    "the control (never opened, never on screen) IS reclaimed at this threshold — so the two above are not a free pass",
    `status=${c.cold?.status ?? c.live?.status}`);
  await presence(null, false);
  for (const id of [opened, looked, ignored, away]) {
    await api(`/api/sessions/${id}`, { method: "DELETE" }); // live slot: closes it
    await api(`/api/sessions/${id}`, { method: "DELETE" }); // cold slot: purges the record
  }
}

// ---- 4. a request waiting on a human is not "idle" ----------------------------------------------
const asking = await mk("sweep · 等着人批的（不回收）");
{
  // `[tool]` makes the mock raise request_permission and WAIT. Nobody answers: the session is
  // technically quiet, and killing it would throw away the question the operator is being asked.
  await api(`/api/sessions/${asking}/prompt`, { method: "POST", body: JSON.stringify({ text: "[tool]" }) });
  const pending = await until(async () => {
    const d = await (await api("/api/sessions")).json();
    return (d.pending || []).some((p) => p.sessionId === asking);
  }, 20000);
  check(pending, "the mock agent raised a permission request (a human is being waited on)");
  await sleep(12000);
  const r = await row(asking);
  check(r.inLive && r.live?.status !== "reaped", "a slot with a PENDING permission is never reclaimed", `status=${r.live?.status}`);
  // Answer it so the turn ends, then let the normal rule apply.
  const d = await (await api("/api/sessions")).json();
  const p = (d.pending || []).find((x) => x.sessionId === asking);
  // Answer with the request's OWN reject option (never an invented decision).
  const reject = p?.options?.find((o) => /reject|deny/i.test(o.optionId) || /reject|拒绝/i.test(o.name)) ?? p?.options?.[0];
  if (p && reject) {
    await api(`/api/sessions/${asking}/permission`, {
      method: "POST",
      body: JSON.stringify({ requestId: p.requestId, decision: { outcome: "selected", optionId: reject.optionId } }),
    });
  }
  check(await until(async () => !(await row(asking)).inLive, 40000), "once answered and idle again, it is reclaimed like any other slot");
}

// ---- cleanup -----------------------------------------------------------------------------------
const all = await (await api("/api/sessions")).json();
const mine = [...(all.live || []), ...(all.cold || []), ...(all.archived || [])].filter((s) => String(s.title).startsWith("sweep · "));
for (const s of mine) {
  if (!s.cold) await api(`/api/sessions/${s.id}`, { method: "DELETE" });
  await api(`/api/sessions/${s.id}`, { method: "DELETE" });
}
check(mine.length > 0, `cleaned up ${mine.length} sweep row(s)`);
check((await setThreshold(5, 5)).value === 5, "and the threshold is back at the shipped default (5)");
check((await api("/api/settings").then((r) => r.json()))?.agent?.warmSlots === 5,
  "…and the 热备 floor is back at ITS shipped default (5)");
const after = await (await api("/api/sessions")).json();
check((after.archived || []).length === before, "the archive list is exactly as we found it", `${before} -> ${(after.archived || []).length}`);

console.log(`\n${fail ? "FAIL" : "PASS"} idle-reap-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
