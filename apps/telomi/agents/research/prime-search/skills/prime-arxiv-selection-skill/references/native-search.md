# Native search

Use this path for named concepts, authors, exact phrases, or a cross-category supplement after category filtering.

If an active `discover_papers()` run has a non-null `next_cursor`, finish it with the exact cursor until
`next_cursor` is null before calling `search()`. The Provider rejects native search while discovery pagination remains
active so that coverage cannot be silently abandoned.

Construct native expressions with the fields that carry the intended evidence:

- `ti:` for title phrases;
- `abs:` for abstract concepts;
- `au:` for named authors;
- `cat:` for an already resolved subject category;
- `submittedDate:` for the assigned interval.

Combine expressions with `AND`, `OR`, `ANDNOT`, and parentheses. Use complementary expressions derived from
the assignment over many minor wording variants. Search title and abstract rather than `all:` unless comments and
journal references are genuinely part of the evidence need.

For a supplemental cross-category search, reuse only the central task concepts needed to catch misclassified papers and
exclude the selected category boundary with `ANDNOT` when practical. `search()` returns one page of 50 results per
expression unless an explicit larger `limit` is passed, so keep each supplemental expression specific enough that its
relevant matches fit that page; a single generic phrase across the whole interval is not a supplement. Pass a larger
`limit` only when the assignment explicitly requires exhaustive coverage. Do not repeat the full category result
through narrower keyword variants or invent target paper names. Merge duplicates by arXiv work identifier and preserve each real query that discovered a retained paper. Review
the merged records with `paper_profile(depth="metadata")`; query keywords are discovery inputs, not relevance evidence.

For bounded dates, keep the date constraint in every expression. If a query fills its page with mostly irrelevant
records, tighten field grouping, add the applicable subject boundary, or split the interval into non-overlapping ranges
instead of raising the limit.
