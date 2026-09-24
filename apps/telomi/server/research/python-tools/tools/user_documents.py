"""Python SDK for user-provided workspace documents."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, TypedDict

from research_runtime import search_source

__all__ = ["UserDocumentRecord", "search"]


class UserDocumentRecord(TypedDict, total=False):
    id: str
    title: str
    url: str
    content_path: str
    snippet: str
    metadata: dict[str, Any]


def search(
    query: str | Sequence[str],
    *,
    max_results: int = 20,
    purpose: str = "Find evidence in user-provided documents",
) -> list[UserDocumentRecord]:
    """Search documents attached to the current workspace.

    Args:
        query: One phrase or a sequence of phrases describing the evidence.
        max_results: Maximum results per phrase, from 1 through 100.
        purpose: Short provenance note for the acquisition.

    Returns:
        Runtime-owned document candidate dictionaries.

    Raises:
        ValueError: If an argument is invalid.
        ResearchRuntimeError: If Runtime document search fails.
    """
    values = [query] if isinstance(query, str) else list(query)
    queries = list(dict.fromkeys(value.strip() for value in values if isinstance(value, str) and value.strip()))
    if not queries:
        raise ValueError("query must contain at least one non-empty string")
    if not isinstance(max_results, int) or not 1 <= max_results <= 100:
        raise ValueError("max_results must be between 1 and 100")
    if not isinstance(purpose, str) or not purpose.strip():
        raise ValueError("purpose must be a non-empty string")
    return search_source([
        {"query": value, "purpose": purpose.strip(), "max_results": max_results}
        for value in queries
    ], source="user_documents")  # type: ignore[return-value]
