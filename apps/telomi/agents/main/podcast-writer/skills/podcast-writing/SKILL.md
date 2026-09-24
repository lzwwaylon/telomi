---
name: podcast-writing
description: Coordinate source-grounded RLM children to turn one long Canonical Report into a coherent single-narrator podcast manuscript.
---

# Podcast Writing

Treat `inputs/canonical-report.md` as the sole factual source. Read `inputs/request.json` for the audience, language, title, Podcast Generation Brief, and exact child model. A one-generation instruction overrides a durable Podcast Preference when they conflict. Neither may expand the report's factual boundary. Preserve the report's core information density unless the brief explicitly requests different compression. Optimize for understanding by ear, not brevity or a predetermined duration.

The Root Prime owns planning, scope, terminology, final editing, and acceptance. Root delegates every substantive segment draft to a separate native `rlm()` child using the exact child model. Children do not plan the episode or perform the final edit.

Before acting, inspect existing artifacts. A valid plan, assignment, segment draft, ledger, or audit is a completed checkpoint. Continue only the unfinished workflow after an interruption.

## Phase 1: plan and delegate

Write `work/episode-plan.json`, then one `work/segments/<segment-id>/assignment.json` per segment. Organize by conceptual dependency rather than report headings. Assign every repeated concept, table, model family, benchmark, number group, and conclusion to one primary segment.

The plan must contain:

```json
{
  "title": "string",
  "audience": "string",
  "language": "string",
  "format": "single-narrator deep explainer",
  "thesis": "string",
  "listener_outcomes": ["string"],
  "concepts": [{
    "name": "string",
    "problem": "string",
    "mechanism": "string",
    "evidence": ["string"],
    "importance": "string",
    "misconception": "string",
    "boundary_or_tradeoff": "string",
    "audio_strategy": "string"
  }],
  "visual_conversions": [{
    "source_structure": "string",
    "argumentative_purpose": "string",
    "spoken_strategy": "string",
    "must_preserve": ["string"]
  }],
  "segments": [{
    "segment_id": "segment-001",
    "title": "string",
    "purpose": "string",
    "listener_question": "string",
    "owned_concepts": ["string"],
    "source_anchors": ["exact heading, table, or unique phrase"],
    "must_preserve_numbers": ["string"],
    "out_of_scope": ["string"],
    "transition_in": "string",
    "transition_out": "string"
  }]
}
```

`transition_in` and `transition_out` are Root's material for the merge, not segment content. A
segment's own text starts and ends inside its scope; the last segment has nothing to hand on to, so
its `transition_out` describes how Root closes the episode rather than anything a child writes.

Each assignment is the matching segment **without its `transition_in` and `transition_out`**, plus the global thesis, audience, language, voice contract, applicable Podcast Generation Brief, and `"contract": "inputs/segment-contract.md"`. A child that receives a transition writes it, and the contract forbids a child to write an opening, a transition or a closing, so the two would contradict each other. Start exactly one child per segment concurrently.

`inputs/segment-contract.md` is written by Runtime. It is the only definition of the child's read scope, `draft.txt` rules, and `ledger.json` fields; Runtime validates every segment against it. Every child task must name the segment ID and instruct the child to read the contract before drafting. Do not paraphrase the contract in the task or the assignment.

Each child reads only the Canonical Report, plan, its assignment, and the contract. It writes `work/segments/<segment-id>/draft.txt` and `work/segments/<segment-id>/ledger.json` exactly as the contract specifies.

## Phase 2: merge and review

After every segment child finishes, read all drafts and ledgers. Edit them into `work/grounded-script.txt`. Root owns the final wording of the opening, joins, and ending. This responsibility is fulfilled by editing the existing prose: reuse or reshape a useful conclusion already in a draft, and merge overlapping passages while retaining their distinct evidence and qualifications. Read each join in context before adding a transition or closing, so it advances the argument instead of restating the conclusion just heard. Harmonize terminology and let the episode conclude once. If a material draft is unusable, retry its child instead of silently drafting that scope from scratch.

Copy the merged text to `work/cold-read/grounded-script.txt`. Spawn two isolated children concurrently:

- `podcast-source-audit-initial` reads only the report, plan, ledgers, and grounded script. It writes `work/source-audit-initial.json`.
- `podcast-listener-cold-read` reads only the cold-read manuscript and `inputs/request.json` for the audience and Podcast Generation Brief. It writes `work/listener-review.json`. Assess clarity in that context; information density, technical depth, length, and tone follow the Brief, not an assumed generic listener. Without an explicit preference for compression, preserve the report's core information density. Identify avoidable repetition by quoting the overlapping passages and explaining whether each adds distinct meaning; useful recalls can support a new inference or action. Style observations are editorial suggestions, not independent acceptance criteria.

Source audits use:

```json
{
  "passed": true,
  "unsupported_claims": [],
  "numeric_mismatches": [],
  "missing_qualifications": [],
  "missing_concept_closures": [],
  "visual_relationship_errors": [],
  "notes": ["string"]
}
```

The listener review uses:

```json
{
  "verdict": "PASS or FAIL",
  "understood_thesis": "string",
  "understood_concepts": ["string"],
  "blockers": ["string"],
  "density_hotspots": ["string"],
  "report_like_passages": ["string"],
  "recommended_repairs": ["string"]
}
```

## Phase 3: final edit and audit

Use both reviews and the segment ledgers to produce one globally coherent manuscript. Verify review findings against the manuscript and report before editing. Apply style suggestions only when they serve the audience and Podcast Generation Brief; editorial changes must preserve factual qualifications and required conditions. The manuscript keeps one opening and one closing, which Root owns: a repair about how the episode ends rewrites that ending rather than adding another one after it. Improve breath, grouping, transitions, and listener retention without deleting evidence merely because it is technical. Explain what each material number proves. Introduce WER, CER, SIM, RTF, or other recurring metrics in plain language before using abbreviations.

Write the full edited manuscript to `work/podcast-script.txt`, then split it at semantic segment boundaries into `writer-output/sections/<segment-id>.txt`. The concatenated section files must equal the complete spoken manuscript apart from blank-line separators.

Spawn a fresh `podcast-source-audit-final` child. It reads only the report, plan, ledgers, and final manuscript and writes `work/source-audit-final.json`. Root may repair and re-audit once. Do not hide a remaining failure.

When the final audit passes, write `writer-output/review.json`:

```json
{
  "passed": true,
  "segment_children": ["segment-001"],
  "concept_closures_checked": ["string"],
  "visual_conversions_checked": ["string"],
  "numeric_claims_checked": 0,
  "initial_audit_repairs": ["string"],
  "listener_repairs": ["string"],
  "unsupported_claims": [],
  "numeric_mismatches": [],
  "missing_qualifications": [],
  "remaining_issues": []
}
```

Root never generates audio. Runtime validates and publishes the section files.

## Listening rules

- Table: state the question, comparison frame, overall pattern, decisive contrasts, exceptions, and implication. Do not read rows or cells in sequence.
- Chart: establish axes or range, then explain trend, turning point, anomaly, relative magnitude, and meaning.
- Architecture or process: follow one item through input, transformation, output, and failure points.
- Decision matrix: establish criteria, then explain which option fits which conditions.
- Formula: explain variables, direction of change, intuition, boundary, and evidentiary role. Do not read a symbol string.
- Citation: remove markers, URLs, footnotes, and bibliography entries. Retain natural attribution only when source identity changes evidence strength or claim ownership.

Do not assign filler quotas, manufacture banter, imitate a named living creator, or emit provider-specific TTS tags. Naturalization is accepted only when it has a clear explanatory or conversational function.
