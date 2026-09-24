from __future__ import annotations

import ipaddress
import os
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path
from typing import Annotated, get_args

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# 指向凭据本身的路径字段。它们不带值，但删除凭据时必须能一并清掉，否则 Provider 会继续
# 从文件里读到用户刚刚删除的凭据。
CREDENTIAL_LOCATION_FIELDS = ("twitter_cookie_file",)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SOURCE_SERVICE_",
        case_sensitive=False,
        extra="ignore",
        populate_by_name=True,
    )

    api_token: SecretStr = Field(min_length=16)
    host: str = "127.0.0.1"
    port: int = Field(default=8791, ge=1, le=65_535)
    workspace_roots: Annotated[tuple[Path, ...], NoDecode] = ()
    max_search_results: int = Field(default=100, ge=1, le=1_000)
    max_document_bytes: int = Field(default=50 * 1024 * 1024, ge=1_024, le=500 * 1024 * 1024)
    material_cache_root: Path | None = None
    # Candidate 实例专用：只读的正式缓存。命中读它，写入只落在 material_cache_root。
    material_cache_base_root: Path | None = None
    material_cache_ttl_seconds: int = Field(default=24 * 60 * 60, ge=60, le=30 * 24 * 60 * 60)
    material_cache_retention_seconds: int = Field(default=30 * 24 * 60 * 60, gt=0)
    material_cache_max_bytes: int = Field(default=50 * 1024 * 1024 * 1024, gt=0)
    material_cache_gc_interval_seconds: int = Field(default=60 * 60, gt=0)

    arxiv_max_concurrency: int = Field(default=1, ge=1, le=16)
    arxiv_sqlite_path: Path = Field(
        default_factory=lambda: Path.home() / ".telomi" / "runtime" / "research-sources" / "arxiv-runtime.sqlite3"
    )
    arxiv_cache_ttl_seconds: int = Field(default=24 * 60 * 60, ge=60, le=30 * 24 * 60 * 60)
    arxiv_min_start_interval_seconds: float = Field(default=4, ge=0, le=60)
    arxiv_main_site_min_start_interval_seconds: float = Field(default=8, ge=0, le=60)
    arxiv_global_min_start_interval_seconds: float = Field(default=3, ge=0, le=60)
    arxiv_overload_cooldown_seconds: float = Field(default=15 * 60, ge=0, le=60 * 60)
    huggingface_max_concurrency: int = Field(default=1, ge=1, le=16)
    twitter_max_concurrency: int = Field(default=1, ge=1, le=4)
    github_max_concurrency: int = Field(default=1, ge=1, le=16)
    general_web_max_concurrency: int = Field(default=1, ge=1, le=16)
    user_documents_max_concurrency: int = Field(default=4, ge=1, le=32)
    document_max_concurrency: int = Field(default=2, ge=1, le=16)
    lychee_path: Path | None = None

    github_token: SecretStr | None = Field(
        default=None,
        validation_alias="SOURCE_SERVICE_GITHUB_TOKEN",
    )
    huggingface_token: SecretStr | None = Field(
        default=None,
        validation_alias="SOURCE_SERVICE_HUGGINGFACE_TOKEN",
    )
    twitter_cookie: SecretStr | None = Field(
        default=None,
        validation_alias="SOURCE_SERVICE_TWITTER_COOKIE",
    )
    twitter_cookie_file: Path | None = Field(
        default=None,
        validation_alias="SOURCE_SERVICE_TWITTER_COOKIE_FILE",
    )
    twitter_bearer_token: SecretStr | None = Field(
        default=None,
        validation_alias="SOURCE_SERVICE_TWITTER_BEARER_TOKEN",
    )
    twitter_operations_file: Path | None = Field(
        default=None,
        validation_alias="SOURCE_SERVICE_TWITTER_OPERATIONS_FILE",
    )
    firecrawl_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="SOURCE_SERVICE_FIRECRAWL_API_KEY",
    )
    tavily_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="SOURCE_SERVICE_TAVILY_API_KEY",
    )
    exa_api_key: SecretStr | None = Field(
        default=None,
        validation_alias="SOURCE_SERVICE_EXA_API_KEY",
    )

    arxiv_endpoint: str = "https://export.arxiv.org/api/query"
    huggingface_endpoint: str = "https://huggingface.co"
    twitter_endpoint: str = "https://x.com"
    firecrawl_endpoint: str = "https://api.firecrawl.dev/v2/search"
    tavily_endpoint: str = "https://api.tavily.com/search"
    exa_endpoint: str = "https://api.exa.ai/search"

    @field_validator("workspace_roots", mode="before")
    @classmethod
    def parse_workspace_roots(cls, value: object) -> object:
        if isinstance(value, str):
            return tuple(Path(item) for item in value.split(os.pathsep) if item.strip())
        return value

    @field_validator("host")
    @classmethod
    def require_loopback_host(cls, value: str) -> str:
        if value == "localhost":
            return value
        try:
            if ipaddress.ip_address(value).is_loopback:
                return value
        except ValueError:
            pass
        raise ValueError("host must be a loopback address or localhost")

    def resolved_workspace_roots(self) -> tuple[Path, ...]:
        return tuple(path.expanduser().resolve() for path in self.workspace_roots)

    @classmethod
    def credential_fields(cls) -> dict[str, str]:
        """环境变量名到 Provider 凭据字段的映射，直接从字段的 validation_alias 推导。

        统一设置入口按这些名字下发凭据。这里不另写一份名单，否则新增字段时两处会漂移。
        """
        mapping: dict[str, str] = {}
        for name, field in cls.model_fields.items():
            # api_token 是本服务自己的调用凭据，不是 Provider 凭据，不能从这条通道改。
            if name == "api_token":
                continue
            is_secret = SecretStr in (get_args(field.annotation) or (field.annotation,))
            if not is_secret and name not in CREDENTIAL_LOCATION_FIELDS:
                continue
            alias = field.validation_alias
            if isinstance(alias, str):
                mapping[alias.upper()] = name
        return mapping

    def with_credentials(self, values: Mapping[str, str | None]) -> Settings:
        """返回一份替换了指定凭据的设置副本，不改动当前实例。

        候选凭据先在副本上装配并验证，验证不通过时正在服务的设置原样保留。
        """
        update: dict[str, SecretStr | Path | None] = {}
        fields = self.credential_fields()
        for name, value in values.items():
            field = fields.get(name.upper())
            if field is None:
                raise KeyError(name)
            if field in CREDENTIAL_LOCATION_FIELDS:
                update[field] = Path(value) if value else None
            else:
                update[field] = SecretStr(value) if value else None
        return self.model_copy(update=update)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
