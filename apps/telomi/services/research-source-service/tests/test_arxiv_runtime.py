from __future__ import annotations

import asyncio
import time
from pathlib import Path

import httpx
import pytest
from conftest import client_for

from research_source_service.app import cancel_on_disconnect
from research_source_service.arxiv_runtime import ArxivRuntimeStore

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
    database = tmp_path / "arxiv.sqlite3"
    first_store = ArxivRuntimeStore(database)
    second_store = ArxivRuntimeStore(database)
    first = first_store.try_acquire_upstream_lock()
    assert first is not None
    try:
        assert second_store.try_acquire_upstream_lock() is None
    finally:
        first.release()
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


def test_upstream_intervals_are_scoped_but_share_one_lock(tmp_path: Path) -> None:
    store = ArxivRuntimeStore(tmp_path / "arxiv.sqlite3")
    try:
        first = store.try_acquire_upstream_lock()
        assert first is not None
        assert store.reserve_upstream_slot("main", 0.05) == 0
        first.release()

        second = store.try_acquire_upstream_lock()
        assert second is not None
        delay = store.reserve_upstream_slot("main", 0.05)
        second.release()
        assert delay >= 0.04

        api = store.try_acquire_upstream_lock()
        assert api is not None
        assert store.reserve_upstream_slot("api", 0) == 0
        api.release()
    finally:
        store.close()


def test_global_slot_spaces_api_after_main(tmp_path: Path) -> None:
    store = ArxivRuntimeStore(tmp_path / "arxiv.sqlite3")
    try:
        assert store.reserve_upstream_slot("main", 0) == 0
        assert store.reserve_upstream_slot("any", 0.05) == 0
        # a request on a different scope right afterwards still waits for the global slot
        assert store.reserve_upstream_slot("api", 0) == 0
        assert store.reserve_upstream_slot("any", 0.05) >= 0.04
    finally:
        store.close()
