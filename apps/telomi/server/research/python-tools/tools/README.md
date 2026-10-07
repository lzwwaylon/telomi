# Prime Provider Python SDK

Use these modules like ordinary Python libraries. Functions return Python data
directly, so a pipeline can search, parse, filter, join, and write results
without an intermediate command or plan file.

Record dictionaries combine several resource types, so fields documented by a
TypedDict can be absent. Use `record.get("field")` for optional metadata.

Use only the Provider assigned to this child. Read its assigned Provider Skill
for discovery, acquisition and pagination guidance; its Python-backed module
reuses this SDK. Use `help(function)` when a selected operation's signature is
unclear, and the Skill's generated `references/API.md` for advanced operations.
The mounted Python module is authoritative for exact signatures.

Provider children discover candidates, acquire the material required by their
Evidence Need, and write the assigned Candidate Ledger with `CandidateLedger`.
Keep actual discovery queries and Provider material results. Runtime owns IDs,
provenance validation and immutable Source publication. Write
`work/<provider_id>_candidates.json`, then call
`research_runtime.finish(provider_id=...)`. Repair that file on validation
failure; successful submission ends acquisition. Root orchestrates children and
reviews their completion replies rather than downloading their selected material.

## github

Import:

```python
from tools import github
```

Read-only discovery and inspection:

- `github.search_repositories(query, *, max_results=20)`
- `github.get_repository(repository)`
- `github.search_code(query, *, repository=None, max_results=20)`
- `github.search_issues(query, *, repository=None, state="all", match=None, max_results=20)`
- `github.get_issue(repository, number)`

`search_issues` discovers candidates. Set `match="comments"` to search comment
text, then call `get_issue` to retrieve the selected Issue body and complete
structured comment thread.

Provider children acquire the selected repository, files or release material
through `clone_repository`, `download_file` or `download_release` according to
the assigned Evidence Need. Preserve Runtime-returned material in the Ledger;
do not substitute metadata for required original material.

## arxiv

Import:

```python
from tools import arxiv
```

Main functions:

- `arxiv.search(query, *, limit=20, sort_by="submittedDate", sort_order="descending", http_method="auto", purpose=...) -> list[Paper]`
- `arxiv.native_query(*, search_query=None, id_list=None, start=0, max_results=10, sort_by=None, sort_order=None, http_method="auto", purpose=...) -> list[Paper]`
- `arxiv.fetch_ids(arxiv_ids, *, search_query=None, max_results=None, ...) -> list[Paper]`
- `arxiv.paper_profile(arxiv_ids, *, depth="metadata"|"front", purpose=...) -> list[PaperProfile]`
- `arxiv.field(name, value, *, phrase=False) -> str`
- `arxiv.submitted_date(start, end) -> str`

`limit` is the final result bound for each expression. `arxiv.search(...)`
automatically makes continuous Provider requests when `limit` exceeds 100.
Page offsets are not exposed by the high-level search interface. Invalid local
arguments raise `ValueError` before Runtime is called.

For complete arXiv discovery with a deterministic query or date boundary,
loop `arxiv.native_query(...)` with `start` and `max_results` as a technical
page batch. Continue until `metadata["arxiv_feed"]["total_results"]` proves the
terminal boundary, or until a short or empty page when that metadata is absent.
`max_results` controls only the request window and must not define the final
result count.

`query` may be one native expression or a sequence of expressions:

```python
papers = arxiv.search(
    [
        'ti:"agent skill"',
        'abs:"agent skill"',
        "cat:cs.AI AND all:self-evolving",
    ],
    limit=100,
)
```

Native fields include `ti`, `au`, `abs`, `co`, `jr`, `cat`, `rn`, `id`, and
`all`. Native expressions support `AND`, `OR`, `ANDNOT`, parentheses, quoted
phrases, and `submittedDate` ranges.

Every paper is a dictionary with this shape:

```python
{
    "id": "arxiv-provider-record-id",
    "title": "Paper title",
    "url": "https://arxiv.org/abs/2602.12670v4",
    "snippet": "Abstract text...",
    "published_at": "2026-02-13",
    "authors": ["Author One", "Author Two"],
    "metadata": {
        "arxiv_id": "2602.12670",
        "arxiv_version_id": "2602.12670v4",
        ...
    },
}
```

Provider children discover through Atom metadata and acquire retained papers
through `download_pdf`. Read the arXiv ID from `metadata["arxiv_id"]` or
the versioned ID from `metadata["arxiv_version_id"]`; pass acquired material
unchanged to the Ledger builder.

## huggingface

Import:

```python
from tools import huggingface
```

Only the Source module assigned to the current Worker is mounted. Main
functions:

- `huggingface.papers_search(query, *, max_results=20, purpose=...)`
- `huggingface.list_daily_papers(*, date=None, week=None, month=None, submitter=None, sort: Literal["published_at", "trending"] | None=None, page=0, max_results=20, purpose=...)`
- `huggingface.paginate_daily_papers(*, total_results, page_size=100, start_page=0, date=None, week=None, month=None, submitter=None, sort: Literal["published_at", "trending"] | None=None, purpose=...)`
- `huggingface.paper_info(paper_ids, *, purpose=...)`
- `huggingface.paper_profile(paper_ids, *, depth="metadata"|"front", purpose=...)`
- `huggingface.download_paper(paper_ids, *, purpose=...)`
- `huggingface.model_info(model_ids, *, revision=None, purpose=...)`
- `huggingface.models(*, search=None, filters=(), sort=None, max_results=20, cursor=None, ...)`
- `huggingface.dataset_info(dataset_ids, *, revision=None, purpose=...)`
- `huggingface.dataset_leaderboard(dataset_id, *, max_results=20, purpose=...)`
- `huggingface.datasets(*, search=None, filters=(), sort=None, max_results=20, cursor=None, ...)`
- `huggingface.spaces(*, search=None, filters=(), models=(), datasets=(), max_results=20, cursor=None, ...)`
- `huggingface.paginate_models`, `paginate_datasets`, and `paginate_spaces`

Use `papers_search` for keyword queries. Use `model_info` or `dataset_info`
only when Root's assignment explicitly supplies the exact repository ID,
or after discovery returns that ID. Use
`dataset_leaderboard` only for benchmark datasets with submitted evaluations.
The two Daily Papers functions do not accept `query`; they only list or
paginate the Daily Papers feed.

Paper acquisition is progressive: use search or Daily Papers for discovery,
`paper_profile(depth="metadata")` for the first shortlist,
`paper_profile(depth="front")` for a bounded Markdown preview, and
`download_paper()` only for retained papers. Each download returns a directory
containing `paper.md` and `metadata.json`; the JSON preserves the native paper
record and normalizes project, GitHub, page, Markdown, and PDF links. Pass the
download result unchanged to `CandidateLedger` so the complete directory
becomes the Source Snapshot.

For complete model or dataset discovery, loop `models(...)` or `datasets(...)`
with `metadata["huggingface_page"]["next_cursor"]` until the cursor is absent or
repeats. Pass the opaque cursor back unchanged. `max_results` is only a page
batch and must not define the final result count. The `paginate_models` and
`paginate_datasets` helpers intentionally stop at `total_results`, so use them
only when the assignment itself calls for a bounded acquisition.

Result metadata identifies `resource_type` and includes a pinned
`document_url` when a repository SHA is available. Paper metadata includes
`pdf_url`. For ordinary filtering, stable Hugging Face fields are also exposed
at the top level:

```python
{
    "id": "huggingface-provider-record-id",
    "title": "owner/repository",
    "url": "https://huggingface.co/owner/repository",
    "repo_id": "owner/repository",
    "resource_type": "model",
    "downloads": 1234,
    "likes": 42,
    "pipeline_tag": "sentence-similarity",
    "library_name": "transformers",
    "created_at": "...",
    "updated_at": "...",
    "document_url": "https://huggingface.co/.../raw/<sha>/README.md",
    "metadata": {...},
}
```

Paper rows similarly expose `paper_id`, `upvotes`, and `pdf_url`. These fields
are copied from `metadata`; Runtime validates the child's submitted Ledger and
material before assigning published Source identities.

## twitter

Import:

```python
from tools import twitter
```

The module exposes every supported read operation:

- `twitter.search(query, *, product="top", max_results=20, cursor=None, ...)`
- `twitter.profile(username=None, *, user_id=None, ...)`
- `twitter.tweets(user=None, *, max_results=20, cursor=None, ...)`
- `twitter.thread(tweet, *, max_results=100, cursor=None, ...)`
- `twitter.article(tweet, ...)`
- `twitter.timeline(*, feed="for_you", max_results=20, cursor=None, ...)`
- `twitter.following`, `twitter.followers`, and `twitter.likes`
- `twitter.bookmarks`
- `twitter.lists` and `twitter.list_tweets`
- `twitter.device_follow`, `twitter.notifications`, and `twitter.trending`
- `twitter.media(*, user=None, tweet_id=None, max_results=20, cursor=None, ...)`

All operations are read-only. `media` returns direct media metadata and URLs;
it does not write or download files. User-scoped functions accept a handle or
numeric user ID. A handle lookup is a separate audited Provider call.

For discovery with a deterministic query or time boundary, pass the opaque
cursor in returned metadata back unchanged until the terminal cursor.
`max_results` is only a page batch and must not define the final result count.

```python
recent = twitter.search(
    '"agent evaluation" lang:en -filter:replies',
    product="latest",
    max_results=50,
)
posts = twitter.tweets("OpenAI", max_results=50)
saved = twitter.bookmarks(max_results=50)
```

Native search operators such as `from:`, `filter:`, `-filter:`, `lang:`,
`since:`, and `until:` are passed through unchanged. Results promote stable
fields such as `text`, `tweet_id`, `user_id`, `author`, engagement counts,
`media_urls`, and `next_cursor` to the top level. Cursors are opaque and must
be passed back unchanged.

The Worker never receives the Cookie header, CSRF token, web bearer token, or
direct network access. Runtime validates, schedules, caches, and records each
request before the Host service injects the local X session.

Provider results contain authenticated post, article, thread, profile, or
timeline content and metadata. Never revisit the public X URL. The Provider
child passes retained results to the Ledger builder for materialization.

## user_documents

Import:

```python
from tools import user_documents
```

Search documents attached to the current workspace:

```python
rows = user_documents.search(
    ["evaluation methodology", "reported limitations"],
    max_results=20,
)
```

The returned records use the same Runtime-owned candidate shape as other
Providers. The Provider child passes retained document records to the Ledger
builder; Runtime preserves their original and readable material.

## youtube

Import:

```python
from tools import youtube
```

Main functions:

- `youtube.capabilities() -> list[YouTubeRecord]`
- `youtube.next_page_token(rows) -> str | None`
- `youtube.subscriptions(*, max_results=50, page_token=None) -> list[YouTubeRecord]`
- `youtube.subscription_uploads(*, published_after=None, channel_ids=(), include_shorts=True, include_live=True, max_results=100) -> list[YouTubeRecord]`
- `youtube.channel_videos(channel, *, published_after=None, max_results=50, page_token=None) -> list[YouTubeRecord]`
- `youtube.playlist_videos(playlist, *, max_results=50, page_token=None) -> list[YouTubeRecord]`
- `youtube.search(query, ...) -> list[YouTubeRecord]`
- `youtube.video(video_or_url) -> list[YouTubeRecord]`
- `youtube.recommendations(...)`, `youtube.watch_later(...)`, and `youtube.history(...)` each return `list[YouTubeRecord]`

YouTube functions expose business parameters only. They do not accept
`purpose`, `allow_asr`, or `stt_provider`; Runtime owns audit labels and the
ASR Provider choice. The Provider child acquires required transcript evidence
through `youtube.transcript` after selection.

Use `subscription_uploads` for scheduled monitoring and pass the prior successful
sync timestamp as `published_after`. Every operation uses Host-owned yt-dlp with
public operations remaining Cookie-free. Account operations use the Host's
`PI_YOUTUBE_YTDLP_COOKIE_FILE`: the user's own value when configured, otherwise a
cookie file retained from the managed browser's login. Browser synchronization
refreshes that file when the browser is read; a stopped browser leaves the saved
credential unchanged. `PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER` selects a
browser profile directly instead. Cookie files must be absolute, no larger than
10 MiB, and readable only by their owner. The Worker does
not choose authentication, parse URLs, or receive Cookie configuration.

For paged operations, call `youtube.next_page_token(rows)` and pass the returned
opaque value to the next request. Filter candidates from list metadata before
calling `youtube.video`. The Provider child retrieves required transcripts for
selected videos through `youtube.transcript`.
Channel-list timestamps marked
`timestamp_precision="approximate"` use a conservative one-day overlap around
`published_after`; call `youtube.video` for retained candidates to apply the
exact time boundary.

Every video record exposes stable fields from metadata when available:

```python
{
    "id": "youtube-provider-record-id",
    "title": "Video title",
    "url": "https://www.youtube.com/watch?v=...",
    "description": "Full YouTube video description, including author links",
    "published_at": "2026-07-20T00:00:00Z",
    "video_id": "...",
    "channel_id": "...",
    "channel_title": "...",
    "duration_seconds": 1234,
    "caption_available": True,
    "metadata": {
        "discovery_source": "subscription_uploads",
        "transcript_status": "available",
        "transcript_kind": "manual",
        ...
    },
}
```

Treat page tokens as opaque. Provider children use metadata for discovery and
retain acquired transcripts in their Candidate Ledger.
Transcript documents retain the original video description as a
`Video Description` section before the transcript so downstream Agents can
inspect and cite author-provided project, repository, and demo links.
When the original video exposes chapters, the returned CanonicalDocument
contains chapter headings in `outline` and node-linked ranges in `timeline`.

Known-video Metadata lookup:

```python
rows = youtube.video("video-id-or-url")
if len(rows) != 1:
    raise RuntimeError(f"expected one video record, got {len(rows)}")
```

## browser

Import:

```python
from tools import browser
```

The Browser child drives a Runtime-owned agent-browser session; every call runs through Runtime,
which keeps the session, the pool and the retained files:

- `browser.open(url)`, `browser.read(url=None)`, `browser.snapshot(interactive=True, urls=False, compact=False, depth=None, selector=None)`
- `browser.get("title" | "url")`, `browser.get("text" | "html" | "value" | "count" | "box" | "styles", selector)`, `browser.get("attr", selector, name)`
- `browser.click(selector, new_tab=False)`, `browser.find(locator, value, action, text=None)`, `browser.fill`, `browser.select`, `browser.press`, `browser.scroll`, `browser.wait`, `browser.back`
- `browser.run(*args)` for any other agent-browser command and `browser.program([...])` for a sequence that stops at the first failure
- `browser.materialize_page()`, `browser.materialize_element("@e12")`, `browser.materialize_url(url)` retain evidence for `CandidateLedger.add(materials=[...])`
- `browser.help()` returns the Runtime's command list; a rejected or malformed command raises with its usage line
- `browser.read_skill("skills/...")` reads a staged Skill reference through Runtime

Blocked by Runtime: `eval`, `upload`, `download`, `screenshot`, `pdf`, and session or connection commands.

## Building a pipeline

Use native Python calls for discovery, acquisition and pagination. A fixed ID
or URL supplied by the assignment may use direct lookup. For discovery, start
with a small sample, verify result shape, then follow the assignment's query,
filters and Provider-proven pagination boundary. Preserve results across calls
and submit the final Ledger through `research_runtime.finish`.

Use `help()` on functions from the assigned Provider module when exact details
are still unclear.

Calls may raise `ValueError` for invalid arguments or
`research_runtime.ResearchRuntimeError` when an operation fails.
`ResearchRuntimeError` exposes `code`, `failure_class`, `retryable`,
`retry_after_ms`, and `details`, so a pipeline can report the exact cause
without discarding Runtime diagnostics.

Do not catch `Exception` and silently replace a failed acquisition with an
empty candidate file. Fix `ValueError` arguments locally. Provider Runtime
exclusively owns transient retries, backoff, and upstream budgets. Never sleep
or retry a Provider request after `ResearchRuntimeError`, even when
`error.retryable` is true; let it propagate after any local cleanup.

`code == "source_unavailable"` means the Provider is temporarily unavailable to
this Provider Child: Runtime has spent the Child's overload budget and fails
every further request to the affected access domain without calling it. arXiv
errors include `details["arxiv_access_scope"]`: `api` covers discovery and metadata,
while `main` covers category, front-matter, and PDF acquisition. A healthy main
domain can still download known paper IDs after API discovery stops. Other
Providers, and provider-wide arXiv access denials without a scoped domain, stop
all further requests. Keep acquired results and report uncovered scope as a gap.
`details` carries `provider_id`, `failure_class`, `elapsed_ms`, `attempts`, and
`retry_after_ms`.

## Runtime bridge functions (`research_runtime`)

Prime Agents work through ipython. `research_runtime` exposes everything the Runtime owns:

| Function | Who | What |
| --- | --- | --- |
| `search_source(requests, source=...)` | Provider child | Search the assigned specialized Provider. |
| `search_general_web(query, max_results=10)` | Search Root only | General web discovery; results are routing leads, not evidence. |
| `browser(*args)` / `browser_program(program)` | Browser child | Browser commands in this execution's own Runtime-owned session. |
| `materialize_source(source, title=None)` | Browser child | Retain the current page, an attachment ref, or a public file as converted material. |
| `read_skill(path)` | any | Read a staged `skills/...` file; Runtime records a `skill_read` receipt for Evolution. |
| `finish(provider_id=...)` | Provider child | Validate and freeze the assigned Candidate Ledger. |

The caller identifies itself with `execution_id()`: `root`, or the child id the Runtime wrote
into `work/.execution-id` when it created the child workspace. Root-only functions are refused
for children by the bridge.
