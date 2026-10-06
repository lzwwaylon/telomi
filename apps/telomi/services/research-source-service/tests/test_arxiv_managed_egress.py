from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from conftest import client_for, make_settings
from test_arxiv_runtime import ATOM_PAGE, arxiv_payload

from research_source_service.app import create_app
from research_source_service.arxiv_runtime import ArxivRuntimeStore
from research_source_service.http_client import ArxivEgressRoutes, HttpGateway

ROUTE = "ts_abc123"
PROXY = "socks5h://127.0.0.1:1080"


def test_managed_routes_require_auth_and_ack_only_names(
    tmp_path: Path, authorization: dict[str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = httpx.AsyncClient
    clients = []

    def factory(**kwargs):
        if "transport" not in kwargs:
            assert kwargs["trust_env"] is False and kwargs["timeout"] is None
            kwargs = {"transport": httpx.MockTransport(lambda _: httpx.Response(200, text=ATOM_PAGE))}
        client = original(**kwargs)
        clients.append(client)
        return client

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    with client_for(tmp_path, lambda _: httpx.Response(200, text=ATOM_PAGE),
                    arxiv_egress_proxies={"manual": "socks5h://127.0.0.1:1081"}) as client:
        payload = {"schema_version": 1, "routes": {ROUTE: PROXY}}
        assert client.post("/v1/arxiv/egress", json=payload).status_code == 401
        response = client.post("/v1/arxiv/egress", headers=authorization, json=payload)
        assert response.json() == {"schema_version": 1, "route_names": ["direct", "manual", ROUTE]}
        count = len(clients)
        assert client.post("/v1/arxiv/egress", headers=authorization, json=payload).json() == response.json()
        assert len(clients) == count, "same configuration reuses clients"
        removed = client.post("/v1/arxiv/egress", headers=authorization, json={"schema_version": 1, "routes": {}})
        assert removed.json() == {"schema_version": 1, "route_names": ["direct", "manual"]}
        assert clients[-1].is_closed, "removed managed client closes without touching static clients"
        assert not clients[-2].is_closed
        assert PROXY not in response.text + removed.text
    assert all(item.is_closed for item in clients[1:]), "lifespan closes owned clients"


@pytest.mark.parametrize("name,proxy", [
    ("direct", PROXY), ("manual", PROXY), ("ts_", PROXY),
    (ROUTE, "socks5h://user:password@127.0.0.1:1080"),
    (ROUTE, "socks5h://@127.0.0.1:1080"),
    (ROUTE, "socks5h://localhost:1080"), (ROUTE, "socks5h://192.0.2.1:1080"),
    (ROUTE, "https://127.0.0.1:1080"), (ROUTE, "socks5h://127.0.0.1"),
    (ROUTE, "socks5h://127.0.0.1:0"), (ROUTE, "socks5h://127.0.0.1:1080/path"),
    (ROUTE, "socks5h://127.0.0.1:1080?token=secret"),
    (ROUTE, "socks5h://127.0.0.1:1080#secret"),
])
def test_managed_routes_reject_unsafe_addresses_without_echo(
    tmp_path: Path, authorization: dict[str, str], name: str, proxy: str,
) -> None:
    with client_for(tmp_path, lambda _: httpx.Response(500)) as client:
        response = client.post("/v1/arxiv/egress", headers=authorization,
                               json={"schema_version": 1, "routes": {name: proxy}})
    assert response.status_code == 422
    assert proxy not in response.text and "password" not in response.text and "token=secret" not in response.text


def test_static_name_collision_leaves_routes_unchanged(
    tmp_path: Path, authorization: dict[str, str],
) -> None:
    with client_for(tmp_path, lambda _: httpx.Response(500), arxiv_egress_proxies={ROUTE: PROXY}) as client:
        response = client.post("/v1/arxiv/egress", headers={**authorization, "x-request-id": "request-1081"},
                               json={"schema_version": 1, "routes": {ROUTE: "socks5h://127.0.0.1:1081"}})
        assert response.status_code == 400
        error = response.json()["error"]
        assert error.pop("request_id") == "request-1081"
        serialized_error = json.dumps(error)
        assert PROXY not in serialized_error and "1081" not in serialized_error
        assert client.app.state.registry.http.arxiv_egress.managed == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_control", [False, True])
async def test_http_update_waits_for_old_inflight_client_and_new_admission_uses_new_route(
    tmp_path: Path, authorization: dict[str, str], monkeypatch: pytest.MonkeyPatch, cancel_control: bool,
) -> None:
    original = httpx.AsyncClient
    entered = asyncio.Event()
    queued = asyncio.Event()
    published = asyncio.Event()
    finish = asyncio.Event()
    calls = []
    proxy_clients = []

    def factory(**kwargs):
        proxy = kwargs.get("proxy")
        if proxy == "socks5h://127.0.0.1:1082":
            published.set()

        async def upstream(_):
            calls.append(proxy)
            if proxy == PROXY:
                entered.set()
                await finish.wait()
            return httpx.Response(200, text=ATOM_PAGE)

        client = original(transport=httpx.MockTransport(upstream))
        if proxy:
            proxy_clients.append(client)
        return client

    direct = original(transport=httpx.MockTransport(lambda _: httpx.Response(500)))
    app = create_app(make_settings(tmp_path, arxiv_max_concurrency=2), direct)
    monkeypatch.setattr(httpx, "AsyncClient", factory)
    async with app.router.lifespan_context(app):
        async with original(transport=httpx.ASGITransport(app), base_url="http://source") as control:
            async def set_routes(port):
                return await control.post("/v1/arxiv/egress", headers=authorization,
                                          json={"schema_version": 1, "routes": {ROUTE: f"socks5h://127.0.0.1:{port}"}})

            assert (await set_routes(1080)).status_code == 200
            source = app.state.registry.sources["arxiv"]
            assert source.runtime_store.fail_egress_route("direct", ("direct", ROUTE), 60, scope="api") == ROUTE
            first = asyncio.create_task(control.post("/v1/search", headers=authorization, json=arxiv_payload("old")))
            await asyncio.wait_for(entered.wait(), 2)
            acquire = source.runtime_store.try_acquire_upstream_lock

            def observe_admission():
                lease = acquire()
                if lease is None:
                    queued.set()
                return lease

            monkeypatch.setattr(source.runtime_store, "try_acquire_upstream_lock", observe_admission)
            second = asyncio.create_task(control.post("/v1/search", headers=authorization,
                                                      json=arxiv_payload("new")))
            await asyncio.wait_for(queued.wait(), 2)
            update = asyncio.create_task(set_routes(1082))
            manager = app.state.registry.http.arxiv_egress
            await asyncio.wait_for(published.wait(), 2)
            assert manager.managed[ROUTE].proxy != PROXY
            assert not update.done() and not proxy_clients[0].is_closed
            if cancel_control:
                update.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await update
                update = asyncio.create_task(set_routes(1082))
                await asyncio.sleep(0)
                assert not update.done(), "idempotent re-push also waits for preceding retirement"
            finish.set()
            assert (await first).status_code == 200
            ack = await update
            assert ack.json() == {"schema_version": 1, "route_names": ["direct", ROUTE]}
            assert proxy_clients[0].is_closed
            assert (await second).status_code == 200
            assert calls == [PROXY, "socks5h://127.0.0.1:1082"]
            assert len(proxy_clients) == 2, "no hidden retry or duplicate client on re-push"
    assert all(client.is_closed for client in proxy_clients)
    await direct.aclose()


def test_failed_client_creation_keeps_old_mapping_and_sanitizes_error(
    tmp_path: Path, authorization: dict[str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = httpx.AsyncClient
    clients = []

    def factory(**kwargs):
        if kwargs.get("proxy") == PROXY:
            raise RuntimeError(f"Could not configure {PROXY}")
        client = original(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
        clients.append(client)
        return client

    with client_for(tmp_path, lambda _: httpx.Response(500)) as client:
        monkeypatch.setattr(httpx, "AsyncClient", factory)
        response = client.post("/v1/arxiv/egress", headers=authorization,
                               json={"schema_version": 1, "routes": {ROUTE: PROXY}})
        assert response.status_code == 503 and PROXY not in response.text
        assert list(client.app.state.registry.http.arxiv_egress.routes) == ["direct"]
        assert clients and all(item.is_closed for item in clients), "partial client creation is cleaned up"


@pytest.mark.asyncio
async def test_hot_update_preserves_shared_scheduler_and_accepts_ipv6(tmp_path: Path) -> None:
    original = httpx.AsyncClient
    async with original(transport=httpx.MockTransport(lambda _: httpx.Response(200))) as client:
        manager = ArxivEgressRoutes({"direct": HttpGateway(client, private_transport=True)})
        store = ArxivRuntimeStore(tmp_path / "cache.sqlite3")
        store.cooldown(61, scope="api")
        store.record_upstream_start("main", 8, 3)
        store.fail_egress_route("direct", ("direct", ROUTE), 60, scope="api")
        before = store.scheduler_connection.execute("SELECT * FROM arxiv_access_slots ORDER BY scope").fetchall()
        health = store.scheduler_connection.execute("SELECT * FROM arxiv_egress_health ORDER BY scope,name").fetchall()
        try:
            await manager.replace({ROUTE: "socks5h://[::1]:1080"})
            assert [tuple(row) for row in before] == [tuple(row) for row in store.scheduler_connection.execute(
                "SELECT * FROM arxiv_access_slots ORDER BY scope").fetchall()]
            assert [tuple(row) for row in health] == [tuple(row) for row in store.scheduler_connection.execute(
                "SELECT * FROM arxiv_egress_health ORDER BY scope,name").fetchall()]
            assert store.upstream_delay("api") > 60
        finally:
            await manager.close()
            store.close()
