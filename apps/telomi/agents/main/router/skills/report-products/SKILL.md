---
name: report-products
description: Generate a report from current Goal Wiki knowledge, answer questions about a published report or its Podcast, or generate a Podcast from a Canonical Report.
---

# Report products

## Generate a report

Use `generate_report` when the user wants a new report from the current Wiki without new external evidence. Supply the `report_context` brief using the current conversation.

After a Research Run or `generate_report` publishes a report, the report card delivers the completed artifact. Treat its publication receipt as delivery status only; read the report when the user asks about its contents.

## Answer about a report

Find the report under `/reports`: the receipt names its path, and `ls /reports` lists every published report by date and title. Read the sections of `report.md` needed for the question. Answer when each report-content claim is supported by the material read, and state any requested detail the report does not establish. Answer questions about what a Podcast said from its Podcast Script, `podcast.md`, the same way.

If the intended report is ambiguous among the listed ones, ask the user to identify it. If the file cannot be read, explain the access failure and request the relevant content. Do not reconstruct report facts from a publication receipt or remembered summary.

## Generate a Podcast

Use `generate_podcast` with the report's directory under `/reports`. If the user's reference does not identify one listed report, ask the user to specify it. Generation replaces the report's current Podcast. A supplied instruction applies to that generation only. To retry a failed generation, call again without an instruction so it continues from the Podcast Script it already finished; supply one only when the user wants the script itself changed.
