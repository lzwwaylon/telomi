from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from difflib import get_close_matches
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qs, quote, urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..errors import ServiceError
from ..http_client import HttpGateway
from ..material_cache import MaterialCache
from ..models import ProviderRequest, SearchRequest, SearchResult
from ..security import safe_output_dir, safe_workspace_dir
from .base import SourceSpec, secret, stable_search_id

MAX_PAGE_SIZE = 100
PAPER_PREVIEW_CHARACTERS = 6_000
PAPER_ID = re.compile(r"(?:\d{4}\.\d{4,5}|[A-Za-z][A-Za-z0-9.-]*/\d{7})(?:v\d+)?")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
WEEK = re.compile(r"\d{4}-W\d{2}")
MONTH = re.compile(r"\d{4}-\d{2}")
REPO_ID = re.compile(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)?")
SORT_MAP = {
    "created_at": "createdAt",
    "last_modified": "lastModified",
    "trending_score": "trendingScore",
    "downloads": "downloads",
    "likes": "likes",
}


@dataclass(frozen=True)
class ModelTag:
    tag_type: str
    value: str
    label: str


HUB_EXPAND_FIELDS = {
    "models": [
        "author",
        "createdAt",
        "lastModified",
        "sha",
        "downloads",
        "downloadsAllTime",
        "likes",
        "trendingScore",
        "pipeline_tag",
        "library_name",
        "tags",
        "gated",
        "cardData",
        "model-index",
    ],
    "datasets": [
        "author",
        "createdAt",
        "lastModified",
        "sha",
        "description",
        "downloads",
        "downloadsAllTime",
        "likes",
        "trendingScore",
        "tags",
        "gated",
    ],
    "spaces": [
        "author",
        "createdAt",
        "lastModified",
        "sha",
        "likes",
        "trendingScore",
        "tags",
        "sdk",
        "models",
        "datasets",
    ],
}


class StrictParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PapersListParameters(StrictParameters):
    date: str | None = None
    week: str | None = None
    month: str | None = None
    submitter: str | None = Field(default=None, min_length=1, max_length=256)
    sort: Literal["published_at", "trending"] | None = None
    page: int = Field(default=0, ge=0, le=1_000_000)
    limit: int | None = Field(default=None, ge=1, le=MAX_PAGE_SIZE)

    @field_validator("date")
    @classmethod
    def validate_date(cls, value: str | None) -> str | None:
        if value is not None and not DATE.fullmatch(value):
            raise ValueError("date must use YYYY-MM-DD")
        return value

    @field_validator("week")
    @classmethod
    def validate_week(cls, value: str | None) -> str | None:
        if value is not None and not WEEK.fullmatch(value):
            raise ValueError("week must use YYYY-Www")
        return value

    @field_validator("month")
    @classmethod
    def validate_month(cls, value: str | None) -> str | None:
        if value is not None and not MONTH.fullmatch(value):
            raise ValueError("month must use YYYY-MM")
        return value

    @model_validator(mode="after")
    def require_one_period(self) -> PapersListParameters:
        if sum(value is not None for value in (self.date, self.week, self.month)) > 1:
            raise ValueError("date, week, and month are mutually exclusive")
        return self


class PapersSearchParameters(StrictParameters):
    query: str | None = Field(default=None, min_length=1, max_length=2_000)
    limit: int | None = Field(default=None, ge=1, le=MAX_PAGE_SIZE)


class PapersInfoParameters(StrictParameters):
    paper_id: str = Field(min_length=1, max_length=128)

    @field_validator("paper_id")
    @classmethod
    def validate_paper_id(cls, value: str) -> str:
        if not PAPER_ID.fullmatch(value):
            raise ValueError("paper_id must be a valid arXiv identifier")
        return value


def validate_repo_id(value: str) -> str:
    parts = value.split("/")
    if (
        not REPO_ID.fullmatch(value)
        or any(part.startswith(("-", ".")) or part.endswith(("-", ".")) for part in parts)
        or "--" in value
        or ".." in value
    ):
        raise ValueError("must be a valid Hugging Face repository ID")
    return value


class HubInfoParameters(StrictParameters):
    repo_id: str = Field(min_length=1, max_length=96)
    revision: str | None = Field(default=None, min_length=1, max_length=256)

    @field_validator("repo_id")
    @classmethod
    def validate_repo_id_field(cls, value: str) -> str:
        return validate_repo_id(value)


class DatasetLeaderboardParameters(StrictParameters):
    dataset_id: str = Field(min_length=1, max_length=96)
    limit: int | None = Field(default=None, ge=1, le=MAX_PAGE_SIZE)

    @field_validator("dataset_id")
    @classmethod
    def validate_dataset_id(cls, value: str) -> str:
        return validate_repo_id(value)


class ModelTagsParameters(StrictParameters):
    tag_type: Literal["pipeline_tag", "library", "language", "license", "other"] = "pipeline_tag"
    search: str | None = Field(default=None, min_length=1, max_length=256)
    limit: int | None = Field(default=None, ge=1, le=MAX_PAGE_SIZE)


class HubListParameters(StrictParameters):
    search: str | None = Field(default=None, min_length=1, max_length=2_000)
    author: str | None = Field(default=None, min_length=1, max_length=256)
    filters: list[str] = Field(default_factory=list, max_length=50)
    sort: Literal["created_at", "downloads", "last_modified", "likes", "trending_score"] | None = None
    limit: int | None = Field(default=None, ge=1, le=MAX_PAGE_SIZE)
    cursor: str | None = Field(default=None, min_length=1, max_length=4_096)

    @field_validator("filters")
    @classmethod
    def validate_filters(cls, values: list[str]) -> list[str]:
        if any(not value.strip() or len(value) > 256 for value in values):
            raise ValueError("filters must contain non-empty strings no longer than 256 characters")
        return values


class ModelsListParameters(HubListParameters):
    apps: list[str] = Field(default_factory=list, max_length=20)
    gated: bool | None = None
    inference: Literal["warm"] | None = None
    inference_provider: str | list[str] | None = None
    pipeline_tag: str | None = Field(default=None, min_length=1, max_length=256)
    trained_datasets: list[str] = Field(default_factory=list, max_length=20)
    num_parameters: str | None = Field(default=None, min_length=1, max_length=128)
    base_model_relation: Literal["base", "adapter", "finetune", "quantized", "merge"] | None = None

    @model_validator(mode="after")
    def validate_inference_filters(self) -> ModelsListParameters:
        if self.inference is not None and self.inference_provider is not None:
            raise ValueError("inference and inference_provider cannot be combined")
        return self


class DatasetsListParameters(HubListParameters):
    gated: bool | None = None


class SpacesListParameters(HubListParameters):
    # The upstream Space API silently accepts but does not define downloads sorting.
    sort: Literal["created_at", "last_modified", "likes", "trending_score"] | None = None
    datasets: list[str] = Field(default_factory=list, max_length=20)
    models: list[str] = Field(default_factory=list, max_length=20)
    linked: bool = False


Operation = Literal[
    "papers_list",
    "papers_search",
    "papers_info",
    "papers_preview",
    "papers_download",
    "models_info",
    "models_card",
    "model_tags",
    "models_list",
    "datasets_info",
    "datasets_leaderboard",
    "datasets_list",
    "spaces_list",
]


class HuggingFaceSource:
    def __init__(
        self,
        http: HttpGateway,
        endpoint: str,
        token: str | None,
        allowed_workspace_roots: tuple[Path, ...] = (),
        max_download_bytes: int = 50 * 1024 * 1024,
        material_cache: MaterialCache | None = None,
    ) -> None:
        self.http = http
        self.endpoint = endpoint.rstrip("/")
        self.token = token
        self.allowed_workspace_roots = allowed_workspace_roots
        self.max_download_bytes = max_download_bytes
        self.material_cache = material_cache

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        if request.provider_request is None:
            raise ServiceError(
                "invalid_provider_request",
                "Hugging Face requests require provider_request with an explicit operation",
                status_code=400,
                provider="huggingface",
            )
        operation = request.provider_request.operation
        raw = request.provider_request.parameters
        try:
            if operation == "papers_list":
                native: StrictParameters = PapersListParameters.model_validate(raw)
            elif operation == "papers_search":
                native = PapersSearchParameters.model_validate(raw)
            elif operation in ("papers_info", "papers_preview", "papers_download"):
                native = PapersInfoParameters.model_validate(raw)
            elif operation in ("models_info", "models_card", "datasets_info"):
                native = HubInfoParameters.model_validate(raw)
            elif operation == "datasets_leaderboard":
                native = DatasetLeaderboardParameters.model_validate(raw)
            elif operation == "model_tags":
                native = ModelTagsParameters.model_validate(raw)
            elif operation == "models_list":
                native = ModelsListParameters.model_validate(raw)
            elif operation == "datasets_list":
                native = DatasetsListParameters.model_validate(raw)
            elif operation == "spaces_list":
                native = SpacesListParameters.model_validate(raw)
            else:
                raise ServiceError(
                    "invalid_provider_request",
                    f"Unsupported Hugging Face operation: {operation}",
                    status_code=400,
                    provider="huggingface",
                    details={"supported_operations": list(Operation.__args__)},
                )
        except ValueError as error:
            raise ServiceError(
                "invalid_provider_request",
                f"Invalid Hugging Face parameters for {operation}: {error}",
                status_code=400,
                provider="huggingface",
            ) from error

        if operation == "papers_info":
            return await self._paper_info(native)
        if operation == "papers_preview":
            return await self._paper_preview(native)
        if operation == "papers_download":
            return await self._paper_download(native, request)
        if operation == "models_card":
            return await self._model_card(native, request)
        if operation in ("models_info", "datasets_info"):
            return await self._hub_info(operation, native)
        if operation == "datasets_leaderboard":
            return await self._dataset_leaderboard(native, request)
        if operation == "model_tags":
            return await self._model_tags(native, request)
        if operation == "papers_search":
            return await self._papers_search(native, request)
        if operation == "papers_list":
            return await self._papers_list(native, request)
        return await self._hub_list(operation, native, request)

    async def _model_tags(
        self,
        parameters: StrictParameters,
        request: SearchRequest,
    ) -> list[SearchResult]:
        native = ModelTagsParameters.model_validate(parameters.model_dump())
        target = min(native.limit or request.max_results, request.max_results, MAX_PAGE_SIZE)
        payload = json_object(await self._get("/api/models-tags-by-type"))
        raw_tags = payload.get(native.tag_type)
        if not isinstance(raw_tags, list):
            raise ServiceError(
                "invalid_provider_response",
                f"Hugging Face model tag catalog omitted '{native.tag_type}'",
                provider="huggingface",
            )
        query = (native.search or "").casefold()
        catalog = model_tag_catalog(payload)
        results: list[SearchResult] = []
        for raw_tag in raw_tags:
            if not isinstance(raw_tag, Mapping):
                continue
            tag_id = string_value(raw_tag.get("id"))
            label = string_value(raw_tag.get("label")) or tag_id
            if not tag_id or (query and query not in tag_id.casefold() and query not in label.casefold()):
                continue
            parameter = "pipeline_tag" if native.tag_type == "pipeline_tag" else native.tag_type
            results.append(
                SearchResult(
                    id=stable_search_id("huggingface-model-tag", f"{native.tag_type}:{tag_id}"),
                    title=label,
                    url=f"{self.endpoint}/models?{parameter}={quote(tag_id, safe='')}",
                    snippet=f"Hugging Face model filter: {native.tag_type}={tag_id}",
                    metadata={
                        "resource_type": "model_tag",
                        "tag_type": native.tag_type,
                        "tag_id": tag_id,
                        "tag_label": label,
                        "provider_implementation": "huggingface_hub_http_v4",
                        "reliability_tier": "platform_primary",
                    },
                )
            )
            if len(results) >= target:
                break
        if query and not results:
            raise model_tag_error(
                catalog,
                [("search", native.search or "", native.tag_type)],
                search_mode=True,
            )
        return results

    async def _papers_search(
        self,
        parameters: StrictParameters,
        request: SearchRequest,
    ) -> list[SearchResult]:
        native = PapersSearchParameters.model_validate(parameters.model_dump())
        target = min(native.limit or request.max_results, request.max_results, MAX_PAGE_SIZE)
        response = await self._get(
            "/api/papers/search",
            params={"q": native.query or request.query, "limit": target},
        )
        rows = json_list(response)
        page = {"operation": "papers_search", "limit": target, "next_cursor": None}
        return [paper_result(row, self.endpoint, page) for row in rows[:target] if paper_identifier(row)]

    async def _papers_list(
        self,
        parameters: StrictParameters,
        request: SearchRequest,
    ) -> list[SearchResult]:
        native = PapersListParameters.model_validate(parameters.model_dump())
        target = min(native.limit or request.max_results, request.max_results, MAX_PAGE_SIZE)
        params: dict[str, object] = {"p": native.page, "limit": target}
        for key in ("date", "week", "month", "submitter"):
            value = getattr(native, key)
            if value is not None:
                params[key] = value
        if native.sort is not None:
            params["sort"] = "publishedAt" if native.sort == "published_at" else native.sort
        response = await self._get("/api/daily_papers", params=params)
        rows = json_list(response)
        page = {
            "operation": "papers_list",
            "page": native.page,
            "limit": target,
            "next_page": native.page + 1 if len(rows) >= target else None,
        }
        return [paper_result(row, self.endpoint, page) for row in rows[:target] if paper_identifier(row)]

    async def _paper_info(self, parameters: StrictParameters) -> list[SearchResult]:
        native = PapersInfoParameters.model_validate(parameters.model_dump())
        row = await self._paper_metadata(native.paper_id)
        return [paper_result(row, self.endpoint, {"operation": "papers_info"})]

    async def _paper_preview(self, parameters: StrictParameters) -> list[SearchResult]:
        native = PapersInfoParameters.model_validate(parameters.model_dump())
        row = await self._paper_metadata(native.paper_id)
        document_url, content = await self._paper_markdown(native.paper_id)
        result = paper_result(row, self.endpoint, {"operation": "papers_preview"})
        text = content.decode("utf-8", errors="replace")
        result.metadata.update({
            "document_url": document_url,
            "document_byte_length": len(content),
            "front_excerpt": text[:PAPER_PREVIEW_CHARACTERS],
            "headings": markdown_headings(text),
        })
        return [result]

    async def _paper_download(
        self,
        parameters: StrictParameters,
        request: SearchRequest,
    ) -> list[SearchResult]:
        native = PapersInfoParameters.model_validate(parameters.model_dump())
        if not request.workspace_dir:
            raise ServiceError(
                "invalid_provider_request",
                "workspace_dir is required for Hugging Face paper downloads",
                status_code=400,
                provider="huggingface",
            )
        workspace = safe_workspace_dir(request.workspace_dir, self.allowed_workspace_roots)
        key = stable_search_id("huggingface-paper", native.paper_id)
        output_dir = safe_output_dir(f"artifacts/huggingface/papers/{key}", workspace)
        markdown_path = output_dir / "paper.md"
        metadata_path = output_dir / "metadata.json"
        cache_hit = bool(
            self.material_cache
            and self.material_cache.restore_tree("huggingface-paper-v1", native.paper_id, output_dir)
        )
        if cache_hit:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            row = payload.get("native")
            if not isinstance(row, dict):
                raise ServiceError(
                    "invalid_provider_response",
                    "Cached Hugging Face paper metadata is invalid",
                    provider="huggingface",
                )
        else:
            row = await self._paper_metadata(native.paper_id)
            document_url, content = await self._paper_markdown(native.paper_id)
            payload = paper_bundle_metadata(row, native.paper_id, self.endpoint, document_url)
            write_atomic(markdown_path, content)
            write_atomic(metadata_path, (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode())
            if self.material_cache:
                self.material_cache.store_tree(
                    "huggingface-paper-v1", native.paper_id, output_dir, immutable=False
                )

        result = paper_result(row, self.endpoint, {"operation": "papers_download"})
        result.metadata.update({
            "artifact_path": output_dir.relative_to(workspace).as_posix(),
            "markdown_path": markdown_path.relative_to(workspace).as_posix(),
            "metadata_path": metadata_path.relative_to(workspace).as_posix(),
            "document_byte_length": markdown_path.stat().st_size,
            "material_cache_hit": cache_hit,
        })
        return [result]

    async def _paper_metadata(self, paper_id: str) -> Mapping[str, Any]:
        response = await self._get(f"/api/papers/{quote(paper_id, safe='.')}")
        row = json_object(response)
        if not paper_identifier(row):
            raise ServiceError(
                "invalid_provider_response",
                "Hugging Face paper response did not contain an identifier",
                provider="huggingface",
            )
        return row

    async def _paper_markdown(self, paper_id: str) -> tuple[str, bytes]:
        document_url = f"{self.endpoint}/papers/{quote(paper_id, safe='.')}.md"
        headers = {"Accept": "text/markdown"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        response = await self.http.request(
            "huggingface", "GET", document_url, headers=headers, follow_redirects=True
        )
        content = response.content
        content_type = response.headers.get("content-type", "").lower()
        if "text/markdown" not in content_type and "text/plain" not in content_type:
            raise ServiceError(
                "invalid_provider_response",
                f"Hugging Face paper returned unsupported content type: {content_type or 'missing'}",
                provider="huggingface",
            )
        if not content.strip():
            raise ServiceError(
                "invalid_provider_response",
                "Hugging Face paper Markdown was empty",
                provider="huggingface",
            )
        if len(content) > self.max_download_bytes:
            raise ServiceError(
                "huggingface_download_too_large",
                f"Hugging Face paper exceeds max bytes of {self.max_download_bytes}",
                status_code=400,
                provider="huggingface",
            )
        return document_url, content

    async def _hub_list(
        self,
        operation: str,
        parameters: StrictParameters,
        request: SearchRequest,
    ) -> list[SearchResult]:
        resource_type = operation.removesuffix("_list")
        if resource_type == "models":
            native: HubListParameters = ModelsListParameters.model_validate(parameters.model_dump())
        elif resource_type == "datasets":
            native = DatasetsListParameters.model_validate(parameters.model_dump())
        else:
            native = SpacesListParameters.model_validate(parameters.model_dump())
        target = min(native.limit or request.max_results, request.max_results, MAX_PAGE_SIZE)
        params = hub_list_query(native, target)
        params["expand"] = HUB_EXPAND_FIELDS[resource_type]
        response = await self._get(f"/api/{resource_type}", params=params)
        rows = json_list(response)
        if resource_type == "models" and not rows:
            await self._raise_for_unknown_model_tags(native)
        next_cursor = response_next_cursor(response)
        singular = resource_type.removesuffix("s")
        page = {
            "operation": operation,
            "cursor": native.cursor,
            "next_cursor": next_cursor,
            "limit": target,
        }
        return [hub_result(row, self.endpoint, singular, page) for row in rows[:target] if hub_identifier(row)]

    async def _raise_for_unknown_model_tags(self, native: HubListParameters) -> None:
        if not isinstance(native, ModelsListParameters) or not (native.pipeline_tag or native.filters):
            return
        payload = json_object(await self._get("/api/models-tags-by-type"))
        catalog = model_tag_catalog(payload)
        problems: list[tuple[str, str, str | None]] = []
        pipeline_values = {tag.value for tag in catalog.get("pipeline_tag", [])}
        if native.pipeline_tag and native.pipeline_tag not in pipeline_values:
            problems.append(("pipeline_tag", native.pipeline_tag, "pipeline_tag"))
        all_values = {tag.value for tags in catalog.values() for tag in tags}
        for index, value in enumerate(native.filters):
            if value not in all_values:
                problems.append((f"filters[{index}]", value, None))
        if problems:
            raise model_tag_error(catalog, problems)

    async def _hub_info(
        self,
        operation: Literal["models_info", "datasets_info"],
        parameters: StrictParameters,
    ) -> list[SearchResult]:
        native = HubInfoParameters.model_validate(parameters.model_dump())
        resource_type = operation.removesuffix("_info")
        row = await self._hub_metadata(operation, native, HUB_EXPAND_FIELDS[resource_type])
        if not hub_identifier(row):
            raise ServiceError(
                "invalid_provider_response",
                "Hugging Face repository response did not contain an identifier",
                provider="huggingface",
            )
        return [
            hub_result(
                row,
                self.endpoint,
                resource_type.removesuffix("s"),
                {"operation": operation, "revision": native.revision},
            )
        ]

    async def _model_card(
        self,
        parameters: StrictParameters,
        request: SearchRequest,
    ) -> list[SearchResult]:
        native = HubInfoParameters.model_validate(parameters.model_dump())
        if not request.workspace_dir:
            raise ServiceError(
                "invalid_provider_request",
                "workspace_dir is required for Hugging Face model card downloads",
                status_code=400,
                provider="huggingface",
            )
        workspace = safe_workspace_dir(request.workspace_dir, self.allowed_workspace_roots)
        revision = native.revision
        sha = revision if revision and re.fullmatch(r"[0-9a-fA-F]{40,64}", revision) else None
        info: Mapping[str, Any] = {}
        if sha is None:
            info = await self._hub_metadata("models_card", native, ["sha"])
            sha = string_value(info.get("sha"))
        if not sha:
            raise ServiceError(
                "invalid_provider_response",
                "Hugging Face model response did not contain a revision SHA",
                provider="huggingface",
            )

        repo_id = string_value(info.get("id")) or native.repo_id
        document_url = f"{self.endpoint}/{quote(repo_id, safe='/')}/raw/{quote(sha, safe='')}/README.md"
        key = stable_search_id("huggingface-model-card", f"{repo_id}@{sha}")
        output_dir = safe_output_dir(f"artifacts/huggingface/model-cards/{key}", workspace)
        target = output_dir / "README.md"
        cache_key = f"{repo_id}@{sha}"
        cache_hit = bool(
            self.material_cache and self.material_cache.restore_tree("huggingface-model-card-v1", cache_key, output_dir)
        )
        if target.is_file() and not target.is_symlink():
            if target.stat().st_size > self.max_download_bytes:
                raise ServiceError(
                    "huggingface_download_too_large",
                    f"Hugging Face model card exceeds max bytes of {self.max_download_bytes}",
                    status_code=400,
                    provider="huggingface",
                )
        else:
            headers = {"Accept": "text/markdown"}
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
            response = await self.http.request(
                "huggingface", "GET", document_url, headers=headers, follow_redirects=True
            )
            content = response.content
            if len(content) > self.max_download_bytes:
                raise ServiceError(
                    "huggingface_download_too_large",
                    f"Hugging Face model card exceeds max bytes of {self.max_download_bytes}",
                    status_code=400,
                    provider="huggingface",
                )
            temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
            try:
                temporary.write_bytes(content)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
            if self.material_cache:
                # cache_key 已经解析到 repo 的 commit sha, 内容由它唯一确定。
                self.material_cache.store_tree("huggingface-model-card-v1", cache_key, output_dir, immutable=True)

        relative_path = target.relative_to(workspace).as_posix()
        metadata: dict[str, Any] = {
            "resource_type": "model_card",
            "repo_id": repo_id,
            "revision": revision or sha,
            "sha": sha,
            "document_url": document_url,
            "artifact_path": relative_path,
            "byte_length": target.stat().st_size,
            "material_cache_hit": cache_hit,
            "provider_implementation": "huggingface_hub_http_v4",
            "reliability_tier": "platform_primary",
        }
        if repo_id != native.repo_id:
            metadata["requested_repo_id"] = native.repo_id
        return [
            SearchResult(
                id=stable_search_id("huggingface", document_url),
                title=f"{repo_id} model card",
                url=f"{self.endpoint}/{quote(repo_id, safe='/')}",
                snippet=f"Downloaded README.md for {repo_id} at {sha}.",
                authors=[repo_id.split("/", 1)[0]],
                metadata=metadata,
            )
        ]

    async def _hub_metadata(
        self,
        operation: Literal["models_info", "datasets_info", "models_card"],
        native: HubInfoParameters,
        expand: list[str],
    ) -> Mapping[str, Any]:
        resource_type = "datasets" if operation == "datasets_info" else "models"
        path = f"/api/{resource_type}/{quote(native.repo_id, safe='/')}"
        if native.revision is not None:
            path += f"/revision/{quote(native.revision, safe='')}"
        try:
            return json_object(await self._get(path, params={"expand": expand}))
        except ServiceError as error:
            upstream_status = error.details.get("upstream_status")
            if upstream_status not in (401, 404):
                raise
            author, separator, search = native.repo_id.partition("/")
            recovery_parameters = {"search": search or author}
            if separator:
                recovery_parameters["author"] = author
            suggestions: list[str] = []
            try:
                lookup_parameters = {"author": author, "limit": 100} if separator else {"search": author, "limit": 5}
                rows = json_list(
                    await self._get(
                        f"/api/{resource_type}",
                        params=lookup_parameters,
                    )
                )
                if separator:
                    candidates = {
                        repo_id.rpartition("/")[2].casefold(): repo_id
                        for row in rows
                        if (repo_id := hub_identifier(row))
                    }
                    requested_name = search.casefold()
                    matches = get_close_matches(requested_name, candidates, n=5, cutoff=0.6)
                    if requested_name in matches:
                        matches.insert(0, matches.pop(matches.index(requested_name)))
                    suggestions = [candidates[match] for match in matches]
                else:
                    suggestions = [repo_id for row in rows[:5] if (repo_id := hub_identifier(row))]
            except ServiceError:
                pass
            list_operation = operation.replace("_info", "_list").replace("models_card", "models_list")
            recovery_call = ", ".join(f"{key}={value}" for key, value in recovery_parameters.items())
            similar = f" Similar repo ids: {', '.join(suggestions)}." if suggestions else ""
            details: dict[str, Any] = {
                "circuit_scope": "request",
                "failure_scope": "request",
                "upstream_status": upstream_status,
                "operation": operation,
                "repo_id": native.repo_id,
                "recovery": {
                    "operation": list_operation,
                    "parameters": recovery_parameters,
                    "then": operation,
                },
            }
            if suggestions:
                details["suggestions"] = suggestions
            raise ServiceError(
                "huggingface_repository_not_found_or_inaccessible",
                f"Hugging Face repository '{native.repo_id}' was not found or is inaccessible."
                f"{similar} Call {list_operation}({recovery_call}) to obtain an exact repo_id, "
                f"then retry {operation}.",
                status_code=404,
                retryable=False,
                provider="huggingface",
                details=details,
            ) from error

    async def _dataset_leaderboard(
        self,
        parameters: StrictParameters,
        request: SearchRequest,
    ) -> list[SearchResult]:
        native = DatasetLeaderboardParameters.model_validate(parameters.model_dump())
        target = min(native.limit or request.max_results, request.max_results, MAX_PAGE_SIZE)
        response = await self._get(
            f"/api/datasets/{quote(native.dataset_id, safe='/')}/leaderboard",
        )
        rows = json_list(response)
        page = {"operation": "datasets_leaderboard", "limit": target}
        return [
            dataset_leaderboard_result(row, self.endpoint, native.dataset_id, page)
            for row in rows[:target]
            if string_value(row.get("modelId"))
        ]

    async def _get(self, path: str, *, params: Mapping[str, object] | None = None):
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return await self.http.request(
            "huggingface",
            "GET",
            f"{self.endpoint}{path}",
            headers=headers,
            params=params,
            follow_redirects=True,
        )


def hub_list_query(native: HubListParameters, target: int) -> dict[str, object]:
    params: dict[str, object] = {"limit": target}
    for key in ("search", "author", "cursor"):
        value = getattr(native, key)
        if value is not None:
            params[key] = value
    if native.filters:
        params["filter"] = native.filters
    if native.sort:
        params["sort"] = SORT_MAP[native.sort]
    if isinstance(native, ModelsListParameters):
        if native.apps:
            params["apps"] = native.apps
        if native.gated is not None:
            params["gated"] = native.gated
        if native.inference is not None:
            params["inference"] = native.inference
        if native.inference_provider is not None:
            params["inference_provider"] = native.inference_provider
        if native.pipeline_tag is not None:
            params["pipeline_tag"] = native.pipeline_tag
        if native.trained_datasets:
            params["filter"] = [
                *native.filters,
                *[
                    dataset if dataset.startswith("dataset:") else f"dataset:{dataset}"
                    for dataset in native.trained_datasets
                ],
            ]
        if native.num_parameters is not None:
            params["num_parameters"] = native.num_parameters
        if native.base_model_relation is not None:
            params["base_model_relation"] = native.base_model_relation
    elif isinstance(native, DatasetsListParameters):
        if native.gated is not None:
            params["gated"] = native.gated
    elif isinstance(native, SpacesListParameters):
        if native.datasets:
            params["datasets"] = native.datasets
        if native.models:
            params["models"] = native.models
        if native.linked:
            params["linked"] = True
    return params


def model_tag_catalog(payload: Mapping[str, Any]) -> dict[str, list[ModelTag]]:
    return {
        tag_type: sorted(
            (
                ModelTag(
                    tag_type=tag_type,
                    value=tag_id,
                    label=string_value(row.get("label")) or tag_id,
                )
                for row in rows
                if isinstance(row, Mapping)
                if (tag_id := string_value(row.get("id")))
            ),
            key=lambda tag: (len(tag.value), tag.value),
        )
        for tag_type, rows in payload.items()
        if isinstance(rows, list)
    }


def model_tag_suggestions(
    value: str,
    catalog: Mapping[str, list[ModelTag]],
    tag_type: str | None,
) -> list[ModelTag]:
    candidates = [tag for kind, tags in catalog.items() if tag_type is None or kind == tag_type for tag in tags]
    aliases: dict[str, list[ModelTag]] = {}
    for tag in candidates:
        for alias in {tag.value.casefold(), tag.label.casefold()}:
            aliases.setdefault(alias, []).append(tag)

    query = value.strip().casefold()
    if query in aliases:
        return aliases[query][:1]

    search_query = query
    if ":" in query:
        prefix, suffix = query.split(":", 1)
        scoped = catalog.get(prefix)
        if scoped:
            candidates = scoped
            aliases = {}
            for tag in candidates:
                for alias in {tag.value.casefold(), tag.label.casefold()}:
                    aliases.setdefault(alias, []).append(tag)
        search_query = suffix
        if search_query in aliases:
            return aliases[search_query][:1]

    terms = [term for term in re.split(r"[\s,;|+&/]+", search_query) if term]
    exact_terms: list[ModelTag] = []
    if len(terms) > 1:
        for term in terms:
            matches = aliases.get(term)
            if matches and matches[0] not in exact_terms:
                exact_terms.append(matches[0])
    if exact_terms:
        return exact_terms[:8]

    suggestions: list[ModelTag] = []
    for alias in get_close_matches(search_query, list(aliases), n=16, cutoff=0.45):
        for tag in aliases[alias]:
            if tag not in suggestions:
                suggestions.append(tag)
                break
        if len(suggestions) >= 8:
            break
    return suggestions


def model_tag_error(
    catalog: Mapping[str, list[ModelTag]],
    problems: list[tuple[str, str, str | None]],
    *,
    search_mode: bool = False,
) -> ServiceError:
    parameters: list[dict[str, Any]] = []
    messages: list[str] = []
    patches: list[dict[str, str]] = []
    calls: list[dict[str, Any]] = []

    for path, received, declared_type in problems:
        suggestions = model_tag_suggestions(received, catalog, declared_type)
        tag_type = declared_type or (suggestions[0].tag_type if suggestions else "other")
        rendered = [{"value": tag.value, "label": tag.label, "tag_type": tag.tag_type} for tag in suggestions]
        parameters.append(
            {
                "path": path,
                "received": received,
                "expected": {
                    "type": "tag_search" if search_mode else "tag_id",
                    "tag_type": tag_type,
                },
                "suggestions": rendered,
            }
        )
        if search_mode:
            selected = suggestions or catalog.get(tag_type, [])[:1]
            for tag in selected:
                call = {
                    "operation": "model_tags",
                    "parameters": {"tag_type": tag.tag_type, "search": tag.label},
                }
                if call not in calls:
                    calls.append(call)
            if selected:
                messages.extend(f"model_tags(tag_type={tag.tag_type!r}, search={tag.label!r})" for tag in selected)
            else:
                calls.append({"operation": "model_tags", "parameters": {"tag_type": tag_type}})
                messages.append(f"model_tags(tag_type={tag_type!r})")
        elif suggestions:
            suggestion = suggestions[0]
            patches.append({"path": path, "value": suggestion.value})
            messages.append(f"Replace {path}={received!r} with {suggestion.value!r} ({suggestion.label})")
        else:
            calls.append({"operation": "model_tags", "parameters": {"tag_type": tag_type}})
            messages.append(f"Call model_tags(tag_type={tag_type!r}) to list valid tag IDs for {path}")

    first_type = parameters[0]["expected"]["tag_type"]
    available = sorted(tag.value for tag in catalog.get(first_type, []))[:100]
    recovery = (
        {"action": "retry_operations", "calls": calls}
        if search_mode
        else {"action": "repair_parameters", "patches": patches, "lookups": calls}
    )
    guidance = "; ".join(messages) or "Call model_tags() to list valid tag IDs"
    return ServiceError(
        "huggingface_model_tag_not_found",
        f"Invalid Hugging Face model tag parameters. {guidance}.",
        status_code=400,
        retryable=False,
        provider="huggingface",
        details={
            "tag_type": first_type,
            "requested_tag": parameters[0]["received"],
            "available_tag_count": len(catalog.get(first_type, [])),
            "available_tags": available,
            "parameters": parameters,
            "recovery": recovery,
        },
    )


def markdown_headings(text: str) -> list[str]:
    return [match.group(1).strip() for line in text.splitlines()
            if (match := re.match(r"^#{1,6}\s+(.+?)\s*$", line))][:40]


def paper_bundle_metadata(
    row: Mapping[str, Any],
    paper_id: str,
    endpoint: str,
    document_url: str,
) -> dict[str, Any]:
    nested = row.get("paper")
    paper = nested if isinstance(nested, Mapping) else {}

    def value(key: str) -> str | None:
        result = string_value(row.get(key)) or string_value(paper.get(key))
        return result or None

    return {
        "schema_version": 1,
        "provider_id": "huggingface",
        "paper_id": paper_id,
        "page_url": f"{endpoint}/papers/{paper_id}",
        "document_url": document_url,
        "pdf_url": f"https://arxiv.org/pdf/{paper_id}",
        "github_repo": value("githubRepo"),
        "project_page": value("projectPage"),
        "native": dict(row),
    }


def write_atomic(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(content)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def paper_result(row: Mapping[str, Any], endpoint: str, page: Mapping[str, object]) -> SearchResult:
    nested = row.get("paper")
    paper = nested if isinstance(nested, Mapping) else {}
    paper_id = string_value(row.get("id")) or string_value(paper.get("id"))
    title = string_value(row.get("title")) or string_value(paper.get("title")) or paper_id
    summary = (
        string_value(paper.get("summary"))
        or string_value(row.get("summary"))
        or string_value(row.get("ai_summary"))
        or ""
    )
    authors = author_names(paper.get("authors") or row.get("authors"))
    published_at = string_value(paper.get("publishedAt")) or string_value(row.get("publishedAt"))
    landing_url = f"{endpoint}/papers/{paper_id}"
    metadata: dict[str, Any] = {
        "resource_type": "paper",
        "paper_id": paper_id,
        "pdf_url": f"https://arxiv.org/pdf/{paper_id}",
        "document_url": f"{endpoint}/papers/{paper_id}.md",
        "provider_implementation": "huggingface_hub_http_v4",
        "reliability_tier": "platform_primary",
        "huggingface_page": dict(page),
    }
    submitted_at = (
        string_value(paper.get("submittedOnDailyAt"))
        or string_value(row.get("submittedOnDailyAt"))
        or (string_value(row.get("publishedAt")) if page.get("operation") == "papers_list" else None)
    )
    if submitted_at:
        metadata["submitted_at"] = submitted_at
    copy_metadata(
        metadata,
        row,
        {
            "upvotes": "upvotes",
            "numComments": "comments",
            "discussionId": "discussion_id",
            "ai_summary": "ai_summary",
            "ai_keywords": "ai_keywords",
            "projectPage": "project_page",
            "githubRepo": "github_repo",
            "githubStars": "github_stars",
            "numTotalModels": "num_total_models",
            "numTotalDatasets": "num_total_datasets",
        },
    )
    for source in (paper, row):
        copy_metadata(
            metadata,
            source,
            {
                "upvotes": "upvotes",
                "discussionId": "discussion_id",
                "ai_summary": "ai_summary",
                "ai_keywords": "ai_keywords",
                "projectPage": "project_page",
                "githubRepo": "github_repo",
                "githubStars": "github_stars",
                "numTotalModels": "num_total_models",
                "numTotalDatasets": "num_total_datasets",
                "source": "source",
            },
        )
    return SearchResult(
        id=stable_search_id("huggingface", landing_url),
        title=title,
        url=landing_url,
        snippet=summary,
        published_at=published_at,
        authors=authors or None,
        metadata=metadata,
    )


def hub_result(
    row: Mapping[str, Any],
    endpoint: str,
    resource_type: str,
    page: Mapping[str, object],
) -> SearchResult:
    repo_id = hub_identifier(row)
    prefix = "" if resource_type == "model" else f"{resource_type}s/"
    landing_url = f"{endpoint}/{prefix}{repo_id}"
    sha = string_value(row.get("sha"))
    metadata: dict[str, Any] = {
        "resource_type": resource_type,
        "repo_id": repo_id,
        "provider_implementation": "huggingface_hub_http_v4",
        "reliability_tier": "platform_primary",
        "huggingface_page": dict(page),
    }
    if sha:
        metadata["document_url"] = f"{endpoint}/{prefix}{quote(repo_id, safe='/')}/raw/{quote(sha, safe='')}/README.md"
    copy_metadata(
        metadata,
        row,
        {
            "author": "author",
            "createdAt": "created_at",
            "lastModified": "updated_at",
            "sha": "sha",
            "downloads": "downloads",
            "downloadsAllTime": "downloads_all_time",
            "likes": "likes",
            "trendingScore": "trending_score",
            "pipeline_tag": "pipeline_tag",
            "library_name": "library_name",
            "gated": "gated",
            "cardData": "card_data",
            "model-index": "model_index",
            "private": "private",
            "disabled": "disabled",
            "tags": "tags",
            "sdk": "sdk",
            "models": "models",
            "datasets": "datasets",
        },
    )
    description = string_value(row.get("description"))
    return SearchResult(
        id=stable_search_id("huggingface", landing_url),
        title=repo_id,
        url=landing_url,
        snippet=description or hub_snippet(row, resource_type),
        published_at=string_value(row.get("createdAt")),
        authors=[string_value(row.get("author")) or repo_id.split("/", 1)[0]],
        metadata=metadata,
    )


def dataset_leaderboard_result(
    row: Mapping[str, Any],
    endpoint: str,
    dataset_id: str,
    page: Mapping[str, object],
) -> SearchResult:
    model_id = string_value(row.get("modelId"))
    leaderboard_url = f"{endpoint}/datasets/{dataset_id}#leaderboard"
    # ponytail: model URLs distinguish rows within one leaderboard. Add structured result identity
    # if a single Worker must retain the same model independently across multiple leaderboards.
    # The upstream filename is descriptive metadata, not a guaranteed public repository path.
    landing_url = f"{endpoint}/{quote(model_id, safe='/')}"
    rank = row.get("rank")
    score = row.get("value")
    lower_is_better = row.get("lower_is_better")
    metadata: dict[str, Any] = {
        "resource_type": "dataset_leaderboard_entry",
        "dataset_id": dataset_id,
        "model_id": model_id,
        "repo_id": model_id,
        "leaderboard_url": leaderboard_url,
        "provider_implementation": "huggingface_hub_http_v4",
        "reliability_tier": "platform_primary",
        "huggingface_page": dict(page),
    }
    copy_metadata(
        metadata,
        row,
        {
            "rank": "rank",
            "value": "score",
            "verified": "verified",
            "filename": "filename",
            "source": "source",
            "pullRequest": "pull_request",
            "lower_is_better": "lower_is_better",
            "num_parameters": "num_parameters",
        },
    )
    direction = "lower is better" if lower_is_better is True else "higher is better"
    snippet = f"Rank {rank} on {dataset_id}; score {score} ({direction})."
    author = row.get("author")
    author_name = string_value(author.get("name")) if isinstance(author, Mapping) else ""
    return SearchResult(
        id=stable_search_id("huggingface", landing_url),
        title=model_id,
        url=landing_url,
        snippet=snippet,
        authors=[author_name or model_id.split("/", 1)[0]],
        metadata=metadata,
    )


def hub_snippet(row: Mapping[str, Any], resource_type: str) -> str:
    parts = [f"Hugging Face {resource_type} repository."]
    pipeline = string_value(row.get("pipeline_tag"))
    library = string_value(row.get("library_name"))
    if pipeline:
        parts.append(f"Task: {pipeline}.")
    if library:
        parts.append(f"Library: {library}.")
    return " ".join(parts)


def paper_identifier(row: Mapping[str, Any]) -> str:
    nested = row.get("paper")
    paper = nested if isinstance(nested, Mapping) else {}
    return string_value(row.get("id")) or string_value(paper.get("id"))


def hub_identifier(row: Mapping[str, Any]) -> str:
    return string_value(row.get("id")) or string_value(row.get("modelId"))


def author_names(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    names: list[str] = []
    for author in raw:
        if isinstance(author, str) and author.strip():
            names.append(author.strip())
        elif isinstance(author, Mapping):
            name = string_value(author.get("name"))
            if name:
                names.append(name)
    return names


def copy_metadata(target: dict[str, Any], source: Mapping[str, Any], fields: Mapping[str, str]) -> None:
    for source_key, target_key in fields.items():
        value = source.get(source_key)
        if value is not None:
            target[target_key] = value


def response_next_cursor(response) -> str | None:
    try:
        next_url = response.links.get("next", {}).get("url")
    except (KeyError, ValueError):
        return None
    if not next_url:
        return None
    values = parse_qs(urlparse(next_url).query).get("cursor")
    return values[0] if values else None


def json_list(response) -> list[dict[str, Any]]:
    try:
        payload = response.json()
    except ValueError as error:
        raise ServiceError(
            "invalid_provider_response",
            "Hugging Face returned invalid JSON",
            provider="huggingface",
        ) from error
    if not isinstance(payload, list) or any(not isinstance(item, dict) for item in payload):
        raise ServiceError(
            "invalid_provider_response",
            "Hugging Face returned a non-list search response",
            provider="huggingface",
        )
    return payload


def json_object(response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as error:
        raise ServiceError(
            "invalid_provider_response",
            "Hugging Face returned invalid JSON",
            provider="huggingface",
        ) from error
    if not isinstance(payload, dict):
        raise ServiceError(
            "invalid_provider_response",
            "Hugging Face returned a non-object response",
            provider="huggingface",
        )
    return payload


def string_value(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


SPECS = (
    SourceSpec(
        id="huggingface",
        credentialed=True,
        probe_request=ProviderRequest(operation="models_list", parameters={"limit": 1}),
        build=lambda deps: HuggingFaceSource(
            deps.http,
            deps.settings.huggingface_endpoint,
            secret(deps.settings.huggingface_token),
            deps.settings.resolved_workspace_roots(),
            deps.settings.max_document_bytes,
            deps.material_cache,
        ),
        max_concurrency=lambda settings: settings.huggingface_max_concurrency,
    ),
)
