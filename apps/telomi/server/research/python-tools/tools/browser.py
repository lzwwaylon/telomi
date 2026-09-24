"""Python API for the Runtime-owned Browser Provider.

The Browser child never drives a browser itself. Every call goes through the per-run Runtime
bridge (``research_runtime``), which runs the command in this execution's own agent-browser
session, keeps the pool and lifecycle, and writes retained material into the workspace.
"""

from __future__ import annotations

from typing import Any

import research_runtime
from research_runtime import BrowserStep, ResearchRuntimeError, read_skill

__all__ = [
    "BrowserStep",
    "ResearchRuntimeError",
    "back",
    "click",
    "fill",
    "find",
    "get",
    "help",
    "materialize",
    "materialize_element",
    "materialize_page",
    "materialize_url",
    "open",
    "press",
    "program",
    "read",
    "read_skill",
    "run",
    "scroll",
    "select",
    "snapshot",
    "wait",
]


def run(*args: str) -> BrowserStep:
    """Run one agent-browser command verbatim, e.g. ``run("get", "attr", "@e3", "href")``.

    Raises ``ResearchRuntimeError`` when the command exits non-zero; a malformed command's
    error carries its usage line.
    """
    return research_runtime.browser(*args)


def program(commands: list[list[str]]) -> list[BrowserStep]:
    """Run up to 32 commands in order; stops at the first failure and returns every executed step."""
    return research_runtime.browser_program(commands)


def open(url: str) -> str:  # noqa: A001 - mirrors the agent-browser command name
    """Navigate this session to an HTTP(S) URL and return the command output."""
    return run("open", url)["output"]


def read(url: str | None = None) -> str:
    """Agent-readable text of the current page, or of ``url`` after navigating to it."""
    return run("read", *([url] if url else []))["output"]


def snapshot(*, interactive: bool = True, urls: bool = False, compact: bool = False,
             depth: int | None = None, selector: str | None = None) -> str:
    """Accessibility-tree snapshot with ``@eN`` refs. Refs go stale on every page change."""
    args = ["snapshot"]
    if interactive:
        args.append("-i")
    if urls:
        args.append("-u")
    if compact:
        args.append("-c")
    if depth is not None:
        args += ["-d", str(depth)]
    if selector:
        args += ["-s", selector]
    return run(*args)["output"]


def get(what: str, *args: str) -> str:
    """``get("title")``, ``get("url")``, ``get("text", "@e3")``, ``get("attr", "@e3", "href")`` and friends."""
    return run("get", what, *args)["output"].strip()


def click(selector: str, *, new_tab: bool = False) -> str:
    """Click an element or ``@ref``. Re-snapshot afterwards before using refs again."""
    return run("click", selector, *(["--new-tab"] if new_tab else []))["output"]


def find(locator: str, value: str, action: str, text: str | None = None) -> str:
    """``find("text", "Next", "click")``: locate by role/text/label/placeholder/... and act."""
    return run("find", locator, value, action, *([text] if text is not None else []))["output"]


def fill(selector: str, text: str) -> str:
    """Clear and fill an input. Do not submit forms that post content to a website."""
    return run("fill", selector, text)["output"]


def select(selector: str, *values: str) -> str:
    """Select dropdown option(s)."""
    return run("select", selector, *values)["output"]


def press(key: str) -> str:
    """Press a key, e.g. ``press("Enter")``."""
    return run("press", key)["output"]


def scroll(direction: str, px: int | None = None, *, selector: str | None = None) -> str:
    """Scroll up/down/left/right by ``px`` pixels, optionally inside ``selector``."""
    args = ["scroll", direction]
    if px is not None:
        args.append(str(px))
    if selector:
        args += ["-s", selector]
    return run(*args)["output"]


def wait(target: str | int, *, kind: str | None = None) -> str:
    """``wait(1500)``, ``wait("@e3")``, ``wait("https://…", kind="url")``, ``wait("networkidle", kind="load")``."""
    if kind is None:
        return run("wait", str(target))["output"]
    if kind not in {"url", "text", "load"}:
        raise ValueError("kind must be url, text, or load")
    return run("wait", f"--{kind}", str(target))["output"]


def back() -> str:
    """Go back one page."""
    return run("back")["output"]


def help() -> str:  # noqa: A001 - the command list the Runtime answers with
    """The Runtime's Browser command list, including what is blocked and why."""
    return run("help")["output"]


def materialize(source: dict[str, Any], *, title: str | None = None) -> dict[str, Any]:
    """Retain Browser evidence as converted local material; pass the result to ``CandidateLedger.add``."""
    return research_runtime.materialize_source(source, title=title)


def materialize_page(*, title: str | None = None) -> dict[str, Any]:
    """Retain the current rendered page."""
    return materialize({"kind": "current_page"}, title=title)


def materialize_element(ref: str, *, title: str | None = None) -> dict[str, Any]:
    """Retain the attachment behind a current snapshot ref (``@eN``)."""
    return materialize({"kind": "element", "ref": ref}, title=title)


def materialize_url(url: str, *, title: str | None = None) -> dict[str, Any]:
    """Retain a public direct HTTP(S) file observed within the assigned scope."""
    return materialize({"kind": "url", "url": url}, title=title)
