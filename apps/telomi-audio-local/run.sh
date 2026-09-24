#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if [ -n "${TELOMI_AUDIO_VENV_PATH:-}" ]; then
    VENV="${TELOMI_AUDIO_VENV_PATH/#\~/$HOME}"
    if [ ! -x "$VENV/bin/python" ]; then
        echo "Telomi Audio Python environment is missing at $VENV" >&2
        exit 1
    fi
else
    if ! command -v uv >/dev/null 2>&1; then
        echo "Telomi Audio requires uv. Install uv and run npm run audio:install." >&2
        exit 1
    fi
    uv sync --project "$HERE" --frozen --python 3.12
    VENV="$HERE/.venv"
fi

"$VENV/bin/python" - <<'PY'
import platform
import sys

if sys.version_info[:2] != (3, 12):
    raise SystemExit(f"Telomi Audio requires Python 3.12, received {sys.version.split()[0]}")
if sys.platform != "darwin" or platform.machine() != "arm64":
    raise SystemExit("Telomi Audio MLX local models currently require Apple Silicon macOS")
PY

if [ "${TELOMI_AUDIO_ASR_AUTO_DOWNLOAD:-true}" = "true" ]; then
    if [ -n "${TELOMI_AUDIO_ASR_MODEL_PATH:-}" ]; then
        echo "Using externally managed ASR model at $TELOMI_AUDIO_ASR_MODEL_PATH"
    else
        "$VENV/bin/python" install_model.py
    fi
fi

if [ "${TELOMI_AUDIO_TTS_AUTO_DOWNLOAD:-true}" = "true" ]; then
    if [ -n "${TELOMI_AUDIO_TTS_MODEL_PATH:-}" ]; then
        echo "Using externally managed TTS model at $TELOMI_AUDIO_TTS_MODEL_PATH"
    else
        "$VENV/bin/python" install_model.py --tts
    fi
fi

if [ "${TELOMI_AUDIO_VAD_AUTO_DOWNLOAD:-true}" = "true" ]; then
    if ! "$VENV/bin/python" download_vad_model.py; then
        echo "warning: VAD model download failed; starting without neural VAD and using request-level fail-open" >&2
    fi
fi

if [ "${1:-}" = "--bootstrap-only" ]; then
    echo "Telomi Audio bootstrap complete"
    exit 0
fi

exec "$VENV/bin/python" app.py "$@"
