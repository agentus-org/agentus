# Installing Agentus

[中文](./installation.zh-CN.md) · [README](../README.md)

Agentus is a multi-session web cockpit for ACP-speaking coding agents. One npm package
(`agentus`) runs a Node server that serves a built React SPA and spawns agent CLIs
(`hermes acp` / `qodercli --acp`) as child processes. The browser drives the sessions; the
reasoning stays inside the CLI subprocesses.

## Prerequisites

Two things, both required:

- **Node >= 22.5.** The store is `node:sqlite`, which landed in 22.5. Agentus refuses to start
  on anything older, with a clear message.
- **An ACP agent CLI on your PATH** — `hermes acp` or `qodercli --acp`. This is the one
  prerequisite npm cannot install for you. Without one the cockpit still runs and you can still
  log in; you just have no backend to open a session on.

```bash
# check the agent side (Hermes self-checks; qoder needs a login first)
hermes acp --check
qodercli login          # else newSession fails with -32000
```

Node itself is easy to get:

```bash
nvm install 22 && nvm use 22      # or
brew install node                 # or https://nodejs.org/en/download
```

### Which Hermes to run

Plain Hermes is enough to drive sessions. The capabilities this cockpit itself leans on are **not**
in the released build — a per-session **thinking depth** (ACP `reasoning_effort`), a **permission
mode that survives a restart** and `session/load`, a free-form **context budget** (with
256K/512K/768K/1M presets), the **status channel** that carries memory-recall / save hints into the
cockpit's message stream, **per-process skill roots** (`HERMES_EXTERNAL_SKILLS_DIRS`, which is how a
slot sees the cockpit's own skill without anything being written into your `~/.hermes`),
**background-job completion wake-ups** (a finished `terminal(background=true)` job is relayed back as
a turn of its own, so the agent resumes instead of the turn simply ending), and each row of the running
snapshot now says whether that process is the kind that wakes the session (`notifyOnComplete`) — which
is how the cockpit shows only the ones that mean 「not finished yet」 instead of a wall of noise, **project skills the agent
can see, trust and edit** (the cockpit reports which project skills a repo has and which tier you
trust, and writes the trust level back to config — it rides the same status channel; a released
Hermes silently skips untrusted project skills without saying so), and a
**DeepSeek web backend** (`search` + `extract` on top of `DEEPSEEK_API_KEY` — DeepSeek has no separate
search key).
They live on the ACP branches of the fork
[`LiangYang666/hermes-agent`](https://github.com/LiangYang666/hermes-agent), and reach the cockpit
through one **tag per integration build**, in a namespace of its own:

```
agentus/<hermes version>/merge-<YYYYMMDD-HHMM>
```

A tag and not a branch, on purpose: the branch of the same name (under `yl-dev/`) is the working
ref and gets rebuilt, while a tag never moves — so pin the tag. The `agentus/` prefix also keeps
ours apart from upstream's own tags (`v0.22.0`, `v0.22.0+canary.*`), and the timestamp in the
last segment sorts, so "newest" is a `sort -V`.

**Current integration build: `agentus/v0.22.0/merge-20261023-0556`** — the newest tag on the fork,
built on Hermes `v0.22.0`. This line is for orientation only, not the source of truth: the
`TAG=$(…)` step below resolves the newest one on every run, so read it there if this sentence
ever looks stale.

Install Hermes normally first — its installer brings the Python/Node runtime and puts `hermes` on
your PATH — then run that build on top of that runtime:

```bash
# 1. Hermes itself: the runtime the slots will use
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

# 2. the newest integration build, as a tag (`refs/tags/` spelled out: never ambiguous)
TAG=$(git ls-remote --tags --refs https://github.com/LiangYang666/hermes-agent.git \
      'refs/tags/agentus/*' | awk '{print $2}' | sed 's#refs/tags/##' | sort -V | tail -1)
git clone --depth=1 --branch "$TAG" https://github.com/LiangYang666/hermes-agent.git ~/Project/hermes-agent

# 3. wrap it, and point the cockpit at the wrapper
mkdir -p ~/.local/bin
cat > ~/.local/bin/hermes-acp-src <<'WRAP'
#!/bin/sh
exec env PYTHONPATH="$HOME/Project/hermes-agent" hermes "$@"
WRAP
chmod +x ~/.local/bin/hermes-acp-src
AGENTUS_HERMES_CMD=~/.local/bin/hermes-acp-src npm start
```

`PYTHONPATH` puts the checkout **ahead of** the installed package, while the installed runtime still
supplies the interpreter and its dependencies — which is why step 1 is not optional. Verify what a
slot will actually run (the same check Agentus suggests when a backend is missing):

```bash
PYTHONPATH=~/Project/hermes-agent hermes acp --check     # → Hermes ACP check OK
```

For a service install, put `AGENTUS_HERMES_CMD` in the environment you hand the server — see
"Running it as a service". Leaving it at the default (`hermes`) keeps a plain install working, so
the fork is an upgrade, never a requirement.

Moving to a newer build is a fetch + checkout in that same tree — `git fetch --depth=1 origin tag
<tag> && git checkout <tag>` — not a reinstall; a running slot picks it up the next time it
restarts.

## Install

### One command — the published package (public)

```bash
npx agentus                # run once, nothing installed globally
npm i -g agentus           # …or install it, then run `agentus`
```

`npx agentus` runs the cockpit in the foreground — Ctrl-C stops it, and it takes its agent
children with it.

### One command — the installer script

The same install from the repository's own script, with the checks and the fallbacks spelled out
(no `sudo`, ever):

```bash
curl -fsSL https://raw.githubusercontent.com/agentus-org/agentus/main/scripts/install.sh | bash
```

The installer (`scripts/install.sh`) checks Node, installs the published `agentus` package with
npm (globally), and falls back to a per-user prefix (`~/.local`) if the global tree is not
writable — it never reaches for `sudo`. It prints the start command and the URL when it is done.
It refuses to run as root unless you set `AGENTUS_ALLOW_ROOT=1`.

Overrides, passed as environment variables:

| var | default | meaning |
|---|---|---|
| `AGENTUS_VERSION` | `latest` | pin a package version, e.g. `0.1.0` |
| `AGENTUS_INSTALL_DIR` | unset | install into this `npm --prefix` instead of the global one |
| `AGENTUS_REGISTRY` | npm's own | registry to fetch from |
| `AGENTUS_ALLOW_ROOT` | `0` | `1` permits running as root |
| `AGENTUS_NODE_MIN` | `22.5` | override the Node floor check |

```bash
# pin a version and a prefix
AGENTUS_VERSION=0.1.0 AGENTUS_INSTALL_DIR="$HOME/.local" \
  bash scripts/install.sh
```

### From source (a checkout)

```bash
git clone https://github.com/agentus-org/agentus.git
cd agentus
npm start                           # installs if needed, builds, serves (scripts/start.sh)
npm run dev -w @agentus/web         # front-end hot reload (Vite :5173, reachable over LAN)
npm run agentus                     # the same CLI as `npx agentus`, straight from the checkout
```

`npm start` (→ `scripts/start.sh`) checks the Node version, installs dependencies with
`NODE_ENV=development` when `node_modules` is missing, builds when the web bundle is stale, then
serves once (no watcher). `AGENTUS_PORT=9000 npm start` moves the port.

## CLI

```
agentus [options]

  -p, --port <n>     port to listen on                 (AGENTUS_PORT, default 8788)
  -d, --data <dir>   where state lives (sqlite, login, settings)
                                                       (AGENTUS_DATA, default ~/.agentus)
  -o, --open         open the cockpit in your browser once it is up
      --where        print the resolved paths and exit (starts nothing)
  -h, --help         this text
  -v, --version      print the version
```

`--where` is worth knowing: it prints what the server actually resolved — data dir, web bundle,
companion APK, Node version — and exits before anything starts. It is the one
answer to "where did my data go" (see below).

## First run

1. Start it: `agentus` (or `npx agentus`, or `npm start` from a checkout).
2. Open **http://localhost:8788** and log in. Default credentials:

   ```
   username: admin
   password: 123456      ← change it
   ```

   Change it in the app: **Settings → 账号** (the first card). It applies immediately and writes
   `<DATA_DIR>/credentials.json` (0600, scrypt hash).
3. Add a backend. The registry is seeded on first boot from the builtin rows (see
   [Backends](#backends)); check that `hermes` or `qoder` resolves, or point a row at your own
   command.
4. **+ new session** → pick a backend and a working directory → start it.

The first session you start will use the Hermes home your own agent already uses (`~/.hermes`)
unless the backend row names another one — see [HERMES_HOME](#hermes_home).

## Configuration reference

### Environment variables

| var | default | meaning |
|---|---|---|
| `AGENTUS_PORT` | `8788` | server port (never reads bare `PORT`) |
| `AGENTUS_DATA` | `~/.agentus` | where state lives; see [Data directory](#data-directory) |
| `AGENTUS_TITLE` | `Agentus` | this instance's own name — the tab title and the PWA label, so several cockpits on one machine are told apart |
| `AGENTUS_HERMES_CMD` | `hermes` | binary to spawn for the hermes backend |
| `AGENTUS_QODER_CMD` | `~/.local/bin/qodercli` | ditto for qoder |
| `AGENTUS_HERMES_HOME` | `~/.hermes` | default `HERMES_HOME` for a row that does not name one |
| `AGENTUS_PERM_TIMEOUT_MS` | `300000` (5 min) | how long a permission prompt waits before auto-cancelling |
| `AGENTUS_HISTORY_PAGE` | `500` | transcript page size |
| `AGENTUS_TTS_BASE_URL` | unset | OpenAI-compatible base for server speech synthesis (`…/v1`); unset = browser voices only |
| `AGENTUS_TTS_API_KEY` / `AGENTUS_TTS_MODEL` / `AGENTUS_TTS_VOICE` | – / `tts-1` / `alloy` | ditto |
| `AGENTUS_STT_BASE_URL` | unset | OpenAI-compatible base for server transcription; unset = browser recognition only |
| `AGENTUS_STT_API_KEY` / `AGENTUS_STT_MODEL` / `AGENTUS_STT_LANGUAGE` | – / `whisper-1` / – | ditto |
| `DASHSCOPE_API_KEY` / `DASHSCOPE_BASE_URL` | – | 百炼 (DashScope) credentials; read from the process env **and** `~/.hermes/.env` |

Auth variables:

| var | default | meaning |
|---|---|---|
| `AGENTUS_AUTH` | `on` | `off` = no login at all (local hacking only) |
| `AGENTUS_USERNAME` | `admin` | operator name |
| `AGENTUS_PASSWORD` | `123456` | operator password (plaintext in env) |
| `AGENTUS_PASSWORD_HASH` | — | `scrypt:<salt>:<hex>`; wins over `AGENTUS_PASSWORD` |
| `AGENTUS_SESSION_TTL_MS` | 604800000 (7d) | session lifetime |
| `AGENTUS_AUTH_SECRET` | `<DATA_DIR>/auth.secret` | cookie signing key (0600, auto-minted) |
| `AGENTUS_AUTH_TOKEN` | `<DATA_DIR>/auth.token` | machine token for scripts (0600, auto-minted) |
| `AGENTUS_LOGIN_MAX_FAILS` / `AGENTUS_LOGIN_LOCK_MS` | `5` / `30000` | per-IP brute-force lockout |
| `AGENTUS_BASIC_AUTH` | — | HTTP Basic in front of **everything** (`:pass` checks only the password) |

The voice/theme environment variables are a **bootstrap only**: the settings page (⚙ in the rail)
owns them afterwards and stores them under `<DATA_DIR>/settings.json` (0600). What the page says
wins; the env is what makes a fresh install work before anyone opens it.

### Data directory

`~/.agentus` by default. It holds `agentus.sqlite` (sessions + transcript), `credentials.json`,
`auth.token`, `auth.secret`, `settings.json`. It is created `0700` on first boot, and the
boot log prints it **and why that directory won**:

| order | rule |
|---|---|
| 1 | `AGENTUS_DATA` when it is set — every launcher and dev/QA instance pins this |
| 2 | `~/.agentus` once it holds something, or when there is no repo-side data yet |
| 3 | `<repo>/packages/server/.data` — an existing checkout that predates this layout |

Rule 3 exists so an install that quietly switched directories cannot come up with an empty
session list (which reads exactly like "my sessions are gone"). To move such a checkout over,
boot it once with `AGENTUS_DATA=~/.agentus`. `agentus --where` prints what the server resolved
instead of making you guess.

Nothing ever writes inside `node_modules`: for an installed package, `<pkg>/packages/server/.data`
would be deleted by the next `npm i -g agentus`, taking the transcript and the login with it.

### Ports

| port | speaks | for |
|---|---|---|
| `AGENTUS_PORT` (8788) | plain HTTP | LAN, loopback, `curl`, scripts — no cert warning, CI unchanged; **the only listener** |
| 5173 | Vite dev server | front-end hot reload, only during `npm run dev` |

TLS is terminated **in front of** this process (a reverse proxy, or a tunnel that does its own
`public_tls`) — see [TLS](#tls).

### Login

The cockpit is behind a login by default. Two credentials exist:

| credential | how it travels | who uses it |
|---|---|---|
| session cookie | `HttpOnly` + `SameSite=Lax`, HMAC-SHA256 signed, 7d | the browser (`POST /api/auth/login`) |
| machine token | `Authorization: Bearer <t>` or `?token=<t>` | scripts, CI, launchers — read it from `<DATA_DIR>/auth.token` (0600) |

Sessions are stateless cookies with a server-side index at `<DATA_DIR>/sessions.json` (0600), so
revocation and "log out everywhere" are real and survive a restart. `AGENTUS_USERNAME` /
`AGENTUS_PASSWORD` / `AGENTUS_PASSWORD_HASH` are the bootstrap; once you save in the 账号 card the
file wins. Delete `credentials.json` to fall back to the environment.

### TLS

A plain TCP tunnel (SakuraFrp, `ssh -L`, most frp setups) forwards bytes — it does not terminate
TLS for you. So terminate TLS **in front of** the server: a reverse proxy (Caddy, nginx), or a
tunnel that does its own `public_tls`.

This process listens on plain HTTP only, on purpose: the LAN path then needs no certificate and
`curl`/scripts stay unchanged, and certificate lifecycle (issuing, rotation, SAN) lives in that
front layer instead of inside the app.

The session cookie still comes out `Secure` when the request arrived over TLS: the handler reads
`X-Forwarded-Proto` (`packages/server/src/auth.ts`), so any front layer that sets it — Caddy and
nginx both do by default — gets a `Secure` cookie with no configuration here.

### Backends

| id | command | notes |
|---|---|---|
| `hermes` | `hermes acp` | needs a Hermes install on PATH (`hermes acp --check`) |
| `qoder` | `qodercli --acp` | needs `qodercli login` first, else `newSession` fails `-32000` |
| `mock` | `node packages/server/mock/agent.mjs` | offline dev/QA: fake streaming, permission prompts, crash/plan/tool triggers |

Adding a backend is one row in `packages/server/src/acp/backends.ts`; the protocol layer never
changes.

## HERMES_HOME

A spawned agent CLI inherits the server's environment, so the server **always sets `HERMES_HOME`
explicitly**: the row's own home if it names one, otherwise the default — **your real `~/.hermes`**,
the same `state.db` your gateway and Studio have open. That is the intended production setting: a
session drives your actual agent, with your config, credentials, memory and session list.

An *inherited* `HERMES_HOME` is ignored, so where a session writes is always something you chose —
on the backend row, or via `AGENTUS_HERMES_HOME`. To keep one session's data separate, name a
directory in that row's HERMES_HOME; no permission is needed.

## Running it as a service

Agentus runs in the foreground by default; a service unit keeps it up across logins and reboots.
Point the unit at the same `AGENTUS_DATA` you use interactively, or the cockpit will come up with
a different session list.

**macOS (launchd)** — `~/Library/LaunchAgents/org.agentus.cockpit.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>org.agentus.cockpit</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>agentus</string><string>--port</string><string>8788</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>AGENTUS_DATA</key><string>/Users/YOU/.agentus</string></dict>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardOutPath</key>  <string>/tmp/agentus.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/agentus.err.log</string>
</dict>
</plist>
```

```bash
launchctl load  ~/Library/LaunchAgents/org.agentus.cockpit.plist
launchctl kickstart -k gui/$(id -u)/org.agentus.cockpit   # restart
```

**Linux (systemd, user unit)** — `~/.config/systemd/user/agentus.service`:

```ini
[Unit]
Description=Agentus cockpit
After=network.target

[Service]
ExecStart=/usr/bin/env agentus --port 8788
Environment=AGENTUS_DATA=%h/.agentus
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now agentus
journalctl --user -u agentus -f
```

TODO(verify): the exact `env` resolution of `agentus` inside a launchd/systemd unit depends on
where npm put the bin (a per-user prefix is not on a service's PATH by default) — use an absolute
path to the `agentus` bin if the unit fails to start.

## Upgrade

```bash
npm i -g agentus@latest            # or: npx agentus@latest … for a one-off
```

Your state is untouched — `~/.agentus` (or wherever `AGENTUS_DATA` points) is not inside the
package, so an upgrade cannot delete it. If you installed into a prefix with
`AGENTUS_INSTALL_DIR=~/.local`, upgrade with the same prefix. On startup the server adopts existing
session cookies once instead of logging every device out.

## Uninstall

```bash
npm rm -g agentus                  # remove the program (state stays)
rm -rf ~/.agentus                  # remove state — SQLite, login, settings
```

If you installed into a per-user prefix, `npm rm -g --prefix ~/.local agentus`. Uninstalling never
touches `~/.hermes` (your agents' own data) or any working directory.

## Troubleshooting

**Port already in use.** `agentus --port 9000`, or find and stop the holder:
`lsof -nP -iTCP:8788 -sTCP:LISTEN`. Agentus never reads bare `PORT` for exactly this reason.

**"No backend" / a session won't start.** The agent CLI is missing or not logged in. Run
`hermes acp --check`, or `qodercli login` (a `-32000` on `newSession` means qoder is not logged
in). Check the backend row's command in Settings; the boot log and a 探测 (probe) say whether the
command resolves.

**Login problems.**

- Forgot the password: delete `<DATA_DIR>/credentials.json` and restart — the bootstrap from
  `AGENTUS_USERNAME` / `AGENTUS_PASSWORD` applies again (or the defaults).
- Locked out by the brute-force limiter: **Settings → 登录失败锁定** lists the locked IPs with
  unlock / unlock all.
- Locked out entirely (can't log in to reach Settings): delete `<DATA_DIR>/sessions.json` to drop
  the session index, or restart the server — the in-memory lockout clears on boot.

**"My sessions are gone."** The server is reading a different data directory. Run `agentus --where`
— it prints the data dir **and which rule chose it** (top of this page). The usual cause is an
existing checkout whose sessions live in `<repo>/packages/server/.data` while the install now
defaults to `~/.agentus`. Boot once with `AGENTUS_DATA` set to the directory that actually holds
them, e.g. `AGENTUS_DATA=~/.agentus agentus` or `AGENTUS_DATA=<repo>/packages/server/.data agentus`.

**The page loads but says "reconnecting" forever.** A tunnel is dropping WebSocket `Upgrade`
requests. The live stream rides on `/ws`; use a tunnel that passes WebSockets through (SakuraFrp
TCP+auto-HTTPS tunnels are verified working).

**Certificate warning on the LAN.** The server itself speaks plain HTTP on `:8788`, so a warning
means you are reaching a TLS-terminating front layer directly by IP — its certificate names a
domain, not an IP. Either use the plain-HTTP `:8788` port on the LAN, or reach the front layer by
the name its certificate was issued for.
