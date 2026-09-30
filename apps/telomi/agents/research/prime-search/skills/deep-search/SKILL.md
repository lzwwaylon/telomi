---
name: deep-search
description: Investigate a Goal question through saved knowledge, Cornell reading of original materials, and ordinary Provider acquisition when an allowed evidence gap remains.
---

# Deep Search

In IPython, import knowledge_search, deep_search, external_search, and write_answer from research_runtime. They are synchronous Python functions: call them without `await`. Start with one knowledge_search call for the user's question. It returns published Wiki leads, historical Cornell Cues, and saved Deep Search Cues with short citation refs for this investigation. Examine the returned coverage; a Wiki miss does not mean an original file or an old Note is absent.

If the existing knowledge does not support the requested detail, call deep_search with a self-contained question. Runtime gives the reader the Goal's saved original material. The reader chooses files and returns Cue Notes and gaps. This call does not search the web. Do not write or revise the reader's Notes yourself.

Review the requested parts against the returned Notes and their evidence, including each Source's title and URL. Preserve the representation and variable meanings established by the code; a model name does not establish them. Do not transfer claims between repositories or versions without checking their relevant implementations. If a Note omits a requested detail or disagrees with its excerpt, ask deep_search to verify the unresolved part in the available materials before declaring it unavailable. A reader's found status does not replace your coverage check. Include every unfulfilled requested part in the final gaps; qualify conclusions to the implementation actually verified.

If an evidence gap remains and `external_allowed` is true, call external_search with a self-contained description of the missing evidence, preserving the user's source restrictions and requested scope. This stage runs the ordinary Prime Search discovery and Provider selection flow, including native Provider children, material retention and Source validation. It can discover appropriate sources without a known repository, URL or file path. Runtime then has the Cornell reader verify the question against the newly pinned material and relevant saved Sources. The return has `status`, `summary`, `gaps`, and `cues`, like deep_search, plus pinned `sources`. Review the returned Cues before using their refs. Continue acquisition only for a specific unresolved evidence need. When external access is disallowed or acquisition fails, explain the remaining gap without inventing support.

Delegate synthesis through write_answer(evidence_refs, requirements). Derive the requirements from the complete user's question, and collect the assigned C and N refs programmatically from the returned pages and Cues. Keep complete results in variables; inspect refs, summaries and gaps in bounded groups instead of slicing a serialized result and silently losing the rest. Runtime freezes the assigned evidence and original Source context for a single Report Writer. The Writer returns answer, citation_refs, gaps and coverage.

Review the Writer's coverage and gaps. A discrepancy between a Note and the original or a missing requested part calls for targeted deep_search on available material; use external_search only when missing evidence needs acquisition and access permits it. Give a subsequent Writer delegation the updated refs and any corrected requirements. Avoid repeating the same unsuccessful reading or acquisition; unresolved parts can be delivered explicitly as a partial answer. When no evidence exists, still delegate to the Writer with an empty ref list and the actual question so its answer states the available limit.

Copy the most recent Writer's answer, citation_refs and gaps unchanged into work/result.json. Keep coverage as a coordination artifact, outside the final three-field result. Cite tags use only the assigned C or N refs; Runtime maps them to durable evidence and display numbers. The coordinating Root does not rewrite factual prose after the Writer checked it.

Finish by writing work/result.json through Python's standard library. Include the complete answer, the distinct citation refs it uses, and unresolved gaps. Write a temporary file then replace it, so Runtime never accepts partial JSON.
