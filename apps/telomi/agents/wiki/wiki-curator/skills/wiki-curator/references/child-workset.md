# Wiki Curator Workset file contract

Read the assigned `work/assignments/<group-id>.json`, then read only its exact member refs from the assignment's `pages_path`. Resolve cited Cornell Entries through the assignment's `entries_path`; their `topicRefs` are explicit attention suggestions, not mandatory Topic membership. The active Topic Plan defines current scope; do not discard durable knowledge for failing a historical collection filter unless the Plan includes that filter. Paths are relative to the Curator Workspace root, never relative to the assignment file. Also read the compact `incoming_pages` rows of `input/index.json` (`ref`, `kind`, `title`, `description`) to see what the rest of this batch already carries, and the Concept rows of `input/main-index.json` (same fields; the previous Edition's published Pages) to see what the Wiki already carries; read nothing else from those files. Do not load Skills, Runtime files, modules, outside knowledge, Page bodies outside the assigned member refs, or any other Workset's assignment, work, or result.

Decide knowledge admission and canonical placement before identity. Keep distinct Entities separate unless evidence proves alias identity. Preserve reusable methods, capabilities, evaluations, and trade-offs as Concepts. Identity-specific facts belong in their Entity. Do not fold an independently reusable abstraction into an Entity solely because only that Entity currently demonstrates it.

Do not retain a Page merely because a draft candidate already exists. A subordinate named subject normally belongs as a section of its parent Entity unless it has independent cross-Source knowledge value. A standalone Concept remains useful without depending on one named Entity. Merge overlapping Concept candidates at the same abstraction level when both are assigned to this Workset; a candidate assigned elsewhere is never merged, rewritten, or claimed here. Keep definitions separate from evaluations, operational patterns, and failure modes when they answer different durable questions.

Before finalizing, inspect assigned Entity bodies for transferable abstractions, including when no Concept candidate exists anywhere in the batch. For each abstraction that remains independently useful without depending on one named Entity, compare it against every Concept row in `incoming_pages`, whether assigned to this Workset or not, and against every published Concept row in `input/main-index.json`. Exactly one of the next two paragraphs applies to it.

When an incoming candidate or a published Concept already expresses that same abstraction, do not derive a Page for it: keep the identity-specific facts in your Entity and leave the abstraction to the Page that owns it; the final relation child links your Entity to it. Wording alone does not separate two abstractions, so a Page phrased differently from how your Entity states it is still the same abstraction.

When neither expresses it, derive it only if it is an abstraction and not a copy. A derived Concept states what the method, capability, evaluation or trade-off is, what it buys and costs, and when it applies, in terms that hold for any Entity that uses it; it cites the Entity's Cornell Entries as evidence. A Page that restates one Entity's own sections (its architecture, sizes, training data, results) under a generic title is that Entity's description with a new name: it adds nothing a reader of the Entity does not already have, so leave those facts in the Entity. Evidence from a single Entity is sufficient when the Page still reads as a transferable statement rather than as that Entity's profile, and a narrower question than any existing Concept answers is a different abstraction rather than a duplicate of one. Do not manufacture a Concept merely to satisfy a quota.

Write one JSON object atomically to the assignment's `output_path`:

```json
{
  "group_id": "exact group id",
  "pages": [{
    "member_refs": ["each consumed member ref"],
    "kind": "entity",
    "title": "Canonical title",
    "description": "One plain identity-specific sentence.",
    "primary_topic_ref": "T1",
    "topic_refs": ["T1"],
    "body": "## Overview\n\nGrounded prose [[entry:0123456789abcdef01234567]]."
  }],
  "retained_member_refs": ["each MAIN member ref left unchanged"],
  "discarded_member_refs": [],
  "deferred_entries": [{"entry_ref": "entry:...", "reason": "specific evidence-based reason"}]
}
```

Every member ref appears exactly once across Page `member_refs`, `retained_member_refs` and `discarded_member_refs`; only incoming refs may be discarded, and only MAIN refs may be retained. Derived synthesis Pages may use empty `member_refs` only when independently useful and evidence-backed.

A MAIN member is already published. It was assigned so you could inspect it against the incoming candidates, not so you would rewrite it. When nothing in this Workset changes it, list it in `retained_member_refs` and Runtime carries it forward byte for byte, citations included. Consume a MAIN member in a Page's `member_refs` only when that Page genuinely changes it: merging a candidate into it, correcting it, or absorbing it into another identity. A consumed member is replaced by your Page in full, so carry every fact, number, comparison and citation of the old body forward unless evidence overturns it; a rewrite that only summarizes the old body is content loss, not curation.

Every assigned Cornell Entry remains in Page prose or receives a specific deferred reason. Never invent Entry refs. Before replacing result.json, compute the complete set of Entry IDs cited by every assigned member Page and verify it exactly equals the union of Entry IDs cited in output Page bodies plus `deferred_entries`; defer comparison evidence about another identity instead of silently dropping it. Every durable Page retains at least one assigned Entry. Before assigning Topic membership, collect the `topicRefs` suggestions of the Cornell Entries actually cited by that Page and check each suggested Topic against the Page's substantial sections. Use the short Topic refs shown in the assignment's `topic_plan` (`T1`, `T2`, ...) and include the primary Topic ref; Runtime maps them to canonical Topic IDs. Do not omit a directly served Topic merely because another Topic is primary. Prefer the smallest complete Topic set, and require a substantial evidence-backed section for every secondary membership.

Write every Page `title`, `description`, and `body`, and every deferral reason, in the assignment's `language`, the language this user reads. Keep canonical names, versions, identifiers, and technical acronyms unchanged. A member Page written in another language is rewritten in the assignment's `language` as part of this Workset without changing its facts or citations; Pages outside the Workset are left as they are.

Bodies contain ordinary H2 sections without H1, frontmatter, raw URLs, source inventories, or an Evidence section. The later final relation child owns Edition links, so Workset results do not contain relationship fields. Write through a temporary sibling file and replace `result.json` only after the complete JSON is ready.

Writing the file is not delivering it. Call `submit_workset(group_id="<this Workset's exact group id>")` as your final filesystem action. Runtime validates the result and reports the exact file, field and value it rejects. On rejection, repair that same `result.json` and call the Tool again; the rejection is the only account of the problem anyone will get, and no later round has the reasoning you have now. A discarded MAIN Page is the common one: MAIN Pages are already published, so keep each one unchanged in `retained_member_refs` when this Workset does not change it, or consume it in the `member_refs` of the Page that carries its knowledge forward. Only after the Tool reports success, return concise ordinary final text to the parent through native RLM completion.
