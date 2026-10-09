# Running a development instance

This doc answers: how do I start a dev instance of Agentus, and how is its code and data
kept away from the live one?

## The two-worktree model

Agentus is developed in **two git worktrees of the same repository**, running as two
instances:

| | live | dev |
|---|---|---|
| path | `worktrees/agentus` | `worktrees/agentus-dev` |
| HTTP port | `8787` | `8901` |
| TLS port | `8443` | disabled (`AGENTUS_TLS_PORT=0`) |
| data dir | `<tree>/packages/server/.data` | `/tmp/agentus-qa-account` |
| started by | `~/.hermes/cache/agentus/launch.py` | `bash scripts/dev.sh start` |
| watcher | no (one process, no reload) | yes (`tsx watch`) |

The live tree serves the operator's real sessions. The dev tree is where you edit; its
`tsx watch` reloads on save, which is convenient precisely because its sessions are
disposable. **Never edit the live tree while the operator is using it** — a reload there
kills his agent children (see [03-release.md](./03-release.md) for the release path and
[04-recover.md](./04-recover.md) for what to do if it happened).

First move of any round: check where you are.

```bash
git -C worktrees/agentus      branch --show-current && git -C worktrees/agentus      status --short
git -C worktrees/agentus-dev  branch --show-current && git -C worktrees/agentus-dev  status --short
```

Edit whatever the **dev** tree has checked out. Use absolute paths when writing files —
the two trees have identical filenames, so nothing reminds you if you picked the wrong one.

## The dev launcher: `scripts/dev.sh`

Run from the dev worktree root:

```bash
bash scripts/dev.sh start     # start :8901, wait for /healthz, re-point the mock backend row
bash scripts/dev.sh status    # is :8901 up? prints the pid, the tree, and /healthz
bash scripts/dev.sh logs      # follow the dev log (tail -f /tmp/agentus-dev.log)
bash scripts/dev.sh stop      # stop the process group on :8901
bash scripts/dev.sh promote [<slug>]       # release to live — see 03-release.md
bash scripts/dev.sh promote-log            # follow /tmp/agentus-qa-account/promote.log
```

`start` prints where everything went:

```
[dev] pid=<n> port=8901 data=/tmp/agentus-qa-account log=/tmp/agentus-dev.log
[dev] http://127.0.0.1:8901  login scratch / scratch-pass-1
```

Defaults are overridable by `DEV_PORT`, `DEV_DATA`, `DEV_USER`, `DEV_PASS`, `DEV_LOG`.

Three things `start` does that matter:

- **It detaches** the server from the calling shell's process group (`detached: true`), so
  it does not die with the terminal that launched it.
- **It strips inherited identity.** `dev.sh` reads the caller's environment and deletes
  every `AGENTUS_*` / `AGENTSL*` / `DEV_*` key it did not set itself, printing
  `[dev] dropped inherited <KEY>`. This exists because a dev watcher that inherits a live
  identity pair will, on a reload, read the live port/data and reap the live agent
  children. Keep that behaviour when you touch the script.
- **It re-points the `mock` backend row at this tree.** A backend row stores an absolute
  path to the mock agent, seeded by whichever tree first created the store, so a dev
  instance reusing a store can silently spawn the *live* tree's mock. `start` PATCHes the
  row back to `$HERE/packages/server/mock/agent.mjs` each boot and prints
  `[dev] re-pointing backend 'mock' at this tree (was …)` when it does.

## Data directories and how they resolve

The server resolves its data directory in three ordered steps, and the **boot log prints
which one won and why** — a directory change is the thing that would otherwise read as
"my sessions are gone":

| order | rule |
|---|---|
| 1 | `AGENTUS_DATA` when it is set |
| 2 | `~/.agentus` once it holds something, or when there is no repo-side data yet |
| 3 | `<repo>/packages/server/.data` — an existing checkout that predates the install layout |

For the worktrees, the outcome is fixed by the launchers rather than by the rules:

- **live** — `~/.hermes/cache/agentus/launch.py` pins `AGENTUS_DATA=<live>/packages/server/.data`
  and `AGENTUS_PORT=8787`, and pops the inherited QA/DEV keys. The launcher owns its
  identity; it never trusts `os.environ`.
- **dev** — `scripts/dev.sh` exports `AGENTUS_DATA=/tmp/agentus-qa-account` and
  `AGENTUS_PORT=8901`.

`agentus --where` (or `AGENTUS_PRINT_PATHS=1`) prints the resolved paths and exits without
starting anything — the single source of truth for "where did my state go".

### Keeping a dev instance's data separate

The dev instance already points at `/tmp/agentus-qa-account`, so it shares nothing with
live. Two independent knobs if you need more:

- **The store** — override `AGENTUS_DATA` (as `dev.sh` does). A throwaway instance is one
  line:
  ```bash
  AGENTUS_PORT=8907 AGENTUS_TLS_PORT=0 AGENTUS_DATA=/tmp/<name> npx tsx packages/server/src/index.ts
  ```
  Note the server reads `AGENTUS_PORT`, not bare `PORT` — and this box exports an ambient
  `PORT=8648` (Hermes Studio), so a script that reads the ambient value starts a retry loop
  against the wrong port.
- **The agent subprocess home** — see below.

## The mock agent backend

The dev instance runs against a MOCK ACP agent:
`packages/server/mock/agent.mjs`. It implements enough of the ACP agent surface
(`initialize` / `newSession` / `prompt` / `cancel` / `setSessionMode` + the permission
flow) to exercise the whole pipeline with fake streaming and no real model or token spend.

The mock switches behaviour on the prompt text (per turn) and on env vars (global
defaults). The ones QA relies on:

| trigger / env | effect |
|---|---|
| `[think]` / `[think:N]` | stream N thought chunks before the answer |
| `[tools:N]` | N tool calls, each with a reasoning burst (the transcript-flood case) |
| `[tool]`, `[tool-diff]`, `[tool-hermes]` | a tool call + `requestPermission` (the approval surface) |
| `[table]` | a deliberately-unsorted table, a local file link and a relative image |
| `[slow]` | ~900 ms between chunks, so a socket can be dropped mid-turn |
| `[sink]` | exit the process mid-turn (the crash path) |
| `[plan]`, `[blocks]`, `[mcp]` | plan / structured-block / handshake-shape probes |
| `MOCK_FORGET=1` | answer like a real agent to a forgotten session (empty `load`) |

**For an ordinary prompt the mock emits no tool calls.** So a visual rule about tool cards
(a "short card is not stretched to the column" CSS rule, say) cannot be measured from a
real dev turn — either drive a `[tools:N]` turn or inject a fixture row with the real class
names and assert the injection count before and after. See [02-verify.md](./02-verify.md).

## Front-end hot reload

The web bundle is built by Vite (`packages/web`, `vite.config.ts`). The server serves the
**built** bundle at `packages/web/dist`, not the sources, so:

- for standalone front-end work: `npm run dev -w @agentus/web` (Vite dev server, `host: true`
  so it is reachable over the LAN);
- for anything the dev server or a sweep must serve: **`npm run build`** first. A sweep run
  after editing web sources but before a build measures the previous bundle and reports
  the old behaviour as if the fix did nothing.

## Isolating a slot's agent subprocess (HERMES_HOME)

A spawned agent CLI inherits the server's environment, so the server **always sets
`HERMES_HOME` explicitly**: the backend row's own home if it names one, otherwise the
default — the operator's real `~/.hermes`. That default is intentional for the live
instance (a slot drives the real agent). For a dev/test slot that should not touch the
operator's data, name a directory in that row's HERMES_HOME (no permission gate exists
any more).

One trap when a row points at a fresh home: an empty home has no `config.yaml`, no
`auth.json` and no `.env`, so `session/new` fails and the cockpit session goes `error`
with zero messages — which looks exactly like a broken adapter. Copy **all three** files
from a working home:

```bash
mkdir -p /tmp/<home> && cp ~/.hermes/{config.yaml,auth.json,.env} /tmp/<home>/
```

Also note a fresh home whose `hindsight/config.json` keeps the default profile name
`"hermes"` would attach to the production memory daemon; the spawn builder warns when it
would. Details: [`05-agent-driven.md`](./05-agent-driven.md) and
[`docs/refs/`](../refs/).

## Reading the dev logs

```bash
bash scripts/dev.sh logs              # tail -f /tmp/agentus-dev.log
bash scripts/dev.sh status            # :8901 up? pid, tree, /healthz
curl -s --noproxy '*' http://127.0.0.1:8901/healthz   # {"ok":true,...} + backend list
```

The dev log is a history of many launches (the `tsx watch` restarts write to it too), so
it is not by itself evidence about the *current* process — for "did it restart?", read the
served pid and the group leader's argv, not the log (see [03-release.md](./03-release.md)
and [04-recover.md](./04-recover.md)).

Cross-links: [02-verify.md](./02-verify.md) for the suites and sweeps ·
[03-release.md](./03-release.md) for `promote` · [04-recover.md](./04-recover.md) for
ports, stores and orphaned processes.
