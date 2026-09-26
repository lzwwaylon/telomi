---
name: research-monitoring
description: Research missing or updated external evidence, including one-off freshness requests; create or manage recurring Research Schedules when requested.
---

# Research and monitoring

## New evidence

1. Review relevant previous searches and their outcomes. Use `research_history` when relevant searches are outside the supplied history. If current Goal knowledge may satisfy the request, use `wiki-knowledge` to check its Evidence.
2. Identify what is already covered and what remains missing or needs updating. Any repeated scope must have a reason: missing evidence, a failed search, or staleness. If existing Evidence satisfies the request, answer from it.
3. Once the evidence gap is explicit and the Topic Plan is confirmed, call `research`. Put the gap, search constraints, previously covered scope and reasons for any repeated scope in `search_question`. Keep retrieval needs separate from the `report_context` brief. When the user's remembered preferences or the conversation say what the evidence notes should record in most detail, such as implementation-level components, put that in `note_focus`; it shapes the notes, not the search.

## Monitoring

Create recurrence only when the user explicitly requests monitoring and provides or approves a cadence. A request for fresh evidence alone remains one-off.

- For a fresh recurring request, include the schedule in `research` so the first completed Run becomes its baseline.
- Use `research_schedule` to inspect or manage a Schedule, or to create one from an existing published baseline.
- Occurrences start only when the Runtime reaches the cron time. Never run one on the user's behalf; express a requested first run through `cron` and `timeZone`, and tell the user the next run time.
