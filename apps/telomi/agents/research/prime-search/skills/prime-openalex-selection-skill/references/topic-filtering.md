# Native Topic filtering

Use `topics(search="speech")` to find native labels; read each description and hierarchy before selecting IDs.
Use `topic_info("T...")` for the full description and sibling Topics. Select siblings by meaning rather than requiring
one keyword in every label. Topics are inferred; the default `topics.id` path includes secondary Topics, whereas
`topic_match="primary"` excludes them. Record this choice because it changes recall.

```python
pool = openalex.discover_papers(
    selected_topic_ids, start_date="2026-01-01", end_date="2026-09-25", limit=300,
)
records = pool["records"]
```

Choose dates from the actual assignment. The example dates do not apply to other tasks.
`complete` declares whether this query reached its terminal cursor. If `complete` is false and the assignment requires
more coverage, continue with `cursor=pool["next_cursor"]`; preserve the query and every completed slice. If the source is
unavailable, hand off the remaining cursor/date need instead. The bounded slice limit is not the corpus size.

Topic metadata pages expose `metadata["openalex_page"]["next_cursor"]`; continue `topics(cursor=...)` only if the label
catalog is still insufficient. For works, `native_query()` exposes native filter/search/sort/cursor. Topic IDs are ORed;
dates and other filters are ANDed. Keep query syntax native to OpenAlex.

Review title, abstract, authors and Topics semantically; then inspect exact work profiles and retain selected PDFs.
OpenAlex dates describe indexed publication metadata. Cross-source release/version claims need separate verification.
Index latency and unclassified works remain coverage limitations; use supplemental search or request another Provider
when these limitations affect the Evidence Need.

Official mechanics: [Topics](https://help.openalex.org/data/topics/),
[filtering](https://help.openalex.org/api/filtering/), [cursor paging](https://help.openalex.org/api/paging/).
