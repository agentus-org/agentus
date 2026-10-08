// The turn's state, decided on its own (no DOM, no server): the head dot AND the tail line.
//
// The turn's state used to be two text lines at the transcript tail; the operator deleted them, the
// quiet half became a breathing dot beside the session title, and then he asked for the tail line
// back as ONE row with the elapsed time counted from the send (see `turn-state.ts`). Both live here:
// the dot's 60-second boundary and the line's duration wording cannot be waited for in a browser
// sweep, so they are asserted with injected stamps, and the browser sweeps only check what got DRAWN.
//
// Run: npm run turn-pulse
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKEND_MARK, markOf } from "../../packages/web/src/agents.ts";
import { durationWords, SILENT_AFTER_MS, turnPulseState } from "../../packages/web/src/turn-state.ts";

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

// ---- the tail line's number: ONE formatter, because both indicators state the same quantity -----
{
  check("0s reads as a duration, not as a raw ms count", durationWords(0) === "0 秒", durationWords(0));
  check("sub-minute durations stay in 秒", durationWords(45_000) === "45 秒", durationWords(45_000));
  check("…rounded, not truncated (999ms is 1 秒)", durationWords(999) === "1 秒", durationWords(999));
  check("a minute is named in 分 秒", durationWords(90_000) === "1 分 30 秒", durationWords(90_000));
  check("exactly 60s still carries the 0 秒", durationWords(60_000) === "1 分 0 秒", durationWords(60_000));
  check("an hour is a duration, not an overflow", durationWords(3_600_000) === "60 分 0 秒", durationWords(3_600_000));
  check("a backwards clock never prints a negative wait", durationWords(-5_000) === "0 秒", durationWords(-5_000));
  check("the head's quiet wording reuses it (one number, one set of words)",
    turnPulseState(T - 90_000, T).said.includes(durationWords(90_000)), turnPulseState(T - 90_000, T).said);
}

// ---- who an agent IS: the table the rail row and the transcript label both draw from -------------
{
  const here = dirname(fileURLToPath(import.meta.url));
  const shipped = (p: string): boolean => existsSync(resolve(here, "../../packages/web/public", p.replace(/^\//, "")));
  const h = markOf("hermes"), q = markOf("qoder"), m = markOf("mock");
  check("hermes carries the artwork AND the word the operator named", h.icon === "/coding-agents/hermes.png" && h.label === "Hermes", `${h.icon} ${h.label}`);
  check("…and the web package actually ships that file", shipped(h.icon ?? ""), h.icon ?? "");
  check("qoder does too", q.icon === "/coding-agents/qoder.svg" && q.label === "Qoder" && shipped(q.icon ?? ""), `${q.icon} ${q.label}`);
  check("an agent with no artwork still gets a word and a monogram", !m.icon && m.label === "Mock" && m.letter === "M", `${m.label}/${m.letter}`);
  check("an unknown backend is never blank (monogram + its own id)", markOf("mystery").letter === "M" && markOf("mystery").label === "mystery", JSON.stringify(markOf("mystery")));
  check("a team session (no backend) yields an empty label — the call site falls back to 旧词 AGENT", markOf("").label === "");
  check("both marks resolve through the ONE table (rail and transcript cannot drift)",
    BACKEND_MARK.hermes === h && BACKEND_MARK.mock === m);
}

console.log(`\n${ok} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
