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
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export interface TermSession {
  id: string;
  cwd: string;
  pid: number | null;
  /** bytes of output kept for a late joiner / a reconnect */
  buffer: string;
  child: ChildProcess;
  subscribers: Set<(chunk: string) => void>;
  exited: { code: number | null; signal: string | null } | null;
  /** true when the child has a real tty (see shellCommand). The panel says which it got, because
   *  a pipe shell and a tty look nothing alike and the operator should not have to guess. */
  tty: boolean;
  /** Resize the tty (no-op on a pipe shell). The kernel then SIGWINCHes the child's foreground
   *  process group, which is what makes a full-screen program redraw at the new width. */
  resize: (cols: number, rows: number) => void;
  /** Stop draining the child's output. The backpressure chain is: this pause -> we stop reading
   *  the child's stdout -> the pty helper blocks in its own write(1) -> it stops reading the pty
   *  master -> the shell/program blocks in write(2). That is the ONLY honest way to slow a fast
   *  producer (xterm's own guidance: without it the emulator grows a write buffer until it is
   *  unresponsive — see the flow-control note in ToolPanel's TerminalTab). */
  pause: () => void;
  resume: () => void;
}

const MAX_BUFFER = 256 * 1024;
/** How long output is held to be coalesced, and the size that makes holding it pointless. */
const FLUSH_MS = 8;
const FLUSH_BYTES = 64 * 1024;

/** The PTY helper that ships with the server. */
function ptyHelperPath(): string | null {
  for (const rel of ["./pty-helper.py", "../src/pty-helper.py"]) {
    try {
      const p = fileURLToPath(new URL(rel, import.meta.url));
      if (fs.existsSync(p)) return p;
    } catch {
      /* not this layout */
    }
  }
  return null;
}

/** How to start the shell.
 *
 *  Default is a REAL pty via `pty-helper.py` (python3 stdlib `forkpty`): the shell gets a controlling
 *  terminal, so prompts, echo, colours, job control and full-screen programs behave. That is the
 *  whole point of the panel — a terminal emulator in front of a pipe shell is a lie (no prompt lands
 *  on screen, keystrokes are never echoed, resize means nothing).
 *
 *  Escapes: `AGENTUS_TERM_CMD` runs an arbitrary command line instead (pipes), `AGENTUS_TERM_PTY=0`
 *  forces the old pipe shell, and a machine without python3 degrades to it automatically. Whoever
 *  gets a pipe shell is told so in the panel rather than being shown a fake terminal. */
function shellCommand(shell: string): { cmd: string; args: string[]; tty: boolean } {
  const override = (process.env.AGENTUS_TERM_CMD || "").trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { cmd: parts[0], args: parts.slice(1), tty: false };
  }
  if (process.env.AGENTUS_TERM_PTY !== "0") {
    const helper = ptyHelperPath();
    if (helper) return { cmd: "python3", args: [helper, shell, "-i"], tty: true };
  }
  return { cmd: shell, args: ["-i"], tty: false };
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

  start(cwd: string, size?: { cols: number; rows: number }): TermSession {
    const shell = pickShell();
    const { cmd, args, tty } = shellCommand(shell);
    const cols = Math.max(20, Math.min(size?.cols ?? 80, 1000));
    const rows = Math.max(5, Math.min(size?.rows ?? 24, 1000));
    const child = spawn(cmd, args, {
      cwd: fs.existsSync(cwd) ? cwd : homedir(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        PYTHONUNBUFFERED: "1",
        // Let the shell know a machine is driving, so prompts stay plain.
        AGENTUS_TERMINAL: "1",
        // The pty is sized at start because the shell reads its size when it draws the first
        // prompt — resizing afterwards still works, but a 80x24 flash on every open is not free.
        AGENTUS_PTY_COLS: String(cols),
        AGENTUS_PTY_ROWS: String(rows),
      },
      // fd 3 is the PTY helper's control channel (resize). A pipe shell has no use for it.
      stdio: tty ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      // own process group: the shell (or the pty helper wrapping it) is killed as a group, never
      // one process at a time (see kill()).
      detached: true,
    }) as ChildProcess;

    const ctl = tty ? ((child.stdio[3] ?? null) as NodeJS.WritableStream | null) : null;
    const session: TermSession = {
      id: randomUUID(),
      cwd,
      pid: child.pid ?? null,
      buffer: "",
      child,
      subscribers: new Set(),
      exited: null,
      tty,
      resize: (c: number, r: number): void => {
        if (!ctl) return;
        try {
          ctl.write(`resize ${Math.max(1, Math.min(c, 1000))} ${Math.max(1, Math.min(r, 1000))}\n`);
        } catch {
          /* the helper is gone; the exit event says so */
        }
      },
      pause: (): void => {
        child.stdout?.pause();
        child.stderr?.pause();
      },
      resume: (): void => {
        child.stdout?.resume();
        child.stderr?.resume();
      },
    };
    // ---- output framing --------------------------------------------------------
    // One `data` event per write(2) is what a pty hands us, and a full-screen program repainting
    // (or `yes`) emits hundreds of them per second. Every one used to become its own WebSocket
    // frame, and the browser then spends more time in message callbacks than in the emulator
    // (upstream measured ~70% of the main thread: ttyd#247). Subscribers therefore get COALESCED
    // frames — whatever lands inside one ~FLUSH_MS window ships as a single message.
    //
    // The scrollback buffer is deliberately NOT batched: a late joiner or a reconnect has to see
    // every byte, and appending to a string costs nothing per frame.
    let pending = "";
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pending) return;
      const chunk = pending;
      pending = "";
      for (const fn of session.subscribers) {
        try {
          fn(chunk);
        } catch {
          /* a dead socket must not break the other listeners */
        }
      }
    };
    const push = (chunk: string): void => {
      session.buffer = (session.buffer + chunk).slice(-MAX_BUFFER);
      pending += chunk;
      // Past this size, holding it any longer only delays a redraw.
      if (pending.length >= FLUSH_BYTES) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // stderr is part of the terminal picture (a missing command prints there). With a pty both
    // streams are already merged into the pty master, so only stdout carries them — harmless.
    child.stdout?.on("data", (d: string) => push(d));
    child.stderr?.on("data", (d: string) => push(d));
    child.on("exit", (code: number | null, signal: string | null) => {
      session.exited = { code, signal };
      push(`\r\n[process exited${code != null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}]\r\n`);
      // The exit line must not wait out the coalescing window — nothing follows it.
      flush();
      this.#sessions.delete(session.id);
    });
    child.on("error", (err: Error) => push(`\r\n[cannot start shell: ${err.message}]\r\n`));
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
