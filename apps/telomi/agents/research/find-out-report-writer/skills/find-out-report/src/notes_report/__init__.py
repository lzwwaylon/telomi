"""Bounded Python interface to Runtime-owned Cornell Notes."""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Any


async def summary(
    offset: int = 0,
    limit: int | None = None,
    source: str | list[str] | None = None,
) -> dict[str, Any]:
    """Page Sources.

    With no `source`, returns the compact roster: every Source with its handle, title, origins and
    Section titles. Pass `source=["@22", "@28"]` to expand Section summaries for
    the Sources you picked. Omit `limit` to let the character budget decide; follow `next_offset`.
    """
    return await _async_call("summary", {"offset": offset, "limit": limit, "source": source})


async def catalog(
    offset: int = 0, limit: int | None = None, source: str | list[str] | None = None
) -> dict[str, Any]:
    """Page the Note catalog, optionally restricted to one or more Sources. Follow `next_offset`."""
    return await _async_call("catalog", {"offset": offset, "limit": limit, "source": source})


async def search(
    query: str,
    limit: int | None = None,
    offset: int = 0,
    source: str | list[str] | None = None,
) -> dict[str, Any]:
    """Rank Notes by cue match, optionally inside one or more Sources. Follow `next_offset`."""
    return await _async_call("search", {"query": query, "limit": limit, "offset": offset, "source": source})


async def get(refs: list[str]) -> dict[str, Any]:
    """Accept up to 256 refs; return full Notes in request order to a 12,000-character JSON budget.

    One oversized Note is returned alone to guarantee progress. Read the returned Notes, then
    re-request only `omitted_refs` until none remain; omitted Notes are not yet inspected.
    """
    return await _async_call("get", {"refs": refs})


async def _async_call(operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_call, operation, arguments)


def _call(operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    base_url = os.environ.get("PRIME_AGENT_REPORT_NOTES_URL", "").rstrip("/")
    token = os.environ.get("PRIME_AGENT_REPORT_NOTES_TOKEN", "")
    if not base_url or not token:
        raise RuntimeError("Prime Report Note Workspace is not configured")
    payload = {"operation": operation, **{key: value for key, value in arguments.items() if value is not None}}
    request = urllib.request.Request(
        f"{base_url}/v1/notes",
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"Prime Report Note Workspace HTTP {error.code}: {detail}") from error
    if not isinstance(value, dict):
        raise RuntimeError("Prime Report Note Workspace returned an invalid response")
    return value


__all__ = ["summary", "catalog", "search", "get"]
