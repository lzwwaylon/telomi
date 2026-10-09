"""A discovery pool a Provider child reads page by page.

A Provider SDK builds the pool of one discovery call, in order, and opens it here. Records are
excluded by their own fields and Runtime records the pool once. The remaining records are screened
in pool order in fresh model contexts through Runtime, which only removes what is plainly off the
task's subject. The screen runs on demand: a call screens the page of the pool it returns, and
the next offset continues from there. Nothing is acquired or submitted: the child judges the
records it reads, acquires what it keeps and ends with ``CandidateLedger`` and ``finish``.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import research_runtime

from tools import discovery_review

WINDOW_SIZE = 15
PAGE_SIZE = 40
CACHE_LIMIT = 5
# What Runtime records of one pool, in pool order.
AUDIT_RECORDS = 2_000

Render = Callable[[Mapping[str, Any]], dict[str, Any]]
_POOLS: dict[str, Pool] = {}
_ATTEMPTS = 0


def _tally(counts: Mapping[str, int]) -> str:
    return ", ".join(f"{name} {count}" for name, count in sorted(counts.items()))


@dataclass
class Pool:
    """The pool of one discovery call: what its fields excluded, and what the screen has answered so far."""

    provider_id: str
    key: str
    size: int
    survivors: list[Mapping[str, Any]]
    excluded: dict[str, int]
    url_of: Callable[[Mapping[str, Any]], str]
    render: Render | None
    attempt: str | None
    window_size: int = WINDOW_SIZE
    workers: int = 4
    # What the Provider reports beside every page: its provenance string, lane counts, uncovered ranges.
    facts: dict[str, Any] = field(default_factory=dict)
    # The screen's answer per record identity: "keep" or the reason it was removed.
    verdicts: dict[str, str] = field(default_factory=dict)
    windows: int = 0
    unscreened_windows: int = 0
    read: int = 0

    def _screen(self, records: Sequence[Mapping[str, Any]]) -> None:
        """Screen the records the screen has not answered yet, one window per fresh model context."""
        records = [record for record in records if self.url_of(record) not in self.verdicts]
        if not records:
            return
        with ThreadPoolExecutor(max_workers=max(1, self.workers)) as executor:
            rendered = list(executor.map(self.render, records))  # type: ignore[arg-type]
            windows = [rendered[start:start + self.window_size] for start in range(0, len(rendered), self.window_size)]

            def one(numbered: tuple[int, list[dict[str, Any]]]) -> tuple[dict[str, Any], bool]:
                number, shown = numbered
                response = research_runtime.review_window(shown, provider_id=self.provider_id, window_id=f"w{number}", attempt=self.attempt)  # type: ignore[arg-type]
                verdicts = {verdict["id"]: verdict for verdict in response["verdicts"]}
                missing = [entry["id"] for entry in shown if entry["id"] not in verdicts]
                if missing:
                    raise RuntimeError(f"Runtime returned no verdict for {len(missing)} records of window w{number}")
                return verdicts, bool(response.get("failed"))

            answers = list(executor.map(one, enumerate(windows, start=self.windows + 1)))
        verdicts = {key: verdict for answered, _ in answers for key, verdict in answered.items()}
        for record, shown in zip(records, rendered):
            verdict = verdicts[shown["id"]]
            self.verdicts[self.url_of(record)] = "keep" if verdict["verdict"] == "keep" else verdict.get("reason") or "no"
        # The screen only removes: a window whose model call failed comes back kept whole, and says so.
        self.unscreened_windows += sum(failed for _, failed in answers)
        self.windows += len(windows)

    def page(self, offset: int, *, noun: str, line_of: Callable[[Mapping[str, Any]], str], notes: Sequence[str] = ()) -> dict[str, Any]:
        """One page of the pool from position ``offset``: its records the screen kept, with their listing.

        A call screens only its own page of the pool, so what it costs does not depend on how much
        of the pool is off the task. The listing opens with what is known of the pool and, when the
        pool is longer than a page, closes with where the page sits and the offset that continues.
        """
        if not isinstance(offset, int) or isinstance(offset, bool) or not 1 <= offset <= max(1, len(self.survivors)):
            raise ValueError(f"offset must be between 1 and {max(1, len(self.survivors))}, the size of this pool")
        end = min(offset - 1 + PAGE_SIZE, len(self.survivors))
        shown = self.survivors[offset - 1:end]
        if self.render is not None:
            self._screen(shown)
        records = [(position, record) for position, record in enumerate(shown, start=offset) if self.verdicts.get(self.url_of(record), "keep") == "keep"]
        self.read = max(self.read, end)
        discovery_review.mark_served(self.provider_id, self.key, self.read)
        rejected = Counter(verdict for verdict in self.verdicts.values() if verdict != "keep")
        head = f"Pool of {self.size} {noun}."
        if self.excluded:
            head += f" Excluded by their own fields: {_tally(self.excluded)}."
        if self.render is not None:
            head += (f" Screened against the task so far: {len(self.verdicts)} of {len(self.survivors)}, {len(self.verdicts) - sum(rejected.values())} kept"
                     + (f", {_tally(rejected)} removed" if rejected else "")
                     + (f", {self.unscreened_windows} windows could not be screened and were kept whole" if self.unscreened_windows else "") + ".")
        lines = [head, *notes, *(f"{position}. {line_of(record)}" for position, record in records)]
        # The notice a truncated read ends with: where this page sits and how to continue.
        if len(self.survivors) > PAGE_SIZE:
            lines.append(f"\n[Showing the {noun} kept from pool records {offset}-{end} of {len(self.survivors)}."
                         + (f" Use offset={end + 1} to continue.]" if end < len(self.survivors) else "]"))
        return {
            **self.facts, "records": [dict(record) for _, record in records], "listing": "\n".join(lines),
            "next_offset": end + 1 if end < len(self.survivors) else None,
            "pool": self.size, "excluded": dict(self.excluded), "screened": len(self.verdicts), "rejected": dict(rejected),
            "kept": len(self.verdicts) - sum(rejected.values()) if self.render is not None else len(self.survivors),
        }


def cached(provider_id: str, key: str) -> Pool | None:
    """The pool an earlier call of this kernel opened under the same discovery arguments."""
    return _POOLS.get(f"{provider_id}:{key}")


def open_pool(
    provider_id: str,
    key: str,
    records: Sequence[Mapping[str, Any]],
    *,
    definition: Mapping[str, Sequence[str]],
    url_of: Callable[[Mapping[str, Any]], str],
    flags_of: Callable[[Mapping[str, Any]], Mapping[str, bool]],
    render: Render | None = None,
    window_size: int = WINDOW_SIZE,
    workers: int = 4,
    facts: Mapping[str, Any] | None = None,
) -> Pool:
    """Open the pool of one discovery call: exclude by fields and record it with Runtime before anything is screened.

    ``records`` is the pool in the order that decides what a reader meets first. ``render`` shows a
    record to the screen; without it every record its own fields do not exclude is kept. Outside a
    Provider child there is no Runtime record and no screen.
    """
    global _ATTEMPTS
    survivors: list[Mapping[str, Any]] = []
    audit: list[dict[str, Any]] = []
    excluded: Counter[str] = Counter()
    for record in records:
        raised = next((name for name, value in flags_of(record).items() if value), None)
        audit.append({"id": url_of(record), "excluded": raised})
        if raised:
            excluded[raised] += 1
        else:
            survivors.append(record)
    attempt = None
    if research_runtime.execution_id() != "root":
        _ATTEMPTS += 1
        attempt = f"a{_ATTEMPTS}"
        research_runtime.review_pool(audit[:AUDIT_RECORDS], provider_id=provider_id, attempt=attempt,
                                     definition={name: list(definition.get(name) or []) for name in ("category", "queries")})
    screens = render is not None and attempt is not None
    pool = Pool(provider_id, key, len(records), survivors, dict(excluded), url_of, render if screens else None, attempt, window_size, workers,
                dict(facts or {}))
    discovery_review.register_pool(provider_id, key, [url_of(record) for record in survivors])
    if len(_POOLS) >= CACHE_LIMIT:
        _POOLS.pop(next(iter(_POOLS)))
    _POOLS[f"{provider_id}:{key}"] = pool
    return pool


__all__ = ["PAGE_SIZE", "Pool", "cached", "open_pool"]
