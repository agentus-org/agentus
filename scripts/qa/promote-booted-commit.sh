#!/usr/bin/env bash
# Prove the promote restart decision against the two real instances:
#   live :8788 — a process that predates BOOT_COMMIT (no `commit` in /api/version)
#   dev  :8901 — a process that booted the target commit
# Expected: live → restart YES (stale), dev → no restart (already running the target).
set -u
LIVE=/Users/liang/Workspace/agent-dev-workspace/worktrees/agentus
TIP=$(git -C "$LIVE" rev-parse --short HEAD)

probe() {
  local port="$1" tip="$2" boot_commit base server_changed
  boot_commit="$(curl -s --noproxy '*' -m 5 "http://127.0.0.1:$port/api/version" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).commit||"")}catch{console.log("")}})')"
  base="$tip"
  if [ -n "$boot_commit" ] && git -C "$LIVE" cat-file -e "${boot_commit}^{commit}" 2>/dev/null; then
    base="$boot_commit"
  else
    base=""
  fi
  server_changed="$( [ -z "$base" ] && echo unknown || git -C "$LIVE" diff --name-only "$base" "$tip" -- packages/server/src packages/shared/src 2>/dev/null | wc -l | tr -d ' ')"
  printf '  :%s boot=%-8s base=%-8s server_changed=%-8s restart=%s\n' \
    "$port" "${boot_commit:-none}" "${base:-none}" "$server_changed" \
    "$([ "$server_changed" != "0" ] && echo YES || echo no)"
}

echo "tip = $TIP"
echo "live (old process, no commit field published):"; probe 8788 "$TIP"
echo "dev  (booted the target commit):";               probe 8901 "$TIP"
