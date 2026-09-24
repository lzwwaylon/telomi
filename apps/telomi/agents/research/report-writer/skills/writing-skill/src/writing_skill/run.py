"""Prime Agent 原生入口。

Prime 的 Python-backed skill 约定是：模块暴露 `run()` 就被包成异步可调用，
在 IPython 里直接 `await writing_skill("draft.md")`；同名 console script 走
`rlm.skill:cli`，它也是找 `run()`。上游只提供 argparse CLI（脚本名
`external-prose-lint`，与 import 名不符），所以这里补一个 run() 把同一份扫描
接到原生调用面上。扫描逻辑仍然全部来自上游的 scanner/formatter，本文件不判断文风。
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from writing_skill.formatter import format_json, format_text
from writing_skill.scanner import scan_path, scan_text


async def run(
    path: str | None = None,
    *,
    text: str | None = None,
    json: bool = False,
    max_hits: int = 15,
    fail_on: Literal["hard", "any", "never"] = "never",
) -> str:
    """Scan Chinese Markdown for mechanical prose hygiene signals and return the report.

    Pass `path` for a file or `text` for an in-memory draft. `fail_on` decides when to raise:
    "never" (default) just returns the report, "hard" raises on hard findings, "any" on any
    finding. The report names the skill rule behind every finding; it does not judge taste.
    """
    if (path is None) == (text is None):
        raise ValueError("pass exactly one of path or text")
    report = scan_text(text, "<text>") if text is not None else scan_path(Path(path))
    rendered = format_json(report) if json else format_text(report, max_hits=max_hits)
    if fail_on == "any" and report.finding_count > 0:
        raise RuntimeError(f"{report.finding_count} prose findings\n{rendered}")
    if fail_on == "hard" and report.hard_finding_count > 0:
        raise RuntimeError(f"{report.hard_finding_count} hard prose findings\n{rendered}")
    return rendered
