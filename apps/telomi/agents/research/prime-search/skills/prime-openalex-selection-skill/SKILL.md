---
name: prime-openalex-selection-skill
description: Use native OpenAlex Topics and publication-date cursor discovery, exact ID/DOI lookup, and retained Provider metadata or cached PDFs for an assigned scholarly evidence need.
---

# OpenAlex

OpenAlex operations and `research_runtime.read_skill` are synchronous: call them without `await`.

Use `import prime_openalex_selection_skill as openalex` and `import research_runtime`. `work_info`, `native_query`, `topics`,
and `download_pdf` return lists of record dictionaries. Check for an empty list before using `rows[0]`.
`discover_papers` returns a discovery dictionary with `records` and cursor fields. Use dictionary access on records.
Runtime owns network access, credentials, free-allowance admission, caching and retries.

## Discover, screen, retain

1. Read [Topic filtering](references/topic-filtering.md) for broad or date-bounded discovery. Select Topic IDs using native
   labels, descriptions and hierarchy. Use `discover_papers()` as the main recall path; use `native_query(search=...)` only to
   supplement uncovered concepts or unclassified works. An exact supplied W ID or DOI goes directly to `work_info()`.
2. Review every retrieved title and abstract semantically against the assignment. Topic matches are predicted labels,
   not verified relevance. Preserve native queries, IDs, Topic labels, publication dates and partial paging boundaries.
3. Use `work_info()` for shortlisted records when affiliations, DOI, locations, content availability or complete native
   metadata are needed. Publication date is not an arXiv submission date, model release date or major-update date.
4. When the Evidence Need requires paper-body claims, use `download_pdf(identifier)` only for selected records. It retains
   the actual OpenAlex cached PDF and converted Markdown. If downloading requires an unavailable key, no cached PDF
   exists or Runtime stops acquisition, preserve the exact diagnostic and full-text gap. Use already acquired native
   records for metadata evidence; ask Root for another acquisition task when paper-body evidence is still required.
5. Retain actual Provider records in `openalex.CandidateLedger()` as metadata Sources when bibliographic or abstract evidence is
   useful. Pass the unchanged Tool record in `materials=[paper]`; the Ledger builder preserves its bytes. Explicitly label
   the candidate `evidence_kind="provider_metadata"` and `full_text_acquired=False`. Metadata supports only its actual
   fields: do not claim it establishes paper-body findings, implementation details or access to the full paper.
   For a successful PDF download use `materials=[downloaded_record]` and label the evidence accordingly. Preserve discovery
   queries separately because download metadata describes acquisition, not discovery. Write the final Ledger to
   `work/openalex_candidates.json` and use `submit_candidate_ledger(provider_id="openalex")` when the assigned work is complete.

For a successfully acquired PDF:

```python
ledger = openalex.CandidateLedger()
ledger.add(title=paper["title"], url=paper["url"], query=discovery_query,
           summary=paper["snippet"],
           metadata={**paper["metadata"], "discovery_queries": discovery_queries,
                     "evidence_kind": "primary_document", "full_text_acquired": True},
           materials=[downloaded_record])
```

For a metadata-only Source, use this alternative with the original `work_info()` or discovery Tool record rather than inventing a paper body:

```python
ledger.add(title=paper["title"], url=paper["url"], query=discovery_query,
           summary=paper["snippet"] or "OpenAlex bibliographic metadata; full text not acquired.",
           metadata={**paper["metadata"], "evidence_kind": "provider_metadata", "full_text_acquired": False},
           materials=[paper])
```

Use `help(openalex.<operation>)` for signatures. Root owns task creation and Provider selection. Keep the assigned
Evidence Need, dates and discovery identifiers intact. On a rejected Candidate Ledger, correct the same
`work/openalex_candidates.json` from the precise diagnostic and submit again. After a successful submission, report
acquired material and remaining gaps to Root.

## Stop and hand off

`discover_papers()` preserves completed pages if Runtime returns `source_unavailable`, `provider_credentials`, or
`provider_daily_budget_exhausted`. On `source_unavailable: true`, stop this Provider, submit completed material or an empty
Ledger, and reply starting `source_unavailable provider=openalex`. Include the exact error code/details, remaining
Evidence Need, date range and cursor. A partial pool never establishes full date coverage.

For raised errors, preserve `code`, `failure_class`, `retryable`, `retry_after_ms` and `details`; use the actions in
[Failure handling](references/failures.md). Runtime has already applied its retry policy. The Agent does not repeat failed
queries under new wording, rotate credentials, purchase credit, or wait indefinitely. Submit usable completed material
before reporting the remaining gap. An empty successful page is a search outcome, not a Provider failure.
