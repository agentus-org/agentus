// QA: a session whose agent still OWNS A RUNNING BACKGROUND PROCESS must not be idle-reaped.
//
// The failure this locks down (operator's question, 2026-10-18: 「有后台进程的话，它还会被空闲回收吗？」):
// the reaper's exemptions were busy / pending approval / starting / watched / 热备 — no answer for
// 「background 还在跑」. So a five-minute build on an otherwise quiet session had its agent SIGTERMed
// out from under it: `#stop` kills the agent (not the process group), so the child kept running
// orphaned, nobody could report its result, and the row was cleared — the silent 「会话看起来结束了、
// 活儿其实还在跑」 hole #22 exists to close, reopening through the back door.
//
// Asserted here:
//   ① a session holding a RUNNING background task is NOT reaped past the idle threshold (the fix);
//   ② the positive control: a plain idle session of the same age IS reaped in the same window — so ①
//      cannot pass by the reaper simply never running;
//   ③ the reprieve is not permanent: once the task ends, the same session IS reclaimed;
//   ④ nothing about it belongs in 已归档 (a reap is a reap, not an archive).
//
// Needs an instance whose sweep tick is short and whose 热备 floor is off (the floor would shelter the
// positive control). Bring one up like the other reclaim sweep:
//
//   env AGENTUS_PORT=8906 AGENTUS_DATA=/tmp/agentus-qa-reapbg AGENTUS_USERNAME=scratch \
//       AGENTUS_PASSWORD=scratch-pass-1 AGENTUS_IDLE_SWEEP_MS=1000 \
//       NODE_ENV=development node_modules/.bin/tsx packages/server/src/index.ts &
//   PORT=8906 AGENTUS_DATA=/tmp/agentus-qa-reapbg node scripts/qa/reap-vs-background.mjs
//
// The mock agent's `[bg:<seconds>]` fixture holds the row RUNNING that long (packages/server/mock/agent.mjs).
import { authHeaders } from "../lib/auth.mjs";

const PORT = Number(process.env.PORT || 8906);
const BASE = process.env.AGENTUS_BASE || `http://127.0.0.1:${PORT}`;
const THRESHOLD_MIN = Number(process.env.REAP_MIN || 0.05); // 3 s
const HOLD_S = Number(process.env.BG_HOLD_S || 10);         // task outlives the threshold by ~3×
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
    live: find(d.live), cold: find(d.cold), archived: find(d.archived),
    inLive: Boolean(find(d.live)), inCold: Boolean(find(d.cold)), inArchived: Boolean(find(d.archived)),
  };
};

const setAgent = async (patch) => {
  const r = await api("/api/settings", { method: "PUT", body: JSON.stringify({ agent: patch }) });
  return { ok: r.ok, body: await r.json() };
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
    await sleep(400);
  }
};

/** A freshly created slot is still spawning; a prompt sent into that window is accepted and then
 *  DROPPED (measured here 2026-10-18: the fixture never ran, so 「no running task」 looked like a
 *  broken exemption). Wait for `ready` before speaking to it. */
const ready = async (id) => until(async () => (await row(id)).live?.status === "ready", 15_000);

/** One socket, read once: does the page-facing snapshot say RUNNING for this session? */
const saysRunning = async (id) => {
  const token = (authHeaders().authorization || "").replace(/^Bearer\s+/i, "");
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
  return await new Promise((res) => {
    const t = setTimeout(() => { try { ws.close(); } catch {} res(false); }, 4000);
    ws.onmessage = (m) => {
      let f; try { f = JSON.parse(m.data); } catch { return; }
      if (f.t !== "sessions") return;
      const hit = (f.background || []).some((b) => b.sessionId === id && b.tasks?.some((x) => x.status === "running"));
      clearTimeout(t); try { ws.close(); } catch {}
      res(Boolean(hit));
    };
    ws.onerror = () => { clearTimeout(t); res(false); };
  });
};

// ---- preconditions -------------------------------------------------------------------------------
const s0 = await setAgent({ idleKillMin: THRESHOLD_MIN, warmSlots: 0 });
check(s0.ok && Math.abs((s0.body?.agent?.idleKillMin ?? NaN) - THRESHOLD_MIN) < 1e-9,
  `idleKillMin pinned to ${THRESHOLD_MIN} (${THRESHOLD_MIN * 60}s)`, JSON.stringify(s0.body?.agent));
check(s0.body?.agent?.warmSlots === 0,
  "…and the 热备 floor is OFF (otherwise the floor, not the fix, would shelter the control)", String(s0.body?.agent?.warmSlots));
await api("/api/notify/presence", { method: "POST", body: JSON.stringify({ sessionId: null, visible: false }) });

// ---- ① a running background task keeps the slot alive -------------------------------------------
const guarded = await mk("sweep · 后台在跑（不该回收）");
const plain = await mk("sweep · 纯空闲（对照）");
await ready(guarded);
await ready(plain);
const r1 = await api(`/api/sessions/${guarded}/prompt`, { method: "POST", body: JSON.stringify({ text: `[bg:${HOLD_S}]` }) });
check(r1.ok, "the mock agent accepted the [bg:<n>] prompt", String(r1.status));
const sawRunning = await until(() => saysRunning(guarded), 12_000);
check(sawRunning, "the page-facing snapshot really says 「running」 (the exemption reads this, not the DB)");

// Two thresholds of genuine quiet: enough for the reaper to fire twice at this age.
await sleep(THRESHOLD_MIN * 60_000 * 2);

const g = await row(guarded);
check(g.inLive && g.live?.pid,
  "① the slot with a RUNNING background task was NOT reaped", `status=${g.live?.status} pid=${g.live?.pid}`);

// ---- ② the control: the same clock DOES reap an idle sibling ------------------------------------
const p = await row(plain);
check(!p.inLive && p.inCold, "② the idle control slot WAS reaped (so ① is not 「the reaper never ran」)",
  `live=${p.inLive} cold=${p.inCold} status=${p.cold?.status}`);
check(p.cold?.status === "reaped", "…and it wears `reaped`, not `closed`", String(p.cold?.status));

// ---- ③ the reprieve ends with the task ----------------------------------------------------------
const finished = await until(async () => {
  const r = await row(guarded);
  return r.inCold || (r.inLive && (r.live?.background ?? []).every((t) => t.status !== "running"));
}, (HOLD_S + 8) * 1000);
const afterTask = await until(async () => (await row(guarded)).inCold, THRESHOLD_MIN * 60_000 * 3);
check(afterTask,
  "③ once the task ended the SAME slot became reclaimable (the exemption is not a permanent reprieve)",
  `finished=${finished} inCold=${(await row(guarded)).inCold}`);

// ---- ④ a reap is not an archive ------------------------------------------------------------------
const g2 = await row(guarded);
check(!g2.inArchived, "④ the reclaimed slot is not in 已归档", `archived=${g2.inArchived}`);

// ---- cleanup: put the settings back --------------------------------------------------------------
await setAgent({ idleKillMin: 5, warmSlots: 5 });
await api(`/api/sessions/${guarded}`, { method: "DELETE" });

console.log(fail ? `\n RED — ${pass} passed, ${fail} failed` : `\n GREEN — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
