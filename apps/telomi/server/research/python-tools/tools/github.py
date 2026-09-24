"""Read-only GitHub discovery and Runtime-owned download API."""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import date
from difflib import get_close_matches
from hashlib import sha256
from typing import Any, Literal, TypedDict

from research_runtime import search_source, workspace_path

__all__ = [
    "GitHubDiscovery",
    "GitHubRecord",
    "clone_repository",
    "discover_repositories",
    "download_file",
    "download_release",
    "get_issue",
    "get_repository",
    "search_code",
    "search_issues",
    "search_repositories",
    "search_topics",
]

MAX_RESULTS = 100
DISCOVERY_RESULT_LIMIT = 100
DISCOVERY_PAGE_SIZE = 20
DISCOVERY_CACHE_LIMIT = 5
DISCOVERY_LANES = ("topic_stars", "created_range", "active", "keywords")
DISCOVERY_RECORD_FIELDS = (
    "full_name", "url", "description", "stars", "forks", "language", "topics",
    "license", "created_at", "pushed_at", "archived", "discovery_lanes",
)
REPOSITORY = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$"
)
TOPIC = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,49})$")


class GitHubRecord(TypedDict, total=False):
    id: str
    title: str
    url: str
    content_path: str
    snippet: str
    repository: str
    owner: str
    path: str
    sha: str
    issue_number: int
    body: str
    comments: list[dict[str, Any]]
    stars: int
    forks: int
    language: str
    updated_at: str
    download_path: str
    material_cache_hit: bool
    full_name: str
    description: str
    topics: list[str]
    license: object
    created_at: str
    pushed_at: str
    archived: bool
    name: str
    display_name: str
    short_description: str
    featured: bool
    curated: bool
    created_by: str
    discovery_lanes: list[dict[str, Any]]
    metadata: dict[str, Any]


class GitHubDiscovery(TypedDict):
    records: list[GitHubRecord]
    lane_counts: dict[str, int]
    unique_count: int
    returned_count: int
    next_cursor: str | None


_DISCOVERY_POOLS: dict[
    tuple[tuple[str, ...], str | None, str | None, str | None, str | None, int | None],
    tuple[list[GitHubRecord], dict[str, int]],
] = {}


def search_topics(
    query: str,
    *,
    curated_only: bool = False,
    max_results: int = 20,
) -> list[GitHubRecord]:
    """Search GitHub's topic catalog.

    Args:
        query: Topic name or phrase.
        curated_only: Restrict results to the small set GitHub itself curates
            (generic names such as deep-learning). Most domain topics such as
            text-to-speech are community topics, so leave this False.
        max_results: Maximum results, from 1 through 100.

    Returns:
        Topic records with names, descriptions, and curation metadata.

    Raises:
        ValueError: If an argument is invalid.
        ResearchRuntimeError: If Runtime or GitHub fails.
    """
    value = _text(query, "query", 2_000)
    if not isinstance(curated_only, bool):
        raise ValueError("curated_only must be a boolean")
    size = _limit(max_results)
    return _run(
        "search_topics",
        {"query": value, "curated_only": curated_only, "limit": size},
        value,
        size,
    )


def search_repositories(
    query: str,
    *,
    topics: Sequence[str] = (),
    language: str | None = None,
    min_stars: int | None = None,
    created_after: str | None = None,
    created_before: str | None = None,
    pushed_after: str | None = None,
    sort: Literal["stars", "updated", "forks"] = "stars",
    max_results: int = 20,
) -> list[GitHubRecord]:
    """Search public GitHub repositories.

    GitHub ANDs whitespace-separated query terms. Topic filters are the
    reliable discovery path; keep free-text queries short and supplemental.

    Args:
        query: GitHub repository search phrase. May be empty when topics are supplied.
        topics: GitHub topic names, all applied as native filters.
        language: Optional GitHub language filter.
        min_stars: Optional inclusive minimum star count.
        created_after: Optional inclusive creation-date lower bound.
        created_before: Optional inclusive creation-date upper bound.
        pushed_after: Optional inclusive last-push lower bound.
        sort: GitHub result sort: stars, updated, or forks.
        max_results: Maximum results, from 1 through 100.

    Returns:
        Repository candidate dictionaries.

    Raises:
        ValueError: If the query or result limit is invalid.
        ResearchRuntimeError: If Runtime or GitHub fails.
    """
    topic_values = _topics(topics)
    value = _query(query, topic_values)
    size = _limit(max_results)
    if sort not in ("stars", "updated", "forks"):
        raise ValueError("sort must be stars, updated, or forks")
    parameters: dict[str, Any] = {
        "query": value,
        "topics": topic_values,
        "sort": sort,
        "limit": size,
    }
    if language is not None:
        parameters["language"] = _text(language, "language", 100)
    if min_stars is not None:
        parameters["min_stars"] = _nonnegative_integer(min_stars, "min_stars")
    for name, bound in (
        ("created_after", created_after),
        ("created_before", created_before),
        ("pushed_after", pushed_after),
    ):
        if bound is not None:
            parameters[name] = _date(bound, name)
    if created_after and created_before and parameters["created_after"] > parameters["created_before"]:
        raise ValueError("created_after must not be later than created_before")
    return _run("search_repositories", parameters, value or " ".join(topic_values), size)


def discover_repositories(
    topics: str | Sequence[str],
    *,
    keywords: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    language: str | None = None,
    min_stars: int | None = None,
    cursor: str | None = None,
    purpose: str = "Discover GitHub repositories through fixed native lanes",
) -> GitHubDiscovery:
    """Build one bounded repository pool from exact GitHub topics and fixed lanes.

    Args:
        topics: One or more exact GitHub topic names, as returned by search_topics().
        keywords: Optional short supplemental query.
        start_date: Optional inclusive creation and activity lower bound.
        end_date: Optional inclusive creation upper bound.
        language: Optional GitHub language filter applied to every lane.
        min_stars: Optional inclusive star threshold applied to every lane.
        cursor: Exact ``next_cursor`` from the preceding discovery page.
        purpose: Short provenance note.

    Returns:
        One compact record page, lane counts, pool counts, and next cursor.

    Raises:
        ValueError: If topics, dates, filters, or cursor are invalid.
        ResearchRuntimeError: If Runtime or GitHub fails.
    """
    topic_values = _topics([topics] if isinstance(topics, str) else topics)
    if not topic_values:
        raise ValueError("topics must contain at least one topic name")
    if (start_date is None) != (end_date is None):
        raise ValueError("start_date and end_date must be provided together")
    start = _date(start_date, "start_date") if start_date is not None else None
    end = _date(end_date, "end_date") if end_date is not None else None
    if start and end and start > end:
        raise ValueError("start_date must not be later than end_date")
    keyword_value = _text(keywords, "keywords", 2_000) if keywords is not None else None
    language_value = _text(language, "language", 100) if language is not None else None
    stars_value = _nonnegative_integer(min_stars, "min_stars") if min_stars is not None else None
    cache_key = (tuple(topic_values), keyword_value, start, end, language_value, stars_value)
    key_hash = sha256(repr(cache_key).encode()).hexdigest()[:16]
    offset = _discovery_offset(cursor, key_hash)
    cached = _DISCOVERY_POOLS.get(cache_key)
    if cached is not None:
        return _discovery_page(*cached, offset, key_hash)
    if cursor is not None:
        raise ValueError("cursor discovery pool is no longer cached; restart without a cursor")

    for topic in topic_values:
        matches = search_topics(topic, curated_only=False, max_results=20)
        names = [row["name"] for row in matches if isinstance(row.get("name"), str)]
        if topic not in names:
            closest = get_close_matches(topic, names, n=5, cutoff=0.3) or names[:5]
            suffix = f" Closest GitHub topics: {', '.join(closest)}." if closest else ""
            raise ValueError(f"Unknown GitHub topic '{topic}'.{suffix}")

    records_by_name: dict[str, GitHubRecord] = {}
    lane_counts: dict[str, int] = {}
    lane_ids = {lane: {topic: [] for topic in topic_values} for lane in DISCOVERY_LANES}
    common = {"language": language_value, "min_stars": stars_value, "max_results": 100}
    for topic in topic_values:
        lanes: list[tuple[str, list[GitHubRecord]]] = [
            ("topic_stars", search_repositories("", topics=[topic], sort="stars", **common)),
        ]
        if start and end:
            lanes.extend([
                ("created_range", search_repositories(
                    "", topics=[topic], created_after=start, created_before=end, sort="stars", **common,
                )),
                ("active", search_repositories(
                    "", topics=[topic], pushed_after=start, sort="updated", **common,
                )),
            ])
        if keyword_value:
            lanes.append(("keywords", search_repositories(
                keyword_value, topics=[topic], sort="stars", **common,
            )))
        for lane, rows in lanes:
            lane_counts[f"{topic}:{lane}"] = len(rows)
            for rank, row in enumerate(rows, start=1):
                record = _compact_repository(row)
                full_name = record.get("full_name")
                if not isinstance(full_name, str) or not full_name:
                    continue
                stored = records_by_name.setdefault(full_name, {**record, "discovery_lanes": []})
                stored["discovery_lanes"].append({"topic": topic, "lane": lane, "rank": rank})
                lane_ids[lane][topic].append(full_name)

    selected_names: list[str] = []
    seen: set[str] = set()
    for lane in DISCOVERY_LANES:
        rows_by_topic = lane_ids[lane]
        ordered = [
            rows[rank]
            for rank in range(max((len(rows) for rows in rows_by_topic.values()), default=0))
            for rows in rows_by_topic.values()
            if rank < len(rows)
        ]
        for full_name in ordered:
            if len(selected_names) == DISCOVERY_RESULT_LIMIT:
                break
            if full_name not in seen:
                seen.add(full_name)
                selected_names.append(full_name)
    selected = [records_by_name[full_name] for full_name in selected_names]
    if len(_DISCOVERY_POOLS) >= DISCOVERY_CACHE_LIMIT:
        _DISCOVERY_POOLS.pop(next(iter(_DISCOVERY_POOLS)))
    _DISCOVERY_POOLS[cache_key] = (selected, lane_counts)
    return _discovery_page(selected, lane_counts, offset, key_hash)


def get_repository(repository: str) -> list[GitHubRecord]:
    """Fetch one repository and its stable metadata.

    Args:
        repository: Repository in ``OWNER/REPO`` form.

    Returns:
        A single repository record when found.

    Raises:
        ValueError: If the repository name is invalid.
        ResearchRuntimeError: If Runtime or GitHub fails.
    """
    value = _repository(repository)
    return _run("get_repository", {"repository": value}, f"repository:{value}", 1)


def search_code(
    query: str,
    *,
    repository: str | None = None,
    max_results: int = 20,
) -> list[GitHubRecord]:
    """Search code, optionally within one repository.

    Args:
        query: GitHub code search phrase or qualifiers.
        repository: Optional repository in ``OWNER/REPO`` form.
        max_results: Maximum results, from 1 through 100.

    Returns:
        Matching code records with repository, path, SHA, and text fragments.

    Raises:
        ValueError: If an argument is invalid.
        ResearchRuntimeError: If Runtime or GitHub fails.
    """
    value = _text(query, "query", 2_000)
    size = _limit(max_results)
    parameters: dict[str, Any] = {"query": value, "limit": size}
    if repository is not None:
        parameters["repository"] = _repository(repository)
    return _run("search_code", parameters, value, size)


def search_issues(
    query: str,
    *,
    repository: str | None = None,
    state: Literal["open", "closed", "all"] = "all",
    match: Literal["title", "body", "comments"] | None = None,
    max_results: int = 20,
) -> list[GitHubRecord]:
    """Search GitHub Issues without loading every discussion.

    Args:
        query: Issue search phrase or qualifiers.
        repository: Optional repository in ``OWNER/REPO`` form.
        state: ``open``, ``closed``, or ``all``.
        match: Restrict matching to issue title, body, or comments.
        max_results: Maximum results, from 1 through 100.

    Returns:
        Issue candidates. Call :func:`get_issue` for full comments.

    Raises:
        ValueError: If an argument is invalid.
        ResearchRuntimeError: If Runtime or GitHub fails.
    """
    value = _text(query, "query", 2_000)
    size = _limit(max_results)
    if state not in ("open", "closed", "all"):
        raise ValueError("state must be open, closed, or all")
    if match is not None and match not in ("title", "body", "comments"):
        raise ValueError("match must be title, body, or comments")
    parameters: dict[str, Any] = {
        "query": value,
        "state": state,
        "limit": size,
    }
    if repository is not None:
        parameters["repository"] = _repository(repository)
    if match is not None:
        parameters["match"] = match
    return _run("search_issues", parameters, value, size)


def get_issue(repository: str, number: int) -> list[GitHubRecord]:
    """Fetch one Issue body and its complete comment thread.

    Args:
        repository: Repository in ``OWNER/REPO`` form.
        number: Positive Issue number.

    Returns:
        One Issue record containing structured ``comments``.

    Raises:
        ValueError: If the repository or Issue number is invalid.
        ResearchRuntimeError: If Runtime or GitHub fails.
    """
    value = _repository(repository)
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        raise ValueError("number must be a positive integer")
    return _run(
        "get_issue",
        {"repository": value, "number": number},
        f"issue:{value}#{number}",
        1,
    )


def clone_repository(
    repository: str,
    *,
    ref: str | None = None,
    full_history: bool = False,
) -> list[GitHubRecord]:
    """Clone a repository into the current PrimeSearch workspace.

    Args:
        repository: Repository in ``OWNER/REPO`` form.
        ref: Optional branch, tag, or commit reference.
        full_history: Clone all history instead of the default depth-one clone.

    Returns:
        One record whose ``download_path`` is a Runtime-owned directory.

    Raises:
        ValueError: If an argument is invalid.
        ResearchRuntimeError: If Runtime, GitHub CLI, or Git fails.
    """
    value = _repository(repository)
    if not isinstance(full_history, bool):
        raise ValueError("full_history must be a boolean")
    parameters: dict[str, Any] = {
        "repository": value,
        "full_history": full_history,
    }
    if ref is not None:
        parameters["ref"] = _ref(ref, "ref")
    return _run("clone_repository", parameters, f"clone:{value}:{ref or 'default'}", 1)


def download_release(
    repository: str,
    *,
    tag: str | None = None,
    patterns: Sequence[str] = (),
    archive: Literal["zip", "tar.gz"] | None = None,
) -> list[GitHubRecord]:
    """Download release assets or a source archive into the workspace.

    Args:
        repository: Repository in ``OWNER/REPO`` form.
        tag: Optional release tag. Without one, patterns or archive is required.
        patterns: Optional asset glob patterns.
        archive: Optional source archive format, ``zip`` or ``tar.gz``.

    Returns:
        One record for each downloaded file with ``download_path``.

    Raises:
        ValueError: If an argument is invalid.
        ResearchRuntimeError: If Runtime or GitHub CLI fails.
    """
    value = _repository(repository)
    normalized_patterns = _patterns(patterns)
    normalized_tag = _ref(tag, "tag") if tag is not None else None
    if archive is not None and archive not in ("zip", "tar.gz"):
        raise ValueError("archive must be zip or tar.gz")
    if normalized_tag is None and not normalized_patterns and archive is None:
        raise ValueError("tag, patterns, or archive is required")
    parameters: dict[str, Any] = {"repository": value}
    if normalized_tag is not None:
        parameters["tag"] = normalized_tag
    if normalized_patterns:
        parameters["patterns"] = normalized_patterns
    if archive is not None:
        parameters["archive"] = archive
    return _run(
        "download_release",
        parameters,
        f"release:{value}:{normalized_tag or 'latest'}",
        MAX_RESULTS,
    )


def download_file(
    repository: str,
    path: str,
    *,
    ref: str | None = None,
) -> list[GitHubRecord]:
    """Download one repository file into the workspace.

    Args:
        repository: Repository in ``OWNER/REPO`` form.
        path: Safe relative file path inside the repository.
        ref: Optional branch, tag, or commit reference.

    Returns:
        One file record with ``download_path``.

    Raises:
        ValueError: If an argument is invalid.
        ResearchRuntimeError: If Runtime or GitHub CLI fails.
    """
    value = _repository(repository)
    relative_path = _path(path)
    parameters: dict[str, Any] = {
        "repository": value,
        "path": relative_path,
    }
    if ref is not None:
        parameters["ref"] = _ref(ref, "ref")
    return _run(
        "download_file",
        parameters,
        f"file:{value}:{relative_path}:{ref or 'default'}",
        1,
    )


def _run(
    operation: str,
    parameters: dict[str, Any],
    query: str,
    max_results: int,
) -> list[GitHubRecord]:
    rows = search_source([{
        "query": query,
        "purpose": f"Host-owned GitHub {operation}",
        "max_results": max_results,
        "provider_request": {
            "operation": operation,
            "parameters": parameters,
        },
    }], source="github")
    return [_enrich(row) for row in rows]


def _enrich(row: dict[str, Any]) -> GitHubRecord:
    output = dict(row)
    metadata = row.get("metadata")
    if not isinstance(metadata, dict):
        return output  # type: ignore[return-value]
    for key in (
        "repository",
        "owner",
        "path",
        "sha",
        "issue_number",
        "body",
        "comments",
        "stars",
        "forks",
        "language",
        "updated_at",
        "topics",
        "license",
        "created_at",
        "pushed_at",
        "archived",
        "name",
        "display_name",
        "short_description",
        "featured",
        "curated",
        "created_by",
        "material_cache_hit",
    ):
        if key in metadata:
            output[key] = metadata[key]
    artifact_path = metadata.get("artifact_path")
    if isinstance(artifact_path, str) and artifact_path:
        output["download_path"] = workspace_path(artifact_path)
    return output  # type: ignore[return-value]


def _compact_repository(row: GitHubRecord) -> GitHubRecord:
    full_name = row.get("full_name") or row.get("repository") or row.get("title")
    values: dict[str, Any] = {
        "full_name": full_name,
        "url": row.get("url"),
        "description": row.get("description", row.get("snippet", "")),
        **{key: row[key] for key in DISCOVERY_RECORD_FIELDS if key in row},
    }
    return {key: values[key] for key in DISCOVERY_RECORD_FIELDS if key in values}  # type: ignore[return-value]


def _discovery_page(
    selected: list[GitHubRecord],
    lane_counts: dict[str, int],
    offset: int,
    key_hash: str,
) -> GitHubDiscovery:
    if offset and offset >= len(selected):
        raise ValueError("cursor is beyond the current discovery pool; restart without a cursor")
    end = min(offset + DISCOVERY_PAGE_SIZE, len(selected))
    records = [record.copy() for record in selected[offset:end]]
    return {
        "records": records,
        "lane_counts": lane_counts,
        "unique_count": len(selected),
        "returned_count": len(records),
        "next_cursor": f"github-discovery:{key_hash}:{end}" if end < len(selected) else None,
    }


def _discovery_offset(cursor: str | None, key_hash: str) -> int:
    if cursor is None:
        return 0
    value = _text(cursor, "cursor", 64)
    parts = value.split(":")
    if len(parts) != 3 or parts[0] != "github-discovery" or not parts[2].isdigit() or int(parts[2]) <= 0:
        raise ValueError("cursor must be the exact next_cursor returned by discover_repositories()")
    if parts[1] != key_hash:
        raise ValueError("cursor was created for different discovery parameters")
    return int(parts[2])


def _repository(value: str) -> str:
    result = _text(value, "repository", 140)
    if not REPOSITORY.fullmatch(result):
        raise ValueError("repository must use OWNER/REPO form")
    return result


def _path(value: str) -> str:
    result = _text(value, "path", 4_096)
    parts = result.split("/")
    if result.startswith("/") or any(part in ("", ".", "..") for part in parts):
        raise ValueError("path must be a safe relative repository path")
    return result


def _ref(value: str, name: str) -> str:
    result = _text(value, name, 255)
    if result.startswith("-") or any(ord(character) < 32 or ord(character) == 127 for character in result):
        raise ValueError(f"{name} is invalid")
    return result


def _patterns(values: Sequence[str]) -> list[str]:
    if isinstance(values, (str, bytes)) or len(values) > 20:
        raise ValueError("patterns must be a sequence of at most 20 strings")
    return list(dict.fromkeys(_text(value, "pattern", 256) for value in values))


def _topics(values: Sequence[str]) -> list[str]:
    if isinstance(values, (str, bytes)) or len(values) > 20:
        raise ValueError("topics must be a sequence of at most 20 topic names")
    topics = list(dict.fromkeys(_text(value, "topic", 50) for value in values))
    if any(not TOPIC.fullmatch(topic) for topic in topics):
        raise ValueError("topic names may contain only letters, numbers, and hyphens")
    return topics


def _query(value: str, topics: Sequence[str]) -> str:
    if not isinstance(value, str) or len(value) > 2_000:
        raise ValueError("query must be a string up to 2000 characters")
    result = value.strip()
    if not result and not topics:
        raise ValueError("query may be empty only when topics are supplied")
    return result


def _date(value: str, name: str) -> str:
    result = _text(value, name, 10)
    try:
        parsed = date.fromisoformat(result)
    except ValueError:
        raise ValueError(f"{name} must use YYYY-MM-DD") from None
    if parsed.isoformat() != result:
        raise ValueError(f"{name} must use YYYY-MM-DD")
    return result


def _nonnegative_integer(value: int, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


def _limit(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= MAX_RESULTS:
        raise ValueError(f"max_results must be between 1 and {MAX_RESULTS}")
    return value


def _text(value: str, name: str, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise ValueError(
            f"{name} must be a non-empty string up to {max_length} characters"
        )
    return value.strip()
