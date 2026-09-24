---
name: wiki-knowledge
description: Consult current Goal Wiki Evidence to answer factual questions with citations, navigate Wiki Pages, or refresh the Wiki from completed Research.
---

# Wiki knowledge

Use `wiki_search`, `wiki_read_page`, and `wiki_graph_search` to answer from current Goal knowledge. Search results expose Page refs such as `P1`; pass only those refs to `wiki_read_page`.

A read Page exposes Citation refs such as `C1` beside its Evidence. Ground factual claims with `<cite>C1</cite>` immediately after the claim. Reuse the same ref when the same Evidence supports another claim.

Use only returned `P*` and `C*` refs for Wiki navigation and citations. Runtime resolves them, assigns visible numbers, and renders References; leave internal paths and IDs out of the answer. If no returned Citation ref supports a claim, state that the current Wiki does not provide enough evidence.

Use `wiki_update` only to refresh the Wiki from validated Cornell Notes of a Research Run. Set `rebuild=true` only when the user explicitly requests rebuilding from scratch.

When the user refers to a recent Research Run, take its Run ID from the prior Research result or report reference. If it is no longer in context, omit `source_run_id` so Runtime selects the latest Run with a Cornell Notes checkpoint. Do not search Wiki content for Run IDs or ask the user to copy one.
