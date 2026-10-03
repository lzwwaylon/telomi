from __future__ import annotations

import asyncio
import hashlib
import os
import re
import sqlite3
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from conftest import client_for, make_settings
from test_arxiv_runtime import ATOM_PAGE, arxiv_payload

from research_source_service.app import create_app
from research_source_service.arxiv_runtime import ArxivRuntimeStore
from research_source_service.documents import DocumentService
from research_source_service.sources.arxiv import parse_feed

PDF = b"%PDF-1.4\nknown PDF fixture\n%%EOF\n"


def atom_versions(versions: list[str], *, total: int | None = None) -> str:
    entry = re.search(r"<entry>.*?</entry>", ATOM_PAGE, re.DOTALL).group(0)
    feed = ATOM_PAGE.replace(entry, "\n".join(entry.replace("2607.09999v1", f"2607.09999{version}")
                                             for version in versions))
    return (feed.replace("totalResults>1<", f"totalResults>{total or len(versions)}<")
            .replace("itemsPerPage>1<", f"itemsPerPage>{len(versions)}<"))


def download_payload(workspace: Path, arxiv_id: str) -> dict[str, object]:
    workspace.mkdir(exist_ok=True)
    return {"schema_version": 1, "source_id": "arxiv", "query": "known paper", "max_results": 1,
            "workspace_dir": str(workspace),
            "provider_request": {"operation": "download_pdf", "parameters": {"arxiv_id": arxiv_id}}}


@pytest.fixture
def fixture_converter(monkeypatch: pytest.MonkeyPatch) -> None:
    async def parse(self: DocumentService, request: object):
        assert (Path(request.input_root) / request.input_path).read_bytes() == PDF
        return SimpleNamespace(manifest=SimpleNamespace(model_dump=lambda mode: {"parser": "fixture"})), "PDF body"
    monkeypatch.setattr(DocumentService, "parse_with_markdown", parse)


@pytest.mark.asyncio
async def test_waiting_api_retry_does_not_block_known_pdf(
    tmp_path: Path, authorization: dict[str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, float]] = []
    waiting = asyncio.Event()
    original_sleep = asyncio.sleep
    pdf = b"%PDF-1.4\nknown PDF fixture\n%%EOF\n"

    async def sleep(delay: float) -> None:
        if delay > 0.3:
            waiting.set()
        await original_sleep(delay)

    monkeypatch.setattr(asyncio, "sleep", sleep)

    async def parse_with_markdown(self: DocumentService, request: object):
        assert (Path(request.input_root) / request.input_path).read_bytes() == pdf
        return SimpleNamespace(manifest=SimpleNamespace(model_dump=lambda mode: {"parser": "fixture"})), "PDF body"

    monkeypatch.setattr(DocumentService, "parse_with_markdown", parse_with_markdown)

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append((str(request.url), time.monotonic()))
        if request.url.host == "export.arxiv.org":
            return httpx.Response(429, headers={"retry-after": "0.8"}, text="API capacity unavailable")
        assert str(request.url) == "https://arxiv.org/pdf/2607.09999v1"
        return httpx.Response(200, content=pdf)

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app = create_app(make_settings(tmp_path, arxiv_global_min_start_interval_seconds=0.03), upstream_client)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://source") as client:
                failed = await client.post("/v1/search", headers=authorization, json=arxiv_payload("failed"))
                assert failed.status_code == 502
                retry = asyncio.create_task(client.post("/v1/search", headers=authorization,
                                                         json=arxiv_payload("queued-retry")))
                try:
                    await asyncio.wait_for(waiting.wait(), 1)
                    response = await asyncio.wait_for(client.post("/v1/search", headers=authorization, json={
                        "schema_version": 1, "source_id": "arxiv", "query": "known paper", "max_results": 1,
                        "workspace_dir": str(tmp_path),
                        "provider_request": {"operation": "download_pdf", "parameters": {"arxiv_id": "2607.09999v1"}},
                    }), 0.35)
                    assert response.status_code == 200
                    result = response.json()["results"][0]
                    assert (tmp_path / result["metadata"]["pdf_path"]).read_bytes() == pdf
                    assert result["metadata"]["arxiv_metadata_incomplete"] is True
                    assert result["authors"] is None and result["published_at"] is None
                    assert failed.json()["error"]["details"]["arxiv_access_scope"] == "api"
                    assert len(calls) == 2, "known PDF acquisition does not call the cooled metadata API"
                    assert calls[1][1] - calls[0][1] >= 0.025, "global pacing still applies to the PDF"
                finally:
                    retry.cancel()
                    await asyncio.gather(retry, return_exceptions=True)


@pytest.mark.parametrize("seed_from_query_cache", [False, True])
def test_verified_metadata_from_discovery_or_cached_query_avoids_api_lookup(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None, seed_from_query_cache: bool,
) -> None:
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url.host == "export.arxiv.org":
            if "failed" in str(request.url):
                return httpx.Response(429, headers={"retry-after": "61"})
            return httpx.Response(200, text=ATOM_PAGE)
        assert str(request.url) == "https://arxiv.org/pdf/2607.09999v1"
        return httpx.Response(200, content=PDF)

    with client_for(tmp_path, upstream) as client:
        payload = arxiv_payload("discovery")
        assert client.post("/v1/search", headers=authorization, json=payload).status_code == 200
        if seed_from_query_cache:
            store = client.app.state.registry.sources["arxiv"].runtime_store
            store.connection.execute("DELETE FROM arxiv_paper_metadata")
            store.connection.commit()
            assert client.post("/v1/search", headers=authorization, json=payload).status_code == 200
        assert client.post("/v1/search", headers=authorization, json=arxiv_payload("failed")).status_code == 502
        response = client.post("/v1/search", headers=authorization,
                               json=download_payload(tmp_path / "paper", "2607.09999v1"))
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["title"] == "Cached Upstream Metadata"
    assert result["authors"] == ["Ada Example"]
    assert result["published_at"] == "2026-07-19T01:02:03Z"
    assert result["metadata"]["arxiv_metadata_incomplete"] is False
    assert len(calls) == 3, "download does not revisit the metadata API"


def test_pinned_historical_query_does_not_replace_verified_latest_alias(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None,
) -> None:
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url.host == "export.arxiv.org":
            version = "v1" if request.url.params["id_list"].endswith("v1") else "v2"
            return httpx.Response(200, text=ATOM_PAGE.replace("2607.09999v1", f"2607.09999{version}"))
        assert str(request.url) == "https://arxiv.org/pdf/2607.09999v2"
        return httpx.Response(200, content=PDF)

    with client_for(tmp_path, upstream) as client:
        for arxiv_id in ["2607.09999", "2607.09999v1"]:
            payload = arxiv_payload("identity")
            payload["provider_request"]["parameters"] = {"id_list": [arxiv_id]}
            assert client.post("/v1/search", headers=authorization, json=payload).status_code == 200
        response = client.post("/v1/search", headers=authorization,
                               json=download_payload(tmp_path / "paper", "2607.09999"))
    assert response.status_code == 200
    assert response.json()["results"][0]["metadata"]["arxiv_version_id"] == "2607.09999v2"
    assert len(calls) == 3


@pytest.mark.parametrize("arxiv_id", ["2607.09999", "2607.09999v1"])
def test_unknown_metadata_pdf_cache_is_mutable_until_version_is_pinned(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None,
    monkeypatch: pytest.MonkeyPatch, arxiv_id: str,
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        assert str(request.url) == f"https://arxiv.org/pdf/{arxiv_id}"
        return httpx.Response(200, content=PDF)

    cache = tmp_path / "materials"
    with client_for(tmp_path, upstream, material_cache_root=cache, material_cache_ttl_seconds=60) as client:
        responses = []
        for index in range(3):
            if index == 2:
                clock[0] += 61
            responses.append(client.post("/v1/search", headers=authorization,
                                         json=download_payload(tmp_path / f"paper-{index}", arxiv_id)))
    assert all(response.status_code == 200 for response in responses)
    exact = arxiv_id.endswith("v1")
    assert len(calls) == (1 if exact else 2), "unresolved latest is refreshed after TTL"
    result = responses[0].json()["results"][0]
    assert result["title"] == f"arXiv {arxiv_id}", "identity display is not a claimed paper title"
    assert result["authors"] is None and result["published_at"] is None
    assert result["metadata"]["arxiv_version_resolved"] is exact
    assert ("arxiv_version_id" in result["metadata"]) is exact
    with sqlite3.connect(cache / "catalog.sqlite") as db:
        assert db.execute("SELECT immutable FROM acquisitions").fetchone()[0] == exact


def test_expired_metadata_does_not_force_live_api_or_claim_a_latest_version(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url.host == "export.arxiv.org":
            return httpx.Response(200, text=ATOM_PAGE)
        assert str(request.url) == "https://arxiv.org/pdf/2607.09999"
        return httpx.Response(200, content=PDF)

    with client_for(tmp_path, upstream, arxiv_cache_ttl_seconds=60) as client:
        payload = arxiv_payload("latest")
        payload["provider_request"]["parameters"] = {"id_list": ["2607.09999"]}
        assert client.post("/v1/search", headers=authorization, json=payload).status_code == 200
        clock[0] += 61
        response = client.post("/v1/search", headers=authorization,
                               json=download_payload(tmp_path / "paper", "2607.09999"))
    assert response.status_code == 200
    assert response.json()["results"][0]["metadata"]["arxiv_version_resolved"] is False
    assert len(calls) == 2


@pytest.mark.parametrize("base_id", ["2607.09999", "solv-int/9901001"])
def test_legacy_equal_query_timestamps_keep_higher_numeric_alias_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, base_id: str,
) -> None:
    monkeypatch.setattr(time, "time", lambda: 1000.0)
    store = ArxivRuntimeStore(tmp_path / "cache.sqlite3", cache_ttl_seconds=60)
    endpoint = "https://export.arxiv.org/api/query"
    old_parameters = {"id_list": [base_id, f"{base_id}v9"]}
    new_parameters = {"id_list": [base_id]}
    old_xml = ATOM_PAGE.replace("2607.09999v1", f"{base_id}v9")
    new_xml = ATOM_PAGE.replace("2607.09999v1", f"{base_id}v10")
    try:
        store.put_cached_response(endpoint, old_parameters, old_xml)
        store.put_cached_response(endpoint, new_parameters, new_xml)
        old = {base_id: parse_feed(old_xml)[0][0].model_dump_json()}
        new = {base_id: parse_feed(new_xml)[0][0].model_dump_json()}
        store.cache_papers(old, endpoint, old_parameters)
        store.cache_papers(new, endpoint, new_parameters)
        store.cache_papers(old, endpoint, old_parameters)
        assert f'"arxiv_version_id":"{base_id}v10"' in store.get_cached_paper(base_id)
        row = store.connection.execute(
            "SELECT expires_at FROM arxiv_paper_metadata WHERE arxiv_id=?", (base_id,)
        ).fetchone()
        assert row["expires_at"] == 1060
    finally:
        store.close()


def test_http_route_health_and_cooldown_are_scoped_but_transport_failure_is_shared(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(time, "time", lambda: 1000.0)
    scheduler = tmp_path / "scheduler.sqlite3"
    first = ArxivRuntimeStore(tmp_path / "first.sqlite3", scheduler_database=scheduler)
    other = ArxivRuntimeStore(tmp_path / "other.sqlite3", scheduler_database=scheduler)
    names = ("direct", "backup")
    try:
        first.record_upstream_start("api", 4, 3)
        first.cooldown(61, scope="api")
        assert other.upstream_delay("api") == 61
        assert other.upstream_delay("main") == 3
        assert first.fail_egress_route("direct", names, 61, scope="api") == "backup"
        assert other.egress_route(names, scope="api") == "backup"
        assert other.egress_route(names, scope="main") == "direct"
        first.fail_egress_route("backup", names, 20, scope="any")
        assert other.egress_route(names, scope="main") == "direct"
        first.cooldown(90, scope="any")
        assert other.upstream_delay("main") == 90
        assert other.upstream_delay("api") == 90
    finally:
        first.close()
        other.close()


@pytest.mark.parametrize("arxiv_id", ["2607.09999", "hep-th/9901001"])
def test_discovery_snapshot_preserves_bibliography_without_claiming_latest_version(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None, arxiv_id: str,
) -> None:
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url.host == "export.arxiv.org":
            return httpx.Response(200, text=ATOM_PAGE.replace("2607.09999v1", f"{arxiv_id}v1"))
        assert str(request.url) == f"https://arxiv.org/pdf/{arxiv_id}"
        return httpx.Response(200, content=PDF)

    with client_for(tmp_path, upstream) as client:
        assert client.post("/v1/search", headers=authorization, json=arxiv_payload("discover")).status_code == 200
        response = client.post("/v1/search", headers=authorization,
                               json=download_payload(tmp_path / "paper", arxiv_id))
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["title"] == "Cached Upstream Metadata"
    assert result["authors"] == ["Ada Example"]
    assert result["published_at"] == "2026-07-19T01:02:03Z"
    assert result["url"] == f"https://arxiv.org/abs/{arxiv_id}"
    assert result["metadata"]["arxiv_metadata_status"] == "discovery_snapshot"
    assert result["metadata"]["arxiv_metadata_version_id"] == f"{arxiv_id}v1"
    assert result["metadata"]["arxiv_metadata_incomplete"] is True
    assert result["metadata"]["arxiv_version_resolved"] is False
    assert "arxiv_version_id" not in result["metadata"]
    assert len(calls) == 2


def test_bad_metadata_cache_cannot_redirect_or_prevent_known_pdf_download(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None,
) -> None:
    def upstream(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://arxiv.org/pdf/2607.09999v1"
        return httpx.Response(200, content=PDF)

    with client_for(tmp_path, upstream) as client:
        store = client.app.state.registry.sources["arxiv"].runtime_store
        for content in ["not JSON", '{"id":"bad","title":"Agent text","url":"https://attacker.invalid",'
                        '"snippet":"","metadata":{"arxiv_version_id":"2607.00001v1"}}']:
            store.connection.execute(
                "INSERT OR REPLACE INTO arxiv_paper_metadata VALUES (?, ?, ?, ?)",
                ("2607.09999v1", content, round(time.time()), round(time.time()) + 60),
            )
            store.connection.commit()
            response = client.post("/v1/search", headers=authorization,
                                   json=download_payload(tmp_path / "paper", "2607.09999v1"))
            assert response.status_code == 200
            result = response.json()["results"][0]
            assert result["title"] == "arXiv 2607.09999v1"
            assert result["metadata"]["arxiv_metadata_status"] == "identity_only"
            assert "attacker.invalid" not in response.text


def test_api_http_failure_does_not_send_pdf_to_unhealthy_alternate(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None, monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []
    original_client = httpx.AsyncClient

    def factory(**kwargs: object) -> httpx.AsyncClient:
        backup = bool(kwargs.get("proxy"))

        def upstream(request: httpx.Request) -> httpx.Response:
            calls.append(("backup" if backup else "direct", str(request.url)))
            assert not backup, "API HTTP overload must not mark the direct PDF route unhealthy"
            return (httpx.Response(429, headers={"retry-after": "61"}) if request.url.host == "export.arxiv.org"
                    else httpx.Response(200, content=PDF))

        return original_client(transport=httpx.MockTransport(upstream))

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    with client_for(tmp_path, None, arxiv_egress_proxies={"backup": "socks5h://127.0.0.1:1080"}) as client:
        failed = client.post("/v1/search", headers=authorization, json=arxiv_payload("failed"))
        assert failed.status_code == 502
        assert failed.json()["error"]["details"]["arxiv_egress_next_route"] == "backup"
        response = client.post("/v1/search", headers=authorization,
                               json=download_payload(tmp_path / "paper", "2607.09999v1"))
    assert response.status_code == 200
    assert response.json()["results"][0]["metadata"]["arxiv_egress_route"] == "direct"
    assert len(calls) == 2


def test_global_access_denial_keeps_both_scopes_cooled(
    tmp_path: Path, authorization: dict[str, str],
) -> None:
    with client_for(tmp_path, lambda request: httpx.Response(403), arxiv_overload_cooldown_seconds=60) as client:
        response = client.post("/v1/search", headers=authorization, json=arxiv_payload("denied"))
        assert response.status_code == 502
        assert response.json()["error"]["details"]["arxiv_access_scope"] == "any"
        assert response.json()["error"]["details"]["provider_global_unavailable"] is True
        store = client.app.state.registry.sources["arxiv"].runtime_store
        assert store.upstream_delay("api") > 59
        assert store.upstream_delay("main") > 59


@pytest.mark.parametrize("requested_id", ["2607.09999", "2607.09999v1"])
def test_pdf_response_version_keeps_unversioned_cache_mutable_and_rejects_pinned_mismatch(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None, requested_id: str,
) -> None:
    def upstream(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == f"https://arxiv.org/pdf/{requested_id}"
        return httpx.Response(200, content=PDF,
                              headers={"content-disposition": 'inline; filename="2607.09999v2.pdf"'})

    cache = tmp_path / "materials"
    with client_for(tmp_path, upstream, material_cache_root=cache) as client:
        response = client.post("/v1/search", headers=authorization,
                               json=download_payload(tmp_path / "paper", requested_id))
    if requested_id.endswith("v1"):
        assert response.status_code == 502
        assert response.json()["error"]["code"] == "invalid_provider_response"
        assert not list((tmp_path / "paper").rglob("paper.pdf"))
    else:
        assert response.status_code == 200
        metadata = response.json()["results"][0]["metadata"]
        assert metadata["arxiv_version_id"] == "2607.09999v2"
        assert metadata["arxiv_version_resolved"] is True
        with sqlite3.connect(cache / "catalog.sqlite") as db:
            assert db.execute("SELECT immutable FROM acquisitions").fetchone()[0] == 0


@pytest.mark.parametrize("cache_hit_with_old_blob_mtime", [False, True])
def test_mutable_pdf_and_markdown_stay_paired_when_local_or_blob_mtime_is_old(
    tmp_path: Path, authorization: dict[str, str], monkeypatch: pytest.MonkeyPatch,
    cache_hit_with_old_blob_mtime: bool,
) -> None:
    first_pdf = b"%PDF-1.4\nfirst body\n%%EOF\n"
    latest_pdf = b"%PDF-1.4\nlatest body\n%%EOF\n"
    calls = []
    conversions = []

    def upstream(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://arxiv.org/pdf/2607.09999"
        calls.append(str(request.url))
        return httpx.Response(200, content=first_pdf if len(calls) == 1 else latest_pdf)

    async def parse(self: DocumentService, request: object):
        content = (Path(request.input_root) / request.input_path).read_bytes()
        conversions.append(content)
        return (SimpleNamespace(manifest=SimpleNamespace(model_dump=lambda mode: {"parser": "fixture"})),
                f"Parsed bytes: {content.hex()}")

    monkeypatch.setattr(DocumentService, "parse_with_markdown", parse)
    cache = tmp_path / "materials"
    workspace = tmp_path / "paper-one"
    with client_for(tmp_path, upstream, material_cache_root=cache, material_cache_ttl_seconds=60) as client:
        first = client.post("/v1/search", headers=authorization, json=download_payload(workspace, "2607.09999"))
        assert first.status_code == 200
        first_path = workspace / first.json()["results"][0]["metadata"]["pdf_path"]
        digest = hashlib.sha256(first_pdf).hexdigest()
        target = (cache / "objects" / digest[:2] / digest) if cache_hit_with_old_blob_mtime else first_path
        os.utime(target, (time.time() - 120, time.time() - 120))
        second_workspace = tmp_path / "paper-two" if cache_hit_with_old_blob_mtime else workspace
        second = client.post("/v1/search", headers=authorization,
                             json=download_payload(second_workspace, "2607.09999"))
    assert second.status_code == 200
    metadata = second.json()["results"][0]["metadata"]
    content = (second_workspace / metadata["pdf_path"]).read_bytes()
    markdown = (second_workspace / metadata["markdown_path"]).read_text()
    assert markdown == f"Parsed bytes: {content.hex()}", "PDF refresh must never reuse a different PDF's Markdown"
    assert len(calls) == (1 if cache_hit_with_old_blob_mtime else 2)
    assert len(conversions) == len(calls)


@pytest.mark.parametrize("versions", [["v2", "v1"], ["v1", "v2"]])
def test_mixed_id_list_latest_alias_uses_highest_version_independent_of_feed_order(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None, versions: list[str],
) -> None:
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return (httpx.Response(200, text=atom_versions(versions)) if request.url.host == "export.arxiv.org"
                else httpx.Response(200, content=PDF))

    with client_for(tmp_path, upstream) as client:
        query = arxiv_payload("mixed")
        query["provider_request"]["parameters"] = {"id_list": ["2607.09999", "2607.09999v1"]}
        assert client.post("/v1/search", headers=authorization, json=query).status_code == 200
        response = client.post("/v1/search", headers=authorization,
                               json=download_payload(tmp_path / "paper", "2607.09999"))
    assert response.status_code == 200
    assert response.json()["results"][0]["metadata"]["arxiv_version_id"] == "2607.09999v2"
    assert calls[-1] == "https://arxiv.org/pdf/2607.09999v2"


@pytest.mark.parametrize("filtered", [False, True])
def test_filtered_or_incomplete_id_list_does_not_establish_verified_latest_alias(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None, filtered: bool,
) -> None:
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return (httpx.Response(200, text=atom_versions(["v1"], total=1 if filtered else 2))
                if request.url.host == "export.arxiv.org" else httpx.Response(200, content=PDF))

    with client_for(tmp_path, upstream) as client:
        query = arxiv_payload("ambiguous")
        query["provider_request"]["parameters"] = {
            "id_list": ["2607.09999", "2607.09999v1"], "max_results": 1,
            **({"search_query": "ti:historical"} if filtered else {}),
        }
        assert client.post("/v1/search", headers=authorization, json=query).status_code == 200
        response = client.post("/v1/search", headers=authorization,
                               json=download_payload(tmp_path / "paper", "2607.09999"))
    assert response.status_code == 200
    metadata = response.json()["results"][0]["metadata"]
    assert metadata["arxiv_metadata_status"] == "discovery_snapshot"
    assert metadata["arxiv_metadata_incomplete"] is True
    assert metadata["arxiv_metadata_version_id"] == "2607.09999v1"
    assert metadata["arxiv_version_resolved"] is False
    assert calls[-1] == "https://arxiv.org/pdf/2607.09999"


@pytest.mark.parametrize("query_gap", [0.05, 5.0])
def test_older_cached_query_cannot_replace_latest_alias_or_extend_its_expiry(
    tmp_path: Path, authorization: dict[str, str], fixture_converter: None, monkeypatch: pytest.MonkeyPatch,
    query_gap: float,
) -> None:
    clock = [1000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        version = "v1" if "," in request.url.params["id_list"] else "v2"
        return httpx.Response(200, text=atom_versions([version]))

    with client_for(tmp_path, upstream, arxiv_cache_ttl_seconds=60) as client:
        old = arxiv_payload("old-query")
        old["provider_request"]["parameters"] = {"id_list": ["2607.09999", "2607.09999v1"]}
        latest = arxiv_payload("latest-query")
        latest["provider_request"]["parameters"] = {"id_list": ["2607.09999"]}
        assert client.post("/v1/search", headers=authorization, json=old).status_code == 200
        clock[0] += query_gap
        assert client.post("/v1/search", headers=authorization, json=latest).status_code == 200
        clock[0] += 5
        assert client.post("/v1/search", headers=authorization, json=old).status_code == 200
        store = client.app.state.registry.sources["arxiv"].runtime_store
        row = store.connection.execute(
            "SELECT result_json, expires_at FROM arxiv_paper_metadata WHERE arxiv_id='2607.09999'"
        ).fetchone()
        assert '"arxiv_version_id":"2607.09999v2"' in row["result_json"]
        assert row["expires_at"] == 1060 + query_gap
    assert len(calls) == 2
