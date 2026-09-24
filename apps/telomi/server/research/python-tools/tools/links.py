"""Pure link extraction shared by research Provider tools."""

from __future__ import annotations

import re
from re import Pattern
from typing import Literal, TypedDict
from urllib.parse import urlsplit, urlunsplit

__all__ = ["Link", "extract_links"]

DEFAULT_REFERENCES_HEADING_PATTERN = re.compile(
    r"(?im)(?:^\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:references|bibliography)(?:\*\*|__)?\s*$"
    r"|<h[1-6][^>]*>\s*(?:references|bibliography)\s*</h[1-6]>)"
)
URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
ARTIFACT = r"\b(?:code|weights?|checkpoints?|model cards?|pretrained models?|demo)\b"
RELEASED = r"\b(?:available|released?|open[ -]sourced?)\b"
AVAILABLE = re.compile(rf"(?i){ARTIFACT}.{{0,100}}{RELEASED}|{RELEASED}.{{0,100}}{ARTIFACT}")


HostKind = Literal["github", "huggingface", "modelscope", "project_page", "demo", "arxiv", "other"]


class Link(TypedDict):
    url: str
    host_kind: HostKind
    position: Literal["front", "body", "references"]
    context: str
    self_likely: bool


def extract_links(
    text: str,
    *,
    references_heading_pattern: Pattern[str] | str = DEFAULT_REFERENCES_HEADING_PATTERN,
) -> list[Link]:
    """Extract and classify HTTP links without fetching them.

    Args:
        text: Plain text, Markdown, or HTML containing links.
        references_heading_pattern: Pattern locating the References section.

    Returns:
        Deduplicated links in document order with positional evidence.

    Raises:
        TypeError: If text is not a string.
    """
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    heading = (
        re.compile(references_heading_pattern)
        if isinstance(references_heading_pattern, str)
        else references_heading_pattern
    )
    reference_match = heading.search(text)
    reference_start = reference_match.start() if reference_match else len(text) + 1
    links: list[Link] = []
    seen: set[str] = set()
    for match in URL.finditer(text):
        url = _normalize_url(match.group())
        if not url or url in seen:
            continue
        seen.add(url)
        position = "references" if match.start() >= reference_start else "front" if match.start() < 4_000 else "body"
        context = " ".join(text[max(0, match.start() - 120):match.end() + 120].split())
        links.append({
            "url": url,
            "host_kind": _host_kind(url, context),
            "position": position,
            "context": context,
            "self_likely": position != "references" and (
                position == "front" or bool(AVAILABLE.search(_sentence(text, match.start(), match.end())))
            ),
        })
    return links


def _sentence(text: str, start: int, end: int) -> str:
    left = max(text.rfind(mark, 0, start) for mark in ".!?\n") + 1
    boundaries = [position for mark in ".!?\n" if (position := text.find(mark, end)) >= 0]
    right = min(boundaries) + 1 if boundaries else len(text)
    return text[left:right]


def _normalize_url(value: str) -> str:
    value = value.rstrip(".,;:!?)]}>")
    try:
        parsed = urlsplit(value)
    except ValueError:
        # PDF conversion sometimes glues brackets onto a URL; skip it rather than abort the whole extraction.
        return ""
    if not parsed.netloc:
        return ""
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, parsed.query, ""))


def _host_kind(url: str, context: str) -> HostKind:
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    if host == "github.com" or host.endswith(".github.com"):
        return "github"
    if host in {"huggingface.co", "hf.co"} or host.endswith(".huggingface.co"):
        return "huggingface"
    if host == "modelscope.cn" or host.endswith(".modelscope.cn"):
        return "modelscope"
    if host == "arxiv.org" or host.endswith(".arxiv.org"):
        return "arxiv"
    if re.search(r"(?i)\bdemo\b", context):
        return "demo"
    if re.search(r"(?i)\b(?:project(?: page)?|homepage|website)\b", context):
        return "project_page"
    return "other"
