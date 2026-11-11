// QA (#103): a FORK must keep the history the agent replays into it.
//
// A fork is the one slot whose transcript arrives ENTIRELY as a replay: the cockpit creates a new
// session row and the agent deep-copies the parent's conversation into a new ACP session, which the
// slot then reads back through `session/load`. The replay window used to ask the store `maxSeq() > 0`
// PER FRAME, so the first frame it persisted answered "we already have a transcript" for all the
// rest and every fork showed exactly one message (measured: 3/3 forks, 1 row each).
//
// Two things are asserted here, and they fail for different reasons:
//   · the fork keeps MORE than one row (the window-level `replayHadTranscript`)
//   · those rows include the operator's own turns (`user_message_chunk`, which had no branch at all)
// …plus the inverse rule from `replay-window.mjs`: a RESUME of a session that already has a
// transcript still drops the replay. That file owns that case; this one must not weaken it.
//
//   BASE=http://127.0.0.1:8901 AGENTUS_DATA=… node scripts/qa/fork-replay.mjs
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

const backend = (id, env) => ({
  id, label: `QA ${id}`, kind: "mock", cmd: process.execPath,
  args: path.join(ROOT, "packages/server/mock/agent.mjs"), env, home: "", profile: "", notes: "smoke: #103 fork replay",
});
const register = async (row) => {
  const r = await fetch(`${BASE}/api/backends`, {
    method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(row),
  });
  if (r.status === 409) {
    await fetch(`${BASE}/api/backends/${row.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", ...H }, body: JSON.stringify(row),
    });
  }
};
const newSession = async (backendId, title) => (await j(await fetch(`${BASE}/api/sessions`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ backend: backendId, cwd: "/tmp", title }),
}))).id;
const messages = async (sid) => {
  const r = await fetch(`${BASE}/api/sessions/${sid}/messages?tail=250`, { headers: H });
  return (await j(r)).messages ?? [];
};
const rows = async (sid) => (await messages(sid)).length;
const statusOf = async (sid) => {
  const d = await j(await fetch(`${BASE}/api/sessions`, { headers: H }));
  return [...(d.live ?? []), ...(d.archived ?? [])].find((s) => s.id === sid)?.status ?? "?";
};
const settle = async (sid, tries = 160) => {
  for (let i = 0; i < tries && (await statusOf(sid)) === "running"; i++) await sleep(250);
  await sleep(500);
};
/** A freshly created slot is still handshaking; a prompt sent before it is ready is refused. */
const waitReady = async (sid, tries = 240) => {
  for (let i = 0; i < tries; i++) {
    const st = await statusOf(sid);
    if (st === "ready" || st === "running") return st;
    await sleep(250);
  }
  return statusOf(sid);
};

// ---- fixture: a session with a real turn behind it, on an agent that replays on load ----------
await register(backend("qa-fork", { MOCK_REPLAY: "1", MOCK_REPLAY_BLOCKS: "3" }));
const sid = await newSession("qa-fork", "fork replay");
check("fixture session created", Boolean(sid), `id=${sid}`);
await waitReady(sid);
await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ text: "原始回合 original turn" }),
});
await settle(sid);
const parentRows = await rows(sid);
check("the parent really has a transcript before we fork", parentRows >= 2, `rows=${parentRows}`);

// ---- the fork --------------------------------------------------------------------------------
const forked = await fetch(`${BASE}/api/sessions/${sid}/fork`, { method: "POST", headers: H });
const forkedBody = await j(forked);
check("fork succeeds", forked.status === 200 && Boolean(forkedBody.id), `HTTP ${forked.status} ${forkedBody.error ?? ""}`);
const fid = forkedBody.id;
if (fid) {
  await settle(fid);
  await sleep(2500); // the replay is exactly what we are measuring — let it land
  const msgs = await messages(fid);
  const kinds = msgs.map((m) => m.kind);
  const said = msgs.filter((m) => m.kind === "user").map((m) => String(m.payload?.text ?? ""));
  check("the fork kept the replayed history (more than the one row it used to)",
    msgs.length > 1, `rows=${msgs.length} kinds=${[...new Set(kinds)].join(",") || "none"}`);
  check("…all three replayed blocks survived (3 asks + 3 thoughts + 3 answers)",
    msgs.length >= 9, `rows=${msgs.length}`);
  check("…including the operator's own turns (no `user_message_chunk` branch = none of these)",
    said.length >= 3, `user rows=${said.length}`);
  check("…and their text is readable (the bubble reads `payload.text`)",
    said.every((t) => t.startsWith("replayed ask")), said[0] ?? "");
  check("the parent was not touched by the fork", (await rows(sid)) === parentRows, `rows=${await rows(sid)}`);
  check("no 「history did not load」 hint when the replay landed",
    !msgs.some((m) => m.kind === "note" && /没能载入/.test(String(m.payload?.text ?? ""))));

  // the window still closes: a real turn after the fork streams into the transcript
  const before = msgs.length;
  await waitReady(fid);
  await fetch(`${BASE}/api/sessions/${fid}/prompt`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ text: "fork 之后再问一句 follow-up" }),
  });
  await settle(fid);
  check("a prompt on the fork still writes rows (the replay window closes)",
    (await rows(fid)) > before, `rows ${before} -> ${await rows(fid)}`);
  await fetch(`${BASE}/api/sessions/${fid}`, { method: "DELETE", headers: H });
}

// ---- the inverse: an agent that replays NOTHING must say so, not show a blank session --------
await register(backend("qa-noreplay", {}));
const silent = await newSession("qa-noreplay", "fork without replay");
await waitReady(silent);
await fetch(`${BASE}/api/sessions/${silent}/prompt`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ text: "原始回合 for the silent backend" }),
});
await settle(silent);
const silentFork = await j(await fetch(`${BASE}/api/sessions/${silent}/fork`, { method: "POST", headers: H }));
if (silentFork.id) {
  await settle(silentFork.id);
  await sleep(3500); // the hint is deferred by 3s on purpose
  const hint = (await messages(silentFork.id))
    .find((m) => m.kind === "note" && /没能载入/.test(String(m.payload?.text ?? "")));
  check("an empty fork says 「history did not load」 instead of showing a blank conversation",
    Boolean(hint), hint ? String(hint.payload?.text).slice(0, 40) : "no note row");
  await fetch(`${BASE}/api/sessions/${silentFork.id}`, { method: "DELETE", headers: H });
} else {
  check("the silent-backend fork still comes up (it is the fallback path, not a failure)", false,
    String(silentFork.error ?? "no id"));
}

// ---- clean up --------------------------------------------------------------------------------
await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/sessions/${silent}`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/backends/qa-fork`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/backends/qa-noreplay`, { method: "DELETE", headers: H });

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
