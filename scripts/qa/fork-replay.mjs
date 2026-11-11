// QA (#103, #104): a FORK is a branch of the CONVERSATION, not of the agent's context.
//
// The rule moved twice, so this file records both:
//   · #103 — a fork's transcript arrived entirely as an ACP replay, and the window asked the store
//     "do we already hold one?" PER FRAME, so the first persisted frame locked the rest out and
//     every fork showed exactly one row.
//   · #104 — fixing the window exposed what the replay actually contains: the AGENT's context. A
//     fork of an 882-row conversation came up with 189 rows, all timestamped inside two seconds,
//     led by a 31 KB context-compaction handoff the parent never displayed, and missing all 26
//     status lines / 11 per-turn token accounts / 1 approval card the parent did display.
// So a fork now COPIES the parent's rows first and the replay is dropped by the window rule.
//
// Asserted here:
//   · the branch opens with the parent's transcript — same rows, same order, same timestamps
//   · the agent's replay does NOT leak into it (the mock replays loudly; none of it may appear)
//   · a prompt on the branch appends after the copied rows
//   · an EMPTY parent plus an agent that replays nothing still says so instead of showing blank
//   · `replay-window.mjs` keeps owning the inverse rule (a resume of a live transcript drops it)
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
  args: path.join(ROOT, "packages/server/mock/agent.mjs"), env, home: "", profile: "", notes: "smoke: #103/#104 fork",
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
/** What the operator actually reads, in order: kind + text + the moment it was said. */
const shape = async (sid) => (await messages(sid)).map((m) => ({
  kind: m.kind,
  at: m.createdAt,
  text: String(m.payload?.text ?? m.payload?.content?.text ?? m.payload?.title ?? ""),
}));
const statusOf = async (sid) => {
  const d = await j(await fetch(`${BASE}/api/sessions`, { headers: H }));
  return [...(d.live ?? []), ...(d.archived ?? [])].find((s) => s.id === sid)?.status ?? "?";
};
const settle = async (sid, tries = 160) => {
  for (let i = 0; i < tries && (await statusOf(sid)) === "running"; i++) await sleep(250);
  await sleep(500);
};
/** A freshly created slot is still handshaking; a prompt sent before that is refused. */
const waitReady = async (sid, tries = 240) => {
  for (let i = 0; i < tries; i++) {
    const st = await statusOf(sid);
    if (st === "ready" || st === "running") return st;
    await sleep(250);
  }
  return statusOf(sid);
};

// ---- a parent with a real transcript, on an agent that replays loudly on load -----------------
await register(backend("qa-fork", { MOCK_REPLAY: "1", MOCK_REPLAY_BLOCKS: "3" }));
const sid = await newSession("qa-fork", "fork · copy");
check("fixture session created", Boolean(sid), `id=${sid}`);
await waitReady(sid);
await fetch(`${BASE}/api/sessions/${sid}/prompt`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ text: "原始回合 original turn" }),
});
await settle(sid);
const parent = await shape(sid);
check("the parent has a transcript to branch from", parent.length >= 2, `rows=${parent.length}`);

// ---- the fork --------------------------------------------------------------------------------
const forked = await fetch(`${BASE}/api/sessions/${sid}/fork`, { method: "POST", headers: H });
const forkedBody = await j(forked);
check("fork succeeds", forked.status === 200 && Boolean(forkedBody.id), `HTTP ${forked.status} ${forkedBody.error ?? ""}`);
const fid = forkedBody.id;
if (fid) {
  await settle(fid);
  await sleep(2500); // the replay, and any late frame, has had its chance by now
  const branch = await shape(fid);
  check("the branch opens with the parent's transcript — same number of rows",
    branch.length === parent.length, `parent=${parent.length} branch=${branch.length}`);
  check("…same order and kinds",
    branch.every((r, i) => r.kind === parent[i]?.kind), branch.map((r) => r.kind).join(","));
  check("…and the same timestamps (not one burst at fork time)",
    branch.every((r, i) => r.at === parent[i]?.at),
    `first ${branch[0]?.at} vs ${parent[0]?.at} · distinct ${new Set(branch.map((r) => r.at)).size}/${branch.length}`);
  check("…with the same text, row for row",
    branch.every((r, i) => r.text === parent[i]?.text));
  check("the agent's replay did NOT leak into the branch (no 「replayed ask」 rows)",
    !branch.some((r) => r.text.includes("replayed ask")),
    branch.filter((r) => r.text.includes("replayed ask")).length + " leaked row(s)");
  check("the parent was not touched by the fork", (await rows(sid)) === parent.length, `rows=${await rows(sid)}`);
  check("no 「history did not load」 hint when the branch has a transcript",
    !branch.some((r) => r.kind === "note" && /没能载入/.test(r.text)));

  // the branch is a live conversation, not a snapshot: a prompt appends after the copied rows
  await waitReady(fid);
  await fetch(`${BASE}/api/sessions/${fid}/prompt`, {
    method: "POST", headers: { "content-type": "application/json", ...H },
    body: JSON.stringify({ text: "fork 之后再问一句 follow-up" }),
  });
  await settle(fid);
  const after = await shape(fid);
  check("a prompt on the branch appends after the copied rows",
    after.length > branch.length && after.slice(0, branch.length).every((r, i) => r.at === branch[i].at),
    `rows ${branch.length} -> ${after.length}`);
  await fetch(`${BASE}/api/sessions/${fid}`, { method: "DELETE", headers: H });
}

// ---- the fallback: an EMPTY parent + an agent that replays nothing ----------------------------
await register(backend("qa-noreplay", {}));
const silent = await newSession("qa-noreplay", "fork · empty parent");
await waitReady(silent);
check("the parent really has no rows to copy", (await rows(silent)) === 0, `rows=${await rows(silent)}`);
const silentFork = await j(await fetch(`${BASE}/api/sessions/${silent}/fork`, { method: "POST", headers: H }));
if (silentFork.id) {
  await settle(silentFork.id);
  await sleep(3500); // the hint is deferred by 3s on purpose
  const hint = (await messages(silentFork.id))
    .find((m) => m.kind === "note" && /没能载入/.test(String(m.payload?.text ?? "")));
  check("an empty branch with no replay says 「history did not load」 instead of showing a blank",
    Boolean(hint), hint ? String(hint.payload?.text).slice(0, 40) : "no note row");
  await fetch(`${BASE}/api/sessions/${silentFork.id}`, { method: "DELETE", headers: H });
} else {
  check("the silent-backend fork still comes up (it is the fallback path, not a failure)", false,
    String(silentFork.error ?? "no id"));
}

// ---- a branch the AGENT has forgotten still opens (our copy is the transcript) ----------------
// `session/fork` hands us an id the agent holds in ITS process. A resume spawns a fresh child, and
// an in-process agent has never heard of that id — `MOCK_FORGET=1` is exactly that shape. A branch
// whose transcript lives in our store must survive it: losing the agent's context is recoverable,
// losing the conversation is not (#104). Without `forkedFrom`, `resume` answers `context_missing`
// here and the fork can never be opened again.
await register(backend("qa-forget", { MOCK_FORGET: "1" }));
const forgot = await newSession("qa-forget", "fork · agent forgot");
check("a MOCK_FORGET session created", Boolean(forgot), `id=${forgot}`);
await waitReady(forgot);
await fetch(`${BASE}/api/sessions/${forgot}/prompt`, {
  method: "POST", headers: { "content-type": "application/json", ...H },
  body: JSON.stringify({ text: "原始回合 on a forgetful agent" }),
});
await settle(forgot);
const forgotParent = await shape(forgot);
const forgotFork = await j(await fetch(`${BASE}/api/sessions/${forgot}/fork`, { method: "POST", headers: H }));
check("a branch of a session the agent will forget still opens", Boolean(forgotFork.id),
  String(forgotFork.error ?? "ok"));
if (forgotFork.id) {
  await settle(forgotFork.id);
  const st = await statusOf(forgotFork.id);
  const got = await shape(forgotFork.id);
  check("…as a live slot, not an error", st !== "error" && st !== "?", `status=${st}`);
  check("…carrying the parent's transcript, because it is OUR copy",
    got.length === forgotParent.length && got.every((r, i) => r.at === forgotParent[i].at),
    `parent=${forgotParent.length} branch=${got.length}`);
  await fetch(`${BASE}/api/sessions/${forgotFork.id}`, { method: "DELETE", headers: H });
}

// ---- clean up --------------------------------------------------------------------------------
await fetch(`${BASE}/api/sessions/${sid}`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/sessions/${silent}`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/backends/qa-fork`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/backends/qa-noreplay`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/sessions/${forgot}`, { method: "DELETE", headers: H });
await fetch(`${BASE}/api/backends/qa-forget`, { method: "DELETE", headers: H });

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
