---
name: wiki-report
description: Search and read the frozen Goal Wiki while writing a grounded report.
---

# Wiki Report

Use the preloaded `wiki_report` Python module. It is the only factual knowledge
interface available to the Report Writer.

```python
topics = await wiki_report.list_topics()
# Select a returned Topic only when its scope fits the question.
hits = await wiki_report.search("multilingual streaming TTS", top_k=10, topic_ref="T1")
page = await wiki_report.read_page(hits["results"][0]["page_ref"])
```

Topic refs belong to this frozen Wiki execution. Inspect the returned titles, intent, questions and scope before choosing a `T` ref. Omit `topic_ref` for a broad search, including pages outside every Topic. A zero `page_count` means no direct memberships, not that the original evidence is absent. Topic filtering searches the full matching pages.

Rules:

- Search before reading. Read only P-number Page refs returned by Wiki search.
- Cite only C-number refs returned in `read_page()["evidence"]`, using `<cite>C12</cite>`.
- Never copy Page paths, Entry hashes, or source URLs into Agent output. Runtime resolves short refs.
- Do not use web search, raw Sources, Cornell Notes, prior reports, or filesystem
  discovery as factual inputs.
- This skill is read-only. Write report artifacts only under `work/` and
  `writer-output/`.
