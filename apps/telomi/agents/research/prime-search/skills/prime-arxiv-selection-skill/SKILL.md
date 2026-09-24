---
name: prime-arxiv-selection-skill
description: Use arXiv subject categories, native fielded search, exact paper lookup, and CandidateLedger for an assigned arXiv research task.
---

# arXiv

Use `import prime_arxiv_selection_skill as arxiv`. The module exposes the arXiv Provider operations and the shared
`CandidateLedger`.

Every operation returns ordinary dictionaries. Read fields with `row["field"]` or `row.get("field")`, never attribute
access such as `row.field`.

## Choose a path

Read only the path needed for the assignment:

- [Category filtering](references/category-filtering.md): use remembered category IDs with `discover_papers()` for broad
  or time-bounded discovery; use `categories()` only when those IDs are uncertain or rejected.
- [Native search](references/native-search.md): use `search()` for named concepts, authors, phrases, or a supplemental
  search for relevant papers classified outside the main subject categories.

Use category filtering as the primary recall path when it fits the domain. Native keyword search may supplement that
path, but must not replace it merely because keywords are easier to write. If the assignment names an exact paper or a
returned record supplies its identifier, use `fetch_ids()` directly.

Use `help(arxiv.<operation>)` when a chosen operation's signature is unclear. Do not enumerate the module or inspect its
source. Read `references/API.md` only for an advanced operation not covered by the selected path.

## Resolve and write

Deduplicate versions by the arXiv work identifier while preserving the exact retained version, authors, abstract,
categories, publication date, URL, and every actual discovery query. Different papers remain separate candidates.

Use this funnel:

1. Complete `discover_papers()` and its cursor for the discovery pool.
2. Call `paper_profile(arxiv_ids, depth="metadata")` for every pool record, passing each record's
   `metadata["arxiv_id"]` (never the Provider record `id`). The profile is compact by default: identity, dates,
   categories, the author comment and its links, and the journal reference. Discovery records already carry the
   abstract; add `fields=["abstract", "authors"]` only when reviewing records you do not have at hand. Group the
   profiles by the assignment's research themes and review title, abstract, categories, dates, comment links, and
   report status semantically.
3. Call `paper_profile(arxiv_ids, depth="front")` for the candidates being considered. Use its affiliations,
   `team_name`, email domains, and the paper's own front-matter links to confirm publisher and artifact claims. When the
   assignment needs statements from the front matter, pass `statement_patterns`: the presets are `artifact_release`
   (code, weights, checkpoints, model cards), `dataset_release`, and `demo`; any other value is your own regular
   expression, which the Tool applies sentence by sentence. Links found only in References belong to cited work, not
   to the paper being profiled; `fields=["all_links"]` returns every pre-bibliography link when needed.
4. Retain papers according to the assignment's research themes. Record the evidence the assignment asks for under the
   keys it names, graded `confirmed`, `unconfirmed`, or `missing`, with the profile fields as the evidence. No such
   grade is an exclusion criterion. Do not judge claims by grepping full text; use the `paper_profile()` fields.
5. Call `download_pdf()` only for retained records, using their exact version IDs. Pass each returned record directly as
   that candidate's `materials`. A paper whose download fails is omitted from the result and listed by
   `download_failures()`; a front profile whose HTML request failed carries `front_source: "error"` and `front_error`. The operation preserves the PDF and returns Document Convert Markdown with its declared
   image assets. Do not serialize search-result metadata JSON as a substitute for the paper document.

Preserve each retained record's discovery query before calling `download_pdf()`. The downloaded record supplies the
material, while query provenance comes from its matching discovery or native-search record; do not assume the download
metadata repeats the original query shape.

Do not inspect another Provider's Ledger, materials, or work files for examples or schema guidance.

The exact method signature is:

```python
CandidateLedger.add(self, *, title: str, url: str, query: str, summary: str,
                    metadata: dict[str, Any],
                    materials: Sequence[Mapping[str, Any]]) -> None
```

Example:

```python
ledger.add(
    title=profile["title"],
    url=paper["url"],
    query=discovery_query,
    summary=profile["abstract"],
    metadata={
        **profile,
        "discovery_queries": discovery_queries,
        # one entry per evidence item the assignment names, for example:
        "<assignment evidence key>": {"grade": "unconfirmed", "evidence": profile["affiliations"]},
    },
    materials=[downloaded_record],
)
```

Build the output with `CandidateLedger()` from the returned download records, then call
`ledger.write("work/arxiv_candidates.json")` exactly once as the final tool call.
Do not inspect, repair, or rewrite the Ledger afterward.

## Provider unavailable

If `discover_papers()` returns `source_unavailable: true`, stop all arXiv operations, retain only completed candidates,
and report its `uncovered_ranges`; never retry those dates with a different query. If any completed candidate has usable
material, write and submit that partial Ledger. If none does, write and submit an empty Ledger. If an operation raises
`ResearchRuntimeError` with `code == "source_unavailable"`, do the same with an empty Ledger and the error details.
After submission, make the completion reply start with `source_unavailable provider=arxiv` and include the uncovered
Evidence Need or dates plus any partial coverage. Root, not this child, chooses another Provider.
