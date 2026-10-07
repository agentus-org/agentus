# Agentus

**Keep your agents on the track.** A multi-session web cockpit for ACP-speaking coding
agents: open several sessions in the browser, each one backed by a real
`hermes acp` / `qodercli --acp` subprocess, and drive them from any device.

> **Red line:** the UI holds *zero* intelligence. No agent loop, no model calls, no
> prompt engineering. The server does exactly six things — gate access, spawn a child,
> relay ACP JSON-RPC, stream events to the browser, persist the transcript, surface
> permission prompts. Reasoning lives in the CLI processes.

```
[browser React SPA]  ──HTTP + WS──▶  [Agentus server]  ──ACP/JSON-RPC over stdio──▶  [hermes acp | qodercli --acp]
                                         · session registry (who runs, where, pid)
                                         · ACP client (ClientSideConnection)
                                         · event fan-out → WS, commands → ACP
                                         · SQLite transcript + resume
```

## Quick start

```bash
# Node >= 22.5 (needs node:sqlite; developed on v25)
git clone https://github.com/agentus/agentus.git
cd agentus

# 1) run it — installs if needed, builds, serves
npm start
# open http://localhost:8787 and log in (admin / 123456 — see "Login" below),
# then "+ new session", pick a backend + working directory
```

The first slot you start will use the Hermes home **your own agent already uses**
(`~/.hermes`) unless the backend row names another one — see "HERMES_HOME" below.

`npm start` (→ `scripts/start.sh`) checks the Node version, installs dependencies with
`NODE_ENV=development` when `node_modules` is missing, builds when the web bundle is
stale, then serves. Use `AGENTUS_PORT=9000 npm start` to move the port.

For front-end hot reload instead: `npm run dev -w @agentus/web` (Vite on :5173,
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
| `AGENTUS_PORT` | `8787` | server port (never reads bare `PORT` — that name is polluted on shared hosts) |
| `AGENTUS_DATA` | `packages/server/.data` | SQLite location |
| `AGENTUS_HERMES_CMD` | `hermes` | binary to spawn for the hermes backend |
| `AGENTUS_QODER_CMD` | `~/.local/bin/qodercli` | ditto for qoder |
| `AGENTUS_HERMES_HOME` | `~/.hermes` | default `HERMES_HOME` for a row that does not name one (the operator's own home) |
| `AGENTUS_PERM_TIMEOUT_MS` | `300000` (5 min) | how long a permission prompt waits before auto-cancelling |
| `AGENTUS_HISTORY_PAGE` | `500` | transcript page size (also set small in tests to exercise paging) |
| `AGENTUS_TERM_PTY` | unset | `1` = run the workspace terminal through Python's stdlib `pty` (real tty; needs `python3`) instead of pipes |
| `AGENTUS_TERM_CMD` | unset | override the terminal command line entirely (e.g. `socat …`), space-separated |
| `AGENTUS_TLS_PORT` | `8443` when a cert exists, else off | **second listener, TLS** — the one a public tunnel points at (`0` disables it) |
| `AGENTUS_TLS_CERT` / `AGENTUS_TLS_KEY` | `<AGENTUS_DATA>/tls/{cert,key}.pem` | cert material for that listener (see `scripts/make-cert.sh`) |
| `AGENTUS_TTS_BASE_URL` | unset | OpenAI-compatible base for **server** speech synthesis (`…/v1`). Unset = browser voices only |
| `AGENTUS_TTS_API_KEY` / `AGENTUS_TTS_MODEL` / `AGENTUS_TTS_VOICE` | – / `tts-1` / `alloy` | ditto |
| `AGENTUS_STT_BASE_URL` | unset | OpenAI-compatible base for **server** transcription. Unset = browser recognition only |
| `AGENTUS_STT_API_KEY` / `AGENTUS_STT_MODEL` / `AGENTUS_STT_LANGUAGE` | – / `whisper-1` / – | ditto |
| `DASHSCOPE_API_KEY` / `DASHSCOPE_BASE_URL` | – | 百炼 (DashScope) credentials. Read from the process env **and** from `~/.hermes/.env`, because the server is usually started from a plain shell |

The voice/theme variables are a **bootstrap only**: the settings page (⚙ in the rail)
owns the provider, endpoint, key, models, hotword list and the palette, and stores them
in `<AGENTUS_DATA>/settings.json` (0600, key never sent back to the browser). What the
page says wins; the env is what makes a fresh checkout work before anyone opens it.

## Login

The cockpit is behind a login by default — this thing spawns processes that write to
your disk, so an open port is a remote shell waiting to happen.

```
username: admin
password: 123456     (default — change it)
```

Change it **in the app**: Settings → 账号 (the first card) takes a new username and/or a
new password, applies immediately, and writes `<DATA_DIR>/credentials.json` (0600, scrypt
hash — no plaintext on disk). Changing the password invalidates every other session; the
device that made the change is handed a fresh cookie, so it stays signed in. The current
password is required for any change, including a username-only one.

`AGENTUS_USERNAME` / `AGENTUS_PASSWORD` / `AGENTUS_PASSWORD_HASH` still work as the
bootstrap: they are what the app starts from, and once you save something in the 账号 card
the file wins from then on (the same "settings file > env" order voice and theme use). A
password-only change pins today's password as a hash, so an env value can never quietly
come back into play. Delete `credentials.json` to fall back to the environment.

Account management lives in Settings → 账号 (the same shape as hermes-studio's
AccountSettings, minus the multi-user parts — this cockpit is one operator):

| card | what it does |
|---|---|
| **账号** | change the username or the password (each in a small modal, current password required) |
| **登录会话** | every browser and script holding a session: client, IP, last seen, expiry. Revoke one, or log out everywhere else. Changing the password does the same for the others at once. |
| **登录失败锁定** | the login limiter, visible: which IPs are locked, for how long, with unlock / unlock all — so locking yourself out of your own cockpit is a 1-click problem, not a restart |

Sessions are stateless cookies, so the server keeps an index of them at
`<DATA_DIR>/sessions.json` (0600). It is advisory for display but authoritative for
existence: a cookie that is not in the index, or that was revoked, is refused — that is what
makes revocation and "log out everywhere" real, and it survives a restart. An upgrade from
an older build adopts the cookies that already exist once instead of logging every device
out.

Endpoints behind the login: `POST /api/auth/credentials`, `GET /api/auth/sessions`,
`POST /api/auth/sessions/revoke`, `POST /api/auth/sessions/revoke-others`,
`GET|DELETE /api/auth/locked-ips`.

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
| `AGENTUS_AUTH` | `on` | `off` = no login at all (local hacking; the boot log will scold you) |
| `AGENTUS_USERNAME` | `admin` | operator name |
| `AGENTUS_PASSWORD` | `123456` | operator password (plaintext in env) |
| `AGENTUS_PASSWORD_HASH` | — | `scrypt:<salt>:<hex>`; wins over `AGENTUS_PASSWORD` if set |
| `AGENTUS_SESSION_TTL_MS` | 604800000 (7d) | session lifetime |
| `AGENTUS_AUTH_SECRET` | `<DATA_DIR>/auth.secret` | cookie signing key (0600, auto-minted) |
| `AGENTUS_AUTH_TOKEN` | `<DATA_DIR>/auth.token` | machine token (0600, auto-minted) |
| `AGENTUS_LOGIN_MAX_FAILS` / `AGENTUS_LOGIN_LOCK_MS` | `5` / `30000` | per-IP brute-force lockout |
| `AGENTUS_BASIC_AUTH` | — | an HTTP Basic challenge in front of **everything** (including `/healthz` and the WS upgrade). `user:pass` checks both; `:pass` (or a bare `pass`) checks **only the password** and accepts any username. This is the outer lock you want before exposing a tunnel; see "Exposing it publicly". |

### Exposing it publicly (tunnel / reverse proxy)

Put `AGENTUS_BASIC_AUTH=:pass` in the server's environment, then point the tunnel at
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
- **`AGENTUS_BASIC_AUTH`**, when the tunnel has no gate, is a plain TCP forward, or you
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

#### TLS: a second listener, on purpose

A plain TCP tunnel (SakuraFrp, safe-nat, `ssh -L`, most frp setups) forwards bytes — it
does **not** terminate TLS for you. Point one at `:8787` and the operator's password and
session cookie cross the internet in clear text. So the server can speak TLS itself:

```bash
scripts/make-cert.sh                    # self-signed, SAN = the name you actually type
# -> packages/server/.data/tls/{cert.pem,key.pem} (0600, git-ignored)
# boot log then says: https://0.0.0.0:8443 (self-signed …) ; point a tunnel at THIS port
```

| port | speaks | for |
|---|---|---|
| `AGENTUS_PORT` (8787) | plain HTTP | LAN, loopback, `curl`, scripts — no cert warning, CI unchanged |
| `AGENTUS_TLS_PORT` (8443) | HTTPS (self-signed) | **the tunnel** — encrypts the public hop |

Same handler, same routes, same auth; only the socket differs. Two listeners beat both
alternatives: turning the single port into HTTPS would put a cert warning in front of your
own LAN usage (and break `curl` scripts), while sniffing the first byte on one port to
serve both hides whether a given visit was really encrypted.

**Retiring the warning on your devices.** With TLS on, the listener serves its own
certificate at `/cert.crt`:

```bash
https://<your-name>:<tls-port>/cert.crt     # iOS: opens the profile installer directly
                                            # Android: downloads it → Settings → Security → CA certificate
curl --cacert <AGENTUS_DATA>/tls/cert.pem https://<your-name>:<tls-port>/healthz   # scripts, no -k
```

Installed as a trusted root (iOS also needs *About → Certificate Trust Settings → enable*),
the browser stops asking and the address bar is clean. It is public material — the private
key never leaves `<AGENTUS_DATA>/tls/`.

The cert is **self-signed on purpose** — no CA issues for an unregistered domain or a bare
IP, so the browser shows "not private → proceed" once per device, and installing the issuer
(`/cert.crt`, above) retires even that. Keep the SAN to the name you type (**the DDNS name**,
not the public IP: a dynamic IP would need re-issuing, and a mismatch adds a second warning).

`make-cert.sh` issues **two** certs on purpose: a 10-year root (`ca.pem`, what devices
install) and a 390-day leaf (`cert.pem`, what the listener serves). Apple caps *server
certificate* validity at 398 days — a 10-year self-signed leaf is precisely what iOS refuses
*after* the user has been through the install dance. A root is not a server cert, so it can
live long; rotating the leaf (`--leaf-only`) never touches an installed device.

`npm run tls-smoke` (in CI, real sockets) guards all of it: a verifying client must be
*rejected* (that is what proves the port is actually TLS), the leaf must chain to the root
`/cert.crt` hands out and stay under the 398-day cap, the API login and `wss://…/ws` handshake
must work over TLS (the upgrade handler is bound to both listeners — the easy thing to
forget), and the LAN port must stay plain.

Logout revokes the session id server-side, so "sign out" ends the session instead of
just hiding the UI — the cookie stops working immediately.

## HERMES_HOME (which data directory a slot reads and writes)

A spawned agent CLI inherits the server's environment, so the server **always sets
`HERMES_HOME` explicitly**: the row's own home if it names one, otherwise the default —
**your real `~/.hermes`**, the same `state.db` your gateway and Studio have open. That is
the intended production setting: a slot drives your actual agent, with your config,
credentials, memory and session list.

An *inherited* `HERMES_HOME` is ignored (a Hermes-launched shell leaks its own down), so
where a slot writes is always something you chose — on the row, or in
`AGENTUS_HERMES_HOME`.

To keep one slot's data separate (a clean session list, a different profile, a throwaway
experiment), name a directory in that row's HERMES_HOME — no permission needed. The
early-dev **isolation guard** is gone: it refused the real home outright because Hermes'
bundled SQLite 3.50.4 (inside the WAL-reset range) corrupted a real `state.db` when two
writers shared one WAL file (2026-10-02). The runtime now links SQLite 3.53.1, and sharing
one home is what Hermes itself already does all day (gateway + Studio bridge), so the
cockpit no longer gets in the way.

A row that points at its own home needs no permission — only a name. One trap survives when
a row points elsewhere: a fresh home whose `hindsight/config.json` keeps the default profile
name `"hermes"` would attach to your production memory daemon, so the row warns when it would.

## What it does today (M0 → M4)

- multi-session rail, **grouped by working directory** — running sessions and **closed
  cases** (transcripts whose process exited;
  click to respawn + `loadSession` resume, re-applying the stored permission mode/effort),
  with search across both by title / backend / cwd
- **sessions name themselves**: the agent's own title (ACP `session_info_update` — Hermes
  generates one in the turn prologue) is adopted as-is, and a backend that never sends one
  still gets a name derived from the first prompt (first line, markdown stripped, ≤50 chars);
  the menu's **重新生成会话名** asks the agent to name the conversation from its CURRENT
  content, on a throwaway `session/fork`, so the session's own transcript is untouched
- streaming render of `agent_message_chunk` / `agent_thought_chunk`, tool calls
  (upserted by `toolCallId`, never appended), plan updates, usage. A tool call is one
  compact line — status dot, truncated title, chevron — and shows the full name, kind,
  status, input and output only when expanded (a transcript of twenty calls stays
  readable)
- **context-window gauge** per session from ACP `usage_update` (warns at 65% / 85%; degrades
  to used-only when the agent reports no window size) and a per-turn trace chip showing the
  effort/mode a turn actually runs with
- **slash-command palette** driven by the agent's own `available_commands_update`
  (filter, ↑/↓, Tab to accept, Esc) — never an invented command list
- **fork a session** (ACP `session/fork`, an unstable capability Hermes does offer): the
  agent copies the parent's context into a new session, which comes up here as a session
  of its own — same workspace, same modes, independent from then on
- permission cards (allow / always allow / reject / dismiss) wired to ACP's
  server→client `requestPermission`, with a pending-count chip and a timeout so a session
  can't wedge
- permission mode + reasoning-effort switches (`setSessionMode` / `setSessionConfigOption`),
  persisted per session
- SQLite transcript with monotonic per-session `seq`; reconnect replays only the tail;
  long transcripts **page** backwards ("load earlier") instead of truncating
- orphan reaping: every child is spawned detached and its pid recorded, so a crashed
  server's leftovers are killed on next boot
- offline-tolerant: WS reconnect with an outbox (taps while disconnected are queued,
  not swallowed), offline app shell via service worker
- PWA + phone layout: drawer rail, thumb-sized controls, safe-area padding,
  16px inputs (no iOS zoom), no horizontal overflow at 390px
- a head with **two** controls: which directory this session works in, and the workspace
  panel. Everything that was up there moved next to the prompt where it belongs
- **workspace panel** (head ▤): a read-only file browser (breadcrumb, sizes, text
  preview) and a shell rooted in the session's workspace, both killed with the socket.
  Cwd is a per-session field: a *running* agent keeps the directory it was started in,
  the panels and the next resume follow the one you pick
- **replies rendered as markdown** (markdown-it + highlight.js, sanitised with DOMPurify
  and `html: false`, so an agent's `<script>` stays visible text): headings, lists,
  tables, quotes, fenced code with a language label, copy button and syntax colouring
- **the agent's own knobs, placed the way ACP intends**: the model button prints the
  model alone ("qwen3.8-flash"); its list is grouped by provider and collapsible (Hermes
  offers 501 models — a flat list is unusable); thinking depth shows nothing but a small scale
  (seven ticks, filled to the level, coloured grey→red), so a phone-width row still fits
  the send button: a thinking-depth button and a
  model button, each reading the agent's advertised options (`configOptions[].category`,
  falling back to the option id) — and hidden when the agent offers none. Model switching
  uses ACP `session/set_model`, which Hermes implements (the SDK in use does not type it,
  so it goes through the generic request() overload)
- **the context window is yours to declare**: click the usage line to set the window the
  gauge measures against, per session, persisted. ACP has no method to change a model's
  window (it is the provider's property — that is what `usage_update.size` reports), so
  this number only drives the gauge; switching models is the real lever
- composer that reads like a chat box, not a toolbar: attachments (`+`), settings
  (permission mode · thinking depth · voice) and dictation live on one row under the
  input, the context/spend line is small type *above* it, and send turns into stop
  while a turn runs
- **attachments** as real ACP content blocks: images (`type: "image"`), text files
  inlined with a filename header, links as `resource_link`. Only file names are
  persisted — never the bytes
- **voice, both directions, browser-first**: read any reply aloud (per-message button
  plus an auto-read toggle, voice picker, speed), dictate a prompt (live interim words).
  A server endpoint is optional and only a proxy (`AGENTUS_TTS_BASE_URL` /
  `AGENTUS_STT_BASE_URL`); with nothing configured, the browser does the work and the
  UI says so
- **voice call mode** (📞 in the chat header): a full-screen call with the session — a canvas
  orb that rides real audio, one colour per phase (listening / thinking / speaking / error,
  announced to a screen reader), the reply read sentence by sentence as it streams, and
  **barge-in that actually takes the floor**: talking over the reply stops our playback,
  *cancels the agent's turn* and hands the microphone back. Its thresholds are knobs on the
  call itself (⚙ in the corner): 抢话灵敏度 (0-100 %, higher = easier to interrupt, 60 % by
  default), 抢话持续时间, 说完停顿 and 最少字数 (3 by default) — a phone on a table leaks its
  own loudspeaker into its own microphone, a headset does not, so these are per-installation
  settings (stored server-side, shared across devices) rather than constants. `最少字数` gates
  only the automatic send; a tap on the orb always sends. While a call is open it owns the
  voice: the auto-read of the same reply stands down, and a call reads **this turn's** answer
  only — never the answer to the question before it
- **settings page** (⚙ in the rail): theme (light / dark / follow-the-OS, plus an accent
  colour that retints the whole cockpit), the speech provider, endpoint and key, the
  models (picked from the endpoint's own list), the hotword list, and a test button for
  each direction. Everything the operator chooses — theme, speech endpoint, the call's
  thresholds, and the talk-to-agent preferences (read replies aloud, voice, speed,
  language, recogniser, server-side synthesis) — is a **row in the store's `settings`
  table** (`voice` / `theme` / `call` / `prefs`, one row per section), not a file beside it
  and not a browser's localStorage: settings follow the operator from the phone to the
  laptop, and two tabs of one instance cannot disagree. A pre-store `settings.json` is
  imported once and kept as `.imported`; the browser keeps a copy of each section only so
  the first frame is already right
- **百炼 (DashScope) speech, first-class**: streaming recognition over its inference
  WebSocket (`qwen-audio-3.1-asr-flash-streaming` — words appear as they are spoken),
  batch recognition over the OpenAI-compatible chat route (`qwen3-asr-flash`), synthesis
  via `SpeechSynthesizer` (`qwen-audio-3.0-tts-flash`, voices such as `longanhuan_v3.6`).
  The browser cannot open that socket (the handshake needs an auth header) and the key
  must not leave the server, so the cockpit owns the upstream connection and the browser
  relays PCM through `/ws/asr`
- **hotwords, fixed and dynamic**: a fixed list (`词=权重`, `50` = super-hotword) that goes
  into the recogniser's instant vocabulary, plus entity terms mined from this session's
  own transcript and its neighbours — merged, deduped, capped, and previewable on the
  settings page
- a session's dictation carries **that session's context** (its last few turns) as the
  recogniser's bias, which is what keeps product names and identifiers intact
- streaming that does not fight the reader: a wheel/touch gesture detaches instantly,
  new output is announced by a "jump to newest" button instead of yanking the viewport
- workspace picker: browse the server's directories (`GET /api/fs/dirs`, one level at a
  time) or pick from the working directories you used before; the same picker re-points
  an existing session

## Naming

The UI says **session** everywhere (the rail, the empty state, the dialogs). "Slot" is
only the project's name — the concept an operator works with is a session, and the
product may well be renamed; nothing in the interface leans on the metaphor.

Names have two layers: `title` is what the rail shows, `auto_title` is the generated name it
falls back to. A generated name (the agent's, or ours derived from the first prompt) never
overwrites a hand-written one; clearing a rename restores it; and an explicit
**重新生成会话名** replaces it on purpose. Regeneration goes through the agent, not through a
model of our own: we fork the session, the fork summarises the copied history, and the fork is
discarded — our layer still holds no intelligence (red line D).

Session actions live on a per-session menu (⋯ / right-click / phone long-press):
rename (in place, reversible — clearing it restores the generated name), **regenerate the
name from the current conversation**, fork, workspace, **export**
(`GET /api/sessions/:id/export?format=md|json` — rendered from our own persisted
transcript, so an archived session exports without waking the agent; ACP itself has
no export concept), copy id, archive (= close: process exits, record kept) and,
for archived slots, resume or delete.

## Tests

```bash
npm run typecheck
npm run auth-smoke                        # 48 assertions: the lock, both credentials
npm run workspace-smoke                   # 45: workspace field, file API, shell, attachments
npm run voice-smoke                       # 47: settings/theme guards, voice router, 百炼 shapes
node scripts/smoke.mjs mock "hello"       # end-to-end against the mock agent
```

Every suite boots its own server on a scratch port with a throwaway data dir, so they run
anywhere (CI included):

- `auth-smoke` — anonymous REST/WS refusal, brute-force lockout, cookie signing and tamper
  detection, expiry, WS-via-cookie, the machine token, logout revocation, `AGENTUS_AUTH=off`.
- `workspace-smoke` — the per-session workspace, the read-only file API, the PTY shell,
  attachments on a prompt, the voice endpoint guards.
- `voice-smoke` — the settings/theme contract (validation, masking, 0600 file), the voice
  router against a stand-in endpoint (OpenAI-compatible **and** 百炼's native shapes),
  hotword merging and capping, and the `.env` bootstrap with an empty `$HOME`.

Browser QA evidence (63 rounds, each with repro → root cause → fix → regression)
lives in [`m1-qa-log.md`](./m1-qa-log.md). The `mock` backend triggers extra paths on
demand: `[tool]` (permission flow), `[think]`, `[plan]`, `[slow]` (reconnect drills),
`[sink]` (mid-turn child crash).

## License

Apache-2.0. See [NOTICE](./NOTICE) for the AionUi inspiration credit (ideas only —
no code copied).