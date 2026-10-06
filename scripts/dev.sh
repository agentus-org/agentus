#!/usr/bin/env bash
# Two instances, one repo — so developing a round never kills the cockpit you are using.
#
#   bash scripts/dev.sh start|stop|status|logs        # the DEV instance (own port + own data dir)
#   bash scripts/dev.sh promote [<slug>]              # put the tested change on the LIVE tree
#
# Why this exists (measured 2026-10-06): editing a server file while the live cockpit ran under
# `tsx watch` restarted the live server, which killed every live `hermes acp` child — the operator's
# own conversation included: the page went white mid-turn and the turn died. So: edit in a second
# git worktree and run THAT as a second instance, and touch the live one only through `promote`,
# once, after the sweeps are green.
#
# The live server no longer runs under a watcher at all (scripts/start.sh and launch.py both run it
# once), so promote is now the only thing that can move live code, and it does so explicitly:
#   · server-side files (packages/server/src, packages/shared/src) changed -> scripts/relaunch.sh
#     restarts the instance and proves the pid changed (no slot survives, by design — it is a release)
#   · web-only change -> the running server keeps its process; the new bundle is served on reload,
#     so no session is interrupted at all
set -euo pipefail

DEV_PORT="${DEV_PORT:-8901}"                    # the QA sweeps default here (scripts/qa/*.mjs)
DEV_DATA="${DEV_DATA:-/tmp/agentslot-qa-account}"
DEV_USER="${DEV_USER:-scratch}"
DEV_PASS="${DEV_PASS:-scratch-pass-1}"
DEV_LOG="${DEV_LOG:-/tmp/agentslot-dev.log}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"        # the worktree this script lives in (the DEV tree)
LIVE="${LIVE_REPO:-$(cd "$HERE/.." && pwd)/agentslot}"   # the tree the operator's cockpit runs
LIVE_PORT="${LIVE_PORT:-8787}"
LIVE_LAUNCHER="${AGENTSLOT_LAUNCHER:-$HOME/.hermes/cache/agentslot/launch.py}"

pid_on_port() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

# Build the auth header at call time. A literal token must never sit in this file: it would be a
# leaked secret, and the harness redacts token-shaped lines on write — silently turning the header
# into `Bearer ***` (that is exactly how a previous revision of this script broke).
auth_hdr() { printf 'Authorization: Bearer %s' "$(cat "$1" 2>/dev/null)"; }

case "${1:-}" in
  start)
    if [ -n "$(pid_on_port "$DEV_PORT")" ]; then
      echo "[dev] :$DEV_PORT is already in use (pid $(pid_on_port "$DEV_PORT")) — stop it first, or set DEV_PORT"
      exit 1
    fi
    mkdir -p "$DEV_DATA"
    # DETACHED from this shell's process group, or the server dies with the terminal that started it.
    # PORT is deliberately NOT exported: the operator's shell may hold PORT=8648 (Hermes Studio) and
    # a launcher that reads a generic PORT would try to take Studio's port (`EADDRINUSE: 8648`).
    env NODE_ENV=development \
      AGENTSLOT_PORT="$DEV_PORT" AGENTSLOT_DATA="$DEV_DATA" \
      AGENTSLOT_USERNAME="$DEV_USER" AGENTSLOT_PASSWORD="$DEV_PASS" \
      AGENTSLOT_HERMES_CMD="${AGENTSLOT_HERMES_CMD:-$HOME/.hermes/cache/agentslot/hermes-acp-src}" \
      AGENTSLOT_TLS_PORT="${AGENTSLOT_TLS_PORT:-0}" \
      DEV_TREE="$HERE" DEV_LOG_PATH="$DEV_LOG" \
      node -e '
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const log = fs.openSync(process.env.DEV_LOG_PATH, "a");
        const p = spawn(process.execPath, ["node_modules/.bin/tsx", "watch", "packages/server/src/index.ts"],
          { cwd: process.env.DEV_TREE, env: process.env, detached: true, stdio: ["ignore", log, log] });
        p.unref();
        console.log(`[dev] pid=${p.pid} port=${process.env.AGENTSLOT_PORT} data=${process.env.AGENTSLOT_DATA} log=${process.env.DEV_LOG_PATH}`);
      '
    for _ in $(seq 20); do sleep 1; curl -s --noproxy '*' -m 2 "http://127.0.0.1:$DEV_PORT/healthz" | grep -q '"ok":true' && break; done
    curl -s --noproxy '*' -m 3 "http://127.0.0.1:$DEV_PORT/healthz" || { echo "[dev] did not come up — see $DEV_LOG"; exit 1; }
    # The backend registry stores ABSOLUTE paths, seeded by whichever tree first created the
    # store — so a dev instance reusing the QA account silently spawns the LIVE tree's mock
    # (measured: a mock edit in the dev tree had no effect, and QA then tested live code).
    # Re-point the rows this tree owns, every start, so the instance runs only its own code.
    token_file="$DEV_DATA/auth.token"
    if [ -f "$token_file" ]; then
      tok_file="$token_file"
      row="$(curl -s --noproxy '*' -m 5 -H "$(auth_hdr "$tok_file")" "http://127.0.0.1:$DEV_PORT/api/backends" \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=(JSON.parse(s).backends||[]).find(x=>x.id==="mock");console.log(r?JSON.stringify(r.args||[]):"")}catch{console.log("")}})')"
      case "$row" in
        *"$HERE"*) : ;;
        "") : ;;
        *) echo "[dev] re-pointing backend 'mock' at this tree (was $row)"
           curl -s --noproxy '*' -m 5 -X PATCH -H "$(auth_hdr "$tok_file")" -H 'content-type: application/json' \
             -d "{\"args\":[\"$HERE/packages/server/mock/agent.mjs\"]}" \
             "http://127.0.0.1:$DEV_PORT/api/backends/mock" >/dev/null ;;
      esac
    fi
    echo
    echo "[dev] http://127.0.0.1:$DEV_PORT  login $DEV_USER / $DEV_PASS"
    ;;
  stop)
    p="$(pid_on_port "$DEV_PORT")"
    if [ -z "$p" ]; then echo "[dev] nothing on :$DEV_PORT"; exit 0; fi
    # the LISTEN pid is tsx's child; kill the process group it leads, not just that pid
    pgid="$(ps -o pgid= -p "$p" | tr -d ' ')"
    kill -TERM "-$pgid" 2>/dev/null || kill -TERM "$p"
    sleep 1
    [ -z "$(pid_on_port "$DEV_PORT")" ] && echo "[dev] stopped :$DEV_PORT" || { kill -9 "-$pgid" 2>/dev/null; echo "[dev] stopped :$DEV_PORT (SIGKILL)"; }
    ;;
  status)
    p="$(pid_on_port "$DEV_PORT")"
    if [ -z "$p" ]; then echo "[dev] :$DEV_PORT down"; else
      echo "[dev] :$DEV_PORT up (pid $p) tree=$HERE"
      curl -s --noproxy '*' -m 3 "http://127.0.0.1:$DEV_PORT/healthz"; echo
    fi
    ;;
  logs) exec tail -f "$DEV_LOG" ;;
  promote-log) exec tail -f "$DEV_DATA/promote.log" ;;
  promote)
    # What this does, and what it must NOT do:
    #   · the LIVE tree is switched to a `run/<slug>` branch pointing at the DEV branch's commit
    #     (checking out the dev branch itself is impossible — git refuses one branch in two worktrees)
    #   · a rebuild + the live `tsx watch` reload carry it into the running cockpit
    #   · every live slot is resumed afterwards, because the reload killed its agent child
    #   · nothing is merged into main and nothing is pushed: that stays the operator's call
    #
    # It runs DETACHED and it must: the reload it causes kills the very agent that ran this
    # script (the operator's own session), so an attached promote is cut in half right before
    # the resume loop. Detach once, then watch the log.
    if [ "${DEV_PROMOTE_DETACHED:-0}" != "1" ]; then
      mkdir -p "$DEV_DATA"
      plog="$DEV_DATA/promote.log"
      : > "$plog"
      DEV_PROMOTE_DETACHED=1 DEV_LOG_PATH="$plog" DEV_PROMOTE_SELF="$0" DEV_PROMOTE_SLUG="${2:-}" node -e '
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const log = fs.openSync(process.env.DEV_LOG_PATH, "a");
        const args = ["promote", ...(process.env.DEV_PROMOTE_SLUG ? [process.env.DEV_PROMOTE_SLUG] : [])];
        const p = spawn("bash", [process.env.DEV_PROMOTE_SELF, ...args], { env: process.env, detached: true, stdio: ["ignore", log, log] });
        p.unref();
        console.log(`[promote] detached pid=${p.pid} log=${process.env.DEV_LOG_PATH}`);
      '
      echo "[promote] the reload this causes kills this session's own agent — so it runs detached."
      echo "[promote] follow it with:  bash scripts/dev.sh promote-log"
      exit 0
    fi
    slug="${2:-$(git -C "$HERE" rev-parse --abbrev-ref HEAD | tr '/' '-')}"
    git -C "$HERE" diff --quiet && git -C "$HERE" diff --cached --quiet || { echo "[promote] the dev tree has uncommitted changes — commit them first"; exit 1; }
    tip="$(git -C "$HERE" rev-parse --short HEAD)"
    old_tip="$(git -C "$LIVE" rev-parse HEAD 2>/dev/null || echo none)"
    echo "[promote] $HERE @ $tip  ->  $LIVE on run/$slug"
    token_file="$LIVE/packages/server/.data/auth.token"
    asset_before="$(curl -s --noproxy '*' -m 5 "http://127.0.0.1:$LIVE_PORT/api/version" 2>/dev/null || true)"
    live_sessions="$(curl -s --noproxy '*' -m 5 -H "$(auth_hdr "$token_file")" "http://127.0.0.1:$LIVE_PORT/api/sessions" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).live||[]).map(x=>x.id).join(" "))}catch{console.log("")}})' || true)"
    git -C "$LIVE" checkout -B "run/$slug" "$tip"
    ( cd "$LIVE" && npm run build >/dev/null )
    # The live server runs without a watcher, so a server-side change only takes effect when we
    # restart it on purpose. Restarting kills the live slots (it is a release) — so do it only when
    # something that the running process embodies actually moved:
    #   · server graph (packages/server/src, packages/shared/src)     -> new code to serve
    #   · how the server is started (scripts/start.sh, package.json)  -> the running shape is stale
    #   · the live process is still under `tsx watch`                  -> old launcher, migrate it
    # and then prove it: relaunch.sh fails loudly if the pid is unchanged, i.e. if old code were
    # about to keep serving.
    server_changed="$(git -C "$LIVE" diff --name-only "$old_tip" "$tip" -- packages/server/src packages/shared/src 2>/dev/null | wc -l | tr -d ' ')"
    shape_changed="$(git -C "$LIVE" diff --name-only "$old_tip" "$tip" -- scripts/start.sh package.json 2>/dev/null | wc -l | tr -d ' ')"
    # The listener is the launcher's CHILD when a watcher is in play, so ask the process-group
    # leader (the launcher spawned it with its own session) — that is the process that holds the
    # `watch` flag.
    live_pid="$(pid_on_port "$LIVE_PORT")"
    live_leader="$(ps -o pgid= -p "${live_pid:-0}" 2>/dev/null | tr -d ' ')"
    live_argv="$(ps -o command= -p "${live_leader:-0}" 2>/dev/null || true)"
    under_watch=0; case "$live_argv" in *"tsx watch"*) under_watch=1 ;; esac
    if [ "${server_changed:-0}" != "0" ] || [ "${shape_changed:-0}" != "0" ] || [ "$under_watch" = "1" ]; then
      why="server-side file(s): $server_changed, start shape: $shape_changed, running under tsx watch: $under_watch"
      echo "[promote] restart needed ($why)"
      echo "[promote] restarting :$LIVE_PORT (explicit, verified — live slots end here, by design)"
      bash "$HERE/scripts/relaunch.sh" --port "$LIVE_PORT" --tree "$LIVE" --launcher "$LIVE_LAUNCHER" \
        || { echo "[promote] FAILED: :$LIVE_PORT did not come back on new code (see above)" >&2; exit 1; }
    else
      echo "[promote] no server-side change — the running server keeps its process (no session interrupted)"
      curl -s --noproxy '*' -m 5 "http://127.0.0.1:$LIVE_PORT/healthz"; echo
    fi
    asset_after="$(curl -s --noproxy '*' -m 5 "http://127.0.0.1:$LIVE_PORT/api/version" 2>/dev/null || true)"
    web_changed="$(git -C "$LIVE" diff --name-only "$old_tip" "$tip" -- packages/web/src 2>/dev/null | wc -l | tr -d ' ')"
    echo "[promote] web asset: ${asset_before:-none} -> ${asset_after:-none}"
    if [ "${web_changed:-0}" != "0" ] && [ "$asset_before" = "$asset_after" ]; then
      echo "[promote] WARNING: the web sources changed but the served asset hash did not — check the build" >&2
    fi
    for id in $live_sessions; do
      code="$(curl -s --noproxy '*' -m 90 -o /dev/null -w '%{http_code}' -X POST -H "$(auth_hdr "$token_file")" \
        "http://127.0.0.1:$LIVE_PORT/api/sessions/$id/resume" || true)"
      echo "[promote] resumed $id -> HTTP $code"
    done
    if [ "${web_changed:-0}" != "0" ]; then
      echo "[promote] done — hard-refresh the cockpit tab (the asset hash changed)"
    else
      echo "[promote] done"
    fi
    ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
