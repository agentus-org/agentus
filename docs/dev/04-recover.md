# Recovering when it breaks

This doc answers: the instance is broken or misbehaving — where do I look first, and how do
I fix it without making the box worse?

## Read the boot log first

The boot log is the authoritative account of what the server resolved. It prints **which
data directory won and why**, the auth state, and the TLS listener:

```
data dir: /Users/…/packages/server/.data  (AGENTUS_DATA was set)      ← the dir + the reason
auth on: user "admin"
https://0.0.0.0:8443 (self-signed …)                                  ← present = TLS listener up
tls off: no cert at <DATA_DIR>/tls/cert.pem                           ← absent/off = no TLS
```

If the directory it names is not the one you expected, stop here — a server serving the
wrong store looks healthy (200s, valid `/api/version`) while the operator's session list is
empty. Triage the identity, not the liveness (see "Is it serving the wrong store?" below).

## Ports

| port | who |
|---|---|
| `8788` | live HTTP |
| `8443` | live TLS (public tunnel points here) |
| `8901` | dev / QA instance |
| `8648` | **Hermes Studio** — not Agentus, do not touch |

```bash
lsof -nP -iTCP:8788 -sTCP:LISTEN        # who owns the port (returns the CHILD, not the supervisor)
ps -o pid,ppid,pgid,command -p <pid>    # its process group and command line
```

## "Address already in use"

`EADDRINUSE` means another process holds the port — often a previous instance that never
died, or (this box) an ambient `PORT=8648` pointed at Studio. The Agentus server reads
`AGENTUS_PORT`, never bare `PORT`, so a script that reads the ambient value will fight for
Studio's port. Do not just relaunch: identify the current holder, decide whether it is the
one you want, then stop it through its own launcher.

```bash
# clean stop of the dev instance (kills the process GROUP on :8901)
bash scripts/dev.sh stop
```

For live, stop it only via the release path ([03-release.md](./03-release.md)) — a bare kill
of the live listener ends the operator's sessions.

## Orphaned agent and shell child processes

Every agent child is spawned detached and its pid recorded, and the server reaps orphans on
next boot — so a crashed server's leftovers are cleaned up automatically. Shell sessions
(the workspace terminal) are killed with their socket. Problems appear when a **supervisor**
(the `tsx watch` wrapper) survives a crash: the listener it spawned may be gone while the
supervisor sits in a restart loop, or a leaked listener keeps holding the port.

**Never kill by a substring match.** A cleanup filtered on `packages/server/src/index.ts`
once ended 249 processes in one shot — the operator's own `hermes-studio` checkout has a
file at that same path, and its server was the only way into the machine. Rules:

1. **Enumerate first and print the full command line and cwd** of every candidate:
   ```bash
   ps -eo pid,ppid,pgid,command | grep <pattern>
   lsof -a -p <pid> -d cwd -Fn      # where it is actually running
   ```
2. **Keep the list inside this worktree's path.** The operator's services are never in
   scope. A `ps | grep` list also contains your own tool shell — exclude the current pid and
   its ancestors, or an unfiltered kill ends your own command mid-flight.
3. **Prove the target is its own process group, then kill the group:**
   ```bash
   ps -o pid,pgid,sess -p <pid>
   kill -9 -- -<pgid>              # negative pid = the group
   ```
   Under a supervisor the LISTEN pid is the supervisor's child, whose pgid is the
   supervisor's — killing only the child leaves the supervisor (which respawns and fights
   for the port). This is why `dev.sh`/`relaunch.sh` kill `-$pgid` and, when `pgid != pid`,
   the pid too.
4. **Fix the leak, not the puddle.** New scripts must use the shipped pattern —
   `spawn(..., { detached: true })` and kill the process group — rather than cleaning up by
   name afterwards.
5. **Re-check the neighbours afterwards:** one `curl` per resident service
   (`:8648` Studio, `:8788`/`:8443` live, `:8901` dev). A cleanup that leaves the box worse
   than it found it is the whole failure mode.

## The SQLite store, WAL, and the `*.bak` files

State lives in `<DATA_DIR>/agentus.sqlite` (the transcript and every other row), accessed
through Node's built-in `node:sqlite` (hence Node `>= 22.5`). Files beside it: `credentials.json`,
`auth.token`, `auth.secret`, `sessions.json`, `settings.json`, `tls/` — several of them
`0600`. The server creates the directory `0700` on first boot.

**Back up before you touch the store.** A single write against the operator's real data gets
a backup and a record of the old values:

```bash
cp -p packages/server/.data/agentus.sqlite \
      ~/.hermes/cache/scratch/agentus.sqlite.bak-$(date +%H%M%S)
```

The one migration path in the project that rewrites rows in place — the legacy transcript
fold — takes its own backup first with `VACUUM INTO <db>.pre-fold.bak` and gates itself on
`pragma user_version`, so it runs once and is idempotent. If you see a `*.pre-fold.bak`
beside the store, that fold ran; the original is inside it.

Two cautions that come from real incidents:

- **Two independent writers on one WAL database** corrupted the operator's live `state.db`
  while the runtime linked a SQLite in the WAL-reset bug range. The fix is the interpreter
  (link SQLite ≥ 3.51.3), not a symlink, and it belongs to the Hermes Studio runtime, not to
  this repo. Check it with `hermes doctor` and read the ⚠ lines — a warning is real, not
  imaginary, but the shipped `hermes doctor` is warn-only. Never add a second writer to the
  live home on a vulnerable build.
- `DELETE /api/sessions/<id>` **closes a live session and purges a cold one** — for an
  already-dead row it deletes the record. So "archive this dead session" is not that route;
  it takes a direct, backed-up, single-row transaction (`WHERE id=? AND status='error'`), no
  live row touched, and no restart needed (a cold row is not in the server's in-memory map).

## Is it serving the wrong store?

Symptoms that look like separate bugs but share one cause: the operator's session list came
back empty, TLS silently turned off (`tls off: no cert at <QA_DIR>/tls/cert.pem`), and a
running slot was reaped — yet the port answers 200 and `/api/version` looks fine. Cause:
`relaunch → launch.py` inherited the QA environment. The launcher now pins its own
`AGENTUS_DATA`/`AGENTUS_PORT` and pops the QA/DEV keys, but verify identity directly:

```bash
PID=$(lsof -nP -iTCP:8788 -sTCP:LISTEN -t)
ps eww -p "$PID" | tr ' ' '\n' | grep AGENTUS          # the process's own identity vars
lsof -p "$PID" | grep sqlite                           # which store it actually opened
```

Recovery:

```bash
cd worktrees/agentus
env -u AGENTUS_DATA -u AGENTUS_BASE -u DEV_LOG_PATH -u DEV_PROMOTE_DETACHED -u DEV_PROMOTE_SELF \
  bash scripts/relaunch.sh --port 8788 --launcher ~/.hermes/cache/agentus/launch.py \
    --launchd ai.hermes.agentus
TOK=$(cat packages/server/.data/auth.token)
curl -s -X POST -H "Authorization: Bearer $TOK" http://127.0.0.1:8788/api/sessions/<id>/resume
```

`--launchd <label>` makes relaunch.sh hand the restart to launchd (`kickstart -k`) rather than
killing the process by hand — once the job is installed, a hand-kill is not a restart, it is a
respawn race (launchd brings the old process back while our own launcher starts a second one). Pass
it whenever the label is loaded; relaunch.sh ignores it when it is not.

After any restart, put the operator back on the air: `POST /api/sessions/<id>/resume` with the
machine token → `status: ready` and a fresh pid. **Capture the slot ids to resume before the
restart** — in the window right after a restart a slot has dropped from `live` into
`archived` wearing `error`, so a resume loop that reads the current `live` list finds
nothing. `resume` works on an `archived('error')` row; that is the cold-slot entry point.

## Auth lockout

The login limiter is visible and reversible without a restart, so locking yourself out is a
one-click problem. Endpoints behind the login:

```bash
TOK=$(cat <DATA_DIR>/auth.token)
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:8788/api/auth/locked-ips
curl -s -X DELETE -H "Authorization: Bearer $TOK" http://127.0.0.1:8788/api/auth/locked-ips
```

In the UI it is Settings → 登录失败锁定 (which IPs are locked, for how long, unlock / unlock
all). Tunables: `AGENTUS_LOGIN_MAX_FAILS` (default 5) / `AGENTUS_LOGIN_LOCK_MS` (default
30000). Login sessions are stateless signed cookies indexed at `<DATA_DIR>/sessions.json`
(0600) — advisory for display, authoritative for existence. A password change invalidates
every other session; `AGENTUS_AUTH=off` disables the login entirely and the boot log scolds
you (do not leave it off — the listener is `0.0.0.0` and this cockpit is tunnelled).

## TLS certificate regeneration

The TLS listener runs on a **second port** (8443 live), pointed at by a plain-TCP tunnel.
Cert material lives at `<DATA_DIR>/tls/`. Regenerate with:

```bash
scripts/make-cert.sh [name]        # default name: the DDNS name; SAN = that name + localhost + 127.0.0.1
scripts/make-cert.sh --leaf-only   # rotate the leaf only; installed devices are untouched
```

`make-cert.sh` issues **two** certs on purpose: a 10-year root (`ca.pem`, what devices install
once, served at `/cert.crt`) and a 390-day leaf (`cert.pem`/`key.pem`, what the listener
serves, under Apple's 398-day cap). Keep the SAN to the DDNS name you actually type, not the
dynamic public IP. It writes into the same directory the server reads from (mirroring the
server's own resolution in `packages/server/src/index.ts`), and if that resolution and the
server's ever diverge the listener stays silently off with a cert sitting next to it — after
regenerating, confirm the boot log still prints `https://…:8443`.

## The process-exit safety net for children

The server installs `SIGINT`/`SIGTERM`/`SIGHUP` handlers that terminate the child agent
processes, so Ctrl-C (or a deliberate restart) takes its agents with it. The
`unhandledRejection`/`uncaughtException` guards are installed **only after `listen()`
succeeds** — installing them earlier would turn a startup failure (`EADDRINUSE`) into a
zombie that is "alive but not listening". Combined with the on-boot orphan reap, this is
what keeps a crashed server from leaving runaway children behind. If you find runaway
children anyway, hunt them by the process-group rule above — never by name.

Cross-links: [01-dev-loop.md](./01-dev-loop.md) (ports, data dirs) ·
[03-release.md](./03-release.md) (release + rollback) ·
[02-verify.md](./02-verify.md) (stray CDP tabs, leaked servers).
