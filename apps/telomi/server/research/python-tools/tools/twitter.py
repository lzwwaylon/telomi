"""Read-only Python API for X/Twitter research.

The PrimeSearch receives no browser profile, Cookie header, CSRF token, or
direct network access. Runtime validates each request and the Host source
service injects the local X session only for the upstream request.
"""

from __future__ import annotations

import argparse
import re
from collections.abc import Sequence
from typing import Any, Literal, TypedDict

from research_runtime import search_source

__all__ = [
    "TwitterRecord",
    "article",
    "bookmarks",
    "device_follow",
    "followers",
    "following",
    "likes",
    "list_tweets",
    "lists",
    "media",
    "notifications",
    "profile",
    "search",
    "thread",
    "timeline",
    "trending",
    "tweets",
]

MAX_RESULTS_PER_REQUEST = 100
MAX_BATCH_ITEMS = 50
HANDLE = re.compile(r"^[A-Za-z0-9_]{1,15}$")
DECIMAL_ID = re.compile(r"^\d{1,32}$")
TWEET_URL_ID = re.compile(r"/(?:status|article)/(\d{1,32})(?:[/?#]|$)")

SearchProduct = Literal["top", "latest", "photos", "videos"]
TimelineFeed = Literal["for_you", "following"]


class TwitterRecord(TypedDict, total=False):
    id: str
    title: str
    url: str
    content_path: str
    snippet: str
    text: str
    content: str
    published_at: str
    authors: list[str]
    resource_type: str
    user_id: str
    screen_name: str
    display_name: str
    tweet_id: str
    author: str
    followers: int
    following: int
    likes: int
    retweets: int
    replies: int
    bookmarks: int
    views: int
    media_urls: list[str]
    media_type: str
    list_id: str
    notification_action: str
    trend_rank: int
    next_cursor: str
    metadata: dict[str, Any]
    identifiers: list[dict[str, Any]]
    query_sequences: list[int]


_HELP = """X/Twitter read-only Python API

Import and call it from a PrimeSearch pipeline:

  from tools import twitter

  recent = twitter.search(
      '"agent evaluation" lang:en -filter:replies',
      product="latest",
      max_results=50,
  )
  posts = twitter.tweets("OpenAI", max_results=50)
  saved = twitter.bookmarks(max_results=50)

Functions return list[TwitterRecord]. User-scoped functions accept either a
handle or a numeric user ID. Resolving a handle is a separate audited Provider
call. Pass an opaque next_cursor from a returned row to request the next page.

The Worker never receives the X Cookie header, CSRF token, bearer token, or
direct network access. Every operation is read-only and recorded by Runtime.
"""


def search(
    query: str | Sequence[str],
    *,
    product: SearchProduct = "top",
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Search X/Twitter posts",
) -> list[TwitterRecord]:
    """Search posts with native X query syntax.

    Args:
        query: One native X query or a sequence of queries.
        product: ``top``, ``latest``, ``photos``, or ``videos``.
        max_results: Maximum records per query, up to 100.
        cursor: Opaque cursor returned by a prior page.
        purpose: Short provenance note.

    Returns:
        Deduplicated post candidates.

    Raises:
        ValueError: If a query, product, cursor, or limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    if product not in ("top", "latest", "photos", "videos"):
        raise ValueError("product must be top, latest, photos, or videos")
    size = _page_size(max_results)
    queries = _text_list(query, "query")
    parameters = {
        "product": product,
        "limit": size,
        **_cursor(cursor),
    }
    return _run([
        _request(
            operation="search",
            query=value,
            purpose=purpose,
            max_results=size,
            parameters={**parameters, "query": value},
        )
        for value in queries
    ])


def profile(
    username: str | None = None,
    *,
    user_id: str | None = None,
    purpose: str = "Read an X/Twitter profile",
) -> list[TwitterRecord]:
    """Read one profile by handle, numeric user ID, or current session.

    Args:
        username: Handle with or without ``@``. Omit for the current account.
        user_id: Numeric user ID instead of a handle.
        purpose: Short provenance note.

    Returns:
        Zero or one profile candidate.

    Raises:
        ValueError: If both targets are supplied or either is malformed.
        ResearchRuntimeError: If Runtime or X fails.
    """
    if username is not None and user_id is not None:
        raise ValueError("username and user_id are mutually exclusive")
    parameters: dict[str, Any] = {}
    query = "current_session_profile"
    if username is not None:
        normalized = _handle(username)
        parameters["username"] = normalized
        query = f"profile:@{normalized}"
    if user_id is not None:
        normalized_id = _decimal_id(user_id, "user_id")
        parameters["user_id"] = normalized_id
        query = f"profile:user_id={normalized_id}"
    return _run([_request(
        operation="profile",
        query=query,
        purpose=purpose,
        max_results=1,
        parameters=parameters,
    )])


def tweets(
    user: str | None = None,
    *,
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Read posts from an X/Twitter user",
) -> list[TwitterRecord]:
    """Read a user's posts.

    Args:
        user: Handle or numeric user ID. Omit for the current account.
        max_results: Maximum records, up to 100.
        cursor: Opaque next-page cursor.
        purpose: Short provenance note.

    Returns:
        Post candidates.

    Raises:
        ValueError: If user, cursor, or limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    return _user_timeline("tweets", user, max_results, cursor, purpose)


def thread(
    tweet: str,
    *,
    max_results: int = 100,
    cursor: str | None = None,
    purpose: str = "Read an X/Twitter conversation thread",
) -> list[TwitterRecord]:
    """Read a focal post and its visible conversation thread.

    Args:
        tweet: Numeric post ID or an X status URL.
        max_results: Maximum records, up to 100.
        cursor: Opaque next-page cursor.
        purpose: Short provenance note.

    Returns:
        Thread post candidates.

    Raises:
        ValueError: If the post target, cursor, or limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    tweet_id = _tweet_id(tweet)
    size = _page_size(max_results)
    return _run([_request(
        operation="thread",
        query=f"thread:{tweet_id}",
        purpose=purpose,
        max_results=size,
        parameters={"tweet_id": tweet_id, "limit": size, **_cursor(cursor)},
    )])


def article(
    tweet: str,
    *,
    purpose: str = "Read an X/Twitter long-form article",
) -> list[TwitterRecord]:
    """Read long-form article or Note Tweet content from a parent post.

    Args:
        tweet: Parent status URL or numeric parent post ID.
        purpose: Short provenance note.

    Returns:
        Zero or one article candidate with content in ``snippet`` and metadata.

    Raises:
        ValueError: If no parent post ID can be parsed.
        ResearchRuntimeError: If Runtime or X fails.
    """
    tweet_id = _tweet_id(tweet)
    return _run([_request(
        operation="article",
        query=f"article:{tweet_id}",
        purpose=purpose,
        max_results=1,
        parameters={"tweet_id": tweet_id},
    )])


def timeline(
    *,
    feed: TimelineFeed = "for_you",
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Read the current X/Twitter home timeline",
) -> list[TwitterRecord]:
    """Read the algorithmic or following home timeline.

    Args:
        feed: ``for_you`` or ``following``.
        max_results: Maximum records, up to 100.
        cursor: Opaque next-page cursor.
        purpose: Short provenance note.

    Returns:
        Home timeline post candidates.

    Raises:
        ValueError: If feed, cursor, or limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    if feed not in ("for_you", "following"):
        raise ValueError("feed must be for_you or following")
    size = _page_size(max_results)
    return _run([_request(
        operation="timeline",
        query=f"home_timeline:{feed}",
        purpose=purpose,
        max_results=size,
        parameters={"feed": feed, "limit": size, **_cursor(cursor)},
    )])


def following(
    user: str | None = None,
    *,
    max_results: int = 50,
    cursor: str | None = None,
    purpose: str = "Read accounts followed by an X/Twitter user",
) -> list[TwitterRecord]:
    """Read accounts followed by a user.

    Args:
        user: Handle or numeric user ID. Omit for the current account.
        max_results: Maximum records, up to 100.
        cursor: Opaque next-page cursor.
        purpose: Short provenance note.

    Returns:
        User profile candidates.

    Raises:
        ValueError: If user, cursor, or limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    return _user_timeline("following", user, max_results, cursor, purpose)


def followers(
    user: str | None = None,
    *,
    max_results: int = 50,
    cursor: str | None = None,
    purpose: str = "Read followers of an X/Twitter user",
) -> list[TwitterRecord]:
    """Read accounts following a user.

    Args:
        user: Handle or numeric user ID. Omit for the current account.
        max_results: Maximum records, up to 100.
        cursor: Opaque next-page cursor.
        purpose: Short provenance note.

    Returns:
        User profile candidates.

    Raises:
        ValueError: If user, cursor, or limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    return _user_timeline("followers", user, max_results, cursor, purpose)


def likes(
    user: str | None = None,
    *,
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Read posts liked by an X/Twitter user",
) -> list[TwitterRecord]:
    """Read posts liked by a user.

    Args:
        user: Handle or numeric user ID. Omit for the current account.
        max_results: Maximum records, up to 100.
        cursor: Opaque next-page cursor.
        purpose: Short provenance note.

    Returns:
        Liked post candidates.

    Raises:
        ValueError: If user, cursor, or limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    return _user_timeline("likes", user, max_results, cursor, purpose)


def bookmarks(
    *,
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Read the current X/Twitter account bookmarks",
) -> list[TwitterRecord]:
    """Read the current account's bookmarks.

    Args:
        max_results: Maximum records, up to 100.
        cursor: Opaque next-page cursor.
        purpose: Short provenance note.

    Returns:
        Bookmarked post candidates.

    Raises:
        ValueError: If cursor or limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    return _simple_page("bookmarks", max_results, cursor, purpose)


def lists(
    *,
    max_results: int = 100,
    purpose: str = "Read the current X/Twitter account lists",
) -> list[TwitterRecord]:
    """List owned and subscribed X lists.

    Args:
        max_results: Maximum lists, up to 100.
        purpose: Short provenance note.

    Returns:
        List candidates.

    Raises:
        ValueError: If the limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    return _simple_limit("lists", max_results, purpose)


def list_tweets(
    list_id: str,
    *,
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Read posts from an X/Twitter list",
) -> list[TwitterRecord]:
    """Read the latest posts from one X list.

    Args:
        list_id: Numeric list ID returned by :func:`lists`.
        max_results: Maximum records, up to 100.
        cursor: Opaque next-page cursor.
        purpose: Short provenance note.

    Returns:
        List post candidates.

    Raises:
        ValueError: If list ID, cursor, or limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    normalized = _decimal_id(list_id, "list_id")
    size = _page_size(max_results)
    return _run([_request(
        operation="list_tweets",
        query=f"list_tweets:{normalized}",
        purpose=purpose,
        max_results=size,
        parameters={"list_id": normalized, "limit": size, **_cursor(cursor)},
    )])


def device_follow(
    *,
    max_results: int = 20,
    purpose: str = "Read the X/Twitter device-follow notification stream",
) -> list[TwitterRecord]:
    """Read posts from the device-follow notification stream.

    Args:
        max_results: Maximum records, up to 100.
        purpose: Short provenance note.

    Returns:
        Device-follow post candidates.

    Raises:
        ValueError: If the limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    return _simple_limit("device_follow", max_results, purpose)


def notifications(
    *,
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Read the current X/Twitter account notifications",
) -> list[TwitterRecord]:
    """Read account notifications.

    Args:
        max_results: Maximum records, up to 100.
        cursor: Opaque next-page cursor.
        purpose: Short provenance note.

    Returns:
        Notification candidates.

    Raises:
        ValueError: If cursor or limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    return _simple_page("notifications", max_results, cursor, purpose)


def trending(
    *,
    max_results: int = 20,
    purpose: str = "Read current X/Twitter trends",
) -> list[TwitterRecord]:
    """Read current session-localized trends.

    Args:
        max_results: Maximum trends, up to 100.
        purpose: Short provenance note.

    Returns:
        Trend candidates.

    Raises:
        ValueError: If the limit is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    return _simple_limit("trending", max_results, purpose)


def media(
    *,
    user: str | None = None,
    tweet_id: str | None = None,
    max_results: int = 20,
    cursor: str | None = None,
    purpose: str = "Read X/Twitter media metadata",
) -> list[TwitterRecord]:
    """Read direct media URLs from a user media timeline or one post.

    Args:
        user: Handle or numeric user ID for a media timeline.
        tweet_id: Numeric post ID or status URL instead of a user.
        max_results: Maximum media assets, up to 100.
        cursor: Opaque next-page cursor for a user media timeline.
        purpose: Short provenance note.

    Returns:
        Media candidates. The function does not write or download files.

    Raises:
        ValueError: If exactly one target is not supplied or input is invalid.
        ResearchRuntimeError: If Runtime or X fails.
    """
    if (user is None) == (tweet_id is None):
        raise ValueError("exactly one of user or tweet_id is required")
    size = _page_size(max_results)
    parameters: dict[str, Any] = {"limit": size, **_cursor(cursor)}
    if user is not None:
        parameters["user_id"] = _resolve_user_id(user, purpose)
        query = f"media:user_id={parameters['user_id']}"
    else:
        parameters["tweet_id"] = _tweet_id(tweet_id or "")
        query = f"media:tweet_id={parameters['tweet_id']}"
    return _run([_request(
        operation="media",
        query=query,
        purpose=purpose,
        max_results=size,
        parameters=parameters,
    )])


def _user_timeline(
    operation: Literal["tweets", "following", "followers", "likes"],
    user: str | None,
    max_results: int,
    cursor: str | None,
    purpose: str,
) -> list[TwitterRecord]:
    size = _page_size(max_results)
    user_id = _resolve_user_id(user, purpose)
    return _run([_request(
        operation=operation,
        query=f"{operation}:user_id={user_id}",
        purpose=purpose,
        max_results=size,
        parameters={"user_id": user_id, "limit": size, **_cursor(cursor)},
    )])


def _resolve_user_id(user: str | None, purpose: str) -> str:
    if user is not None:
        value = _text(user, "user", max_length=64)
        if DECIMAL_ID.fullmatch(value):
            return value
        rows = profile(_handle(value), purpose=f"{purpose}: resolve user ID")
    else:
        rows = profile(purpose=f"{purpose}: resolve current user ID")
    for row in rows:
        user_id = row.get("user_id")
        if isinstance(user_id, str) and DECIMAL_ID.fullmatch(user_id):
            return user_id
        metadata = row.get("metadata")
        if isinstance(metadata, dict):
            user_id = metadata.get("user_id")
            if isinstance(user_id, str) and DECIMAL_ID.fullmatch(user_id):
                return user_id
    raise ValueError("Twitter profile response did not include a numeric user_id")


def _simple_page(
    operation: Literal["bookmarks", "notifications"],
    max_results: int,
    cursor: str | None,
    purpose: str,
) -> list[TwitterRecord]:
    size = _page_size(max_results)
    return _run([_request(
        operation=operation,
        query=operation,
        purpose=purpose,
        max_results=size,
        parameters={"limit": size, **_cursor(cursor)},
    )])


def _simple_limit(
    operation: Literal["lists", "device_follow", "trending"],
    max_results: int,
    purpose: str,
) -> list[TwitterRecord]:
    size = _page_size(max_results)
    return _run([_request(
        operation=operation,
        query=operation,
        purpose=purpose,
        max_results=size,
        parameters={"limit": size},
    )])


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


def _run(requests: Sequence[dict[str, Any]]) -> list[TwitterRecord]:
    rows = list(requests)
    if not rows:
        raise ValueError("at least one Twitter request is required")
    return [_public_record(row) for row in search_source(rows, source="twitter")]


def _public_record(row: dict[str, Any]) -> TwitterRecord:
    record = dict(row)
    metadata = row.get("metadata")
    snippet = row.get("snippet")
    if isinstance(snippet, str) and snippet:
        record.setdefault("text", snippet)
    if isinstance(metadata, dict):
        for key in (
            "resource_type",
            "user_id",
            "screen_name",
            "display_name",
            "tweet_id",
            "author",
            "followers",
            "following",
            "likes",
            "retweets",
            "replies",
            "bookmarks",
            "views",
            "media_urls",
            "media_type",
            "list_id",
            "notification_action",
            "trend_rank",
        ):
            if key in metadata and key not in record:
                record[key] = metadata[key]
        content = metadata.get("content")
        if isinstance(content, str) and content:
            record.setdefault("content", content)
            record.setdefault("text", content)
        page = metadata.get("twitter_page")
        if isinstance(page, dict) and isinstance(page.get("next_cursor"), str):
            record["next_cursor"] = page["next_cursor"]
    return record  # type: ignore[return-value]


def _handle(value: str) -> str:
    parsed = _text(value, "username", max_length=64).lstrip("@")
    if not HANDLE.fullmatch(parsed):
        raise ValueError("username must contain 1 to 15 letters, numbers, or underscores")
    return parsed


def _tweet_id(value: str) -> str:
    parsed = _text(value, "tweet", max_length=2_000)
    if DECIMAL_ID.fullmatch(parsed):
        return parsed
    match = TWEET_URL_ID.search(parsed)
    if not match:
        raise ValueError("tweet must be a numeric post ID or an X status URL")
    return match.group(1)


def _decimal_id(value: str, label: str) -> str:
    parsed = _text(value, label, max_length=32)
    if not DECIMAL_ID.fullmatch(parsed):
        raise ValueError(f"{label} must be a decimal identifier")
    return parsed


def _cursor(value: str | None) -> dict[str, str]:
    if value is None:
        return {}
    return {"cursor": _text(value, "cursor", max_length=4_096)}


def _page_size(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= MAX_RESULTS_PER_REQUEST:
        raise ValueError(f"max_results must be between 1 and {MAX_RESULTS_PER_REQUEST}")
    return value


def _text(value: object, label: str, *, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise ValueError(f"{label} must be a non-empty string up to {max_length} characters")
    return value.strip()


def _text_list(value: str | Sequence[str], label: str) -> list[str]:
    rows = [value] if isinstance(value, str) else list(value)
    if not rows or len(rows) > MAX_BATCH_ITEMS:
        raise ValueError(f"{label} must contain between 1 and {MAX_BATCH_ITEMS} values")
    output: list[str] = []
    for row in rows:
        parsed = _text(row, label, max_length=2_000)
        if parsed not in output:
            output.append(parsed)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.parse_args()
    print(_HELP)
