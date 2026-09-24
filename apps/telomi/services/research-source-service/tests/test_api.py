from __future__ import annotations

from importlib.metadata import version

import httpx
from conftest import TOKEN, client_for, make_settings
from fastapi.testclient import TestClient

from research_source_service.app import create_app
from research_source_service.config import Settings


def unused_provider(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"Unexpected provider request: {request.method} {request.url}")


def test_settings_parse_path_separated_workspace_roots(tmp_path, monkeypatch) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    monkeypatch.setenv("SOURCE_SERVICE_API_TOKEN", TOKEN)
    monkeypatch.setenv("SOURCE_SERVICE_WORKSPACE_ROOTS", f"{first}:{second}")
    monkeypatch.delenv("SOURCE_SERVICE_PORT", raising=False)

    settings = Settings()

    assert settings.workspace_roots == (first, second)
    assert settings.port == 8791


def test_all_endpoints_require_authentication(tmp_path) -> None:
    with client_for(tmp_path, unused_provider) as client:
        response = client.get("/v1/health")

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.json()["error"]["code"] == "unauthorized"


def test_health(tmp_path, authorization) -> None:
    with client_for(tmp_path, unused_provider) as client:
        health = client.get("/v1/health", headers=authorization)

    assert health.json() == {
        "status": "ok",
        "service": "research-source-service",
        "version": version("telomi-research-source-service"),
    }


def test_sources_lists_every_registered_source_id(tmp_path, authorization) -> None:
    with client_for(tmp_path, unused_provider) as client:
        response = client.get("/v1/sources", headers=authorization)

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": 1,
        "sources": [
            "arxiv",
            "general_web_exa",
            "general_web_firecrawl",
            "general_web_tavily",
            "github",
            "huggingface",
            "twitter",
            "user_documents",
        ],
    }


def test_validate_citation_urls_accepts_markdown_and_returns_unavailable_urls(tmp_path, authorization) -> None:
    class StubValidator:
        async def validate(self, markdown: str) -> list[str]:
            assert markdown == "Alive https://example.com. Dead https://example.com/missing."
            return ["https://example.com/missing"]

    app = create_app(
        make_settings(tmp_path),
        httpx.AsyncClient(transport=httpx.MockTransport(unused_provider)),
        url_validator=StubValidator(),
    )
    with TestClient(app) as client:
        response = client.post(
            "/v1/citations/validate-urls",
            headers=authorization,
            json={
                "schema_version": 1,
                "markdown": "Alive https://example.com. Dead https://example.com/missing.",
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": 1,
        "unavailable_urls": ["https://example.com/missing"],
    }


def test_extra_request_fields_are_rejected(tmp_path, authorization) -> None:
    with client_for(tmp_path, unused_provider) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={"schema_version": 1, "source_id": "github", "query": "agents", "unexpected": True},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "request_validation_failed"
    assert any(
        violation["location"][-1] == "unexpected" for violation in response.json()["error"]["details"]["violations"]
    )


def test_max_results_is_bounded_by_runtime_configuration(tmp_path, authorization) -> None:
    app = create_app(
        make_settings(tmp_path, max_search_results=5), httpx.AsyncClient(transport=httpx.MockTransport(unused_provider))
    )
    with TestClient(app) as client:
        response = client.post(
            "/v1/search",
            headers={"Authorization": f"Bearer {TOKEN}"},
            json={"schema_version": 1, "source_id": "github", "query": "agents", "max_results": 6},
        )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "max_results_exceeded"
    assert response.json()["error"]["details"] == {
        "provided": 6,
        "maximum": 5,
        "parameter": "max_results",
    }


def test_unknown_source_id_is_refused_by_the_registry(tmp_path, authorization) -> None:
    with client_for(tmp_path, unused_provider) as client:
        response = client.post(
            "/v1/search",
            headers=authorization,
            json={"schema_version": 1, "source_id": "slack", "query": "agents", "max_results": 1},
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "source_not_registered"


def test_every_source_module_registers_through_its_specs() -> None:
    from research_source_service.sources.catalog import discover_specs

    specs = discover_specs()
    assert [spec.id for spec in specs] == sorted(spec.id for spec in specs)
    assert {spec.id for spec in specs if spec.credentialed} == {
        "github", "huggingface", "twitter", "general_web_firecrawl", "general_web_tavily", "general_web_exa",
    }
