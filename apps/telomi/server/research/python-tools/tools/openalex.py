"""OpenAlex native Topic discovery and exact paper acquisition behind Runtime."""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import date
from typing import Any

from research_runtime import ResearchRuntimeError, search_source, workspace_path
from tools import discovery_review

__all__ = ["discover_papers", "download_pdf", "native_query", "topic_info", "topics", "work_info"]
MAX_PAGE_SIZE = 100
MAX_POOL_SIZE = 2_000


def _run(operation: str, parameters: dict[str, Any], limit: int = 1) -> list[dict[str, Any]]:
    rows = search_source([{
        "query": json.dumps({"operation": operation, "parameters": parameters}, sort_keys=True),
        "max_results": limit,
        "provider_request": {"operation": operation, "parameters": parameters},
    }], source="openalex")
    for row in rows:
        metadata = row.get("metadata", {})
        if isinstance(metadata, dict):
            row["openalex_id"] = metadata.get("openalex_id")
            material = metadata.get("markdown_path")
            if isinstance(material, str):
                row["download_path"] = workspace_path(material)
    return rows


def topics(search: str | None = None, *, filter: str | None = None, cursor: str = "*",
           per_page: int = 50) -> list[dict[str, Any]]:
    """List/search native Topic labels and descriptions; page metadata is in metadata.openalex_page."""
    params = _list_parameters(search, filter, cursor, per_page, "works_count:desc")
    return _run("topics", params, per_page)


def topic_info(identifier: str) -> list[dict[str, Any]]:
    """Fetch a native Topic description, keywords, hierarchy and siblings by exact T ID."""
    return _run("topic_info", {"identifier": _text(identifier, "identifier")})


def native_query(*, topic_ids: Sequence[str] = (), start_date: str | None = None,
                 end_date: str | None = None, search: str | None = None, filter: str | None = None,
                 cursor: str = "*", per_page: int = 50, sort: str = "publication_date:desc",
                 topic_match: str = "any") -> list[dict[str, Any]]:
    """Fetch one native cursor page; dates are inclusive publication dates, never update dates.

    topic_ids are ORed; other filters are ANDed. topic_match='any' includes
    secondary topics; 'primary' narrows recall. Native search supplements tags.
    Errors retain Runtime's structured code/details and are never retried here.
    """
    if isinstance(topic_ids, str) or not isinstance(topic_ids, Sequence):
        raise TypeError("topic_ids must be a sequence of exact Topic IDs")
    if len(topic_ids) > 100:
        raise ValueError("topic_ids accepts at most 100 IDs")
    if topic_match not in {"any", "primary"}:
        raise ValueError("topic_match must be any or primary")
    params = _list_parameters(search, filter, cursor, per_page, sort)
    params.update({"topic_ids": [_text(value, "topic_ids") for value in topic_ids], "topic_match": topic_match})
    for key, value in (("start_date", start_date), ("end_date", end_date)):
        if value is not None:
            if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
                raise ValueError(f"{key} must use YYYY-MM-DD")
            params[key] = value
    if start_date and end_date and start_date > end_date:
        raise ValueError("start_date must not exceed end_date")
    if not topic_ids and not filter and not search:
        raise ValueError("query requires topic_ids, filter, or search")
    return _run("query", params, per_page)


def discover_papers(topic_ids: Sequence[str], *, start_date: str, end_date: str,
                    limit: int = 300, per_page: int = 50, cursor: str = "*",
                    search: str | None = None, filter: str | None = None,
                    topic_match: str = "any") -> dict[str, Any]:
    """Build a bounded Topic-first pool, retaining completed pages if Runtime stops acquisition.

    Review records before downloading selected full text. complete=false plus
    next_cursor means a bounded slice, not exhaustive coverage. A failed page
    returns source_unavailable, exact error details and uncovered_range; Root
    owns cross-Provider fallback. Non-availability errors propagate unchanged.
    """
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_POOL_SIZE:
        raise ValueError(f"limit must be between 1 and {MAX_POOL_SIZE}")
    if not topic_ids:
        raise ValueError("discover_papers requires native Topic IDs; use native_query for supplemental search")
    _list_parameters(search, filter, cursor, per_page, "publication_date:desc")
    records: list[dict[str, Any]] = []
    identities: set[str] = set()
    cursors: set[str] = set()
    current: str | None = cursor
    total_count: int | None = None
    error_info: dict[str, Any] | None = None
    complete = False
    # Bound calls even if an unstable index repeats records while changing its cursor.
    for _ in range(min(limit, 100)):
        if current is None or len(records) >= limit:
            break
        if current in cursors:
            raise ResearchRuntimeError("OpenAlex repeated a cursor; acquisition stopped",
                                       code="invalid_provider_response", details={"operation": "query"})
        cursors.add(current)
        try:
            page = native_query(topic_ids=topic_ids, start_date=start_date, end_date=end_date,
                                search=search, filter=filter, cursor=current,
                                per_page=min(per_page, limit - len(records)), topic_match=topic_match)
        except ResearchRuntimeError as error:
            if error.code not in {"source_unavailable", "provider_daily_budget_exhausted", "provider_credentials"}:
                raise
            error_info = {"code": error.code, "message": str(error), "failure_class": error.failure_class,
                          "retryable": error.retryable, "retry_after_ms": error.retry_after_ms,
                          "details": error.details}
            break
        if not page:
            current, complete = None, True
            break
        meta = page[0].get("metadata", {}).get("openalex_page", {})
        total_count = meta.get("count")
        next_cursor = meta.get("next_cursor")
        if next_cursor is not None and not isinstance(next_cursor, str):
            raise ResearchRuntimeError("OpenAlex returned an invalid cursor", code="invalid_provider_response")
        for row in page:
            identity = row.get("openalex_id") or row.get("id")
            if identity not in identities:
                identities.add(identity)
                records.append(row)
        current = next_cursor
        if current is None:
            complete = True
            break
    # Every record is returned at once, so the pool counts as read when it is built.
    key = f"{','.join(topic_ids)}|{start_date}|{end_date}|{search or ''}|{filter or ''}|{topic_match}"
    discovery_review.register_pool("openalex", key, [str(row.get("url") or row.get("id") or "") for row in records])
    discovery_review.mark_served("openalex", key, len(records))
    return {"records": records, "unique_count": len(records), "total_count": total_count,
            "next_cursor": current, "complete": complete, "source_unavailable": error_info is not None,
            "error": error_info,
            "uncovered_range": {"start_date": start_date, "end_date": end_date,
                                "remaining_cursor": current} if not complete else None,
            "guidance": "Screen title/abstract semantically; retain native queries and publication dates. "
                        "A partial or failed pool does not establish complete date coverage."}


def work_info(identifier: str) -> list[dict[str, Any]]:
    """Fetch exact W ID or DOI metadata, affiliations, Topic predictions, locations and content availability."""
    return _run("work_info", {"identifier": _text(identifier, "identifier")})


def download_pdf(identifier: str) -> list[dict[str, Any]]:
    """Retain the official OpenAlex cached PDF and converted Markdown for a selected W ID or DOI.

    Requires a configured free API key. Missing PDF remains a precise error;
    neither this Tool nor Source Service substitutes arXiv or a publisher.
    """
    return _run("download_pdf", {"identifier": _text(identifier, "identifier")})


def _text(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be non-empty text")
    return value.strip()


def _list_parameters(search: str | None, filter: str | None, cursor: str, per_page: int,
                     sort: str) -> dict[str, Any]:
    if not isinstance(per_page, int) or isinstance(per_page, bool) or not 1 <= per_page <= MAX_PAGE_SIZE:
        raise ValueError(f"per_page must be between 1 and {MAX_PAGE_SIZE}")
    params = {"cursor": _text(cursor, "cursor"), "per_page": per_page, "sort": _text(sort, "sort")}
    for key, value in (("search", search), ("filter", filter)):
        if value is not None:
            params[key] = _text(value, key)
    return params
