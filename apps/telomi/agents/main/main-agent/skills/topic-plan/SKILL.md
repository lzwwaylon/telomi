---
name: topic-plan
description: Define or revise a Goal's durable Topic Plan when the user discusses long-term interests, changes the Goal's scope, or Research awaits Topic confirmation.
---

# Topic Plan

Read `/work/topic-plan.json`. It is the current draft, or the latest user-confirmed Plan when no draft exists. Maintain the complete document with the native `edit` or `write` Tool.

The document contains only `topics`. A confirmed existing Topic has a Runtime-owned `id`; preserve it exactly when editing, renaming, or reordering that Topic. A new Topic omits `id` so Runtime can assign it on confirmation. Each Topic contains only `title`, `intent`, optional `questions`, `include`, and `exclude`, and the existing Runtime-owned `id` when present.

Create focused, durable attention lenses, each centered on one independently trackable concern. Apply this when creating a Plan and revising the requested scope. Keep titles user-confirmable and `intent` to one sentence. Omit optional arrays unless they clarify scope. Do not ask the user to rank Topics.

Decide granularity before writing the document:

1. List the concerns. From the user's message and the current document, write down one line per long-term concern the user could research, monitor, or navigate on its own. Each enumerated item, lettered sub-point, or separately described aim is its own line unless it only elaborates the previous line. Headings, numbering, the current document's Topic count, and any suggested number of Topics are neither grouping decisions nor targets; the Topic count follows from this list. A numbered section or paragraph usually holds several concerns, so the list is usually longer than the user's numbering, and a Plan whose Topics correspond one to one with the user's sections has skipped this step. For example, a section "2. Platform work: (a) migrating the database to a new engine; (b) adding tracing and alerting" lists two concerns, migration and observability, so it yields two Topics rather than one Topic named after the section.
2. Make one Topic per line. Join lines only when the user explicitly asks to treat them as one focus, or when a comparison, relationship, or established compound concept is itself the focus. Sharing a domain, Source, Wiki Page, or workflow does not join them. Supporting questions and one-off search steps stay out of the list; keep the latter in the investigation question.
3. When revising, map each existing Topic to the lines it covers. Keep its `id` only for a clear continuation of one concern, at most once; a Topic that covers several lines is split into new Topics without `id`, and Topics that express the same concern are merged. Preserve the original scope across a split.

Before saving, check every Topic against the list: a title, intent, or `include` list that names two lines is split. Then check that every line is covered, that no scope is duplicated across Topics, and that distinct concerns remain independently navigable. Preserve unmentioned Topics. Use one Topic when the list has a single durable concern.

Usually read only the current document. If the user asks about prior scope, wants to restore an older Plan, or the current intent is unclear, inspect the read-only `/history/topic-plan.jsonl`. Each line is one complete user-confirmed snapshot. Never modify history.

Saving creates a draft. Only the user's Confirm action appends a confirmed history snapshot and activates it. After editing, briefly summarize the change and ask the user to review the inline Topic card. Do not start Research or scheduling while the current Plan is awaiting confirmation.
