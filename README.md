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
NODE_ENV=development npm install     # NODE_ENV=production silently skips devDeps

# 1) build the isolated Hermes home your test agents will use (see SECURITY note)
python3 scripts/setup-hermes-test-home.py

# 2) run it
AGENTSLOT_PORT=8787 npm run dev -w @agentslot/server
# open http://localhost:8787, "+ new slot", pick a backend + working directory
```

`npm run dev` starts the server (which also serves the built web app).
For front-end hot reload instead, `npm run dev -w @agentslot/web` (Vite, :5173,
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

## What it does today (M1)

- multi-session rail — live slots + **cold slots** (transcripts whose process exited;
  click to respawn + `loadSession` resume, re-applying the stored permission mode/effort)
- streaming render of `agent_message_chunk` / `agent_thought_chunk`, tool calls
  (upserted by `toolCallId`, never appended), plan updates, usage
- permission cards (allow / always allow / reject / dismiss) wired to ACP's
  server→client `requestPermission`, with a timeout so a session can't wedge
- permission mode + reasoning-effort switches (`setSessionMode` / `setSessionConfigOption`),
  persisted per session
- SQLite transcript with monotonic per-session `seq`; reconnect replays only the tail
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

Browser QA evidence for M1 (20+ rounds, each with repro → root cause → fix → regression)
lives in [`m1-qa-log.md`](./m1-qa-log.md).

## License

Apache-2.0. See [NOTICE](./NOTICE) for the AionUi inspiration credit (ideas only —
no code copied).