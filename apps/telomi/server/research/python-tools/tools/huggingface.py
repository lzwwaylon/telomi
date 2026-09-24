"""Python API for Hugging Face Hub research discovery.

Import this module from a PrimeSearch pipeline. Functions return ordinary
Python dictionaries. Network access, credentials, retries, concurrency,
cancellation, provenance, and ledgers remain owned by Runtime.
"""

from __future__ import annotations

import argparse
import inspect
import re
from collections.abc import Callable, Sequence
from functools import wraps
from hashlib import sha256
from typing import Any, Literal, ParamSpec, TypedDict, TypeVar

from research_runtime import search_source, workspace_path

__all__ = [
    "HuggingFaceDiscovery",
    "HuggingFaceRecord",
    "dataset_info",
    "dataset_leaderboard",
    "datasets",
    "discover_models",
    "download_paper",
    "list_daily_papers",
    "model_card",
    "model_info",
    "model_tags",
    "models",
    "models_created_between",
    "paginate_daily_papers",
    "paginate_datasets",
    "paginate_models",
    "paginate_spaces",
    "paper_info",
    "paper_profile",
    "papers_search",
    "spaces",
]

HubSort = Literal["created_at", "downloads", "last_modified", "likes", "trending_score"]
# Hugging Face Spaces do not support downloads sorting. Keep this separate from model/dataset sorts.
SpaceSort = Literal["created_at", "last_modified", "likes", "trending_score"]
PaperSort = Literal["published_at", "trending"]
REPO_ID = re.compile(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)?")
MAX_RESULTS_PER_REQUEST = 100
MAX_PAPER_DOWNLOADS_PER_SESSION = 10
MAX_TOTAL_RESULTS = 10_000
MAX_LIST_ITEMS = 50
DISCOVERY_RESULT_LIMIT = 100
DISCOVERY_PAGE_SIZE = 20
DISCOVERY_LANES = ("trending", "created_range", "likes", "downloads")
DISCOVERY_RECORD_FIELDS = (
    "repo_id",
    "created_at",
    "updated_at",
    "pipeline_tag",
    "library_name",
    "downloads",
    "downloads_all_time",
    "likes",
    "tags",
    "discovery_lanes",
)
P = ParamSpec("P")
R = TypeVar("R")


class HuggingFaceRecord(TypedDict, total=False):
    id: str
    title: str
    url: str
    content_path: str
    snippet: str
    published_at: str
    submitted_at: str
    authors: list[str]
    resource_type: str
    repo_id: str
    dataset_id: str
    model_id: str
    tag_type: str
    tag_id: str
    tag_label: str
    paper_id: str
    downloads: int
    downloads_all_time: int
    likes: int
    upvotes: int
    rank: int
    score: float
    verified: bool
    filename: str
    lower_is_better: bool
    leaderboard_url: str
    source: dict[str, Any]
    tags: list[str]
    pipeline_tag: str
    library_name: str
    created_at: str
    updated_at: str
    document_url: str
    artifact_path: str
    download_path: str
    markdown_path: str
    metadata_path: str
    front_excerpt: str
    headings: list[str]
    document_byte_length: int
    byte_length: int
    revision: str
    sha: str
    card_data: dict[str, Any]
    model_index: dict[str, Any]
    material_cache_hit: bool
    pdf_url: str
    metadata: dict[str, Any]
    identifiers: dict[str, Any]
    query_sequences: list[int]
    discovery_lanes: list[dict[str, Any]]


class HuggingFaceDiscovery(TypedDict):
    records: list[HuggingFaceRecord]
    lane_counts: dict[str, int]
    unique_count: int
    returned_count: int
    next_cursor: str | None


DISCOVERY_CACHE_LIMIT = 5
_DISCOVERY_POOLS: dict[
    tuple[tuple[str, ...], str | None, str | None, tuple[str, ...]],
    tuple[list[HuggingFaceRecord], dict[str, int]],
] = {}


def _guide_daily_paper_arguments(function: Callable[P, R]) -> Callable[P, R]:
    signature = inspect.signature(function)

    @wraps(function)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> R:
        try:
            signature.bind(*args, **kwargs)
        except TypeError as error:
            if "query" in kwargs:
                raise TypeError(
                    f"{function.__name__}() does not accept parameter 'query'. "
                    "Use papers_search(query=..., max_results=...) for keyword search; "
                    f"use {function.__name__}(...) only for the Daily Papers feed."
                ) from None
            raise TypeError(
                f"Invalid arguments for {function.__name__}(): {error}. "
                f"Accepted parameters: {', '.join(signature.parameters)}."
            ) from None
        return function(*args, **kwargs)

    return wrapped


_HELP = """Hugging Face Python API

Import and call it from your own pipeline:

  from tools import huggingface

  papers = huggingface.papers_search("agent evaluation", max_results=20)
  profiles = huggingface.paper_profile(["2607.01234"], depth="front")
  bundles = huggingface.download_paper(["2607.01234"])
  recent = huggingface.list_daily_papers(week="2026-W28", sort="trending")
  exact_model = huggingface.model_info("openai/whisper-large-v3")
  card = huggingface.model_card("openai/whisper-large-v3")
  benchmark = huggingface.dataset_leaderboard(
      "SWE-bench/SWE-bench_Verified",
      max_results=10,
  )
  model_rows = huggingface.models(
      search="retrieval",
      sort="trending_score",
      max_results=50,
  )
  task_tags = huggingface.model_tags(tag_type="pipeline_tag")
  dataset_rows = huggingface.datasets(
      filters=["language:zh"],
      sort="downloads",
      max_results=50,
  )

All functions return list[HuggingFaceRecord]. Use paper_info, model_info, or
dataset_info when an exact identifier is known. Use paginate_models,
paginate_datasets, paginate_spaces, or paginate_daily_papers for bounded
multi-page acquisitions. Hub cursors are opaque and are passed back to Runtime
unchanged.

The Worker never receives a Hugging Face token or direct network access.
Runtime calls the native Hugging Face HTTP APIs and records every operation.
"""


def papers_search(
    query: str | Sequence[str],
    *,
    max_results: int = 20,
    purpose: str = "Discover Hugging Face papers",
) -> list[HuggingFaceRecord]:
    """Search Hugging Face paper metadata by keyword.

    Args:
        query: One search phrase or a sequence of phrases.
        max_results: Maximum results for each phrase, up to 100.
        purpose: Short provenance note describing why the search is made.

    Returns:
        Deduplicated paper candidate dictionaries.

    Raises:
        ValueError: If a query or result limit is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    queries = _text_list(query, "query", max_items=MAX_LIST_ITEMS)
    size = _page_size(max_results)
    return _run([
        _request(
            operation="papers_search",
            query=value,
            purpose=purpose,
            max_results=size,
            parameters={"query": value, "limit": size},
        )
        for value in queries
    ])


@_guide_daily_paper_arguments
def list_daily_papers(
    *,
    date: str | None = None,
    week: str | None = None,
    month: str | None = None,
    submitter: str | None = None,
    sort: PaperSort | None = None,
    page: int = 0,
    max_results: int = 20,
    purpose: str = "Acquire Hugging Face daily papers",
) -> list[HuggingFaceRecord]:
    """List one page from the Hugging Face Daily Papers feed.

    ``date``, ``week``, and ``month`` select when papers appeared in Daily
    Papers. They do not filter the papers' original ``published_at`` values.

    Args:
        date: Optional Daily Papers appearance date in YYYY-MM-DD form.
        week: Optional Daily Papers appearance week in YYYY-Www form.
        month: Optional Daily Papers appearance month in YYYY-MM form.
        submitter: Optional Hugging Face submitter username.
        sort: ``published_at`` or ``trending``.
        page: Zero-based daily-paper page number.
        max_results: Maximum papers on this page, up to 100.
        purpose: Short provenance note describing why the list is acquired.

    Returns:
        Paper candidate dictionaries for one page.

    Raises:
        ValueError: If period, sort, page, or result limit is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    periods = [value for value in (date, week, month) if value is not None]
    if len(periods) > 1:
        raise ValueError("date, week, and month are mutually exclusive")
    if date is not None and not _matches_date(date, 10, (4, 7), "-"):
        raise ValueError("date must use YYYY-MM-DD")
    if week is not None and not (
        len(week) == 8 and week[:4].isdigit() and week[4:6] == "-W" and week[6:].isdigit()
    ):
        raise ValueError("week must use YYYY-Www")
    if month is not None and not _matches_date(month, 7, (4,), "-"):
        raise ValueError("month must use YYYY-MM")
    if sort is not None and sort not in ("published_at", "trending"):
        raise ValueError(
            f"Invalid value for parameter 'sort': {sort!r}. "
            "Use 'published_at' for publication order or 'trending' for popularity."
        )
    if not isinstance(page, int) or page < 0:
        raise ValueError("page must be a non-negative integer")
    size = _page_size(max_results)
    parameters: dict[str, Any] = {"page": page, "limit": size}
    for key, value in (
        ("date", date),
        ("week", week),
        ("month", month),
        ("submitter", submitter),
        ("sort", sort),
    ):
        if value is not None:
            parameters[key] = _text(value, key)
    period = date or week or month or "latest"
    return _run([_request(
        # This is the stable Runtime wire operation. Worker-facing SDK names use
        # "daily" so Agents do not confuse this feed with keyword paper search.
        operation="papers_list",
        query=f"daily_papers:{period}:page={page}",
        purpose=purpose,
        max_results=size,
        parameters=parameters,
    )])


@_guide_daily_paper_arguments
def paginate_daily_papers(
    *,
    total_results: int,
    page_size: int = 100,
    start_page: int = 0,
    date: str | None = None,
    week: str | None = None,
    month: str | None = None,
    submitter: str | None = None,
    sort: PaperSort | None = None,
    purpose: str = "Acquire paginated Hugging Face daily papers",
) -> list[HuggingFaceRecord]:
    """Acquire a bounded multi-page range from the Daily Papers feed.

    Period filters select when papers appeared in Daily Papers, not their
    original publication dates.

    Args:
        total_results: Maximum records to retain across pages.
        page_size: Results requested per page, up to 100.
        start_page: Initial zero-based page.
        date: Optional Daily Papers appearance date in YYYY-MM-DD form.
        week: Optional Daily Papers appearance week in YYYY-Www form.
        month: Optional Daily Papers appearance month in YYYY-MM form.
        submitter: Optional submitter username.
        sort: ``published_at`` or ``trending``.
        purpose: Short provenance note.

    Returns:
        Deduplicated paper candidates across requested pages.

    Raises:
        ValueError: If a pagination argument is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    total = _total_results(total_results)
    size = _page_size(page_size)
    if not isinstance(start_page, int) or start_page < 0:
        raise ValueError("start_page must be a non-negative integer")
    records: list[HuggingFaceRecord] = []
    seen: set[str] = set()
    page = start_page
    while len(records) < total:
        previous_count = len(records)
        rows = list_daily_papers(
            date=date,
            week=week,
            month=month,
            submitter=submitter,
            sort=sort,
            page=page,
            max_results=min(size, total - len(records)),
            purpose=purpose,
        )
        _extend_unique(records, seen, rows, total)
        if len(records) == previous_count:
            break
        if len(rows) < min(size, total - len(records) + len(rows)):
            break
        page += 1
    return records


def paper_info(
    paper_ids: str | Sequence[str],
    *,
    purpose: str = "Acquire known Hugging Face paper metadata",
) -> list[HuggingFaceRecord]:
    """Fetch Hugging Face paper metadata for known arXiv identifiers.

    Args:
        paper_ids: One arXiv ID or a sequence of IDs.
        purpose: Short provenance note describing why the lookup is made.

    Returns:
        Paper candidate dictionaries.

    Raises:
        ValueError: If no valid ID is supplied.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    identifiers = _text_list(paper_ids, "paper_ids", max_items=MAX_LIST_ITEMS)
    return _run([
        _request(
            operation="papers_info",
            query=f"paper_id={paper_id}",
            purpose=purpose,
            max_results=1,
            parameters={"paper_id": paper_id},
        )
        for paper_id in identifiers
    ])


def paper_profile(
    paper_ids: str | Sequence[str],
    *,
    depth: Literal["metadata", "front"] = "metadata",
    purpose: str = "Profile Hugging Face papers before acquisition",
) -> list[HuggingFaceRecord]:
    """Inspect exact papers using metadata or a bounded full-text preview.

    ``metadata`` returns the native paper metadata, including abstract, AI
    summary, keywords, project page, GitHub repository, and document links when
    Hugging Face supplies them. ``front`` additionally reads the Hugging Face
    paper Markdown and returns a bounded excerpt plus its headings without
    writing material into the Worker workspace.
    """
    if depth not in ("metadata", "front"):
        raise ValueError("depth must be 'metadata' or 'front'")
    identifiers = _text_list(paper_ids, "paper_ids", max_items=MAX_LIST_ITEMS)
    if depth == "metadata":
        return paper_info(identifiers, purpose=purpose)
    return _run([
        _request(
            operation="papers_preview",
            query=f"paper_preview={paper_id}",
            purpose=purpose,
            max_results=1,
            parameters={"paper_id": paper_id},
        )
        for paper_id in identifiers
    ])


def download_paper(
    paper_ids: str | Sequence[str],
    *,
    purpose: str = "Download selected Hugging Face papers",
) -> list[HuggingFaceRecord]:
    """Download selected Hugging Face full-text Markdown and metadata bundles.

    Each returned record points at a Runtime-owned directory containing
    ``paper.md`` and ``metadata.json``. The metadata preserves the native
    Hugging Face response, including project and GitHub links when available.
    Pass the returned record unchanged to ``CandidateLedger.add(materials=...)``.
    """
    identifiers = _text_list(paper_ids, "paper_ids", max_items=MAX_PAPER_DOWNLOADS_PER_SESSION)
    return _run([
        _request(
            operation="papers_download",
            query=f"paper_download={paper_id}",
            purpose=purpose,
            max_results=1,
            parameters={"paper_id": paper_id},
        )
        for paper_id in identifiers
    ])


def model_info(
    model_ids: str | Sequence[str],
    *,
    revision: str | None = None,
    purpose: str = "Acquire known Hugging Face model metadata",
) -> list[HuggingFaceRecord]:
    """Fetch exact metadata for known Hugging Face model repository IDs.

    Args:
        model_ids: One model repository ID or a sequence of IDs.
        revision: Optional branch, tag, or commit shared by all requested IDs.
        purpose: Short provenance note describing why the lookup is made.

    Returns:
        Exact model repository candidate dictionaries.

    Raises:
        ValueError: If an ID or revision is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    return _hub_info("models_info", model_ids, revision, purpose)


def model_card(
    model_id: str,
    *,
    revision: str | None = None,
    purpose: str = "Download a Hugging Face model card README",
) -> list[HuggingFaceRecord]:
    """Download README.md for an exact Hugging Face model repository.

    The returned record contains ``download_path`` for reading the pinned model
    card from the Worker sandbox. Runtime resolves the repository's current
    commit SHA before downloading when no revision is supplied.

    Args:
        model_id: Exact model repository ID.
        revision: Optional branch, tag, or commit.
        purpose: Short provenance note describing why the card is downloaded.

    Returns:
        One model-card record with its local download path and pinned SHA.
    """
    repo_id = _repo_id(model_id, "model_id")
    parameters = {"repo_id": repo_id}
    if revision is not None:
        parameters["revision"] = _text(revision, "revision", max_length=256)
    return _run([_request(
        operation="models_card",
        query=f"model_card={repo_id}",
        purpose=purpose,
        max_results=1,
        parameters=parameters,
    )])


def model_tags(
    *,
    tag_type: Literal["pipeline_tag", "library", "language", "license", "other"] = "pipeline_tag",
    search: str | None = None,
    max_results: int = 100,
    purpose: str = "Discover Hugging Face model filter tags",
) -> list[HuggingFaceRecord]:
    """List current Hugging Face model filter values.

    Args:
        tag_type: Filter family to list. Use ``pipeline_tag`` for model tasks.
        search: Optional substring matched against tag IDs and labels.
        max_results: Maximum matching tags to return, up to 100.
        purpose: Short provenance note.

    Returns:
        Model-filter tag records from Hugging Face's current catalog.

    Raises:
        ValueError: If a tag type, search value, or result limit is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    if tag_type not in ("pipeline_tag", "library", "language", "license", "other"):
        raise ValueError("tag_type must be pipeline_tag, library, language, license, or other")
    size = _page_size(max_results)
    parameters: dict[str, Any] = {"tag_type": tag_type, "limit": size}
    _put_optional_text(parameters, "search", search)
    return _run([_request(
        operation="model_tags",
        query=f"model_tags:{tag_type}:{search or 'all'}",
        purpose=purpose,
        max_results=size,
        parameters=parameters,
    )])


def dataset_info(
    dataset_ids: str | Sequence[str],
    *,
    revision: str | None = None,
    purpose: str = "Acquire known Hugging Face dataset metadata",
) -> list[HuggingFaceRecord]:
    """Fetch exact metadata for known Hugging Face dataset repository IDs.

    Args:
        dataset_ids: One dataset repository ID or a sequence of IDs.
        revision: Optional branch, tag, or commit shared by all requested IDs.
        purpose: Short provenance note describing why the lookup is made.

    Returns:
        Exact dataset repository candidate dictionaries.

    Raises:
        ValueError: If an ID or revision is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    return _hub_info("datasets_info", dataset_ids, revision, purpose)


def dataset_leaderboard(
    dataset_id: str,
    *,
    max_results: int = 20,
    purpose: str = "Acquire a Hugging Face dataset leaderboard",
) -> list[HuggingFaceRecord]:
    """List ranked model scores for a known benchmark dataset.

    Only datasets with submitted evaluation results expose a leaderboard.

    Args:
        dataset_id: Benchmark dataset repository ID.
        max_results: Maximum ranked entries to return, up to 100.
        purpose: Short provenance note describing why the leaderboard is acquired.

    Returns:
        Ranked model candidate dictionaries with score metadata.

    Raises:
        ValueError: If the dataset ID or result limit is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    repo_id = _repo_id(dataset_id, "dataset_id")
    size = _page_size(max_results)
    return _run([_request(
        operation="datasets_leaderboard",
        query=f"dataset_id={repo_id}:leaderboard",
        purpose=purpose,
        max_results=size,
        parameters={"dataset_id": repo_id, "limit": size},
    )])


def models(
    *,
    search: str | None = None,
    author: str | None = None,
    filters: Sequence[str] = (),
    apps: Sequence[str] = (),
    gated: bool | None = None,
    inference: Literal["warm"] | None = None,
    inference_provider: str | Sequence[str] | None = None,
    pipeline_tag: str | None = None,
    trained_datasets: Sequence[str] = (),
    num_parameters: str | None = None,
    base_model_relation: Literal["base", "adapter", "finetune", "quantized", "merge"] | None = None,
    sort: HubSort | None = None,
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Discover Hugging Face models",
) -> list[HuggingFaceRecord]:
    """List model repositories with native Hugging Face filters.

    Args:
        search: Text contained in returned model IDs.
        author: User or organization namespace.
        filters: Hub tags such as task, language, or library.
        apps: Supported applications such as ``vllm``.
        gated: Filter gated or non-gated models.
        inference: Use ``warm`` for models served by a provider.
        inference_provider: One provider, ``all``, or provider names.
        pipeline_tag: Model task such as ``text-generation``.
        trained_datasets: Dataset tags, with or without ``dataset:``.
        num_parameters: Hub range syntax such as ``min:6B,max:128B``.
        base_model_relation: Model-tree relation such as ``base`` for Base only.
        sort: Native public sort field.
        max_results: Maximum records on this page, up to 100.
        cursor: Opaque cursor returned by a prior page.
        purpose: Short provenance note.

    Returns:
        Model repository candidate dictionaries.

    Raises:
        ValueError: If a native filter is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    if inference is not None and inference != "warm":
        raise ValueError("inference must be warm")
    if inference is not None and inference_provider is not None:
        raise ValueError("inference and inference_provider cannot be combined")
    if base_model_relation is not None and base_model_relation not in (
        "base",
        "adapter",
        "finetune",
        "quantized",
        "merge",
    ):
        raise ValueError("base_model_relation must be base, adapter, finetune, quantized, or merge")
    parameters = _hub_parameters(
        search=search,
        author=author,
        filters=filters,
        sort=sort,
        max_results=max_results,
        cursor=cursor,
    )
    _put_list(parameters, "apps", apps, 20)
    _put_optional(parameters, "gated", gated)
    _put_optional(parameters, "inference", inference)
    if inference_provider is not None:
        parameters["inference_provider"] = (
            _text(inference_provider, "inference_provider")
            if isinstance(inference_provider, str)
            else _sequence(inference_provider, "inference_provider", 20)
        )
    _put_optional_text(parameters, "pipeline_tag", pipeline_tag)
    _put_list(parameters, "trained_datasets", trained_datasets, 20)
    _put_optional_text(parameters, "num_parameters", num_parameters)
    _put_optional(parameters, "base_model_relation", base_model_relation)
    return _hub_list("models_list", parameters, purpose)


def datasets(
    *,
    search: str | None = None,
    author: str | None = None,
    filters: Sequence[str] = (),
    gated: bool | None = None,
    sort: HubSort | None = None,
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Discover Hugging Face datasets",
) -> list[HuggingFaceRecord]:
    """List dataset repositories with native Hugging Face filters.

    Args:
        search: Text contained in returned dataset IDs.
        author: User or organization namespace.
        filters: Hub dataset tags such as ``language:zh``.
        gated: Filter gated or non-gated datasets.
        sort: Native public sort field.
        max_results: Maximum records on this page, up to 100.
        cursor: Opaque cursor returned by a prior page.
        purpose: Short provenance note.

    Returns:
        Dataset repository candidate dictionaries.

    Raises:
        ValueError: If a native filter is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    parameters = _hub_parameters(
        search=search,
        author=author,
        filters=filters,
        sort=sort,
        max_results=max_results,
        cursor=cursor,
    )
    _put_optional(parameters, "gated", gated)
    return _hub_list("datasets_list", parameters, purpose)


def spaces(
    *,
    search: str | None = None,
    author: str | None = None,
    filters: Sequence[str] = (),
    datasets: Sequence[str] = (),
    models: Sequence[str] = (),
    linked: bool = False,
    sort: SpaceSort | None = None,
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Discover Hugging Face Spaces",
) -> list[HuggingFaceRecord]:
    """List Space repositories with native Hugging Face filters.

    Args:
        search: Text contained in returned Space IDs.
        author: User or organization namespace.
        filters: Hub tags.
        datasets: Dataset repositories linked by the Space.
        models: Model repositories linked by the Space.
        linked: Require a linked model or dataset.
        sort: Native public sort field.
        max_results: Maximum records on this page, up to 100.
        cursor: Opaque cursor returned by a prior page.
        purpose: Short provenance note.

    Returns:
        Space repository candidate dictionaries.

    Raises:
        ValueError: If a native filter is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    if sort is not None and sort not in ("created_at", "last_modified", "likes", "trending_score"):
        raise ValueError(
            f"Invalid spaces sort {sort!r}; use created_at, last_modified, likes, or trending_score"
        )
    parameters = _hub_parameters(
        search=search,
        author=author,
        filters=filters,
        sort=sort,
        max_results=max_results,
        cursor=cursor,
    )
    _put_list(parameters, "datasets", datasets, 20)
    _put_list(parameters, "models", models, 20)
    if linked:
        parameters["linked"] = True
    return _hub_list("spaces_list", parameters, purpose)


def paginate_models(*, total_results: int, page_size: int = 100, **kwargs: Any) -> list[HuggingFaceRecord]:
    """Paginate :func:`models` with opaque cursors.

    Args:
        total_results: Maximum records to retain.
        page_size: Results requested per page, up to 100.
        **kwargs: Any non-pagination arguments accepted by :func:`models`.

    Returns:
        Deduplicated model candidates.

    Raises:
        ValueError: If pagination is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    return _paginate(models, total_results=total_results, page_size=page_size, kwargs=kwargs)


def models_created_between(
    start_date: str,
    end_date: str,
    *,
    page_size: int = 100,
    max_results: int = MAX_TOTAL_RESULTS,
    purpose: str = "Discover Hugging Face models across a creation-date range",
    **kwargs: Any,
) -> list[HuggingFaceRecord]:
    """Page newest-first model results until the inclusive date range is covered.

    Args:
        start_date: Inclusive lower bound in YYYY-MM-DD form.
        end_date: Inclusive upper bound in YYYY-MM-DD form.
        page_size: Results requested per page, up to 100.
        max_results: Safety bound on scanned records, up to 10,000.
        purpose: Short provenance note.
        **kwargs: Model filters accepted by :func:`models`, except pagination
            and sort arguments.

    Returns:
        Deduplicated model records whose ``created_at`` dates fall in range.

    Raises:
        ValueError: If dates or pagination arguments are invalid.
        RuntimeError: If the safety bound is reached before the lower date.
    """
    if not _matches_date(start_date, 10, (4, 7), "-"):
        raise ValueError("start_date must use YYYY-MM-DD")
    if not _matches_date(end_date, 10, (4, 7), "-"):
        raise ValueError("end_date must use YYYY-MM-DD")
    if start_date > end_date:
        raise ValueError("start_date must be on or before end_date")
    forbidden = {"cursor", "max_results", "sort"}.intersection(kwargs)
    if forbidden:
        raise ValueError(f"models_created_between owns arguments: {', '.join(sorted(forbidden))}")

    size = _page_size(page_size)
    limit = _total_results(max_results)
    cursor: str | None = None
    scanned = 0
    selected: list[HuggingFaceRecord] = []
    seen: set[str] = set()
    while scanned < limit:
        rows = models(
            **kwargs,
            sort="created_at",
            max_results=min(size, limit - scanned),
            cursor=cursor,
            purpose=purpose,
        )
        scanned += len(rows)
        dated = [row.get("created_at", "")[:10] for row in rows if row.get("created_at")]
        for row in rows:
            created = row.get("created_at", "")[:10]
            if not start_date <= created <= end_date:
                continue
            identity = row.get("id") or row.get("repo_id") or row.get("url")
            if not isinstance(identity, str) or not identity or identity in seen:
                continue
            seen.add(identity)
            selected.append(row)
        next_cursor = _next_cursor(rows)
        if not next_cursor or (dated and min(dated) < start_date):
            return selected
        cursor = next_cursor
    raise RuntimeError(
        f"Model pagination reached the {limit}-record safety limit before {start_date}; "
        f"the Provider query is too broad ({kwargs or 'no filters'}). Narrow it with a task or other "
        "Provider-native tag resolved by model_tags(); do not increase max_results beyond the hard limit."
    )


def discover_models(
    pipeline_tags: str | Sequence[str],
    *,
    start_date: str | None = None,
    end_date: str | None = None,
    filters: Sequence[str] = (),
    cursor: str | None = None,
    purpose: str = "Discover Hugging Face models through fixed native lanes",
) -> HuggingFaceDiscovery:
    """Build one high-recall model set from fixed Hub-native discovery lanes.

    For each task, this runs trending first, optional complete creation-date
    coverage, likes, and downloads. It builds a bounded pool of at most 100
    records, then returns one page. Follow ``next_cursor`` to read later pages.

    Args:
        pipeline_tags: One or more current pipeline tag IDs.
        start_date: Optional inclusive creation-date lower bound.
        end_date: Optional inclusive creation-date upper bound.
        filters: Additional Hub tags applied to every lane.
        cursor: Exact ``next_cursor`` from the preceding discovery page.
        purpose: Short provenance note.

    Returns:
        One compact record page, pool and page counts, per-task lane counts,
        and the next cursor when more records remain. Records contain only
        ``repo_id``, dates, task, library, popularity, tags, and discovery-lane
        provenance when those fields are available; use ``model_info()`` or
        ``model_card()`` for full details.

    Raises:
        ValueError: If tags or date bounds are invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
        RuntimeError: If complete creation-date coverage hits its safety bound.
    """
    tasks = _text_list(pipeline_tags, "pipeline_tags", max_items=MAX_LIST_ITEMS)
    filter_ids: list[str] = []
    for value in _text_list(filters, "filters", max_items=MAX_LIST_ITEMS) if filters else []:
        prefix, separator, suffix = value.partition(":")
        filter_ids.append(suffix if separator and prefix in {"language", "library", "license", "other"} else value)
    if (start_date is None) != (end_date is None):
        raise ValueError("start_date and end_date must be provided together")
    cache_key = (tuple(tasks), start_date, end_date, tuple(filter_ids))
    key_hash = sha256(repr(cache_key).encode()).hexdigest()[:16]
    offset = _discovery_offset(cursor, key_hash)
    cached = _DISCOVERY_POOLS.get(cache_key)
    if cached is not None:
        return _discovery_page(*cached, offset, key_hash)
    if cursor is not None:
        raise ValueError("cursor discovery pool is no longer cached; restart without a cursor")
    catalog = {
        row["tag_id"]
        for row in model_tags(tag_type="pipeline_tag", max_results=100, purpose=purpose)
        if row.get("tag_id")
    }
    unknown = [task for task in tasks if task not in catalog]
    if unknown:
        raise ValueError(
            f"Unknown pipeline_tags: {', '.join(unknown)}. "
            f"Available tags include: {', '.join(sorted(catalog))}"
        )

    records_by_id: dict[str, HuggingFaceRecord] = {}
    lane_counts: dict[str, int] = {}
    lane_ids = {
        lane: {task: [] for task in tasks}
        for lane in DISCOVERY_LANES
    }
    for task in tasks:
        lanes: list[tuple[str, list[HuggingFaceRecord]]] = [
            ("trending", models(
                pipeline_tag=task,
                filters=filter_ids,
                sort="trending_score",
                max_results=100,
                purpose=purpose,
            )),
        ]
        if start_date is not None and end_date is not None:
            lanes.append(("created_range", models_created_between(
                start_date,
                end_date,
                pipeline_tag=task,
                filters=filter_ids,
                page_size=100,
                max_results=MAX_TOTAL_RESULTS,
                purpose=purpose,
            )))
        lanes.extend([
            ("likes", models(
                pipeline_tag=task,
                filters=filter_ids,
                sort="likes",
                max_results=100,
                purpose=purpose,
            )),
            ("downloads", models(
                pipeline_tag=task,
                filters=filter_ids,
                sort="downloads",
                max_results=100,
                purpose=purpose,
            )),
        ])
        for lane, rows in lanes:
            lane_counts[f"{task}:{lane}"] = len(rows)
            for rank, row in enumerate(rows, start=1):
                repo_id = row.get("repo_id")
                if not isinstance(repo_id, str) or not repo_id:
                    continue
                record = records_by_id.setdefault(repo_id, {**row, "discovery_lanes": []})
                record["discovery_lanes"].append({
                    "pipeline_tag": task,
                    "lane": lane,
                    "rank": rank,
                })
                lane_ids[lane][task].append(repo_id)

    ordered_lane_ids: dict[str, list[str]] = {}
    for lane in DISCOVERY_LANES:
        rows_by_task = lane_ids[lane]
        ordered_lane_ids[lane] = [
            rows[rank]
            for rank in range(max((len(rows) for rows in rows_by_task.values()), default=0))
            for rows in rows_by_task.values()
            if rank < len(rows)
        ]

    selected: list[str] = []
    selected_set: set[str] = set()
    timeline_ids = set(ordered_lane_ids["created_range"])
    for lane in DISCOVERY_LANES:
        for repo_id in ordered_lane_ids[lane]:
            if len(selected) == DISCOVERY_RESULT_LIMIT:
                break
            if repo_id in selected_set:
                continue
            if (
                start_date is not None
                and end_date is not None
                and lane != "created_range"
                and repo_id not in timeline_ids
                and not _record_has_release_evidence_between(records_by_id[repo_id], start_date, end_date)
            ):
                continue
            selected.append(repo_id)
            selected_set.add(repo_id)
    selected_records = [
        {key: record[key] for key in DISCOVERY_RECORD_FIELDS if key in record}
        for record in (records_by_id[repo_id] for repo_id in selected)
    ]
    if len(_DISCOVERY_POOLS) >= DISCOVERY_CACHE_LIMIT:
        _DISCOVERY_POOLS.pop(next(iter(_DISCOVERY_POOLS)))
    _DISCOVERY_POOLS[cache_key] = (selected_records, lane_counts)
    return _discovery_page(selected_records, lane_counts, offset, key_hash)


def _discovery_page(
    selected: list[HuggingFaceRecord],
    lane_counts: dict[str, int],
    offset: int,
    key_hash: str,
) -> HuggingFaceDiscovery:
    if offset and offset >= len(selected):
        raise ValueError("cursor is beyond the current discovery pool; restart without a cursor")
    end = min(offset + DISCOVERY_PAGE_SIZE, len(selected))
    records = [record.copy() for record in selected[offset:end]]
    return {
        "records": records,
        "lane_counts": lane_counts,
        "unique_count": len(selected),
        "returned_count": len(records),
        "next_cursor": f"hf-discovery:{key_hash}:{end}" if end < len(selected) else None,
    }


def _record_has_release_evidence_between(
    record: HuggingFaceRecord,
    start_date: str,
    end_date: str,
) -> bool:
    if any(
        isinstance(value, str) and start_date <= value[:10] <= end_date
        for value in (record.get("created_at"), record.get("published_at"), record.get("submitted_at"))
    ):
        return True
    start_month, end_month = start_date[:7], end_date[:7]
    for tag in record.get("tags", []):
        match = re.fullmatch(r"arxiv:(\d{2})(\d{2})\.\d{4,5}", tag, re.IGNORECASE)
        if match and start_month <= f"20{match.group(1)}-{match.group(2)}" <= end_month:
            return True
    return False


def _discovery_offset(cursor: str | None, key_hash: str) -> int:
    if cursor is None:
        return 0
    value = _text(cursor, "cursor", max_length=64)
    parts = value.split(":")
    if len(parts) != 3 or parts[0] != "hf-discovery" or not parts[2].isdigit() or int(parts[2]) <= 0:
        raise ValueError("cursor must be the exact next_cursor returned by discover_models()")
    if parts[1] != key_hash:
        raise ValueError("cursor was created for different discovery parameters")
    return int(parts[2])


def paginate_datasets(*, total_results: int, page_size: int = 100, **kwargs: Any) -> list[HuggingFaceRecord]:
    """Paginate :func:`datasets` with opaque cursors.

    Args:
        total_results: Maximum records to retain.
        page_size: Results requested per page, up to 100.
        **kwargs: Any non-pagination arguments accepted by :func:`datasets`.

    Returns:
        Deduplicated dataset candidates.

    Raises:
        ValueError: If pagination is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    return _paginate(datasets, total_results=total_results, page_size=page_size, kwargs=kwargs)


def paginate_spaces(*, total_results: int, page_size: int = 100, **kwargs: Any) -> list[HuggingFaceRecord]:
    """Paginate :func:`spaces` with opaque cursors.

    Args:
        total_results: Maximum records to retain.
        page_size: Results requested per page, up to 100.
        **kwargs: Any non-pagination arguments accepted by :func:`spaces`.

    Returns:
        Deduplicated Space candidates.

    Raises:
        ValueError: If pagination is invalid.
        ResearchRuntimeError: If Runtime or Hugging Face fails.
    """
    return _paginate(spaces, total_results=total_results, page_size=page_size, kwargs=kwargs)


def _hub_parameters(
    *,
    search: str | None,
    author: str | None,
    filters: Sequence[str],
    sort: HubSort | None,
    max_results: int,
    cursor: str | None,
) -> dict[str, Any]:
    if sort is not None and sort not in (
        "created_at",
        "downloads",
        "last_modified",
        "likes",
        "trending_score",
    ):
        raise ValueError("sort must be created_at, downloads, last_modified, likes, or trending_score")
    parameters: dict[str, Any] = {"limit": _page_size(max_results)}
    _put_optional_text(parameters, "search", search)
    _put_optional_text(parameters, "author", author)
    _put_list(parameters, "filters", filters, MAX_LIST_ITEMS)
    _put_optional(parameters, "sort", sort)
    _put_optional_text(parameters, "cursor", cursor, max_length=4_096)
    return parameters


def _hub_list(
    operation: Literal["models_list", "datasets_list", "spaces_list"],
    parameters: dict[str, Any],
    purpose: str,
) -> list[HuggingFaceRecord]:
    size = int(parameters["limit"])
    summary = parameters.get("search") or parameters.get("author") or "all"
    return _run([_request(
        operation=operation,
        query=f"{operation}:{summary}",
        purpose=purpose,
        max_results=size,
        parameters=parameters,
    )])


def _hub_info(
    operation: Literal["models_info", "datasets_info"],
    repo_ids: str | Sequence[str],
    revision: str | None,
    purpose: str,
) -> list[HuggingFaceRecord]:
    identifiers = [_repo_id(value, "repo_ids") for value in _text_list(
        repo_ids,
        "repo_ids",
        max_items=MAX_LIST_ITEMS,
    )]
    parsed_revision = _text(revision, "revision", max_length=256) if revision is not None else None
    requests = []
    for repo_id in identifiers:
        parameters = {"repo_id": repo_id}
        if parsed_revision is not None:
            parameters["revision"] = parsed_revision
        requests.append(_request(
            operation=operation,
            query=f"repo_id={repo_id}",
            purpose=purpose,
            max_results=1,
            parameters=parameters,
        ))
    return _run(requests)


def _paginate(
    function: Callable[..., list[HuggingFaceRecord]],
    *,
    total_results: int,
    page_size: int,
    kwargs: dict[str, Any],
) -> list[HuggingFaceRecord]:
    total = _total_results(total_results)
    size = _page_size(page_size)
    cursor = kwargs.pop("cursor", None)
    if cursor is not None:
        cursor = _text(cursor, "cursor", max_length=4_096)
    records: list[HuggingFaceRecord] = []
    seen_ids: set[str] = set()
    seen_cursors: set[str] = set()
    while len(records) < total:
        rows = function(
            **kwargs,
            max_results=min(size, total - len(records)),
            cursor=cursor,
        )
        _extend_unique(records, seen_ids, rows, total)
        next_cursor = _next_cursor(rows)
        if not next_cursor or next_cursor in seen_cursors:
            break
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    return records


def _next_cursor(rows: Sequence[HuggingFaceRecord]) -> str | None:
    for row in rows:
        metadata = row.get("metadata")
        if not isinstance(metadata, dict):
            continue
        page = metadata.get("huggingface_page")
        if not isinstance(page, dict):
            continue
        value = page.get("next_cursor")
        if isinstance(value, str) and value:
            return value
    return None


def _extend_unique(
    target: list[HuggingFaceRecord],
    seen: set[str],
    rows: Sequence[HuggingFaceRecord],
    limit: int,
) -> None:
    for row in rows:
        record_id = row.get("id") or row.get("candidate_id")
        identity = record_id if isinstance(record_id, str) and record_id else str(row.get("url", ""))
        if not identity or identity in seen:
            continue
        seen.add(identity)
        target.append(row)
        if len(target) >= limit:
            return


def _request(
    *,
    operation: str,
    query: str,
    purpose: str,
    max_results: int,
    parameters: dict[str, Any],
) -> dict[str, Any]:
    return {
        "query": query,
        "purpose": _text(purpose, "purpose", max_length=4_000),
        "max_results": max_results,
        "provider_request": {
            "operation": operation,
            "parameters": parameters,
        },
    }


def _run(requests: Sequence[dict[str, Any]]) -> list[HuggingFaceRecord]:
    rows = list(requests)
    if not rows:
        raise ValueError("at least one Hugging Face request is required")
    return [_public_record(row) for row in search_source(rows, source="huggingface")]


def _public_record(row: dict[str, Any]) -> HuggingFaceRecord:
    """Expose stable Hugging Face metadata as convenient top-level fields."""
    record = dict(row)
    metadata = row.get("metadata")
    if isinstance(metadata, dict):
        for key in (
            "resource_type",
            "repo_id",
            "dataset_id",
            "model_id",
            "tag_type",
            "tag_id",
            "tag_label",
            "paper_id",
            "downloads",
            "downloads_all_time",
            "likes",
            "upvotes",
            "rank",
            "score",
            "verified",
            "filename",
            "lower_is_better",
            "leaderboard_url",
            "source",
            "tags",
            "pipeline_tag",
            "library_name",
            "created_at",
            "updated_at",
            "submitted_at",
            "document_url",
            "pdf_url",
            "artifact_path",
            "markdown_path",
            "metadata_path",
            "front_excerpt",
            "headings",
            "document_byte_length",
            "byte_length",
            "revision",
            "sha",
            "card_data",
            "model_index",
            "material_cache_hit",
        ):
            if key in metadata and key not in record:
                record[key] = metadata[key]
        download_path = metadata.get("markdown_path") or metadata.get("artifact_path")
        if isinstance(download_path, str) and download_path:
            record["download_path"] = workspace_path(download_path)
    return record  # type: ignore[return-value]


def _repo_id(value: object, label: str) -> str:
    parsed = _text(value, label, max_length=96)
    parts = parsed.split("/")
    if (
        not REPO_ID.fullmatch(parsed)
        or any(part.startswith(("-", ".")) or part.endswith(("-", ".")) for part in parts)
        or "--" in parsed
        or ".." in parsed
    ):
        raise ValueError(f"{label} must be a valid Hugging Face repository ID")
    return parsed


def _text(value: object, label: str, *, max_length: int = 2_000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise ValueError(f"{label} must be a non-empty string up to {max_length} characters")
    return value.strip()


def _text_list(
    value: str | Sequence[str],
    label: str,
    *,
    max_items: int,
) -> list[str]:
    rows = [value] if isinstance(value, str) else list(value)
    return _sequence(rows, label, max_items)


def _sequence(values: Sequence[str], label: str, max_items: int) -> list[str]:
    if len(values) > max_items:
        raise ValueError(f"{label} cannot exceed {max_items} items")
    rows: list[str] = []
    for value in values:
        parsed = _text(value, label, max_length=256)
        if parsed not in rows:
            rows.append(parsed)
    if not rows:
        raise ValueError(f"{label} must contain at least one value")
    return rows


def _page_size(value: int) -> int:
    if not isinstance(value, int) or not 1 <= value <= MAX_RESULTS_PER_REQUEST:
        raise ValueError(
            f"max_results must be between 1 and {MAX_RESULTS_PER_REQUEST}; "
            "use a paginate_* helper for larger acquisitions"
        )
    return value


def _total_results(value: int) -> int:
    if not isinstance(value, int) or not 1 <= value <= MAX_TOTAL_RESULTS:
        raise ValueError(f"total_results must be between 1 and {MAX_TOTAL_RESULTS}")
    return value


def _put_optional(parameters: dict[str, Any], key: str, value: object) -> None:
    if value is not None:
        parameters[key] = value


def _put_optional_text(
    parameters: dict[str, Any],
    key: str,
    value: str | None,
    *,
    max_length: int = 256,
) -> None:
    if value is not None:
        parameters[key] = _text(value, key, max_length=max_length)


def _put_list(
    parameters: dict[str, Any],
    key: str,
    values: Sequence[str],
    max_items: int,
) -> None:
    rows = list(values)
    if rows:
        parameters[key] = _sequence(rows, key, max_items)


def _matches_date(value: str, length: int, separator_positions: tuple[int, ...], separator: str) -> bool:
    return (
        len(value) == length
        and all(value[index] == separator for index in separator_positions)
        and all(character.isdigit() for index, character in enumerate(value) if index not in separator_positions)
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.parse_args()
    print(_HELP)
