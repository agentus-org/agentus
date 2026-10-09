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

## Install

### One command

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

### With a package manager

If you would rather not pipe a script into a shell:

```bash
npx agentus                # run once, nothing installed globally
npm i -g agentus           # …or install it, then run `agentus`
```

`npx agentus` runs the cockpit in the foreground — Ctrl-C stops it, and it takes its agent
children with it.

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

  -p, --port <n>     port to listen on                 (AGENTUS_PORT, default 8787)
  -d, --data <dir>   where state lives (sqlite, login, TLS material, settings)
                                                       (AGENTUS_DATA, default ~/.agentus)
  -o, --open         open the cockpit in your browser once it is up
      --where        print the resolved paths and exit (starts nothing)
  -h, --help         this text
  -v, --version      print the version
```

`--where` is worth knowing: it prints what the server actually resolved — data dir, web bundle,
companion APK, TLS listener, Node version — and exits before anything starts. It is the one
answer to "where did my data go" (see below).

## First run

1. Start it: `agentus` (or `npx agentus`, or `npm start` from a checkout).
2. Open **http://localhost:8787** and log in. Default credentials:

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
| `AGENTUS_PORT` | `8787` | server port (never reads bare `PORT`) |
| `AGENTUS_DATA` | `~/.agentus` | where state lives; see [Data directory](#data-directory) |
| `AGENTUS_HERMES_CMD` | `hermes` | binary to spawn for the hermes backend |
| `AGENTUS_QODER_CMD` | `~/.local/bin/qodercli` | ditto for qoder |
| `AGENTUS_HERMES_HOME` | `~/.hermes` | default `HERMES_HOME` for a row that does not name one |
| `AGENTUS_PERM_TIMEOUT_MS` | `300000` (5 min) | how long a permission prompt waits before auto-cancelling |
| `AGENTUS_HISTORY_PAGE` | `500` | transcript page size |
| `AGENTUS_TLS_PORT` | `8443` when a cert exists, else off | the TLS listener (`0` disables it) |
| `AGENTUS_TLS_CERT` / `AGENTUS_TLS_KEY` | `<DATA_DIR>/tls/{cert,key}.pem` | cert material for that listener |
| `AGENTUS_TLS_CA` | `<DATA_DIR>/tls/ca.pem` | the root a device installs once |
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
`auth.token`, `auth.secret`, `tls/`, `settings.json`. It is created `0700` on first boot, and the
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
would be deleted by the next `npm i -g agentus`, taking the transcript, the login and the TLS key
with it.

### Ports

| port | speaks | for |
|---|---|---|
| `AGENTUS_PORT` (8787) | plain HTTP | LAN, loopback, `curl`, scripts — no cert warning, CI unchanged |
| `AGENTUS_TLS_PORT` (8443) | HTTPS (self-signed) | the tunnel — encrypts the public hop |
| 5173 | Vite dev server | front-end hot reload, only during `npm run dev` |

Same handler, same routes, same auth on both listeners; only the socket differs.

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
TLS for you. So the server can speak TLS itself, on a **second** listener:

```bash
scripts/make-cert.sh                    # self-signed root + short-lived leaf, SAN = the name you type
# -> $AGENTUS_DATA/tls/{ca.pem,cert.pem,key.pem}   (key 0600, git-ignored)
# boot log then says: https://0.0.0.0:8443 (self-signed …) ; point a tunnel at THIS port
```

The listener also serves its own issuer at `/cert.crt`, so a device can install the root once:
`https://<your-name>:<tls-port>/cert.crt`. iOS opens the profile installer directly; Android
downloads it (Settings → Security → CA certificate); iOS also needs *About → Certificate Trust
Settings → enable*. It is public material — the private key never leaves `<DATA_DIR>/tls/`.

`make-cert.sh` issues two certs on purpose: a 10-year root (`ca.pem`, what devices install) and a
390-day leaf (`cert.pem`, what the listener serves). Apple caps server-certificate validity at 398
days, so a 10-year leaf is exactly what iOS refuses *after* the install dance. Rotate the leaf
(`--leaf-only`) freely; the installed root is untouched.

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
    <string>/usr/bin/env</string><string>agentus</string><string>--port</string><string>8787</string>
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
ExecStart=/usr/bin/env agentus --port 8787
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
rm -rf ~/.agentus                  # remove state — SQLite, login, TLS key, settings
```

If you installed into a per-user prefix, `npm rm -g --prefix ~/.local agentus`. Uninstalling never
touches `~/.hermes` (your agents' own data) or any working directory.

## Troubleshooting

**Port already in use.** `agentus --port 9000`, or find and stop the holder:
`lsof -nP -iTCP:8787 -sTCP:LISTEN`. Agentus never reads bare `PORT` for exactly this reason.

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

**Certificate warning on the LAN.** That is the TLS listener's self-signed cert (a bare LAN IP
cannot carry a trusted cert). Either use the plain-HTTP `:8787` port on the LAN, or install the
issuer once from `/cert.crt` (see [TLS](#tls)).
