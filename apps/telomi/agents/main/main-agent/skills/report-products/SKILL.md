---
name: report-products
description: Request a report-style investigation answer, read a published report or its Podcast, or generate a Podcast from a Canonical Report.
---

# Report products

## Request a report

Use `investigate` with the complete question and a self-contained context describing the audience, format, depth, language and evidence priorities. Restrict it to `local_only` when the user requests saved Goal material; otherwise allow external evidence. Read its `result_ref`, review coverage and gaps, then publish the saved answer with `deliver_investigation` using its `investigation_id` and a concise `report_title`, or continue the thread for missing evidence.

Publication compiles the reviewed Writer answer and its frozen evidence into a Canonical Report. The report card, `/reports` file and Podcast all use that same published content. Do not repeat investigation or writing merely to publish an answer already reviewed: recover its returned `investigation_id`, read its saved result and publish it. Never invent an id or reconstruct the answer from memory. Generate audio only when the user requests it.

Ordinary factual answers use `deliver_investigation` without `report_title`. An investigation report is available for reading and Podcasts; a Research Schedule baseline still requires a completed Research Run with verified Sources and Cornell Notes.

## Answer about a report

Find the report under `/reports`: the receipt names its path, and `ls /reports` lists every published report by date and title. Read the sections of `report.md` needed for the question. Answer when each report-content claim is supported by the material read, and state any requested detail the report does not establish. Answer questions about what a Podcast said from its Podcast Script, `podcast.md`, the same way.

If the intended report is ambiguous among the listed ones, ask the user to identify it. If the file cannot be read, explain the access failure and request the relevant content. Do not reconstruct report facts from a publication receipt or remembered summary.

## Generate a Podcast

Use this path only when the current user request asks for audio or a Podcast. A request for a written report about Podcasts still uses `investigate`.

Use `generate_podcast` with the report's directory under `/reports`. If the user's reference does not identify one listed report, ask the user to specify it. Generation replaces the report's current Podcast. A supplied instruction applies to that generation only. To retry a failed generation, call again without an instruction so it continues from the Podcast Script it already finished; supply one only when the user wants the script itself changed.
