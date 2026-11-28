// issue #120: the Studio side of surface_v1 — provenance / call state never becomes user text.
// Pure QA (no network): the actual ACP + fork hop is covered by the dev probe.
import assert from "node:assert/strict";

const { dispatchSurface, completionSurface } = await import("../../packages/server/src/acp/surface.js");
const { voiceSurfaceMeta } = await import("../../packages/server/src/acp/voice-mode.js");

const ctx = (meta: { studio_context: string }): Record<string, unknown> => JSON.parse(meta.studio_context);

const dispatch = dispatchSurface({ sessionId: "abc123", title: "planner" });
assert.equal(dispatch.surface, "studio-dispatch");
assert.equal(ctx(dispatch).sourceSessionId, "abc123");
assert.equal(ctx(dispatch).sourceTitle, "planner");
assert.equal(ctx(dispatch).dispatcher, "planner");
assert.ok(!JSON.stringify(dispatch).includes("ship the patch"), "the task itself is not repeated in metadata");

const completion = completionSurface("【完成回推】worker1 finished", { sessionId: "worker1", title: "worker" });
assert.equal(completion.surface, "studio-completion");
assert.equal(ctx(completion).text, "【完成回推】worker1 finished");
assert.equal(ctx(completion).sourceSessionId, "worker1");

const call = voiceSurfaceMeta("sess1", { inCall: true, boundary: "enter", turns: 0 });
if (!call) throw new Error("voice surface missing");
assert.equal(call.surface, "voice-live");
assert.equal(ctx(call).sessionId, "sess1");
assert.equal(ctx(call).state, "in-call");
assert.ok(String(ctx(call).text).includes("TTS"));
assert.ok(!JSON.stringify(call).includes('"resource"'), "call state is not a fake user resource block");

const { readCaps } = await import("../../packages/server/src/acp/session-manager.js");
const oldCaps = readCaps({ loadSession: true, sessionCapabilities: { fork: {} } });
assert.equal(oldCaps.surfaceV1, false, "an old backend is not assumed to support surface_v1");
const newCaps = readCaps({ _meta: { hermesStudio: { surfaceV1: true } } });
assert.equal(newCaps.surfaceV1, true, "the fork advertises surface_v1 in initialize._meta");

const handoff = dispatchSurface({ sessionId: "src", title: "planner" }, "handoff", "[跨工作空间转交] provenance");
assert.equal(ctx(handoff).kind, "handoff", "handoff/spawn rides the same surface channel");
assert.equal(ctx(handoff).text, "[跨工作空间转交] provenance", "the envelope is a model-bound note, not ACP text");
assert.ok(ctx(dispatchSurface({ sessionId: "s" }, "spawn", "x".repeat(9000))).text.length < 5000, "notes are clipped before JSON");

console.log("[surface-injection] 12 assertions passed");
