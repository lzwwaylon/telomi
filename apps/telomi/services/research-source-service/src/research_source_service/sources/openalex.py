"""OpenAlex native Topics, cursor discovery, exact works and cached full text."""

from __future__ import annotations

import json
import re
import tempfile
import time
from datetime import date
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, urljoin, urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..documents import DocumentService
from ..errors import ServiceError
from ..http_client import HttpGateway
from ..material_cache import MaterialCache
from ..models import DocumentParseRequest, ProviderRequest, SearchRequest, SearchResult
from ..security import safe_output_dir, safe_workspace_dir
from .base import CREDENTIAL_PROBE_QUERY, SourceSpec, secret, stable_search_id
from .openalex_budget import OpenAlexBudget


class Parameters(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ListParameters(Parameters):
    search: str | None = Field(default=None, min_length=1, max_length=2_000)
    filter: str | None = Field(default=None, min_length=1, max_length=8_000)
    cursor: str = Field(default="*", min_length=1, max_length=4_000)
    per_page: int = Field(default=50, ge=1, le=100)
    sort: str = Field(default="publication_date:desc", min_length=1, max_length=200)

    @field_validator("filter")
    @classmethod
    def free_filters(cls, value: str | None) -> str | None:
        if value and re.search(r"(?:^|,)\s*(?:from_created_date|from_updated_date)\s*:", value, re.I):
            raise ValueError("OpenAlex sync-date filters require paid plans; use publication dates")
        return value


class TopicsParameters(ListParameters):
    sort: str = "works_count:desc"


class WorkQueryParameters(ListParameters):
    topic_ids: list[str] = Field(default_factory=list, max_length=100)
    start_date: str | None = None
    end_date: str | None = None
    topic_match: Literal["any", "primary"] = "any"

    @field_validator("topic_ids")
    @classmethod
    def validate_topics(cls, values: list[str]) -> list[str]:
        return [entity_id(value, "T") for value in values]

    @field_validator("start_date", "end_date")
    @classmethod
    def valid_date(cls, value: str | None) -> str | None:
        if value is not None and (not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) or not date.fromisoformat(value)):
            raise ValueError("dates must use YYYY-MM-DD")
        return value

    @model_validator(mode="after")
    def valid_range(self) -> WorkQueryParameters:
        if self.start_date and self.end_date and self.start_date > self.end_date:
            raise ValueError("start_date must not exceed end_date")
        if not self.topic_ids and not self.filter and not self.search:
            raise ValueError("query requires topic_ids, native filter, or search")
        return self


class ExactParameters(Parameters):
    identifier: str = Field(min_length=1, max_length=512)


def entity_id(value: str, prefix: str) -> str:
    candidate = value.removeprefix("https://openalex.org/")
    if not re.fullmatch(prefix + r"\d+", candidate):
        raise ValueError(f"identifier must be an exact OpenAlex {prefix} ID")
    return candidate


def work_identifier(value: str) -> str:
    if re.fullmatch(r"(?:https://openalex.org/)?W\d+", value):
        return entity_id(value, "W")
    doi = value.removeprefix("https://doi.org/").removeprefix("doi:")
    if re.fullmatch(r"10\.\d{4,9}/\S+", doi) and not any(char in doi for char in "?#"):
        return "https://doi.org/" + doi
    raise ValueError("identifier must be an exact OpenAlex W ID or DOI")


class OpenAlexSource:
    def __init__(
        self, http: HttpGateway, endpoint: str, api_key: str | None,
        documents: DocumentService, material_cache: MaterialCache, budget: OpenAlexBudget,
    ) -> None:
        self.http, self.endpoint, self.api_key = http, endpoint.rstrip("/"), api_key
        self.documents, self.material_cache, self.budget = documents, material_cache, budget

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        if request.query == CREDENTIAL_PROBE_QUERY and self.api_key:
            # Free singleton lookups may not exercise account access; validate the supplied key explicitly.
            await self._json("rate-limit", "credential_check")
            return []
        native = request.provider_request or ProviderRequest(operation="query", parameters={"search": request.query})
        operation = native.operation
        try:
            if operation in {"topics", "query"}:
                model = TopicsParameters if operation == "topics" else WorkQueryParameters
                parameters = model.model_validate(native.parameters)
                if parameters.per_page > request.max_results:
                    parameters.per_page = request.max_results
                params = parameters.model_dump(
                    exclude_none=True, exclude={"topic_ids", "topic_match", "start_date", "end_date"}
                )
                if isinstance(parameters, WorkQueryParameters):
                    filters = [parameters.filter] if parameters.filter else []
                    if parameters.topic_ids:
                        key = "topics.id" if parameters.topic_match == "any" else "primary_topic.id"
                        filters.append(key + ":" + "|".join(parameters.topic_ids))
                    start = parameters.start_date
                    end = parameters.end_date
                    if request.temporal_range:
                        start = max(start or request.temporal_range.start_date, request.temporal_range.start_date)
                        end = min(end or request.temporal_range.end_date, request.temporal_range.end_date)
                    if start and end and start > end:
                        raise ValueError("requested dates do not overlap the assigned temporal range")
                    if start:
                        filters.append("from_publication_date:" + start)
                    if end:
                        filters.append("to_publication_date:" + end)
                    if filters:
                        params["filter"] = ",".join(filters)
                payload = await self._json("topics" if operation == "topics" else "works", operation, params)
                rows, meta = payload.get("results"), payload.get("meta")
                if not isinstance(rows, list) or not isinstance(meta, dict) or not isinstance(meta.get("count"), int):
                    raise malformed(operation, "list response requires results[] and meta.count")
                if isinstance(meta["count"], bool) or meta["count"] < len(rows) or len(rows) > parameters.per_page:
                    raise malformed(operation, "list response has invalid count or exceeds its requested page size")
                if meta.get("next_cursor") is not None and not isinstance(meta["next_cursor"], str):
                    raise malformed(operation, "meta.next_cursor must be a string or null")
                return [self._record(row, operation, params, meta, topic=operation == "topics") for row in rows]
            if operation in {"topic_info", "work_info", "download_pdf"}:
                parameters = ExactParameters.model_validate(native.parameters)
                identifier = (entity_id(parameters.identifier, "T") if operation == "topic_info"
                              else work_identifier(parameters.identifier))
                if operation == "download_pdf":
                    return await self._download(identifier, request)
                collection = "topics" if operation == "topic_info" else "works"
                payload = await self._json(collection + "/" + quote(identifier, safe="/:"), operation)
                return [self._record(payload, operation, {"identifier": identifier}, topic=collection == "topics")]
            raise ValueError("operation must be topics, topic_info, query, work_info, or download_pdf")
        except ValueError as error:
            raise ServiceError(
                "invalid_provider_request", f"Invalid OpenAlex {operation} parameters: {error}",
                status_code=400, provider="openalex",
                details={"operation": operation, "failure_scope": "request", "next_action": "correct_parameters"},
            ) from error

    async def _request(self, url: str, operation: str, params: dict[str, Any] | None = None, *, redirects: int = 0):
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        searching = params and (params.get("search") or re.search(r"(?:\.|\b)search\s*:", params.get("filter", "")))
        units = 100 if operation == "download_pdf" else (10 if searching else 1 if params else 0)
        self.budget.reserve(units, operation)
        try:
            response = await self.http.request("openalex", "GET", url, headers=headers, params=params)
        except ServiceError as error:
            if self.api_key:
                error.message = error.message.replace(self.api_key, "[redacted]")
                error.args = (error.message,)
                error.details = json.loads(json.dumps(error.details).replace(self.api_key, "[redacted]"))
            status = error.details.get("upstream_status")
            upstream_headers = error.details.get("upstream_headers", {})
            if operation == "download_pdf" and status in {301, 302, 303, 307, 308}:
                if upstream_headers.get("x-ratelimit-remaining") == "0":
                    self.budget.block()
                return await self._content_redirect(upstream_headers.get("location"), operation)
            if status == 301 and operation in {"topic_info", "work_info"}:
                location = error.details.get("upstream_headers", {}).get("location", "")
                if isinstance(location, str) and location.startswith("/"):
                    location = self.endpoint + location
                target, origin = urlsplit(location), urlsplit(self.endpoint)
                if (redirects >= 3 or (target.scheme, target.netloc) != (origin.scheme, origin.netloc)
                        or not re.fullmatch(r"/(?:works/W\d+|topics/T\d+)", target.path)
                        or target.query or target.fragment):
                    raise malformed(operation, "merged entity redirect is invalid or exceeded 3 hops") from error
                return await self._request(location, operation, redirects=redirects + 1)
            try:
                remaining = float(upstream_headers.get("x-ratelimit-remaining", "inf"))
                required = float(upstream_headers.get("x-ratelimit-credits-required", max(units, 1)))
            except (ValueError, TypeError):
                remaining, required = float("inf"), 0
            daily = status == 429 and (remaining < required or bool(re.search(
                r"(?:daily|credit|budget|quota).*(?:exceed|exhaust|limit)|insufficient credits", error.message, re.I
            )))
            if daily:
                self.budget.block()
                error.code, error.retryable = "provider_daily_budget_exhausted", False
                error.details.update({"failure_scope": "provider", "next_action": "handoff"})
            elif status == 404:
                error.code = "openalex_fulltext_missing" if operation == "download_pdf" else "openalex_entity_not_found"
                error.retryable = False
                error.details.update({"failure_scope": "request", "next_action": "handoff_evidence_need"})
            elif status in {401, 403}:
                error.details.update({"failure_scope": "provider", "next_action": "handoff"})
            elif status in {400, 422}:
                error.details.update({"failure_scope": "request", "next_action": "correct_parameters"})
            else:
                error.details.update({"next_action": "runtime_retry" if error.retryable else "handoff"})
            error.details["operation"] = operation
            raise
        if response.headers.get("x-ratelimit-remaining") == "0":
            self.budget.block()
        return response

    async def _content_redirect(self, location: Any, operation: str):
        # Official content API bills once, then sends a signed R2 storage URL. The API key stops here.
        for _ in range(4):
            try:
                target = urlsplit(location) if isinstance(location, str) else None
                if (target is None or target.scheme != "https" or not target.hostname
                        or not target.hostname.endswith((".r2.cloudflarestorage.com", ".r2.dev"))
                        or target.username or target.password or target.port not in (None, 443)):
                    raise ValueError("content redirect must target trusted HTTPS R2 storage")
            except ValueError as error:
                raise malformed(operation, "content redirect is not a trusted storage URL") from error
            try:
                return await self.http.request("openalex", "GET", location, headers={"Accept": "application/pdf"})
            except ServiceError as error:
                if error.details.get("upstream_status") in {301, 302, 303, 307, 308}:
                    location = urljoin(location, error.details.get("upstream_headers", {}).get("location", ""))
                    continue
                error.details.update({"operation": operation, "failure_scope": "request",
                                      "next_action": "handoff_evidence_need", "content_origin": "openalex_cached_r2"})
                error.details.pop("circuit_scope", None)
                if error.details.get("upstream_status") == 404:
                    error.code, error.retryable = "openalex_fulltext_missing", False
                # Storage bodies can echo signed URLs in arbitrary encodings; retain only diagnostics.
                error.details.pop("upstream_body", None)
                error.details.get("upstream_headers", {}).pop("location", None)
                status = error.details.get("upstream_status")
                error.message = ("OpenAlex cached PDF storage request failed "
                                 f"({'HTTP ' + str(status) if status else error.code})")
                error.args = (error.message,)
                raise
        raise malformed(operation, "content redirect exceeded 4 storage hops")

    async def _json(self, path: str, operation: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        url = self.endpoint + "/" + path
        response = await self._request(url, operation, params)
        try:
            payload = response.json()
        except ValueError as error:
            raise malformed(operation, "response is not JSON") from error
        if not isinstance(payload, dict):
            raise malformed(operation, "response must be an object")
        return payload

    def _record(
        self, row: Any, operation: str, query: dict[str, Any], page: dict[str, Any] | None = None,
        *, topic: bool = False,
    ) -> SearchResult:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str):
            raise malformed(operation, "record requires an exact native ID")
        try:
            identifier = entity_id(row["id"], "T" if topic else "W")
        except ValueError as error:
            raise malformed(operation, "record has an invalid native ID") from error
        title = row.get("display_name") or row.get("title")
        if not isinstance(title, str) or not title.strip():
            raise malformed(operation, "record requires a title")
        abstract = (abstract_text(row.get("abstract_inverted_index"), operation) if not topic
                    else str(row.get("description") or ""))
        url = "https://openalex.org/" + identifier
        if row.get("authorships") is not None and not isinstance(row["authorships"], list):
            raise malformed(operation, "authorships must be an array or null")
        authors = [item["author"]["display_name"] for item in (row.get("authorships") or [])
                   if isinstance(item, dict) and isinstance(item.get("author"), dict)
                   and isinstance(item["author"].get("display_name"), str)] if not topic else []
        return SearchResult(
            id=stable_search_id("openalex", url), title=title, url=url, snippet=abstract,
            published_at=row.get("publication_date") if isinstance(row.get("publication_date"), str) else None,
            authors=authors,
            metadata={
                **row, "openalex_id": identifier, "resource_type": "topic" if topic else "paper_metadata",
                "abstract": abstract, "native_query": {"operation": operation, "parameters": query},
                "openalex_page": page or {}, "source_url": url, "provider_implementation": "openalex-native-v1",
            },
        )

    async def _download(self, identifier: str, request: SearchRequest) -> list[SearchResult]:
        if not request.workspace_dir:
            raise ValueError("workspace_dir is required for download_pdf")
        workspace = safe_workspace_dir(request.workspace_dir, self.documents.allowed_workspace_roots)
        paper = self._record(await self._json("works/" + quote(identifier, safe="/:"), "work_info"),
                             "work_info", {"identifier": identifier})
        native_id = paper.metadata["openalex_id"]
        if not isinstance(paper.metadata.get("has_content"), dict) or not paper.metadata["has_content"].get("pdf"):
            raise ServiceError(
                "openalex_fulltext_missing", f"OpenAlex has no cached PDF for {native_id}", status_code=404,
                provider="openalex", details={"operation": "download_pdf", "failure_scope": "request",
                                             "next_action": "handoff_evidence_need", "identifier": native_id},
            )
        if not self.api_key:
            raise ServiceError(
                "openalex_fulltext_key_required", "OpenAlex cached PDF downloads require a free API key",
                provider="openalex", details={"operation": "download_pdf", "failure_scope": "request",
                                             "next_action": "handoff_evidence_need", "identifier": native_id},
            )
        # Construct the official content endpoint; no secrets or arbitrary publisher URLs come from returned records.
        url = f"https://content.openalex.org/works/{native_id}.pdf"
        cache_key = native_id + ":" + str(paper.metadata.get("updated_date") or "unknown")
        key = stable_search_id("openalex-paper", cache_key)
        output = safe_output_dir(f"artifacts/openalex/papers/{key}", workspace)
        pdf, markdown, manifest = output / "paper.pdf", output / "paper.md", output / "parser-manifest.json"
        cache_hit = (all(path.is_file() and not path.is_symlink() for path in (pdf, markdown, manifest))
                     and time.time() - manifest.stat().st_mtime <= self.material_cache.ttl_seconds)
        cache_hit = cache_hit or self.material_cache.restore_tree("openalex-paper-v1", cache_key, output)
        if not cache_hit:
            response = await self._request(url, "download_pdf")
            if len(response.content) > self.documents.max_bytes:
                raise ServiceError("document_too_large", "OpenAlex PDF exceeds document size limit",
                                   status_code=413, provider="openalex", details={"operation": "download_pdf"})
            if not response.content.startswith(b"%PDF-"):
                raise malformed("download_pdf", "content does not have a PDF signature")
            atomic_write(pdf, response.content)
            parsed, text = await self.documents.parse_with_markdown(DocumentParseRequest(
                input_path=pdf.relative_to(workspace).as_posix(), input_root=str(workspace),
                content_type="application/pdf", source_name=native_id + ".pdf", title=paper.title,
                asset_output_dir=(output / "assets").relative_to(workspace).as_posix(),
            ))
            if not text.strip():
                raise ServiceError("empty_document", "Document Convert returned empty OpenAlex Markdown",
                                   provider="openalex", details={"operation": "download_pdf"})
            atomic_write(markdown, text.encode())
            atomic_write(manifest, json.dumps(parsed.manifest.model_dump(mode="json")).encode())
            self.material_cache.store_tree("openalex-paper-v1", cache_key, output, immutable=False)
        if any(path.is_symlink() or not path.is_file() for path in (pdf, markdown, manifest)):
            raise malformed("download_pdf", "cached paper bundle is incomplete")
        if (pdf.stat().st_size > self.documents.max_bytes or not pdf.read_bytes().startswith(b"%PDF-")
                or not markdown.read_text().strip()):
            raise malformed("download_pdf", "cached paper bundle has invalid or empty document content")
        paper.metadata.update({
            "resource_type": "paper_document", "document_url": url,
            "pdf_path": pdf.relative_to(workspace).as_posix(),
            "markdown_path": markdown.relative_to(workspace).as_posix(),
            "artifact_path": markdown.relative_to(workspace).as_posix(),
            "parser_manifest": json.loads(manifest.read_text()), "material_cache_hit": bool(cache_hit),
            "native_query": {"operation": "download_pdf", "parameters": {"identifier": identifier}},
        })
        return [paper]


def abstract_text(index: Any, operation: str) -> str:
    if index is None:
        return ""
    if not isinstance(index, dict):
        raise malformed(operation, "abstract_inverted_index must be an object or null")
    positions: dict[int, str] = {}
    for word, offsets in index.items():
        if not isinstance(word, str) or not isinstance(offsets, list):
            raise malformed(operation, "abstract index entries must be words and position lists")
        for offset in offsets:
            if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or offset in positions:
                raise malformed(operation, "abstract positions must be distinct non-negative integers")
            positions[offset] = word
    return " ".join(positions[offset] for offset in sorted(positions))


def malformed(operation: str, cause: str) -> ServiceError:
    return ServiceError("invalid_provider_response", f"Malformed OpenAlex {operation} response: {cause}",
                        provider="openalex", details={"operation": operation, "failure_scope": "request",
                                                     "next_action": "handoff_evidence_need"})


def atomic_write(path: Path, content: bytes) -> None:
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(content)
            handle.flush()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


SPECS = (SourceSpec(
    id="openalex", credentialed=True,
    build=lambda deps: OpenAlexSource(
        deps.http, deps.settings.openalex_endpoint, secret(deps.settings.openalex_api_key),
        deps.documents, deps.material_cache,
        OpenAlexBudget(deps.settings.arxiv_scheduler_sqlite_path.parent / "openalex-budget.sqlite3",
                      secret(deps.settings.openalex_api_key)),
    ),
    max_concurrency=lambda settings: settings.openalex_max_concurrency,
    probe_request=ProviderRequest(operation="work_info", parameters={"identifier": "W2741809807"}),
),)
