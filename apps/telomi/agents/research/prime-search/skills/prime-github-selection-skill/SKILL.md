---
name: prime-github-selection-skill
description: Discover and acquire GitHub evidence for a Prime Search child explicitly assigned Provider 'github'; do not use for Root coordination or another Provider.
---

# GitHub Provider

Use the Python-backed Skill directly:

```python
import prime_github_selection_skill as github

rows = github.discover_repositories(
    "exact-topic-name",
    start_date="assignment-start-date",
    end_date="assignment-end-date",
)
```

Do not enumerate the module, inspect its source, or read the complete API reference. Use
`help(github.<chosen_operation>)` only when the selected operation's signature is unclear. Read
`references/API.md` only for an advanced operation not covered here.

## Discover repositories

- Exact repository named by the assignment or a returned record: use `get_repository()`.
- Topic discovery: use `search_topics()` to resolve exact GitHub topic names (community topics such as
  `text-to-speech` count; the curated flag is informational), then use
  `discover_repositories()` with those topics and the assignment's date bounds as the primary path.
- Supplement the pooled discovery only when needed with `search_repositories()` and structured `topics`, `language`,
  `min_stars`, creation dates, activity date, and sort filters.
- Use a free-text repository query only as a last resort, with one to three discriminative terms. GitHub ANDs
  whitespace-separated terms; topics are the reliable filter.
- Exhaustive inventory: broaden or paginate only when the assignment explicitly asks for all matching repositories.
- Bounded temporal evidence: discover repositories first, then resolve release or substantive-update timing from
  Provider-returned releases, tags, and repository metadata. GitHub `pushed` and `updated_at` are not release dates.

Follow organization, repository, and exact-name leads only when they came from the assignment or a Provider record.
Do not use Issue or code search for repository discovery or release-date verification unless the assignment asks for
Issue or code evidence.

## Preserve the decision trail

Maintain one candidate map keyed by `OWNER/REPO`. Preserve the first discovery query and merge later query provenance.
Do not repeat the same query or exact repository lookup. For a bounded temporal assignment, record the returned release
evidence or explicit timing uncertainty in candidate metadata. Keep every relevant unique repository that satisfies the
assigned scope; the Ledger is the final retention decision, and the Organizer later merges cross-Provider duplicates.

Use the shared builder instead of hand-writing Ledger assembly:

```python
ledger = github.CandidateLedger()
ledger.add(
    title=title,
    url=url,
    query=discovery_query,
    summary=grounded_summary,
    metadata=provider_metadata,
    materials=clone_result,
)
ledger.write("work/github_candidates.json")
```

Call `clone_repository()` once for each retained repository and pass its returned record directly as `materials`.
Do not extract, copy, rename, or provide paths from the acquired repository. Represent one repository as one candidate
and preserve its pinned revision in metadata.
