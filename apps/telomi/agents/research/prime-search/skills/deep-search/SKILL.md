---
name: deep-search
description: Investigate a Goal question through saved knowledge, Cornell reading of original materials, and versioned GitHub code when an allowed implementation gap remains.
---

# Deep Search

In IPython, import knowledge_search, deep_search, and github_read from research_runtime. They are synchronous Python functions: call them without `await`. Start with one knowledge_search call for the user's question. It returns published Wiki leads, historical Cornell Cues, and saved Deep Search Cues with stable citation refs. Examine the returned coverage; a Wiki miss does not mean an original file or an old Note is absent.

If the existing knowledge does not support the requested detail, call deep_search with a self-contained question. Runtime gives the reader the Goal's saved original material. The reader chooses files and returns Cue Notes and gaps. This call does not search the web. Do not write or revise the reader's Notes yourself.

If a specific code implementation remains unresolved, `external_allowed` is true, and a repository, version, and candidate file paths can be identified, call github_read(question, repository, ref, paths). Select the missing implementation, not files the local reader already examined. It uses the GitHub Provider to pin those files and has the same Cornell reader verify them. The return has `status`, `summary`, `gaps`, and `cues`, like deep_search, plus pinned `sources`. Treat a repository or path inferred from context as a locator to verify, never as evidence. Use the returned Cue refs only after reading the result. When external access is disallowed, the locator is too uncertain, or acquisition fails, explain the remaining gap.

Use a returned cite_ref exactly inside <cite>REF</cite> after the claim it supports. If the reader reports no evidence, state the checked limit and gap without inventing an answer. Do not print large result objects into the model context; inspect relevant Cue Notes and evidence in compact slices.

Finish by writing work/result.json through Python's standard library. Include the complete answer, the distinct citation refs it uses, and unresolved gaps. Write a temporary file then replace it, so Runtime never accepts partial JSON.
