# Developing Agentus

This is the in-repo manual for working on Agentus: how to run a development instance,
how to prove a change works, how to release it to the live instance, and how to recover
when it breaks.

**What Agentus is.** A multi-session web cockpit for ACP-speaking coding agents
(`hermes acp` / `qodercli --acp`). The server spawns one child process per session and
relays ACP JSON-RPC between the browser and that agent. The UI holds no intelligence:
gate access → spawn → relay → stream → persist → surface permission cards. State lives in
`<DATA_DIR>` (default `~/.agentus`; see [01-dev-loop.md](./01-dev-loop.md) for how the
directory resolves). Node `>= 22.5` is required — the store is `node:sqlite`.

## The mental model

There are **two instances of the same codebase**, distinguished only by environment
variables, and they must never touch each other's code or data:

| | live | dev |
|---|---|---|
| tree | `worktrees/agentus` | `worktrees/agentus-dev` |
| role | the instance the operator actually uses | where changes are made and tested |
| HTTP port | `8788` | `8901` |
| TLS port | `8443` | off (`AGENTUS_TLS_PORT=0`) |
| data dir | `<tree>/packages/server/.data` (pinned by the launcher) | `/tmp/agentus-qa-account` |
| launcher | `~/.hermes/cache/agentus/launch.py` | `scripts/dev.sh start\|stop\|status\|logs` |
| supervision | launchd job `ai.hermes.agentus` (`KeepAlive`) | none — a plain detached process |
| hot reload | **no** — restart is explicit | yes (`tsx watch`) |

**Ports are configuration, not literals.** Both of live's ports live in
`~/.hermes/cache/agentus/ports.env`; `launch.py` pins them into the server's environment, and
`scripts/dev.sh` / `scripts/relaunch.sh` read the same file instead of hardcoding a number. Move
live by editing that one line and restarting it — never by hunting a literal through the launchers,
the scripts and the docs (that is how the port and the TLS port both drifted before).

**Live is supervised by launchd.** It used to be a detached child of whatever shell happened to
start it: nothing brought it back after a crash, and it inherited that shell's entire environment
(usually an agent session's, handing `HERMES_SESSION_ID` and `WEIXIN_TOKEN` down to every ACP child
it spawned). Now:

```bash
launchctl print gui/$(id -u)/ai.hermes.agentus         # state, pid, the job's environment
launchctl kickstart -k gui/$(id -u)/ai.hermes.agentus  # the supported restart (stop then start)
tail -f /tmp/agentus-server.log                        # the job's stdout/stderr
```

`scripts/relaunch.sh --launchd ai.hermes.agentus` is the same thing wrapped with a health check and
a pid-moved assertion, and that is what `promote` uses. Launchd's `KeepAlive` restarts it on any
exit, so a crash self-heals; a **manual** `kill` therefore no longer restarts live, it just makes
launchd respawn it.

**Why two trees.** `tsx watch` reloads the whole server on any server-source edit, and a
reload SIGTERMs every child process — every live `hermes acp` session, including the one
the operator is typing into. Editing server code in the live tree would therefore kill his
conversation mid-turn (measured: page went white mid-turn, the turn died). The live tree
runs **without** a watcher and is only moved by an explicit release
([03-release.md](./03-release.md)). All edits happen in the dev tree.

**The loop you repeat every round:**

```
change (dev tree)  →  verify (sweeps + suites)  →  promote (dev→live)  →  record (track + lessons)
```

Nothing merges to `main` or reaches the live instance without the operator saying so —
the one exception is a strictly web-only change, and even that is bounded by what
`promote` prints (see [03-release.md](./03-release.md)).

## The five documents

| doc | the question it answers |
|---|---|
| [01-dev-loop.md](./01-dev-loop.md) | How do I run a development instance, and how is its data kept separate from live? |
| [02-verify.md](./02-verify.md) | How do I prove a change actually works — unit suites and real-browser sweeps? |
| [03-release.md](./03-release.md) | How do I get a verified change onto the live instance, and how do I roll it back? |
| [04-recover.md](./04-recover.md) | The instance is broken — where do I look, and how do I fix it safely? |
| [05-agent-driven.md](./05-agent-driven.md) | How do I hand a task on this repo to a coding agent, and review what it does? |

## Related in-repo docs

- [`docs/transcript-folding.md`](../transcript-folding.md) — how one reply becomes rows,
  pages and bubbles (the store's row semantics).
- [`docs/android-notify-contract.md`](../android-notify-contract.md) — the server↔phone
  notification contract.
- [`docs/refs/`](../refs/) — notes on the reference UIs and ACP rules this project borrows
  behaviour from.
- [`README.md`](../../README.md) — install, environment variables, login, TLS and the
  public tunnel.
