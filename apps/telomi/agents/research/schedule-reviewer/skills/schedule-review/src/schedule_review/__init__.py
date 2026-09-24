"""Read-only Python interface to the Runtime-owned user memory and Goal Wiki."""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Any


async def memory_recall(query: str) -> dict[str, Any]:
    return await _async_call("memory_recall", {"query": query})


async def memory_reflect(query: str) -> dict[str, Any]:
    return await _async_call("memory_reflect", {"query": query})


async def wiki_search(query: str, top_k: int = 10) -> dict[str, Any]:
    return await _async_call("wiki_search", {"query": query, "top_k": top_k})


async def wiki_read_page(path: str) -> dict[str, Any]:
    return await _async_call("wiki_read_page", {"path": path})


async def wiki_graph_search(query: str, top_k: int = 10) -> dict[str, Any]:
    return await _async_call("wiki_graph_search", {"query": query, "top_k": top_k})


async def _async_call(operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_call, operation, arguments)


def _call(operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    base_url = os.environ.get("PRIME_AGENT_SCHEDULE_REVIEW_URL", "").rstrip("/")
    token = os.environ.get("PRIME_AGENT_SCHEDULE_REVIEW_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError("Research Schedule Review Runtime is not configured")
    request = urllib.request.Request(
        f"{base_url}/v1/schedule-review",
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
            f"Research Schedule Review Runtime HTTP {error.code}: {detail}"
        ) from error
    if not isinstance(value, dict):
        raise RuntimeError("Research Schedule Review Runtime returned an invalid response")
    return value


__all__ = [
    "memory_recall",
    "memory_reflect",
    "wiki_search",
    "wiki_read_page",
    "wiki_graph_search",
]
