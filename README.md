# AgentSlot

**Keep your agents on the track.** A multi-slot web cockpit for ACP-speaking coding
agents: open several sessions in the browser, each one backed by a real
`hermes acp` / `qodercli --acp` subprocess, and drive them from any device.

> **Red line:** the UI holds *zero* intelligence. No agent loop, no model calls, no
> prompt engineering. The server does exactly six things — gate access, spawn a child,
> relay ACP JSON-RPC, stream events to the browser, persist the transcript, surface
> permission prompts. Reasoning lives in the CLI processes.

```
[browser React SPA]  ──HTTP + WS──▶  [AgentSlot server]  ──ACP/JSON-RPC over stdio──▶  [hermes acp | qodercli --acp]
                                         · session registry (who runs, where, pid)
                                         · ACP client (ClientSideConnection)
                                         · event fan-out → WS, commands → ACP
                                         · SQLite transcript + cold-slot resume
```

## Quick start

```bash
# Node >= 22.5 (needs node:sqlite; developed on v25)
git clone https://github.com/agent-slot/agentslot.git
cd agentslot

# 1) build the isolated Hermes home your test agents will use (see SECURITY note)
python3 scripts/setup-hermes-test-home.py

# 2) run it — installs if needed, builds, serves
npm start
# open http://localhost:8787 and log in (admin / 123456 — see "Login" below),
# then "+ new slot", pick a backend + working directory
```

`npm start` (→ `scripts/start.sh`) checks the Node version, installs dependencies with
`NODE_ENV=development` when `node_modules` is missing, builds when the web bundle is
stale, then serves. Use `AGENTSLOT_PORT=9000 npm start` to move the port.

For front-end hot reload instead: `npm run dev -w @agentslot/web` (Vite on :5173,
`host: true` so your phone can reach it over LAN).

### Backends

| id | command | notes |
|---|---|---|
| `hermes` | `hermes acp` | needs a Hermes install on PATH (`hermes acp --check`) |
| `qoder` | `qodercli --acp` | needs `qodercli login` first, else `newSession` fails `-32000` |
| `mock` | `node packages/server/mock/agent.mjs` | offline dev/QA: fake streaming, permission prompts, crash/plan/tool triggers |

Adding a backend is **one row** in `packages/server/src/acp/backends.ts`. The protocol
layer never changes.

### Environment

| var | default | meaning |
|---|---|---|
| `AGENTSLOT_PORT` | `8787` | server port (never reads bare `PORT` — that name is polluted on shared hosts) |
| `AGENTSLOT_DATA` | `packages/server/.data` | SQLite location |
| `AGENTSLOT_HERMES_CMD` | `hermes` | binary to spawn for the hermes backend |
| `AGENTSLOT_QODER_CMD` | `~/.local/bin/qodercli` | ditto for qoder |
| `AGENTSLOT_HERMES_HOME` | `~/.agentslot-test/home` | **isolated `HERMES_HOME` for the child** |
| `AGENTSLOT_ALLOW_LIVE_HOME` | unset | `1` = allow spawning against `~/.hermes` (you almost never want this) |
| `AGENTSLOT_PERM_TIMEOUT_MS` | `300000` (5 min) | how long a permission prompt waits before auto-cancelling |
| `AGENTSLOT_HISTORY_PAGE` | `500` | transcript page size (also set small in tests to exercise paging) |

## Login

The cockpit is behind a login by default — this thing spawns processes that write to
your disk, so an open port is a remote shell waiting to happen.

```
username: admin
password: 123456     (default — change it)
```

Change it with `AGENTSLOT_PASSWORD` (or `AGENTSLOT_PASSWORD_HASH` holding
`scrypt:<salt>:<hex>`, so no plaintext sits in your env), then restart. The server
warns on every boot while the default is still in use, and the login card says so too.

Two credentials exist, deliberately:

| credential | how it travels | who uses it |
|---|---|---|
| **session cookie** | `HttpOnly` + `SameSite=Lax`, HMAC-SHA256 signed, 7d | the browser (issued by `POST /api/auth/login`) |
| **machine token** | `Authorization: Bearer <t>` or `?token=<t>` | scripts, CI, launchers — read it from `<DATA_DIR>/auth.token` (0600) |

The cookie is `HttpOnly` rather than a token in `localStorage`, and it rides along on
the WebSocket handshake for free. Everything under `/api` is closed to anonymous
callers; the app shell, its assets, `/healthz` and `/api/auth/*` stay open so the
login page itself can load. `scripts/*.mjs` read the machine token automatically
(`scripts/lib/auth.mjs`).

Auth environment:

| var | default | meaning |
|---|---|---|
| `AGENTSLOT_AUTH` | `on` | `off` = no login at all (local hacking; the boot log will scold you) |
| `AGENTSLOT_USERNAME` | `admin` | operator name |
| `AGENTSLOT_PASSWORD` | `123456` | operator password (plaintext in env) |
| `AGENTSLOT_PASSWORD_HASH` | — | `scrypt:<salt>:<hex>`; wins over `AGENTSLOT_PASSWORD` if set |
| `AGENTSLOT_SESSION_TTL_MS` | 604800000 (7d) | session lifetime |
| `AGENTSLOT_AUTH_SECRET` | `<DATA_DIR>/auth.secret` | cookie signing key (0600, auto-minted) |
| `AGENTSLOT_AUTH_TOKEN` | `<DATA_DIR>/auth.token` | machine token (0600, auto-minted) |
| `AGENTSLOT_LOGIN_MAX_FAILS` / `AGENTSLOT_LOGIN_LOCK_MS` | `5` / `30000` | per-IP brute-force lockout |
| `AGENTSLOT_BASIC_AUTH` | — | an HTTP Basic challenge in front of **everything** (including `/healthz` and the WS upgrade). `user:pass` checks both; `:pass` (or a bare `pass`) checks **only the password** and accepts any username. This is the outer lock you want before exposing a tunnel; see "Exposing it publicly". |

### Exposing it publicly (tunnel / reverse proxy)

Put `AGENTSLOT_BASIC_AUTH=:pass` in the server's environment, then point the tunnel at
`<lan-ip>:8787`. That gives you two independent locks — Basic at the edge of the app, the
operator login inside it — and scripts can still get in (`curl -u :pass` plus the machine
token).

Password-only (`:pass`, or a bare `pass`) is the recommended form here: HTTP Basic always
asks the browser for a username (RFC 7617 carries `user:pass`), but a single-operator
service gains nothing from one — typing any name, or leaving it blank, works. If you do
configure a username, it is checked too.

Pick one outer lock, not both:

- **The tunnel's own gate**, if it has one. SakuraFrp's `auth_pass` is an IP-level
  authorisation: the first visit shows a small page asking for the access password, the
  IP is remembered after that, and the WebSocket keeps working through it (both measured
  end to end). Zero config on this side; the cost is that machines cannot get in without
  the extra authorisation dance (`POST /v4/tunnel/auth`).
- **`AGENTSLOT_BASIC_AUTH`**, when the tunnel has no gate, is a plain TCP forward, or you
  want scriptable access (`curl -u :pass`). A real 401 challenge is understood by every
  browser, proxy and HTTP client — unlike some tunnel "access auth" flavours, which answer
  HTTP **200** with an authorise-your-IP page and are invisible to `curl`.

Turning both on means three password prompts in a row, so pick one.

Two things to know about a tunnel in front of this app:

- **WebSockets must pass through.** The cockpit's live stream rides on `/ws`; an HTTP/1.1
  tunnel that drops `Upgrade` gives you a page that loads and then says "reconnecting"
  forever. Verified working through SakuraFrp's TCP+auto-HTTPS tunnels.
- **Terminate TLS at the edge.** When the request arrives with `X-Forwarded-Proto: https`
  the session cookie is issued `Secure` automatically (verified through that same tunnel),
  so no config needed. The last hop inside your LAN stays plain HTTP.

What this is *not*: TLS by itself. A bare LAN IP cannot carry a trusted certificate, so
the password crosses your own network in clear text. Put it behind a TLS proxy if you
expose it beyond your LAN.

Logout revokes the session id server-side, so "sign out" ends the session instead of
just hiding the UI — the cookie stops working immediately.

## Isolation (read this before pointing it at your real agent)

A spawned agent CLI inherits the server's environment. With `HERMES_HOME` unset,
`hermes acp` falls back to *your live* `~/.hermes` — the same `state.db` your running
gateway has open. Two writers on one WAL SQLite is how a real user's state.db got
corrupted on 2026-10-02 (Hermes' bundled SQLite 3.50.4 has the WAL-reset bug).

So the server is **fail-closed**: it resolves an explicit home for every backend that
owns one, ignores an *inherited* `HERMES_HOME` (a Hermes-launched shell leaks the live
one down), and refuses to spawn when the resolved home equals the live home unless you
say `AGENTSLOT_ALLOW_LIVE_HOME=1`. `GET /api/backends` reports `home` / `warnings` /
`blocked` and the new-slot dialog shows them.

`scripts/setup-hermes-test-home.py` builds that home: config derived from yours with
`mcp_servers: {}`, memory off (the embedded Hindsight instance is named by
`hindsight/config.json`'s `profile`, whose default `"hermes"` would attach a fresh home
to your production memory daemon), and `.env` copied 0600.

## What it does today (M0 → M4)

- multi-session rail — live slots + **cold slots** (transcripts whose process exited;
  click to respawn + `loadSession` resume, re-applying the stored permission mode/effort),
  with search across both by title / backend / cwd
- streaming render of `agent_message_chunk` / `agent_thought_chunk`, tool calls
  (upserted by `toolCallId`, never appended; expand a card for the agent's input/output),
  plan updates, usage
- **context-window gauge** per slot from ACP `usage_update` (warns at 65% / 85%; degrades
  to used-only when the agent reports no window size) and a per-turn trace chip showing the
  effort/mode a turn actually runs with
- **slash-command palette** driven by the agent's own `available_commands_update`
  (filter, ↑/↓, Tab to accept, Esc) — never an invented command list
- permission cards (allow / always allow / reject / dismiss) wired to ACP's
  server→client `requestPermission`, with a pending-count chip and a timeout so a session
  can't wedge
- permission mode + reasoning-effort switches (`setSessionMode` / `setSessionConfigOption`),
  persisted per session
- SQLite transcript with monotonic per-session `seq`; reconnect replays only the tail;
  long slots **page** backwards ("load earlier") instead of truncating
- orphan reaping: every child is spawned detached and its pid recorded, so a crashed
  server's leftovers are killed on next boot
- offline-tolerant: WS reconnect with an outbox (taps while disconnected are queued,
  not swallowed), offline app shell via service worker
- PWA + phone layout: drawer rail, thumb-sized controls, safe-area padding,
  16px inputs (no iOS zoom), no horizontal overflow at 390px

## Tests

```bash
npm run typecheck
npm run auth-smoke                        # 30 assertions: the lock, both credentials
node scripts/smoke.mjs mock "hello"      # end-to-end against the mock agent
```

`auth-smoke` boots its own servers on scratch ports with throwaway data dirs, so it
runs anywhere (CI included) and covers: anonymous REST/WS refusal, brute-force
lockout, cookie signing and tamper detection, expiry, WS-via-cookie, the machine
token, logout revocation, and the `AGENTSLOT_AUTH=off` escape hatch.

Browser QA evidence (44 rounds, each with repro → root cause → fix → regression)
lives in [`m1-qa-log.md`](./m1-qa-log.md). The `mock` backend triggers extra paths on
demand: `[tool]` (permission flow), `[think]`, `[plan]`, `[slow]` (reconnect drills),
`[sink]` (mid-turn child crash).

## License

Apache-2.0. See [NOTICE](./NOTICE) for the AionUi inspiration credit (ideas only —
no code copied).