#!/usr/bin/env bash
# Restart an Agentus instance and PROVE it came back on a new process.
#
#   scripts/relaunch.sh --port 8787 --launcher ~/.hermes/cache/agentus/launch.py
#
# Why this exists: the live instance no longer runs under `tsx watch` (a reload SIGTERMs
# every live `hermes acp` slot), so nothing restarts the server by itself any more. A
# release therefore has to restart it on purpose — and, since "did it actually restart?" is
# exactly the thing that used to be invisible, this script asserts it: old LISTEN pid ->
# TERM the process group -> wait for the port to free -> launcher -> poll /healthz ->
# new pid must differ. Any failure exits non-zero, so a publish can never silently leave
# the old process serving.
#
# The launcher owns REPO/port/data/log; for tests, point --launcher at one that reads
# PORT/DATA/LOG from the environment (launch_scratch.py) and export them here.
set -uo pipefail

PORT=""
LAUNCHER=""
LAUNCHD=""
TREE=""
HEALTH_TIMEOUT=90
FREE_TIMEOUT=25

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --launcher) LAUNCHER="$2"; shift 2 ;;
    --launchd) LAUNCHD="$2"; shift 2 ;;
    --tree) TREE="$2"; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT="$2"; shift 2 ;;
    *) echo "[relaunch] unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Default the port from ports.env (the single source for live's ports) rather than a literal that
# goes stale the moment the port moves. --port still wins for scratch/dev instances.
if [ -z "$PORT" ]; then
  PORT="$(sed -n 's/^AGENTUS_PORT=\([0-9]*\).*/\1/p' /Users/liang/.hermes/cache/agentus/ports.env 2>/dev/null | head -1)"
fi
PORT="${PORT:-8787}"


[ -n "$LAUNCHER" ] || { echo "[relaunch] --launcher is required" >&2; exit 2; }
[ -f "$LAUNCHER" ] || { echo "[relaunch] launcher not found: $LAUNCHER" >&2; exit 2; }
[ -n "$TREE" ] || TREE="$(cd "$(dirname "$0")/.." && pwd)"

listen_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

old="$(listen_pid "$PORT")"
echo "[relaunch] port $PORT: old pid ${old:-none}"

launchd_owned=""
if [ -n "$LAUNCHD" ] && launchctl print "gui/$(id -u)/$LAUNCHD" >/dev/null 2>&1; then
  launchd_owned=1
  # launchd owns this instance now, and that changes what "restart" means. Killing the server by
  # hand is no longer a restart — KeepAlive immediately respawns it, our own launcher then starts a
  # THIRD process, and one of them loses the port race (or worse, two servers share a data dir).
  # `kickstart -k` is the version where the supervisor does it: stop whatever is running, start it
  # fresh, in that order, once.
  # Which port does this job actually serve? It is NOT always in the plist: the live job keeps its
  # ports in ports.env (launch.py pins them from there), precisely so the port is one editable line
  # rather than a plist edit. So try the job's own environment first (a plist that declares the port
  # explicitly, and the scratch launcher's PORT), then fall back to ports.env — the source the live
  # job reads. If none of them yields a number the guard is skipped rather than guessed at.
  # The values in `launchctl print` are UNQUOTED (`PORT => 8797`), and the block also contains
  # `AGENTUS_PORT => N` for a job that declares it — so the patterns are anchored (`^...PORT =>`)
  # rather than free to match the tail of a longer key.
  _jl="$(launchctl print "gui/$(id -u)/$LAUNCHD" 2>/dev/null | tr -d '"')"
  job_port="$(printf '%s\n' "$_jl" | sed -n 's/^[[:space:]]*AGENTUS_PORT => *\([0-9][0-9]*\).*/\1/p' | head -1)"
  [ -n "$job_port" ] || job_port="$(printf '%s\n' "$_jl" | sed -n 's/^[[:space:]]*PORT => *\([0-9][0-9]*\).*/\1/p' | head -1)"
  [ -n "$job_port" ] || job_port="$(sed -n 's/^AGENTUS_PORT=\([0-9][0-9]*\).*/\1/p' /Users/liang/.hermes/cache/agentus/ports.env 2>/dev/null | head -1)"
  if [ -n "$job_port" ] && [ "$job_port" != "$PORT" ]; then
    echo "[relaunch] FAILED: $LAUNCHD serves :$job_port but --port was $PORT" >&2
    exit 1
  fi
  echo "[relaunch] $LAUNCHD is a launchd job — restarting it with kickstart -k"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD" || { echo "[relaunch] FAILED: kickstart" >&2; exit 1; }
  # A rapid exit+respawn can leave the port momentarily unclaimed or still claimed by the dying pid,
  # so wait for a pid that is not the old one instead of sampling once.
  for _ in $(seq 1 $((FREE_TIMEOUT * 2))); do
    now="$(listen_pid "$PORT")"
    [ -n "$now" ] && [ "$now" != "$old" ] && break
    sleep 0.5
  done
elif [ -n "$old" ]; then
  pgid="$(ps -o pgid= -p "$old" 2>/dev/null | tr -d ' ')"
  # Kill the whole group, then the process itself if it is not the group leader. Under a watcher
  # the LISTEN pid is the launcher's CHILD (leader = the `tsx watch` supervisor, measured: the
  # migration left the old supervisor alive when only the child was signalled), so a group-only or
  # child-only kill both leave something behind.
  if [ -n "$pgid" ]; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
    [ "$pgid" != "$old" ] && kill -TERM "$old" 2>/dev/null || true
  else
    kill -TERM "$old" 2>/dev/null || true
  fi
  for _ in $(seq 1 $((FREE_TIMEOUT * 2))); do
    [ -z "$(listen_pid "$PORT")" ] && break
    sleep 0.5
  done
  if [ -n "$(listen_pid "$PORT")" ]; then
    echo "[relaunch] pid $old ignored SIGTERM — sending SIGKILL" >&2
    kill -KILL "$old" 2>/dev/null || true
    sleep 2
  fi
  [ -z "$(listen_pid "$PORT")" ] || { echo "[relaunch] FAILED: port $PORT still held after SIGKILL" >&2; exit 1; }
  echo "[relaunch] port $PORT free"
fi

if [ -z "$launchd_owned" ]; then
  launch_out="$(cd "$TREE" && python3 "$LAUNCHER" 2>&1)"
  echo "[relaunch] launcher: ${launch_out:-no output}"
fi

health=""
for _ in $(seq 1 $((HEALTH_TIMEOUT * 2))); do
  health="$(curl -s --noproxy '*' -m 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
  case "$health" in *'"ok":true'*) break ;; esac
  sleep 0.5
done
case "$health" in
  *'"ok":true'*) echo "[relaunch] healthz ok: $health" ;;
  *) echo "[relaunch] FAILED: no healthy response on :$PORT within ${HEALTH_TIMEOUT}s" >&2; exit 1 ;;
esac

new="$(listen_pid "$PORT")"
if [ -z "$new" ]; then echo "[relaunch] FAILED: nothing listening on :$PORT" >&2; exit 1; fi
if [ -n "$old" ] && [ "$new" = "$old" ]; then
  echo "[relaunch] FAILED: pid unchanged ($new) — the running code is still the old code" >&2
  exit 1
fi
echo "[relaunch] pid ${old:-none} -> $new  (server restarted)"
