---
name: prime-github-selection-skill
description: Discover and acquire GitHub evidence for a Prime Search child explicitly assigned Provider 'github'; do not use for Root coordination or another Provider.
---

# GitHub Provider

Use the Python-backed Skill directly:

```python
import prime_github_selection_skill as github

found = github.discover_repositories(
    "exact-topic-name",
    start_date="assignment-start-date",
    end_date="assignment-end-date",
)
```

Do not enumerate the module, inspect its source, or read the complete API reference. Use
`help(github.<chosen_operation>)` only when the selected operation's signature is unclear. Read
`references/API.md` only for an advanced operation not covered here.

## Discover repositories

- Exact repository fixed by the assignment, supplied official link or returned record: use `get_repository()`.
- Topic discovery: use `search_topics()` to resolve exact GitHub topic names (community topics count; the curated
  flag is informational), then use
  `discover_repositories()` with those topics and the assignment's date bounds as the primary path; see Coverage below.
- Supplement the pooled discovery only when needed with `search_repositories()` and structured `topics`, `language`,
  `min_stars`, creation dates, activity date, and sort filters.
- For topic coverage, use a free-text repository query only as a last resort, with one to three discriminative terms. GitHub ANDs
  whitespace-separated terms; topics are the reliable filter.
- Exhaustive inventory: broaden or paginate only when the assignment explicitly asks for all matching repositories.
- Bounded temporal evidence: discover repositories first, then resolve release or substantive-update timing from
  Provider-returned releases, tags, and repository metadata. GitHub `pushed` and `updated_at` are not release dates.

Treat example or tentative names in the assignment as leads. Preserve the user's source categories and explicit owner
restrictions while verifying the canonical repository and any required official relationship.
Do not use Issue or code search for repository discovery or release-date verification unless the assignment asks for
Issue or code evidence.

## Resolve an uncertain repository

1. Use supplied official links and returned `full_name` and `url` fields to resolve `OWNER/REPO`, including renamed or
   transferred repositories. Identity is resolved when the returned record and any required official relationship support the assignment.
2. If `get_repository()` reports `github_repository_not_found`, inspect its `details` and suggestions, then use
   `search_repositories()` with the project name. An owner filter applies only when the user explicitly restricted the owner;
   a suggested same-owner query does not establish ownership. Verify each replacement against the assignment's source and
   relationship constraints. Query changes correct identity, rather than retry the failed request.
3. Acquire the verified canonical repository once. If identity remains unresolved, submit the available results and report
   the attempted identifiers and remaining identity gap. Preserve actual permission, network and rate-limit diagnostics;
   report `source_unavailable` only when that is the Tool's error code. Root owns Provider fallback.

## Preserve the decision trail

Maintain one candidate map keyed by `OWNER/REPO`. Preserve the first discovery query and merge later query provenance.
Do not repeat the same query or exact repository lookup. For a bounded temporal assignment, record the returned release
evidence or explicit timing uncertainty in candidate metadata. Keep every relevant unique repository that satisfies the
assigned scope; the Ledger is the final retention decision, and the Organizer later merges cross-Provider duplicates.

## Coverage: discovery, your judgment, then the Ledger

For coverage (a category, an organization type or a time-bounded landscape), discover the repositories with one call,
judge them, then acquire and submit what you keep:

```python
found = github.discover_repositories(
    assigned_topics,                    # the category of repositories: exact topic names from search_topics()
    start_date=start_date, end_date=end_date,
)
print(found["listing"])
records = list(found["records"])
```

Define the category from the assignment: pass its exact topics with the assigned dates, and do not invent topic names
for something named. A repository, project or product the assignment names, such as one of the task's leads, that
the pages you read do not contain is looked up by its name with `search_repositories(name)` and judged like any
record; GitHub ANDs the words of one query, so keep it to the one to three words that identify it. Search terms that
describe the category instead of naming a project add nothing discovery has not ranked.

`discover_repositories()` runs the most starred, created-in-range, recently active and optional keyword lanes of every
topic and merges all of their records by repository. A record is excluded only by its own fields: `exclude` names
`archived` and `fork`, both on unless you pass fewer, and with dates a repository neither created nor pushed inside
them is out of date. `min_stars` (100 unless you pass another) keeps every lane to the repositories people took notice
of; lower it only when the assignment asks for repositories too new or too specialized to have stars, and a task that
asks for public, notable or widely used projects does not. The rest are ordered by stars, `recent_share` of the
positions (0.75 unless you pass another) going to repositories created inside the assigned dates and the others to
older repositories still active in them. The first of them, up to the bound the tool states, are the pool; the listing
says how many rank below it. In that order they go through one screen in a fresh model context, which reads the task Root wrote for you and each
repository's description and README opening, fetched without cloning, and removes only what that text shows to be off
the subject of the task. Nothing is cloned and nothing is submitted.

The first line of `listing` says how many repositories the pool holds, what each exclusion removed and how far the
screen has read; each line after it is one repository the screen kept, numbered by its position in the pool, with its stars, creation
date and description. A call screens one page of the pool, so a pool longer than a page ends its listing with a notice
of where the page sits, for example `[Showing the repositories kept from pool records 1-40 of 248. Use offset=41 to
continue.]`. A page fits one cell: print it whole and read every line before you choose. `found["records"]` holds the
page's repositories with their topics, dates, `discovery_lanes` and `papers`, the arXiv identifiers their description
and README link.

Whether to read further pages is yours to decide from what the task asks and what the page shows. To continue, call
it again with the same arguments and the offset the notice names:

```python
found = github.discover_repositories(assigned_topics, start_date=start_date, end_date=end_date, offset=found["next_offset"])
print(found["listing"])
records += found["records"]
```

`next_offset` is null on the last page. Judge the records against the task:

- Drop a record only when its own facts show it is outside what the task asks: another kind of object than the task
  wants (a wrapper, port, plugin, demo, application or re-upload when the task asks for the original project), outside
  the time range the task gives, or under an exclusion the task states. Not knowing a project is not a reason to drop it.
- The task's leads are not the answer. A result that keeps only the lead names has not covered the task.
- How far you read and how many you keep is yours to decide from the task; there is no fixed ceiling. A narrow task
  may need a few repositories and a landscape many, and each one you keep is a clone the later stages read. When you
  keep fewer than qualify, follow the preference the task states; without one, prefer repositories created inside the
  task's time range and, among those, more stars, and keep an older repository when the task asks for the origin of
  something inside the range.

Call `discover_repositories()` with other arguments only when the listing shows the call missed the task: a wrong or
missing topic, an exclusion the task does not want, or a mix of new and older repositories the task does not want
(pass another `recent_share`: 1 puts every repository created inside the dates first, 0 every older one). Another
definition is another pool, screened from its start.

Then acquire and submit like any other task. Wrap each clone so one failure does not lose the others:

```python
ledger, failed = github.CandidateLedger(), {}
for record in kept:                         # the records you chose from the pages you read
    try:
        materials = github.clone_repository(record["full_name"])
    except Exception as error:
        failed[record["url"]] = str(error)[:200]
        continue
    ledger.add(title=record["full_name"], url=record["url"], query=found["query"],
               summary=one_sentence_on_what_it_is, metadata=record, materials=materials)
ledger.write("work/github_candidates.json")
import research_runtime
research_runtime.finish(provider_id="github")
```

If `finish` raises a validation error, repair the same file and call `finish` again. When nothing qualifies, write the
empty Ledger and submit it. End with a compact reply: what you retained, each with the paper identifiers in its
`papers`; what you left out of the pages you read and why, one line per group; what could not be cloned; the leads
neither discovery nor a name search found; and how much of the pool you read. `review-windows.jsonl` beside the
execution conditions records the pool and what each screen window saw and decided.

## Exact-object assignments

For exact-object assignments, use the shared builder instead of hand-writing Ledger assembly:

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
import research_runtime
research_runtime.finish(provider_id="github")
```

Call `clone_repository()` once for each retained repository and pass its returned record directly as `materials`.
Do not extract, copy, rename, or provide paths from the acquired repository. Represent one repository as one candidate
and preserve its pinned revision in metadata.
