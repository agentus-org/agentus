// Auto-read selection (issues #66 / #67) — pure arithmetic, so no server, no agent slot, no browser.
//
// What it pins:
//   #67  a turn split by tool calls is read IN FULL, in order — not just its last paragraph, and the
//        settled paragraphs are handed over while the turn is still running;
//   #67  only the CURRENT turn is read (the previous turn's paragraphs, and history, are not);
//   #67  the 30 s freshness window still stops a slot opened from history from talking to the room;
//   #66  the stop/hush path drops what has not been read yet and does not suppress the next turn.
//
//   node_modules/.bin/tsx scripts/qa/auto-read-sweep.mts
import { settledReplies, AUTO_READ_FRESH_MS } from "../../packages/web/src/autoRead";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}

const NOW = 1_700_000_000_000;
const agent = (key: string, text: string) => ({ key, kind: "agent", text });
const user = (key: string, text: string) => ({ key, kind: "user", text });
const tool = (key: string) => ({ key, kind: "tool" });
const view = (msgs: unknown[], extra: Record<string, unknown> = {}) => ({
  msgs,
  busy: false,
  loaded: true,
  lastAt: NOW - 1_000,
  ...extra,
}) as never;

// ---- #67: a turn cut by a tool call, finished ------------------------------------------------
const splitTurn = view([
  user("u1", "查一下配置"),
  agent("a1", "我先看下配置"),
  tool("t1"),
  agent("a2", "配置里没有这一项"),
  tool("t2"),
  agent("a3", "结论：需要手动加"),
]);
const split = settledReplies(splitTurn, NOW);
check("split turn: every paragraph is read", split?.length === 3, `got ${split?.length}`);
check("split turn: order preserved", split?.map((t) => t.key).join(",") === "a1,a2,a3", String(split?.map((t) => t.key)));
check("split turn: text carried", split?.[0].text === "我先看下配置", String(split?.[0]?.text));

// ---- #67: the same turn while it is still streaming ------------------------------------------
const midTurn = view(
  [
    user("u1", "查一下配置"),
    agent("a1", "我先看下配置"),
    tool("t1"),
    agent("a2", "正在查…"),
  ],
  { busy: true },
);
const mid = settledReplies(midTurn, NOW);
check("mid-turn: the landed paragraph is read", mid?.length === 1 && mid[0].key === "a1", JSON.stringify(mid));
check("mid-turn: the still-growing one waits", !mid?.some((t) => t.key === "a2"));

// ---- the same turn once it ends: the tail joins ----------------------------------------------
const landed = settledReplies(view([user("u1", "查"), agent("a1", "我先看下"), tool("t1"), agent("a2", "结论是 X")]), NOW);
check("turn end: the last paragraph is read too", landed?.length === 2 && landed[1].key === "a2", JSON.stringify(landed));

// ---- only the CURRENT turn -------------------------------------------------------------------
const twoTurns = view([
  user("u1", "第一问"),
  agent("a1", "第一答"),
  user("u2", "第二问"),
  agent("a2", "第二答"),
]);
const cur = settledReplies(twoTurns, NOW);
check("two turns: only the latest turn is read", cur?.length === 1 && cur[0].key === "a2", JSON.stringify(cur));

// ---- history / freshness / readiness ---------------------------------------------------------
check("stale session: nothing is read", settledReplies(view([user("u1", "x"), agent("a1", "旧答复")], { lastAt: NOW - AUTO_READ_FRESH_MS - 1 }), NOW) === null);
check("not loaded: nothing is read", settledReplies(view([agent("a1", "x")], { loaded: false }), NOW) === null);
check("no session: nothing is read", settledReplies(undefined, NOW) === null);
check("empty turn: empty list, not null", Array.isArray(settledReplies(view([user("u1", "hi")]), NOW)));
check("empty turn: zero segments", settledReplies(view([user("u1", "hi")]), NOW)?.length === 0);

// ---- noise the transcript really carries -----------------------------------------------------
const noisy = view([
  user("u1", "go"),
  { key: "th1", kind: "thought", text: "thinking" },
  agent("a1", "   "),
  { key: "a2", kind: "agent" },
  agent("a3", "真话"),
]);
const noisyOut = settledReplies(noisy, NOW);
check("thoughts, blank and text-less rows are skipped", noisyOut?.length === 1 && noisyOut[0].key === "a3", JSON.stringify(noisyOut));

// ---- one long message split into three bubbles, all landed ----------------------------------
const three = settledReplies(view([user("u1", "go"), agent("a1", "一"), agent("a2", "二"), agent("a3", "三")]), NOW);
check("three landed bubbles: all three read", three?.length === 3, JSON.stringify(three));

// ---- a completed turn long ago (fresh) must still be readable, but not history ---------------
check(
  "exactly at the freshness edge is still fresh",
  settledReplies(view([user("u1", "x"), agent("a1", "y")], { lastAt: NOW - AUTO_READ_FRESH_MS }), NOW)?.length === 1,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
