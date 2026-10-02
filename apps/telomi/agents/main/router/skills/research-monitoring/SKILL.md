---
name: research-monitoring
description: Inspect prior Research Runs, create or manage recurring Research Schedules from a published baseline, or refresh the Goal Wiki when requested.
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

Runtime queues verified investigation Cues for background Wiki maintenance after they are saved. Continue answering from the investigation evidence while maintenance runs. Use `wiki_update` when the user requests a refresh, a retry of interrupted maintenance, or a rebuild. Omit `source_run_id` to process pending investigation evidence; set `rebuild=true` only for an explicit rebuild from the complete saved Cornell corpus. Supply `source_run_id` only when the user selects a particular historical Research Run.
