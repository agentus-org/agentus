// ⌘/Ctrl+Enter = 插话 (issue #14): the composer's one-keystroke "take the floor".
//
// Before this, interrupting meant Enter (which only FILES the message into the queue) and then the
// queue row's ↑ button — two steps, and one of them needs the mouse. The new verb is deliberately
// composed of those two existing steps (`enqueuePrompt` + `sendQueuedNow`) so the words keep the
// queue's ✕/✎ history and the `#takingFloor` guard instead of growing a third send path.
//
// This drives the real store with a captured socket: what goes on the WIRE is the assertion, not
// that a callback fired. Offline: no server, no browser.
//
// Run: npx tsx scripts/qa/insert-sweep.mts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { cockpit } = await import("../../packages/web/src/state.ts");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? (pass += 1) : (fail += 1);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

/** The store publishes its snapshot on a MACROTASK (rAF in the browser), so read it after one. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

const row = (id: string) => ({
  id, backend: "mock", acpSessionId: "acp-1", cwd: "/tmp", status: "running", pid: 42,
  title: id, createdAt: 1_000, modes: null, configOptions: [], commands: [],
});
const SID = "sess_insert_probe";

// ---- a captured socket: everything the store sends is recorded, nothing leaves the process ----
const sent: Record<string, unknown>[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(cockpit as any).ws = {
  readyState: 1, // WebSocket.OPEN
  send: (raw: string) => { sent.push(JSON.parse(raw)); },
};
const prompts = (): Record<string, unknown>[] => sent.filter((f) => f.t === "prompt");

cockpit.apply({ t: "sessions", sessions: [row(SID)], cold: [], archived: [] } as never);
// the queue lives on the SESSION VIEW (the rail snapshot carries the row only), so look at the
// active view — that is also the object the composer draws its queue rows from
cockpit.setActive(SID);
await tick();
const queue = (): { text: string; inflight?: boolean }[] => cockpit.getSnapshot().active?.queue ?? [];
const view = () => cockpit.getSnapshot().sessions.find((s) => s.id === SID);
check("the probe session is up and BUSY (the state 插话 exists for)", view()?.status === "running");

// ---- 1. plain Enter while busy files into the queue and sends NOTHING ----
cockpit.enqueuePrompt(SID, "回车排队的这一句", []);
await tick();
check("Enter files one queue row", queue().length === 1, JSON.stringify(queue().map((q) => q.text)));
check("…and nothing reached the agent (that is the wait the operator has to sit through)", prompts().length === 0,
  `${prompts().length} prompt frames`);

// ---- 2. ⌘/Ctrl+Enter takes the floor with the SAME row ----
cockpit.sendNow(SID, "别改了，先跑测试", []);
await tick();
const after = prompts();
check("⌘Enter puts exactly one prompt on the wire", after.length === 1, JSON.stringify(after));
check("…carrying the text he typed", after[0]?.text === "别改了，先跑测试", String(after[0]?.text));
check("…with `interrupt: true` (the server's cancel-then-wait hand-over, same as the queue's ↑)",
  after[0]?.interrupt === true, JSON.stringify(after[0]?.interrupt));
check("…for the right session", after[0]?.sessionId === SID, String(after[0]?.sessionId));

const q = queue();
check("the interrupted message keeps its queue row (✕/✎ still work on it)", q.length === 2, `${q.length} rows`);
check("…and only the new one is inflight (the queue's earlier row is NOT re-sent)",
  q.filter((r) => r.inflight).length === 1 && q[q.length - 1]?.text === "别改了，先跑测试",
  JSON.stringify(q.map((r) => ({ text: r.text, inflight: r.inflight }))));

// ---- 3. an empty box is not a message ----
const before = prompts().length;
cockpit.sendNow(SID, "   ", []);
await tick();
check("⌘Enter on an empty box sends nothing and files nothing",
  prompts().length === before && queue().length === 2, `${prompts().length - before} frames, ${queue().length} rows`);

// ---- 4. the same verb is harmless when NO turn is running: interrupt with nothing to cancel is a
//         plain prompt server-side, so the shortcut never needs a busy check of its own ----
cockpit.apply({ t: "session", session: { ...row(SID), status: "ready" } } as never);
await tick();
sent.length = 0;
cockpit.sendNow(SID, "空闲时也走同一条路", []);
await tick();
check("with nothing running the shortcut still sends (one frame, interrupt is a no-op there)",
  prompts().length === 1 && prompts()[0]?.interrupt === true, JSON.stringify(prompts()));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
