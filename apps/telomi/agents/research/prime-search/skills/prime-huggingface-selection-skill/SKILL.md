---
name: prime-huggingface-selection-skill
description: Use Hugging Face Hub discovery, native search, exact lookups, Model Cards, and CandidateLedger for an assigned Hugging Face research task.
---

# Hugging Face

Use `import prime_huggingface_selection_skill as huggingface`. The module exposes the Hugging Face Provider operations
and the shared `CandidateLedger`. Every operation is a plain synchronous call that returns its records directly; do not
`await` it.

## Route the assignment

Read only the branch that owns the assigned evidence:

- [Papers](references/paper-workflow.md): paper search, Daily Papers, metadata and front preview, then full-text bundle acquisition.
- [Open-source models](references/model-workflow.md): model discovery, native filters, exact `model_info`, and selected Model Cards.
- [Datasets and leaderboards](references/dataset-workflow.md): dataset discovery, exact metadata, and reported benchmark rows.
- [Spaces](references/space-workflow.md): hosted application discovery and linked model or dataset evidence.

A branch may point to a narrower reference. Read that reference only when its stated condition applies. Resolve every
reference path relative to the directory containing this exact `SKILL.md`. Do not enumerate the module or inspect its
source. Use `help(huggingface.<operation>)` when a chosen operation's interface is unclear. Read `references/API.md`
only when `help()` is insufficient.

## Submit retained evidence

Preserve each discovery expression in `query` and keep returned Provider records unchanged. Write `summary` as concise
decision-relevant prose rather than copied Markdown, navigation, installation commands, or large tables. Deduplicate
only the stable native identity named by the selected branch.

Build the final output with `CandidateLedger()`. Pass the exact acquired Provider record in `materials`; the Ledger
derives Runtime-owned paths. Write `work/huggingface_candidates.json` once after every retained candidate has readable
material, then submit it through the Runtime Tool.

```python
ledger.add(
    title=title,
    url=url,
    query=discovery_query,
    summary=grounded_summary,
    metadata=provider_metadata,
    materials=[acquired_record],
)
ledger.write("work/huggingface_candidates.json")
```

Keep inaccessible candidates out of the Ledger without discarding other completed candidates. Report their exact
evidence gaps in the completion reply.
