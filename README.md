# AgentSlot

**Keep your agents on the track.** A multi-slot web cockpit for ACP-speaking coding
agents: open several sessions in the browser, each one backed by a real
`hermes acp` / `qodercli --acp` subprocess, and drive them from any device.

> **Red line:** the UI holds *zero* intelligence. No agent loop, no model calls, no
> prompt engineering. The server does exactly five things — spawn a child, relay ACP
> JSON-RPC, stream events to the browser, persist the transcript, surface permission
> prompts. Reasoning lives in the CLI processes.

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
# open http://localhost:8787, "+ new slot", pick a backend + working directory
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
node scripts/smoke.mjs mock "hello"      # end-to-end against the mock agent
```

Browser QA evidence (28+ rounds, each with repro → root cause → fix → regression)
lives in [`m1-qa-log.md`](./m1-qa-log.md). The `mock` backend triggers extra paths on
demand: `[tool]` (permission flow), `[think]`, `[plan]`, `[slow]` (reconnect drills),
`[sink]` (mid-turn child crash).

## License

Apache-2.0. See [NOTICE](./NOTICE) for the AionUi inspiration credit (ideas only —
no code copied).