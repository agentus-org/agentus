# AgentSlot

> Keep your agents on the track.

Multi-session web cockpit for coding agents that speak [ACP](https://agentclientprotocol.com) (Qoder CLI / Hermes). Each session is backed by a real `qodercli --acp` / `hermes acp` subprocess — the UI holds **zero intelligence**: spawn, ACP JSON-RPC relay, streaming render, session persistence, permission prompts.

## Status

M0 skeleton. `npm install && npm run dev` starts server (`:8787`) + web (`:5173`).

## Layout

```
packages/
  server/   Node + TS — the only ACP client; session registry; WS broadcast; SQLite store
  web/      React + Vite SPA
  shared/   message/permission types aligned with AionUi acp.ts (Apache-2.0)
```

Backends are one registry table (`packages/server/src/acp/backends.ts`): adding a backend = one row, never protocol code.

## Credits

This project borrows patterns and types from [AionUi](https://github.com/iOfficeAI/AionUi) (Apache-2.0); see `NOTICE`.
