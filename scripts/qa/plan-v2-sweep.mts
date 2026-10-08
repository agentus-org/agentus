// QA: ACP v2's `plan_update`, behind its experiment switch (P2).
//
//   npm run plan-v2-sweep            # against whatever mode the server is in
//   AGENTUS_ACP_V2_PLAN=1 bash scripts/dev.sh start && npm run plan-v2-sweep
//
// Why the switch and why test both ways: v2 is still a DRAFT — the SDK ships it under an
// experimental subpath, both ends of this wire declare protocolVersion 1, and nothing may depend on
// it. What we do want is the property that survives a draft schema: a client that cannot parse a
// frame must not render a plan that is quietly wrong. So the parse is pinned by unit checks against
// the draft shapes, and the wire behaviour is asserted in whichever mode the server is running —
// `off` must mean "not a single trace", `on` must mean "the same card, v2's extra statuses intact".
//
// The unit half imports the real module (tsx), so this can't drift from the implementation.
import fs from "node:fs";
import path from "node:path";
import { acceptsWriteFrom, foldPlanUpdate, normalizeItems, v2PlanEnabled } from "../../packages/server/src/plan/plan.ts";

const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// --- the pure mapping, against the draft schema ---------------------------------------
const v2Frame = (plan) => ({ sessionUpdate: "plan_update", plan, _meta: { "x/source": "v2" } });
const itemsFrame = v2Frame({
  planId: "main", type: "items",
  entries: [
    { content: "v2 write the code", status: "completed", priority: "medium" },
    { content: "v2 run the suite", status: "in_progress", priority: "high" },
    { content: "v2 hand over", status: "cancelled", priority: "low" },
  ],
});
const folded = foldPlanUpdate(itemsFrame);
check("an item-list plan_update folds into the shape the card renders",
  folded?.entries?.length === 3 && folded?.planId === "main", JSON.stringify(folded?.entries?.map((e) => e.status)));
check("…keeping v2's extra `cancelled` status, not dropping the step",
  folded?.entries?.[2]?.status === "cancelled" && folded?.entries?.[2]?.content === "v2 hand over",
  JSON.stringify(folded?.entries?.[2]));
check("…and carrying the frame's `_meta` through (that is where a remark would live)",
  JSON.stringify(folded?.meta) === JSON.stringify({ "x/source": "v2" }), JSON.stringify(folded?.meta));

check("a markdown plan is NOT guessed into a step list",
  foldPlanUpdate(v2Frame({ planId: "main", type: "markdown", content: "# plan\n- do it" })) === null);
check("a file plan is NOT guessed into a step list",
  foldPlanUpdate(v2Frame({ planId: "main", type: "file", uri: "file:///tmp/plan.md" })) === null);
check("a plan with an unknown `type` is ignored rather than half-read",
  foldPlanUpdate(v2Frame({ planId: "main", type: "timeline", entries: [{ content: "x", status: "pending" }] })) === null);
check("a frame with no plan at all is ignored", foldPlanUpdate({ sessionUpdate: "plan_update" }) === null);
check("a status we have never heard of is passed through, not silently completed",
  (() => {
    const f = foldPlanUpdate(v2Frame({ planId: "main", type: "items", entries: [{ content: "future status", status: "deferred" }] }));
    return f?.entries?.[0]?.status === "deferred";
  })(), "unknown statuses must survive (forward compatibility)");

check("the switch is OFF unless someone asks for it", v2PlanEnabled({}) === false && v2PlanEnabled({ AGENTUS_ACP_V2_PLAN: "0" }) === false);
check("…and ON with AGENTUS_ACP_V2_PLAN=1", v2PlanEnabled({ AGENTUS_ACP_V2_PLAN: "1" }) === true);
check("normalizeItems still drops entries with no content (v1 and v2 share it)",
  normalizeItems([{ status: "pending" }, { content: "kept", status: "pending" }]).length === 1);

// --- write arbitration, both orders ---------------------------------------------------
check("a native frame is accepted over a tool-written plan (native priority)",
  acceptsWriteFrom("mcp", "acp") === true);
check("…and the tool cannot write over frames", acceptsWriteFrom("acp", "mcp") === false);
check("…while the turn lifecycle may always stamp the plan", acceptsWriteFrom("acp", "server") === true);

// --- on the wire: whatever mode this server is in -------------------------------------
// Pick the data dir by EVIDENCE (which token actually authenticates against BASE), never by an
// inherited env var: a shell that has pointed AGENTUS_DATA at another tree all along would otherwise
// hand this sweep that cockpit's token, every call would 401, and the "v2 is ignored" check would
// pass VACUOUSLY — the worst kind of green (measured 2026-10-08).
const dataDir = await (async () => {
  const dirs = [...new Set([process.env.AGENTUS_DATA, "/tmp/agentus-qa-account"].filter((d): d is string => Boolean(d)))];
  for (const d of dirs) {
    const file = path.join(d, "auth.token");
    if (!fs.existsSync(file)) continue;
    const tok = fs.readFileSync(file, "utf8").trim();
    const r = await fetch(`${BASE}/api/sessions`, { headers: { authorization: `Bearer ${tok}` } }).catch(() => null);
    if (r?.ok) return d;
  }
  throw new Error(`no data dir under test: tried ${dirs.join(", ")}`);
})();
const token = fs.readFileSync(path.join(dataDir, "auth.token"), "utf8").trim();
const api = async (p, init = {}) => {
  const r = await fetch(BASE + p, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const auth = await api("/api/sessions");
// An unauthorized answer is not an empty cockpit: without this the whole wire half passes vacuously.
if (auth.status !== 200) throw new Error(`cannot reach ${BASE} with ${dataDir}/auth.token (HTTP ${auth.status})`);

// This sweep exercises the FRAME path (v1 and v2 alike), which is now an OPT-IN: every backend
// defaults to MCP-driven, where a frame is dropped at the door (session-manager `#framesAccepted`).
// So it declares the capability BEFORE opening its session — the channel rides the handshake — and
// restores the row at the end.
const mockRowBefore = (await api("/api/backends/mock")).body;
await api("/api/backends/mock", { method: "PATCH", body: JSON.stringify({ ...mockRowBefore, nativePlanSource: "acp" }) });

const sess = (await api("/api/sessions", { method: "POST", body: JSON.stringify({ backend: "mock", cwd: "/tmp", title: "plan v2 sweep" }) })).body;
if (!sess?.id) throw new Error(`the sweep could not open a mock session: ${JSON.stringify(sess).slice(0, 160)}`);
const sid = sess.id;
const statusOf = async () => (await api("/api/sessions")).body?.live?.find((s) => s.id === sid)?.status ?? "";
const idle = async (ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const st = await statusOf();
    if (st !== "running" && st !== "starting") return st;
    if (Date.now() - t0 > ms) return st;
    await sleep(300);
  }
};
const say = async (text) => {
  const r = await api(`/api/sessions/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
  // A rejected prompt (session busy, agent gone) must not read as "the frame changed nothing".
  if (r.status >= 400) throw new Error(`prompt ${JSON.stringify(text)} rejected: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  await idle(60000);
  await sleep(400);
};
const planOf = async () => (await api(`/api/sessions/${sid}/plan`)).body?.plan ?? null;

await idle();
await say("[planv2] a draft v2 update");
const afterV2 = await planOf();
const frames = (await api(`/api/sessions/${sid}/messages?tail=1`)).body?.messages?.filter((m) => m.kind === "plan") ?? [];
const mode = afterV2 ? "on" : "off";
console.log(`\n[wire] this server is running with the v2 experiment ${mode.toUpperCase()}`);

if (mode === "on") {
  check("a v2 frame lands in the plan object",
    afterV2?.items?.length === 3 && afterV2?.source === "acp", JSON.stringify({ n: afterV2?.items?.length, source: afterV2?.source }));
  // The turn is over by the time we look, so the lifecycle has already demoted `in_progress` back to
  // `pending` (#finalizePlan). That is the v2 frame's own third step, not a lost one.
  check("…with the v2 entries in order, and the unfinished one demoted by the turn lifecycle (not lost)",
    afterV2?.items?.[0]?.content === "v2 read the failing test"
      && afterV2?.items?.[1]?.content === "v2 patch the flaky timing assert"
      && afterV2?.items?.[2]?.status === "pending",
    JSON.stringify(afterV2?.items?.map((i: { status: string; content: string }) => `${i.status}:${i.content.slice(0, 26)}`)));
} else {
  check("a v2 frame is ignored entirely — no plan object, no transcript row",
    afterV2 === null && frames.length === 0, JSON.stringify({ plan: afterV2, frames: frames.length }));
}

// Either way the v1 path in the SAME session must be untouched by any of this.
await say("[plan] the v1 frame");
const afterV1 = await planOf();
check("the v1 path still works in the same session (this is the channel Hermes uses)",
  afterV1?.items?.length === 3 && afterV1?.items?.[0]?.content === "read the failing test",
  JSON.stringify(afterV1?.items?.map((i) => i.content)));
check("…and its frames do land in the transcript (what an archived card replays)",
  ((await api(`/api/sessions/${sid}/messages?tail=1`)).body?.messages ?? []).some((m) => m.kind === "plan"),
  `v2 frames seen earlier: ${frames.length}`);

await api(`/api/sessions/${sid}`, { method: "DELETE" });
await api("/api/backends/mock", { method: "PATCH", body: JSON.stringify({ ...mockRowBefore }) });
console.log(`\nplan-v2-sweep: ${pass} passed, ${fail} failed  (server mode: v2 ${mode})`);
process.exit(fail ? 1 : 0);
