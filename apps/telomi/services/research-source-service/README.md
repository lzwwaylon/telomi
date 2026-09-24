# Research Source Service

This service moves research provider execution and document content parsing into a standalone Python process. It exposes a strict, authenticated FastAPI contract on a loopback address.

The service has a deliberately narrow responsibility:

- It executes one validated Provider operation for each Source call; exact response or material cache hits may avoid upstream work.
- It normalizes provider responses into stable search results.
- It parses a trusted local document and returns one versioned CanonicalDocument JSON plus a manifest.
- It validates final report URLs with one lychee pass over the complete Markdown.
- It enforces authentication, request limits, concurrency ceilings, and workspace path boundaries.

The TypeScript Runtime remains the control plane. It owns fallback order, retries, rate policy, timeouts, cancellation, budgets, ledgers, remote document download, and artifact persistence. The Agent writes Python that calls the Runtime gateway. It does not call this process directly and does not execute provider CLI commands.

## Source registration and connection status

Each external Source has one Node descriptor under `server/providers/sources/`
for authentication, settings credential fields, Research Provider identity and
verification. Settings, the credential catalog, the Research registry and Prime
Search Python SDK staging derive from these descriptors. The Python service
discovers Source modules through their `SPECS`; verification checks its
`GET /v1/sources` against the Node descriptors and reports missing registrations.

Node owns Source Connection Status. It verifies enabled Sources at startup,
daily and on request from Settings, refreshing browser logins before probing
browser-backed Sources. Status is persisted in the Agent Directory without
credentials. Before a Research Run, Node verifies again unless all enabled
Sources have a check less than five minutes old. This freshness window applies
to failed checks too; it is not a guarantee that the previous check passed.

The next Run's Provider Catalog excludes disabled or unavailable Sources.
The enable switch belongs to Settings, not the Goal Harness, and does not
change replay identity. Status changes publish App Events for notifications.
Browser profile resync is refused while a browser session is running.

## Install

uv is required. `npm run research:install` synchronizes the checked-in
`uv.lock` into this directory's `.venv` with uv's managed Python 3.11, so the
service does not depend on Homebrew or whichever `python3` is first on the
Mac's `PATH`.

Install lychee 0.24.2 from the [official releases](https://github.com/lycheeverse/lychee/releases/tag/lychee-v0.24.2) or with Homebrew:

```bash
brew install lychee
```

Set `SOURCE_SERVICE_LYCHEE_PATH` when the binary is not on `PATH`.

```bash
cd apps/telomi
npm run research:install
```

`uv sync --frozen` refuses dependency drift instead of rewriting the lock file during installation.

## Run

Set a random token of at least 16 characters and one or more trusted workspace roots. Separate multiple roots with the platform path separator.

```bash
export SOURCE_SERVICE_API_TOKEN='replace-with-a-long-random-token'
export SOURCE_SERVICE_WORKSPACE_ROOTS='/absolute/path/to/managed/workspaces'
export SOURCE_SERVICE_FIRECRAWL_API_KEY='optional'
export SOURCE_SERVICE_TAVILY_API_KEY='optional'
export SOURCE_SERVICE_EXA_API_KEY='optional'
export SOURCE_SERVICE_HUGGINGFACE_TOKEN='optional-for-private-or-higher-rate-Hugging-Face-access'
export SOURCE_SERVICE_TWITTER_COOKIE_FILE='/absolute/path/to/x-cookies.txt'
.venv/bin/python -m research_source_service
```

The standalone default listener is `127.0.0.1:8791`. The Node Runtime autostart path also starts at port 8791 and selects another free loopback port when it is occupied. Set `TELOMI_RESEARCH_SOURCE_PORT` to require one explicit autostart port. `SOURCE_SERVICE_HOST` only accepts `localhost` or a loopback IP address.

### arXiv SQLite runtime cache

The Node Runtime and standalone service default to one host-wide database at:

```text
~/.telomi/runtime/research-sources/arxiv-runtime.sqlite3
```

Set `SOURCE_SERVICE_ARXIV_SQLITE_PATH` to override the database location. `SOURCE_SERVICE_ARXIV_CACHE_TTL_SECONDS` controls the exact upstream-query cache and defaults to 86400 seconds.
All checkouts owned by the same user therefore share one cross-process connection lock, cooldown, and request schedule.
Legacy API requests use a four-second interval. Main-site taxonomy and PDF requests use a fifteen-second interval.

This is Runtime code, not Agent execution. The Agent still produces native arXiv query intent through `tools.arxiv`. The Runtime then applies this order:

1. Validate and canonicalize native arXiv request parameters.
2. Reuse an unexpired exact Atom response from SQLite when endpoint and parameters match.
3. Acquire the host-wide single-connection lock and reserve the next endpoint-specific request slot.
4. Call the native arXiv Atom API without reimplementing its search semantics.
5. Validate and parse the Atom page, then cache the original XML for identical requests.

The cache never answers a different query and never searches cached records locally. Complex native grammar, relevance sorting, versions, dates, and pagination therefore retain official API semantics. PDF bytes and parsing outputs use the material cache, while every uncached PDF request still passes through the same host-wide arXiv connection lock.

The same store caches the official arXiv category taxonomy as one exact resource. Category filtering still happens only against that returned taxonomy and never against locally accumulated paper records.

### Material and document cache

The Node Runtime configures a shared `SOURCE_SERVICE_MATERIAL_CACHE_ROOT`. The service uses it for downloaded material, parsed document output, and content-addressed workspace snapshots:

- arXiv paper material is keyed by the exact arXiv version;
- Hugging Face model cards are keyed by repository commit SHA;
- GitHub files and releases use operation-specific keys; clones resolve mutable references to commits when possible;
- Document Convert output is keyed by input content, parser contract, and parser options.

`SOURCE_SERVICE_MATERIAL_CACHE_BASE_ROOT` adds a second, read-only cache root. Lookups try `SOURCE_SERVICE_MATERIAL_CACHE_ROOT` first and fall back to the base root; every new blob, tree, acquisition, and in-flight row is written to the writable root only, and garbage collection can only remove what that root owns. An eval instance therefore reuses the production instance's material without mutating its bytes or access timestamps. Persistent workspace snapshots retain their own tree metadata and object links so subsequent base eviction cannot break replay. Keep both roots on the same volume to share object storage. The base catalog is opened `mode=ro`, and a base root that has never been used is treated as empty.

Set `SOURCE_SERVICE_MATERIAL_CACHE_TTL_SECONDS` to control mutable entries. Immutable versioned entries are content addressed and do not expire with that TTL. Search response caching remains owned by the Node Provider Runtime and is separate from this material cache.

Freshness and disk retention are separate: all downloaded and parsed material, including immutable versions, can be evicted after `SOURCE_SERVICE_MATERIAL_CACHE_RETENTION_SECONDS` without use (default 30 days). Successful reuse persists the last access time in SQLite; restarting the service does not reset it, and offline time counts toward retention. When unique stored object bytes exceed `SOURCE_SERVICE_MATERIAL_CACHE_MAX_BYTES` (default 50 GiB), the oldest unused material is evicted first. Shared objects count once, and existing materialized Source files in Runs and Cases remain intact.

The service starts a background collection pass on startup and repeats it every `SOURCE_SERVICE_MATERIAL_CACHE_GC_INTERVAL_SECONDS` (default one hour). Active cache operations defer collection; failures are logged and retried on the next pass. Shutdown waits for any running pass to finish. Workspace snapshots are always protected during automatic collection, even when that leaves the cache above its capacity target; the service logs the remaining excess. Removing those snapshots requires an explicit reference-aware cleanup of retained Runs and Cases. Collection never modifies the read-only base root.

`scripts/gc_material_cache.py` previews the same download retention policy and accepts `--apply` to perform it. Its preview opens the catalog read-only. Only `--prune-workspace-snapshots` enables Workspace Snapshot deletion, and requires a complete, readable `TELOMI_DATA_DIR` reference scan with product and evaluation services stopped. Unknown references are never treated as an empty set. The catalog records the last completed sweep and its result, and unfinished filesystem deletions are resumed on the next writable cache startup or collection.

All `/v1` endpoints require either:

```text
Authorization: Bearer <SOURCE_SERVICE_API_TOKEN>
```

or:

```text
X-Source-Service-Token: <SOURCE_SERVICE_API_TOKEN>
```

## API

`GET /v1/health` returns service health.

`POST /v1/citations/validate-urls` accepts `{ "schema_version": 1, "markdown": "..." }` and returns the URLs that lychee rejected, timed out, or excluded. The Runtime calls it once during final citation compilation.

`POST /v1/search` performs exactly one Source operation:

```json
{
  "schema_version": 1,
  "source_id": "general_web_tavily",
  "query": "agent runtime evaluation",
  "max_results": 10,
  "criterion_ids": ["criterion-1"],
  "purpose": "Find candidate evidence"
}
```

An optional `credential` states the Provider credentials this one request must be answered with,
keyed by environment variable name. It replaces the service's own configuration for that request
only, so the caller decides which key answers and a value it removed cannot keep serving from a
long-running service. Omit it to use the service's configured credentials.

Telomi sends this snapshot to both local and remote services once a Provider is managed in
Settings, including explicit nulls after deletion. A wholly unmanaged remote Provider keeps
using its service configuration; local environment keys and cookie files do not take it over.
For locally owned Twitter cookie files, startup imports the UTF-8 contents once (up to 2 MiB),
preserving raw Cookie, browser JSON and Netscape formats. Later edits to that file cannot change
the request credential or its cache revision. Unreadable files remain unimported with a status
explanation; service-side file references are not cached by local credential identity.


```json
{
  "schema_version": 1,
  "source_id": "general_web_tavily",
  "query": "agent runtime evaluation",
  "max_results": 10,
  "credential": { "SOURCE_SERVICE_TAVILY_API_KEY": "tvly-..." }
}
```

`POST /v1/credentials/verify` asks the Provider whether a candidate credential works, using a
source built for that call only. Nothing is stored and no other request can see the candidate, so a
refusal leaves the configuration in use untouched:

```json
{
  "schema_version": 1,
  "source_id": "general_web_tavily",
  "credential": { "SOURCE_SERVICE_TAVILY_API_KEY": "tvly-..." }
}
```

Native arXiv parameters use `provider_request`:

```json
{
  "schema_version": 1,
  "source_id": "arxiv",
  "query": "fallback query",
  "max_results": 25,
  "provider_request": {
    "operation": "query",
    "parameters": {
      "search_query": "cat:cs.AI AND all:evaluation",
      "sortBy": "submittedDate",
      "sortOrder": "descending",
      "max_results": 25
    }
  }
}
```

The official category taxonomy is exposed as a separate arXiv operation:

```json
{
  "schema_version": 1,
  "source_id": "arxiv",
  "query": "categories:speech",
  "max_results": 10,
  "provider_request": {
    "operation": "categories",
    "parameters": {
      "search": ["speech", "audio"],
      "max_results": 10
    }
  }
}
```

`discover_papers()` is a Worker-side Python helper, not another HTTP endpoint. It composes validated `categories` and native `query` calls, builds one bounded monthly relevance pool, and serves later pages from the same Worker session.

Hugging Face is one Source with explicit operations for different Hub resource
types:

- `papers_search`
- `papers_list`
- `papers_info`
- `models_list`
- `datasets_list`
- `spaces_list`

For example:

```json
{
  "schema_version": 1,
  "source_id": "huggingface",
  "query": "retrieval models",
  "max_results": 50,
  "provider_request": {
    "operation": "models_list",
    "parameters": {
      "search": "retrieval",
      "filters": ["transformers"],
      "sort": "trending_score",
      "limit": 50
    }
  }
}
```

One call returns at most 100 records. Repository results expose an opaque
`metadata.huggingface_page.next_cursor`; callers pass only that cursor into the
next request. The service reconstructs the known API endpoint and never
accepts an arbitrary next URL. Public data works without credentials.
`SOURCE_SERVICE_HUGGINGFACE_TOKEN` enables authenticated access,
but the token is injected by this service and is never returned to Runtime or
the Agent. When Telomi starts this service, it first discovers the token from
the existing Telomi `auth.json` or standard Hugging Face CLI token file, so a
manual export is only an override.

### GitHub source

The `github` source exposes these read-only and download operations:

- `search_repositories`, `get_repository`, and `search_code`
- `search_issues` and `get_issue`, including complete Issue comments
- `clone_repository`, `download_release`, and `download_file`

Downloads are materialized only below the assigned workspace. Repository clones
default to depth 1 and omit blobs larger than 1 MB, so model weights and datasets
stay on the server while code and docs are checked out. Every GitHub operation runs through `gh`, which uses the
active local `gh auth` account by default. `SOURCE_SERVICE_GITHUB_TOKEN`
may explicitly override that account for the Host service. No
credential is copied into a Worker, and no create, edit, comment, merge, close,
secret, workflow-dispatch, or delete operation is exposed to the Agent.

### X/Twitter session source

The `twitter` source provides these read-only operations:

- `search`, `profile`, `tweets`, `thread`, `article`, and `timeline`
- `following`, `followers`, and `likes`
- `bookmarks`
- `lists` and `list_tweets`
- `device_follow`, `notifications`, and `trending`
- `media`

It does not install an extension or launch a browser. When started by Telomi,
the Node Runtime imports only the required X session Cookies from the already
running project-managed Chrome Profile and keeps them in process memory. The Host service sends
the same authenticated web GraphQL and REST reads as the X web client using a
local session Cookie header. This skips browser-based login orchestration, not
X authentication. The Cookie header is equivalent to account access and must
be protected like a password.

Prefer a permission-restricted file so the session can be rotated without
restarting the Node Runtime:

```bash
chmod 600 /absolute/path/to/x-cookies.txt
export SOURCE_SERVICE_TWITTER_COOKIE_FILE='/absolute/path/to/x-cookies.txt'
```

The file may contain a raw `Cookie` header, a browser JSON cookie export, or
Netscape `cookies.txt`. It must include both `auth_token` and `ct0`. A raw
header can instead be supplied through `SOURCE_SERVICE_TWITTER_COOKIE`, but environment variables are easier to leak
through process inspection and diagnostics. Cookie values are injected only
by the Python service and are never returned to Runtime or Prime Search.
Domain-bearing exports retain only exact `x.com` or `twitter.com` cookies.
The authenticated upstream origin is restricted to the HTTPS root of those
two domains.

`followers` and `lists` also reproduce X's short-lived
`x-client-transaction-id` request proof. The Host anonymously reads the public
X home page and its allowlisted `abs.twimg.com` ondemand asset, caches only the
derived signing context, and generates a fresh ID from the exact HTTP method
and API path for each request. Cookies and authorization are never sent during
this bootstrap. A rejected signed request invalidates the context and retries
once.

The list-management response may contain usable data alongside X error code
214 `DecodeException` rows. The service accepts that partial response only
when the expected timeline structure is present and every error matches that
known form. It returns only `owned-subscribed-list-module-*` entries, so list
recommendations are not reported as lists owned or subscribed to by the
current account. Every other GraphQL error remains a Provider failure.

X rotates persisted GraphQL query IDs. The built-in IDs are pinned and can be
replaced without code changes by setting
`SOURCE_SERVICE_TWITTER_OPERATIONS_FILE` to a local JSON object whose keys are
GraphQL operation names:

```json
{
  "SearchTimeline": "replacementQueryId",
  "UserTweets": "replacementQueryId"
}
```

The service reloads the Cookie file and operation override file for each
Source call. It validates all operation names, query IDs, arguments, cursors,
and result limits before making an upstream request. `media` returns direct
asset metadata and URLs but does not download or write files.

`POST /v1/documents/parse` accepts only a trusted local file:

```json
{
  "schema_version": 1,
  "input_path": "downloads/paper.pdf",
  "input_root": "/absolute/path/to/managed/workspace",
  "content_type": "application/pdf",
  "source_name": "paper.pdf",
  "title": "Paper title",
  "asset_output_dir": "document-conversions/content-hash/assets"
}
```

`input_root` must be inside `SOURCE_SERVICE_WORKSPACE_ROOTS`. The real input path must remain inside the real input root, and symlinks are rejected. The top-level response contains only `schema_version: 2`, `document`, and a content-addressed `manifest`. `document` is CanonicalDocument v1: one ordered `nodes` stream, page membership, heading outline, useful page labels and notes, cleaning audit, and parser provenance. Picture and chart OCR text stays attached to its figure in `figure.content`; captions remain in `figure.captions` without being duplicated in that content list. Bounding boxes, character spans, raw parser references, duplicate table text, and parser-private fields are removed before the response leaves the Provider. It never returns Markdown, raw Docling JSON, or a Host output path.

When `asset_output_dir` is provided for a PDF, it must be a symlink-free path
relative to `input_root`. Docling writes extracted PNG figures there, figure
nodes receive Markdown-relative `asset_path` values, and the manifest records
each asset's relative path, SHA-256, byte length, media type, page, and figure
index. Without this option, parsing stays text-only and does not pay the
picture-rendering cost.

Supported document parsers include plain text, Markdown, HTML, JSON, PDF, DOCX, PPTX, and XLSX.

## Test

```bash
.venv/bin/python -m pytest
.venv/bin/python -m ruff check src tests
```

Tests use mocked upstream transports and real FastAPI request handling. They verify authentication, strict input validation, stable result IDs, single-attempt provider behavior, Source isolation, workspace containment, symlink rejection, and document manifests.
