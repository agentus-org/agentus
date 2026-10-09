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
//   6. one resume brings it back with a real process.
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
const setThreshold = async (min) => {
  const r = await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: { idleKillMin: min } }) });
  const d = await r.json();
  return { ok: r.ok, value: d?.agent?.idleKillMin, error: d?.error };
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
check((await setThreshold(5)).value === 5, "and the threshold is back at the shipped default (5)");
const after = await (await api("/api/sessions")).json();
check((after.archived || []).length === before, "the archive list is exactly as we found it", `${before} -> ${(after.archived || []).length}`);

console.log(`\n${fail ? "FAIL" : "PASS"} idle-reap-sweep: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
