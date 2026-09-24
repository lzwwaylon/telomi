from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from pydantic import SecretStr

from ..models import ProviderRequest, SearchRequest, SearchResult

if TYPE_CHECKING:
    from ..config import Settings
    from ..documents import DocumentService
    from ..http_client import HttpGateway
    from ..material_cache import MaterialCache


class Source(Protocol):
    async def search(self, request: SearchRequest) -> list[SearchResult]: ...


def stable_search_id(source: str, url: str) -> str:
    digest = hashlib.sha256(f"{source}\n{url}".encode()).hexdigest()
    return f"{source}-{digest[:32]}"


SearchOperation = Callable[[], Awaitable[list[SearchResult]]]


def secret(value: SecretStr | None) -> str | None:
    return value.get_secret_value() if value else None


# 校验候选凭据用的最小检索。中性查询，只为让 Provider 对这把 key 作答。
CREDENTIAL_PROBE_QUERY = "telomi credential check"


@dataclass(frozen=True)
class SourceDeps:
    """注册表持有、装配任何 Source 都可能用到的共享对象。"""

    settings: Settings
    http: HttpGateway
    documents: DocumentService
    material_cache: MaterialCache


@dataclass(frozen=True)
class SourceSpec:
    """一个 Source 在本服务里的全部登记。

    每个 `sources/` 模块通过模块级 `SPECS` 暴露自己的登记，注册表自动发现，不再另外维护名单。
    `credentialed` 为真的 Source 会按请求携带的凭据重新装配；`probe_request` 给出校验凭据时
    Provider 要求的原生操作，没有时用普通检索。
    """

    id: str
    build: Callable[[SourceDeps], Source]
    max_concurrency: Callable[[Settings], int]
    credentialed: bool = False
    probe_request: ProviderRequest | None = None
