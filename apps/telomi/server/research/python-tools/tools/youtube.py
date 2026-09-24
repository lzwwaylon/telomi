"""Python API for the Telomi YouTube Provider.

Import this module from a PrimeSearch pipeline. Network access, local browser
cookies, yt-dlp execution, ASR, retries, artifacts, and provenance remain
owned by Host Runtime.
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from typing import Any, TypedDict

from research_runtime import search_source

__all__ = [
    "YouTubeRecord",
    "capabilities",
    "channel_videos",
    "history",
    "next_page_token",
    "playlist_videos",
    "recommendations",
    "search",
    "subscription_uploads",
    "subscriptions",
    "transcript",
    "video",
    "watch_later",
]

MAX_PAGE_SIZE = 50
MAX_BATCH_RESULTS = 500


class YouTubeRecord(TypedDict, total=False):
    id: str
    title: str
    url: str
    content_path: str
    description: str
    snippet: str
    published_at: str
    authors: list[str]
    metadata: dict[str, Any]
    video_id: str
    channel_id: str
    channel_title: str
    playlist_id: str
    duration_seconds: float
    caption_available: bool
    transcript_status: str
    transcript_kind: str
    source_language: str
    output_language: str
    timestamp_precision: str
    next_page_token: str


def _request(
    operation: str,
    parameters: dict[str, Any],
    *,
    query: str,
    max_results: int,
) -> dict[str, Any]:
    if not isinstance(max_results, int) or not 1 <= max_results <= MAX_BATCH_RESULTS:
        raise ValueError(
            f"max_results must be between 1 and {MAX_BATCH_RESULTS}"
        )
    return {
        "query": query,
        "purpose": f"Host-owned YouTube {operation}",
        "max_results": max_results,
        "provider_request": {
            "operation": operation,
            "parameters": parameters,
        },
    }


def _run(request: dict[str, Any]) -> list[YouTubeRecord]:
    return [_enrich(row) for row in search_source([request], source="youtube")]


def _enrich(row: dict[str, Any]) -> YouTubeRecord:
    output = dict(row)
    metadata = row.get("metadata")
    if not isinstance(metadata, dict):
        return output  # type: ignore[return-value]
    description = metadata.get("video_description")
    if not isinstance(description, str) and metadata.get("resource_type") == "video":
        description = row.get("snippet")
    if isinstance(description, str):
        output["description"] = description
    aliases = {
        "video_id": "video_id",
        "channel_id": "channel_id",
        "channel_title": "channel_title",
        "playlist_id": "playlist_id",
        "duration_seconds": "duration_seconds",
        "caption_available": "caption_available",
        "transcript_status": "transcript_status",
        "transcript_kind": "transcript_kind",
        "transcript_source_language": "source_language",
        "transcript_output_language": "output_language",
        "timestamp_precision": "timestamp_precision",
        "next_page_token": "next_page_token",
    }
    for source, target in aliases.items():
        if source in metadata:
            output[target] = metadata[source]
    return output  # type: ignore[return-value]


def next_page_token(rows: Sequence[YouTubeRecord]) -> str | None:
    """Return the opaque continuation token carried by one result page."""
    for row in reversed(rows):
        token = row.get("next_page_token")
        if isinstance(token, str) and token:
            return token
    return None


def capabilities() -> list[YouTubeRecord]:
    """Return account connection and capability status.

    Returns:
        One Provider capability record without exposing credentials.

    Raises:
        ResearchRuntimeError: If Runtime cannot inspect the Provider.
    """
    return _run(_request(
        "capabilities",
        {},
        query="youtube:capabilities",
        max_results=1,
    ))


def subscriptions(
    *,
    max_results: int = 50,
    page_token: str | None = None,
) -> list[YouTubeRecord]:
    """List one page of channels followed by the connected account.

    Args:
        max_results: Number of subscriptions, from 1 through 50.
        page_token: Opaque token returned in result metadata.

    Returns:
        Subscription records for YouTube channels.

    Raises:
        ValueError: If local bounds are invalid.
        ResearchRuntimeError: If yt-dlp fails.
    """
    limit = _page_size(max_results)
    return _run(_request(
        "list_subscriptions",
        {
            "limit": limit,
            **_optional("page_token", page_token),
        },
        query=f"youtube:list_subscriptions:{page_token or 'first'}",
        max_results=limit,
    ))


def subscription_uploads(
    *,
    published_after: str | None = None,
    channel_ids: Sequence[str] = (),
    include_shorts: bool = True,
    include_live: bool = True,
    max_results: int = 100,
) -> list[YouTubeRecord]:
    """Acquire recent videos from the connected account's subscriptions.

    Args:
        published_after: Optional ISO 8601 lower bound for incremental sync.
        channel_ids: Optional subscribed-channel subset.
        include_shorts: Include short-form video candidates.
        include_live: Include live and scheduled live videos.
        max_results: Total result bound, from 1 through 500.

    Returns:
        Video records sorted by publication time.

    Raises:
        ValueError: If local bounds or channel IDs are invalid.
        ResearchRuntimeError: If yt-dlp fails.
    """
    limit = _batch_size(max_results)
    channels = _strings(channel_ids, "channel_ids", 500)
    parameters: dict[str, Any] = {
        "limit": limit,
        "include_shorts": _boolean(include_shorts, "include_shorts"),
        "include_live": _boolean(include_live, "include_live"),
        **_optional("published_after", published_after),
    }
    if channels:
        parameters["channel_ids"] = channels
    return _run(_request(
        "list_subscription_uploads",
        parameters,
        query=f"youtube:list_subscription_uploads:{published_after or 'latest'}",
        max_results=limit,
    ))


def channel_videos(
    channel: str,
    *,
    published_after: str | None = None,
    include_shorts: bool = True,
    include_live: bool = True,
    max_results: int = 50,
    page_token: str | None = None,
) -> list[YouTubeRecord]:
    """List videos from a channel ID, handle, or channel URL."""
    value = _text(channel, "channel")
    limit = _page_size(max_results)
    return _run(_request(
        "list_channel_videos",
        {
            "channel_id": value,
            "limit": limit,
            "include_shorts": _boolean(include_shorts, "include_shorts"),
            "include_live": _boolean(include_live, "include_live"),
            **_optional("published_after", published_after),
            **_optional("page_token", page_token),
        },
        query=f"youtube:list_channel_videos:{value}",
        max_results=limit,
    ))


def playlist_videos(
    playlist: str,
    *,
    max_results: int = 50,
    page_token: str | None = None,
) -> list[YouTubeRecord]:
    """List videos from a playlist ID or URL."""
    value = _text(playlist, "playlist")
    limit = _page_size(max_results)
    return _run(_request(
        "list_playlist_videos",
        {
            "playlist_id": value,
            "limit": limit,
            **_optional("page_token", page_token),
        },
        query=f"youtube:list_playlist_videos:{value}",
        max_results=limit,
    ))


def search(
    query: str,
    *,
    channel_id: str | None = None,
    published_after: str | None = None,
    max_results: int = 50,
    page_token: str | None = None,
) -> list[YouTubeRecord]:
    """Search YouTube videos through yt-dlp."""
    value = _text(query, "query")
    limit = _page_size(max_results)
    return _run(_request(
        "search_videos",
        {
            "query": value,
            "limit": limit,
            **_optional("channel_id", channel_id),
            **_optional("published_after", published_after),
            **_optional("page_token", page_token),
        },
        query=value,
        max_results=limit,
    ))


def video(video_or_url: str) -> list[YouTubeRecord]:
    """Get video metadata by ID or URL.

    Video metadata records do not expose ``content_path``. Call
    ``transcript(...)`` when document content is required.
    """
    value = _text(video_or_url, "video_or_url")
    return _run(_request(
        "get_video",
        {"video_id": value},
        query=f"youtube:get_video:{value}",
        max_results=1,
    ))


def transcript(
    video_or_url: str,
    *,
    target_language: str | None = None,
    preferred_languages: Sequence[str] = (),
    max_duration_seconds: int = 7200,
) -> list[YouTubeRecord]:
    """Acquire captions and a convertible ``content_path`` with ASR fallback."""
    value = _text(video_or_url, "video_or_url")
    languages = _strings(preferred_languages, "preferred_languages", 20)
    parameters: dict[str, Any] = {
        "video_id": value,
        "preferred_languages": languages,
        "max_duration_seconds": _integer(
            max_duration_seconds, "max_duration_seconds", 30, 21600
        ),
        **_optional("target_language", target_language),
    }
    return _run(_request(
        "get_transcript",
        parameters,
        query=f"youtube:get_transcript:{value}:{target_language or 'source'}",
        max_results=1,
    ))


def recommendations(
    *,
    max_results: int = 20,
) -> list[YouTubeRecord]:
    """Snapshot the local account's home feed."""
    return _account_feed("snapshot_home_recommendations", max_results)


def watch_later(
    *,
    max_results: int = 20,
) -> list[YouTubeRecord]:
    """Read Watch Later items through yt-dlp."""
    return _account_feed("list_watch_later", max_results)


def history(
    *,
    max_results: int = 20,
) -> list[YouTubeRecord]:
    """Read account history through yt-dlp."""
    return _account_feed("list_history", max_results)


def _account_feed(
    operation: str,
    max_results: int,
) -> list[YouTubeRecord]:
    limit = _integer(max_results, "max_results", 1, 100)
    return _run(_request(
        operation,
        {"limit": limit},
        query=f"youtube:{operation}:snapshot",
        max_results=limit,
    ))


def _page_size(value: int) -> int:
    return _integer(value, "max_results", 1, MAX_PAGE_SIZE)


def _batch_size(value: int) -> int:
    return _integer(value, "max_results", 1, MAX_BATCH_RESULTS)


def _integer(value: int, label: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{label} must be an integer")
    if not minimum <= value <= maximum:
        raise ValueError(f"{label} must be from {minimum} through {maximum}")
    return value


def _boolean(value: bool, label: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{label} must be a boolean")
    return value


def _text(value: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value.strip()


def _strings(values: Sequence[str], label: str, maximum: int) -> list[str]:
    if isinstance(values, str):
        raise ValueError(f"{label} must be a sequence of strings, not one string")
    rows: list[str] = []
    for value in values:
        parsed = _text(value, label)
        if parsed not in rows:
            rows.append(parsed)
    if len(rows) > maximum:
        raise ValueError(f"{label} cannot exceed {maximum} values")
    return rows


def _optional(key: str, value: str | None) -> dict[str, str]:
    return {key: _text(value, key)} if value is not None else {}


_HELP = """YouTube Python API

Import and call it from a PrimeSearch pipeline:

  from tools import youtube

  videos = youtube.subscription_uploads(
      published_after="2026-07-19T00:00:00Z",
      max_results=100,
  )

  transcript = youtube.transcript(
      videos[0]["video_id"],
      target_language="zh-Hans",
  )

Local browser cookies, yt-dlp, STT, artifacts, retries, and provenance remain
inside Host Runtime.
"""


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.parse_args()
