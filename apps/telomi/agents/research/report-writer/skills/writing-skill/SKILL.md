---
name: writing-skill
description: Shape an evidence-grounded research report and run deterministic Chinese prose diagnostics. Use for Report Writer structure and final editing, not for search, source selection, memos, social posts, or publishing.
---

# Research Report Writing

This Skill is mounted inside an unattended Report Writer stage. The task defines the audience, frozen evidence and output contract for a report or investigation answer. Follow that stage's factual boundary and output contract. Do not ask the user questions, start extra model conversations, call external writing tools, or change the orchestration supplied in the user prompt.

## Structure

When the structure is yours to decide, use the research question and frozen evidence rather than a reusable template.

Read [the thesis catalog](./references/reference_writing_thesis_catalog.md) and [prose guide](./references/bestpractice_external_prose.md). They apply to every report language.

Choose one responsibility per Section, assign repeated entities and explanations to one primary Section, and keep limitations near the claims they qualify. The stage prompt remains authoritative for Source retrieval, child assignments, citations, paths, and output files.

## Final edit

Edit the child drafts as one report: remove repeated explanations, harmonize terminology, preserve evidence gaps, and keep every factual claim within the frozen citation boundary. Do not add facts from memory.

For a Chinese report, build `work/final-check.md` by prefixing each edited Section body with its materialized outline title as `## <title>`, then run the deterministic diagnostic in IPython. Keep the actual `writer-output/sections/` files body-only as required by the stage contract.

```python
report = await writing_skill("work/final-check.md")
print(report)
```

Read [the lint reference](./references/external_prose_lint.md) when interpreting findings. Fix mechanical problems that are real for this report; the diagnostic is not a semantic judge and does not replace citation or report-contract validation. For a report in any other language, skip this Chinese-specific diagnostic.

For a full Chinese report, Runtime independently reconstructs the final Section text from the validated Writer output, reruns the same scanner and publishes its diagnostic. It does not trust the Agent's check file as publication evidence. Never claim the diagnostic ran when the callable failed.
