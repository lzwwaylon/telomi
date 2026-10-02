---
name: topic-plan
description: Define or revise a Goal's durable Topic Plan when the user discusses long-term interests, changes the Goal's scope, or Research awaits Topic confirmation.
---

# Topic Plan

Read `/work/topic-plan.json`. It is the current draft, or the latest user-confirmed Plan when no draft exists. Maintain the complete document with the native `edit` or `write` Tool.

The document contains only `topics`. A confirmed existing Topic has a Runtime-owned `id`; preserve it exactly when editing, renaming, or reordering that Topic. A new Topic omits `id` so Runtime can assign it on confirmation. Each Topic contains only `title`, `intent`, optional `questions`, `include`, and `exclude`, and the existing Runtime-owned `id` when present.

Create focused, durable attention lenses, each centered on one independently trackable concern. Apply this when creating a Plan and revising the requested scope. Keep titles user-confirmable and `intent` to one sentence. Omit optional arrays unless they clarify scope. Do not ask the user to rank Topics.

Use these boundaries to choose Topic granularity:

- Separate concerns when the user could research, monitor, or navigate either independently. Sharing a domain, Source, Wiki Page, or workflow does not by itself make them one concern. Prefer separate Topics over an umbrella title that joins independent concerns to reduce the Topic count.
- Keep a coherent comparison, relationship, or established compound concept together when that is itself the user's focus. Judge the intent and scope, not conjunctions in the title. Supporting questions and one-off search steps do not each need a Topic; keep the latter in the investigation question.
- Merge Topics when they express the same concern or the user explicitly requests a combined focus. For a split, preserve the original scope across the resulting Topics. Retain an existing `id` only for a clear continuation of that Topic, at most once; new Topics omit `id`.

Before saving, check that the Plan covers the user's stated long-term concerns, each Topic's title, intent, questions, and include scope serve the same concern, and distinct concerns remain independently navigable. Preserve unmentioned Topics and honor explicit user grouping choices. Use one Topic when there is a single durable concern.

Usually read only the current document. If the user asks about prior scope, wants to restore an older Plan, or the current intent is unclear, inspect the read-only `/history/topic-plan.jsonl`. Each line is one complete user-confirmed snapshot. Never modify history.

Saving creates a draft. Only the user's Confirm action appends a confirmed history snapshot and activates it. After editing, briefly summarize the change and ask the user to review the inline Topic card. Do not start Research or scheduling while the current Plan is awaiting confirmation.
