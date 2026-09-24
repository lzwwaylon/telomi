#!/usr/bin/env bash

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-dev}"

cd "$APP_DIR"

# Ensure a Node >= 22 runtime. pi-coding-agent requires node >=22.19; on Node 20
# the bundled undici calls webidl.util.markAsUncloneable (absent there) and the
# server crashes on import (8787 never listens, vite ECONNREFUSEs). If the active
# node is too old, switch via nvm (reads .nvmrc=24), then fall back to scanning
# nvm's installed >=22 versions, and finally error out with guidance.
ensure_node() {
  local major
  major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')"
  if [ -n "$major" ] && [ "$major" -ge 22 ] 2>/dev/null; then
    return 0
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +e
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm use >/dev/null 2>&1
    set -e
  fi
  major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*//')"
  if [ -z "$major" ] || ! [ "$major" -ge 22 ] 2>/dev/null; then
    local best
    best="$(ls -1 "$NVM_DIR/versions/node" 2>/dev/null | sed 's/^v//' \
      | awk -F. '$1>=22' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
    [ -n "$best" ] && export PATH="$NVM_DIR/versions/node/v$best/bin:$PATH"
  fi
  local cur
  cur="$(node -v 2>/dev/null)"
  major="$(printf '%s' "$cur" | sed 's/^v//; s/\..*//')"
  if [ -z "$major" ] || ! [ "$major" -ge 22 ] 2>/dev/null; then
    echo "[telomi] ERROR: need Node >=22.19 (pi-coding-agent); active='${cur:-none}'" >&2
    echo "[telomi] install one with: nvm install 24" >&2
    exit 1
  fi
  echo "[telomi] node runtime: $cur"
}
ensure_node

# Read shell-consumed settings with the same precedence as the server:
# explicit environment > .env.worktree > .env.local > .env > default. Never source .env as shell code.
# Only name files that exist: Node prints "<file> not found" for --env-file-if-exists.
ENV_FILE_ARGS=()
for env_file in .env .env.local .env.worktree; do
  [ -f "$APP_DIR/$env_file" ] && ENV_FILE_ARGS+=("--env-file=$APP_DIR/$env_file")
done
read_setting() {
  node ${ENV_FILE_ARGS[@]+"${ENV_FILE_ARGS[@]}"} \
    -e 'process.stdout.write(process.env[process.argv[1]]?.trim() || process.argv[2])' "$1" "$2"
}
load_setting() {
  local value
  value="$(read_setting "$1" "$2")"
  export "$1=$value"
}
load_setting PORT 8787
load_setting WEB_PORT 5174
export API_PORT="${API_PORT:-$PORT}"
load_setting TELOMI_DATA_DIR "$APP_DIR/data"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$TELOMI_DATA_DIR/.pi/agent}"
export PRIME_AGENT_CODING_AGENT_DIR="${PRIME_AGENT_CODING_AGENT_DIR:-$PI_CODING_AGENT_DIR}"

# Workspace dependencies are hoisted to the repository root; a Worktree has no local node_modules.
if [ ! -d node_modules ] && [ ! -d "$APP_DIR/../../node_modules" ]; then
  echo "[telomi] Installing dependencies..."
  npm install --cache ./.npm-cache
fi

if [ ! -f "$PI_CODING_AGENT_DIR/auth.json" ]; then
  echo "[telomi] No provider connected yet; open Settings in the app to connect one."
fi

echo "[telomi] mode=$MODE sandbox=srt data=$TELOMI_DATA_DIR port=$PORT"

# Browser readiness is enforced by server initialization for every entrypoint.

case "$MODE" in
  dev)
    # Point the browser's EventSource at the backend directly so SSE bypasses
    # vite's proxy. vite's http-proxy leaks sockets on long-lived SSE streams,
    # which exhausts the per-host HTTP/1.1 6-connection cap and makes page
    # refreshes hang. Fetch keeps going through the proxy unchanged.
    export VITE_API_BASE="${VITE_API_BASE:-http://localhost:$PORT}"
    exec npm run dev
    ;;
  prod)
    npm run build
    exec npm start
    ;;
  server)
    exec npm start
    ;;
  *)
    echo "Usage: ./start.sh [dev|prod|server]" >&2
    exit 1
    ;;
esac
