// #57's server half: a declared context window reaches the backends that can only hear it as argv.
//
// Qoder sends no `usage_update` and advertises no context option over ACP, so the usage row had
// nothing to show and (because the row was gated on usage) nowhere to type a window either. Its CLI
// does take `--context-window <n>`, and its own log line says that flag beats the window restored
// from a resumed session — so a declaration is applied at the next spawn. These cases pin the arg
// composition: qoder only, never twice, and never for a backend whose knob is the ACP route.
//
// Run: npm run context-window
import { applyContextWindow } from "../../packages/server/src/acp/backends.js";

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const qoder = { kind: "qoder" } as const;
const hermes = { kind: "hermes" } as const;
const base = ["--acp"];

{
  const out = applyContextWindow("qoder", qoder, base, 200_000);
  check("qoder: the declared window becomes argv", out.join(" ") === "--acp --context-window 200000", out.join(" "));
  check("…and the caller's array is not mutated", base.join(" ") === "--acp", base.join(" "));
}

check("no declaration: argv untouched", applyContextWindow("qoder", qoder, base, null).join(" ") === "--acp");
check("zero/negative is not a declaration", applyContextWindow("qoder", qoder, base, -5).join(" ") === "--acp");
check("a fractional number is rounded to an integer token count",
  applyContextWindow("qoder", qoder, base, 199_999.6).join(" ") === "--acp --context-window 200000");

check("an arg the operator already wrote is not duplicated",
  applyContextWindow("qoder", qoder, ["--acp", "--context-window", "32000"], 200_000).join(" ")
  === "--acp --context-window 32000");
check("…nor is the --context-window=<n> spelling",
  applyContextWindow("qoder", qoder, ["--acp", "--context-window=32000"], 200_000).join(" ")
  === "--acp --context-window=32000");

// Hermes has a real knob (`context_budget` over ACP): touching its argv would be a second truth
// source for the same number, which is exactly the class of bug #57 is about.
check("hermes: argv untouched (its window is an ACP option)", applyContextWindow("hermes", hermes, ["acp"], 123_456).join(" ") === "acp");
check("mock: argv untouched", applyContextWindow("mock", { kind: "mock" }, ["x"], 123_456).join(" ") === "x");
check("an unknown backend kind is left alone", applyContextWindow("custom", {}, ["--acp"], 123_456).join(" ") === "--acp");

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
