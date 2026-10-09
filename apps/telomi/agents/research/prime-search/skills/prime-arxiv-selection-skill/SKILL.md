---
name: prime-arxiv-selection-skill
description: Use arXiv subject categories, native fielded search, exact paper lookup, and CandidateLedger for an assigned arXiv research task.
---

# arXiv

Use `import prime_arxiv_selection_skill as arxiv`. The module exposes the arXiv Provider operations and the shared
`CandidateLedger`.

Provider query, `fetch_ids()`, `paper_profile()`, `download_pdf()` and `categories()` return lists of ordinary
dictionaries; `discover_papers()` returns a dictionary with one page of `records` and its `listing`. Read fields with `row["field"]` or
`row.get("field")`, never attribute access such as `row.field`. These Provider and Ledger helpers are synchronous
Python calls. Do not `await` them.

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

## Coverage: discovery, your judgment, then the Ledger

For coverage (a research area, a kind of work, a time-bounded landscape, or everything arXiv holds about something
named), discover the papers with one call, judge them, then download and submit what you keep.

```python
found = arxiv.discover_papers(
    selected_category_ids, research_object_terms,  # the research area: see Category filtering
    queries=native_expressions,                    # named entities, methods or terms, including the task's leads: see Native search
    start_date=start_date, end_date=end_date,
)
print(found["listing"])
records = list(found["records"])
```

Define the pool from the assignment:

- A research area, a kind of work or a time-bounded landscape is a category: pass category IDs with research-object
  concepts and the assigned dates. `queries` add named entities, methods or terms the categories may miss, such as the
  task's leads; they never replace the categories.
- A task about something named (an entity, project, product, method or term) is defined by `queries` alone.
- The lanes are merged by arXiv work, and a later version of a pooled paper is the same record.
- Pass the assigned dates as they are: one call enumerates the most recent 36 calendar months of a longer range and
  names the earlier part as uncovered.

`discover_papers()` excludes a record published outside the assigned dates and orders the pool so that the
best-ranked results of every calendar month and of every search expression come first, newer first within a rank. In
that order the records go through one screen in a fresh model context, which reads the task Root wrote for you and
each paper's title and whole abstract and removes only what that text shows to be off the subject of the task.
Nothing is downloaded and nothing is submitted.

The first line of `listing` says how many papers the pool holds, what the date exclusion removed and how far the
screen has read; a line after it names any `uncovered_ranges` or failed lanes; each further line is one paper the
screen kept, numbered by its position in the pool, with its exact version identifier, publication date and title. A
call screens one page of the pool, so a pool longer than a page ends its listing with a notice of where the page sits,
for example `[Showing the papers kept from pool records 1-40 of 422. Use offset=41 to continue.]`. A page fits
one cell: print it whole and read every line before you choose. `found["records"]` holds the page's papers; each
carries `arxiv_id`, the version `download_pdf()` takes.

Whether to read further pages is yours to decide from what the task asks and what the page shows. To continue, call
it again with the same arguments and the offset the notice names; the pool is cached, so only the screen runs:

```python
found = arxiv.discover_papers(selected_category_ids, research_object_terms, queries=native_expressions,
                              start_date=start_date, end_date=end_date, offset=found["next_offset"])
print(found["listing"])
records += found["records"]
```

`next_offset` is null on the last page. Judge the records against the task:

- Drop a record only when its own facts show it is outside what the task asks: another kind of work than the task
  wants, outside the time range the task gives, or under an exclusion the task states. Not knowing a paper or its
  authors is not a reason to drop it. When a title does not settle it, read the abstract with
  `paper_profile()` for that record instead of guessing.
- The task's leads are not the answer. A result that keeps only the lead names has not covered the task.
- How far you read and how many you keep is yours to decide from the task; there is no fixed ceiling. Each paper you
  keep is a download and a conversion the later stages read. When you keep fewer than qualify, follow the preference
  the task states; without one, prefer the papers that most directly answer the task's Evidence Need and, among
  those, the newer ones.

Building the pool takes minutes. Call `discover_papers()` with other arguments only when the listing shows the call
missed the task: a wrong category, or a group of work the task names that is absent. Another definition is another
pool, built and screened from its start.

Then download and submit like any other task. Wrap each download so one failure does not lose the others:

```python
ledger, failed = arxiv.CandidateLedger(), {}
for record in kept:                         # the records you chose from the pages you read
    try:
        materials = arxiv.download_pdf(record["arxiv_id"])
        if not materials:
            raise RuntimeError("the PDF could not be downloaded or converted")
    except Exception as error:
        failed[record["url"]] = str(error)[:200]
        continue
    ledger.add(title=record["title"], url=record["url"], query=found["query"],
               summary=one_sentence_on_what_it_contributes, metadata=record, materials=materials)
ledger.write("work/arxiv_candidates.json")
import research_runtime
research_runtime.finish(provider_id="arxiv")
```

If `finish` raises a validation error, repair the same file and call `finish` again. When nothing qualifies, write the
empty Ledger and submit it. End with a compact reply: what you retained; what you left out of the pages you read and
why, one line per group; what could not be downloaded; the leads the pool did not contain; how much of the pool you
read; and any `uncovered_ranges` or `failed_lanes` the call reported.

## Exact-object assignments

A task whose Evidence Need Root registered as exact objects names its papers. Call `download_pdf()` with those
identifiers and add each returned record with `CandidateLedger`, as below. When such a task still needs discovery to
resolve what it names, use the funnel in this section; its pool is a source of leads, not a result.

Deduplicate versions by the arXiv work identifier while preserving the exact retained version, authors, abstract,
categories, publication date, URL, and every actual discovery query. Different papers remain separate candidates.

Use this funnel:

1. Read `discover_papers()` page by page, as far into the pool as the assignment needs.
2. Call `paper_profile(arxiv_ids, depth="metadata")` for every pool record you read, passing each record's
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

Build the output with `CandidateLedger()` from the returned download records and save with
`ledger.write("work/arxiv_candidates.json")`. Draft writes are atomic and can be repeated before final
submission. Use that exact filename, including the underscore. Then use `import research_runtime` and call `research_runtime.finish(provider_id="arxiv")`.
Successful submission freezes this task's final Ledger and ends its acquisition; do not query again or rewrite the
submitted result. Ask Root for a new bounded task if new evidence is needed later.

## Provider unavailable

If `discover_papers()` returns `source_unavailable: true`, preserve its records and `uncovered_ranges` and stop
API discovery. Never retry those dates with another query. For a raised `ResearchRuntimeError` with
`code == "source_unavailable"`, read `details["arxiv_access_scope"]`:

- `api`: stop search, exact metadata lookup, and `paper_profile()` (it requires API metadata even at front depth).
  Select retained papers from metadata already acquired and call `download_pdf()` directly with their known exact IDs.
  Keep the original title, dates, authors, metadata, and discovery query when the download record marks
  `arxiv_metadata_incomplete: true`; that record provides material and identity, not replacement bibliographic facts.
- `main`: stop front-matter, category, and PDF acquisition. Preserve papers whose complete material was acquired.
- Missing scope or a provider-wide access denial: stop all arXiv operations.

For a coverage task, `discover_papers()` returns the part of the range discovery reached and reports
`uncovered_ranges`; when it raises `source_unavailable` for the whole range, submit an empty Ledger. For any task, write
and submit the partial Ledger from usable material, or an empty Ledger when no material was acquired.
After submission, make the completion reply start with `source_unavailable provider=arxiv` and include the affected
access domain, uncovered Evidence Need or dates, and partial coverage. Root, not this child, chooses another Provider.
