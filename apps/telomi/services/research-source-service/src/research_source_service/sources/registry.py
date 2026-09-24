from __future__ import annotations

from collections.abc import Mapping

from ..config import Settings
from ..documents import DocumentService
from ..errors import ServiceError
from ..http_client import HttpGateway
from ..material_cache import MaterialCache
from ..models import SearchRequest, SearchResult
from ..scheduling import ProviderGate
from .base import CREDENTIAL_PROBE_QUERY, Source, SourceDeps
from .catalog import discover_specs


class SourceRegistry:
    def __init__(self, settings: Settings, http: HttpGateway, documents: DocumentService) -> None:
        self.settings = settings
        self.http = http
        self.documents = documents
        self.max_results = settings.max_search_results
        self.material_cache = MaterialCache(
            settings.material_cache_root,
            ttl_seconds=settings.material_cache_ttl_seconds,
            base_root=settings.material_cache_base_root,
        )
        self.specs = {spec.id: spec for spec in discover_specs()}
        deps = self._deps(settings)
        self.sources: dict[str, Source] = {spec.id: spec.build(deps) for spec in self.specs.values()}
        self.gates = {spec.id: ProviderGate(spec.max_concurrency(settings)) for spec in self.specs.values()}

    def _deps(self, settings: Settings) -> SourceDeps:
        return SourceDeps(
            settings=settings, http=self.http, documents=self.documents, material_cache=self.material_cache
        )

    def _credentialed_sources(self, settings: Settings) -> dict[str, Source]:
        """按一组凭据装配凭据决定行为的 Source。构造只是赋值，没有 I/O，因此按请求装配是廉价的。

        素材缓存和并发闸门由注册表持有，不随凭据重建。
        """
        deps = self._deps(settings)
        return {spec.id: spec.build(deps) for spec in self.specs.values() if spec.credentialed}

    def _with_credentials(self, credential: Mapping[str, str | None]) -> Settings:
        """本服务只接受它自己读取的 Provider 凭据名。其它名字一律拒绝，包括它自己的调用凭据。"""
        try:
            return self.settings.with_credentials(credential)
        except KeyError as error:
            raise ServiceError(
                "unknown_credential",
                f"'{error.args[0]}' is not a Provider credential this service reads",
                status_code=400,
            ) from error

    def source_for(self, source_id: str, credential: Mapping[str, str | None] | None) -> Source | None:
        """本次请求使用的 Source。

        调用方给出凭据时为这一次请求单独装配一个 Source，服务启动时缓存的设置不参与决定。
        请求因此始终用调用方解析出的那把 key 作答：轮换不会改变已经发出的请求，删除后的旧值也
        不会在长驻服务里继续生效，调用方给这次结果记的缓存作用域与实际使用的凭据必然一致。
        """
        spec = self.specs.get(source_id)
        if spec is None:
            return None
        if credential is None or not spec.credentialed:
            return self.sources[source_id]
        return spec.build(self._deps(self._with_credentials(credential)))

    async def verify_credential(self, source_id: str, credential: Mapping[str, str | None]) -> None:
        """向 Provider 求证一个候选凭据，不让它成为任何请求会用到的凭据。

        临时 Source 只服务这一次校验调用，随后即被丢弃：候选凭据不写入任何地方，被拒绝时在用
        配置原样保留。结论由 Provider 自己的回答给出。
        """
        spec = self.specs.get(source_id)
        if spec is None or not spec.credentialed:
            raise ServiceError(
                "source_not_registered",
                f"Research source '{source_id}' does not take a managed credential",
                status_code=404,
            )
        source = spec.build(self._deps(self._with_credentials(credential)))
        await self.gates[source_id].run(
            lambda: source.search(
                SearchRequest(
                    source_id=source_id,
                    query=CREDENTIAL_PROBE_QUERY,
                    max_results=1,
                    provider_request=spec.probe_request,
                )
            )
        )

    def close(self) -> None:
        for source in self.sources.values():
            close = getattr(source, "close", None)
            if callable(close):
                close()

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        if request.max_results > self.max_results:
            raise ServiceError(
                "max_results_exceeded",
                f"max_results cannot exceed the service limit of {self.max_results}",
                status_code=400,
                provider=request.source_id,
                details={
                    "provided": request.max_results,
                    "maximum": self.max_results,
                    "parameter": "max_results",
                },
            )
        source = self.source_for(request.source_id, request.credential)
        if not source:
            raise ServiceError(
                "source_not_registered",
                f"Research source '{request.source_id}' is not registered",
                status_code=404,
            )
        return await self.gates[request.source_id].run(lambda: source.search(request))
