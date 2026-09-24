---
name: prime-user-documents-provider-skill
description: Find evidence in user-provided workspace documents for a Prime Search child explicitly assigned Provider 'user_documents'; do not use for Root coordination or another Provider.
---

# User Documents Provider

Use the Python-backed Skill directly:

```python
import prime_user_documents_provider_skill as user_documents

rows = user_documents.search("evaluation methodology and reported limitations", max_results=20)
```

Do not enumerate the module or inspect its source. Use `help(user_documents.search)` if its signature is unclear;
`references/API.md` contains the generated interface reference.

Search only for evidence required by the assignment. Preserve the returned document identity, content path, and
Provider metadata unchanged. Do not use this Provider to search external sources, and do not copy or rewrite the
document when Runtime already returned an artifact path.

Use the shared builder to deduplicate by canonical document URL and write the assigned Candidate Ledger exactly once:

```python
ledger = user_documents.CandidateLedger()
ledger.add(
    title=title,
    url=url,
    query=discovery_query,
    summary=grounded_summary,
    metadata=provider_metadata,
    materials=[provider_row],
)
ledger.write("work/user_documents_candidates.json")
```
