---
name: find-out-report
description: Read frozen Find Out Notes through notes_report while writing a grounded report - roster first, then drill into the Sources you chose.
---

# Find Out Report

`notes_report` is the only factual knowledge interface. The Notes are organized by Source, and every
operation can be narrowed to the Sources you name. Choose Sources from the roster; ranking is for
finding a specific fact inside a Source, never for deciding which Sources the report covers.

## Retrieval procedure

```python
import notes_report

# 1. The whole roster: every Source with its handle, title, origins, evidence_origins and Section titles.
#    evidence_origins says where the Notes anchor their evidence (a code repository, a paper, a page);
#    it is the roster's only signal of what depth a Source's Notes can carry.
#    Page it to the end — this is the only view that shows you everything that exists.
roster = await notes_report.summary()
while roster["next_offset"] is not None:
    roster = await notes_report.summary(offset=roster["next_offset"])

# 2. Choose the Sources this report will cover, then read only their Section summaries.
picked = ["@22", "@28", "@56"]
detail = await notes_report.summary(source=picked)

# 3. List and read the Notes of those Sources.
listing = await notes_report.catalog(source=picked)
notes = await notes_report.get(["N2", "N7"])

# 4. Search only to locate a specific fact, ideally inside Sources you already chose.
hits = await notes_report.search("CV3-Eval", source=["@28"])
```

`summary`, `catalog` and `search` report `next_offset`; follow it until `null` rather than guessing
a `limit` that fits. `get()` accepts up to 256 refs per request as input protection, not a target
batch size or a limit on how many Notes you may read overall. It returns Notes in request order
to a 12,000-character JSON budget, so short Notes can fit together while long Notes need more pages.
A single oversized Note is returned alone rather than omitted forever. No Note text is cut off.
Read the returned page, then pass only its `omitted_refs` to the next `get()` call; repeat until
none remain. Omitted Notes have not been shown and must not be cited as if already read.

## Rules

- Read the whole roster before choosing Sources, and choose from the roster. A Source you never
  looked at cannot be judged irrelevant.
- Treat each Note as one partial Source review, not a complete answer.
- A Source may serve more than one Section; each Section reads the cues it needs and the editorial plan names the primary one.
- Cite Notes as `<cite>N123</cite>` using refs returned by `notes_report.get()`. Runtime resolves
  each ref to its Source's canonical URL deterministically; a hand-typed URL can be wrong, a ref
  cannot. Use only claims returned by `notes_report.get()`.
- Child Agents may retrieve only the Note refs assigned by the root editorial plan.
- Retrieve and read one bounded page at a time. Make each `notes_report.get()` batch the final
  expression of its own IPython cell, consume it immediately, and do not fetch pages silently in a
  loop before combining or reprinting them as one large result.
- Do not use web search, a Wiki, raw Sources, filesystem Note files, previous reports, or model
  memory as factual inputs.
- Write report artifacts only under `work/` and `writer-output/`.
