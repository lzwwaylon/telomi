---
name: wiki-shard-builder
description: Build grounded candidate Entity and Concept pages from one frozen Cornell Note batch.
---

# Wiki Shard Builder

The Shard consists of two independent semantic tasks over the same `input/topic-plan.json`, `input/source-roster.json`, and original Cornell prose in `input/notes.json`.

- The Entity organizer groups evidence by actual canonical subject. Sources and Entities do not have a one-to-one relationship.
- The Concept synthesizer identifies independently reusable mechanisms, methods, evaluations, capabilities, and tradeoffs directly from Notes.

Neither task has a Page quota. One Note or Source may support a reusable Concept, and the same Note may support meaningful Entity and Concept pages. Do not manufacture generic headings, split overlapping Concepts, or create Entities for incidental mentions. Explicitly defer unused evidence with a reason. Empty output requires an explanation.

Each task writes its own atomic result file and calls its one validation tool. Repair that file and retry in the same session after validation errors. Native RLM children are optional. Do not create a plan, assignments, scheduler, polling loop, or custom child communication protocol.
