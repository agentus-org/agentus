#!/usr/bin/env bash
# Agentus one-command start.
#
#   ./scripts/start.sh            # install if needed, build the web app, serve
#   AGENTUS_PORT=9000 ./scripts/start.sh
#   AGENTUS_WATCH=1 ./scripts/start.sh   # dev only: reload server files on change
#
# The server runs ONCE here (no watcher): a reload would SIGTERM every live `hermes acp`
# slot, so the normal-install path trades hot reload for an explicit restart on release.
#
# Agentus has no agent runtime of its own: it spawns `hermes acp` / `qodercli --acp`
# on demand, so a slot only starts costing anything when you open one.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${AGENTUS_PORT:-8787}"

# node:sqlite (the zero-dependency store) landed in Node 22.5 — check before anything else.
node -e '
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(`Agentus needs Node >= 22.5 (node:sqlite); found ${process.versions.node}`);
  process.exit(1);
}
'

if [ ! -d node_modules ]; then
  echo "[agentus] installing dependencies (NODE_ENV=development so devDeps land)…"
  NODE_ENV=development npm install
fi

# Build the shared types + web bundle when missing or stale (the server serves dist/).
need_build=0
[ -f packages/web/dist/index.html ] || need_build=1
if [ -d packages/web/src ] && [ -n "$(find packages/web/src packages/shared/src -newer packages/web/dist/index.html -print -quit 2>/dev/null)" ]; then
  need_build=1
fi
if [ "$need_build" = 1 ]; then
  echo "[agentus] building…"
  NODE_ENV=development npm run build >/dev/null
fi

echo "[agentus] starting on :${PORT} (open http://localhost:${PORT})"
if [ -z "${AGENTUS_PASSWORD:-}" ] && [ "${AGENTUS_AUTH:-on}" != "off" ]; then
  echo "[agentus] login: admin / 123456 (default) — set AGENTUS_PASSWORD to change it."
  echo "[agentus] scripts: the machine token is written to packages/server/.data/auth.token"
fi
export AGENTUS_PORT="$PORT"
export NODE_ENV="${NODE_ENV:-development}"

# No `tsx watch` by default: a reload restarts the whole server, which SIGTERMs every live
# `hermes acp` slot mid-turn (measured 2026-10-06 — publishing cut the operator's own
# session). This path is the normal install one: the server runs once, and a release is an
# explicit verified restart (scripts/relaunch.sh). Watch mode is a development convenience:
#   AGENTUS_WATCH=1 ./scripts/start.sh
if [ "${AGENTUS_WATCH:-0}" = "1" ]; then
  echo "[agentus] watch mode ON — server files reload themselves (dev only)"
  exec node_modules/.bin/tsx watch packages/server/src/index.ts
fi
exec node_modules/.bin/tsx packages/server/src/index.ts
