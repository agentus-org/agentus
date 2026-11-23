// QA: per-session `todo` disable rides the ACP handshake to Hermes (cockpit disables todo_list).
//
//   node scripts/qa/cockpit-disable-todo-sweep.mjs
//
// The cockpit shows ONE plan — its own `update_plan` card. Hermes' built-in `todo_list` (the `todo`
// toolset) is invisible on that card, so a cockpit Hermes session must ask the fork to disable it.
// The channel is ACP handshake `_meta.hermesStudio.disabled_toolsets=["todo"]`, expanded by the fork into
// a per-session editor and frozen into the session policy (CLI/cron/Studio never send it). This
// sweep guards the wire side: every Hermes handshake carries the meta, non-Hermes carries none.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(path.join(root, "packages/server/src/acp/session-manager.ts"), "utf8");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// The helper exists, is Hermes-only, and asks for exactly the `todo` toolset.
check("handshake meta helper exists", /#handshakeMeta\s*\(/.test(src));
check("meta is gated on Hermes backend", /spec\.kind\s*!==\s*"hermes"\s*\)\s*return undefined/.test(src));
check("meta disables only the todo toolset", /disabled_toolsets:\s*\["todo"\]/.test(src));
check("meta is nested under hermesStudio", /hermesStudio:\s*\{\s*disabled_toolsets/.test(src));
check("legacy agentus key still sent for old gateways", /agentus:\s*\{\s*disabled_toolsets/.test(src));

// All three Hermes handshakes (new / load / resume-fresh) actually spread the meta onto the wire.
const metaSpreads = (src.match(/\.\.\.\(\w*Meta \? \{ _meta: \w*Meta \} : \{\}\)/g) || []).length;
check("three handshakes carry _meta", metaSpreads === 3, `found ${metaSpreads}`);
for (const [name, re] of [
  ["newSession", /conn\.newSession\(\{ cwd,[^\n]*_meta: newMeta/],
  ["loadSession", /conn\.loadSession\(\{[\s\S]{0,160}?_meta: loadMeta/],
  ["resume/fork-fresh", /conn\.newSession\(\{ cwd: resumeCwd,[^\n]*_meta: resumeMeta/],
]) check(`${name} carries _meta`, re.test(src));

// The no-injection contract must remain: #planReminder() is kept for rollback but never CALLED
// (only its definition + the comment mentioning it), so no plan resource block reaches the wire.
const planReminderRefs = (src.match(/#planReminder\s*\(/g) || []).length;
check("plan reminder stays unwired (definition + comment only)", planReminderRefs === 2, `found ${planReminderRefs}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
