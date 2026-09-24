# Plan Wiki Curator Worksets

Use this phase only before `work/plan.json` exists.

Read `input/index.json` once. It contains the operation, active Topic Plan, incoming compact Page rows, previous-Edition count, and deterministic exact-title suggestions. Read `input/main-index.json` as a compact catalog. Do not read `input/pages.json` or Page bodies as Root.

Create exclusive semantic Worksets covering every incoming ref exactly once. Each Workset contains at least one incoming ref and may include relevant MAIN refs; a child keeps an included MAIN ref unchanged when the batch does not change it, so including one for inspection costs nothing. Keep every Runtime suggested identity group together. Never assign one MAIN ref to multiple Worksets.

An `update` Plan omits untouched MAIN Pages because Runtime copies them unchanged. `initialize` and `reframe` expose every Page that requires review as incoming.

Use these identity rules:

- Similarity means inspect together, not merge.
- Merge Entities only with positive evidence of the same canonical identity or an explicit alias.
- Distinct versioned or time-scoped subjects remain separate unless evidence identifies them as the same canonical Entity.
- Merge Concepts only when they express the same reusable abstraction at the same level.
- Identity-specific attributes, behavior, evidence, and constraints normally belong in that Entity.
- Reusable mechanisms, evaluations, capabilities, and trade-offs remain Concepts even when currently evidenced by only one Entity.
- Group candidate Concepts that may express the same reusable abstraction together even when they come from different Entities or Sources.
- A Workset child may derive a new Concept out of an assigned Entity body, so some Concepts of this Edition do not exist yet while you plan. Grouping cannot reach them; the child contract makes each child compare its derivations against the whole batch's incoming Concept rows.
- Do not put an Entity and all related Concepts into one Workset merely because they are related. Separate reusable Concept decisions from Entity identity decisions.
- A subordinate named subject normally stays inside its parent Entity unless it has independent cross-Source knowledge value.

Write exactly this shape to `work/plan.json`, then stop the turn without spawning children:

```json
{
  "groups": [{
    "group_id": "safe-workset-id",
    "members": ["DRAFT001:entity:abc", "MAIN:entity:def"]
  }]
}
```

Runtime validates the Plan and creates `work/assignments/*.json` plus `work/child-contract.md` for the delegation turn.
