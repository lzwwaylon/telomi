from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import httpx
import pytest
from conftest import client_for, make_settings
from pydantic import ValidationError
from test_arxiv_runtime import ATOM_PAGE, arxiv_payload

from research_source_service.arxiv_runtime import ArxivRuntimeStore
from research_source_service.errors import ServiceError
from research_source_service.http_client import HttpGateway
from research_source_service.sources.arxiv import ArxivSource

PROXY = "socks5h://proxy-user:proxy-password@127.0.0.1:1080"


def test_service_429_waits_globally_and_next_instance_uses_alternate(
    tmp_path: Path, authorization: dict[str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [100.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    requests: list[tuple[str, float]] = []
    original_client = httpx.AsyncClient

    def client_factory(**kwargs: object) -> httpx.AsyncClient:
        if "transport" in kwargs:
            return original_client(**kwargs)
        route = "backup" if kwargs.get("proxy") else "direct"
        assert kwargs["trust_env"] is False

        def upstream(_request: httpx.Request) -> httpx.Response:
            requests.append((route, clock[0]))
            return (httpx.Response(429, text="Rate exceeded", headers={"retry-after": "2"})
                    if route == "direct" else httpx.Response(200, text=ATOM_PAGE))

        return original_client(transport=httpx.MockTransport(upstream))

    async def sleep(delay: float) -> None:
        clock[0] += delay

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(asyncio, "sleep", sleep)
    options = {"arxiv_egress_proxies": {"backup": PROXY}, "arxiv_global_min_start_interval_seconds": 3}
    with client_for(tmp_path, lambda _request: httpx.Response(500), **options) as client:
        failed = client.post("/v1/search", headers=authorization, json=arxiv_payload("routing"))
    assert failed.status_code == 502
    details = failed.json()["error"]["details"]
    assert details["arxiv_egress_route"] == "direct"
    assert details["arxiv_egress_next_route"] == "backup"
    assert requests == [("direct", 100.0)], "Python makes no hidden retry"

    with client_for(tmp_path / "other", lambda _request: httpx.Response(500),
                    arxiv_scheduler_sqlite_path=tmp_path / "arxiv-upstream.sqlite3", **options) as client:
        succeeded = client.post("/v1/search", headers=authorization, json=arxiv_payload("routing"))
    assert succeeded.status_code == 200
    assert requests == [("direct", 100.0), ("backup", 103.0)], "alternate retains the global interval and cooldown"
    assert succeeded.json()["results"][0]["metadata"]["arxiv_egress_route"] == "backup"
    evidence = failed.text + succeeded.text + (tmp_path / "arxiv-upstream.jsonl").read_text()
    assert "proxy-user" not in evidence and "proxy-password" not in evidence and PROXY not in evidence
    records = [json.loads(line) for line in (tmp_path / "other" / "arxiv-upstream.jsonl").read_text().splitlines()]
    assert records[-1]["egress_route"] == "backup"
    assert records[-1]["slot_wait_ms"] == 3000


@pytest.mark.asyncio
async def test_exhausted_routes_do_not_offer_another_retry(tmp_path: Path) -> None:
    calls: list[str] = []

    def handler(route: str):
        def upstream(_request: httpx.Request) -> httpx.Response:
            calls.append(route)
            return httpx.Response(429, headers={"retry-after": "0"})
        return upstream

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler("direct"))) as direct:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler("backup"))) as backup:
            source = ArxivSource(HttpGateway(direct), "https://export.arxiv.org/api/query",
                                 runtime_store=ArxivRuntimeStore(tmp_path / "cache.sqlite3"),
                                 global_min_start_interval_seconds=0,
                                 egress_routes={"backup": HttpGateway(backup)})
            try:
                for expected in ["backup", None]:
                    with pytest.raises(ServiceError) as raised:
                        await source._request_upstream("api", 0, "GET", source.endpoint)
                    assert raised.value.details.get("arxiv_egress_next_route") == expected
                assert calls == ["direct", "backup"]
            finally:
                source.close()


@pytest.mark.asyncio
async def test_cancelled_egress_request_releases_lock_without_failing_route(tmp_path: Path) -> None:
    waiting = asyncio.Event()
    store = ArxivRuntimeStore(tmp_path / "cache.sqlite3")
    store.cooldown(60)
    assert store.fail_egress_route("direct", ("direct", "backup"), 60) == "backup"

    async def upstream(_request: httpx.Request) -> httpx.Response:
        waiting.set()
        await asyncio.Event().wait()
        raise AssertionError("Cancelled upstream must not return")

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        source = ArxivSource(HttpGateway(client), "https://export.arxiv.org/api/query", runtime_store=store,
                             egress_routes={"backup": HttpGateway(client)})
        # Start on a healthy alternate after the already persisted global cooldown.
        store.scheduler_connection.execute("UPDATE arxiv_access_slots SET next_allowed_at=0")
        store.scheduler_connection.commit()
        task = asyncio.create_task(source._request_upstream("api", 0, "GET", source.endpoint))
        try:
            await asyncio.wait_for(waiting.wait(), 1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            lease = store.try_acquire_upstream_lock()
            assert lease is not None
            lease.release()
            assert store.egress_route(("direct", "backup")) == "backup", "cancellation is not a route failure"
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            source.close()


@pytest.mark.asyncio
async def test_proxy_transport_errors_hide_proxy_credentials(tmp_path: Path) -> None:
    def upstream(_request: httpx.Request) -> httpx.Response:
        raise httpx.ProxyError(f"Proxy failed at {PROXY}")

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        gateway = HttpGateway(client, private_transport=True)
        with pytest.raises(ServiceError) as raised:
            await gateway.request("arxiv", "GET", "https://export.arxiv.org/api/query")
        assert raised.value.retryable
        assert raised.value.message == "arxiv request failed: ProxyError"


def test_unconfigured_routing_keeps_direct_transport_and_one_attempt(
    tmp_path: Path, authorization: dict[str, str],
) -> None:
    calls = []

    def upstream(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(429, headers={"retry-after": "0"})

    with client_for(tmp_path, upstream) as client:
        response = client.post("/v1/search", headers=authorization, json=arxiv_payload("direct"))
    assert response.status_code == 502
    assert len(calls) == 1
    assert response.json()["error"]["details"]["arxiv_egress_route"] == "direct"
    assert "arxiv_egress_next_route" not in response.json()["error"]["details"]


@pytest.mark.parametrize("status", [429, 502])
def test_private_http_failure_evidence_hides_proxy_secrets(
    tmp_path: Path, authorization: dict[str, str], monkeypatch: pytest.MonkeyPatch, status: int,
) -> None:
    original_client = httpx.AsyncClient

    def upstream(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text=f"Proxy failed at {PROXY}",
                              headers={"location": PROXY, "server": "proxy-password", "retry-after": "2"})

    def factory(**_kwargs: object) -> httpx.AsyncClient:
        return original_client(transport=httpx.MockTransport(upstream))

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    with client_for(tmp_path, upstream, arxiv_egress_proxies={"backup": PROXY}) as client:
        response = client.post("/v1/search", headers=authorization, json=arxiv_payload("private-errors"))
    assert response.status_code == 502
    details = response.json()["error"]["details"]
    assert details["upstream_status"] == status
    assert details["upstream_headers"] == {"retry-after": "2"}
    if status == 429:
        assert response.json()["error"]["retry_after_ms"] == 2000
    evidence = response.text + (tmp_path / "arxiv-upstream.jsonl").read_text()
    assert "proxy-user" not in evidence and "proxy-password" not in evidence and PROXY not in evidence


@pytest.mark.asyncio
async def test_access_denied_does_not_select_alternate(tmp_path: Path) -> None:
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: httpx.Response(403))) as client:
        gateway = HttpGateway(client)
        store = ArxivRuntimeStore(tmp_path / "cache.sqlite3")
        source = ArxivSource(gateway, "https://export.arxiv.org/api/query", runtime_store=store,
                             egress_routes={"backup": gateway})
        try:
            with pytest.raises(ServiceError) as raised:
                await source._request_upstream("api", 0, "GET", source.endpoint)
            assert not raised.value.retryable
            assert "arxiv_egress_next_route" not in raised.value.details
            assert store.egress_route(("direct", "backup")) == "direct"
        finally:
            source.close()


def test_egress_config_keeps_secrets_private_and_validates_routes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOURCE_SERVICE_ARXIV_EGRESS_PROXIES", json.dumps({"backup": PROXY}))
    settings = make_settings(tmp_path)
    assert settings.arxiv_egress_proxies["backup"].get_secret_value() == PROXY
    assert "proxy-password" not in repr(settings)
    assert "proxy-password" not in settings.model_dump_json()
    for name, url in [("direct", PROXY), ("bad name", PROXY), ("backup", "ftp://secret@127.0.0.1:1080"),
                      ("backup", "http://secret@127.0.0.1"), ("backup", "http://secret@127.0.0.1:1080/path")]:
        with pytest.raises(ValidationError) as raised:
            make_settings(tmp_path, arxiv_egress_proxies={name: url})
        assert "secret@" not in str(raised.value)
