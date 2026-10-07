// A real (PTY-backed) shell for the workspace panel's Terminal tab.
//
// Design notes, since this is the one place the cockpit forks a process that is
// not an agent:
//
//  * **No native dependency, and honest about what that costs.** node-pty is a
//    build-time native module; this project is deliberately dependency-light, so
//    the default shell is `$SHELL -i` over ordinary pipes. That runs commands,
//    streams output, keeps the prompt and `cd` — everything a cockpit panel is
//    used for — but it is *not* a tty: no job control, no colour, and full-screen
//    programs (vim, top) will refuse to start. Two ways out, both opt-in:
//    AGENTUS_TERM_PTY=1 wraps the shell in Python's stdlib `pty.spawn` for a
//    real terminal, and AGENTUS_TERM_CMD overrides the whole command line.
//  * **One shell per panel, killed with the socket.** The child lives in the
//    server's own group and is killed on disconnect, on `term-close`, and in the
//    process-exit safety net (see installSafetyNet) — an abandoned shell is
//    exactly the orphan class AC5 exists to prevent.
//  * **The workspace is the fence.** The shell starts in the slot's workspace,
//    because that is the directory the operator pointed this slot at. It is not
//    a sandbox and does not pretend to be: the person running the cockpit already
//    owns the machine (same trust model as the agent processes).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";

export interface TermSession {
  id: string;
  cwd: string;
  pid: number | null;
  /** bytes of output kept for a late joiner / a reconnect */
  buffer: string;
  child: ChildProcessWithoutNullStreams;
  subscribers: Set<(chunk: string) => void>;
  exited: { code: number | null; signal: string | null } | null;
}

const MAX_BUFFER = 256 * 1024;

/** How to start the shell. Default: pipes (no native deps). PTY on request. */
function shellCommand(shell: string): { cmd: string; args: string[] } {
  const override = (process.env.AGENTUS_TERM_CMD || "").trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { cmd: parts[0], args: parts.slice(1) };
  }
  if (process.env.AGENTUS_TERM_PTY === "1") {
    // python3's stdlib pty module is the one pty allocation available without a
    // native build step. Missing python3 fails loudly in the panel (the child
    // prints the interpreter error into the terminal), which is better than
    // silently degrading to a pipe shell that claims to be a tty.
    return {
      cmd: "python3",
      args: ["-u", "-c", `import pty,sys; pty.spawn(${JSON.stringify([shell, "-i"])})`],
    };
  }
  return { cmd: shell, args: ["-i"] };
}

function pickShell(): string {
  const candidate = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : null;
  if (candidate) return candidate;
  for (const s of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (fs.existsSync(s)) return s;
  }
  return "/bin/sh";
}

export class TermService {
  #sessions = new Map<string, TermSession>();

  start(cwd: string): TermSession {
    const shell = pickShell();
    const { cmd, args } = shellCommand(shell);
    const child = spawn(cmd, args, {
      cwd: fs.existsSync(cwd) ? cwd : homedir(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        PYTHONUNBUFFERED: "1",
        // Let the shell know a machine is driving, so prompts stay plain.
        AGENTUS_TERMINAL: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      // own process group: `script` wraps the shell, so only a group kill reliably
      // takes both down (see kill()).
      detached: true,
    }) as ChildProcessWithoutNullStreams;

    const session: TermSession = {
      id: randomUUID(),
      cwd,
      pid: child.pid ?? null,
      buffer: "",
      child,
      subscribers: new Set(),
      exited: null,
    };
    const push = (chunk: string): void => {
      session.buffer = (session.buffer + chunk).slice(-MAX_BUFFER);
      for (const fn of session.subscribers) {
        try {
          fn(chunk);
        } catch {
          /* a dead socket must not break the other listeners */
        }
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // stderr is part of the terminal picture (a missing command prints there)
    child.stdout.on("data", (d: string) => push(d));
    child.stderr.on("data", (d: string) => push(d));
    child.on("exit", (code, signal) => {
      session.exited = { code, signal };
      push(`\r\n[process exited${code != null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}]\r\n`);
      this.#sessions.delete(session.id);
    });
    child.on("error", (err) => push(`\r\n[cannot start shell: ${err.message}]\r\n`));
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): TermSession | undefined {
    return this.#sessions.get(id);
  }

  list(): { id: string; cwd: string; pid: number | null; alive: boolean }[] {
    return [...this.#sessions.values()].map((s) => ({
      id: s.id, cwd: s.cwd, pid: s.pid, alive: s.exited === null,
    }));
  }

  kill(id: string): boolean {
    const s = this.#sessions.get(id);
    if (!s) return false;
    // The wrapper is `script`; killing the group takes the shell with it.
    try {
      if (s.child.pid) process.kill(-s.child.pid, "SIGKILL");
    } catch {
      /* no own process group: fall through to the direct kill */
    }
    try {
      s.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    this.#sessions.delete(id);
    return true;
  }

  /** Used by the process-exit safety net and on shutdown: no shells outlive us. */
  killAll(): number {
    const ids = [...this.#sessions.keys()];
    for (const id of ids) this.kill(id);
    return ids.length;
  }
}

export const terms = new TermService();
