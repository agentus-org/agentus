// The cockpit identity as a FILE the agent's tool process can find (issue #106).
//
// WHY A FILE EXISTS AT ALL — `#cockpitEnv()` hands the three variables to the CHILD we spawn, and
// that is the only delivery it has ever had. On a gateway-owned runtime (Hermes 0.23+) that child is
// a VIEWER: the turn runs inside one resident gateway that serves every session, so a PROCESS-level
// environment cannot carry a per-session secret, and the tool subprocess the agent actually shells
// out of inherits the GATEWAY's env, not ours. Measured on the live box 2026-11-13: 11 `hermes acp`
// children each carried `AGENTUS_COCKPIT_SESSION`; 0 of the gateway's tool subprocesses carried any
// of the four variables. The token was not wrong, it just could not reach the place it is used.
//
// WHAT DOES SURVIVE — the one thing that is per-session on the far side: the agent's own session id.
// Every tool process the gateway spawns is stamped with it (measured: `HERMES_SESSION_CHAT_ID` is
// byte-identical to our `acp_session_id`), so a file NAMED by that id is reachable from inside the
// turn using nothing but what the runtime already says about itself. `bin/cli.mjs` reads it when the
// environment is missing the three variables (`resolveIdentityFile()`), and the CLI keeps it clearly
// apart from the operator credential: what comes out of this file is a SESSION identity, so
// `delete`/`archive` stay closed (#73, #106).
//
// WHAT IT IS NOT — never a wider credential than the env it replaces. Same per-session token, same
// 0600-in-0700 shape, and the token itself is only worth something while that slot is LIVE: the
// server authenticates it against its in-memory map (`cockpitCaller`), so a file left behind by a
// dead process answers 401 and is swept anyway. Written only for `gatewayOwned` slots — for an
// in-process backend the environment still works, and writing a file nobody needs would be a second
// copy of a secret to keep clean.
import fs from "node:fs";
import path from "node:path";

/** Where the rendezvous lives: `<HOME>/.agentus/cockpit/`.
 *
 *  Deliberately NOT the data dir. The reader is a CLI process that started with no cockpit variables
 *  at all, so the only paths it can derive are the ones its own shell environment gives it — HOME is
 *  one of them, `AGENTUS_DATA` is not. Session ids are globally unique, so several instances (live, a
 *  dev tree, a QA instance in /tmp) share the directory without ever colliding on a name. */
export function identityDir(): string {
  return path.join(process.env.HOME || "", ".agentus", "cockpit");
}

/** The endpoint agents are told to call — one spelling, shared with `#cockpitEnv()`. */
export function cockpitEndpoint(): string {
  return `http://127.0.0.1:${process.env.AGENTUS_PORT ?? 8788}`;
}

export interface IdentityFile {
  endpoint: string;
  token: string;
  /** the cockpit's own session id — what the CLI reports as `self` */
  session: string;
  /** the CLI to run; also handed over as `AGENTUS_COCKPIT_BIN` for runtimes that keep the env */
  bin: string;
  /** the agent-side session id this file is named by (the lookup key) */
  agentSessionId: string;
  at: number;
}

/** Publish (or refresh) the identity for one live slot. Best effort: a read-only or full HOME must
 *  never fail a session — the agent then simply has no cockpit channel, exactly as before #106. */
export function publishIdentity(file: IdentityFile): void {
  try {
    const dir = identityDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${file.agentSessionId}.json`);
    // Write-then-rename: the reader can be running this very millisecond (the agent's first tool call
    // after a resume), and half a JSON document reads as "no identity" instead of "not ready yet".
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    console.warn(`[agentus] could not publish the cockpit identity file: ${(err as Error).message}`);
  }
}

/** The slot is gone (closed / archived / reaped): its token died with it, so the file must go too
 *  rather than sit in the operator's home advertising an identity that answers 401. */
export function unpublishIdentity(agentSessionId: string | null | undefined): void {
  if (!agentSessionId) return;
  try {
    fs.rmSync(path.join(identityDir(), `${agentSessionId}.json`), { force: true });
  } catch { /* nothing to remove, or a HOME we cannot write: both are fine */ }
}

/** Boot-time sweep for files no live slot can own.
 *
 *  A token is only valid while its slot is in the server's in-memory map, so every file that predates
 *  this process is already worthless — they are litter, not credentials. A generous age (a week)
 *  keeps this from ever racing a second instance that is publishing right now. */
export function sweepStaleIdentities(maxAgeMs = 7 * 24 * 3600_000): void {
  try {
    const dir = identityDir();
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json") && !name.endsWith(".tmp")) continue;
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { force: true });
      } catch { /* a file that vanished under us is the goal, not a failure */ }
    }
  } catch { /* no directory: nothing to sweep */ }
}
