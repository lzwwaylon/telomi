from __future__ import annotations

import asyncio
import json
import socket
import uuid

import httpx
import pytest
import uvicorn
from conftest import TOKEN, make_settings

from research_source_service.app import create_app
from research_source_service.arxiv_runtime import ArxivRuntimeStore


@pytest.mark.parametrize("supplied_request_id", [None, "disconnect-regression"])
async def test_real_http_disconnect_cancels_upstream_and_releases_lock(tmp_path, supplied_request_id):
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    release = asyncio.Event()

    async def upstream(request):
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return httpx.Response(404, text="fixture")

    settings = make_settings(tmp_path, material_cache_root=tmp_path / "cache")
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app = create_app(settings, http_client=upstream_client)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen()
            sock.setblocking(False)
            port = sock.getsockname()[1]
            server = uvicorn.Server(uvicorn.Config(app, log_level="critical", lifespan="on"))
            serving = asyncio.create_task(server.serve(sockets=[sock]))
            writer = None
            store = ArxivRuntimeStore(settings.arxiv_sqlite_path)
            try:
                async def wait_started():
                    while not server.started:
                        if serving.done():
                            await serving
                            raise AssertionError("Uvicorn exited before startup")
                        await asyncio.sleep(0.01)

                await asyncio.wait_for(wait_started(), 5)
                headers = {"X-Request-ID": supplied_request_id} if supplied_request_id else {}
                async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
                    health = await client.get("/v1/health", headers={**headers, "Authorization": f"Bearer {TOKEN}"})
                    assert health.status_code == 200
                    if supplied_request_id:
                        assert health.headers["x-request-id"] == supplied_request_id
                    else:
                        assert str(uuid.UUID(health.headers["x-request-id"])) == health.headers["x-request-id"]
                    unauthorized = await client.get("/v1/health", headers=headers)
                    assert unauthorized.status_code == 401
                    assert unauthorized.json()["error"]["request_id"] == unauthorized.headers["x-request-id"]
                    if supplied_request_id:
                        assert unauthorized.headers["x-request-id"] == supplied_request_id
                    else:
                        assert unauthorized.headers["x-request-id"] != health.headers["x-request-id"]

                _, writer = await asyncio.open_connection("127.0.0.1", port)
                body = json.dumps({
                    "schema_version": 1, "source_id": "arxiv", "query": "fixture", "max_results": 1,
                    "provider_request": {"operation": "paper_front", "parameters": {"arxiv_id": "1803.09047v1"}},
                }).encode()
                writer.write((
                    f"POST /v1/search HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\n"
                    f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n"
                ).encode() + body)
                await writer.drain()
                await asyncio.wait_for(entered.wait(), 5)
                lease = store.try_acquire_upstream_lock()
                if lease is not None:
                    lease.release()
                    pytest.fail("The blocked upstream request must hold the real arXiv flock")
                writer.close()
                await writer.wait_closed()
                await asyncio.wait_for(cancelled.wait(), 5)
                lease = store.try_acquire_upstream_lock()
                assert lease is not None, "Disconnect must release the arXiv flock before another request starts"
                lease.release()
            finally:
                release.set()
                if writer is not None:
                    writer.close()
                    await writer.wait_closed()
                server.should_exit = True
                try:
                    await asyncio.wait_for(serving, 5)
                finally:
                    store.close()
