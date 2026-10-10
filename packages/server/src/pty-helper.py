#!/usr/bin/env python3
"""Run one command on a REAL pseudo-terminal and shovel bytes between it and stdio.

This is the whole trick behind a web terminal (ttyd does the same thing in C): `forkpty` gives the
child a controlling terminal, so the shell believes a human is at the keyboard — line editing,
prompts, colours, job control, full-screen programs (vim, top) all work. Without it (pipe stdio)
the shell is in non-interactive mode: no prompt on screen, no echo, no cursor, SIGWINCH meaningless,
and any terminal emulator in front of it is a lie.

Why a Python helper instead of node-pty: node-pty is a build-time native module and this project
stays dependency-free on install. Python 3 is present on macOS and essentially every Linux; its
stdlib already has forkpty + termios, which is all a PTY needs. If python3 is missing the server
falls back to pipes and says so in the panel.

Wire format, all raw bytes:
    stdin  (fd 0)  -> keystrokes from the browser, written straight to the PTY master
    stdout (fd 1)  <- everything the PTY produces, written straight out (no filtering, no ANSI
                      stripping: a terminal emulator consumes the escape sequences, a <pre> cannot)
    fd 3           <- control channel, one command per line: "resize <cols> <rows>"

**Never block on stdout.** stdout is a pipe into the server, and the server stops reading it on
purpose when a consumer falls behind (see the flow-control notes in term.ts / index.ts: the brake is
applied by pausing this process's stdout). A blocking `write(1)` would stop this loop dead — and this
loop is also what forwards the keyboard, so a slow page would take Ctrl-C down with it and the
operator would have nothing left to abort the flood with. So stdout is NON-BLOCKING, output
accumulates in a local buffer, and reading the PTY is suspended while that buffer is at its cap: the
backpressure travels back to the producing program instead of parking in here. The input path is
never gated by output.

Sizing: the initial size comes from AGENTUS_PTY_COLS / AGENTUS_PTY_ROWS, and `resize` applies
TIOCSWINSZ to the master — the kernel then signals the child's foreground process group (SIGWINCH),
which is what makes vim redraw at the new width.

Exit: when the child exits we exit with its status; when stdin hits EOF (the socket closed) or we
are signalled, we kill the child's process group first so no shell is orphaned.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

CTL_FD = 3
READ_CHUNK = 65536
# Stop reading the PTY once this much output is waiting to go out: the producing program then blocks
# in its own write(2), which is the backpressure we want and what keeps this buffer bounded.
OUT_CAP = 1 << 20


def set_winsize(fd: int, cols: int, rows: int) -> None:
    cols = max(1, min(cols, 1000))
    rows = max(1, min(rows, 1000))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main() -> int:
    argv = sys.argv[1:] or [os.environ.get("SHELL") or "/bin/sh"]
    try:
        cols = int(os.environ.get("AGENTUS_PTY_COLS") or 80)
        rows = int(os.environ.get("AGENTUS_PTY_ROWS") or 24)
    except ValueError:
        cols, rows = 80, 24

    pid, master = pty.fork()
    if pid == 0:  # child: this IS the shell now
        os.environ["TERM"] = os.environ.get("TERM") or "xterm-256color"
        try:
            os.execvp(argv[0], argv)
        except Exception as exc:  # noqa: BLE001 - report it on the terminal rather than dying mute
            os.write(2, f"cannot start {argv[0]}: {exc}\r\n".encode())
            os._exit(127)

    set_winsize(master, cols, rows)

    ctl = None
    try:
        ctl = os.fdopen(CTL_FD, "r", buffering=1)
    except OSError:
        ctl = None  # no control channel: a fixed-size terminal is still a terminal

    stdin_fd = 0
    # Non-blocking stdout: the server stops reading it on purpose (flow control), and blocking here
    # would freeze the input path with it.
    try:
        os.set_blocking(1, False)
    except (OSError, AttributeError):
        pass  # no os.set_blocking: the writes below fall back to blocking behaviour
    pending = bytearray()
    stdin_open = True
    while True:
        # While we are behind on output we stop reading the PTY — that IS the backpressure. stdin and
        # the control channel stay watched, so a keystroke (Ctrl-C above all) is never stuck behind
        # a flood.
        readable = [stdin_fd] if stdin_open else []
        if ctl is not None:
            readable.append(CTL_FD)
        if len(pending) < OUT_CAP:
            readable.append(master)
        writable = [1] if pending else []
        try:
            ready_r, ready_w, _ = select.select(readable, writable, [])
        except OSError as exc:
            if exc.errno == errno.EINTR:
                continue
            break

        if ready_w and pending:
            try:
                written = os.write(1, pending)
                del pending[:written]
            except (BlockingIOError, InterruptedError):
                pass
            except OSError:
                break  # stdout is gone: the server died, so are we

        if master in ready_r:
            try:
                data = os.read(master, READ_CHUNK)
            except (BlockingIOError, InterruptedError):
                data = None
            except OSError:
                data = b""
            if data == b"":
                break  # the child closed the pty: it is gone
            if data:
                pending += data

        if stdin_open and stdin_fd in ready_r:
            try:
                data = os.read(stdin_fd, READ_CHUNK)
            except (BlockingIOError, InterruptedError):
                data = None
            except OSError:
                data = b""
            if data == b"":
                # EOF: the browser went away. Let the child finish its exit path rather than
                # dropping output we still owe the scrollback.
                stdin_open = False
                if ctl is None:
                    break
            elif data:
                try:
                    os.write(master, data)
                except OSError:
                    break

        if ctl is not None and CTL_FD in ready_r:
            line = ctl.readline()
            if line == "":
                ctl.close()
                ctl = None
                continue
            parts = line.split()
            if parts and parts[0] == "resize" and len(parts) == 3 and parts[1].isdigit() and parts[2].isdigit():
                set_winsize(master, int(parts[1]), int(parts[2]))

    # Best effort: hand over whatever is left, but never hang on it.
    try:
        while pending:
            written = os.write(1, pending)
            del pending[:written]
    except OSError:
        pass

    # Reap the child, then leave with its status so the server can report a real exit code.
    status = 0
    try:
        _, raw = os.waitpid(pid, 0)
        status = os.waitstatus_to_exitcode(raw) if hasattr(os, "waitstatus_to_exitcode") else 0
    except ChildProcessError:
        pass
    except KeyboardInterrupt:
        pass
    return 0 if status is None else status


def _terminate(_signum, _frame):  # noqa: ANN001 - signal handler
    # The server kills our process group; this is the polite path when only we are signalled.
    try:
        os.kill(0, signal.SIGKILL)
    except OSError:
        pass
    raise SystemExit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _terminate)
    signal.signal(signal.SIGHUP, _terminate)
    sys.exit(main())
