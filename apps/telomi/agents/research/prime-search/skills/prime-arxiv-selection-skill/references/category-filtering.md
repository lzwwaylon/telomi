# Category filtering

Use this path when the assignment concerns a research area represented by arXiv subject categories. Categories are a
high-recall domain boundary, not a relevance judgment.

## Resolve categories

Start from the category set supplied by domain knowledge or the assignment, then call
`discover_papers()` directly. It verifies every proposed ID against the current official taxonomy before searching.
Remembered category IDs are proposals, not evidence, so do not claim a category meaning without its returned paper
metadata.

When an ID is uncertain or validation rejects it, use one targeted taxonomy lookup with domain concepts. Inspect the
returned official labels and descriptions, choose the categories that represent the assigned domain, then retry discovery:

```python
matches = arxiv.categories(search=domain_concepts, max_results=10)
print([(row["category_id"], row["category_label"], row["description"]) for row in matches])
```

A paper may have a primary category and cross-list categories. A `cat:` query matches either. Use
`metadata["primary_category"]` after retrieval only when the assignment explicitly requires primary-category papers.

## Search within the category boundary

Pass the selected category IDs and one flat list of equivalent research-object `concepts` to `discover_papers()`.
Concepts are matched with OR. Keep compound concepts intact; do not split a specific concept into common component
words that match a much broader literature.

Keep priorities, comparison dimensions, and preferred examples out of `concepts`. Judge them from each returned title
and abstract during review. Do not use nested concept lists. Pass assigned dates in `YYYY-MM-DD` form without compacting
them:

Before calling the Tool, check every proposed concept: it must name the research object being generated or transformed,
not how it is modeled, which language it supports, a desired capability, quality, latency, organization type, or an
evaluation dimension. Remove dimension-only terms from `concepts`; assess them from returned abstracts or with a
fielded supplemental search after the category pool is complete.

```python
discovery = arxiv.discover_papers(
    selected_category_ids,
    research_object_terms,
    start_date=start_date,
    end_date=end_date,
)
```

`discover_papers()` builds a bounded pool by interleaving Provider-native results across calendar months and pages it
with an opaque cursor. This prevents a busy or recent month from hiding the rest of the assigned interval.
The first call builds and caches that pool in the worker session. Later cursor calls only return the next cached slice;
they do not repeat taxonomy validation or monthly Provider queries.
Inspect `lane_counts` first. Read every returned record from its ID, title, publication date, abstract, and
`discovery_lanes` before requesting another page. After the pool is complete, call `paper_profile(depth="metadata")`
for every pool record and apply the assignment's research themes semantically. Regex and keyword matches are not
relevance evidence and must not decide inclusion or exclusion. The complete discovery pool is not the final Candidate
Ledger. Do not construct a hand-written list of target titles or IDs, or choose representatives.

Follow the exact opaque `next_cursor` until it is null. `unique_count` is the complete pool, while
`returned_count` is only the current page. Each record's `discovery_lanes` preserves its calendar-month relevance rank.
Recency is a review signal, not proof of quality. Serialize retained records only after the final page has been reviewed.
`saturated_lanes` contains only months whose lane hit the lane limit; `failed_lanes` lists months whose Provider
request failed and are therefore absent from the pool, and `uncovered_ranges` lists the date ranges they leave out.
Once arXiv is unavailable to this Provider Child, the remaining months are not requested: report `uncovered_ranges` as
a coverage gap instead of retrying. When no month is covered, discovery raises `source_unavailable`, which is not an
empty result. When either list is non-empty or `guidance` is returned, finish the current cursor, then follow the
returned guidance before finalizing candidates.
While `next_cursor` is non-null, the tool rejects native search with the cursor needed to resume. Finish the active
discovery instead of bypassing unread pages with supplemental queries.

After category review, read [Native search](native-search.md) when a supplemental search is needed for papers
that may be classified outside the selected categories.
