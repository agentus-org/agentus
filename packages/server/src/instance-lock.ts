// ONE data directory, ONE server.
//
// Why this file exists (incident 2026-10-22, `tasks/20261001-agentus/incident-20261022-orphan-reclaim.md` §7):
// a hand-written promote script started a SECOND server on the live data dir (a different port, so
// `listen` was happy). That instance then ran the startup orphan reclaim — which kills every agent
// pid the database remembers — and executed the agents of the server that was already serving. Every
// 10 s the launchd job retried, failed with EADDRINUSE, and killed the operator's freshly restored
// sessions again: the failure looked like "my sessions die on resume".
//
// So identity is claimed BEFORE anything that can touch another instance's processes:
//   · the claim is an O_EXCL `server.pid` in the data dir (atomic on every filesystem we ship to),
//   · a claim is only honoured while its pid is alive AND still looks like an agentus server,
//   · a dead or foreign holder is replaced (crash/SIGKILL must not brick the data dir),
//   · nothing here kills anything — refusing to start is the whole remedy.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/** The claim lives beside the sqlite store: same dir, same 0700 guarantees. */
export const LOCK_FILE = "server.pid";

export interface LockHolder {
  pid: number;
  port: number | null;
  dataDir: string;
  /** Identifies THIS process run. Agents record it too, so a reclaim can tell "previous run" from
   *  "mine" — see `acp/agent-owner.ts`. */
  instanceId: string;
  startedAt: number;
  entry: string;
}

export interface LockHandle {
  ok: true;
  path: string;
  holder: LockHolder;
  /** Set when the previous holder was gone and we took the directory over. */
  tookOver: LockHolder | null;
  release(): void;
}

export interface LockRefused {
  ok: false;
  holder: LockHolder | null;
  /** One line an operator can act on; `index.ts` prints it verbatim. */
  why: string;
}

/** `ps -o command=` — the argv of a pid, or null when it is gone. */
export function commandLineOf(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const s = out.trim();
    return s || null;
  } catch {
    return null;
  }
}

/** Kernel start time of a pid (ms), or null when it cannot be read. Used only to detect pid REUSE. */
export function startedAtOf(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const t = Date.parse(out); // "Thu Oct 22 23:42:48 2026" under the C locale ps uses
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists, just not ours to signal. Either way it is NOT free to take over silently.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Does this argv look like an agentus server? Deliberately narrow: a pid that is merely alive must
 *  never block a restart because its number was recycled by an unrelated program. Covers the source
 *  entry (`packages/server/src/index.ts`, tsx or node), the built one (`dist/server/index.js`) and a
 *  globally installed package (`…/node_modules/agentus/…`). */
export function looksLikeServer(cmd: string | null): boolean {
  if (!cmd) return false;
  if (!/\b(node|tsx|bun|deno)\b/.test(cmd)) return false;
  return /packages[\\/]server[\\/](src[\\/]index|dist[\\/]index)\.(ts|js|mjs|cjs)\b/.test(cmd)
    || /agentus[\\/](dist[\\/])?server[\\/]index\.(js|mjs|cjs)\b/.test(cmd);
}

/** Synchronous sleep: this runs during module init, before any event loop turn is meaningful. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin: only when Atomics is unavailable */ }
  }
}

function readHolder(lockPath: string): LockHolder | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const j = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof j.pid !== "number" || !Number.isInteger(j.pid)) return null;
    return {
      pid: j.pid,
      port: typeof j.port === "number" ? j.port : null,
      dataDir: typeof j.dataDir === "string" ? j.dataDir : "",
      instanceId: typeof j.instanceId === "string" ? j.instanceId : "",
      startedAt: typeof j.startedAt === "number" ? j.startedAt : 0,
      entry: typeof j.entry === "string" ? j.entry : "",
    };
  } catch {
    return null; // unreadable or truncated: a crashed writer, treat as no claim
  }
}

/** Is the recorded holder still a live agentus server on THIS data dir? */
function judgeHolder(holder: LockHolder, dataDir: string): { alive: boolean; why: string } {
  if (holder.pid === process.pid) return { alive: false, why: `claim names this very pid (${holder.pid})` };
  if (!pidAlive(holder.pid)) return { alive: false, why: `pid ${holder.pid} is gone` };
  const cmd = commandLineOf(holder.pid);
  if (!cmd) return { alive: false, why: `pid ${holder.pid} disappeared while checking` };
  if (!looksLikeServer(cmd)) {
    return { alive: false, why: `pid ${holder.pid} was recycled by another program (${cmd.slice(0, 120)})` };
  }
  if (holder.dataDir && path.resolve(holder.dataDir) !== path.resolve(dataDir)) {
    // The file lives in OUR dir but names another one: copied/hand-edited file. Its pid may well be
    // a healthy server for the OTHER directory — replacing the claim is right, killing is not.
    return { alive: false, why: `claim names data dir ${holder.dataDir}, not ${dataDir}` };
  }
  if (holder.startedAt) {
    const actual = startedAtOf(holder.pid);
    // 1 s of slack: `ps` prints whole seconds. Anything larger means pid reuse, not our process.
    if (actual !== null && Math.abs(actual - holder.startedAt) > 2000) {
      return { alive: false, why: `pid ${holder.pid} start time does not match the claim (reused pid)` };
    }
  }
  return { alive: true, why: `pid ${holder.pid} (port ${holder.port ?? "?"}) is serving this data dir` };
}

export interface AcquireOptions {
  /** Port this instance intends to listen on; recorded for the operator, not used for judging. */
  port?: number | null;
  /** How long to wait for a dying holder to release (a restart hands over within a second; a live
   *  second instance must be refused quickly enough to be useful). */
  waitMs?: number;
}

/**
 * Claim `dataDir`. Returns a handle (already released on process exit) or a refusal with the reason.
 *
 * Callers MUST `process.exit(1)` on a refusal and MUST NOT touch the store, the agents or the port:
 * the whole point is that a second instance leaves the first one's world untouched.
 */
export function acquireInstanceLock(dataDir: string, opts: AcquireOptions = {}): LockHandle | LockRefused {
  const lockPath = path.join(dataDir, LOCK_FILE);
  const me: LockHolder = {
    pid: process.pid,
    port: opts.port ?? null,
    dataDir: path.resolve(dataDir),
    instanceId: randomUUID(),
    startedAt: Date.now(),
    entry: process.argv[1] ?? "",
  };
  const deadline = Date.now() + (opts.waitMs ?? 4000);
  let tookOver: LockHolder | null = null;

  for (;;) {
    try {
      // O_EXCL: the kernel decides who wins, even with two servers starting in the same tick.
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(me, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      const handle: LockHandle = {
        ok: true, path: lockPath, holder: me, tookOver,
        release: () => {
          // Only ever remove OUR claim: a slow instance must not delete the claim of the one that
          // replaced it (that is how two servers end up owning one directory).
          const onDisk = readHolder(lockPath);
          if (!onDisk || onDisk.pid !== me.pid || onDisk.instanceId !== me.instanceId) return;
          try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
        },
      };
      process.once("exit", handle.release);
      return handle;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return { ok: false, holder: null, why: `cannot create ${lockPath}: ${(err as Error).message}` };
      }
    }

    const holder = readHolder(lockPath);
    if (!holder) {
      // A crashed writer left junk (or a zero-byte file). Remove and retry.
      try { fs.unlinkSync(lockPath); } catch { /* raced with another starter: loop decides */ }
      continue;
    }
    const verdict = judgeHolder(holder, dataDir);
    if (verdict.alive) {
      if (Date.now() < deadline) {
        // A restart tears the old process down first; give it a moment instead of failing a
        // `tsx watch` reload or a promote on a scheduling hiccup.
        sleepSync(250);
        continue;
      }
      return { ok: false, holder, why: verdict.why };
    }
    tookOver = holder;
    console.log(`[agentus] instance lock: taking over ${lockPath} — ${verdict.why}`);
    try { fs.unlinkSync(lockPath); } catch { /* someone else cleaned it: the next open decides */ }
  }
}

/** For a diagnostic line: "1m 12s". */
export function humanAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
