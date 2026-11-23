#!/usr/bin/env bash
#
# Hermes Studio one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/hermes-studio-org/hermes-studio/main/scripts/install.sh | bash
#
# Or the equivalent npm route, if you would rather not pipe a script into a shell:
# `npx hermes-studio` (run once) / `npm i -g hermes-studio` — this script is that, plus a Node check and a
# per-user fallback.
#
# What it does — and nothing else:
#   1. checks Node is >= 22.5 (Hermes Studio stores its state in node:sqlite, which landed in 22.5);
#   2. installs the published `hermes-studio` package with npm, globally by default;
#   3. if a global install is not writable (a locked-down machine, a system Node), retries into
#      a per-user prefix instead of touching system directories;
#   4. prints the exact command that starts the cockpit and the URL to open.
#
# It never installs or upgrades an ACP agent CLI (`hermes acp` / `qodercli --acp`) — that is the
# one prerequisite npm cannot cover. Put one on PATH yourself; see docs/installation.md.
#
# It is safe to pipe straight into bash: it reads no stdin, writes nothing outside the npm
# prefix it installs into, and refuses to run as root unless you say so explicitly.
#
# Environment overrides:
#   HERMES_STUDIO_VERSION="0.1.0"       pin a package version      (default: latest)
#   HERMES_STUDIO_INSTALL_DIR="/x"      install into this npm --prefix instead of global   (default: unset)
#   HERMES_STUDIO_REGISTRY="https://…"  npm registry to fetch from (default: npm's own registry)
#   HERMES_STUDIO_ALLOW_ROOT=1          permit running as root     (default: refuse)
#   HERMES_STUDIO_NODE_MIN="22.5"       override the Node floor check   (default: 22.5)
#
# Flags:  --help  ·  --version <v>  ·  --dir <path>
#
set -euo pipefail

VERSION="${HERMES_STUDIO_VERSION:-latest}"
INSTALL_DIR="${HERMES_STUDIO_INSTALL_DIR:-}"
REGISTRY="${HERMES_STUDIO_REGISTRY:-}"
ALLOW_ROOT="${HERMES_STUDIO_ALLOW_ROOT:-0}"
NODE_MIN="${HERMES_STUDIO_NODE_MIN:-22.5}"

log()  { printf 'hermes-studio: %s\n' "$*"; }
warn() { printf 'hermes-studio: %s\n' "$*" >&2; }
die()  { printf 'hermes-studio: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Hermes Studio installer

Usage
  curl -fsSL https://raw.githubusercontent.com/hermes-studio-org/hermes-studio/main/scripts/install.sh | bash
  bash scripts/install.sh [options]

Options
  --version <v>   package version to install        (default: latest)
  --dir <path>    install into this prefix (npm --prefix) instead of the global one
  -h, --help      this text

Environment
  HERMES_STUDIO_VERSION, HERMES_STUDIO_INSTALL_DIR, HERMES_STUDIO_REGISTRY, HERMES_STUDIO_ALLOW_ROOT, HERMES_STUDIO_NODE_MIN

After install:
  hermes-studio            # start the cockpit on http://localhost:8788
  hermes-studio --where    # print the paths the server resolved (data dir, web bundle) and exit
EOF
}

# ---- argument parsing (runs before anything else) -------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dir|--prefix) [ $# -ge 2 ] || die "--dir needs a value"; INSTALL_DIR="$2"; shift 2 ;;
    --dir=*|--prefix=*) INSTALL_DIR="${1#*=}"; shift ;;
    *) die "unknown option \"$1\" (try --help)" ;;
  esac
done

# ---- refuse to run as root ------------------------------------------------------------------
if [ "$(id -u 2>/dev/null || echo 0)" = "0" ] && [ "${ALLOW_ROOT}" != "1" ]; then
  die "refusing to install as root (a Node package does not need it, and a root-owned
  global tree makes later upgrades awkward). Re-run as your normal user, or set
  HERMES_STUDIO_ALLOW_ROOT=1 if you really mean it."
fi

# ---- Node >= 22.5 (node:sqlite) -------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node is not on PATH. Install Node >= ${NODE_MIN} first —
  nvm:      nvm install 22 && nvm use 22
  homebrew: brew install node
  else:     https://nodejs.org/en/download"
export HERMES_STUDIO_NODE_MIN="$NODE_MIN"
node -e '
const need = process.env.HERMES_STUDIO_NODE_MIN || "22.5";
const [maj,min] = process.versions.node.split(".").map(Number);
const [nmaj,nmin] = need.split(".").map(Number);
if (maj < nmaj || (maj === nmaj && min < nmin)) {
  console.error(`hermes-studio: needs Node >= ${need} (the store is node:sqlite); this is ${process.versions.node}.`);
  console.error("  nvm: nvm install 22 && nvm use 22   ·   homebrew: brew install node");
  process.exit(1);
}
console.log(`hermes-studio: Node ${process.versions.node} ok (need >= ${need})`);
' || die "Node version check failed."

# ---- npm ------------------------------------------------------------------------------------
command -v npm >/dev/null 2>&1 || die "npm is not on PATH. It ships with Node — reinstall
  Node, or skip the installer and run:  npx agentus@${VERSION}"

PKG="agentus@${VERSION}"
NPM_ARGS=()
if [ -n "$REGISTRY" ]; then NPM_ARGS+=(--registry "$REGISTRY"); fi

install_global() {
  npm install -g "$PKG" ${NPM_ARGS[@]+"${NPM_ARGS[@]}"}
}
install_into_prefix() {
  local dir="$1"
  mkdir -p "$dir"
  npm install -g --prefix "$dir" "$PKG" ${NPM_ARGS[@]+"${NPM_ARGS[@]}"}
}

# ---- install: fetch from the registry, fall back to a per-user prefix -----------------------
BIN_DIR=""
if [ -n "$INSTALL_DIR" ]; then
  log "installing ${PKG} into ${INSTALL_DIR} …"
  install_into_prefix "$INSTALL_DIR" || die "npm install into ${INSTALL_DIR} failed."
  BIN_DIR="${INSTALL_DIR}/bin"
elif install_global; then
  BIN_DIR="$(npm prefix -g 2>/dev/null || echo /usr/local)/bin"
else
  # A global install most often fails with EACCES on a system Node. Do NOT reach for sudo —
  # retry into a per-user prefix, which needs no privileges at all.
  warn "global install failed (no write access?) — retrying into a per-user prefix."
  INSTALL_DIR="${HOME}/.local"
  install_into_prefix "$INSTALL_DIR" || die "fallback install into ${INSTALL_DIR} failed."
  BIN_DIR="${INSTALL_DIR}/bin"
fi

# ---- verify it landed -----------------------------------------------------------------------
if [ -x "${BIN_DIR}/agentus" ]; then
  log "installed: ${BIN_DIR}/agentus"
elif command -v hermes-studio >/dev/null 2>&1; then
  log "installed: $(command -v hermes-studio)"
else
  warn "the install finished but 'hermes-studio' was not found on PATH — check ${BIN_DIR}."
fi

# ---- the next step, exactly -----------------------------------------------------------------
echo
echo "  Next — start the cockpit:"
if command -v hermes-studio >/dev/null 2>&1; then
  echo "      hermes-studio"
else
  echo "      export PATH=\"${BIN_DIR}:\$PATH\"    # once, to put hermes-studio on PATH"
  echo "      hermes-studio"
fi
echo
echo "  Then open  http://localhost:8788  and log in (admin / 123456 — change it in Settings → 账号)."
echo "  The one thing npm cannot install is an agent CLI: put 'hermes acp' or 'qodercli --acp' on"
echo "  PATH, then add a backend and start a session. Full guide: docs/installation.md"
