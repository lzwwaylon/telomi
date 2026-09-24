---
name: topic-plan
description: Define or revise a Goal's durable Topic Plan when the user discusses long-term interests, changes the Goal's scope, or Research awaits Topic confirmation.
---

# Topic Plan

Read `/work/topic-plan.json`. It is the current draft, or the latest user-confirmed Plan when no draft exists. Maintain the complete document with the native `edit` or `write` Tool.

The document contains only `topics`. A confirmed existing Topic has a Runtime-owned `id`; preserve it exactly when editing, renaming, or reordering that Topic. A new Topic omits `id` so Runtime can assign it on confirmation. Each Topic contains only `title`, `intent`, optional `questions`, `include`, and `exclude`, and the existing Runtime-owned `id` when present.

Create a compact set of durable attention lenses. Add, remove, merge, split, rename, or reorder Topics when that is what the user means. Keep titles user-confirmable and `intent` to one sentence. Omit optional arrays unless they clarify scope. Do not ask the user to rank Topics.

Before saving, check that the Plan covers the user's stated long-term concerns, keeps distinct concerns independently navigable, and preserves unmentioned Topics. Use one Topic when there is a single durable concern; otherwise separate the concerns by user attention. One-off search steps belong in the Search Question.

Usually read only the current document. If the user asks about prior scope, wants to restore an older Plan, or the current intent is unclear, inspect the read-only `/history/topic-plan.jsonl`. Each line is one complete user-confirmed snapshot. Never modify history.

Saving creates a draft. Only the user's Confirm action appends a confirmed history snapshot and activates it. After editing, briefly summarize the change and ask the user to review the inline Topic card. Do not start Research or scheduling while the current Plan is awaiting confirmation.
