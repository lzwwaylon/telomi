---
name: wiki
description: Explore object and concept summaries, expand their section and relationship indexes, then search and read complete passages for Topic navigation in IPython.
---

# Wiki

The `wiki` Python module is already available in IPython. Calls are synchronous and return Python values that persist when assigned to variables.

Start from the object and concept titles/descriptions already in the task. Either kind is a valid entry point, including when no concepts exist. `overview(ref: str) -> dict` expands one real P reference into its section headings and recorded relationships, without returning body text or granting reading receipts.

```python
overview = wiki.overview("P1")  # choose an actual reference from the task catalog
print(overview)
hits = wiki.search(terms=["first phrase", "alternative phrase"], mode="any")
print({key: hits[key] for key in ("total", "next_offset")})
for match in hits["matches"]:
    print(match["section_ref"], match["page_ref"], match["heading"])
section = wiki.read("S1")  # use a reference returned by the actual catalog or search
print(section)
```

`overview` returns `page_ref`, `kind`, `title`, `description`, `sections` and `relations`. Each section has `section_ref` and `heading`. Each relation preserves its original `from`, `to` and `label`, shows whether it is incoming or outgoing for this page, and provides the counterpart page's reference, type, title and description. Follow a useful counterpart with another overview, or select it directly from the initial catalog. An empty relation list is only the current recorded graph. Relationships provide discovery paths, not automatic Topic membership or proof that every chapter is relevant.

The same metadata is available at `../input/indexes/Pn.json` for filesystem lookup. Prefer per-page indexes to printing the complete sections.md. Use search when summaries and indexes leave a concrete uncertainty, and keep complete results in variables.

Use exactly one of `query="exact phrase"` or `terms=["phrase one", "phrase two"]`. A query is one contiguous phrase: spaces do not mean OR. Each term is also a phrase; `mode="any"` finds alternatives, while `mode="all"` requires every term. Matching uses NFKC normalization and lowercasing. Keep supported names and multiword names together; do not split them merely to obtain hits. At most 12 terms, 200 characters per phrase.

Search covers page titles, descriptions, section headings, bodies and source titles. Optional `scope="body"` avoids metadata-only matches; `kind="entity"` or `kind="concept"` and `page_ref="P1"` restrict candidates. Filters narrow scope, so an empty result does not prove absence from the whole Wiki. Determine which page kinds exist from the catalog before searching.

Results contain `total`, `offset`, `limit`, `next_offset` and `matches`. Each match has `section_ref`, `page_ref`, `title`, `heading`, `matched_fields`, `matched_terms` and a bounded `snippet`. Default limit is 12, maximum 40. Ordering follows the section catalog, not a relevance score. If `next_offset` is not `None`, continue with the same query and that offset, or narrow the query; do not treat the first page as exhaustive.

Keep full results in variables and deduplicate by section_ref across searches. Display a compact candidate table using section_ref, page_ref and heading; the injected catalog already supplies titles and descriptions. For uncertain candidates, display their matched_fields, matched_terms and snippet before selecting complete sections. A source/title match can return several sections of a page; the relevant body establishes the claim.

Batch independent searches in one cell. When the remaining pages of a query are already needed, collect them with next_offset in the same cell, deduplicate, and display one compact table. Refine an overly broad query when its candidates do not address the Topic, rather than repeatedly printing all metadata and snippets. Keep total and next_offset visible so pagination is never mistaken for exhaustive coverage. Search results are discovery aids, not complete reading receipts. Before declaring a gap, check useful alternatives and uninspected relevant candidates.

The task already includes the complete brief page catalog and output contract; index.md repeats it. Page indexes can also be read in IPython with Path.read_text(). Use wiki.read only with catalog P/S references; a filesystem path is not a Wiki reference. Keep selected texts in a dictionary keyed by S reference and print each complete selected section once, in manageable batches. Reopen content when it is no longer visible or a specific unresolved question requires it. Compact projection applies to discovery results, not to evidence-bearing section text.

`read(ref: str) -> str` returns complete P page or S section text. Standalone N Cue content is not available in Topic navigation. Oversized pages return instructions to read their sections. Unknown references raise an error.

Keep intermediate results in variables. Print every selected complete section before linking it: assignment alone does not deliver text to the model. Runtime verifies actual visible text and resolves the task-local aliases. Write the existing result.json contract, check the selected references and required keys in Python, and submit with submit_note_first. Report a compact check summary; reprint the full result only when a specific error requires inspection.
