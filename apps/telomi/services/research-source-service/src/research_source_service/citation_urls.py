from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

from .errors import ServiceError, bounded_message


class CitationUrlValidator:
    def __init__(self, binary: Path | None = None) -> None:
        self._binary = str(binary) if binary else shutil.which("lychee")

    async def validate(self, markdown: str) -> list[str]:
        if not self._binary:
            raise ServiceError(
                "lychee_unavailable",
                "lychee is not installed; install lychee 0.24.2 or set SOURCE_SERVICE_LYCHEE_PATH",
                status_code=503,
            )
        try:
            process = await asyncio.create_subprocess_exec(
                self._binary,
                "--format=json",
                "--no-progress",
                "--max-retries=0",
                "--max-concurrency=6",
                "--max-redirects=5",
                "--exclude-all-private",
                "--method=get",
                "--accept=200..=299",
                "--header=Range: bytes=0-0",
                "--default-extension=md",
                "-",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            raise ServiceError("lychee_start_failed", bounded_message(error), status_code=503) from error

        try:
            stdout, stderr = await process.communicate(markdown.encode("utf-8"))
        except asyncio.CancelledError:
            process.kill()
            await process.wait()
            raise
        if process.returncode not in {0, 2}:
            detail = bounded_message(stderr.decode("utf-8", errors="replace"))
            raise ServiceError(
                "lychee_failed",
                f"lychee exited with code {process.returncode}: {detail}",
            )
        try:
            payload = json.loads(stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ServiceError("lychee_invalid_response", "lychee returned invalid JSON") from error
        if not isinstance(payload, dict):
            raise ServiceError("lychee_invalid_response", "lychee returned a non-object JSON response")

        unavailable: set[str] = set()
        for map_name in ("error_map", "timeout_map", "excluded_map"):
            groups = payload.get(map_name, {})
            if not isinstance(groups, dict):
                raise ServiceError("lychee_invalid_response", f"lychee returned an invalid {map_name}")
            for entries in groups.values():
                if not isinstance(entries, list):
                    raise ServiceError("lychee_invalid_response", f"lychee returned invalid entries in {map_name}")
                for entry in entries:
                    if isinstance(entry, dict) and isinstance(entry.get("url"), str):
                        unavailable.add(entry["url"])
        return sorted(unavailable)
