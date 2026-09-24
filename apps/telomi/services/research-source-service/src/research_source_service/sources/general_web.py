from __future__ import annotations

from ..errors import ServiceError, bounded_message
from ..http_client import HttpGateway
from ..models import SearchRequest, SearchResult
from .base import SourceDeps, SourceSpec, secret, stable_search_id


class GeneralWebSource:
    def __init__(
        self,
        http: HttpGateway,
        *,
        backend: str,
        firecrawl_endpoint: str,
        firecrawl_key: str | None,
        tavily_endpoint: str,
        tavily_key: str | None,
        exa_endpoint: str,
        exa_key: str | None,
    ) -> None:
        self.http = http
        self.backend = backend
        self.firecrawl_endpoint = firecrawl_endpoint
        self.firecrawl_key = firecrawl_key
        self.tavily_endpoint = tavily_endpoint
        self.tavily_key = tavily_key
        self.exa_endpoint = exa_endpoint
        self.exa_key = exa_key

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        backends = {
            "firecrawl": self._firecrawl,
            "tavily": self._tavily,
            "exa": self._exa,
        }
        results = await backends[self.backend](request)
        for result in results:
            result.metadata["general_web_backend"] = self.backend
        return results

    async def _firecrawl(self, request: SearchRequest) -> list[SearchResult]:
        if not self.firecrawl_key:
            raise missing_credentials("firecrawl", "SOURCE_SERVICE_FIRECRAWL_API_KEY")
        payload = await self.http.request_json(
            "firecrawl",
            "POST",
            self.firecrawl_endpoint,
            headers={"Authorization": f"Bearer {self.firecrawl_key}"},
            body={
                "query": request.query.strip()[:500],
                "limit": min(request.max_results, 100),
                "sources": ["web", "images"],
            },
        )
        if payload.get("success") is False:
            raise ServiceError(
                "provider_error",
                f"Firecrawl search failed: {bounded_message(payload.get('error', 'unknown error'))}",
                retryable=True,
                provider="firecrawl",
            )
        data = payload.get("data")
        if isinstance(data, list):
            rows = data
            image_rows: list[object] = []
        elif isinstance(data, dict):
            rows = data.get("web") if isinstance(data.get("web"), list) else []
            image_rows = data.get("images") if isinstance(data.get("images"), list) else []
        else:
            rows, image_rows = [], []
        images_by_source: dict[str, list[str]] = {}
        for item in image_rows:
            if not isinstance(item, dict):
                continue
            source_url, image_url = http_url(item.get("url")), http_url(item.get("imageUrl"))
            if source_url and image_url:
                images_by_source.setdefault(source_url, []).append(image_url)
        results: list[SearchResult] = []
        for row in rows[: request.max_results]:
            if not isinstance(row, dict):
                continue
            url = http_url(row.get("url"))
            if not url:
                continue
            metadata_row = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            images = unique_urls(
                [
                    row.get("imageUrl"),
                    row.get("screenshot"),
                    metadata_row.get("ogImage"),
                    metadata_row.get("og_image"),
                    *images_by_source.get(url, []),
                ]
            )
            description = row.get("description") if isinstance(row.get("description"), str) else ""
            markdown = row.get("markdown") if isinstance(row.get("markdown"), str) else ""
            metadata: dict[str, object] = {
                "provider_implementation": "firecrawl_search_api_v2",
                "reliability_tier": "web_discovery",
            }
            if isinstance(row.get("position"), int | float):
                metadata["search_position"] = row["position"]
            if isinstance(payload.get("id"), str):
                metadata["firecrawl_search_id"] = payload["id"]
            if images:
                metadata["images"] = images
            results.append(
                SearchResult(
                    id=stable_search_id("general_web_firecrawl", url),
                    title=row.get("title") if isinstance(row.get("title"), str) and row["title"].strip() else url,
                    url=url,
                    snippet=(description or markdown)[:4_000],
                    metadata=metadata,
                )
            )
        return results

    async def _tavily(self, request: SearchRequest) -> list[SearchResult]:
        if not self.tavily_key:
            raise missing_credentials("tavily", "SOURCE_SERVICE_TAVILY_API_KEY")
        payload = await self.http.request_json(
            "tavily",
            "POST",
            self.tavily_endpoint,
            headers={"Authorization": f"Bearer {self.tavily_key}"},
            body={
                "query": request.query.strip()[:400],
                "search_depth": "basic",
                "topic": "general",
                "max_results": min(request.max_results, 20),
                "include_answer": False,
                "include_raw_content": False,
                "include_images": True,
                "include_image_descriptions": True,
            },
        )
        rows = payload.get("results")
        if not isinstance(rows, list):
            return []
        results: list[SearchResult] = []
        for row in rows[: request.max_results]:
            if not isinstance(row, dict) or not (url := http_url(row.get("url"))):
                continue
            content = row.get("content") if isinstance(row.get("content"), str) else ""
            raw_content = row.get("raw_content") if isinstance(row.get("raw_content"), str) else ""
            metadata: dict[str, object] = {
                "provider_implementation": "tavily_search_api_v1",
                "reliability_tier": "web_discovery",
                "general_web_temporal_policy": "query_text_only",
            }
            for source, target in (
                ("score", "tavily_score"),
                ("request_id", "tavily_request_id"),
                ("response_time", "tavily_response_time"),
            ):
                value = row.get(source) if source == "score" else payload.get(source)
                if value is not None:
                    metadata[target] = value
            images = unique_urls(row.get("images") if isinstance(row.get("images"), list) else [])
            if images:
                metadata["images"] = images
            results.append(
                SearchResult(
                    id=stable_search_id("general_web_tavily", url),
                    title=row.get("title") if isinstance(row.get("title"), str) and row["title"].strip() else url,
                    url=url,
                    snippet=(content or raw_content)[:4_000],
                    published_at=row.get("published_date") if isinstance(row.get("published_date"), str) else None,
                    metadata=metadata,
                )
            )
        return results

    async def _exa(self, request: SearchRequest) -> list[SearchResult]:
        if not self.exa_key:
            raise missing_credentials("exa", "SOURCE_SERVICE_EXA_API_KEY")
        payload = await self.http.request_json(
            "exa",
            "POST",
            self.exa_endpoint,
            headers={"x-api-key": self.exa_key},
            body={
                "query": request.query.strip(),
                "type": "auto",
                "numResults": min(request.max_results, 100),
                "contents": {"highlights": {"numSentences": 2, "highlightsPerUrl": 2}},
            },
        )
        rows = payload.get("results")
        if not isinstance(rows, list):
            return []
        results: list[SearchResult] = []
        for row in rows[: request.max_results]:
            if not isinstance(row, dict) or not (url := http_url(row.get("url"))):
                continue
            highlights = [item for item in row.get("highlights", []) if isinstance(item, str) and item.strip()]
            fallback = row.get("summary") if isinstance(row.get("summary"), str) else row.get("text")
            author = row.get("author") if isinstance(row.get("author"), str) and row["author"].strip() else None
            metadata: dict[str, object] = {
                "provider_implementation": "exa_search_api_v1",
                "reliability_tier": "web_discovery",
                "general_web_temporal_policy": "query_text_only",
            }
            for source, target in (
                ("id", "exa_document_id"),
                ("score", "exa_score"),
            ):
                if row.get(source) is not None:
                    metadata[target] = row[source]
            for source, target in (
                ("requestId", "exa_request_id"),
                ("searchTime", "exa_search_time_ms"),
            ):
                if payload.get(source) is not None:
                    metadata[target] = payload[source]
            image = http_url(row.get("image"))
            if image:
                metadata["images"] = [image]
            results.append(
                SearchResult(
                    id=stable_search_id("general_web_exa", url),
                    title=row.get("title") if isinstance(row.get("title"), str) and row["title"].strip() else url,
                    url=url,
                    snippet=("\n\n".join(highlights) or (fallback if isinstance(fallback, str) else ""))[:4_000],
                    published_at=row.get("publishedDate") if isinstance(row.get("publishedDate"), str) else None,
                    authors=[author] if author else None,
                    metadata=metadata,
                )
            )
        return results


def missing_credentials(provider: str, variable: str) -> ServiceError:
    return ServiceError(
        "provider_credentials",
        f"{provider} API key is required; set {variable}",
        provider=provider,
    )


def http_url(value: object) -> str | None:
    return (
        value.strip() if isinstance(value, str) and value.strip().lower().startswith(("http://", "https://")) else None
    )


def unique_urls(values: list[object]) -> list[str]:
    return list(dict.fromkeys(url for value in values if (url := http_url(value))))


def _build(backend: str):
    def build(deps: SourceDeps) -> GeneralWebSource:
        settings = deps.settings
        return GeneralWebSource(
            deps.http,
            backend=backend,
            firecrawl_endpoint=settings.firecrawl_endpoint,
            firecrawl_key=secret(settings.firecrawl_api_key),
            tavily_endpoint=settings.tavily_endpoint,
            tavily_key=secret(settings.tavily_api_key),
            exa_endpoint=settings.exa_endpoint,
            exa_key=secret(settings.exa_api_key),
        )

    return build


SPECS = tuple(
    SourceSpec(
        id=f"general_web_{backend}",
        credentialed=True,
        build=_build(backend),
        max_concurrency=lambda settings: settings.general_web_max_concurrency,
    )
    for backend in ("firecrawl", "tavily", "exa")
)
