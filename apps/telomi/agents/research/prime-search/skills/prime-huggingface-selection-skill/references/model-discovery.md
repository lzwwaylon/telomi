# Integrated model discovery

Use this path for broad or time-bounded model discovery. One call builds the pool and returns its first page, so do
not reconstruct its retrieval logic.

## Run discovery

```python
found = huggingface.discover_models(
    assigned_pipeline_tags,                # the category of models: every relevant pipeline_tag ID, resolved with model_tags()
    start_date=start_date, end_date=end_date,
)
print(found["listing"])
records = list(found["records"])
```

Define the category from the assignment:

- A category, an organization type or a time-bounded landscape is a category: pass `pipeline_tags` with the assigned
  creation-date interval. Pass only the task tags the assignment is about: a neighbouring tag enumerates a different
  kind of model. Resolve every language or other filter through `model_tags()` first and pass only Provider-native
  filters the assignment requires in `filters`.
- `discover_models()` validates task tags, runs trending, complete date-range, likes and downloads lanes, and
  merges them by `repo_id`. The date-range lane is ordered by likes and the lanes take turns, so a model that leads
  any lane is in the pool.
- A record is excluded only by its own fields. `exclude` names two of them, both on unless you pass fewer:
  `conversion` (a format variant, named as one or declaring a quantized base) and `derived` (built on another author's
  model of the same task). `min_likes` (100 unless you pass another) removes records below it as `low_interest`:
  it is what makes the pool the models people took notice of. Change these only when the assignment asks for such
  repositories: quantized builds, fine-tunes of a named model, or releases too new or too specialized to have likes.
  A task that asks for public, notable or widely used models asks for none of them.
- The pool holds the models that rank highest across the lanes, up to the bound the tool states, and each call
  returns one page of it in that order: the models that lead each lane come first.

Nothing is acquired or submitted, and no model has read the records. The first line of `listing` says how many models
the pool holds and what each exclusion removed; each line after it is one model with its likes and creation date.
A repository created before the range is in the pool for a release inside it, and its line says which, for example
`created 2025-11-01, released 2026-03 (arxiv:2603.25551)`: it belongs to the range.
When the pool is longer than a page the listing ends with a notice of where the page sits, for example
`[Showing models 1-50 of 163. Use offset=51 to continue.]`. A page fits one cell: print it whole and read every line
before you choose. `found["records"]` holds the page's models with their task, downloads and tags, `lane_counts` what each lane
returned, `unique_count` the size of the pool and `returned_count` this page; every record carries `discovery_lanes`,
its rank in each lane.

Whether to read further pages is yours to decide from what the task asks and what the page shows. To continue, call
it again with the same arguments and the offset the notice names:

```python
found = huggingface.discover_models(assigned_pipeline_tags, start_date=start_date, end_date=end_date, offset=found["next_offset"])
print(found["listing"])
records += found["records"]
```

`next_offset` is null on the last page. In the completion reply say how much of the pool you read. Use the lane provenance directly:
do not rerank the pool or create a hand-written Top-N list, and do not repeat discovery with narrower language views
to create a larger pool.

Judge the records against the task:

- Drop a record only when its own facts show it is outside what the task asks: another kind of object than the task
  wants (a re-upload or copy of another repository's model, a single voice, language pack or adapter of a model that
  is already in the pool, when the task asks for the original releases), outside the time range the task gives, or
  under an exclusion the task states. Not knowing a model or its author is not a reason to drop it.
- The task's leads are not the answer. A result that keeps only the lead names has not covered the task.
- A preference the task states orders the records; it does not remove one that meets the task. There is no ceiling
  on Model Cards: keep every record that qualifies.

A model the assignment names that the pages you read do not contain is looked up by its name with `models(search=name)`,
see [Native search](native-search.md), and judged like any record. Search terms that describe the category instead of
naming a model add nothing discovery has not ranked.

Call `discover_models()` again only when the listing shows the call missed the task: a wrong or missing task tag, an
exclusion the task does not want, or models below the pool that the task needs, which a narrower date range or
filter reaches. If it raises because the category is too broad to enumerate, call it again with the assignment's date
range or a Provider-native filter.

Then acquire and submit like any other task. Wrap each card so one failure does not lose the others:

```python
ledger, failed = huggingface.CandidateLedger(), {}
for record in kept:                         # the records you chose from the pages you read
    try:
        materials = huggingface.model_card(record["repo_id"])   # raises for a gated or empty card
    except Exception as error:
        failed[record["url"]] = str(error)[:200]
        continue
    ledger.add(title=record["repo_id"], url=record["url"], query=found["query"],
               summary=one_sentence_on_what_it_is, metadata=record, materials=materials)
ledger.write("work/huggingface_candidates.json")
import research_runtime
research_runtime.finish(provider_id="huggingface")
```

If `finish` raises a validation error, repair the same file and call `finish` again. When nothing qualifies, write the
empty Ledger and submit it. End with a compact reply: what you retained, each with the paper identifiers in its
`arxiv:` tags; what you left out of the pages you read and why, one line per group; whose card could not be acquired; and the
leads neither discovery nor a name search found.

Do not catch a `discover_models()` error and continue with a partial result. Repair the failed input or let the error
propagate with its recovery details. If complete date coverage reaches its safety limit, change the category as the
error says while preserving the assignment boundary.
