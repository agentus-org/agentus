// QA: a fork must bring the operator's conversation WITH it — and must not grow a second copy of it.
//
// Measured on live 2026-10-16 (0.3.8): forking a 260-row session produced a slot holding ONE row (a
// `thought`). The agent side was fine (hermes had deep-copied all 238 messages); the cockpit's replay
// window was the bug — it re-read `maxSeq(id) > 0` per frame, so the first frame an EMPTY slot
// accepted closed the window on the remaining ~236. A fork is exactly the case where the replay is
// the only copy, so the window is now decided once, at spawn, and the fork additionally seeds the new
// slot's transcript from the parent's (the agent's replay cannot carry the operator's own prompts —
// `user_message_chunk` is not a row the cockpit renders).
//
// This fixture is the shape that must hold: rows copied kind-for-kind, from the OPERATOR's first
// message, with the agent's own re-attach replay dropped on top of it.
//
//   node scripts/qa/fork-transcript.mjs      (BASE/AGENTUS_DATA overridable, like the other sweeps)
import path from "node:path";
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

// MOCK_REPLAY=1 makes the agent re-send its whole history on `session/load` — the real shape a
// re-attach has, and the one that must not be folded onto the copy as a second transcript.
const ROW = {
  id: "qa-fork", label: "QA fork probe", kind: "mock",
  cmd: process.execPath, args: path.join(ROOT, "packages/server/mock/agent.mjs"),
  env: { MOCK_THINK: "1", MOCK_REPLAY: "1", MOCK_REPLAY_BLOCKS: "4" }, home: "", profile: "",
  notes: "smoke: a fork carries the conversation it was made from",
};

const created = await fetch(`${BASE}/api/backends`, {
  method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(ROW),
});
if (created.status === 409) {
  await fetch(`${BASE}/api/backends/${ROW.id}`, {
    method: "PATCH", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(ROW),
  });
}

const open = async (title) => (await j(await fetch(`${BASE}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ backend: ROW.id, cwd: "/tmp", title }),
}))).id;

const rowsOf = async (sid) => {
  const d = await j(await fetch(`${BASE}/api/sessions/${sid}/messages?tail=500`, { headers: H }));
  return (d.messages ?? []).map((m) => ({ kind: m.kind, text: String(m.payload?.text ?? m.text ?? "") }));
};
const statusOf = async (sid) => {
  const d = await j(await fetch(`${BASE}/api/sessions`, { headers: H }));
  return [...(d.live ?? []), ...(d.cold ?? []), ...(d.archived ?? [])].find((s) => s.id === sid) ?? null;
};
/** Wait for a state, and say which one it actually reached — "the prompt never ran" and "the turn
 *  is still going" are different failures and a bare boolean hides that. */
const waitStatus = async (sid, want) => {
  for (let i = 0; i < 200; i++) {
    const st = (await statusOf(sid))?.status ?? "?";
    if (want(st)) return st;
    await sleep(250);
  }
  return "timeout";
};
const settle = (sid) => waitStatus(sid, (st) => st === "ready");

// ---- fixture: a session with a real conversation behind it --------------------------------------
const parent = await open("fork parent");
console.log(`fixture session ${parent}`);
// A new slot is a ROW, not yet a process: resume it first — that is what the composer does on the
// first message of a cold session (a bare /prompt against it fails with "session not ready").
await fetch(`${BASE}/api/sessions/${parent}/resume`, { method: "POST", headers: H });
const up = await settle(parent);
check("the fixture slot is up before it is asked anything", up === "ready", `status=${up}`);
await fetch(`${BASE}/api/sessions/${parent}/prompt`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ text: "第一句话 the operator's own words" }),
});
await waitStatus(parent, (st) => st !== "running");
await sleep(500);
const source = await rowsOf(parent);
check("the fixture really has a conversation to carry", source.length >= 2,
  `rows=${source.length} kinds=${source.map((r) => r.kind).join(",")}`);
check("…starting with the OPERATOR's message (the half a replay cannot rebuild)",
  source[0]?.kind === "user", `first=${source[0]?.kind}`);

// ---- the fork ----------------------------------------------------------------------------------
const forked = await j(await fetch(`${BASE}/api/sessions/${parent}/fork`, { method: "POST", headers: H }));
check("the fork lands", Boolean(forked.id), JSON.stringify(forked).slice(0, 200));
const child = forked.id;
await settle(child);

const carried = await rowsOf(child);
check("the fork's transcript IS the parent's conversation (the whole point of forking)",
  carried.length > 0 && carried.length === source.length,
  `rows ${source.length} -> ${carried.length}`);
check("…kind for kind, text for text",
  JSON.stringify(carried) === JSON.stringify(source),
  carried.map((r) => r.kind).join(","));
check("…including the operator's own message (never reconstructed, always copied)",
  carried[0]?.kind === "user" && carried[0]?.text === source[0]?.text,
  `first=${carried[0]?.kind}`);

// The agent re-attaches to the forked id in a FRESH process and replays its history; the copy is
// already there, so that replay is a duplicate and the window must drop it whole.
const afterReplay = await rowsOf(child);
check("the agent's re-attach replay did NOT append a second copy",
  afterReplay.length === carried.length, `rows ${carried.length} -> ${afterReplay.length}`);

const info = await statusOf(child);
check("the fork's clock reads NOW (it is a new conversation, not the parent's age)",
  (info?.lastAt ?? 0) >= (info?.createdAt ?? 0) && Date.now() - (info?.lastAt ?? 0) < 120_000,
  `lastAt=${new Date(info?.lastAt ?? 0).toISOString()} createdAt=${new Date(info?.createdAt ?? 0).toISOString()}`);

// ---- and it still WORKS: the copy is history, the next turn appends to it ------------------------
await fetch(`${BASE}/api/sessions/${child}/prompt`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ text: "接着干 continue in the fork" }),
});
await settle(child);
const grown = await rowsOf(child);
check("a turn in the fork APPENDS to the carried history (seq keeps counting)",
  grown.length > carried.length, `rows ${carried.length} -> ${grown.length}`);
check("…and the carried history is still intact in front of it",
  JSON.stringify(grown.slice(0, carried.length)) === JSON.stringify(carried),
  `${grown.slice(0, 4).map((r) => r.kind).join(",")} …`);

// ---- the window's other half: a replay that is the ONLY copy is kept IN FULL ---------------------
// A slot whose rows are gone has nothing but the agent's replay to rebuild from, so that replay is
// not a duplicate and none of it may be dropped. The trap: an EMPTY slot accepting its first frame
// makes `maxSeq` non-zero, so a per-frame test ends the window after ONE row — the same shape the
// fork above showed. Measured here on a slot that never had rows: the agent re-attaches and replays
// MOCK_REPLAY_BLOCKS × 2 frames, and all of them must land.
const bare = await open("bare slot");
await fetch(`${BASE}/api/sessions/${bare}/resume`, { method: "POST", headers: H });
await settle(bare);
// restart = re-attach: the agent replays its history onto a slot the store holds no rows for
await fetch(`${BASE}/api/sessions/${bare}/restart`, { method: "POST", headers: H });
await settle(bare);
await sleep(2500); // the replay is exactly what is being measured
const rebuilt = await rowsOf(bare);
check("a replay that is the ONLY copy lands IN FULL (an empty slot is not a duplicate)",
  rebuilt.length >= 8, `rows=${rebuilt.length} kinds=${rebuilt.map((r) => r.kind).join(",")}`);

// ---- clean up: no QA backend left behind --------------------------------------------------------
await fetch(`${BASE}/api/sessions/${bare}`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/sessions/${child}`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/sessions/${parent}`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/backends/${ROW.id}`, { method: "DELETE", headers: H });

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
