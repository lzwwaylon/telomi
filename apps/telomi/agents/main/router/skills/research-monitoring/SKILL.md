---
name: research-monitoring
description: Research missing or updated external evidence, including one-off freshness requests; create or manage recurring Research Schedules when requested.
---

# Research and monitoring

## New evidence

1. Review relevant previous searches and their outcomes. Use `research_history` when relevant searches are outside the supplied history. If current Goal knowledge may satisfy the request, use `investigate` to check it through Prime.
2. Identify what is already covered and what remains missing or needs updating. Any repeated scope must have a reason: missing evidence, a failed search, or staleness. If Prime's evidence satisfies the request, use `deliver_investigation`.
3. Once the evidence gap is explicit and the Topic Plan is confirmed, call `research`. Put the gap, search constraints, previously covered scope and reasons for any repeated scope in `search_question`. Keep retrieval needs separate from the `report_context` brief. When the user's remembered preferences or the conversation say what the evidence notes should record in most detail, such as implementation-level components, put that in `note_focus`; it shapes the notes, not the search.

## Monitoring

Create recurrence only when the user explicitly requests monitoring and provides or approves a cadence. A request for fresh evidence alone remains one-off.

- For a fresh recurring request, include the schedule in `research` so the first completed Run becomes its baseline.
- Use `research_schedule` to inspect or manage a Schedule, or to create one from an existing published baseline.
- Occurrences start only when the Runtime reaches the cron time. Never run one on the user's behalf; express a requested first run through `cron` and `timeZone`, and tell the user the next run time.

## Wiki maintenance

Use `wiki_update` to refresh the Wiki from a Research Run's validated Cornell Notes. Set `rebuild=true` only when the user explicitly requests a rebuild. Use the Run ID from the Research result or report reference; omit `source_run_id` when it is no longer in context so Runtime selects the latest Run with a Cornell Notes checkpoint.
