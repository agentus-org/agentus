// The head's turn dot, decided on its own (no DOM, no server).
//
// The turn's state used to be two text lines at the transcript tail; the operator deleted them and the
// half worth keeping — «this turn has gone QUIET» — became a breathing dot beside the session title.
// Its 60-second boundary cannot be waited for in a browser sweep, so the boundary and the wording are
// asserted here with an injected `now`, and `scripts/qa/turn-pulse-sweep.mjs` only checks that the dot
// actually gets DRAWN (and that the deleted lines are really gone from the transcript).
//
// Run: npm run turn-pulse
import { SILENT_AFTER_MS, turnPulseState } from "../../packages/web/src/turn-state.ts";

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const T = 1_800_000_000_000; // an arbitrary but fixed "now"
const at = (msAgo: number) => turnPulseState(T - msAgo, T);

// ---- a fresh turn: green, and the words say so -----------------------------------------------
{
  const s = at(0);
  check("a turn that just spoke is not quiet", !s.quiet);
  check("…and its words say the agent is working", /正在工作/.test(s.said), s.said);
  check("…with no duration claimed", !/\d+ 秒/.test(s.said), s.said);
}

// ---- the boundary (inclusive, and it is the number the operator will read) ---------------------
{
  check("59s of silence is still 在跑", !at(SILENT_AFTER_MS - 1000).quiet);
  check("exactly 60s flips to 安静", at(SILENT_AFTER_MS).quiet);
  check("the threshold is 60s — a normal tool call must not turn it amber early", SILENT_AFTER_MS === 60_000, String(SILENT_AFTER_MS));
}

// ---- the wording of the quiet state -------------------------------------------------------------
{
  const s = at(90_000);
  check("a quiet turn is marked quiet", s.quiet);
  check("…and names the silence in 分/秒", /1 分 30 秒/.test(s.said), s.said);
  check("…and points at the stop button", /停止/.test(s.said), s.said);
  const under = at(SILENT_AFTER_MS - 1000);
  check("just under the threshold the words are still the working ones (no duration leak)", !under.quiet && /正在工作/.test(under.said), under.said);
  const big = at(3_600_000);
  check("an hour of silence still reads as a duration", /60 分 0 秒/.test(big.said), big.said);
}

// ---- a clock that disagrees with the server must not produce a negative gap ---------------------
{
  const future = turnPulseState(T + 5_000, T);
  check("a last-activity stamp in the future yields gap 0, not a negative wait", future.gapMs === 0, String(future.gapMs));
  check("…and stays in the working state", !future.quiet);
}

console.log(`\n${ok} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
