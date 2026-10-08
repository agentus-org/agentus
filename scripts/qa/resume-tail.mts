// What the client must do with the frames a RECONNECT sends back (the `partial` tail).
//
// The tail is not a page of history to append: it re-states rows the client already holds, because the
// row it last saw may have GROWN while the socket was down — a streamed reply is folded into one row
// that keeps its seq, and a tool call's output lands after the call row exists. Applying that tail
// through a plain "have I seen this seq?" guard froze those bubbles at whatever version the client
// happened to hold, until a reload — which is the 「重启后最后几条消息错乱」 the operator reported.
//
// No server, no browser: the frames are fed to the real cockpit store, the same entry point the
// WebSocket calls.
//
// Run: npm run resume-tail
// The store touches localStorage only to remember the active session; the browser APIs it does not need.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { cockpit } = await import("../../packages/web/src/state.ts");

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const SID = "s-resume";
type Row = { seq: number; sessionId: string; kind: string; payload: unknown; createdAt: number; toolCallId?: string };
const row = (seq: number, kind: string, payload: unknown, toolCallId?: string): Row =>
  ({ seq, sessionId: SID, kind, payload, createdAt: 1_700_000_000_000 + seq, ...(toolCallId ? { toolCallId } : {}) });
const agent = (text: string, messageId?: string): unknown =>
  ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}) });
const call = (status: string): unknown =>
  ({ sessionUpdate: "tool_call", toolCallId: "tc-1", title: "跑测试", status });
const frame = (messages: Row[], partial = false): unknown =>
  ({ t: "messages", sessionId: SID, messages, hasMore: false, ...(partial ? { partial: true } : {}) });

type Block = { key?: string; kind: string; text?: string; status?: string; toolCallId?: string };
const blocks = (): Block[] => ((cockpit.byId.get(SID)?.msgs ?? []) as unknown as Block[]);
const of = (kind: string): Block[] => blocks().filter((b) => b.kind === kind);

// ---- 1. a full replay opens the transcript --------------------------------------------------
cockpit.apply(frame([
  row(1, "user", { text: "先问一句" }),
  row(2, "agent", agent("不是", "m-1")),
  row(3, "tool", call("pending"), "tc-1"),
]) as never);
check("the replay renders one bubble per row", blocks().length === 3, `${blocks().length} blocks`);
check("…including the tool card", of("tool").length === 1 && of("tool")[0]?.status === "pending");

// ---- 2. the reconnect tail: rows re-stated, one of them GROWN --------------------------------
// Exactly what the server sends after a restart: the same rows (some grown) plus whatever is new.
cockpit.apply(frame([
  row(1, "user", { text: "先问一句" }),                       // re-stated, unchanged
  row(2, "agent", agent("不是这样的，因为 socket 断过。", "m-1")), // GREW while the socket was down
  row(3, "tool", call("completed"), "tc-1"),                  // output landed after the call row
  row(4, "agent", agent("这是断线之后的新回答。", "m-2")),        // genuinely new
], true) as never);

check("the grown row is REPLACED, not dropped (that is the bug this guards)",
  of("agent").find((b) => b.key === "agent:m-1")?.text === "不是这样的，因为 socket 断过。",
  JSON.stringify(of("agent").find((b) => b.key === "agent:m-1")?.text));
check("…and it is still ONE bubble", of("agent").filter((b) => b.key === "agent:m-1").length === 1,
  `${of("agent").filter((b) => b.key === "agent:m-1").length} bubbles`);
check("a re-stated user row does not become a second bubble", of("user").length === 1,
  `${of("user").length} user bubbles`);
check("a re-stated tool row upserts (one card, newest status)",
  of("tool").length === 1 && of("tool")[0]?.status === "completed",
  `${of("tool").length} cards, status=${of("tool")[0]?.status}`);
check("a genuinely new row is added", of("agent").some((b) => b.key === "agent:m-2"));
check("nothing else was invented", blocks().length === 4, `${blocks().length} blocks`);

// ---- 3. an UNKEYED row is the one thing the tail must not re-apply --------------------------
// Its folding rule is "merge with the block above", so re-delivering one would grow a second bubble.
// It therefore stays behind the seq guard — and a first delivery still lands normally.
{
  // It merges with the block above it (`foldTextRow`'s no-id rule), so the thing to check is that the
  // text is not DOUBLED by a re-delivery.
  const held = (): string => of("agent").find((b) => b.key === "agent:m-2")?.text ?? "";
  cockpit.apply(frame([row(5, "agent", agent("一段没有 id 的回顾文字。"))], true) as never);
  const afterFirst = held();
  const blocksAfterFirst = blocks().length;
  check("an unkeyed row lands in the block above it (the no-id rule)",
    afterFirst.endsWith("一段没有 id 的回顾文字。"), JSON.stringify(afterFirst));
  cockpit.apply(frame([row(5, "agent", agent("一段没有 id 的回顾文字。"))], true) as never);
  check("…and its re-delivery does not double the text", held() === afterFirst,
    `${JSON.stringify(afterFirst)} → ${JSON.stringify(held())}`);
  check("…nor add a bubble", blocks().length === blocksAfterFirst,
    `${blocksAfterFirst} → ${blocks().length}`);
}

// ---- 4. a tail that arrives twice is still idempotent ---------------------------------------
{
  const before = blocks().length;
  cockpit.apply(frame([
    row(2, "agent", agent("不是这样的，因为 socket 断过。", "m-1")),
    row(3, "tool", call("completed"), "tc-1"),
    row(4, "agent", agent("这是断线之后的新回答。", "m-2")),
  ], true) as never);
  check("re-applying the same tail changes nothing", blocks().length === before,
    `${before} → ${blocks().length}`);
  check("…and the texts are still the server's version",
    of("agent").find((b) => b.key === "agent:m-2")?.text === "这是断线之后的新回答。");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
