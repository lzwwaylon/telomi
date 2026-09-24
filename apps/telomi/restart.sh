#!/usr/bin/env bash

# Stop any running telomi processes then launch start.sh.
# Accepts the same arguments as start.sh (dev|prod|server, default dev).

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$APP_DIR/stop.sh"
exec "$APP_DIR/start.sh" "$@"
