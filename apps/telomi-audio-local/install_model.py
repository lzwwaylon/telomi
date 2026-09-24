"""Install or verify a pinned local ASR or TTS model in the shared cache."""

from __future__ import annotations

import argparse
from pathlib import Path

from model_assets import (
    default_asr_model_path,
    default_tts_model_path,
    ensure_asr_model,
    ensure_tts_model,
    inspect_asr_model,
    inspect_tts_model,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--tts",
        action="store_true",
        help="install the pinned local TTS model instead of the ASR model",
    )
    args = parser.parse_args()
    default_path = default_tts_model_path() if args.tts else default_asr_model_path()
    model_path = (args.model_path or default_path).expanduser().resolve()

    if args.check:
        inspection = (
            inspect_tts_model(model_path) if args.tts else inspect_asr_model(model_path)
        )
        print(f"{inspection.stage}: {inspection.detail}")
        if not inspection.ready:
            raise SystemExit(1)
        return

    installed = (
        ensure_tts_model(args.model_path) if args.tts else ensure_asr_model(args.model_path)
    )
    label = "Local TTS" if args.tts else "Local ASR"
    print(f"{label} model ready at {installed}")


if __name__ == "__main__":
    main()
