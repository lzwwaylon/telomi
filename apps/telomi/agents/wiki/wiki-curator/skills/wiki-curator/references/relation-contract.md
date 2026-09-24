# Wiki Curator final Concept coordination and relations

Read `work/relation-assignment.json`. `catalog` contains every Page after Workset delivery, including unchanged published Pages and newly derived Concepts. `owned_pages` contains the modified Page bodies. Inspect the full Concept catalog for overlapping abstractions, then read the relevant bodies from `concepts_path` and their cited Cornell Entries from `entries_path`. These are frozen inputs; paths are relative to the Curator Workspace root. Use `topic_plan` for current Topic membership and `suggested_relations` as evidence hints. Write only the assignment's `output_path`.

## Resolve Concept identity

Decide from meaning and evidence whether Pages answer the same durable question at the same abstraction level. Different titles, examples, or wording do not establish different Concepts. Compare across Worksets and against published Concepts, including duplicates already present in the previous Edition. Read every proposed member's full body before merging.

Merge only when one Concept can carry the complete supported knowledge of all members without erasing a meaningful boundary. Keep distinct questions, mechanisms, evaluations, operational patterns, and failure modes separate. Preserve differences in versions, applicability, measurements, conditions, and uncertainty explicitly; a shared topic or overlapping citations alone is insufficient to merge. When identity remains uncertain, retain the separate Pages. Entity Pages are outside your merge authority.

For each merge, list at least two distinct pre-coordination `catalog` refs in `member_refs` and select one as `keep_ref`. A Page participates in at most one merge. Prefer an established published identity and its title when valid. Write the complete replacement Concept, preserving every supported fact, comparison, condition, number, and citation from all members while consolidating repeated prose. Its Cornell Entry references must equal the union cited by the member Pages; there is no deferral or new-evidence path in this phase. Use ordinary H2 sections without H1, frontmatter, raw URLs, Related, or Evidence sections. Choose valid short Topic refs from `topic_plan`, including the primary in `topic_refs`. Pages outside merges remain unchanged. Use an empty `concept_merges` array when no merge is justified.

## Link the resulting Edition

First map every absorbed ref to its `keep_ref`. The final catalog contains those survivors and every unmerged Page. Your `owned_refs` is exactly the unique mapped refs of `owned_pages`, plus every merge's `keep_ref`, including merges of previously unchanged Pages. Own each once even if it has no outgoing edges.

Write relations from these owned refs to final catalog refs, using survivor refs only. Base edges on the final Page bodies. Review the supported suggested relationships of all absorbed Pages, map their endpoints, and preserve those that remain valid. Runtime redirects incoming links from unchanged Pages. Remove self-links and duplicate edges after mapping. Consider precise inverse relationships when supported and useful without forcing reciprocity. Prefer a small useful graph over generic related-to edges.

Write one JSON object atomically to `output_path`:

```json
{
  "concept_merges": [{
    "member_refs": ["MAIN:concept:one", "DERIVED:group:2"],
    "keep_ref": "MAIN:concept:one",
    "title": "Canonical concept",
    "description": "One grounded sentence.",
    "primary_topic_ref": "T1",
    "topic_refs": ["T1"],
    "body": "## Mechanism\n\nComplete supported synthesis [[entry:0123456789abcdef01234567]]."
  }],
  "owned_refs": ["every final owned Page ref, including Pages with no outgoing edge"],
  "relations": [{"from_ref": "final owned ref", "to_ref": "final catalog ref", "label": "precise semantic relation"}]
}
```

Write titles, descriptions, prose, and relation labels in the assignment's `language`, preserving canonical names, identifiers, and technical acronyms. Return concise ordinary completion text after writing. On rejection, repair this same complete result from the original frozen inputs; previous merge results are not new inputs.
