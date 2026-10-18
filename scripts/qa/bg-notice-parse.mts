// QA: the background-completion notice is PARSED, not pattern-matched on the happy path only.
//
// The format lives in another repo (fork `acp_adapter/background.py` → `_summary_text` → the gateway's
// formatted sentence), so this file pins the parser against the REAL text three wakes delivered on
// live (2026-10-18), plus the shapes that must degrade to plain text rather than a broken card.
//
// Usage: npx tsx scripts/qa/bg-notice-parse.mts
import { parseBgNotice, shortCommand } from "../../packages/web/src/bgNotice.ts";

let pass = 0, fail = 0;
const check = (ok: boolean, what: string, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ""}`); }
};

// 1. Verbatim from the live wake (session 3143c27c, proc_32226b0dffb7). Trailing `]` on its own line,
//    and the shell-startup noise line the capsule printed before the real output.
const REAL = `[IMPORTANT: Background process proc_32226b0dffb7 completed normally (exit code 0).
Command: cd /Users/liang/.hermes/cache/scratch && sleep 45 && echo "观测用任务完成 $(date '+%H:%M:%S')"
Output:
/Users/liang/.openclaw/completions/openclaw.zsh:3829: command not found: compdef
观测用任务完成 14:25:33
]`;

const a = parseBgNotice(REAL);
check(!!a, "a real completion notice parses");
check(a?.id === "proc_32226b0dffb7", "process id", String(a?.id));
check(a?.ok === true, "completed normally reads as ok");
check(a?.exitCode === 0, "exit code 0");
check(a?.command.startsWith("cd /Users/liang/.hermes/cache/scratch"), "command captured whole");
check(a?.output === "/Users/liang/.openclaw/completions/openclaw.zsh:3829: command not found: compdef\n观测用任务完成 14:25:33", "output keeps every line, drops only the carrier's `]`", JSON.stringify(a?.output));

// 2. A failure reads as a failure (the card's left edge turns red).
const bad = parseBgNotice(`[IMPORTANT: Background process proc_x exited with errors (exit code 2).
Command: npm test
Output:
boom
]`);
check(bad?.ok === false && bad?.exitCode === 2, "non-zero exit is a failure", `ok=${bad?.ok} code=${bad?.exitCode}`);

// 3. No `Output:` section at all: still a notice, empty output (not a crash).
const bare = parseBgNotice(`[IMPORTANT: Background process proc_y completed normally (exit code 0).\nCommand: true\n]`);
check(!!bare && bare.output === "" && bare.command === "true", "a notice without output still parses", JSON.stringify(bare));

// 4. A `]` inside real output survives — only the trailing carrier bracket is dropped.
const bracketed = parseBgNotice(`[IMPORTANT: Background process proc_z completed normally (exit code 0).\nCommand: echo "[x]"\nOutput:\n[x]\n]`);
check(bracketed?.output === "[x]", "inner brackets survive", JSON.stringify(bracketed?.output));

// 5. Anything else is NOT a notice → the caller renders the raw text.
check(parseBgNotice("hello") === null, "plain text is not a notice");
check(parseBgNotice("[IMPORTANT: Background process") === null, "a truncated header is not a notice");

// 6. The header line is one line: long commands do not push the exit code off the row.
const long = "cd /very/long/path/" + "x".repeat(200) + " && ./run --with-flag";
const short = shortCommand(long);
check(short.length <= 64 && short.endsWith("…"), "long commands are shortened for the header", `${short.length} chars`);
check(shortCommand("  a   b  ") === "a b", "whitespace collapses");

console.log(fail ? `\n RED — ${pass} passed, ${fail} failed` : `\n GREEN — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
