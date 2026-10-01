---
name: deep-search
description: Investigate a Goal question through saved knowledge, Cornell reading of original materials, and ordinary Provider acquisition when an allowed evidence gap remains.
---

# Deep Search

Read `inputs/request.json` for the complete question, conversation, language and source restrictions. Paths resolve from this execution's working directory. The staged Skill is `skills/root-agent/deep-search/SKILL.md`. In IPython, import the following synchronous functions from `research_runtime`; call them without `await`:

- `knowledge_search(query: str, *, limit: int = 10)`
- `deep_search(question: str)`
- `external_search(question: str)`
- `write_answer(evidence_refs: list[str], requirements: list[str])`
- `read_handoff(receipt: dict)`

After selecting `evidence_refs` from this invocation's mapped Cues:

```python
requirements = ["Explain the requested mechanism with evidence"]
writer_receipt = write_answer(evidence_refs, requirements)
```

Both Writer arguments are lists, including a single requirement. Operations return receipts with `result_ref`, `sha256` and `byte_length`; Runtime has already published the complete JSON under read-only `inputs/handoff/`. `read_handoff` loads it silently into a Python variable.

For a continued thread, load `thread_ref` and `previous_evidence_ref` into variables first. Use progress and relevant Cue summaries to identify which parts are already established and which changed. Open a historical answer only for a specific remaining question. Reuse sufficient current mapped refs directly; a fresh Session alone calls for no new search. If a detail is missing, search Goal knowledge once. Its result contains Wiki leads and saved Cornell/Deep Search Cues. Keep complete objects in variables; never print serialized objects or sliced JSON prefixes. Select the question's entity before its requested subtopic. Start with a small index, such as `print([(c["ref"], c["cue"]) for c in selected_cues[:10]])`, then inspect only the relevant Notes and source locators. Omit global summaries repeated on every Cue, file inventories and repeated metadata. Measure the chosen text before printing: total visible output must stay below 8000 characters per IPython cell. Split necessary long Notes or original passages at line or paragraph boundaries into separate cells. A Wiki omission does not establish that original material is absent.

When existing evidence is insufficient, give `deep_search` a self-contained **incremental** question: identify the unresolved requested part and the relevant source or version, and distinguish it from facts already checked. Runtime gives the Reader the original user question, the currently registered Cues with Source anchors, and the Goal's pinned originals. Those Cues are navigation for avoiding repeated verification; original text remains authoritative. Recheck established facts when scope, versions or evidence disagree. The Reader chooses original files and writes new Cue Notes and gaps. Load its receipt and inspect relevant conclusions; this call does not search the web. Preserve the user's topic: deployment context or a product-suggestion request is not permission to start another model landscape or unrelated comparison.

Review the requested parts against the returned Notes and their evidence, including each Source's title and URL. Preserve the representation and variable meanings established by the code; a model name does not establish them. Do not transfer claims between repositories or versions without checking their relevant implementations. If a Note omits a requested detail or disagrees with its excerpt, ask deep_search to verify the unresolved part in the available materials before declaring it unavailable. A reader's found status does not replace your coverage check. Include every unfulfilled requested part in the final gaps; qualify conclusions to the implementation actually verified.

When a specific evidence need remains and `external_allowed` is true, call `external_search` with that need and the user's source restrictions. Use canonical URLs present in relevant evidence and original excerpts. An inferred repository owner or example is a discovery lead, not an additional restriction. When identity is unresolved, state the product and required official evidence so acquisition can discover the canonical entity. This stage uses ordinary Prime Search and native Provider children, retains materials, and has Cornell verify new Sources with the saved reading context. Its receipt contains status, summary, gaps, Cues and pinned Sources. Review these Cues before citing them. Acquire again only for a distinct unresolved need; retain access failures and unresolved facts as explicit limits.

Before synthesis, map **each requested part** to its available Cues and remaining gap. Collect current refs from the selected objects and merge relevant restored, local and newly acquired evidence; newly acquired evidence does not replace existing implementation evidence. The Writer can use only its assigned frozen materials. Complete the mapping before `write_answer(evidence_refs, requirements)` so a known local fact is not omitted from an otherwise supported answer. Derive a list of requirements from the complete question and keep suggestions within that question's purpose. Runtime freezes the selected evidence and original Source context for one fresh Writer. Load its receipt, review coverage/gaps, and inspect only necessary answer passages.

Review the Writer's coverage and gaps. A discrepancy between a Note and the original or a missing requested part calls for targeted deep_search on available material; use external_search only when missing evidence needs acquisition and access permits it. Give a subsequent Writer delegation the updated refs and any corrected requirements. Avoid repeating the same unsuccessful reading or acquisition; unresolved parts can be delivered explicitly as a partial answer. When no evidence exists, still delegate to the Writer with an empty ref list and the actual question so its answer states the available limit.

Write work/result.json with exactly {"answer_ref": writer_receipt["result_ref"]}, using the most recent Writer receipt. Runtime checks the path against its registered latest Writer receipt, verifies the frozen bytes and resolves the original Writer answer, citation_refs and gaps for delivery. A complete receipt object is also accepted. Keep coverage as a coordination artifact. Cite tags use only the assigned C or N refs; Runtime maps them to durable evidence and display numbers. The coordinating Root does not rewrite factual prose after the Writer checked it.

Finish through Python's standard library: write a temporary file then replace work/result.json, so Runtime never accepts partial JSON. Historical Replay may explicitly set PRIME_INVESTIGATION_HANDOFF_MODE=inline: read_handoff then accepts the old complete result, and that old protocol submits the Writer's answer, citation_refs and gaps as three fields. Production uses the file protocol.
