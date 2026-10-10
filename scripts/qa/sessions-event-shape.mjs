// QA: every `t:"sessions"` frame carries ALL THREE buckets (live / cold / archived).
//
// The bug this pins (2026-10-10): `SessionManager` is constructed with the same `emit` the HTTP routes
// use, and its own `#emitSessions()` — 9 call sites, including the idle reaper — shipped only
// `{sessions, pending}`, while `sessionsEvent()` shipped all three. The client read a missing bucket as
// "empty" (`e.cold ?? []`), so closing ONE slot emptied the operator's whole rail (measured 16 rows → 0
// while the API still reported 25 cold+archived). Both halves are fixed; this is the wire-side half,
// and it is a RELEASE MARKER: the served bundle hash says nothing about the server code.
//
// Trigger: DELETE a live session. That route closes it THROUGH the manager, so the frame it emits is
// the manager's own shape — the one that was wrong.
//
// Usage: AGENTUS_BASE=http://127.0.0.1:8788 AGENTUS_DATA=<live data dir> node scripts/qa/sessions-event-shape.mjs
//        exit 0 = every frame after a manager-emitted change carried all three buckets.
import { authHeaders } from "../lib/auth.mjs";

const BASE = process.env.AGENTUS_BASE ?? "http://127.0.0.1:8788";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, init = {}) =>
  fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...authHeaders(), ...(init.headers || {}) } });

const check = (ok, what, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? `  — ${detail}` : ""}`);
  return ok;
};
let pass = 0, fail = 0;
const assert = (ok, what, detail = "") => { ok ? pass++ : fail++; return check(ok, what, detail); };

// a throwaway mock slot: making a REAL event happen is what gives the check teeth
const mk = await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: process.env.TMPDIR || "/tmp", title: "event-shape probe（自动删除）" }) });
if (!mk.ok) { console.error("create failed:", mk.status, (await mk.text()).slice(0, 200)); process.exit(2); }
const probe = (await mk.json()).id;

const frames = [];
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws?token=${encodeURIComponent((authHeaders().authorization ?? "").replace(/^Bearer /, ""))}`);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws handshake failed")); setTimeout(() => rej(new Error("ws timeout")), 15000); });
ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.t === "sessions") frames.push(m); } catch { /* not ours */ } };
await sleep(800);
const before = frames.length;

const closed = await api(`/api/sessions/${probe}`, { method: "DELETE" });
assert(closed.ok, "closed the probe slot (the DELETE route goes through the manager's own emit)", `HTTP ${closed.status}`);
const deadline = Date.now() + 8000;
while (frames.length === before && Date.now() < deadline) await sleep(200);

assert(frames.length > before, "the manager emitted a sessions frame", `${before} → ${frames.length} frames`);
const f = frames[frames.length - 1] ?? {};
assert(Object.prototype.hasOwnProperty.call(f, "cold"), "…and it CARRIES the `cold` bucket (the 2026-10-10 fix)", `keys=${Object.keys(f).join(",")}`);
assert(Object.prototype.hasOwnProperty.call(f, "archived"), "…and the `archived` bucket");
assert(Array.isArray(f.cold) && Array.isArray(f.archived), "…both as arrays (a client can tell `[]` from `absent`)",
  JSON.stringify({ cold: Array.isArray(f.cold) ? f.cold.length : typeof f.cold, archived: Array.isArray(f.archived) ? f.archived.length : typeof f.archived }));

// every other frame this connection saw must agree — one straggler producer is the whole bug
const bad = frames.filter((m) => !Array.isArray(m.cold) || !Array.isArray(m.archived));
assert(bad.length === 0, "every sessions frame on this connection had all three buckets", `${bad.length}/${frames.length} without them`);
assert(Object.prototype.hasOwnProperty.call(f, "sessions") && Object.prototype.hasOwnProperty.call(f, "pending"),
  "…and still carries the two it always had (sessions / pending)");

ws.close();
await api(`/api/sessions/${probe}`, { method: "DELETE" });   // purge the probe (now cold)
console.log(`\n${fail ? "FAIL" : "PASS"} sessions-event-shape: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
