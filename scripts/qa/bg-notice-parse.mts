// QA: the background-completion notice is PARSED, not pattern-matched on the happy path only.
//
// The format lives in another repo (fork `acp_adapter/background.py` → `_summary_text` → the gateway's
// formatted sentence), so this file pins the parser against the REAL text three wakes delivered on
// live (2026-10-18), plus the shapes that must degrade to plain text rather than a broken card.
//
// Usage: npx tsx scripts/qa/bg-notice-parse.mts
import { delegSummary, parseBgNotice, parseDelegNotice, shortCommand } from "../../packages/web/src/bgNotice.ts";

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


// 7. The DELEGATION wake (delegate_task background=true). Verbatim shape from the batch this
//    cockpit actually received (deleg_82be1dc2, 2026-10-21): a header line, three preamble fields,
//    then one `--- ✓ TASK i/n: <goal> (status=…, …) ---` section per subagent carrying a whole report.
const DELEG = `[ASYNC DELEGATION BATCH COMPLETE — deleg_82be1dc2]
A background fan-out unit you dispatched earlier — 2 subagent(s) — has finished; its consolidated results are below.
Dispatched: 2026-10-21 21:39:50 (3m21s ago)
Role: leaf   Model: ?   Total duration: 201.36s

--- ✓ TASK 1/2: 审查 Agentus 通话模式本轮改动的正确性，找出会引入新 bug 的地方。  (status=completed, api_calls=27, 200.98s) ---
## 阻断

**1. 关键词模式会把自己的回合当成"听到唤醒词"，立刻自我取消** — \`CallMode.tsx:375\`
---
一条孤立的 \`---\` 规则行不得被当成下一个 section

--- ✓ TASK 2/2: 复核设置读写规则  (status=completed, api_calls=19, 98.5s) ---
字段名是对齐的。`;

const d = parseDelegNotice(DELEG);
check(!!d, "a delegation wake parses");
check(d?.id === "deleg_82be1dc2", "batch id", String(d?.id));
check(d?.ago === "3m21s ago", "elapsed time from Dispatched", String(d?.ago));
check(d?.total === "201.36s" && d?.role === "leaf", "role and total duration", `${d?.role}/${d?.total}`);
check(d?.tasks.length === 2, "one section per subagent", String(d?.tasks.length));
check(d?.tasks[0].index === 1 && d?.tasks[0].total === 2, "task numbering");
check(d?.tasks[0].ok === true && d?.tasks[0].status === "completed", "✓ + status=completed reads as ok");
check(d?.tasks[0].meta === "api_calls=27, 200.98s", "meta keeps the rest, drops status", JSON.stringify(d?.tasks[0].meta));
check(d?.tasks[0].goal.startsWith("审查 Agentus 通话模式"), "goal captured whole", d?.tasks[0].goal.slice(0, 20));
check(!!d?.tasks[0].body.includes("关键词模式会把自己的回合") && !!d?.tasks[0].body.includes("---"),
  "body keeps the report, including its own rules", `${d?.tasks[0].body.length} chars`);
check(!d?.tasks[0].body.includes("TASK 2/2"), "a section ends at the next marker");
check(d?.tasks[1].body === "字段名是对齐的。", "the last section's body has no trailing blank lines");

// 8. A failed / interrupted subagent is not a success, and the folded line says so.
const bad2 = parseDelegNotice(`[ASYNC DELEGATION BATCH COMPLETE — deleg_x]
Dispatched: 2026-10-21 10:00:00 (12s ago)
--- ✗ TASK 1/1: do the thing  (status=interrupted, 3.1s) ---
stopped`);
check(bad2?.tasks[0].ok === false && bad2?.tasks[0].status === "interrupted", "✗ is a failure");
const bad3 = parseDelegNotice(`[ASYNC DELEGATION BATCH COMPLETE — deleg_y]
--- TASK 1/1: do the thing  (status=interrupted) ---
stopped`);
check(bad3?.tasks[0].ok === false, "status=interrupted without a marker is still a failure");
check(delegSummary(bad2!).includes("1 个未完成"), "the folded line counts unfinished tasks", delegSummary(bad2!));

// 9. Not a delegation wake → the caller renders the raw text, exactly as before.
check(parseDelegNotice("hello") === null, "plain text is not a delegation wake");
check(parseDelegNotice("[ASYNC DELEGATION BATCH COMPLETE — deleg_z]") === null, "a header with no sections is not one");
check(parseDelegNotice("[IMPORTANT: Background process proc_x completed normally (exit code 0).]") === null,
  "a terminal notice is not a delegation wake");

// 10. The WATCH shape — no exit code at all. Verbatim from the live wake that printed the whole block
//     unfolded (session 3143c27c, proc_a0124b2bc374, 2026-10-21): the agent asked to be woken when a
//     line appeared, not when the process ended, so the header carries a pattern instead of a code.
const WATCH = `[IMPORTANT: Background process proc_a0124b2bc374 matched watch pattern "Application startup complete".
Command: cd ~ && exec /Users/liang/.cache/uv/bin/hindsight-api --idle-timeout 300 --port 9177
Matched output:
INFO:     Application startup complete.]`;
const w = parseBgNotice(WATCH);
check(!!w, "a watch match parses (it used to fall through to raw text and dump the block)");
check(w?.kind === "watch", "reads as a watch match", String(w?.kind));
check(w?.pattern === "Application startup complete", "pattern captured", String(w?.pattern));
check(w?.exitCode === null, "no invented exit code", String(w?.exitCode));
check(w?.ok === true, "a matched pattern is not a failure");
check(w?.output === "INFO:     Application startup complete.", "matched output, carrier bracket dropped", JSON.stringify(w?.output));
check(parseBgNotice(REAL)?.kind === "exit", "an exit notice is still an exit notice");

console.log(fail ? `\n RED — ${pass} passed, ${fail} failed` : `\n GREEN — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
