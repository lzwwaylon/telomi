from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProviderRequest(StrictModel):
    operation: str = Field(min_length=1, max_length=64)
    parameters: dict[str, Any] = Field(default_factory=dict)


class TemporalRange(StrictModel):
    start_date: str = Field(min_length=1, max_length=32)
    end_date: str = Field(min_length=1, max_length=32)


class SearchRequest(StrictModel):
    schema_version: Literal[1] = 1
    source_id: str = Field(min_length=1, max_length=64)
    query: str = Field(min_length=1, max_length=20_000)
    max_results: int = Field(default=10, ge=1, le=30_000)
    criterion_ids: list[str] = Field(default_factory=list, max_length=1_000)
    purpose: str = Field(default="", max_length=4_000)
    workspace_dir: str | None = Field(default=None, max_length=4_096)
    temporal_range: TemporalRange | None = None
    provider_request: ProviderRequest | None = None
    # 调用方为这一次请求指定的 Provider 凭据，键是环境变量名，值为 null 表示该凭据不存在。
    # 给出时完全覆盖服务自身的配置：请求用哪把 key 由调用方决定，不受服务启动时缓存的设置影响。
    credential: dict[str, str | None] | None = Field(default=None, max_length=32)

    @field_validator("credential")
    @classmethod
    def validate_credential(cls, value: dict[str, str | None] | None) -> dict[str, str | None] | None:
        return validate_credential_map(value)


class SearchResult(StrictModel):
    id: str
    title: str
    url: str
    snippet: str
    published_at: str | None = None
    authors: list[str] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchResponse(StrictModel):
    schema_version: Literal[1] = 1
    source_id: str
    results: list[SearchResult]
    elapsed_ms: int = Field(ge=0)


class HealthResponse(StrictModel):
    status: Literal["ok"]
    service: Literal["research-source-service"]
    version: str


class SourcesResponse(StrictModel):
    """The source ids this service registers, so the host can check its own catalog against them."""

    schema_version: Literal[1] = 1
    sources: list[str]


def validate_credential_map(
    value: dict[str, str | None] | None,
) -> dict[str, str | None] | None:
    """只校验凭据的名字和长度。任何报错都不带出凭据本身。"""
    if value is None:
        return None
    for name, secret in value.items():
        if not name or len(name) > 128:
            raise ValueError("credential names must be 1 to 128 characters")
        # Managed cookie exports retain the legacy file reader's 2 MiB byte limit.
        limit = 2 * 1024 * 1024 if name == "SOURCE_SERVICE_TWITTER_COOKIE" else 20_000
        if secret is not None and (not secret.strip() or len(secret.encode("utf-8")) > limit):
            raise ValueError(f"credential '{name}' must be a non-empty value of at most {limit} bytes")
    return value


class CredentialCheckRequest(StrictModel):
    """校验一个候选凭据。服务只为这次调用装配一个临时 Source，不改变任何在用配置。"""

    schema_version: Literal[1] = 1
    source_id: str = Field(min_length=1, max_length=64)
    credential: dict[str, str | None] = Field(max_length=32)

    @field_validator("credential")
    @classmethod
    def validate_credential(cls, value: dict[str, str | None]) -> dict[str, str | None]:
        checked = validate_credential_map(value)
        assert checked is not None
        return checked


class CredentialCheckResponse(StrictModel):
    schema_version: Literal[1] = 1
    source_id: str


class CitationUrlValidationRequest(StrictModel):
    schema_version: Literal[1] = 1
    markdown: str = Field(min_length=1, max_length=10_000_000)


class CitationUrlValidationResponse(StrictModel):
    schema_version: Literal[1] = 1
    unavailable_urls: list[str]


class DocumentParseRequest(StrictModel):
    schema_version: Literal[1] = 1
    input_path: str = Field(min_length=1, max_length=8_192)
    input_root: str = Field(min_length=1, max_length=4_096)
    content_type: str | None = Field(default=None, max_length=255)
    source_name: str | None = Field(default=None, max_length=512)
    title: str | None = Field(default=None, max_length=1_000)
    page_range: tuple[int, int] | None = None
    asset_output_dir: str | None = Field(default=None, max_length=4_096)

    @field_validator("page_range", mode="before")
    @classmethod
    def validate_page_range(cls, value: object) -> object:
        if value is None:
            return value
        if (
            not isinstance(value, (list, tuple))
            or len(value) != 2
            or any(not isinstance(page, int) or isinstance(page, bool) for page in value)
            or value[0] < 1
            or value[1] < value[0]
        ):
            raise ValueError("page_range must be a one-based inclusive [start_page, end_page] pair")
        return value


class DocumentManifest(StrictModel):
    schema_version: Literal[2] = 2
    document_id: str
    content_sha256: str
    document_sha256: str
    parser: str
    content_type: str | None
    source_name: str
    title: str | None = None
    parse_metadata: dict[str, Any]
    assets: list[dict[str, Any]] = Field(default_factory=list)


class DocumentParseResponse(StrictModel):
    schema_version: Literal[2] = 2
    document: dict[str, Any]
    manifest: DocumentManifest


class TreeStoreRequest(StrictModel):
    schema_version: Literal[1] = 1
    path: str = Field(min_length=1, max_length=4_096)
    exclude: list[str] = Field(default_factory=list, max_length=200)


class TreeStoreResponse(StrictModel):
    schema_version: Literal[1] = 1
    tree_sha: str
    file_count: int = Field(ge=0)
    total_bytes: int = Field(ge=0)


class TreeGcRequest(StrictModel):
    keep_tree_shas: list[str] = Field(max_length=100_000)
    dry_run: bool

    @field_validator("keep_tree_shas")
    @classmethod
    def validate_tree_shas(cls, value: list[str]) -> list[str]:
        if any(len(item) != 64 or any(char not in "0123456789abcdef" for char in item) for item in value):
            raise ValueError("keep_tree_shas must contain lowercase hex sha256 values")
        return value


class TreeGcResponse(StrictModel):
    trees_removed: int = Field(ge=0)
    blobs_removed: int = Field(ge=0)
    bytes_freed: int = Field(ge=0)


class TreeRestoreRequest(StrictModel):
    schema_version: Literal[1] = 1
    path: str = Field(min_length=1, max_length=4_096)


class TreeRestoreResponse(StrictModel):
    schema_version: Literal[1] = 1
    tree_sha: str
    materialize_mode: Literal["clone", "copy"]


class ErrorBody(StrictModel):
    code: str
    message: str
    failure_class: Literal[
        "cancelled",
        "timeout",
        "rate_limit",
        "provider",
        "validation",
        "budget",
        "permanent",
    ]
    retryable: bool
    provider: str | None = None
    request_id: str
    retry_after_ms: int | None = Field(default=None, ge=0)
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(StrictModel):
    error: ErrorBody
