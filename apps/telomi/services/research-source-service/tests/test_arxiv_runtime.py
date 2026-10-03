from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from conftest import client_for

from research_source_service.app import cancel_on_disconnect
from research_source_service.arxiv_runtime import ArxivRuntimeStore
from research_source_service.sources.arxiv import ArxivSource

ATOM_PAGE = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv exact query cache fixture</title>
  <id>https://arxiv.org/api/query-cache-fixture</id>
  <updated>2026-07-21T00:00:00Z</updated>
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>1</opensearch:itemsPerPage>
  <entry>
    <id>https://arxiv.org/abs/2607.09999v1</id>
    <updated>2026-07-20T01:02:03Z</updated>
    <published>2026-07-19T01:02:03Z</published>
    <title>Cached Upstream Metadata</title>
    <summary>An exact raw Atom response.</summary>
    <author><name>Ada Example</name></author>
    <link title="pdf" href="https://arxiv.org/pdf/2607.09999v1" type="application/pdf"/>
    <category term="cs.AI"/>
    <arxiv:primary_category term="cs.AI"/>
  </entry>
</feed>"""


def arxiv_payload(term: str) -> dict[str, object]:
    return {
        "schema_version": 1,
        "source_id": "arxiv",
        "query": term,
        "max_results": 10,
        "provider_request": {
            "operation": "query",
            "parameters": {
                "search_query": f"cat:cs.AI AND all:{term}",
                "max_results": 10,
            },
        },
    }


def test_identical_query_reuses_exact_atom_response_from_sqlite(
    tmp_path: Path,
    authorization: dict[str, str],
) -> None:
    database = tmp_path / "arxiv.sqlite3"
    upstream_requests: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        upstream_requests.append(request)
        return httpx.Response(200, text=ATOM_PAGE, headers={"content-type": "application/atom+xml"})

    payload = arxiv_payload("cache")
    with client_for(tmp_path, upstream, arxiv_sqlite_path=database) as client:
        first = client.post("/v1/search", headers=authorization, json=payload)
    assert first.status_code == 200

    def reject_upstream(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected arXiv upstream request: {request.url}")

    with client_for(tmp_path, reject_upstream, arxiv_sqlite_path=database) as client:
        second = client.post("/v1/search", headers=authorization, json=payload)

    assert second.status_code == 200
    assert len(upstream_requests) == 1
    assert second.json()["results"][0]["title"] == "Cached Upstream Metadata"
    assert second.json()["results"][0]["metadata"]["arxiv_request_method"] == "CACHE"
    assert second.json()["results"][0]["metadata"]["arxiv_storage"] == "sqlite_query_cache"


def test_different_query_never_searches_cached_records_locally(
    tmp_path: Path,
    authorization: dict[str, str],
) -> None:
    database = tmp_path / "arxiv.sqlite3"
    terms: list[str] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        terms.append(request.url.params["search_query"])
        return httpx.Response(200, text=ATOM_PAGE, headers={"content-type": "application/atom+xml"})

    with client_for(tmp_path, upstream, arxiv_sqlite_path=database) as client:
        first = client.post("/v1/search", headers=authorization, json=arxiv_payload("first"))
        second = client.post("/v1/search", headers=authorization, json=arxiv_payload("second"))

    assert first.status_code == 200
    assert second.status_code == 200
    assert terms == ["cat:cs.AI AND all:first", "cat:cs.AI AND all:second"]
    assert "arxiv_storage" not in second.json()["results"][0]["metadata"]


def test_sqlite_coordinates_minimum_start_interval_for_upstream_calls(
    tmp_path: Path,
    authorization: dict[str, str],
) -> None:
    database = tmp_path / "arxiv.sqlite3"
    started_at: list[float] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        started_at.append(time.monotonic())
        return httpx.Response(200, text=ATOM_PAGE, headers={"content-type": "application/atom+xml"})

    with client_for(
        tmp_path,
        upstream,
        arxiv_sqlite_path=database,
        arxiv_min_start_interval_seconds=0.05,
    ) as client:
        first = client.post("/v1/search", headers=authorization, json=arxiv_payload("first"))
        second = client.post("/v1/search", headers=authorization, json=arxiv_payload("second"))

    assert first.status_code == 200
    assert second.status_code == 200
    assert len(started_at) == 2
    assert started_at[1] - started_at[0] >= 0.04


def test_upstream_lock_is_exclusive_across_store_instances(tmp_path: Path) -> None:
    scheduler = tmp_path / "shared" / "upstream.sqlite3"
    first_store = ArxivRuntimeStore(tmp_path / "first" / "cache.sqlite3", scheduler_database=scheduler)
    second_store = ArxivRuntimeStore(tmp_path / "second" / "cache.sqlite3", scheduler_database=scheduler)
    def other_process_lock() -> str:
        return subprocess.run(
            [sys.executable, "-c", """
import sys
from pathlib import Path
from research_source_service.arxiv_runtime import ArxivRuntimeStore
store = ArxivRuntimeStore(Path(sys.argv[1]), scheduler_database=Path(sys.argv[2]))
lease = store.try_acquire_upstream_lock()
print('busy' if lease is None else 'available')
if lease is not None:
    lease.release()
store.close()
""", str(tmp_path / "process" / "cache.sqlite3"), str(scheduler)],
            check=True, capture_output=True, text=True, timeout=5,
        ).stdout.strip()

    first = first_store.try_acquire_upstream_lock()
    assert first is not None
    try:
        assert second_store.try_acquire_upstream_lock() is None
        assert other_process_lock() == "busy"
    finally:
        first.release()
        second = second_store.try_acquire_upstream_lock()
        assert second is not None
        second.release()
        assert other_process_lock() == "available"
        first_store.close()
        second_store.close()


@pytest.mark.asyncio
async def test_client_disconnect_cancels_work_and_releases_upstream_lock(tmp_path: Path) -> None:
    database = tmp_path / "arxiv.sqlite3"
    first_store = ArxivRuntimeStore(database)
    second_store = ArxivRuntimeStore(database)
    acquired = asyncio.Event()

    class Request:
        async def is_disconnected(self) -> bool:
            await acquired.wait()
            return True

    async def search() -> None:
        lease = first_store.try_acquire_upstream_lock()
        assert lease is not None
        acquired.set()
        try:
            await asyncio.Event().wait()
        finally:
            lease.release()

    try:
        with pytest.raises(asyncio.CancelledError):
            await cancel_on_disconnect(Request(), search())
        second = second_store.try_acquire_upstream_lock()
        assert second is not None
        second.release()
    finally:
        first_store.close()
        second_store.close()


def test_upstream_intervals_are_scoped_but_share_one_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(time, "time", lambda: 100.0)
    store = ArxivRuntimeStore(tmp_path / "arxiv.sqlite3")
    try:
        first = store.try_acquire_upstream_lock()
        assert first is not None
        assert store.upstream_delay("main") == 0
        store.record_upstream_start("main", 0.05, 0)
        first.release()

        second = store.try_acquire_upstream_lock()
        assert second is not None
        delay = store.upstream_delay("main")
        second.release()
        assert delay == pytest.approx(0.05)

        api = store.try_acquire_upstream_lock()
        assert api is not None
        assert store.upstream_delay("api") == 0
        api.release()
    finally:
        store.close()


def test_global_slot_spaces_api_after_main(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(time, "time", lambda: 100.0)
    store = ArxivRuntimeStore(tmp_path / "arxiv.sqlite3")
    try:
        assert store.upstream_delay("main") == 0
        store.record_upstream_start("main", 0, 0.05)
        # a request on a different scope right afterwards still waits for the global slot
        assert store.upstream_delay("api") == pytest.approx(0.05)
    finally:
        store.close()


def test_separate_query_caches_share_deadlines_and_cooldown(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [100.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    scheduler = tmp_path / "shared" / "upstream.sqlite3"
    first = ArxivRuntimeStore(tmp_path / "first" / "cache.sqlite3", scheduler_database=scheduler)
    second = ArxivRuntimeStore(tmp_path / "second" / "cache.sqlite3", scheduler_database=scheduler)
    try:
        lease = first.try_acquire_upstream_lock()
        assert lease is not None
        try:
            assert second.try_acquire_upstream_lock() is None
        finally:
            lease.release()
        endpoint, query = "https://export.arxiv.org/api/query", {"search_query": "fixture"}
        first.put_cached_response(endpoint, query, "first instance response")
        assert second.get_cached_response(endpoint, query) is None
        second.put_cached_response(endpoint, query, "second instance response")
        assert first.get_cached_response(endpoint, query) == "first instance response"
        assert second.get_cached_response(endpoint, query) == "second instance response"
        assert first.scheduler_connection.execute(
            "SELECT name FROM sqlite_master WHERE name='arxiv_query_cache'"
        ).fetchone() is None

        first.record_upstream_start("main", 8, 3)
        assert second.upstream_delay("api") == 3
        assert second.upstream_delay("main") == 8
        clock[0] += 2
        second.cooldown(20)
        assert first.upstream_delay("api") == 20
        assert first.upstream_delay("main") == 20
        first.cooldown(1)
        assert second.upstream_delay("api") == 20, "A shorter retry window cannot erase the shared cooldown"
    finally:
        first.close()
        second.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("oversleep", [0.0, 5.0])
@pytest.mark.parametrize("separate_cache", [False, True])
async def test_scope_wait_and_oversleep_keep_global_interval_at_actual_http_start(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    oversleep: float,
    separate_cache: bool,
) -> None:
    clock = [100.0]
    started_at: list[float] = []
    monkeypatch.setattr(time, "time", lambda: clock[0])

    async def sleep(delay: float) -> None:
        clock[0] += delay + oversleep

    class Http:
        async def request(self, _provider: str, method: str, url: str, **_kwargs: object) -> httpx.Response:
            started_at.append(clock[0])
            return httpx.Response(200, request=httpx.Request(method, url))

    monkeypatch.setattr(asyncio, "sleep", sleep)
    scheduler = tmp_path / "scheduler.sqlite3"
    store = ArxivRuntimeStore(tmp_path / "cache.sqlite3", scheduler_database=scheduler)
    source = ArxivSource(Http(), "https://export.arxiv.org/api/query", runtime_store=store,
                         global_min_start_interval_seconds=3)
    other = ArxivSource(Http(), "https://export.arxiv.org/api/query",
                        runtime_store=ArxivRuntimeStore(tmp_path / "other-cache.sqlite3", scheduler_database=scheduler),
                        global_min_start_interval_seconds=3) if separate_cache else source
    try:
        await source._request_upstream("main", 8, "GET", "https://arxiv.org/html/fixture-a")
        await source._request_upstream("main", 8, "GET", "https://arxiv.org/html/fixture-b")
        await other._request_upstream("api", 4, "GET", "https://export.arxiv.org/api/query")
        assert started_at[1] - started_at[0] >= 8
        assert started_at[2] - started_at[1] >= 3
        assert started_at == [100.0, 108.0 + oversleep, 111.0 + 2 * oversleep]
    finally:
        source.close()
        if other is not source:
            other.close()


@pytest.mark.asyncio
async def test_cancelling_pacing_wait_releases_shared_lock_without_reserving_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(time, "time", lambda: 100.0)
    waiting = asyncio.Event()

    async def sleep(_delay: float) -> None:
        waiting.set()
        await asyncio.Event().wait()

    class Http:
        async def request(self, *_args: object, **_kwargs: object) -> httpx.Response:
            raise AssertionError("A cancelled pacing wait must never reach HTTP")

    monkeypatch.setattr(asyncio, "sleep", sleep)
    scheduler = tmp_path / "scheduler.sqlite3"
    first = ArxivRuntimeStore(tmp_path / "first-cache.sqlite3", scheduler_database=scheduler)
    second = ArxivRuntimeStore(tmp_path / "second-cache.sqlite3", scheduler_database=scheduler)
    first.cooldown(60)
    source = ArxivSource(Http(), "https://export.arxiv.org/api/query", runtime_store=first)
    task = asyncio.create_task(source._request_upstream("api", 4, "GET", source.endpoint))
    try:
        await asyncio.wait_for(waiting.wait(), 1)
        lease = second.try_acquire_upstream_lock()
        assert lease is not None, "a pacing/cooldown wait must leave admission available to other scopes"
        lease.release()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert second.upstream_delay("api") == 60
        lease = second.try_acquire_upstream_lock()
        assert lease is not None
        lease.release()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        source.close()
        second.close()
