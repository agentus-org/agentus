// WHICH agent processes belong to THIS data directory.
//
// `reclaimOrphans()` used to ask one question — `process.kill(pid, 0)`, "is this number alive?" — and
// then SIGKILL it. Two ways that ends a session that was perfectly healthy:
//   1. pid reuse: the agent died with the previous server, the number went to something else, and the
//      next boot killed an unrelated process;
//   2. two servers on one data dir (incident 2026-10-22 §7): the second one reclaimed the first one's
//      agents — every minute, forever, because it kept failing to listen and retrying.
//
// A pid is a weak identity, so each spawn now leaves a receipt next to the store:
//   <DATA_DIR>/agents/<pid>.json = { pid, sessionId, dataDir, serverInstance, startedAt, cmd }
// and a reclaim only kills when the receipt proves the process is an agent of this data dir from a
// PREVIOUS server run. No receipt (rows written by older builds) → the argv must still look like an
// ACP agent; otherwise the pid is dropped with a warning instead of being killed.

import fs from "node:fs";
import path from "node:path";
import { commandLineOf, pidAlive } from "../instance-lock.js";

export interface AgentReceipt {
  pid: number;
  sessionId: string;
  dataDir: string;
  /** The server run that spawned it — the same value as the instance lock's `instanceId`. */
  serverInstance: string;
  startedAt: number;
  cmd: string;
}

export interface Verdict {
  /** Nothing to kill: the pid is already gone. Not an error, never worth a warning. */
  gone: boolean;
  /** Safe to SIGKILL: the receipt proves ownership. */
  kill: boolean;
  /** Human-readable reason, logged either way (the operator's next 5-minute diagnosis). */
  why: string;
}

function agentsDir(dataDir: string): string {
  return path.join(dataDir, "agents");
}

function receiptPath(dataDir: string, pid: number): string {
  return path.join(agentsDir(dataDir), `${pid}.json`);
}

/** Best effort: bookkeeping must never fail a session. */
export function recordAgentOwner(dataDir: string | null, receipt: Omit<AgentReceipt, "dataDir"> & { dataDir?: string }): void {
  const dir = dataDir ?? receipt.dataDir;
  if (!dir) return;
  try {
    fs.mkdirSync(agentsDir(dir), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      receiptPath(dir, receipt.pid),
      JSON.stringify({ ...receipt, dataDir: path.resolve(dir) }, null, 2),
      { mode: 0o600 },
    );
  } catch { /* an unreadable receipt only makes reclaim more conservative */ }
}

export function forgetAgentOwner(dataDir: string | null, pid: number | null | undefined): void {
  if (!dataDir || !pid) return;
  try { fs.unlinkSync(receiptPath(dataDir, pid)); } catch { /* already gone */ }
}

function readReceipt(dataDir: string, pid: number): AgentReceipt | null {
  try {
    const j = JSON.parse(fs.readFileSync(receiptPath(dataDir, pid), "utf8")) as Partial<AgentReceipt>;
    if (typeof j.pid !== "number") return null;
    return {
      pid: j.pid,
      sessionId: typeof j.sessionId === "string" ? j.sessionId : "",
      dataDir: typeof j.dataDir === "string" ? j.dataDir : "",
      serverInstance: typeof j.serverInstance === "string" ? j.serverInstance : "",
      startedAt: typeof j.startedAt === "number" ? j.startedAt : 0,
      cmd: typeof j.cmd === "string" ? j.cmd : "",
    };
  } catch {
    return null;
  }
}

/** Does this argv look like a CLI coding agent run over ACP? Fallback for rows without a receipt. */
export function looksLikeAcpAgent(cmd: string | null): boolean {
  if (!cmd) return false;
  if (/mock[\\/]agent\.mjs\b/.test(cmd)) return true;          // the bundled mock backend
  if (/\bqodercli\b/.test(cmd)) return true;
  if (/\bhermes\b/.test(cmd) && /\bacp\b/.test(cmd)) return true;
  if (/\b(claude-code|claude|opencode|codex)\b/.test(cmd) && /\bacp\b/.test(cmd)) return true;
  return false;
}

/**
 * Decide whether `pid` (recorded on session `sessionId`) may be killed by the startup reclaim.
 *
 * `serverInstance` is OUR instance id: a receipt naming it means the process is ours, so it is not an
 * orphan at all (this also makes the call safe to use while running).
 */
export function verifyAgentOwner(
  dataDir: string | null,
  pid: number,
  sessionId: string,
  serverInstance: string,
): Verdict {
  if (!pidAlive(pid)) return { gone: true, kill: false, why: `pid ${pid} already gone` };

  const cmd = commandLineOf(pid);
  if (!cmd) return { gone: true, kill: false, why: `pid ${pid} vanished while checking` };

  if (!dataDir) {
    // No data dir wired in (unit tests, odd embedders): fall back to the argv shape, and say so.
    return looksLikeAcpAgent(cmd)
      ? { gone: false, kill: true, why: `pid ${pid} matches an ACP agent (no data dir to compare)` }
      : { gone: false, kill: false, why: `pid ${pid} is not an ACP agent (${cmd.slice(0, 120)})` };
  }

  const receipt = readReceipt(dataDir, pid);
  if (receipt) {
    if (receipt.dataDir && path.resolve(receipt.dataDir) !== path.resolve(dataDir)) {
      return { gone: false, kill: false, why: `pid ${pid} was spawned by the server of ${receipt.dataDir}` };
    }
    if (receipt.sessionId && receipt.sessionId !== sessionId) {
      return { gone: false, kill: false, why: `pid ${pid} belongs to session ${receipt.sessionId}, not ${sessionId}` };
    }
    if (receipt.serverInstance && receipt.serverInstance === serverInstance) {
      return { gone: false, kill: false, why: `pid ${pid} was spawned by THIS server run` };
    }
    if (!looksLikeAcpAgent(cmd)) {
      // Receipt says ours, argv says something else: the pid was recycled after all. Trust the argv.
      return { gone: false, kill: false, why: `pid ${pid} no longer runs an ACP agent (${cmd.slice(0, 120)})` };
    }
    return { gone: false, kill: true, why: `pid ${pid} = agent of session ${sessionId} from a previous run (receipt)` };
  }

  // Receipt-less row (written before this file existed, or the file was lost). Judge by argv only:
  // a non-agent process must NEVER be killed for a stale database row.
  if (!looksLikeAcpAgent(cmd)) {
    return { gone: false, kill: false, why: `pid ${pid} is not an ACP agent (${cmd.slice(0, 120)})` };
  }
  return { gone: false, kill: true, why: `pid ${pid} matches an ACP agent (no receipt: legacy row)` };
}
