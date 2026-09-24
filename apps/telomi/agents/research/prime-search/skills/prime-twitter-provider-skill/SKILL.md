---
name: prime-twitter-provider-skill
description: Discover and acquire authenticated X/Twitter evidence for a Prime Search child explicitly assigned Provider 'twitter'; do not use for Root coordination or another Provider.
---

# X/Twitter Provider

Use the Python-backed Skill directly:

```python
import prime_twitter_provider_skill as twitter

rows = twitter.search('"agent evaluation" lang:en -filter:replies', product="latest", max_results=50)
```

Do not enumerate the module, inspect its source, or read the complete API reference. Use
`help(twitter.<chosen_operation>)` when the selected operation's signature is unclear. Read
`references/API.md` only for an operation not covered here.

- Use native X query syntax in `search()`.
- Call `profile()` once when a numeric user ID is useful. User-scoped reads accept a handle or numeric ID.
- Pass opaque cursors back unchanged. Paginate to the terminal cursor only for explicitly exhaustive assignments.
- Treat bookmarks, home timelines, notifications, lists, and trends as private session-scoped evidence and use them
  only when the assignment requires them.
- Provider rows already contain authenticated post, article, thread, profile, or timeline content. Do not revisit
  public X URLs or use Browser.

Preserve every relevant unique Provider record and its discovery query. Pass the returned row directly to the shared
builder. The deterministic SDK uses a Runtime artifact when present and serializes pathless Provider records itself.
Do not create or name material files. Write the assigned Candidate Ledger exactly once:

```python
ledger = twitter.CandidateLedger()
ledger.add(
    title=title,
    url=url,
    query=discovery_query,
    summary=grounded_summary,
    metadata=provider_metadata,
    materials=[provider_row],
)
ledger.write("work/twitter_candidates.json")
```
