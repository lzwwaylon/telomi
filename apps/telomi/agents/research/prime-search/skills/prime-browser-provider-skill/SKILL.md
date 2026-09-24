---
name: prime-browser-provider-skill
description: Explore assigned websites from explicit starting URLs to discover and retain original material for a bounded Evidence Need.
---

# Browser Provider

## Check the assignment

Start with the assigned HTTP(S) URLs, Evidence Need, navigation scope and any time constraints. If entry URLs or the website scope are missing, return the missing prerequisite to Root before browsing. Use `import prime_browser_provider_skill as browser` in ipython (plain synchronous calls; do not search the filesystem for modules). The module exposes the Runtime-owned Browser session and evidence retention; [references/API.md](references/API.md) lists every function with its signature. General search engine queries belong to Root's `research_runtime.search_general_web`; do not open search engines to discover which websites to investigate.

## Explore the websites

Open an assigned entry and inspect its navigation, categories, archives and links. Choose paths whose visible content could satisfy the Evidence Need. Follow relevant links within the assigned website scope; return promising out-of-scope URLs to Root for a follow-up assignment. An unavailable entry is a reported gap, not permission to guess another website.

Run one command at a time while learning the site's structure; each call returns the command output:

```python
import prime_browser_provider_skill as browser

browser.open("https://example.com")
print(browser.snapshot())
```

Replace example URLs with assigned entries or links observed during exploration. Read a link's `href` with `get attr` and open that URL directly. Re-snapshot after navigation or dynamic DOM changes; use refs only from the latest snapshot. For feeds, timelines, pagination or relative-time windows, read [Dynamic feeds](references/dynamic-feeds.md).

Once the path is known, combine stable reads into one program; it stops at the first failing command and returns every executed step:

```python
browser.open("https://example.com")
title, url, body = browser.get("title"), browser.get("url"), browser.get("text", "body")
```

`browser.program([[...], [...]])` runs a fixed command sequence and stops at the first failure; `browser.run(*args)` runs any other Browser command.

Navigation and interaction are available: `open`, `read`, `snapshot`, `get`, `find`, `click`, `scroll`, `wait`, `fill`, `select`, `back`. Runtime blocks only what could leak data or take over the browser (`eval`, `upload`, `download`, `screenshot`, `pdf`, session and connection commands). A rejected or malformed command raises with its usage; `browser.help()` returns the whole command list. Do not submit forms that post content to a website; report a blocked path requiring human action when access needs CAPTCHA, 2FA or a hardware key, and continue other independently accessible assigned paths.

## Retain evidence

For each relevant page, record its canonical URL, title, visible date when relevant, and body text returned by `browser.get("text", ...)` or `browser.read()` during this assignment. Distinguish absent facts from unsupported inference. Retain the rendered page:

```python
materialize_result = browser.materialize_page()
```

For a retained attachment, use its current snapshot ref. Use `url` only for a public direct HTTP(S) file observed within the assigned scope:

```python
browser.materialize_element("@e42")
browser.materialize_url("https://example.com/report.pdf")
```

Pass the complete `materialize_source` result to the shared builder. Preserve the actual discovery query, or the assigned entry URL when exploration began directly from that URL:

```python
ledger = browser.CandidateLedger()
ledger.add(
    title=title,
    url=url,
    query=discovery_query,
    summary=grounded_summary,
    metadata=provider_metadata,
    materials=[materialize_result],
)
```

The builder derives material paths from those results; pass them unchanged. Read a Skill reference with `browser.read_skill("skills/<skill>/references/<file>.md")` only when its stated condition applies; Runtime records that read.

## Complete the assignment

Finish when retained evidence satisfies the assigned scope, the relevant navigation paths are exhausted, or remaining paths are blocked. For requests requiring exhaustive coverage or a complete time interval, finding one relevant page is insufficient. Account for each assigned entry and any unmet part of the Evidence Need.

Write `ledger.write("work/browser_candidates.json")` as the final filesystem action, then call `submit_candidate_ledger(provider_id="browser")`. Repair the same file and retry on validation failure. Submit an empty Ledger when nothing qualifies; distinguish no findings from access failure in the native completion reply. After successful submission, return a compact coverage summary, useful discovered URLs and unresolved gaps to Root.
