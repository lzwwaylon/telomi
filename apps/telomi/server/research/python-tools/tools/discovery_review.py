"""Record of the discovery pools a Provider child has been served in this kernel.

Discovery operations register the bounded pool they build and how far each page they serve reads
into it. The Candidate Ledger embeds that record, so what a child was served can be compared with
what it retained.
"""

from __future__ import annotations

import copy

_POOLS: dict[str, dict[str, object]] = {}


def register_pool(provider: str, key: str, urls: list[str]) -> None:
    """Record a newly built discovery pool; the same key re-registers idempotently."""
    _POOLS[f"{provider}:{key}"] = {
        "provider": provider,
        "key": key,
        "urls": list(dict.fromkeys(url for url in urls if isinstance(url, str) and url)),
        "served": 0,
    }


def mark_served(provider: str, key: str, end: int) -> None:
    """Record that records up to ``end`` of the pool have been returned to the Agent."""
    pool = _POOLS.get(f"{provider}:{key}")
    if pool is not None:
        pool["served"] = max(int(pool["served"]), end)  # type: ignore[call-overload]


def pools() -> list[dict[str, object]]:
    """Every registered pool as ``{provider, key, size, served, urls}`` in registration order."""
    return [
        {"provider": pool["provider"], "key": pool["key"], "size": len(pool["urls"]),  # type: ignore[arg-type]
         "served": pool["served"], "urls": copy.deepcopy(pool["urls"])}
        for pool in _POOLS.values()
    ]


def reset() -> None:
    """Forget every pool; tests only."""
    _POOLS.clear()


__all__ = ["mark_served", "pools", "register_pool", "reset"]
