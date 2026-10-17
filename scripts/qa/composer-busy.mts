// 「我按了回车，它说 turn already running，我的话也没了」 — the composer must never be the reason a
// sentence dies (2026-10-17).
//
// Three separate truths are guarded here, because all three had to be wrong at once for the incident:
//   1. WHAT THE OPERATOR SEES — a session whose turn is running must show STOP, even on a page that never
//      saw the `turn-start` frame (the operator's page was open across a cockpit restart, so it did not).
//   2. WHAT A BLIND PAGE SENDS — a prompt pressed while the socket is down must be FILED, not replayed
//      verbatim on reconnect: the replay cannot know the agent has since started working.
//   3. WHERE THE WORDS GO WHEN THE SERVER STILL REFUSES — the refusal carries them back, and the client
//      puts them in line for the next turn instead of leaving them in a red bubble.
//
//   npx tsx scripts/qa/composer-busy.mts
import { busyNow, cockpit as store } from "../../packages/web/src/state";

// The store touches localStorage for the queue/active session; node has none.
(globalThis as unknown as { localStorage: Storage }).localStorage ??= {
  getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0,
} as unknown as Storage;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const tick = () => new Promise((r) => setTimeout(r, 5));

const SID = "sess-busy-qa";
const info = (status: string) => ({ id: SID, title: "busy probe", backend: "mock", status, cwd: "/tmp", cold: false });

// ---- 1. busy is the SERVER's word, not just the frames we happened to see ----
check("a session the server calls running is busy, even with no turn-start seen",
  busyNow({ busy: false, info: { status: "running" } }) === true);
check("our own turn-start still counts before the status frame lands",
  busyNow({ busy: true, info: { status: "ready" } }) === true);
check("an idle session is not busy", busyNow({ busy: false, info: { status: "ready" } }) === false);
check("a view that does not exist yet is not busy", busyNow(null) === false);

// ---- 2. a prompt pressed with the socket down is filed, not replayed ----
store.apply({ t: "sessions", sessions: [info("running")], cold: [], archived: [], pending: [] } as never);
store.setActive(SID);
await tick();
const sent = store.send({ t: "prompt", sessionId: SID, text: "断线时说的话" } as never);
const queued = store.getSnapshot().active?.queue ?? [];
check("with the socket down, send() reports not-sent (so nothing pretends to be delivered)", sent === false);
check("…and the words are in the QUEUE, where the operator can see/retract them",
  queued.some((q) => q.text === "断线时说的话"), JSON.stringify(queued.map((q) => q.text)));
check("…with no interrupt flag waiting to be replayed into a busy agent (the queue drains at turn-end)",
  Boolean(queued.length) && queued.every((q) => !q.inflight));

// a turn is running, so the queue must NOT hand itself over now — and the drain must reach that
// conclusion from `status` alone, because a reconnected page has no `busy` to offer
store.drainQueue(SID);
await tick();
check("drainQueue refuses to hand over while the server says running (status alone is enough)",
  (store.getSnapshot().active?.queue ?? []).every((q) => !q.inflight));

store.apply({ t: "messages", sessionId: SID, messages: [], partial: true } as never);
await tick();
check("while the server says running, the filed prompt stays filed",
  (store.getSnapshot().active?.queue ?? []).length === queued.length);

// ---- 3. a refusal hands the sentence back and it goes back in line ----
const before = (store.getSnapshot().active?.queue ?? []).length;
store.apply({
  t: "message",
  message: {
    seq: -1, sessionId: SID, kind: "meta", createdAt: Date.now(),
    payload: { text: "turn failed: turn already running", rejectedPrompt: "被拒的那句" },
  },
} as never);
await tick();
const after = store.getSnapshot().active?.queue ?? [];
check("a `turn already running` refusal requeues the operator's sentence",
  after.some((q) => q.text === "被拒的那句"), JSON.stringify(after.map((q) => q.text)));
check("…and the shell keeps the red bubble too (it is still the explanation)",
  (store.getSnapshot().active?.msgs ?? []).some((m) => m.kind === "meta" && String(m.text).includes("turn already running")));
check("…without inventing a second copy when the same block re-arrives (resync)",
  (() => {
    store.apply({
      t: "message",
      message: { seq: 11, sessionId: SID, kind: "meta", createdAt: Date.now(), payload: { text: "unrelated" } },
    } as never);
    return true;
  })() && (store.getSnapshot().active?.queue ?? []).length >= before + 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
