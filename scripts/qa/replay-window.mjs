// QA: a restart/resume must NOT rewrite the transcript or the clock.
//
// Measured on live (2026-10-08, promoting one release): every resumed slot re-sent its whole
// transcript over ACP, the server appended it, and ONE restart wrote 1240 rows into the store and
// pushed all eleven sessions' activity clocks to 「刚刚」. The rail's time is the operator's "when was
// this last talked to" — a restart is not a conversation.
//
// The mock produces the REAL shape here (`MOCK_REPLAY=1`): complete blocks, reasoning with no
// messageId, so nothing can be folded by identity — only a replay WINDOW (frames that arrive between
// a spawn/resume and the slot's next prompt are history) can catch it.
//
//   node scripts/qa/replay-window.mjs        (BASE/AGENTUS_DATA overridable, like the other sweeps)
import path from "node:path";
import { rmSync } from "node:fs";
import { authHeaders } from "../lib/auth.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const ROOT = path.resolve(import.meta.dirname, "../..");
const H = { ...authHeaders() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const j = (r) => r.json().catch(() => ({}));

const ROW = {
  id: "qa-replay", label: "QA replay probe", kind: "mock",
  cmd: process.execPath, args: path.join(ROOT, "packages/server/mock/agent.mjs"),
  env: { MOCK_REPLAY: "1", MOCK_REPLAY_BLOCKS: "4" }, home: "", profile: "",
  notes: "smoke: a re-attach must not rewrite the transcript",
};

const put = (body) => fetch(`${BASE}/api/backends/${ROW.id}`, {
  method: "PATCH", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(body),
});

// ---- fixture: a slot with a real turn behind it ------------------------------------------------
const created = await fetch(`${BASE}/api/backends`, {
  method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(ROW),
});
if (created.status === 409) await put(ROW); // leftover from an aborted run

const sid = (await j(await fetch(`${BASE}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ backend: ROW.id, cwd: "/tmp", title: "replay window" }),
}))).id;
console.log(`fixture session ${sid}`);

const rows = async () => {
  const r = await fetch(`${BASE}/api/sessions/${sid}/messages?tail=250`, { headers: H });
  return ((await j(r)).messages ?? []).length;
};
const statusOf = async () => {
  const d = await j(await fetch(`${BASE}/api/sessions`, { headers: H }));
  return [...(d.live ?? []), ...(d.archived ?? [])].find((s) => s.id === sid)?.status ?? "?";
};
const lastAtOf = async () => {
  const d = await j(await fetch(`${BASE}/api/sessions`, { headers: H }));
  return [...(d.live ?? []), ...(d.archived ?? [])].find((s) => s.id === sid)?.lastAt ?? 0;
};

await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ text: "原始回合 original turn" }),
});
for (let i = 0; i < 120 && (await statusOf()) === "running"; i++) await sleep(250);
await sleep(500);

const before = await rows();
const clockBefore = await lastAtOf();
check("the fixture really has a transcript to preserve", before >= 2, `rows=${before}`);

// ---- the re-attach: the agent replays its history ----------------------------------------------
const restarted = await fetch(`${BASE}/api/sessions/${sid}/restart`, { method: "POST", headers: H });
check("the slot restarts (this is the path the operator's release takes)",
  restarted.status === 200, `HTTP ${restarted.status}`);
for (let i = 0; i < 160 && (await statusOf()) === "running"; i++) await sleep(250);
// give the replay time to land — it is exactly what we are measuring
await sleep(2500);

const after = await rows();
const clockAfter = await lastAtOf();

check("the replay did NOT add rows (a re-attach is a record of work already stored)",
  after === before, `rows ${before} -> ${after} (+${after - before})`);
check("…and it did not move the session's clock (the rail must not read 「刚刚」 after a restart)",
  clockAfter === clockBefore || Math.abs(clockAfter - clockBefore) < 1000,
  `lastAt ${new Date(clockBefore).toISOString()} -> ${new Date(clockAfter).toISOString()}`);

// ---- and the slot still works: the window closes on the operator's next word -------------------
await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ text: "再问一次 follow-up" }),
});
for (let i = 0; i < 160 && (await statusOf()) === "running"; i++) await sleep(250);
await sleep(500);
const spoke = await rows();
check("a prompt AFTER the re-attach still streams into the transcript (the window closes)",
  spoke > after, `rows ${after} -> ${spoke}`);

const clockMoved = await lastAtOf();
check("…and that real turn DID move the clock (the rule is 'no replay', not 'no clock')",
  clockMoved > clockBefore, `${new Date(clockBefore).toISOString()} -> ${new Date(clockMoved).toISOString()}`);

// ---- clean up: no QA backend left behind -------------------------------------------------------
await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/backends/${ROW.id}`, { method: "DELETE", headers: H });
try { rmSync(path.join("/tmp", "as-replay-probe"), { recursive: true, force: true }); } catch { /* not ours */ }

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
