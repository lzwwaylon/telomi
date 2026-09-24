"""Deterministic Candidate Ledger assembly shared by Provider skills."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse


class CandidateLedger:
    """Deduplicate Provider candidates while preserving first-discovery provenance."""

    def __init__(self) -> None:
        self._candidates: dict[str, dict[str, Any]] = {}
        self._written = False

    def add(
        self,
        *,
        title: str,
        url: str,
        query: str,
        summary: str,
        metadata: dict[str, Any],
        materials: Sequence[Mapping[str, Any]],
    ) -> None:
        """Add or merge one candidate by canonical URL."""
        query = _required(query, "query")
        url = _required(url, "url")
        if urlparse(url).scheme not in {"http", "https"}:
            raise ValueError("url must use HTTP(S)")
        if not isinstance(metadata, dict):
            raise TypeError("metadata must be a dictionary")
        paths = _material_paths(materials)
        existing = self._candidates.get(url)
        if existing is None:
            candidate_metadata = copy.deepcopy(metadata)
            candidate_metadata["discovery_queries"] = _queries(candidate_metadata, query)
            self._candidates[url] = {
                "title": _required(title, "title"),
                "url": url,
                "query": query,
                "summary": _required(summary, "summary"),
                "metadata": candidate_metadata,
                "material_paths": paths,
            }
            return
        for key, value in metadata.items():
            if key != "discovery_queries" and key not in existing["metadata"]:
                existing["metadata"][key] = copy.deepcopy(value)
        existing["metadata"]["discovery_queries"] = _queries(existing["metadata"], query)
        existing["material_paths"] = list(dict.fromkeys([*existing["material_paths"], *paths]))

    def as_dict(self) -> dict[str, Any]:
        """Return the Agent-authored Ledger body; Runtime injects identity fields."""
        return {
            "candidates": copy.deepcopy(list(self._candidates.values())),
        }

    def write(self, path: str | Path) -> None:
        """Atomically write the Ledger once for this builder instance."""
        if self._written:
            raise RuntimeError("CandidateLedger.write() may be called only once")
        target = Path(path)
        if not target.is_absolute():
            target = Path(os.environ.get("PRIME_AGENT_ARTIFACT_WORKSPACE", "/workspace")) / target
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=target.parent, delete=False) as file:
            temporary = Path(file.name)
            json.dump(self.as_dict(), file, ensure_ascii=False, indent=2)
            file.write("\n")
        try:
            os.replace(temporary, target)
            self._written = True
        finally:
            temporary.unlink(missing_ok=True)


def _required(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value.strip()


def _material_paths(materials: Sequence[Mapping[str, Any]]) -> list[str]:
    if isinstance(materials, (str, bytes)):
        raise TypeError("materials must contain Provider Tool records")
    paths: list[str] = []
    for material in materials:
        if not isinstance(material, Mapping):
            raise TypeError("materials must contain Provider Tool records")
        metadata = material.get("metadata")
        values = [
            material.get("artifact_path"),
            material.get("material_path"),
            material.get("content_path"),
            metadata.get("provider_artifact_path") if isinstance(metadata, Mapping) else None,
            metadata.get("artifact_path") if isinstance(metadata, Mapping) else None,
            material.get("download_path"),
        ]
        path = next((value.strip() for value in values if isinstance(value, str) and value.strip()), None)
        if path is None:
            encoded = json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
            digest = hashlib.sha256(encoded).hexdigest()
            root = Path(os.environ.get("PRIME_AGENT_ARTIFACT_WORKSPACE", "/workspace"))
            target = root / "work" / "materials" / "provider-records" / f"{digest}.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_bytes(encoded + b"\n")
            path = target.relative_to(root).as_posix()
        paths.append(path)
    if not paths:
        raise ValueError("materials must not be empty")
    return list(dict.fromkeys(paths))


def _queries(metadata: dict[str, Any], query: str) -> list[str]:
    existing = metadata.get("discovery_queries")
    values = existing if isinstance(existing, list) else []
    return list(dict.fromkeys([*(_required(value, "discovery_queries") for value in values), query]))


__all__ = ["CandidateLedger"]
