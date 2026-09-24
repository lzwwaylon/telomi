#!/usr/bin/env bash

# Stop running telomi processes started via start.sh.
# Matches processes whose command line references this APP_DIR, plus anything
# holding the server PORT as a safety net. SIGTERM first, SIGKILL after
# STOP_TIMEOUT seconds if any refuse to exit.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8787}"
TIMEOUT="${STOP_TIMEOUT:-5}"

log() { echo "[telomi:stop] $*"; }

# Stop the headless Chrome debug instance (started by start.sh). Best-effort —
# if the script or node_modules is missing, just keep going; the main PID sweep
# below will still clean up other processes.
if [ -d "$APP_DIR/node_modules" ] && [ -f "$APP_DIR/scripts/chrome-debug.ts" ]; then
  (cd "$APP_DIR" && npm run -s browser:stop >/dev/null 2>&1) || true
fi

collect_pids() {
  local self=$$
  local snapshot
  snapshot=$(ps ax -o pid=,command=)
  printf '%s\n' "$snapshot" \
    | awk -v pat="$APP_DIR" -v self="$self" '
        $0 ~ pat \
          && $0 !~ /stop\.sh/ \
          && $0 !~ /restart\.sh/ \
          && $1 != self \
          { print $1 }'
  lsof -ti "tcp:${PORT}" 2>/dev/null || true
}

any_alive() {
  for pid in "$@"; do
    kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

PIDS=$(collect_pids | sort -u | grep -v '^$' || true)
if [ -z "$PIDS" ]; then
  log "no running telomi processes found"
  exit 0
fi

log "sending SIGTERM to: $(echo $PIDS | tr '\n' ' ')"
for pid in $PIDS; do kill -TERM "$pid" 2>/dev/null || true; done

waited=0
while [ "$waited" -lt "$TIMEOUT" ]; do
  if ! any_alive $PIDS; then break; fi
  sleep 1
  waited=$((waited + 1))
done

STILL=""
for pid in $PIDS; do
  kill -0 "$pid" 2>/dev/null && STILL="$STILL $pid"
done
if [ -n "$STILL" ]; then
  log "still alive after ${TIMEOUT}s, sending SIGKILL to:$STILL"
  for pid in $STILL; do kill -KILL "$pid" 2>/dev/null || true; done
  sleep 1
fi

if lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then
  log "WARNING: port ${PORT} still in use"
  exit 1
fi
log "stopped"
