from __future__ import annotations

import asyncio
import json
import logging
import re
import tempfile
import time
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from html import unescape
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlencode, urlsplit

import httpx
from lxml import etree, html
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..arxiv_runtime import ArxivRuntimeStore
from ..documents import DocumentService
from ..errors import ServiceError
from ..http_client import UPSTREAM_HEADER_KEYS, HttpGateway
from ..material_cache import MaterialCache
from ..models import DocumentParseRequest, ProviderRequest, SearchRequest, SearchResult
from ..security import safe_output_dir, safe_workspace_dir
from .base import SourceDeps, SourceSpec, stable_search_id

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV = "{http://arxiv.org/schemas/atom}"
OPENSEARCH = "{http://a9.com/-/spec/opensearch/1.1/}"
DATE_RANGE = re.compile(r"submittedDate:\[([^\]]+)\]", re.IGNORECASE)
DATE_RANGE_VALUE = re.compile(r"\d{12}\s+TO\s+\d{12}")
ARXIV_ID = re.compile(r"(?:\d{4}\.\d{4,5}|[A-Za-z][A-Za-z0-9.-]*/\d{7})(?:v\d+)?")
EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w-])")
ARXIV_TAXONOMY_URL = "https://arxiv.org/category_taxonomy"
# Without a Retry-After from arXiv, back off in short steps before the configured long cooldown.
OVERLOAD_LADDER_SECONDS = (20, 60, 180, 15 * 60)
OVERLOAD_STRIKE_RESET_SECONDS = 30 * 60


def _upstream_headers(headers: Any) -> dict[str, str]:
    return {key: headers[key] for key in UPSTREAM_HEADER_KEYS if key in headers}


def _query_summary(parameters: dict[str, object] | None) -> dict[str, object] | None:
    if not parameters:
        return None
    return {key: (value[:200] if isinstance(value, str) else value) for key, value in parameters.items()}
CATEGORY_SEARCH_STOP_WORDS = {"and", "for", "from", "into", "the", "with"}
LOGGER = logging.getLogger(__name__)


class ArxivParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    search_query: str | None = Field(default=None, min_length=1, max_length=20_000)
    id_list: list[str] = Field(default_factory=list, max_length=10_000)
    start: int = Field(default=0, ge=0, le=10_000_000)
    max_results: int | None = Field(default=None, ge=1, le=30_000)
    sortBy: Literal["relevance", "lastUpdatedDate", "submittedDate"] | None = None
    sortOrder: Literal["ascending", "descending"] | None = None
    http_method: Literal["auto", "get", "post"] = "auto"

    @field_validator("search_query")
    @classmethod
    def validate_date_ranges(cls, value: str | None) -> str | None:
        if value is None:
            return value
        for match in DATE_RANGE.finditer(value):
            if not DATE_RANGE_VALUE.fullmatch(match.group(1).strip()):
                raise ValueError("arXiv date ranges must use YYYYMMDDHHMM TO YYYYMMDDHHMM")
        return value

    @model_validator(mode="after")
    def require_query(self) -> ArxivParameters:
        if not self.search_query and not self.id_list:
            raise ValueError("arXiv query requires search_query, id_list, or both")
        return self


class ArxivDownloadParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    arxiv_id: str = Field(min_length=1, max_length=200)

    @field_validator("arxiv_id")
    @classmethod
    def validate_arxiv_id(cls, value: str) -> str:
        if not ARXIV_ID.fullmatch(value):
            raise ValueError("arxiv_id must be an exact arXiv identifier")
        return value


class ArxivPaperFrontParameters(ArxivDownloadParameters):
    max_bytes: int | None = Field(default=None, ge=1_024, le=50 * 1024 * 1024)


class ArxivCategoriesParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    search: list[str] = Field(default_factory=list, max_length=20)
    start: int = Field(default=0, ge=0, le=500)
    max_results: int = Field(default=100, ge=1, le=100)

    @field_validator("search", mode="before")
    @classmethod
    def normalize_search(cls, value: object) -> object:
        values = [value] if isinstance(value, str) else value
        if values is None:
            return []
        if not isinstance(values, list):
            raise ValueError("search must be text or a list of text values")
        normalized: list[str] = []
        for item in values:
            if not isinstance(item, str) or not item.strip() or len(item) > 200:
                raise ValueError("each search value must be non-empty and at most 200 characters")
            if item.strip() not in normalized:
                normalized.append(item.strip())
        return normalized


class ArxivSource:
    def __init__(
        self,
        http: HttpGateway,
        endpoint: str,
        runtime_store: ArxivRuntimeStore | None = None,
        min_start_interval_seconds: float = 4,
        main_site_min_start_interval_seconds: float = 15,
        overload_cooldown_seconds: float = 15 * 60,
        documents: DocumentService | None = None,
        material_cache: MaterialCache | None = None,
        global_min_start_interval_seconds: float = 3,
    ) -> None:
        self.http = http
        self.endpoint = endpoint
        self.runtime_store = runtime_store
        self.min_start_interval_seconds = min_start_interval_seconds
        self.main_site_min_start_interval_seconds = main_site_min_start_interval_seconds
        self.global_min_start_interval_seconds = global_min_start_interval_seconds
        self.overload_cooldown_seconds = overload_cooldown_seconds
        self.documents = documents
        self.material_cache = material_cache
        # Every upstream request and its outcome, shared by all service processes next to the runtime store.
        database = getattr(runtime_store, "database", None)
        self.upstream_log_path = Path(database).parent / "arxiv-upstream.jsonl" if database else None
        self._overload_strikes = 0
        self._last_overload_at = 0.0

    def close(self) -> None:
        if self.runtime_store is not None:
            self.runtime_store.close()

    def _overload_delay(self, error: ServiceError) -> float:
        """Retry-After when arXiv states one; otherwise short steps before the long cooldown."""
        if error.retry_after_ms is not None:
            return error.retry_after_ms / 1_000
        now = time.time()
        if now - self._last_overload_at > OVERLOAD_STRIKE_RESET_SECONDS:
            self._overload_strikes = 0
        step = OVERLOAD_LADDER_SECONDS[min(self._overload_strikes, len(OVERLOAD_LADDER_SECONDS) - 1)]
        self._overload_strikes += 1
        self._last_overload_at = now
        return min(step, self.overload_cooldown_seconds)

    def _log_upstream(self, record: dict[str, Any]) -> None:
        if self.upstream_log_path is None:
            return
        try:
            self.upstream_log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.upstream_log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        if request.provider_request and request.provider_request.operation == "categories":
            try:
                parameters = ArxivCategoriesParameters.model_validate(request.provider_request.parameters)
            except ValueError as error:
                raise ServiceError(
                    "invalid_provider_request",
                    f"Invalid arXiv category parameters: {error}",
                    status_code=400,
                    provider="arxiv",
                ) from error
            return await self._categories(parameters, request)
        if request.provider_request and request.provider_request.operation == "download_pdf":
            try:
                parameters = ArxivDownloadParameters.model_validate(request.provider_request.parameters)
            except ValueError as error:
                raise ServiceError(
                    "invalid_provider_request",
                    f"Invalid arXiv download parameters: {error}",
                    status_code=400,
                    provider="arxiv",
                ) from error
            return await self._download_pdf(parameters, request)
        if request.provider_request and request.provider_request.operation == "paper_front":
            try:
                parameters = ArxivPaperFrontParameters.model_validate(request.provider_request.parameters)
            except ValueError as error:
                raise ServiceError(
                    "invalid_provider_request",
                    f"Invalid arXiv paper-front parameters: {error}",
                    status_code=400,
                    provider="arxiv",
                ) from error
            return await self._paper_front(parameters)
        native = self._validate_request(request)
        target = min(native.max_results or request.max_results, request.max_results)
        params = self._request_parameters(native, target)
        cached_xml = self.runtime_store.get_cached_response(self.endpoint, params) if self.runtime_store else None
        if cached_xml is not None:
            results, feed_metadata = parse_feed(cached_xml)
            ensure_expected_page(native.start, results, feed_metadata)
            self._annotate_results(
                results,
                native=native,
                request_method="CACHE",
                feed_metadata=feed_metadata,
                storage="sqlite_query_cache",
            )
            return results[:target]

        encoded = urlencode(params)
        method = native.http_method
        if method == "auto":
            method = "post" if len(f"{self.endpoint}?{encoded}") > 7_500 else "get"
        response = await self._request_upstream(
            "api",
            self.min_start_interval_seconds,
            method.upper(),
            self.endpoint,
            headers={"Accept": "application/atom+xml"},
            params=params if method == "get" else None,
            form=params if method == "post" else None,
        )
        xml = response.text
        results, feed_metadata = parse_feed(xml)
        ensure_expected_page(native.start, results, feed_metadata)
        if self.runtime_store is not None:
            self.runtime_store.put_cached_response(self.endpoint, params, xml)
        self._annotate_results(
            results,
            native=native,
            request_method=method.upper(),
            feed_metadata=feed_metadata,
        )
        return results[:target]

    async def _categories(
        self,
        parameters: ArxivCategoriesParameters,
        request: SearchRequest,
    ) -> list[SearchResult]:
        cache_parameters = {"operation": "categories"}
        taxonomy = (
            self.runtime_store.get_cached_response(ARXIV_TAXONOMY_URL, cache_parameters)
            if self.runtime_store else None
        )
        if taxonomy is None:
            taxonomy = (await self._request_upstream(
                "main",
                self.main_site_min_start_interval_seconds,
                "GET",
                ARXIV_TAXONOMY_URL,
                headers={"Accept": "text/html"},
            )).text
            if self.runtime_store is not None:
                self.runtime_store.put_cached_response(ARXIV_TAXONOMY_URL, cache_parameters, taxonomy)
        categories = parse_category_taxonomy(taxonomy)
        if parameters.search:
            scored = [
                (_category_search_score(category, parameters.search), category)
                for category in categories
            ]
            categories = [
                category for score, category in sorted(
                    scored,
                    key=lambda item: (-item[0], str(item[1].metadata.get("category_id") or "")),
                )
                if score > 0
            ]
        end = parameters.start + min(parameters.max_results, request.max_results)
        return categories[parameters.start:end]

    async def _download_pdf(
        self,
        parameters: ArxivDownloadParameters,
        request: SearchRequest,
    ) -> list[SearchResult]:
        if self.documents is None:
            raise ServiceError("document_conversion_unavailable", "Document Convert is unavailable", provider="arxiv")
        if not request.workspace_dir:
            raise ServiceError(
                "invalid_provider_request",
                "workspace_dir is required for arXiv PDF downloads",
                status_code=400,
                provider="arxiv",
            )
        workspace = safe_workspace_dir(request.workspace_dir, self.documents.allowed_workspace_roots)
        lookup = request.model_copy(update={
            "max_results": 1,
            "provider_request": ProviderRequest(
                operation="query",
                parameters={"id_list": [parameters.arxiv_id], "max_results": 1},
            ),
        })
        papers = await self.search(lookup)
        if len(papers) != 1:
            raise ServiceError(
                "arxiv_paper_not_found",
                f"arXiv paper '{parameters.arxiv_id}' was not found",
                status_code=404,
                provider="arxiv",
            )
        paper = papers[0]
        version_id = str(paper.metadata.get("arxiv_version_id") or "")
        pdf_url = str(paper.metadata.get("pdf_url") or "")
        if not ARXIV_ID.fullmatch(version_id) or not pdf_url.startswith("https://"):
            raise ServiceError(
                "invalid_provider_response",
                "arXiv metadata did not contain an exact PDF identity",
                provider="arxiv",
            )

        key = stable_search_id("arxiv-paper", version_id)
        output_dir = safe_output_dir(f"artifacts/arxiv/papers/{key}", workspace)
        cache_key = f"{version_id}:document-v2"
        cache_hit = bool(
            self.material_cache
            and self.material_cache.restore_tree("arxiv-paper-v2", cache_key, output_dir)
        )
        pdf_path = output_dir / "paper.pdf"
        if pdf_path.is_file() and not pdf_path.is_symlink():
            if pdf_path.stat().st_size > self.documents.max_bytes or not has_pdf_signature(pdf_path):
                raise ServiceError(
                    "invalid_document",
                    "Cached arXiv PDF is invalid or exceeds the configured size limit",
                    status_code=400,
                    provider="arxiv",
                )
        else:
            response = await self._request_upstream(
                "main",
                self.main_site_min_start_interval_seconds,
                "GET",
                pdf_url,
                headers={"Accept": "application/pdf"},
            )
            content = response.content
            if len(content) > self.documents.max_bytes:
                raise ServiceError(
                    "document_too_large",
                    "arXiv PDF exceeds the configured document size limit",
                    status_code=413,
                    provider="arxiv",
                )
            if not content.startswith(b"%PDF-"):
                raise ServiceError(
                    "invalid_provider_response",
                    "arXiv PDF download did not contain a valid PDF signature",
                    provider="arxiv",
                )
            write_atomic(pdf_path, content)

        markdown_path = output_dir / "paper.md"
        manifest_path = output_dir / "parser-manifest.json"
        if cache_hit:
            markdown = markdown_path.read_text(encoding="utf-8")
            parser_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        else:
            relative_dir = output_dir.relative_to(workspace).as_posix()
            parsed, markdown = await self.documents.parse_with_markdown(DocumentParseRequest(
                schema_version=1,
                input_path=pdf_path.relative_to(workspace).as_posix(),
                input_root=str(workspace),
                content_type="application/pdf",
                source_name=f"{version_id}.pdf",
                title=paper.title,
                asset_output_dir=f"{relative_dir}/assets",
            ))
            parser_manifest = parsed.manifest.model_dump(mode="json")
            write_atomic(markdown_path, markdown.encode("utf-8"))
            write_atomic(manifest_path, json.dumps(parser_manifest, sort_keys=True).encode("utf-8"))
            if self.material_cache:
                # The cache key includes the immutable arXiv version, so this tree does not expire with the TTL.
                self.material_cache.store_tree(
                    "arxiv-paper-v2", cache_key, output_dir, immutable=True
                )
        if not markdown.strip():
            raise ServiceError("empty_document", "Document Convert returned empty Markdown", provider="arxiv")
        result = paper.model_copy(deep=True)
        result.metadata.update({
            "resource_type": "paper_document",
            "pdf_path": pdf_path.relative_to(workspace).as_posix(),
            "markdown_path": markdown_path.relative_to(workspace).as_posix(),
            "artifact_path": markdown_path.relative_to(workspace).as_posix(),
            "pdf_byte_length": pdf_path.stat().st_size,
            "markdown_byte_length": markdown_path.stat().st_size,
            "material_cache_hit": cache_hit,
            "parser_manifest": parser_manifest,
            "provider_implementation": "arxiv_atom_document_runtime_v3",
        })
        return [result]

    async def _paper_front(
        self,
        parameters: ArxivPaperFrontParameters,
    ) -> list[SearchResult]:
        version_id = parameters.arxiv_id
        cache_key = f"{version_id}:front-v2"
        with tempfile.TemporaryDirectory(prefix="telomi-arxiv-front-") as temporary:
            cache_dir = Path(temporary) / "front"
            if self.material_cache and self.material_cache.restore_tree(
                "arxiv-paper-front-v2", cache_key, cache_dir
            ):
                return [SearchResult.model_validate_json((cache_dir / "result.json").read_text())]

            page_url = f"https://arxiv.org/html/{version_id}"
            try:
                response = await self._request_upstream(
                    "main",
                    self.main_site_min_start_interval_seconds,
                    "GET",
                    page_url,
                    headers={"Accept": "text/html"},
                )
            except ServiceError as error:
                if error.details.get("upstream_status") != 404:
                    raise
                result = unavailable_paper_front(version_id, page_url)
            else:
                limit = parameters.max_bytes or 5 * 1024 * 1024
                if len(response.content) > limit:
                    raise ServiceError(
                        "document_too_large",
                        "arXiv HTML exceeds the requested size limit",
                        status_code=413,
                        provider="arxiv",
                    )
                result = parse_paper_front(response.content, version_id, page_url)

            if self.material_cache:
                cache_dir.mkdir(parents=True)
                write_atomic(cache_dir / "result.json", result.model_dump_json().encode())
                self.material_cache.store_tree(
                    "arxiv-paper-front-v2",
                    cache_key,
                    cache_dir,
                    immutable=bool(result.metadata["html_available"]) and bool(re.search(r"v\d+$", version_id)),
                )
            return [result]

    async def _request_upstream(
        self,
        scope: str,
        min_interval_seconds: float,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        params: dict[str, object] | None = None,
        form: dict[str, object] | None = None,
    ) -> httpx.Response:
        lease = None
        record: dict[str, Any] = {
            "at": datetime.now(UTC).isoformat(), "kind": "request", "scope": scope, "method": method, "url": url,
            "query": _query_summary(params or form),
        }
        started = time.monotonic()
        try:
            if self.runtime_store is not None:
                while lease is None:
                    lease = await asyncio.to_thread(self.runtime_store.try_acquire_upstream_lock)
                    if lease is None:
                        await asyncio.sleep(0.05)
                # arXiv's terms count every host under one client: keep a global
                # spacing across the api and main scopes, not only within each.
                delay = max(
                    await asyncio.to_thread(
                        self.runtime_store.reserve_upstream_slot,
                        scope,
                        min_interval_seconds,
                    ),
                    await asyncio.to_thread(
                        self.runtime_store.reserve_upstream_slot,
                        "any",
                        self.global_min_start_interval_seconds,
                    ),
                )
                if delay > 0:
                    await asyncio.sleep(delay)
                record["slot_wait_ms"] = round(delay * 1_000)
            started = time.monotonic()
            response = await self.http.request(
                "arxiv",
                method,
                url,
                headers=headers,
                params=params,
                form=form,
            )
            record.update(status=response.status_code, headers=_upstream_headers(response.headers))
            return response
        except ServiceError as error:
            record.update(
                status=error.details.get("upstream_status"), error=error.code,
                headers=error.details.get("upstream_headers"), body=error.details.get("upstream_body"),
            )
            if self.runtime_store is not None and error.retryable:
                cooldown = self._overload_delay(error)
                error.retry_after_ms = round(cooldown * 1_000)
                record["cooldown_seconds"] = cooldown
                self.runtime_store.cooldown(cooldown)
            raise
        finally:
            if lease is not None:
                lease.release()
            record["elapsed_ms"] = round((time.monotonic() - started) * 1_000)
            self._log_upstream(record)

    @staticmethod
    def _validate_request(request: SearchRequest) -> ArxivParameters:
        raw = (
            request.provider_request.parameters
            if request.provider_request
            else {
                "search_query": request.query,
                "max_results": request.max_results,
            }
        )
        if request.provider_request and request.provider_request.operation != "query":
            raise ServiceError(
                "invalid_provider_request",
                "arXiv provider operation must be 'query', 'paper_front', or 'download_pdf'",
                status_code=400,
                provider="arxiv",
            )
        try:
            return ArxivParameters.model_validate(raw)
        except ValueError as error:
            raise ServiceError(
                "invalid_provider_request",
                f"Invalid arXiv parameters: {error}",
                status_code=400,
                provider="arxiv",
            ) from error

    @staticmethod
    def _request_parameters(native: ArxivParameters, target: int) -> dict[str, object]:
        params: dict[str, object] = {}
        if native.search_query:
            params["search_query"] = native.search_query
        if native.id_list:
            params["id_list"] = ",".join(native.id_list)
        if native.start:
            params["start"] = native.start
        params["max_results"] = target
        if native.sortBy:
            params["sortBy"] = native.sortBy
        if native.sortOrder:
            params["sortOrder"] = native.sortOrder
        return params

    @staticmethod
    def _annotate_results(
        results: list[SearchResult],
        *,
        native: ArxivParameters,
        request_method: str,
        feed_metadata: dict[str, object],
        storage: str | None = None,
    ) -> None:
        for result in results:
            result.metadata.update(
                {
                    "arxiv_query": native.model_dump(exclude_none=True),
                    "arxiv_request_method": request_method,
                    "arxiv_feed": feed_metadata,
                    **({"arxiv_storage": storage} if storage else {}),
                }
            )


def _category_search_score(category: SearchResult, searches: list[str]) -> int:
    text = " ".join((
        category.title,
        category.snippet,
        str(category.metadata.get("category_id") or ""),
    )).casefold()
    score = 0
    for search in searches:
        phrase = search.casefold()
        if phrase in text:
            score += 100
        score += sum(
            token in text
            for token in set(re.findall(r"[a-z0-9]+", phrase))
            if len(token) >= 4 and token not in CATEGORY_SEARCH_STOP_WORDS
        )
    return score


def parse_category_taxonomy(document: str) -> list[SearchResult]:
    try:
        root = html.fromstring(document)
    except (etree.ParserError, ValueError) as error:
        raise ServiceError(
            "invalid_provider_response",
            "arXiv returned malformed category taxonomy HTML",
            provider="arxiv",
        ) from error
    results: list[SearchResult] = []
    for heading in root.xpath("//h4"):
        category_id = clean(heading.text)
        label = clean(" ".join(heading.xpath("./span//text()"))).strip("()")
        section = heading.getparent().getparent() if heading.getparent() is not None else None
        description = clean(" ".join(section.xpath("./div[2]//text()"))) if section is not None else ""
        if not category_id or not re.fullmatch(r"[a-z-]+(?:\.[A-Za-z-]+)?", category_id):
            continue
        results.append(SearchResult(
            id=stable_search_id("arxiv-category", category_id),
            title=label or category_id,
            url=ARXIV_TAXONOMY_URL,
            snippet=description,
            metadata={
                "resource_type": "category",
                "category_id": category_id,
                "category_label": label or category_id,
                "description": description,
                "provider_implementation": "arxiv_category_taxonomy_v1",
                "reliability_tier": "primary",
            },
        ))
    if not results:
        raise ServiceError(
            "invalid_provider_response",
            "arXiv category taxonomy did not contain any categories",
            provider="arxiv",
        )
    return results


def unavailable_paper_front(version_id: str, page_url: str) -> SearchResult:
    return SearchResult(
        id=stable_search_id("arxiv-paper-front", version_id),
        title=version_id,
        url=page_url,
        snippet="",
        metadata={
            "html_available": False,
            "arxiv_id": re.sub(r"v\d+$", "", version_id),
            "arxiv_version_id": version_id,
            "hint": "arXiv HTML is unavailable; use download_pdf for this paper.",
            "provider_implementation": "arxiv_html_front_v2",
        },
    )


def parse_paper_front(content: bytes, version_id: str, page_url: str) -> SearchResult:
    try:
        root = html.fromstring(content)
    except (etree.ParserError, ValueError) as error:
        raise ServiceError(
            "invalid_provider_response",
            "arXiv returned malformed paper HTML",
            provider="arxiv",
        ) from error
    etree.strip_elements(root, "script", "style", with_tail=False)
    _strip_page_chrome(root)
    # arXiv wraps the LaTeXML article in site banners, an infobox, and a footer; only ltx_document is the paper.
    page_title = clean(" ".join(root.xpath("//title/text()")))
    root = next((node for node in root.iter() if _has_class(node, "ltx_document")), root)
    nodes = list(root.iter())
    bibliography = next((node for node in nodes if _has_class(node, "ltx_bibliography")), None)
    before = nodes[:nodes.index(bibliography)] if bibliography is not None else nodes
    title_node = next((node for node in nodes if _has_class(node, "ltx_title_document")), None)
    author_node = next((node for node in nodes if _has_class(node, "ltx_authors")), None)
    author_notes = _author_note_texts(
        node for node in before if _has_class(node, "ltx_author_notes")
    )
    footnotes = _html_texts(
        node for node in before if _has_class(node, "ltx_note_content")
    )
    pre_bibliography_text = _text_before(root, bibliography)[:200_000]
    addresses = list(dict.fromkeys(EMAIL.findall(pre_bibliography_text)))
    domains = list(dict.fromkeys(address.rsplit("@", 1)[1].lower() for address in addresses))
    title_text = _html_text(title_node) or page_title or version_id
    author_block_text = _html_text(author_node)
    front_text = _front_text(root, bibliography)[:12_000]
    return SearchResult(
        id=stable_search_id("arxiv-paper-front", version_id),
        title=title_text,
        url=page_url,
        snippet=front_text[:1_000],
        metadata={
            "html_available": True,
            "arxiv_id": re.sub(r"v\d+$", "", version_id),
            "arxiv_version_id": version_id,
            "title_text": title_text,
            "author_block_text": author_block_text,
            "author_notes": author_notes,
            "footnotes": footnotes,
            "emails": {"domains": domains, "addresses": addresses},
            "front_text": front_text,
            "pre_bibliography_text": pre_bibliography_text,
            "bibliography_detected": bibliography is not None,
            "provider_implementation": "arxiv_html_front_v2",
        },
    )


def _has_class(node: etree._Element, name: str) -> bool:
    return name in str(node.attrib.get("class") or "").split()


def _html_texts(nodes: Iterable[etree._Element]) -> list[str]:
    return [text for node in nodes if (text := _html_text(node))]


def _author_note_texts(nodes: Iterable[etree._Element]) -> list[str]:
    notes: list[str] = []
    for node in nodes:
        text = _html_text(node)
        parts = re.findall(r"(?i)Affiliation:\s*.*?(?=\s+Affiliation:|$)", text)
        for part in parts or [text]:
            if part:
                notes.append(part)
    return notes


def _html_text(node: etree._Element | None) -> str:
    return clean(" ".join(node.itertext()) if node is not None else "")


PAGE_CHROME_CLASSES = (
    "ltx_page_header", "ltx_page_footer", "ltx_page_logo", "ltx_page_navbar",
    "ds-announcement", "ds-site-footer", "arxiv-html-header", "html-header-nav", "infobox",
)
PAGE_CHROME_TAGS = {"nav", "header", "footer"}


def _strip_page_chrome(root: etree._Element) -> None:
    """Drop LaTeXML navigation, logo, and footer nodes so page chrome never reads as paper text or links."""
    doomed = [
        node for node in root.iter()
        if isinstance(node.tag, str) and (
            node.tag.rsplit("}", 1)[-1].lower() in PAGE_CHROME_TAGS
            or any(_has_class(node, name) for name in PAGE_CHROME_CLASSES)
        )
    ]
    for node in doomed:
        parent = node.getparent()
        if parent is None:
            continue
        if node.tail:
            previous = node.getprevious()
            if previous is not None:
                previous.tail = (previous.tail or "") + node.tail
            else:
                parent.text = (parent.text or "") + node.tail
        parent.remove(node)


def _text_before(root: etree._Element, stop: etree._Element | None) -> str:
    parts: list[str] = []
    for event, node in etree.iterwalk(root, events=("start", "end")):
        if event == "start":
            if node is stop:
                break
            if node.text:
                parts.append(node.text)
            parts.extend(_href_text(node))
        elif node.tail:
            parts.append(node.tail)
    return clean(" ".join(parts))


def _href_text(node: etree._Element) -> list[str]:
    """Return an http(s) href when the anchor text does not already spell it out."""
    if not isinstance(node.tag, str) or node.tag.rsplit("}", 1)[-1].lower() != "a":
        return []
    href = str(node.attrib.get("href") or "").strip()
    if not href.lower().startswith(("http://", "https://")):
        return []
    text = " ".join(node.itertext())
    return [] if href in text else [f"({href})"]


def _front_text(root: etree._Element, bibliography: etree._Element | None) -> str:
    first_section = next((node for node in root.iter() if _has_class(node, "ltx_section")), None)
    parts: list[str] = []
    for event, node in etree.iterwalk(root, events=("start", "end")):
        if event == "start":
            if node is bibliography:
                break
            if node.text:
                parts.append(node.text)
            parts.extend(_href_text(node))
        else:
            if node.tail:
                parts.append(node.tail)
            if node is first_section:
                break
    return clean(" ".join(parts))


def parse_feed(xml: str) -> tuple[list[SearchResult], dict[str, object]]:
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
    try:
        root = etree.fromstring(xml.encode("utf-8"), parser=parser)
    except (etree.XMLSyntaxError, ValueError) as error:
        raise ServiceError(
            "invalid_provider_response",
            "arXiv returned malformed Atom XML",
            provider="arxiv",
        ) from error

    metadata: dict[str, object] = {}
    for element, key in (
        ("title", "title"),
        ("id", "id"),
        ("updated", "updated_at"),
    ):
        value = element_text(root.find(f"{ATOM}{element}"))
        if value:
            metadata[key] = value
    feed_links = [clean_attributes(link) for link in root.findall(f"{ATOM}link")]
    if feed_links:
        metadata["links"] = feed_links
    for field, key in (
        ("totalResults", "total_results"),
        ("startIndex", "start_index"),
        ("itemsPerPage", "items_per_page"),
    ):
        text = element_text(root.find(f"{OPENSEARCH}{field}"))
        if text.isdigit():
            metadata[key] = int(text)

    results: list[SearchResult] = []
    for entry in root.findall(f"{ATOM}entry"):
        result = parse_entry(entry)
        if result is not None:
            results.append(result)
    return results, metadata


def parse_entry(entry: etree._Element) -> SearchResult | None:
    raw_id = element_text(entry.find(f"{ATOM}id"))
    updated = element_text(entry.find(f"{ATOM}updated"))
    published = element_text(entry.find(f"{ATOM}published"))
    if not raw_id or not valid_atom_datetime(updated) or not valid_atom_datetime(published):
        LOGGER.warning("Skipping arXiv entry missing a valid id, updated, or published field")
        return None

    version_id = short_arxiv_id(raw_id)
    if not version_id:
        LOGGER.warning("Skipping arXiv entry with an unsupported id: %s", raw_id)
        return None
    base_id = re.sub(r"v\d+$", "", version_id)
    title = element_text(entry.find(f"{ATOM}title")) or base_id
    summary = element_text(entry.find(f"{ATOM}summary"))

    authors: list[str] = []
    author_records: list[dict[str, object]] = []
    for author in entry.findall(f"{ATOM}author"):
        name = element_text(author.find(f"{ATOM}name"))
        if not name:
            continue
        authors.append(name)
        author_records.append({"name": name})

    links = [clean_attributes(link) for link in entry.findall(f"{ATOM}link")]
    pdf = next(
        (
            str(link["href"])
            for link in links
            if "href" in link and (link.get("title") == "pdf" or link.get("type") == "application/pdf")
        ),
        f"https://arxiv.org/pdf/{version_id}",
    )
    categories = [
        term
        for category in entry.findall(f"{ATOM}category")
        if (term := clean(category.attrib.get("term")))
    ]
    primary = entry.find(f"{ARXIV}primary_category")
    abstract_url = f"https://arxiv.org/abs/{version_id}"
    result_metadata: dict[str, object] = {
        "arxiv_id": base_id,
        "arxiv_version_id": version_id,
        "pdf_url": pdf,
        "source_url": f"https://arxiv.org/src/{version_id}",
        "categories": categories,
        "author_records": author_records,
        "links": links,
        "provider_implementation": "arxiv_atom_runtime_v2",
        "reliability_tier": "primary",
        "updated_at": updated,
    }
    if primary is not None and (term := clean(primary.attrib.get("term"))):
        result_metadata["primary_category"] = term
    for element, key in (
        ("comment", "comment"),
        ("journal_ref", "journal_ref"),
        ("doi", "doi"),
    ):
        value = element_text(entry.find(f"{ARXIV}{element}"))
        if value:
            result_metadata[key] = value
    return SearchResult(
        id=stable_search_id("arxiv", f"https://arxiv.org/abs/{base_id}"),
        title=title,
        url=abstract_url,
        snippet=summary,
        published_at=published,
        authors=authors or None,
        metadata=result_metadata,
    )


def ensure_expected_page(start: int, results: list[SearchResult], feed_metadata: dict[str, object]) -> None:
    total_results = feed_metadata.get("total_results")
    if start > 0 and isinstance(total_results, int) and total_results > start and not results:
        raise ServiceError(
            "arxiv_unexpected_empty_page",
            f"arXiv returned an empty page at start={start} before totalResults={total_results}",
            retryable=True,
            provider="arxiv",
            details={"start": start, "total_results": total_results},
        )


def short_arxiv_id(raw_id: str) -> str:
    parsed = urlsplit(raw_id)
    path = parsed.path if parsed.scheme or parsed.netloc else raw_id
    marker = "/abs/"
    if marker in path:
        path = path.split(marker, 1)[1]
    return path.strip("/")


def valid_atom_datetime(value: str) -> bool:
    if not value:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def clean_attributes(element: etree._Element) -> dict[str, str]:
    return {str(key): clean(value) for key, value in element.attrib.items() if clean(value)}


def element_text(element: etree._Element | None) -> str:
    return clean("".join(element.itertext()) if element is not None else "")


def clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", unescape(value or "")).strip()


def write_atomic(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(content)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def has_pdf_signature(path: Path) -> bool:
    with path.open("rb") as stream:
        return stream.read(5) == b"%PDF-"


def _build(deps: SourceDeps) -> ArxivSource:
    settings = deps.settings
    return ArxivSource(
        deps.http,
        settings.arxiv_endpoint,
        ArxivRuntimeStore(settings.arxiv_sqlite_path, cache_ttl_seconds=settings.arxiv_cache_ttl_seconds),
        settings.arxiv_min_start_interval_seconds,
        settings.arxiv_main_site_min_start_interval_seconds,
        settings.arxiv_overload_cooldown_seconds,
        deps.documents,
        deps.material_cache,
        settings.arxiv_global_min_start_interval_seconds,
    )


SPECS = (
    SourceSpec(id="arxiv", build=_build, max_concurrency=lambda settings: settings.arxiv_max_concurrency),
)
