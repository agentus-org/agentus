// The plan MCP token must survive a resume: the gateway freezes the MCP server list (env included)
// into the session policy at create time. A token minted afresh on every load changes that fingerprint,
// forces an idle-only MCP rebind during `session/load`, and — when a foreign turn still holds the lease —
// the rebind answers `session_busy`, so the slot cannot be adopted and "stop and take over" never works.
//
// Run: npx tsx scripts/qa/plan-token-stability.mts
import { planTokenFor } from "../../packages/server/src/auth.ts";
import { isFrozenMcpConflict, resumeMcpServers } from "../../packages/server/src/acp/session-manager.ts";

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const a = planTokenFor("abc12345");
const b = planTokenFor("abc12345");
const c = planTokenFor("def67890");

check("the same session gets the same plan token on every resume", a === b, `${a} vs ${b}`);
check("a different session gets a different token", a !== c, `${a} vs ${c}`);
check("the token is not the bare session id", a !== "abc12345", a);
check("the busy-slot fallback keeps the frozen MCP list (empty selection)",
  Array.isArray(resumeMcpServers()) && resumeMcpServers().length === 0,
  JSON.stringify(resumeMcpServers()));
check("only a frozen-policy conflict triggers that fallback",
  isFrozenMcpConflict(new Error("session_busy")) && !isFrozenMcpConflict(new Error("context_missing")),
  JSON.stringify([isFrozenMcpConflict(new Error("session_busy")), isFrozenMcpConflict(new Error("context_missing"))]));

console.log(`${ok} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
