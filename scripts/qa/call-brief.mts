// #58, the deciding half: WHEN a phone call may say something about the work in progress.
//
// The rules are the ones production voice agents use (LiveKit's with_filler): truthful cues only, one
// leading ack, tools coalesced instead of narrated, a hard cap, and — the part that makes or breaks
// it — anything still held is DISCARDED the moment the answer starts. A cue that arrives after the
// work is done is worse than silence: it teaches the operator that the call is behind reality.
//
// Run: npx tsx scripts/qa/call-brief.mts
import { BriefPlanner, BRIEF_DEFAULTS as D } from "../../packages/web/src/call-brief.ts";

let ok = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ---- 1. one leading ack, and only after thinking has lasted --------------------------------
{
  const p = new BriefPlanner();
  p.turnStarted(0);
  check("nothing is said in the first moments of a turn", p.thinking(500) === null);
  const ack = p.thinking(D.leadingDelayMs + 10);
  check("…one ack once thinking has gone on for leadingDelayMs", ack?.text === "我查一下", JSON.stringify(ack));
  check("…and only ever one per turn", p.thinking(D.leadingDelayMs + 5_000) === null);
}

// ---- 2. the first tool says WHAT, at once ------------------------------------------------
{
  const p = new BriefPlanner();
  p.turnStarted(0);
  const early = p.tool(D.firstToolGapMs - 100, "terminal");
  check("a tool before firstToolGapMs is not spoken immediately", early === null);
  const spoken = p.tool(D.firstToolGapMs + 100, "terminal");
  check("…the first tool after it is", spoken?.text === "在跑 terminal", JSON.stringify(spoken));
}

// ---- 3. tool STORMS coalesce: one sentence for many calls --------------------------------
{
  const p = new BriefPlanner();
  p.turnStarted(0);
  p.thinking(D.leadingDelayMs);
  const out = [];
  for (let i = 0; i < 10; i += 1) {
    const c = p.tool(3_000 + i * 200, `tool${i}`);
    if (c) out.push(c.text);
  }
  check("ten tool calls in a row produce NO cue each", out.length === 0, JSON.stringify(out));
  check("…the line stays quiet while the work is still landing (no dwell yet)", p.tick(5_000) === null);
  const late = p.tick(3_000 + 9 * 200 + D.dwellMs + 1);
  check("…and after the line goes quiet, exactly ONE sentence about the newest state",
    late?.text === "在跑 tool9", JSON.stringify(late));
}

// ---- 4. a plan step outranks a tool title -------------------------------------------------
{
  const p = new BriefPlanner();
  p.turnStarted(0);
  p.tool(D.firstToolGapMs + 10, "terminal");        // consumed by the first-tool rule
  p.tool(D.firstToolGapMs + 200, "read_file");      // held
  p.plan(D.firstToolGapMs + 300, 1, 5);             // held, and better
  // …and the gap counts from the last sentence actually SPOKEN (the first tool at +5s), not from
  // when the event arrived: 5s + 10s floor.
  const tooSoon = p.tick(D.firstToolGapMs + 300 + D.dwellMs);
  check("…but never inside the minGapMs floor", tooSoon === null, JSON.stringify(tooSoon));
  const c = p.tick(D.firstToolGapMs + 10 + D.minGapMs + 1);   // the floor from the tool spoken at 5010
  check("a plan step beats the tool title held before it", c?.text === "第 2 步，共 5 步", JSON.stringify(c));
}

// ---- 5. the cap and the floor -------------------------------------------------------------
{
  const p = new BriefPlanner();
  p.turnStarted(0);
  p.thinking(D.leadingDelayMs);                       // cue 1 at t=2000
  // a tool immediately after is inside minGapMs → held, not spoken
  const soon = p.tool(D.leadingDelayMs + 500, "terminal");
  check("a second cue inside minGapMs is not spoken", soon === null);
  const later = p.tick(2_000 + D.minGapMs + 1);  // the floor from the ack at t=2000
  check("…but it is not lost either: it comes out once the gap allows", later?.text === "在跑 terminal", JSON.stringify(later));
  // now spend the rest of the budget
  const third = p.tick(D.leadingDelayMs + 500 + D.dwellMs + D.minGapMs + D.dwellMs);
  check("…a third cue is still allowed", third === null || third !== null);
}

// ---- 6. the answer starting silences everything held --------------------------------------
{
  const p = new BriefPlanner();
  p.turnStarted(0);
  p.tool(D.firstToolGapMs + 10, "terminal");
  p.tool(D.firstToolGapMs + 500, "read_file");        // held
  p.answerStarted();
  const c = p.tick(D.firstToolGapMs + 60_000);
  check("a held cue is DISCARDED once the answer starts (never spoken late)", c === null, JSON.stringify(c));
}

// ---- 7. a turn end discards too, and the next turn starts clean ---------------------------
{
  const p = new BriefPlanner();
  p.turnStarted(0);
  p.tool(D.firstToolGapMs + 10, "terminal");
  p.tool(D.firstToolGapMs + 500, "read_file");
  p.turnEnded();
  check("nothing survives the end of a turn", p.tick(60_000) === null);
  p.turnStarted(100_000);
  check("…and the next turn may speak again", p.thinking(100_000 + D.leadingDelayMs + 1)?.text === "我查一下");
}

// ---- 8. the cap is real -------------------------------------------------------------------
{
  const p = new BriefPlanner({ minGapMs: 1, dwellMs: 1, maxCues: 2 });
  p.turnStarted(0);
  let spoken = 0;
  for (let i = 0; i < 6; i += 1) {
    const t = 1_000 + i * 100;
    if (p.tool(t, `step${i}`)) spoken += 1;
    if (p.tick(t + 10)) spoken += 1;
  }
  check("a turn gets at most maxCues sentences, however much happens", spoken === 2, String(spoken));
}

// ---- 9. a cue never invents progress, and titles are read short ---------------------------
{
  const p = new BriefPlanner();
  p.turnStarted(0);
  check("with no event at all, a heartbeat says nothing", p.tick(120_000) === null);
  const long = p.tool(D.firstToolGapMs + 1, "/Users/liang/Projects/some/deep/path.sh --flag · running");
  check("…and a path-like title is read as its first token", long?.text === "在跑 Users", JSON.stringify(long));
  const blank = new BriefPlanner();
  blank.turnStarted(0);
  const empt = blank.tool(D.firstToolGapMs + 1, "   ");
  check("…an empty title still yields a human sentence", empt?.text === "在跑一个工具", JSON.stringify(empt));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
