---
name: prime-youtube-provider-skill
description: Discover and acquire YouTube metadata and transcripts for a Prime Search child explicitly assigned Provider 'youtube'; do not use for Root coordination or another Provider.
---

# YouTube Provider

Use the Python-backed Skill directly:

```python
import prime_youtube_provider_skill as youtube

rows = youtube.subscription_uploads(published_after="2026-07-19T00:00:00Z", max_results=100)
```

Do not enumerate the module, inspect its source, or read the complete API reference. Use
`help(youtube.<chosen_operation>)` when the selected operation's signature is unclear. Read
`references/API.md` only for an operation not covered here.

- Use `subscription_uploads()` for account-backed monitoring with an ISO 8601 `published_after` cursor.
- Use `next_page_token(rows)` and pass the opaque token back unchanged for paged operations.
- Filter channel or upload metadata before fetching full video details or transcripts.
- Resolve retained candidates with `video()` before applying an exact publication boundary when list timestamps are
  approximate.
- Use `transcript()` only when transcript evidence is required. Runtime owns cookies, yt-dlp, ASR, retries, and
  material acquisition.

Preserve transcript source, language, machine-generation, translation, and extractor metadata. Record each retained
Provider artifact path and use the shared builder to write the assigned Candidate Ledger exactly once:

```python
ledger = youtube.CandidateLedger()
ledger.add(
    title=title,
    url=url,
    query=discovery_query,
    summary=grounded_summary,
    metadata=provider_metadata,
    materials=transcript_rows,
)
ledger.write("work/youtube_candidates.json")
```
