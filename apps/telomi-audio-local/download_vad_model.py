"""Download the pinned Silero VAD ONNX model into the shared local cache."""

from __future__ import annotations

import argparse
import hashlib
import os
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from environment import audio_env
from vad import SILERO_VAD_MODEL_SHA256, SILERO_VAD_MODEL_VERSION


MODEL_URL = (
    "https://raw.githubusercontent.com/snakers4/silero-vad/"
    "v5.1.2/src/silero_vad/data/silero_vad.onnx"
)
MAX_MODEL_BYTES = 8 * 1024 * 1024


def default_model_path() -> Path:
    configured = audio_env("TELOMI_AUDIO_VAD_MODEL_PATH", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (
        Path.home()
        / ".cache"
        / "telomi-audio"
        / "models"
        / f"silero-vad-{SILERO_VAD_MODEL_VERSION}.onnx"
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_model(path: Path, *, force: bool = False) -> Path:
    if path.exists() and sha256_file(path) == SILERO_VAD_MODEL_SHA256:
        print(f"Silero VAD {SILERO_VAD_MODEL_VERSION} ready at {path}")
        return path
    if path.exists() and not force:
        raise RuntimeError(
            f"Existing VAD model failed SHA-256 validation: {path}. "
            "Pass --force to replace it."
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        MODEL_URL,
        headers={"User-Agent": "Telomi-Voice-VAD-Installer/1"},
    )
    temporary_path: Path | None = None
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            final_url = response.geturl()
            if urlparse(final_url).scheme != "https":
                raise RuntimeError("VAD model download redirected outside HTTPS")
            declared_length = response.headers.get("Content-Length")
            if declared_length and int(declared_length) > MAX_MODEL_BYTES:
                raise RuntimeError("VAD model exceeds the configured size limit")
            with tempfile.NamedTemporaryFile(
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_MODEL_BYTES:
                        raise RuntimeError("VAD model exceeds the configured size limit")
                    temporary.write(chunk)
        if temporary_path is None:
            raise RuntimeError("VAD model download did not create a temporary file")
        received_digest = sha256_file(temporary_path)
        if received_digest != SILERO_VAD_MODEL_SHA256:
            raise RuntimeError(
                "VAD model SHA-256 mismatch: "
                f"expected {SILERO_VAD_MODEL_SHA256}, received {received_digest}"
            )
        os.replace(temporary_path, path)
        temporary_path = None
        print(f"Downloaded Silero VAD {SILERO_VAD_MODEL_VERSION} to {path}")
        return path
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=default_model_path())
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    ensure_model(args.output.expanduser().resolve(), force=args.force)


if __name__ == "__main__":
    main()
