#!/usr/bin/env bash
# AgentSlot one-command start.
#
#   ./scripts/start.sh            # install if needed, build the web app, serve
#   AGENTSLOT_PORT=9000 ./scripts/start.sh
#
# AgentSlot has no agent runtime of its own: it spawns `hermes acp` / `qodercli --acp`
# on demand, so a slot only starts costing anything when you open one.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${AGENTSLOT_PORT:-8787}"

# node:sqlite (the zero-dependency store) landed in Node 22.5 — check before anything else.
node -e '
const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error(`AgentSlot needs Node >= 22.5 (node:sqlite); found ${process.versions.node}`);
  process.exit(1);
}
'

if [ ! -d node_modules ]; then
  echo "[agentslot] installing dependencies (NODE_ENV=development so devDeps land)…"
  NODE_ENV=development npm install
fi

# Build the shared types + web bundle when missing or stale (the server serves dist/).
need_build=0
[ -f packages/web/dist/index.html ] || need_build=1
if [ -d packages/web/src ] && [ -n "$(find packages/web/src packages/shared/src -newer packages/web/dist/index.html -print -quit 2>/dev/null)" ]; then
  need_build=1
fi
if [ "$need_build" = 1 ]; then
  echo "[agentslot] building…"
  NODE_ENV=development npm run build >/dev/null
fi

echo "[agentslot] starting on :${PORT} (open http://localhost:${PORT})"
if [ -z "${AGENTSLOT_PASSWORD:-}" ] && [ "${AGENTSLOT_AUTH:-on}" != "off" ]; then
  echo "[agentslot] login: admin / 123456 (default) — set AGENTSLOT_PASSWORD to change it."
  echo "[agentslot] scripts: the machine token is written to packages/server/.data/auth.token"
fi
export AGENTSLOT_PORT="$PORT"
export NODE_ENV="${NODE_ENV:-development}"
exec node_modules/.bin/tsx watch packages/server/src/index.ts
