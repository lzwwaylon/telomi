---
name: wiki-curator
description: Create one complete Topic-bound Wiki Edition through native RLM children and shared Workspace files. Use only for the Wiki Curator Root.
---

# Wiki Edition Curator

Use ordinary Workspace files and native `rlm()` children. Do not import Runtime communication modules.

The current operation and all compact inputs live under `input/`. Each incoming Page is provisional. The previous Edition is editorial input, while Cornell Evidence is the durable authority. Historical Topic refs are suggestions only. The active Topic Plan defines current scope; historical collection filters do not unless the Plan includes them.

For `initialize`, build the first Edition from one draft Shard. For `update`, integrate one draft Shard into the previous rolling Edition. For `reframe`, review every previous Page under the new Topic Plan.

## Workflow

- If `work/plan.json` does not exist, read [references/plan-and-delegate.md](references/plan-and-delegate.md), write only the Plan, and stop the turn. Runtime validates it and materializes assignments.
- If assignments exist, read [references/resume-and-repair.md](references/resume-and-repair.md), spawn native children only for assignment files whose result is missing or rejected, and stop the turn.
- After Runtime accepts every Workset, read [references/relation-pass.md](references/relation-pass.md) and spawn the one final Concept coordination and relation child requested by Runtime.
- Do not write Workset prose as Root. Do not poll children, inspect RLM internals, or create a messaging channel.

Root owns semantic Workset planning. Workset children own knowledge admission, Concept and Entity identity, canonical placement, prose, evidence retention, and Topic membership. The final child resolves duplicate Concepts across all Workset outputs and published Pages, then owns outgoing relationships for modified Pages and merged Concepts against the resulting Edition catalog. Runtime owns only deterministic Plan validation, result validation, identity and Topic ref remapping, relation normalization, and atomic publication.

Topics appear only as short refs (`T1`, `T2`, ...) in Workspace files. Use those refs everywhere a Topic is referenced; Runtime maps them back to canonical Topic IDs.

The Goal Topic Plan is a navigation frame, not an Ontology or Page quota. Default every Page to one primary Topic. Add a secondary only when a substantial evidence-backed section directly serves it. Keep distinct Entity identities separate unless evidence proves an alias. Keep transferable methods, evaluations, capabilities, and trade-offs as reusable Concepts; identity-specific facts remain in their Entity.

An incoming Entity-only Shard is not evidence that the Edition should contain only Entities. Workset children explicitly test mechanisms for reuse beyond one Entity and may create evidence-backed derived Concept Pages with empty `member_refs`. Do not create Concepts to satisfy a quota.
