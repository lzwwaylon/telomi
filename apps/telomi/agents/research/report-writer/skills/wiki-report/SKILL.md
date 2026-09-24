---
name: wiki-report
description: Search and read the frozen Goal Wiki while writing a grounded report.
---

# Wiki Report

Use the preloaded `wiki_report` Python module. It is the only factual knowledge
interface available to the Report Writer.

```python
hits = await wiki_report.search("multilingual streaming TTS", top_k=10)
page = await wiki_report.read_page(hits["results"][0]["page_ref"])
related = await wiki_report.graph_search("speech tokenizer", top_k=10)
```

Rules:

- Search before reading. Read only P-number Page refs returned by Wiki search or graph search.
- Cite only C-number refs returned in `read_page()["evidence"]`, using `<cite>C12</cite>`.
- Never copy Page paths, Entry hashes, or source URLs into Agent output. Runtime resolves short refs.
- Do not use web search, raw Sources, Cornell Notes, prior reports, or filesystem
  discovery as factual inputs.
- This skill is read-only. Write report artifacts only under `work/` and
  `writer-output/`.
