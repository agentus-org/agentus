# Agentus

[English](README.md) | [简体中文](README.zh-CN.md)

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

## Install

```bash
# public one-liner — the published package (Node >= 22.5; the store is node:sqlite)
npx agentus                      # …or: npm i -g agentus, then `agentus`
# open http://localhost:8788 and log in (admin / 123456 — see "Login" below),
# then "+ new session", pick a backend + a working directory
```

Or run the installer straight from the repository — same install, plus a Node check and a
per-user fallback (`sudo` never):

```bash
curl -fsSL https://raw.githubusercontent.com/agentus-org/agentus/main/scripts/install.sh | bash
```

Full guide — install, flags, every environment variable, login, TLS, the phone bridge:
[`docs/installation.md`](docs/installation.md) · [中文](docs/installation.zh-CN.md).

`npx agentus` runs the cockpit in the foreground — Ctrl-C stops it, and it takes its agent
children with it. Flags: `--port 9000`, `--data <dir>`, `--open` (open the browser once it
is up), `--where` (print the paths the server actually resolved — data dir, web bundle,
companion APK — and exit without starting anything).

**The one prerequisite npm cannot install for you is an agent CLI**: `hermes acp` (install
Hermes on your PATH; `hermes acp --check` self-checks) or `qodercli --acp` (`qodercli login`
first, else `newSession` fails with `-32000`). Without one the cockpit still runs and still
logs in — you just have no backend to start a session on.

A plain Hermes install drives sessions; the cockpit's own extras — per-session **thinking
depth**, a permission mode that survives a restart, the **context-budget** field, the **status
channel** (memory recall/save hints in the message stream), per-process skill roots, **project
skills made visible and switchable** (a repo's `.agents/skills` shows up as a `project_skills`
option instead of being skipped in silence), **background-job completion wake-ups** (a finished
background process comes back as a turn of its own), and a **DeepSeek web backend** (search +
extract on the model key) — come from the fork's integration build instead. That is a five-line install:
[§ Which Hermes to run](docs/installation.md#which-hermes-to-run) — currently the tag
`agentus/v0.22.0/merge-20261019-2348`, on Hermes `v0.22.0`.

The first slot you start will use the Hermes home **your own agent already uses**
(`~/.hermes`) unless the backend row names another one — see "HERMES_HOME" below.

### From a checkout (development)

```bash
git clone https://github.com/agentus-org/agentus.git
cd agentus
npm start                     # installs if needed, builds, serves (scripts/start.sh)
npm run dev -w @agentus/web   # front-end hot reload (Vite :5173, host: true → reachable over LAN)
npm run agentus               # the same CLI as `npx agentus`, straight from the checkout
```

**Working on Agentus itself?** The bootstrapping manual is in
[`docs/dev/`](docs/dev/README.md): run a dev instance beside live, prove a change with the
browser sweeps, promote it to live, and what to do when live breaks. Written for a human
*and* for a coding agent you point at this repo.

`npm start` (→ `scripts/start.sh`) checks the Node version, installs dependencies with
`NODE_ENV=development` when `node_modules` is missing, builds when the web bundle is
stale, then serves. Use `AGENTUS_PORT=9000 npm start` to move the port.

### Where your state lives

`~/.agentus` by default — `agentus.sqlite` (sessions and transcript), `credentials.json`,
`auth.token` (the machine credential), `auth.secret`, `settings.json`. It is
created 0700 on first boot, and the boot log prints it **and why that directory won**:

| order | rule |
|---|---|
| 1 | `AGENTUS_DATA` when it is set — every launcher and dev/QA instance pins this |
| 2 | `~/.agentus` once it holds something, or when there is no repo-side data yet |
| 3 | `<repo>/packages/server/.data` — an existing checkout that predates this layout |

Rule 3 is not a nicety: an install that quietly switched directories would come up with an
empty session list, which reads exactly like "my sessions are gone". To move such a
checkout over, boot it once with `AGENTUS_DATA=~/.agentus`. `agentus --where` prints what
the server resolved, rather than making you guess.

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
| `AGENTUS_PORT` | `8788` | server port (never reads bare `PORT` — that name is polluted on shared hosts) |
| `AGENTUS_DATA` | `~/.agentus` | where state lives; see "Where your state lives" for the full order (`<repo>/packages/server/.data` on a checkout that already has one) |
| `AGENTUS_TITLE` | `Agentus` | this instance's own name: the browser tab title and the PWA/home-screen label. Set it when one person runs several cockpits (`AGENTUS_TITLE="Agentus（pre-betabox）"`) |
| `AGENTUS_HERMES_CMD` | `hermes` | binary to spawn for the hermes backend |
| `AGENTUS_QODER_CMD` | `~/.local/bin/qodercli` | ditto for qoder |
| `AGENTUS_HERMES_HOME` | `~/.hermes` | default `HERMES_HOME` for a row that does not name one (the operator's own home) |
| `AGENTUS_PERM_TIMEOUT_MS` | `300000` (5 min) | how long a permission prompt waits before auto-cancelling |
| `AGENTUS_HISTORY_PAGE` | `500` | transcript page size (also set small in tests to exercise paging) |
| `AGENTUS_TERM_PTY` | unset | `1` = run the workspace terminal through Python's stdlib `pty` (real tty; needs `python3`) instead of pipes |
| `AGENTUS_TERM_CMD` | unset | override the terminal command line entirely (e.g. `socat …`), space-separated |
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
`<lan-ip>:8788`. That gives you two independent locks — Basic at the edge of the app, the
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

#### TLS: terminated in front, not in-process

A plain TCP tunnel (SakuraFrp, safe-nat, `ssh -L`, most frp setups) forwards bytes — it does
**not** terminate TLS for you. Point one at `:8788` and the operator's password and session
cookie would cross the internet in clear text. So terminate TLS **in front of Agentus** — a
reverse proxy (Caddy/nginx) or a tunnel that does its own `public_tls` — and let this process
speak plain HTTP:

| port | speaks | for |
|---|---|---|
| `AGENTUS_PORT` (8788) | plain HTTP | LAN, loopback, `curl`, scripts — no cert warning, CI unchanged; **the only listener** |

Certificate lifecycle (issuing, rotation, SAN) stays in that front layer and never touches the
app, and the LAN path stays warning-free. Nothing is lost on the cookie side either: the handler
reads `X-Forwarded-Proto` (`packages/server/src/auth.ts`), so a request that arrived over TLS at
the front layer still gets a `Secure` session cookie — Caddy and nginx both set that header by
default.

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

## The cockpit CLI (for the agents inside it)

An agent in a slot is blind: the other sessions, what they are doing, and what the operator
asked them all live in the cockpit, not in the agent's prompt. `agentus cockpit` is the one
channel that lets an agent read that — and, if you allow it, hand a message to another session:

```bash
"$AGENTUS_COCKPIT_BIN" capabilities                    # the contract, self-describing (start here)
"$AGENTUS_COCKPIT_BIN" session list --here             # …narrowed: my workspace, newest activity first
"$AGENTUS_COCKPIT_BIN" session list --waiting --table  # …the operator's approval queue, as a table
"$AGENTUS_COCKPIT_BIN" session rename <id> "…name…"    # name a session (the row records who did it)
"$AGENTUS_COCKPIT_BIN" session show <id>               # one session, + what it is waiting on
"$AGENTUS_COCKPIT_BIN" session messages <id> --tail 20
"$AGENTUS_COCKPIT_BIN" session plan <id>
"$AGENTUS_COCKPIT_BIN" session send <id> "…a message…"  # operator-gated, off by default
"$AGENTUS_COCKPIT_BIN" skill                           # this CLI's own manual, from the package
```

The shape is noun-then-verb (`agentus session send <id> …`) because every one of these acts on the
same object; the session id is a positional argument, options stay options.

The cockpit hands `AGENTUS_COCKPIT_BIN/_ENDPOINT/_TOKEN/_SESSION` to each agent it spawns, so
the CLI needs no arguments, no port and no config — and the token never appears on a command
line. `AGENTUS_COCKPIT_BIN` is this same `agentus` launcher, so there is one command with one
name; `agentus cockpit …` at your own shell is the identical thing. Delivering a message (**设置 → 驾驶舱互发消息**, off by default) means the target agent
*received* it, never that it read or agreed; a busy target refuses with `target_busy` and saw
nothing.

The manual is `skills/agentus-cockpit/SKILL.md`, shipped in the package. Backends with a native
skills directory (Hermes: `$HERMES_HOME/skills`) get it installed at spawn — idempotently, by
content, so a release that changes it refreshes it and a spawn that would not costs nothing.
Backends without one (Qoder) get a single line in the plan reminder and can read the same file
with `agentus cockpit skill`, which is also why the document is never pasted into a prompt.

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
npm run backend-smoke                     # 42: the backend registry, spawn env, health evidence
npm run workspace-smoke                   # 85: workspace field, file API, shell, attachments
npm run voice-smoke                       # 47: settings/theme guards, voice router, 百炼 shapes
npm run package-smoke                     # packs, installs into a throwaway prefix + HOME, boots
                                          # that install, drives a mock turn, checks ~/.agentus
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