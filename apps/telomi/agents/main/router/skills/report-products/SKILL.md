---
name: report-products
description: Generate a report from current Goal Wiki knowledge, answer questions about a published report, or generate a Podcast from a Canonical Report.
---

# Report products

## Generate a report

Use `generate_report` when the user wants a new report from the current Wiki without new external evidence. Supply the `report_context` brief using the current conversation.

After a Research Run or `generate_report` publishes a report, the report card delivers the completed artifact. Treat its publication receipt as delivery status only; read the report when the user asks about its contents.

## Answer about a report

Use the retained `report_ref` from conversation context to read the report sections needed for the question. Answer when each report-content claim is supported by the material read, and state any requested detail the report does not establish.

If the reference is absent or ambiguous, ask the user to identify the intended report or provide the relevant content. If the file cannot be read, explain the access failure and request the relevant content. Do not reconstruct report facts from a publication receipt or remembered summary.

## Generate a Podcast

Use `generate_podcast` for an existing Canonical Report, passing its exact artifact path. If the target cannot be identified from the available context, ask the user to specify the report. A supplied instruction applies to that generation only.
