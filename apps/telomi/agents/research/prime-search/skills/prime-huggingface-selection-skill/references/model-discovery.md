# Integrated model discovery

Use this path for broad or time-bounded model discovery. It owns lane construction and returns one bounded candidate
pool, so do not reconstruct its retrieval logic.

## Run discovery

- Start with `discover_models()` without a cursor. Pass every relevant `pipeline_tag` together, the assigned
  creation-date interval when present. The operation chooses a fixed page size so one call cannot return the whole
  pool.
- Resolve every language filter through `model_tags()` before discovery. Never guess IDs such as `language:zh` from
  human language names. If any required task or filter ID is unknown, read [Tag filtering](tag-filtering.md), resolve
  it with `model_tags()`, then return here. Pass only Provider-native filters explicitly required by the assignment.
- The operation validates task tags, runs trending, complete date-range, likes, and downloads lanes, and merges them by
  `repo_id`.
- For time-bounded work, it keeps trending records with in-range release evidence first, then dynamically fills the
  remaining capacity from the creation timeline. Likes and downloads remain supplemental provenance rather than fixed
  candidate quotas.

Treat likes and downloads as lagging signals, especially near the recent edge of the requested interval. A newly
created record that ranks high in a Provider-native trending lane, or strongly matches the assigned task and language
tags, may represent an emerging release before its counters accumulate. Retain it for exact metadata or Model Card
review rather than excluding it solely for low counts. Recency and trending are review signals, not proof of quality.

Inspect `lane_counts` first. Read and decide the returned `records` before requesting another page. `returned_count`
describes the current page; `unique_count` describes the complete bounded pool. Every record includes `discovery_lanes` with its original rank in
each lane. Use that provenance directly. Do not compute replacement weights, rerank the pool, or create a hand-written
Top-N retrieval list.

Accumulate only records that remain relevant to the assigned scope into an in-memory shortlist. Complete discovery
pagination before calling exact metadata or Model Card operations for that shortlist. Discovery membership alone is
not a reason to fetch a full Model Card.

When `next_cursor` is non-null, call `discover_models()` again with the same discovery arguments and that exact cursor.
Accumulate chosen records in code and continue until `next_cursor` is null. Write the Candidate Ledger only after the
last page has been reviewed.

Do not repeat discovery with narrower language views to create a larger pool.

Do not catch a `discover_models()` error and continue with a partial result. Repair the failed input or let the error
propagate with its recovery details. If complete date coverage reaches its safety limit, narrow the query with a valid
task or another Provider-native tag while preserving the assignment boundary.
