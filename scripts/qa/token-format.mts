// Token counts, formatted the way every other number on the surface is.
//
// The bug this pins (operator: 「现在 512k 选择完，显示的是 524k，是不是换算有问题」): the two
// context gauges divided by 1000, so the picker's own 512K preset (524288) rendered as "524k" —
// the same window wearing two names, and the picker chip right next to it saying 512K.
//
// Run: npx tsx scripts/qa/token-format.mts
import { fmtTokens } from "../../packages/web/src/tokens.ts";

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---- the presets the picker actually offers, each under its own label --------------------------
// These are the four values from the agent's `context_budget` option (packages/server/mock/agent.mjs
// and the Hermes adapter advertise the same ladder): 256K / 512K / 768K / 1M.
const PRESETS: [number, string][] = [
  [262144, "256k"],
  [524288, "512k"],
  [786432, "768k"],
  [1048576, "1m"],
];
for (const [n, want] of PRESETS) {
  check(`${n} renders as ${want}`, fmtTokens(n) === want, `got ${fmtTokens(n)}`);
}

// ---- the counterexample, stated as an assertion ------------------------------------------------
// This is the pre-fix arithmetic. Kept visible so a future "simplify" back to 1000 fails loudly
// instead of silently (it is exactly the shape the operator reported).
{
  const old = (n: number) => `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  check("the old ÷1000 formatter really did print 524k for the 512K preset",
    old(524288) === "524k", `got ${old(524288)}`);
  check("…and the new one does not", fmtTokens(524288) !== "524k");
}

// ---- small and mid values stay readable --------------------------------------------------------
check("0 is 0", fmtTokens(0) === "0");
check("999 stays a plain count", fmtTokens(999) === "999");
check("1024 is 1k", fmtTokens(1024) === "1k");
check("1234 keeps one decimal", fmtTokens(1234) === "1.2k");
check("a hand-typed 200000 reads 195.3k (not 200k)", fmtTokens(200000) === "195.3k");
check("2M folds into m", fmtTokens(2 * 1048576) === "2m");
check("negative / NaN never render a negative count",
  fmtTokens(-5) === "0" && fmtTokens(Number.NaN) === "0");

console.log(`\n${ok} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
