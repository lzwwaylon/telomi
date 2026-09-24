"""Python API for the native arXiv Export API.

Import this module from a PrimeSearch pipeline. Every acquisition function
returns ordinary Python dictionaries. Network access, credentials, retries,
concurrency, cancellation, provenance, and ledgers remain owned by Runtime.
"""

from __future__ import annotations

import argparse
import re
from collections.abc import Sequence
from datetime import date, timedelta
from difflib import get_close_matches
from typing import Any, Literal, TypedDict

from research_runtime import ResearchRuntimeError, log_tool_failure, search_source, workspace_path

from tools.links import extract_links

__all__ = [
    "ArxivDiscovery",
    "Category",
    "Paper",
    "PaperProfile",
    "categories",
    "discover_papers",
    "download_pdf",
    "fetch_ids",
    "field",
    "native_query",
    "paper_profile",
    "search",
    "submitted_date",
]

SortBy = Literal["relevance", "lastUpdatedDate", "submittedDate"]
SortOrder = Literal["ascending", "descending"]
HttpMethod = Literal["auto", "get", "post"]
SearchField = Literal["ti", "au", "abs", "co", "jr", "cat", "rn", "id", "all"]

SEARCH_FIELDS: tuple[SearchField, ...] = ("ti", "au", "abs", "co", "jr", "cat", "rn", "id", "all")
SORT_BY_VALUES: tuple[SortBy, ...] = ("relevance", "lastUpdatedDate", "submittedDate")
SORT_ORDER_VALUES: tuple[SortOrder, ...] = ("ascending", "descending")
HTTP_METHOD_VALUES: tuple[HttpMethod, ...] = ("auto", "get", "post")
MAX_RESULTS_PER_REQUEST = 50
MAX_TOTAL_RESULTS = 30_000
RECOMMENDED_PAGE_SIZE = MAX_RESULTS_PER_REQUEST
MAX_ID_LIST = 10_000
DISCOVERY_LANE_LIMIT = 100
DISCOVERY_PAGE_SIZE = 20
MAX_PDF_DOWNLOADS_PER_SESSION = 50
EMAIL_ADDRESS = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")
SHORT_CAPITALISED_PHRASE = re.compile(r"[A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,5}")
DISCOVERY_CURSOR_PREFIX = "arxiv-discovery:"
# Profile keys returned only on request; the default profile stays small enough to review in bulk.
OPTIONAL_PROFILE_FIELDS = ("abstract", "authors", "all_links")
# Named sentence patterns for front-matter statements; any other string is compiled as a custom regex.
STATEMENT_PRESETS: dict[str, str] = {
    "artifact_release": (
        r"\b(?:code|weights?|checkpoints?|model cards?|pretrained models?)\b.{0,120}"
        r"\b(?:available|released?|open[ -]sourced?|public(?:ly)?)\b"
        r"|\b(?:available|released?|open[ -]sourced?|public(?:ly)?)\b.{0,120}"
        r"\b(?:code|weights?|checkpoints?|model cards?|pretrained models?)\b"
    ),
    "dataset_release": (
        r"\b(?:datasets?|corpus|corpora|benchmark)\b.{0,120}\b(?:available|released?|open[ -]sourced?|public(?:ly)?)\b"
        r"|\b(?:available|released?|open[ -]sourced?|public(?:ly)?)\b.{0,120}\b(?:datasets?|corpus|corpora|benchmark)\b"
    ),
    "demo": r"\b(?:demo|samples?|audio samples?|project page)\b.{0,80}\bhttps?://",
}
CATEGORY_ID = re.compile(r"[a-z-]+(?:\.[A-Za-z-]+)?")

# ponytail: one worker owns one Python kernel, so process-local paging state is sufficient.
_pending_discovery: tuple[str, str] | None = None
_discovery_pool: tuple[str, list[Paper], dict[str, int], dict[str, str], list[dict[str, str]], bool] | None = None
_inside_discovery = False
_downloaded_pdf_ids: set[str] = set()
# Identifiers whose most recent download_pdf() call failed, with the error; see download_failures().
_last_download_failures: dict[str, str] = {}


def download_failures() -> dict[str, str]:
    """Return the papers skipped by the last download_pdf() call, keyed by identifier, with the Provider error."""
    return dict(_last_download_failures)


class Paper(TypedDict, total=False):
    id: str
    title: str
    url: str
    content_path: str
    snippet: str
    published_at: str
    authors: list[str]
    metadata: dict[str, Any]
    identifiers: list[dict[str, Any]]
    query_sequences: list[int]
    pdf_path: str
    markdown_path: str
    artifact_path: str
    download_path: str
    material_cache_hit: bool
    discovery_lanes: list[dict[str, Any]]


class PaperProfile(TypedDict, total=False):
    arxiv_id: str
    version: str
    title: str
    abstract: str
    authors: list[str]
    categories: list[str]
    primary_category: str | None
    published_at: str | None
    updated_at: str | None
    comment: str | None
    comment_links: list[dict[str, Any]]
    journal_ref: str | None
    front_source: str  # html, unavailable, or error (see front_error)
    front_error: str
    affiliations: list[dict[str, str]]
    team_name: str | None
    email_domains: list[str]
    links: list[dict[str, Any]]
    statements: list[dict[str, str]]


class Category(TypedDict, total=False):
    id: str
    title: str
    url: str
    snippet: str
    metadata: dict[str, Any]
    resource_type: str
    category_id: str
    category_label: str
    description: str


class ArxivDiscovery(TypedDict):
    records: list[Paper]  # Current cursor page from the complete discovery pool.
    lane_counts: dict[str, int]  # Records returned by each monthly lane.
    saturated_lanes: list[str]  # Lanes truncated at DISCOVERY_LANE_LIMIT.
    failed_lanes: dict[str, str]  # Months whose Provider request failed, with the error.
    uncovered_ranges: list[dict[str, str]]  # Contiguous start_date/end_date ranges the failed months leave out.
    source_unavailable: bool  # Runtime stopped this Provider Child after exhausting its overload budget.
    guidance: str
    unique_count: int  # Every unique record returned by the monthly lanes.
    returned_count: int
    next_cursor: str | None


_HELP = """arXiv Python API

Import and call it from your own pipeline:

  from tools import arxiv

  papers = arxiv.search(
      'cat:cs.AI AND ti:"agent skill"',
      limit=300,
      sort_by="submittedDate",
      sort_order="descending",
  )
  speech_categories = arxiv.categories(search="speech")

  known = arxiv.fetch_ids(["2602.12670", "2605.23904v2"])
  profiles = arxiv.paper_profile(["2602.12670", "2605.23904v2"], depth="front")
  document = arxiv.download_pdf("2602.12670")

All acquisition functions return list[Paper]. No plan file or receipt is
involved. Filter, join, and write these dictionaries with normal Python.

native_query exposes the complete arXiv Export API query surface:
search_query, id_list, start, max_results, sortBy, sortOrder, and GET/POST
selection. search_query supports ti, au, abs, co, jr, cat, rn, id, all,
boolean operators, grouping, quoted phrases, and submittedDate ranges.
search automatically issues continuous Provider requests when limit exceeds
50. Page offsets remain internal to this module.
"""


# Provider record ``id`` (``arxiv-<hash>``) to the arXiv identifier of that record, filled from every returned Paper
# so record ids passed back to id_list resolve instead of reaching arXiv as HTTP 400.
_record_arxiv_ids: dict[str, str] = {}
RECORD_ID = re.compile(r"^(?:arxiv-)?([0-9a-f]{32})$")


def _normalize_ids(values: str | Sequence[str] | None) -> list[str]:
    if values is None:
        return []
    rows = values.split(",") if isinstance(values, str) else list(values)
    normalized: list[str] = []
    for value in rows:
        if not isinstance(value, str) or not value.strip():
            continue
        identifier = value.strip().rstrip("/")
        record_id = RECORD_ID.match(identifier)
        if record_id:
            resolved = _record_arxiv_ids.get(record_id.group(1))
            if not resolved:
                raise ValueError(
                    f"'{identifier}' is a Provider record id, not an arXiv identifier; "
                    "pass metadata['arxiv_id'] or the arxiv.org URL from the record"
                )
            identifier = resolved
        for marker in ("/abs/", "/pdf/"):
            if marker in identifier:
                identifier = identifier.split(marker, 1)[1]
        if identifier.lower().endswith(".pdf"):
            identifier = identifier[:-4]
        if identifier and identifier not in normalized:
            normalized.append(identifier)
    if len(normalized) > MAX_ID_LIST:
        raise ValueError(f"id_list cannot exceed {MAX_ID_LIST} identifiers")
    return normalized


def _native_request(
    *,
    search_query: str | None = None,
    id_list: str | Sequence[str] | None = None,
    start: int = 0,
    max_results: int = 10,
    sort_by: SortBy | None = None,
    sort_order: SortOrder | None = None,
    http_method: HttpMethod = "auto",
    purpose: str = "Acquire primary arXiv metadata",
) -> dict[str, Any]:
    query = search_query.strip() if isinstance(search_query, str) else None
    identifiers = _normalize_ids(id_list)
    if not query and not identifiers:
        raise ValueError("search_query, id_list, or both are required")
    if query is not None and len(query) > 20_000:
        raise ValueError("search_query must be at most 20000 characters")
    if not isinstance(start, int) or start < 0:
        raise ValueError("start must be a non-negative integer")
    if not isinstance(max_results, int) or not 1 <= max_results <= MAX_RESULTS_PER_REQUEST:
        raise ValueError(
            f"max_results must be between 1 and {MAX_RESULTS_PER_REQUEST}; "
            "use arxiv.search(..., limit=...) for larger acquisitions"
        )
    if sort_by is not None and sort_by not in SORT_BY_VALUES:
        raise ValueError(f"sort_by must be one of {SORT_BY_VALUES}")
    if sort_order is not None and sort_order not in SORT_ORDER_VALUES:
        raise ValueError(f"sort_order must be one of {SORT_ORDER_VALUES}")
    if http_method not in HTTP_METHOD_VALUES:
        raise ValueError(f"http_method must be one of {HTTP_METHOD_VALUES}")

    parameters: dict[str, Any] = {
        "start": start,
        "max_results": max_results,
        "http_method": http_method,
    }
    if query:
        parameters["search_query"] = query
    if identifiers:
        parameters["id_list"] = identifiers
    if sort_by is not None:
        parameters["sortBy"] = sort_by
    if sort_order is not None:
        parameters["sortOrder"] = sort_order
    return {
        "query": query or f"id_list={','.join(identifiers)}",
        "purpose": purpose,
        "max_results": max_results,
        "provider_request": {"operation": "query", "parameters": parameters},
    }


def _run(requests: Sequence[dict[str, Any]]) -> list[Paper]:
    rows = list(requests)
    if not rows:
        raise ValueError("at least one arXiv request is required")
    return [_public_record(row) for row in search_source(rows, source="arxiv")]


def native_query(
    *,
    search_query: str | None = None,
    id_list: str | Sequence[str] | None = None,
    start: int = 0,
    max_results: int = 10,
    sort_by: SortBy | None = None,
    sort_order: SortOrder | None = None,
    http_method: HttpMethod = "auto",
    purpose: str = "Acquire primary arXiv metadata",
) -> list[Paper]:
    """Run one request against the native arXiv Export API.

    Args:
        search_query: Native arXiv query expression, such as
            ``cat:cs.AI AND ti:"agent skill"``.
        id_list: One arXiv ID, URL, or sequence of IDs and URLs. Version
            suffixes such as ``v2`` are preserved.
        start: Zero-based result offset.
        max_results: Maximum number of results to return, up to 50.
        sort_by: Native arXiv sort field.
        sort_order: Ascending or descending result order.
        http_method: Whether Runtime should use GET, POST, or choose
            automatically.
        purpose: Short provenance note describing why the request is made.

    Returns:
        A list of paper dictionaries containing the Provider record ``id``,
        ``title``, ``url``, abstract snippet, and available metadata. Read the
        arXiv identifier from ``metadata["arxiv_id"]`` or
        ``metadata["arxiv_version_id"]``.

    Raises:
        ValueError: If neither a query nor IDs are supplied, or if a native
            parameter is invalid.
        ResearchRuntimeError: If Runtime or the arXiv provider fails.
    """
    _require_discovery_complete()
    return _run([_native_request(
        search_query=search_query,
        id_list=id_list,
        start=start,
        max_results=max_results,
        sort_by=sort_by,
        sort_order=sort_order,
        http_method=http_method,
        purpose=purpose,
    )])


def categories(
    *,
    search: str | Sequence[str] | None = None,
    max_results: int = 500,
    purpose: str = "Discover arXiv subject categories",
) -> list[Category]:
    """List current arXiv subject categories from the official taxonomy.

    Args:
        search: Optional text or texts matched against category IDs, names, and descriptions.
        max_results: Maximum matching categories to return, up to 500.
        purpose: Short provenance note describing why categories are needed.

    Returns:
        Category records containing ``category_id``, label, and description.

    Raises:
        ValueError: If the search text or result limit is invalid.
        ResearchRuntimeError: If Runtime or arXiv fails.
    """
    if not isinstance(max_results, int) or not 1 <= max_results <= 500:
        raise ValueError("max_results must be between 1 and 500")
    parameters: dict[str, Any] = {}
    if search is not None:
        values = [search] if isinstance(search, str) else list(search)
        normalized: list[str] = []
        for value in values:
            if not isinstance(value, str) or not value.strip() or len(value) > 200:
                raise ValueError("each search value must be non-empty and at most 200 characters")
            if value.strip() not in normalized:
                normalized.append(value.strip())
        if not normalized:
            raise ValueError("search must contain at least one text value")
        parameters["search"] = normalized
    records: list[Category] = []
    for start in range(0, max_results, MAX_RESULTS_PER_REQUEST):
        size = min(MAX_RESULTS_PER_REQUEST, max_results - start)
        page_parameters = {**parameters, "start": start, "max_results": size}
        page = _run([{
            "query": f"categories:{','.join(parameters.get('search', ['all']))}:{start}",
            "purpose": purpose,
            "max_results": size,
            "provider_request": {"operation": "categories", "parameters": page_parameters},
        }])
        records.extend(page)  # type: ignore[arg-type]
        if len(page) < size:
            break
    return records[:max_results]


def discover_papers(
    categories: Sequence[str],
    concepts: Sequence[str],
    *,
    start_date: str,
    end_date: str,
    cursor: str | None = None,
    purpose: str = "Discover papers within arXiv subject categories",
) -> ArxivDiscovery:
    """Build one paper pool from monthly arXiv relevance lanes.

    The operation joins research-object concepts with OR, searches title and
    abstract, expands hyphen/space variants, interleaves Provider-native
    relevance results across calendar months, and returns one compact page from
    a pool containing every unique record returned by those monthly lanes. A
    lane that reaches the lane limit is truncated.

    Args:
        categories: Plausible arXiv category IDs. The operation verifies them
            against the current official taxonomy.
        concepts: Flat list of equivalent research-object phrases or abbreviations.
        start_date: Inclusive ``YYYY-MM-DD`` date.
        end_date: Inclusive ``YYYY-MM-DD`` date.
        cursor: Exact ``next_cursor`` from the preceding discovery page.
        purpose: Short provenance note describing why the search is made.

    Returns:
        One compact page, lane counts, failed lanes with their uncovered date
        ranges, pool count, and next cursor. Once arXiv is unavailable to this
        Provider Child, the remaining months are not requested and count as
        failed.

    Raises:
        ValueError: If categories, concepts, or dates are invalid.
        ResearchRuntimeError: If every monthly lane fails. The code is
            ``source_unavailable`` when arXiv is temporarily unavailable; its
            ``details`` then carry ``provider_id``, ``failure_class``,
            ``elapsed_ms``, ``attempts``, ``retry_after_ms``, and
            ``uncovered_ranges``.
    """
    global _discovery_pool, _inside_discovery, _pending_discovery
    offset = _discovery_offset(cursor)
    category_ids: list[str] = []
    for category in categories:
        value = category.strip() if isinstance(category, str) else ""
        if not CATEGORY_ID.fullmatch(value):
            raise ValueError("categories must contain valid arXiv category IDs")
        if value not in category_ids:
            category_ids.append(value)
    if not category_ids or len(category_ids) > 50:
        raise ValueError("categories must contain between 1 and 50 IDs")

    concept_terms = _discovery_terms(concepts, "concepts", required=True)
    concept_variants = list(dict.fromkeys(
        variant
        for concept in concept_terms
        for variant in _term_variants(concept)
    ))
    if len(concept_variants) > 100:
        raise ValueError("concepts must produce at most 100 phrase variants")

    category_boundary = "(" + " OR ".join(field("cat", value) for value in category_ids) + ")"
    concept_boundary = "(" + " OR ".join(
        expression
        for value in concept_variants
        for expression in (field("ti", value, phrase=True), field("abs", value, phrase=True))
    ) + ")"
    query_boundary = f"{category_boundary} AND {concept_boundary}"
    query = f"{query_boundary} AND {submitted_date(start_date, end_date)}"
    if cursor and not _pending_discovery:
        raise ValueError("cursor is not active; restart discovery without a cursor")
    if _pending_discovery and _pending_discovery != (query, cursor):
        raise RuntimeError(
            f"Finish the active arXiv discovery first with cursor={_pending_discovery[1]!r} "
            "and the same categories, concepts, and dates"
        )
    if cursor is None:
        _validate_category_ids(category_ids)
        _inside_discovery = True
        lanes: dict[str, list[Paper]] = {}
        failed_lanes: dict[str, str] = {}
        uncovered: list[dict[str, str]] = []
        unavailable: ResearchRuntimeError | None = None
        month_ranges = _month_ranges(start_date, end_date)

        def mark_uncovered(month: str, month_start: str, month_end: str, error: BaseException) -> None:
            failed_lanes[month] = str(error)[:300]
            lanes[month] = []
            previous_end = date.fromisoformat(uncovered[-1]["end_date"]) if uncovered else None
            if previous_end is not None and previous_end + timedelta(days=1) == date.fromisoformat(month_start):
                uncovered[-1]["end_date"] = month_end
            else:
                uncovered.append({"start_date": month_start, "end_date": month_end})

        try:
            for index, (month, month_start, month_end) in enumerate(month_ranges):
                lane_query = f"{query_boundary} AND {submitted_date(month_start, month_end)}"
                try:
                    lanes[month] = search(
                        lane_query,
                        limit=DISCOVERY_LANE_LIMIT,
                        sort_by="relevance",
                        sort_order="descending",
                        purpose=purpose,
                    )
                except Exception as error:  # noqa: BLE001 - one month must not discard the others
                    mark_uncovered(month, month_start, month_end, error)
                    log_tool_failure("arxiv", "discover_papers.lane", lane_query, error)
                    unavailable = _unavailable(error)
                    if unavailable is not None:
                        for remaining in month_ranges[index + 1:]:
                            mark_uncovered(*remaining, unavailable)
                        break
        finally:
            _inside_discovery = False
        if failed_lanes and len(failed_lanes) == len(lanes):
            if unavailable is not None:
                raise ResearchRuntimeError(
                    f"arXiv is temporarily unavailable and no discovery lane was covered: {unavailable}",
                    code="source_unavailable",
                    failure_class=unavailable.failure_class,
                    retry_after_ms=unavailable.retry_after_ms,
                    details={**unavailable.details, "uncovered_ranges": uncovered},
                )
            raise ResearchRuntimeError(
                "every discovery lane failed: "
                + "; ".join(f"{month}: {error}" for month, error in failed_lanes.items()),
                code="arxiv_discovery_failed",
                failure_class="provider",
            )
        records: dict[str, Paper] = {}
        lane_ids: dict[str, list[str]] = {}
        for lane, rows in lanes.items():
            lane_ids[lane] = []
            for rank, row in enumerate(rows, start=1):
                metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
                identity = str(metadata.get("arxiv_id") or row.get("id") or row.get("url") or "")
                if not identity:
                    continue
                record = records.setdefault(identity, {
                    **row,
                    "discovery_lanes": [],
                })
                record["discovery_lanes"].append({"lane": lane, "rank": rank})
                lane_ids[lane].append(identity)

        ordered_ids: list[str] = []
        seen: set[str] = set()
        for rank in range(max(map(len, lane_ids.values()), default=0)):
            for lane in lane_ids:
                if rank >= len(lane_ids[lane]):
                    continue
                identity = lane_ids[lane][rank]
                if identity not in seen:
                    seen.add(identity)
                    ordered_ids.append(identity)
        ordered = [records[identity] for identity in ordered_ids]
        lane_counts = {lane: len(rows) for lane, rows in lanes.items()}
        source_unavailable = unavailable is not None
        _discovery_pool = (query, ordered, lane_counts, failed_lanes, uncovered, source_unavailable)
    elif not _discovery_pool or _discovery_pool[0] != query:
        raise ValueError("discovery cursor has no active candidate pool; restart without a cursor")
    else:
        _, ordered, lane_counts, failed_lanes, uncovered, source_unavailable = _discovery_pool

    if offset and offset >= len(ordered):
        raise ValueError("cursor is beyond the current discovery pool; restart without a cursor")
    end = min(offset + DISCOVERY_PAGE_SIZE, len(ordered))
    page = ordered[offset:end]
    next_cursor = f"{DISCOVERY_CURSOR_PREFIX}{end}" if end < len(ordered) else None
    _pending_discovery = (query, next_cursor) if next_cursor else None
    if next_cursor is None:
        _discovery_pool = None
    return {
        "records": page,
        "lane_counts": lane_counts,
        "saturated_lanes": [lane for lane, count in lane_counts.items() if count >= DISCOVERY_LANE_LIMIT],
        "failed_lanes": failed_lanes,
        "uncovered_ranges": uncovered,
        "source_unavailable": source_unavailable,
        "guidance": _discovery_guidance(lane_counts, failed_lanes, uncovered),
        "unique_count": len(ordered),
        "returned_count": len(page),
        "next_cursor": next_cursor,
    }


def _discovery_terms(values: Sequence[str], label: str, *, required: bool) -> list[str]:
    if isinstance(values, (str, bytes)):
        raise ValueError(f"{label} must be a flat sequence of phrases")
    terms: list[str] = []
    for item in values:
        value = item.strip() if isinstance(item, str) else ""
        if not value or len(value) > 200:
            raise ValueError(f"{label} must contain non-empty text phrases up to 200 characters")
        if value not in terms:
            terms.append(value)
    if required and not terms:
        raise ValueError(f"{label} must contain at least one phrase")
    if len(terms) > 50:
        raise ValueError(f"{label} cannot contain more than 50 phrases")
    return terms


def _term_variants(value: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys((value, value.replace("-", " "), value.replace(" ", "-"))))


def _validate_category_ids(category_ids: Sequence[str]) -> None:
    taxonomy = categories(
        max_results=500,
        purpose="Validate proposed arXiv subject categories",
    )
    known = {str(row.get("category_id")) for row in taxonomy if row.get("category_id")}
    unknown = [category_id for category_id in category_ids if category_id not in known]
    if not unknown:
        return
    suggestions = ", ".join(dict.fromkeys(
        suggestion
        for category_id in unknown
        for suggestion in get_close_matches(category_id, known, n=5, cutoff=0.35)
    ))
    raise ValueError(
        f"Unknown arXiv categories: {', '.join(unknown)}. "
        "Exact taxonomy validation found no matching IDs. "
        f"Close official category IDs: {suggestions or 'none'}. "
        "The IDs may be mistyped or no longer present; use categories(search=[domain concepts], max_results=10), "
        "inspect the returned official IDs, then retry discover_papers()."
    )


def _unavailable(error: BaseException) -> ResearchRuntimeError | None:
    """Return ``error`` when Runtime reports arXiv unavailable to this Provider Child."""
    return error if isinstance(error, ResearchRuntimeError) and error.code == "source_unavailable" else None


def _discovery_guidance(
    lane_counts: dict[str, int],
    failed_lanes: dict[str, str] | None = None,
    uncovered_ranges: Sequence[dict[str, str]] = (),
) -> str:
    saturated = [lane for lane, count in lane_counts.items() if count >= DISCOVERY_LANE_LIMIT]
    parts: list[str] = []
    if failed_lanes:
        ranges = ", ".join(f"{row['start_date']} to {row['end_date']}" for row in uncovered_ranges)
        parts.append(
            f"The Provider request failed for lanes: {', '.join(failed_lanes)}; "
            f"those months are missing from the pool (uncovered: {ranges}). "
            "When a lane error says arXiv is temporarily unavailable, do not retry it in this assignment; "
            "report the uncovered ranges as a coverage gap. "
            "Otherwise, after the cursor is finished, run discover_papers() again for each failed month alone."
        )
    if saturated:
        parts.append(
            f"Discovery reached the {DISCOVERY_LANE_LIMIT}-result lane limit in lanes: {', '.join(saturated)}. "
            "Results are not complete for the saturated scope. "
            "Finish the current cursor, then split saturated periods into non-overlapping shorter date ranges or run a "
            "small fielded supplemental search. Regex may prioritize review, but verify exclusions from each record's "
            "title and abstract before dropping them."
        )
    return " ".join(parts)


def _discovery_offset(cursor: str | None) -> int:
    if cursor is None:
        return 0
    if not isinstance(cursor, str) or not cursor.startswith(DISCOVERY_CURSOR_PREFIX):
        raise ValueError("cursor must be the exact next_cursor returned by discover_papers()")
    value = cursor.removeprefix(DISCOVERY_CURSOR_PREFIX)
    if not value.isdigit():
        raise ValueError("cursor must be the exact next_cursor returned by discover_papers()")
    return int(value)


def _month_ranges(start: str, end: str) -> list[tuple[str, str, str]]:
    try:
        first = date.fromisoformat(start)
        last = date.fromisoformat(end)
    except ValueError as error:
        raise ValueError("dates must use YYYY-MM-DD") from error
    if first > last:
        raise ValueError("start date must not be after end date")
    ranges: list[tuple[str, str, str]] = []
    cursor = first.replace(day=1)
    while cursor <= last:
        following = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
        month_start = max(first, cursor)
        month_end = min(last, following - timedelta(days=1))
        ranges.append((cursor.strftime("%Y-%m"), month_start.isoformat(), month_end.isoformat()))
        if len(ranges) > 36:
            raise ValueError("discover_papers supports up to 36 calendar months; split a longer interval")
        cursor = following
    return ranges


def search(
    query: str | Sequence[str],
    *,
    limit: int | None = None,
    sort_by: SortBy = "submittedDate",
    sort_order: SortOrder = "descending",
    http_method: HttpMethod = "auto",
    purpose: str = "Acquire primary arXiv papers",
) -> list[Paper]:
    """Search arXiv with one or more native query expressions.

    This is the usual entry point for topic searches. Pagination is automatic:
    ``limit`` is the final bound for each expression and defaults to one page of
    50 results when omitted or ``None``. Pass a larger explicit ``limit`` only for
    an explicitly exhaustive assignment. Page offsets are internal.

    Args:
        query: One native arXiv query expression or a sequence of expressions.
        limit: Final result bound for each expression, from 1 through 30000.
            ``None`` means the default page of 50 results.
        sort_by: Native arXiv sort field.
        sort_order: Ascending or descending result order.
        http_method: Whether Runtime should use GET, POST, or choose
            automatically.
        purpose: Short provenance note describing why the search is made.

    Returns:
        A deduplicated list of paper dictionaries.

    Raises:
        ValueError: If no usable query is supplied or a parameter is invalid.
        ResearchRuntimeError: If Runtime or the arXiv provider fails.
    """
    _require_discovery_complete()
    if limit is None:
        limit = RECOMMENDED_PAGE_SIZE
    if not isinstance(limit, int) or not 1 <= limit <= MAX_TOTAL_RESULTS:
        raise ValueError(f"limit must be between 1 and {MAX_TOTAL_RESULTS}")
    raw_values = [query] if isinstance(query, str) else list(query)
    values: list[str] = []
    for value in raw_values:
        if isinstance(value, str) and value.strip() and value.strip() not in values:
            values.append(value.strip())
    if not values:
        raise ValueError("query must contain at least one native arXiv expression")
    if limit is not None and limit <= MAX_RESULTS_PER_REQUEST:
        return _run([
            _native_request(
                search_query=value,
                max_results=limit,
                sort_by=sort_by,
                sort_order=sort_order,
                http_method=http_method,
                purpose=purpose,
            )
            for value in values
        ])

    papers: list[Paper] = []
    seen: set[str] = set()
    for value in values:
        # Keep page offsets inside this module. Exposing a second pagination
        # operation caused PrimeSearchs to mix page size and absolute offsets.
        for paper in _paginate(
            value,
            total_results=limit,
            require_complete=False,
            sort_by=sort_by,
            sort_order=sort_order,
            http_method=http_method,
            purpose=purpose,
        ):
            identity = str(paper.get("id") or paper.get("url") or "")
            if identity and identity in seen:
                continue
            if identity:
                seen.add(identity)
            papers.append(paper)
    return papers


def _require_discovery_complete() -> None:
    if _pending_discovery and not _inside_discovery:
        raise RuntimeError(
            f"Finish the active arXiv discovery first with cursor={_pending_discovery[1]!r}; "
            "native search is available after next_cursor is null"
        )


def fetch_ids(
    arxiv_ids: str | Sequence[str],
    *,
    search_query: str | None = None,
    start: int = 0,
    max_results: int | None = None,
    sort_by: SortBy | None = None,
    sort_order: SortOrder | None = None,
    http_method: HttpMethod = "auto",
    purpose: str = "Acquire known primary arXiv papers",
) -> list[Paper]:
    """Fetch papers by known arXiv identifiers.

    Args:
        arxiv_ids: One arXiv ID, URL, or sequence of IDs and URLs.
        search_query: Optional native expression combined with ``id_list``.
        start: Zero-based result offset.
        max_results: Maximum results to return. Defaults to the number of IDs.
        sort_by: Optional native arXiv sort field.
        sort_order: Optional ascending or descending result order.
        http_method: Whether Runtime should use GET, POST, or choose
            automatically.
        purpose: Short provenance note describing why the lookup is made.

    Returns:
        A list of paper dictionaries in the provider response.

    Raises:
        ValueError: If no usable ID is supplied or a parameter is invalid.
        ResearchRuntimeError: If Runtime or the arXiv provider fails.
    """
    identifiers = _normalize_ids(arxiv_ids)
    if not identifiers:
        raise ValueError("arxiv_ids must contain at least one identifier")
    return native_query(
        search_query=search_query,
        id_list=identifiers,
        start=start,
        max_results=max_results or len(identifiers),
        sort_by=sort_by,
        sort_order=sort_order,
        http_method=http_method,
        purpose=purpose,
    )


def paper_profile(
    arxiv_ids: str | Sequence[str],
    *,
    depth: Literal["metadata", "front"] = "metadata",
    fields: Sequence[str] = (),
    statement_patterns: Sequence[str] = (),
    purpose: str = "Profile arXiv papers before PDF acquisition",
) -> list[PaperProfile]:
    """Build compact metadata or HTML-front profiles for exact papers.

    Args:
        arxiv_ids: One arXiv ID, URL, or sequence of IDs and URLs.
        depth: ``metadata`` uses Atom only and returns identity, dates, categories,
            comment, comment links, and journal reference. ``front`` adds one HTML
            request per paper and returns ``front_source``, ``affiliations``,
            ``team_name``, ``email_domains``, and ``links`` limited to the paper's
            own front-matter and self-referencing links.
        fields: Extra keys to include: ``abstract``, ``authors``, ``all_links``
            (every link before the bibliography, ``front`` depth only).
        statement_patterns: Sentence patterns to extract from the front matter at
            ``front`` depth. Preset names are ``artifact_release``,
            ``dataset_release``, and ``demo``; any other value is compiled as a
            case-insensitive regular expression. Matches are returned under
            ``statements`` as ``{"pattern", "text"}``.
        purpose: Short provenance note describing why the profiles are needed.

    Returns:
        Paper profiles with the requested keys only.

    Raises:
        ValueError: If IDs, depth, fields, or patterns are invalid, or discovery
            pagination is active.
        ResearchRuntimeError: If Runtime or arXiv fails.
    """
    identifiers = _normalize_ids(arxiv_ids)
    if not identifiers:
        raise ValueError("arxiv_ids must contain at least one identifier")
    if depth not in ("metadata", "front"):
        raise ValueError("depth must be 'metadata' or 'front'")
    extra = _profile_fields(fields)
    patterns = _statement_patterns(statement_patterns)
    if depth == "metadata" and (patterns or "all_links" in extra):
        raise ValueError("statement_patterns and the all_links field require depth='front'")
    papers = [
        paper
        for start in range(0, len(identifiers), MAX_RESULTS_PER_REQUEST)
        for paper in fetch_ids(identifiers[start:start + MAX_RESULTS_PER_REQUEST], purpose=purpose)
    ]
    profiles = [_metadata_profile(paper, extra) for paper in papers]
    if depth == "metadata":
        return profiles

    # One paper at a time: a failed or malformed front degrades that profile instead of discarding the batch.
    unavailable: ResearchRuntimeError | None = None
    profile_rows = list(zip(profiles, papers, strict=True))
    for index, (profile, paper) in enumerate(profile_rows):
        query = f"paper_front={profile['version']}"
        try:
            rows = _run([{
                "query": query,
                "purpose": purpose,
                "max_results": 1,
                "provider_request": {"operation": "paper_front", "parameters": {"arxiv_id": profile["version"]}},
            }])
            front = next((row["metadata"] for row in rows if isinstance(row.get("metadata"), dict)), {})
            _add_front_profile(profile, front, _strings(paper.get("authors")), extra, patterns)
        except Exception as error:  # noqa: BLE001 - keep the metadata profile and report the failure
            unavailable = unavailable or _unavailable(error)
            _add_front_profile(profile, {}, _strings(paper.get("authors")), extra, patterns)
            profile["front_source"] = "error"
            profile["front_error"] = str(error)[:300]
            log_tool_failure("arxiv", "paper_profile.front", query, error)
            if unavailable is not None:
                for remaining_profile, remaining_paper in profile_rows[index + 1:]:
                    _add_front_profile(
                        remaining_profile, {}, _strings(remaining_paper.get("authors")), extra, patterns,
                    )
                    remaining_profile["front_source"] = "error"
                    remaining_profile["front_error"] = str(unavailable)[:300]
                break
    return profiles


def _profile_fields(fields: Sequence[str]) -> set[str]:
    if isinstance(fields, str):
        fields = [fields]
    unknown = [field for field in fields if field not in OPTIONAL_PROFILE_FIELDS]
    if unknown:
        raise ValueError(f"unknown profile fields {unknown}; choose from {list(OPTIONAL_PROFILE_FIELDS)}")
    return set(fields)


def _statement_patterns(values: Sequence[str]) -> list[tuple[str, re.Pattern[str]]]:
    if isinstance(values, str):
        values = [values]
    patterns: list[tuple[str, re.Pattern[str]]] = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("statement_patterns must be preset names or regular expressions")
        try:
            patterns.append((value, re.compile(STATEMENT_PRESETS.get(value, value), re.IGNORECASE)))
        except re.error as error:
            raise ValueError(f"statement pattern {value!r} is not a valid regular expression: {error}") from error
    return patterns


def _metadata_profile(paper: Paper, extra: set[str]) -> PaperProfile:
    metadata = paper.get("metadata") if isinstance(paper.get("metadata"), dict) else {}
    comment = metadata.get("comment") if isinstance(metadata.get("comment"), str) else None
    version = str(metadata.get("arxiv_version_id") or metadata.get("arxiv_id") or "")
    profile: PaperProfile = {
        "arxiv_id": str(metadata.get("arxiv_id") or re.sub(r"v\d+$", "", version)),
        "version": version,
        "title": str(paper.get("title") or ""),
        "published_at": str(paper["published_at"]) if paper.get("published_at") else None,
        "updated_at": str(metadata["updated_at"]) if metadata.get("updated_at") else None,
        "primary_category": str(metadata["primary_category"]) if metadata.get("primary_category") else None,
        "categories": _strings(metadata.get("categories")),
        "comment": comment,
        "comment_links": extract_links(comment or ""),
        "journal_ref": str(metadata["journal_ref"]) if metadata.get("journal_ref") else None,
    }
    if "abstract" in extra:
        profile["abstract"] = str(paper.get("snippet") or "")
    if "authors" in extra:
        profile["authors"] = _strings(paper.get("authors"))
    return profile


def _add_front_profile(
    profile: PaperProfile,
    front: dict[str, Any],
    authors: Sequence[str],
    extra: set[str],
    patterns: Sequence[tuple[str, re.Pattern[str]]],
) -> None:
    available = front.get("html_available") is True
    profile.update({
        "front_source": "html" if available else "unavailable",
        "affiliations": [],
        "team_name": None,
        "email_domains": [],
        "links": [],
    })
    if patterns:
        profile["statements"] = []
    if not available:
        return
    author_block = str(front.get("author_block_text") or "")
    author_notes = _strings(front.get("author_notes"))
    footnotes = _strings(front.get("footnotes"))
    emails = front.get("emails") if isinstance(front.get("emails"), dict) else {}
    domains = [domain.lower() for domain in _strings(emails.get("domains"))]
    profile["affiliations"] = _affiliations(
        authors, author_block, author_notes, footnotes, domains, _strings(emails.get("addresses"))
    )
    # A block that names no author at all (Atom names never split across markup) is a team byline.
    if author_block and not _mentions_authors(author_block, authors):
        team = " ".join(EMAIL_ADDRESS.sub(" ", author_block).split())
        team = re.sub(r"https?://\S+", " ", team)
        team = re.sub(r"(?i)\b(?:Correspondence|Contact|E-?mails?|Affiliation)\b:?\s*", " ", team)
        team = " ".join(team.split()).strip(" ,;:")
        profile["team_name"] = team or None
    profile["email_domains"] = domains
    links = [
        link for link in extract_links(str(front.get("pre_bibliography_text") or ""))
        if link["position"] != "references"
    ]
    # Body links are mostly citations and demos of other work; keep the paper's own front-matter links by default.
    profile["links"] = links if "all_links" in extra else [
        link for link in links if link["position"] == "front" or link["self_likely"]
    ]
    if patterns:
        profile["statements"] = _statements(" ".join([str(front.get("front_text") or ""), *footnotes]), patterns)


def _affiliations(
    authors: Sequence[str],
    author_block: str,
    author_notes: Sequence[str],
    footnotes: Sequence[str],
    domains: Sequence[str],
    addresses: Sequence[str],
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for raw in author_notes:
        for name in re.findall(r"(?i)\bAffiliation:\s*(.*?)(?=\s+Affiliation:|$)", raw):
            _add_affiliation(rows, name, "structured", raw)

    remaining = author_block
    for author in authors:
        remaining = re.sub(re.escape(author), " ", remaining, flags=re.IGNORECASE)
    # LaTeXML often separates given and family names with superscripts; drop the name tokens one by one too.
    for token in _author_tokens(authors):
        remaining = re.sub(rf"(?<!\w){re.escape(token)}(?!\w)", " ", remaining, flags=re.IGNORECASE)
    for note in author_notes:
        remaining = remaining.replace(note, " ")
    remaining = re.sub(r"(?i)\\sthanks(?:Corresponding author)?|\bCorresponding authors?\b", " ", remaining)
    remaining = EMAIL_ADDRESS.sub(" ", remaining)
    remaining = re.sub(r"https?://\S+", " ", remaining)
    remaining = re.sub(r"(?i)\b(?:Correspondence|Contact|E-?mails?|Equal contributions?)\b:?", " ", remaining)
    remaining = re.sub(r"[\d*†‡§¶#]+", " ", remaining)
    remaining = re.sub(r"(?i)\bAffiliation:\s*", "", remaining)
    fragments = [fragment.strip(" ,;|-:") for fragment in re.split(r"[;|\n]", remaining)]
    fragments = [fragment for fragment in fragments if fragment]
    if len(fragments) == 1 and len(fragments[0]) <= 180 and (
        _looks_like_organisation(fragments[0])
        or (SHORT_CAPITALISED_PHRASE.fullmatch(fragments[0]) and len(fragments[0].split()) >= 2)
    ):
        _add_affiliation(rows, fragments[0], "author_block", author_block)
    else:
        for fragment in fragments:
            if _looks_like_organisation(fragment):
                _add_affiliation(rows, fragment, "author_block", author_block)

    for raw in footnotes:
        body = re.sub(r"(?is)^.*?\baddress:\s*", "", raw)
        fragments = re.split(r"(?:^|(?<=\s))\d+[.)]?\s*(?=[A-Z])", body)
        values = [fragment.strip(" ,;|-") for fragment in fragments if fragment.strip(" ,;|-")]
        for value in values or [raw]:
            if _looks_like_organisation(value):
                _add_affiliation(rows, value, "footnote", raw)

    generic = {"gmail", "outlook", "hotmail", "yahoo", "qq", "163", "foxmail", "protonmail", "icloud"}
    for domain in domains:
        if generic.isdisjoint(domain.split(".")):
            raw = ", ".join(address for address in addresses if address.lower().endswith(f"@{domain}")) or domain
            _add_affiliation(rows, domain, "email_domain", raw)
    return rows


FOOTNOTE_TEXT = re.compile(
    r"(?i)contributed equally|equal contribution|corresponding author|these authors|footnotetext"
    r"|demo page|project page|work done|\bthanks:|funded by|supported by|grant no|this research|this work"
)


def _author_tokens(authors: Sequence[str]) -> set[str]:
    return {
        token for author in authors for token in re.split(r"[\s.,-]+", author)
        if len(token) >= 2
    }


def _mentions_authors(text: str, authors: Sequence[str]) -> bool:
    folded = text.casefold()
    if any(author.casefold() in folded for author in authors):
        return True
    words = set(re.split(r"[\s.,-]+", folded))
    return len({token.casefold() for token in _author_tokens(authors)} & words) >= 2


def _add_affiliation(rows: list[dict[str, str]], name: str, evidence: str, raw: str) -> None:
    # Structured affiliation lines often carry the author's e-mail; the domain is reported separately.
    name = re.sub(r"(?i)\bE-?mails?:?\s*", " ", EMAIL_ADDRESS.sub(" ", name))
    name = " ".join(name.split()).strip(" ,;|-*†‡§")
    # LaTeXML labels author footnotes as affiliations too; those sentences are not organisations.
    if FOOTNOTE_TEXT.search(name):
        return
    if name and name.casefold() not in {row["name"].casefold() for row in rows}:
        rows.append({"name": name, "evidence": evidence, "raw": raw})


def _looks_like_organisation(value: str) -> bool:
    if re.search(r"(?i)https?://|@", value):
        return False
    return bool(re.search(
        r"(?i)\b(?:University|Institute|Institut|Laboratory|Lab|School|College|Academy|Inc|Ltd|Corp|"
        r"Corporation|Research|Team|AI|Technologies|Technology|Group)\b",
        value,
    ))


def _statements(text: str, patterns: Sequence[tuple[str, re.Pattern[str]]]) -> list[dict[str, str]]:
    sentences = [sentence.strip() for sentence in re.split(r"(?<=[.!?])\s+|[\r\n]+", text) if sentence.strip()]
    rows: list[dict[str, str]] = []
    for name, pattern in patterns:
        for sentence in sentences:
            if pattern.search(sentence) and not any(row["text"] == sentence and row["pattern"] == name for row in rows):
                rows.append({"pattern": name, "text": sentence})
    return rows


def _strings(value: object) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def download_pdf(
    arxiv_ids: str | Sequence[str],
    *,
    purpose: str = "Download and convert exact arXiv papers",
) -> list[Paper]:
    """Download exact arXiv PDFs and convert them to readable Markdown.

    Args:
        arxiv_ids: One exact arXiv ID, URL, or a sequence of IDs and URLs.
        purpose: Short provenance note describing why the papers are downloaded.

    Returns:
        Paper records whose ``download_path`` points to converted Markdown;
        ``pdf_path`` preserves each original PDF. A paper whose download or
        conversion fails is omitted and recorded in ``download_failures()``
        and the Provider log; the call raises only when every paper fails.

    Raises:
        ValueError: If no usable ID is supplied.
        ResearchRuntimeError: If every download or conversion fails; the
            ``source_unavailable`` error itself when arXiv became unavailable,
            after which no further paper is requested.
    """
    identifiers = _normalize_ids(arxiv_ids)
    if not identifiers:
        raise ValueError("arxiv_ids must contain at least one identifier")
    requested = set(identifiers)
    if len(_downloaded_pdf_ids | requested) > MAX_PDF_DOWNLOADS_PER_SESSION:
        raise ValueError(
            f"download_pdf permits at most {MAX_PDF_DOWNLOADS_PER_SESSION} papers per worker session. "
            "Use paper_profile() to confirm which records the assignment needs before downloading."
        )
    _downloaded_pdf_ids.update(requested)
    papers: list[Paper] = []
    failures: dict[str, str] = {}
    unavailable: ResearchRuntimeError | None = None
    for index, identifier in enumerate(identifiers):
        query = f"download_pdf={identifier}"
        try:
            papers.extend(_run([{
                "query": query,
                "purpose": purpose,
                "max_results": 1,
                "provider_request": {"operation": "download_pdf", "parameters": {"arxiv_id": identifier}},
            }]))
        except Exception as error:  # noqa: BLE001 - one paper must not discard the others
            unavailable = unavailable or _unavailable(error)
            failures[identifier] = str(error)[:300]
            log_tool_failure("arxiv", "download_pdf", query, error)
            if unavailable is not None:
                failures.update({remaining: str(unavailable)[:300] for remaining in identifiers[index + 1:]})
                break
    if failures and not papers:
        if unavailable is not None:
            raise unavailable
        raise ResearchRuntimeError(
            "every PDF download failed: " + "; ".join(f"{key}: {value}" for key, value in failures.items()),
            code="arxiv_download_failed",
            failure_class="provider",
        )
    if failures:
        _last_download_failures.clear()
        _last_download_failures.update(failures)
    return papers


def _public_record(row: dict[str, Any]) -> Paper:
    record = dict(row)
    metadata = row.get("metadata")
    if isinstance(metadata, dict):
        record_id = RECORD_ID.match(str(row.get("id") or ""))
        arxiv_id = metadata.get("arxiv_version_id") or metadata.get("arxiv_id")
        if record_id and isinstance(arxiv_id, str) and arxiv_id:
            _record_arxiv_ids[record_id.group(1)] = arxiv_id
        for key in (
            "resource_type",
            "category_id",
            "category_label",
            "description",
            "pdf_path",
            "markdown_path",
            "artifact_path",
            "material_cache_hit",
        ):
            if key in metadata:
                record[key] = metadata[key]
        markdown_path = metadata.get("markdown_path")
        if isinstance(markdown_path, str) and markdown_path:
            record["download_path"] = workspace_path(markdown_path)
    return record  # type: ignore[return-value]


def _paginate(
    search_query: str,
    *,
    id_list: str | Sequence[str] | None = None,
    start: int = 0,
    total_results: int,
    require_complete: bool = False,
    page_size: int = RECOMMENDED_PAGE_SIZE,
    sort_by: SortBy | None = None,
    sort_order: SortOrder | None = None,
    http_method: HttpMethod = "auto",
    purpose: str = "Acquire paginated primary arXiv metadata",
) -> list[Paper]:
    """Paginate native arXiv requests for ``search``.

    Args:
        search_query: Native arXiv query expression.
        id_list: Optional IDs combined with the query.
        start: Initial zero-based result offset.
        total_results: Total number of results requested across all pages.
        require_complete: Fail when the official total exceeds the safety limit.
        page_size: Results requested per page, up to
            ``RECOMMENDED_PAGE_SIZE``.
        sort_by: Optional native arXiv sort field.
        sort_order: Optional ascending or descending result order.
        http_method: Whether Runtime should use GET, POST, or choose
            automatically.
        purpose: Short provenance note describing why pagination is needed.

    Returns:
        A deduplicated list of paper dictionaries across all pages.

    Raises:
        ValueError: If pagination or native query parameters are invalid.
        ResearchRuntimeError: If Runtime or the arXiv provider fails.
    """
    if not isinstance(total_results, int) or not 1 <= total_results <= MAX_TOTAL_RESULTS:
        raise ValueError(f"total_results must be between 1 and {MAX_TOTAL_RESULTS}")
    if not isinstance(page_size, int) or not 1 <= page_size <= RECOMMENDED_PAGE_SIZE:
        raise ValueError(f"page_size must be between 1 and {RECOMMENDED_PAGE_SIZE}")
    papers: list[Paper] = []
    seen: set[str] = set()
    requested_end = start + total_results
    offset = start
    while offset < requested_end:
        size = min(page_size, requested_end - offset)
        page = _run([_native_request(
            search_query=search_query,
            id_list=id_list,
            start=offset,
            max_results=size,
            sort_by=sort_by,
            sort_order=sort_order,
            http_method=http_method,
            purpose=purpose,
        )])
        if not page:
            break
        for paper in page:
            identity = str(paper.get("id") or paper.get("url") or "")
            if identity and identity in seen:
                continue
            if identity:
                seen.add(identity)
            papers.append(paper)

        metadata = page[0].get("metadata")
        feed = metadata.get("arxiv_feed", {}) if isinstance(metadata, dict) else {}
        official_total = feed.get("total_results") if isinstance(feed, dict) else None
        page_start = feed.get("start_index") if isinstance(feed, dict) else None
        items_per_page = feed.get("items_per_page") if isinstance(feed, dict) else None
        consumed = items_per_page if isinstance(items_per_page, int) and items_per_page > 0 else len(page)
        next_offset = (page_start if isinstance(page_start, int) else offset) + consumed
        if next_offset <= offset:
            raise RuntimeError("arXiv pagination did not advance")
        offset = next_offset
        if isinstance(official_total, int):
            if require_complete and official_total > total_results:
                raise RuntimeError(
                    f"arXiv query has {official_total} matches, above the {total_results} complete-coverage "
                    "safety limit. The expression is likely too broad or grouped incorrectly. Use explicit "
                    "ti:/abs:/cat: fields, narrow the subject boundary, or retry non-overlapping date ranges."
                )
            requested_end = min(requested_end, official_total)
            if offset >= requested_end:
                break
        if not isinstance(official_total, int) and len(page) < size:
            break
    return papers


def field(name: SearchField, value: str, *, phrase: bool = False) -> str:
    """Build a native arXiv field expression.

    Args:
        name: Native field prefix such as ``ti``, ``au``, ``abs``, or ``cat``.
        value: Field value.
        phrase: Wrap the value in double quotes when true.

    Returns:
        An unencoded expression such as ``ti:"agent skill"``.

    Raises:
        ValueError: If the field name or value is invalid.
    """
    if name not in SEARCH_FIELDS:
        raise ValueError(f"field name must be one of {SEARCH_FIELDS}")
    text = value.strip()
    if not text:
        raise ValueError("field value cannot be empty")
    if phrase:
        text = '"' + text.replace('"', r'\"') + '"'
    return f"{name}:{text}"


def submitted_date(start: str, end: str) -> str:
    """Build a native arXiv submission-date range.

    Args:
        start: Inclusive GMT timestamp in ``YYYYMMDDHHMM`` form, or an ISO
            ``YYYY-MM-DD`` date (normalized to 00:00 GMT).
        end: Inclusive GMT timestamp in ``YYYYMMDDHHMM`` form, or an ISO
            ``YYYY-MM-DD`` date (normalized to 23:59 GMT).

    Returns:
        A ``submittedDate:[start TO end]`` expression.

    Raises:
        ValueError: If timestamps are malformed or reversed.
    """
    start = _submitted_date_boundary(start, end_of_day=False)
    end = _submitted_date_boundary(end, end_of_day=True)
    if start > end:
        raise ValueError("start date must not be after end date")
    return f"submittedDate:[{start} TO {end}]"


def _submitted_date_boundary(value: str, *, end_of_day: bool) -> str:
    if len(value) == 12 and value.isdigit():
        return value
    if len(value) == 10 and value[4] == "-" and value[7] == "-":
        compact = value.replace("-", "")
        if len(compact) == 8 and compact.isdigit():
            return f"{compact}{'2359' if end_of_day else '0000'}"
    raise ValueError("dates must use YYYYMMDDHHMM or YYYY-MM-DD")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.parse_args()
    print(_HELP)
