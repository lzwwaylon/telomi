from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from types import SimpleNamespace
from urllib.parse import quote

import httpx
import pytest
from conftest import client_for

from research_source_service.documents import DocumentService
from research_source_service.errors import ServiceError
from research_source_service.sources.openalex_budget import OpenAlexBudget


def work(identifier="W123"):
    return {"id": "https://openalex.org/" + identifier, "display_name": "Speech synthesis",
            "publication_date": "2026-02-01", "updated_date": "2026-09-01",
            "abstract_inverted_index": {"Speech": [0], "generation": [1]},
            "authorships": [{"author": {"display_name": "Author"}, "institutions": []}],
            "topics": [{"id": "https://openalex.org/T123", "display_name": "Speech"}],
            "has_content": {"pdf": True}}


def post(client, authorization, operation, parameters, workspace=None):
    return client.post("/v1/search", headers=authorization, json={
        "source_id": "openalex", "query": "speech evidence", "max_results": 50,
        "provider_request": {"operation": operation, "parameters": parameters},
        **({"workspace_dir": str(workspace)} if workspace else {}),
    })


def test_native_topic_and_date_cursor_discovery(tmp_path, authorization):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.headers["authorization"] == "Bearer test-key"
        assert "api_key" not in request.url.params
        if request.url.path == "/topics":
            return httpx.Response(200, json={"results": [{"id": "https://openalex.org/T123",
                "display_name": "Speech", "description": "Speech generation", "keywords": ["speech"]}],
                "meta": {"count": 1, "next_cursor": None}})
        assert request.url.params["filter"] == (
            "topics.id:T123|T456,from_publication_date:2026-01-01,to_publication_date:2026-09-25"
        )
        return httpx.Response(200, json={"results": [work()], "meta": {"count": 2, "next_cursor": "next"}})

    with client_for(tmp_path, handler, openalex_api_key="test-key") as client:
        labels = post(client, authorization, "topics", {"search": "speech"})
        papers = post(client, authorization, "query", {"topic_ids": ["T123", "https://openalex.org/T456"],
                      "start_date": "2026-01-01", "end_date": "2026-09-25"})
    assert labels.status_code == papers.status_code == 200
    row = papers.json()["results"][0]
    assert row["snippet"] == "Speech generation"
    assert row["metadata"]["openalex_page"]["next_cursor"] == "next"
    assert row["metadata"]["openalex_id"] == "W123"
    assert row["metadata"]["native_query"]["parameters"]["cursor"] == "*"
    assert len(calls) == 2


def test_empty_search_is_success_not_failure(tmp_path, authorization):
    with client_for(tmp_path, lambda request: httpx.Response(200, json={
        "results": [], "meta": {"count": 0, "next_cursor": None},
    })) as client:
        response = post(client, authorization, "query", {"topic_ids": ["T123"]})
    assert response.status_code == 200
    assert response.json()["results"] == []


@pytest.mark.parametrize("status", [200, 401])
def test_supplied_key_probe_checks_account_endpoint(tmp_path, authorization, status):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.path == "/rate-limit"
        assert request.headers["authorization"] == "Bearer candidate-key"
        return httpx.Response(status, json={"remaining": 1000} if status == 200 else {"message": "Invalid key"})

    with client_for(tmp_path, handler) as client:
        response = client.post("/v1/credentials/verify", headers=authorization, json={
            "source_id": "openalex", "credential": {"SOURCE_SERVICE_OPENALEX_API_KEY": "candidate-key"},
        })
    assert len(calls) == 1
    assert response.status_code == (200 if status == 200 else 502)
    if status == 401:
        assert response.json()["error"]["code"] == "provider_credentials"
        assert response.json()["error"]["details"]["operation"] == "credential_check"


@pytest.mark.parametrize(("status", "headers", "body", "code", "retryable"), [
    (404, {}, {"message": "Work not found"}, "openalex_entity_not_found", False),
    (401, {}, {"message": "Invalid key"}, "provider_credentials", False),
    (400, {}, {"message": "Unknown filter"}, "provider_rejected_request", False),
    (429, {"retry-after": "7"}, {"message": "Rate limit exceeded"}, "provider_rate_limit", True),
    (429, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "300"},
     {"message": "Daily budget exceeded"}, "provider_daily_budget_exhausted", False),
    (429, {"x-ratelimit-remaining": "1", "x-ratelimit-credits-required": "10"},
     {"message": "Insufficient credits"}, "provider_daily_budget_exhausted", False),
])
def test_precise_upstream_errors(tmp_path, authorization, status, headers, body, code, retryable):
    with client_for(tmp_path, lambda request: httpx.Response(status, headers=headers, json=body)) as client:
        response = post(client, authorization, "work_info", {"identifier": "W123"})
    error = response.json()["error"]
    assert error["code"] == code
    assert error["retryable"] is retryable
    assert error["provider"] == "openalex"
    assert error["details"]["operation"] == "work_info"
    assert error["details"]["upstream_status"] == status
    if code == "provider_rate_limit":
        assert error["retry_after_ms"] == 7000


@pytest.mark.parametrize("payload", [{"results": [], "meta": {}}, {"results": [False], "meta": {"count": 1}},
    {"results": [{**work(), "abstract_inverted_index": {"bad": [True]}}], "meta": {"count": 1}}])
def test_malformed_response_not_silently_empty(tmp_path, authorization, payload):
    with client_for(tmp_path, lambda request: httpx.Response(200, json=payload)) as client:
        response = post(client, authorization, "query", {"topic_ids": ["T123"]})
    assert response.json()["error"]["code"] == "invalid_provider_response"


@pytest.mark.parametrize("parameters", [{"topic_ids": ["speech"]}, {"search": "speech", "per_page": True},
    {"topic_ids": ["T123"], "start_date": "2026-09-25", "end_date": "2026-01-01"},
    {"filter": "from_updated_date:2026-01-01"}, {"topic_ids": ["T123"], "api_key": "secret"}])
def test_invalid_or_paid_parameters_never_reach_upstream(tmp_path, authorization, parameters):
    def handler(request):
        raise AssertionError("invalid parameters must not reach upstream")
    with client_for(tmp_path, handler) as client:
        response = post(client, authorization, "query", parameters)
    assert response.json()["error"]["code"] == "invalid_provider_request"


def test_exact_doi_and_bounded_native_merged_redirect(tmp_path, authorization):
    calls = []
    def handler(request):
        calls.append(str(request.url))
        if len(calls) == 1:
            return httpx.Response(301, headers={"location": "https://api.openalex.org/works/W123"})
        return httpx.Response(200, json=work())
    with client_for(tmp_path, handler) as client:
        response = post(client, authorization, "work_info", {"identifier": "10.1234/example"})
    assert response.status_code == 200
    assert "/works/https://doi.org/10.1234/example" in calls[0]
    assert response.json()["results"][0]["metadata"]["openalex_id"] == "W123"


def test_untrusted_redirect_does_not_receive_credentials(tmp_path, authorization):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(301, headers={"location": "https://publisher.example/works/W123"})
    with client_for(tmp_path, handler, openalex_api_key="test-key") as client:
        response = post(client, authorization, "work_info", {"identifier": "W123"})
    assert response.json()["error"]["code"] == "invalid_provider_response"
    assert len(calls) == 1


def test_missing_fulltext_is_precise_task_gap(tmp_path, authorization):
    def handler(request):
        return httpx.Response(200, json={**work(), "has_content": {"pdf": False}})
    with client_for(tmp_path, handler) as client:
        response = post(client, authorization, "download_pdf", {"identifier": "W123"}, tmp_path)
    error = response.json()["error"]
    assert error["code"] == "openalex_fulltext_missing"
    assert error["details"]["failure_scope"] == "request"


def test_fulltext_key_required_does_not_block_metadata(tmp_path, authorization):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=work())
    with client_for(tmp_path, handler) as client:
        response = post(client, authorization, "download_pdf", {"identifier": "W123"}, tmp_path)
        metadata = post(client, authorization, "work_info", {"identifier": "W123"})
    assert response.json()["error"]["code"] == "openalex_fulltext_key_required"
    assert metadata.status_code == 200
    assert all(request.url.host == "api.openalex.org" for request in calls)


def test_cached_pdf_retains_actual_document_and_provenance(tmp_path, authorization, monkeypatch):
    requests = []
    async def parse(self, request):
        assert (tmp_path / request.input_path).read_bytes().startswith(b"%PDF-")
        parsed = SimpleNamespace(manifest=SimpleNamespace(model_dump=lambda **kwargs: {"parser": "fixture"}))
        return parsed, "# Paper\nFull text."
    monkeypatch.setattr(DocumentService, "parse_with_markdown", parse)
    def handler(request):
        requests.append(request)
        if request.url.host == "content.openalex.org":
            assert request.headers["authorization"] == "Bearer test-key"
            return httpx.Response(200, content=b"%PDF-fixture")
        return httpx.Response(200, json=work())
    with client_for(tmp_path, handler, openalex_api_key="test-key", material_cache_root=tmp_path / "cache") as client:
        first = post(client, authorization, "download_pdf", {"identifier": "W123"}, tmp_path)
        second = post(client, authorization, "download_pdf", {"identifier": "W123"}, tmp_path)
    assert first.status_code == second.status_code == 200
    metadata = second.json()["results"][0]["metadata"]
    assert metadata["material_cache_hit"] is True
    assert (tmp_path / metadata["markdown_path"]).read_text() == "# Paper\nFull text."
    assert metadata["document_url"] == "https://content.openalex.org/works/W123.pdf"
    assert sum(request.url.host == "content.openalex.org" for request in requests) == 1


def test_daily_exhaustion_blocks_next_request_before_dispatch(tmp_path, authorization):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(429, json={"message": "Daily credit budget exceeded"})
    with client_for(tmp_path, handler) as client:
        first = post(client, authorization, "query", {"topic_ids": ["T123"]})
        second = post(client, authorization, "query", {"search": "different query"})
    assert first.json()["error"]["code"] == second.json()["error"]["code"] == "provider_daily_budget_exhausted"
    assert len(calls) == 1


def test_content_redirect_uses_no_api_key_and_bills_once(tmp_path, authorization, monkeypatch):
    calls = []
    async def parse(self, request):
        parsed = SimpleNamespace(manifest=SimpleNamespace(model_dump=lambda **kwargs: {"parser": "fixture"}))
        return parsed, "# Paper\nFull text."
    monkeypatch.setattr(DocumentService, "parse_with_markdown", parse)
    def handler(request):
        calls.append(request)
        if request.url.host == "api.openalex.org":
            return httpx.Response(200, json=work())
        if request.url.host == "content.openalex.org":
            assert request.headers["authorization"] == "Bearer test-key"
            return httpx.Response(302, headers={
                "location": "https://fixture.r2.cloudflarestorage.com/paper.pdf?signature=temporary",
                "x-ratelimit-remaining": "100", "x-ratelimit-credits-used": "100",
            })
        assert request.url.host == "fixture.r2.cloudflarestorage.com"
        assert "authorization" not in request.headers
        return httpx.Response(200, content=b"%PDF-fixture")
    with client_for(tmp_path, handler, openalex_api_key="test-key") as client:
        response = post(client, authorization, "download_pdf", {"identifier": "W123"}, tmp_path)
    assert response.status_code == 200
    assert len(calls) == 3
    assert "signature" not in json.dumps(response.json())
    with sqlite3.connect(tmp_path / "openalex-budget.sqlite3") as connection:
        assert connection.execute("SELECT spent FROM daily_budget").fetchone()[0] == 100


def test_storage_failure_does_not_retain_signed_url_echoes(tmp_path, authorization):
    signed_url = "https://fixture.r2.cloudflarestorage.com/paper.pdf?signature=temporary-content-token"

    def handler(request):
        if request.url.host == "api.openalex.org":
            return httpx.Response(200, json=work())
        if request.url.host == "content.openalex.org":
            return httpx.Response(302, headers={"location": signed_url})
        assert request.url.host == "fixture.r2.cloudflarestorage.com"
        assert "authorization" not in request.headers
        return httpx.Response(500, headers={"location": signed_url, "retry-after": "7"},
                              text=f"Storage failure at {signed_url} and {quote(signed_url, safe='')}")

    with client_for(tmp_path, handler, openalex_api_key="test-key") as client:
        response = post(client, authorization, "download_pdf", {"identifier": "W123"}, tmp_path)
    assert response.status_code == 502
    assert "temporary-content-token" not in response.text
    error = response.json()["error"]
    assert error["code"] == "provider_error"
    assert error["retryable"] is True
    assert error["details"]["upstream_status"] == 500
    assert error["details"]["operation"] == "download_pdf"
    assert error["details"]["failure_scope"] == "request"
    assert error["details"]["upstream_headers"]["retry-after"] == "7"
    assert "upstream_body" not in error["details"]
    assert "location" not in error["details"]["upstream_headers"]


def test_free_budget_concurrent_reservations_and_credential_isolation(tmp_path):
    database = tmp_path / "budget.sqlite3"
    first, second = OpenAlexBudget(database, None), OpenAlexBudget(database, None)
    first.reserve(900, "query")
    def reserve(store):
        try:
            store.reserve(100, "download_pdf")
            return True
        except ServiceError as error:
            assert error.code == "provider_daily_budget_exhausted"
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, [first, second]))
    assert sorted(results) == [False, True]
    OpenAlexBudget(database, "different-key").reserve(100, "download_pdf")
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT spent FROM daily_budget WHERE scope=? AND day=?",
            (first.scope, datetime.now(UTC).date().isoformat())).fetchone()[0] == 1000
