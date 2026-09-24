from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from collections.abc import Coroutine
from contextlib import asynccontextmanager, suppress
from importlib.metadata import version
from typing import Any, TypeVar

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .citation_urls import CitationUrlValidator
from .config import Settings, get_settings
from .documents import DocumentService
from .errors import ServiceError
from .http_client import HttpGateway
from .material_cache import MaterialCache
from .models import (
    CitationUrlValidationRequest,
    CitationUrlValidationResponse,
    CredentialCheckRequest,
    CredentialCheckResponse,
    DocumentParseRequest,
    DocumentParseResponse,
    ErrorBody,
    ErrorResponse,
    HealthResponse,
    SearchRequest,
    SearchResponse,
    SourcesResponse,
    TreeGcRequest,
    TreeGcResponse,
    TreeRestoreRequest,
    TreeRestoreResponse,
    TreeStoreRequest,
    TreeStoreResponse,
)
from .security import require_api_token, safe_workspace_dir
from .sources import SourceRegistry
from .sources.twitter import parse_cookie_input

LOGGER = logging.getLogger(__name__)
VERSION = version("telomi-research-source-service")
T = TypeVar("T")


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        scope.setdefault("state", {})["request_id"] = Headers(scope=scope).get("x-request-id") or str(uuid.uuid4())

        async def send_response(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["x-request-id"] = scope["state"]["request_id"]
            await send(message)

        # Request.is_disconnected() must poll the server's receive directly.
        await self.app(scope, receive, send_response)


async def cancel_on_disconnect(request: Request, operation: Coroutine[Any, Any, T]) -> T:
    task = asyncio.create_task(operation)
    try:
        while not task.done():
            if await request.is_disconnected():
                task.cancel()
                return await task
            await asyncio.wait((task,), timeout=0.1)
        return await task
    finally:
        if not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


def create_app(
    settings: Settings | None = None,
    http_client: httpx.AsyncClient | None = None,
    url_validator: CitationUrlValidator | None = None,
) -> FastAPI:
    configured = settings or get_settings()
    owned_client = http_client is None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Report Provider calls are governed by caller cancellation. Do not add
        # a wall-clock timeout here because complete pagination can run long.
        client = http_client or httpx.AsyncClient(
            timeout=None,
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
        )
        gateway = HttpGateway(client)
        documents = DocumentService(
            allowed_workspace_roots=configured.resolved_workspace_roots(),
            max_bytes=configured.max_document_bytes,
            max_concurrency=configured.document_max_concurrency,
            # Parsed documents share the Provider content-addressed store so the
            # same PDF is not converted twice.
            material_cache=MaterialCache(
                configured.material_cache_root,
                ttl_seconds=configured.material_cache_ttl_seconds,
                base_root=configured.material_cache_base_root,
            ),
        )
        # Without a cache root, each PDF is sent to Docling again. Log that
        # explicitly so standalone service launches do not assume caching works.
        if configured.material_cache_root:
            LOGGER.info(
                "Document Convert cache enabled at %s", configured.material_cache_root
            )
        else:
            LOGGER.warning(
                "Document Convert cache disabled: SOURCE_SERVICE_MATERIAL_CACHE_ROOT is unset; "
                "every parse will re-run the converter"
            )
        app.state.documents = documents
        app.state.registry = SourceRegistry(configured, gateway, documents)
        app.state.url_validator = url_validator or CitationUrlValidator(configured.lychee_path)
        stop_gc = asyncio.Event()

        async def collect_material_cache() -> None:
            while not stop_gc.is_set():
                try:
                    report = await asyncio.to_thread(
                        app.state.registry.material_cache.collect_garbage,
                        max_idle_seconds=configured.material_cache_retention_seconds,
                        max_bytes=configured.material_cache_max_bytes,
                        blocking=False,
                    )
                    LOGGER.info("Material cache GC: %s", report)
                    if report.get("over_limit_bytes", 0):
                        LOGGER.warning(
                            "Material cache remains %s bytes above its capacity target; "
                            "protected workspace snapshots are retained",
                            report["over_limit_bytes"],
                        )
                except Exception:
                    LOGGER.exception("Material cache GC failed; will retry on the next scheduled pass")
                try:
                    await asyncio.wait_for(stop_gc.wait(), configured.material_cache_gc_interval_seconds)
                except TimeoutError:
                    pass

        app.state.material_cache_gc_task = (
            asyncio.create_task(collect_material_cache()) if configured.material_cache_root else None
        )
        try:
            yield
        finally:
            stop_gc.set()
            if app.state.material_cache_gc_task is not None:
                # Cancelling to_thread would leave deletion running after service shutdown.
                await app.state.material_cache_gc_task
            app.state.registry.close()
            if owned_client:
                await client.aclose()

    authentication = Depends(require_api_token(configured.api_token.get_secret_value()))
    app = FastAPI(
        title="Telomi Research Source Service",
        version=VERSION,
        lifespan=lifespan,
        dependencies=[authentication],
    )

    app.add_middleware(RequestContextMiddleware)

    @app.exception_handler(ServiceError)
    async def service_error_handler(request: Request, error: ServiceError) -> JSONResponse:
        body = ErrorResponse(
            error=ErrorBody(
                code=error.code,
                message=error.message,
                failure_class=failure_class(error),
                retryable=error.retryable,
                provider=error.provider,
                request_id=request_id(request),
                retry_after_ms=error.retry_after_ms,
                details=error.details,
            )
        )
        headers = {"WWW-Authenticate": "Bearer"} if error.status_code == 401 else None
        # Provider errors may echo arbitrary keys, including cookie components, without labels.
        credentials = getattr(request.state, "provider_credentials", None) or {}
        secrets = [value for value in credentials.values() if value]
        cookie = credentials.get("SOURCE_SERVICE_TWITTER_COOKIE")
        if cookie:
            with suppress(ServiceError):
                secrets.extend(parse_cookie_input(cookie).values())
        encoded = body.model_dump_json()
        for secret in sorted(filter(None, set(secrets)), key=len, reverse=True):
            encoded = encoded.replace(json.dumps(secret, ensure_ascii=False)[1:-1], "[redacted]")
        return JSONResponse(status_code=error.status_code, content=json.loads(encoded), headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, error: RequestValidationError) -> JSONResponse:
        details = {
            "violations": [
                {
                    "location": [str(value) for value in violation["loc"]],
                    "message": violation["msg"],
                    "type": violation["type"],
                }
                for violation in error.errors()
            ]
        }
        body = ErrorResponse(
            error=ErrorBody(
                code="request_validation_failed",
                message="Request did not match the API contract",
                failure_class="validation",
                retryable=False,
                request_id=request_id(request),
                details=details,
            )
        )
        return JSONResponse(status_code=422, content=body.model_dump(mode="json"))

    @app.exception_handler(Exception)
    async def unexpected_error_handler(request: Request, error: Exception) -> JSONResponse:
        LOGGER.exception("Unhandled source service error", exc_info=error)
        body = ErrorResponse(
            error=ErrorBody(
                code="internal_error",
                message="The source service encountered an internal error",
                failure_class="permanent",
                retryable=False,
                request_id=request_id(request),
            )
        )
        return JSONResponse(status_code=500, content=body.model_dump(mode="json"))

    @app.get("/v1/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(status="ok", service="research-source-service", version=VERSION)

    @app.get("/v1/sources", response_model=SourcesResponse)
    async def sources(raw_request: Request) -> SourcesResponse:
        registry: SourceRegistry = raw_request.app.state.registry
        return SourcesResponse(sources=sorted(registry.sources))

    @app.post(
        "/v1/search",
        response_model=SearchResponse,
        responses={400: {"model": ErrorResponse}, 502: {"model": ErrorResponse}},
    )
    async def search(request: SearchRequest, raw_request: Request) -> SearchResponse:
        started = time.monotonic()
        registry: SourceRegistry = raw_request.app.state.registry
        raw_request.state.provider_credentials = request.credential
        results = await cancel_on_disconnect(raw_request, registry.search(request))
        return SearchResponse(
            source_id=request.source_id,
            results=results,
            elapsed_ms=max(0, round((time.monotonic() - started) * 1_000)),
        )

    @app.post(
        "/v1/credentials/verify",
        response_model=CredentialCheckResponse,
        responses={400: {"model": ErrorResponse}, 404: {"model": ErrorResponse}, 502: {"model": ErrorResponse}},
    )
    async def verify_credential(
        request: CredentialCheckRequest, raw_request: Request
    ) -> CredentialCheckResponse:
        """校验一个候选凭据。候选只服务这一次调用，不会成为任何请求使用的凭据。"""
        registry: SourceRegistry = raw_request.app.state.registry
        raw_request.state.provider_credentials = request.credential
        await cancel_on_disconnect(
            raw_request, registry.verify_credential(request.source_id, request.credential)
        )
        return CredentialCheckResponse(source_id=request.source_id)

    @app.post(
        "/v1/documents/parse",
        response_model=DocumentParseResponse,
        responses={400: {"model": ErrorResponse}, 502: {"model": ErrorResponse}},
    )
    async def parse_document(request: DocumentParseRequest, raw_request: Request) -> DocumentParseResponse:
        documents: DocumentService = raw_request.app.state.documents
        return await documents.parse(request)

    @app.post(
        "/v1/citations/validate-urls",
        response_model=CitationUrlValidationResponse,
        responses={502: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
    )
    async def validate_citation_urls(
        request: CitationUrlValidationRequest,
        raw_request: Request,
    ) -> CitationUrlValidationResponse:
        validator: CitationUrlValidator = raw_request.app.state.url_validator
        return CitationUrlValidationResponse(unavailable_urls=await validator.validate(request.markdown))

    def material_cache(raw_request: Request) -> MaterialCache:
        cache: MaterialCache = raw_request.app.state.registry.material_cache
        if cache.root is None:
            raise ServiceError(
                "material_cache_disabled",
                "SOURCE_SERVICE_MATERIAL_CACHE_ROOT is unset; workspace trees cannot be stored",
                status_code=503,
            )
        return cache

    @app.post(
        "/v1/trees",
        response_model=TreeStoreResponse,
        responses={400: {"model": ErrorResponse}, 403: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
    )
    async def store_tree(request: TreeStoreRequest, raw_request: Request) -> TreeStoreResponse:
        cache = material_cache(raw_request)
        source = safe_workspace_dir(request.path, configured.resolved_workspace_roots())
        tree_sha, file_count, total_bytes = await asyncio.to_thread(
            cache.store_tree_sha, source, tuple(request.exclude)
        )
        return TreeStoreResponse(tree_sha=tree_sha, file_count=file_count, total_bytes=total_bytes)

    @app.post(
        "/v1/trees/gc",
        response_model=TreeGcResponse,
        responses={503: {"model": ErrorResponse}},
    )
    async def gc_trees(request: TreeGcRequest, raw_request: Request) -> TreeGcResponse:
        plan = await asyncio.to_thread(
            material_cache(raw_request).collect_garbage,
            dry_run=request.dry_run,
            keep_workspace_tree_shas=set(request.keep_tree_shas),
        )
        return TreeGcResponse(
            trees_removed=plan["dead_trees"],
            blobs_removed=plan["dead_blobs"],
            bytes_freed=plan["freed_bytes"],
        )

    @app.post(
        "/v1/trees/{tree_sha}/restore",
        response_model=TreeRestoreResponse,
        responses={
            400: {"model": ErrorResponse}, 403: {"model": ErrorResponse}, 404: {"model": ErrorResponse},
            409: {"model": ErrorResponse}, 503: {"model": ErrorResponse},
        },
    )
    async def restore_tree(tree_sha: str, request: TreeRestoreRequest, raw_request: Request) -> TreeRestoreResponse:
        if not re.fullmatch(r"[0-9a-f]{64}", tree_sha):
            raise ServiceError("invalid_tree_sha", "tree_sha must be a lowercase hex sha256", status_code=400)
        cache = material_cache(raw_request)
        target = safe_workspace_dir(request.path, configured.resolved_workspace_roots())
        try:
            restored = await asyncio.to_thread(cache.restore_tree_sha, tree_sha, target)
        except LookupError as error:
            raise ServiceError(
                "unknown_tree", f"tree {tree_sha} is not in the material cache", status_code=404
            ) from error
        if not restored:
            raise ServiceError("target_not_empty", "restore target must be an empty directory", status_code=409)
        return TreeRestoreResponse(tree_sha=tree_sha, materialize_mode=cache.last_materialize_mode or "copy")

    return app


def request_id(request: Request) -> str:
    return getattr(request.state, "request_id", str(uuid.uuid4()))


def failure_class(error: ServiceError) -> str:
    if error.code in {"provider_timeout"}:
        return "timeout"
    if error.code in {"provider_rate_limit"}:
        return "rate_limit"
    if error.code in {"provider_error", "provider_network_error", "document_download_failed"}:
        return "provider"
    if error.status_code in {400, 404, 409, 413, 422} or error.code.startswith(("invalid_", "path_", "symlink_")):
        return "validation"
    return "permanent"
