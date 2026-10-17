#!/usr/bin/env bash
# Restart the LIVE cockpit and prove the process that comes back is the new one.
#
# Why a script and not a command line: restarting kills every live slot — including the agent that
# launched it — so the assertions cannot print to that agent's terminal. They append to a log the
# resumed session reads afterwards. Two ways this has already gone wrong, both fixed here:
#
#   1. `setsid` does not exist on macOS. A restart written around it exits on its first line, leaves
#      the OLD process serving, and looks exactly like "the fix did not work" — every retry repeated
#      it. Live runs as a launchd job, so the only correct lever is `launchctl kickstart -k`.
#   2. Verification with a literal `Bearer ***`: the token was read into a variable and then never
#      used, so every check answered 401 and the log said nothing about the fix. The token is read
#      here and passed through the header without ever being echoed.
#
# Usage:  detached, e.g.  nohup bash scripts/qa/restart-live-verify.sh 3143c27c &
#         (then `tail -f /tmp/agentus-restart.log` from anywhere, or just re-read it after resume)
set -uo pipefail
SID="${1:-}"
PORT="${AGENTUS_PORT:-8788}"
LOG="${AGENTUS_RESTART_LOG:-/tmp/agentus-restart.log}"
UNIT="gui/$(id -u)/ai.hermes.agentus"

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') restart :$PORT (session ${SID:-none}) ==="
  OLD=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN | head -1); echo "old pid: ${OLD:-none}"

  # launchd owns the live process: kickstart -k makes it exit and be started again. A plain `kill`
  # would leave launchd's bookkeeping stale; a foreground start would die with this shell.
  if ! launchctl print "$UNIT" >/dev/null 2>&1; then
    echo "NO launchd unit $UNIT — refusing to guess how live is started"
    echo "=== done $(date '+%H:%M:%S') ==="
    exit 1
  fi
  launchctl kickstart -k "$UNIT" 2>&1

  code=000
  for _ in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$PORT/healthz" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 1
  done
  sleep 3
  NEW=$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN | head -1)
  echo "healthz=$code  old=${OLD:-none}  new=${NEW:-none}  pid_changed=$([ -n "${NEW:-}" ] && [ "${NEW:-}" != "${OLD:-}" ] && echo yes || echo NO)"
  echo "version: $(curl -s --noproxy '*' "http://127.0.0.1:$PORT/api/version")"
  [ "${NEW:-}" != "${OLD:-}" ] || echo "WARNING: the pid did not change — this was not a restart"

  # A restart proves nothing about WHICH code is serving; these two do. The voice data plane is the
  # cheapest witness (it is a pure read that reports its own inputs).
  TOK=""
  for f in "$HOME/.agentus/auth.token" \
           "$(cd "$(dirname "$0")/../.." && pwd)/packages/server/.data/auth.token"; do
    [ -f "$f" ] && TOK=$(cat "$f") && break
  done
  if [ -n "$TOK" ] && [ -n "$SID" ]; then
    curl -s --noproxy '*' -H "Authorization: Bearer $TOK" \
      "http://127.0.0.1:$PORT/api/voice/hotwords?sessionId=$SID" \
      | python3 -c 'import json,sys
d = json.load(sys.stdin)
dyn = [w["word"] for w in d.get("words", []) if w.get("origin") == "dynamic"]
print("fixed:", d.get("fixed"), "dynamic:", d.get("dynamic"), "contextTurns:", d.get("contextTurns"))
print("context roles:", [c["role"] for c in d.get("context", [])])
print("dynamic words:", dyn[:20])
print("sha-like leaked into the pool:", [w for w in dyn if len(w) == 7 and all(c in "0123456789abcdef" for c in w)])'
  else
    echo "no token/session id — skipped the data-plane witness (say which session to sample)"
  fi
  echo "=== done $(date '+%H:%M:%S') ==="
} >> "$LOG" 2>&1
