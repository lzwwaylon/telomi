"""Read-only Python interface to the Runtime-owned Goal Wiki."""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Any


async def search(query: str, top_k: int = 10) -> dict[str, Any]:
    return await _async_call("search", {"query": query, "top_k": top_k})


async def read_page(path: str) -> dict[str, Any]:
    return await _async_call("read_page", {"path": path})


async def graph_search(query: str, top_k: int = 10) -> dict[str, Any]:
    return await _async_call("graph_search", {"query": query, "top_k": top_k})


async def _async_call(operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_call, operation, arguments)


def _call(operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    base_url = os.environ.get("PRIME_AGENT_REPORT_WIKI_URL", "").rstrip("/")
    token = os.environ.get("PRIME_AGENT_REPORT_WIKI_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError("Prime Report Wiki Runtime is not configured")
    request = urllib.request.Request(
        f"{base_url}/v1/wiki",
        data=json.dumps(
            {"operation": operation, **arguments},
            ensure_ascii=False,
        ).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(
            f"Prime Report Wiki Runtime HTTP {error.code}: {detail}"
        ) from error
    if not isinstance(value, dict):
        raise RuntimeError("Prime Report Wiki Runtime returned an invalid response")
    return value


__all__ = ["search", "read_page", "graph_search"]
