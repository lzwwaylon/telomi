---
name: research-monitoring
description: Inspect prior Research Runs, create or manage recurring Research Schedules from a published baseline, or refresh and correct the Goal Wiki when requested.
---

# Research history and monitoring

## Earlier research

Use `research_history` when relevant searches are outside the supplied history. Include missing evidence, failed searches or staleness in investigation context when these justify revisiting earlier scope.

## Monitoring

Create recurrence only when the user explicitly requests monitoring and provides or approves a cadence. A request for fresh evidence alone remains a one-off investigation.

- With a confirmed Topic Plan, use `research_schedule` to inspect or manage a Schedule, or create one from an existing published Research Run. An investigation answer is not a published baseline.
- If no published baseline exists, explain that a Schedule cannot yet be created from this conversation; do not promise that an investigation will publish one.
- Occurrences start only when the Runtime reaches the cron time. Never run one on the user's behalf; express a requested first run through `cron` and `timeZone`, and tell the user the next run time.

## Wiki maintenance

Original Sources and verified Cues are saved independently. After successful investigation delivery, Runtime batches its new Reader artifacts and cited historical Reader artifacts for selective Wiki maintenance using Main's review. Continue answering from saved investigation evidence while maintenance runs.

Use `wiki_update` for a requested refresh, retry or rebuild. Omit `source_run_id` to process delivered pending evidence; set `rebuild=true` only for an explicit rebuild. Supply `source_run_id` only when the user selects a particular historical Research Run.

For an explicit request to review, clean up or correct existing Wiki content, use `reconsider=true`, `rebuild=false`, and omit `source_run_id`. Carry the user's actual requested correction and exclusions in `reason`. Runtime freezes the complete saved Goal evidence and latest delivered reviews for another selective compilation, preserving original Sources and historical Editions. Ordinary negative feedback remains discussion until the user requests a Wiki change. Findings needing more evidence may remain deferred for a later delivered investigation or explicit maintenance; deferral starts no independent investigation.
