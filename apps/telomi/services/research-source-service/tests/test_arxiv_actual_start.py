from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from research_source_service.arxiv_runtime import ArxivRuntimeStore
from research_source_service.errors import ServiceError
from research_source_service.sources.arxiv import ArxivSource


@pytest.mark.asyncio
@pytest.mark.parametrize("next_scope, expected_gap", [("api", 4), ("main", 3)])
async def test_synchronous_admission_pause_keeps_intervals_at_actual_http_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, next_scope: str, expected_gap: int,
) -> None:
    clock = [100.0]
    starts = []
    monkeypatch.setattr(time, "time", lambda: clock[0])

    async def sleep(delay: float) -> None:
        clock[0] += delay

    monkeypatch.setattr(asyncio, "sleep", sleep)
    method = (
        "begin_upstream_request" if hasattr(ArxivRuntimeStore, "begin_upstream_request") else "record_upstream_start"
    )
    original = getattr(ArxivRuntimeStore, method)
    paused = False

    def persist(self, *args, **kwargs):
        nonlocal paused
        result = original(self, *args, **kwargs)
        if not paused:
            paused = True
            clock[0] += 4.2
        return result

    monkeypatch.setattr(ArxivRuntimeStore, method, persist)

    class Http:
        async def request(self, provider: str, method: str, url: str, **kwargs) -> httpx.Response:
            starts.append(clock[0])
            clock[0] += 0.05
            return httpx.Response(200, request=httpx.Request(method, url))

    store = ArxivRuntimeStore(tmp_path / "cache.sqlite3")
    source = ArxivSource(Http(), "https://export.arxiv.org/api/query", runtime_store=store)
    try:
        await source._request_upstream("api", 4, "GET", source.endpoint)
        await source._request_upstream(next_scope, 4 if next_scope == "api" else 8, "GET", source.endpoint)
        assert starts[1] - starts[0] == pytest.approx(expected_gap)
    finally:
        source.close()


@pytest.mark.asyncio
async def test_cancelled_http_attempt_finalizes_spacing_and_clears_intent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [100.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    entered = asyncio.Event()

    class Http:
        async def request(self, *args, **kwargs):
            entered.set()
            await asyncio.Event().wait()

    store = ArxivRuntimeStore(tmp_path / "cache.sqlite3")
    source = ArxivSource(Http(), "https://export.arxiv.org/api/query", runtime_store=store)
    task = asyncio.create_task(source._request_upstream("api", 4, "GET", source.endpoint))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert store.scheduler_connection.execute("SELECT count(*) FROM arxiv_upstream_intent").fetchone()[0] == 1
        clock[0] += 1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        lease = store.try_acquire_upstream_lock()
        assert lease is not None
        try:
            assert store.recover_upstream_request() is None
            assert store.upstream_delay("api") == 3
            assert store.upstream_delay("main") == 2
        finally:
            lease.release()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        source.close()


@pytest.mark.asyncio
async def test_finalization_preserves_long_retry_after_and_other_scope_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = [100.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])

    class Http:
        async def request(self, *args, **kwargs):
            raise ServiceError("provider_rate_limit", "429", retryable=True, retry_after_ms=61_000,
                               details={"upstream_status": 429})

    store = ArxivRuntimeStore(tmp_path / "cache.sqlite3")
    source = ArxivSource(Http(), "https://export.arxiv.org/api/query", runtime_store=store)
    try:
        with pytest.raises(ServiceError):
            await source._request_upstream("api", 4, "GET", source.endpoint)
        assert store.upstream_delay("api") == 61
        assert store.upstream_delay("main") == 3
        assert store.scheduler_connection.execute("SELECT count(*) FROM arxiv_upstream_intent").fetchone()[0] == 0
    finally:
        source.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("crashed_scope, interval", [("api", 4), ("main", 8)])
async def test_process_exit_after_http_entry_recovers_intent_without_holding_other_scope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, crashed_scope: str, interval: int,
) -> None:
    scheduler = tmp_path / "scheduler.sqlite3"
    crashed = await asyncio.to_thread(subprocess.run, [sys.executable, "-c", """
import asyncio, os, sys, time
from pathlib import Path
from research_source_service.arxiv_runtime import ArxivRuntimeStore
from research_source_service.sources.arxiv import ArxivSource
clock = [100.0]
time.time = lambda: clock[0]
class Http:
    async def request(self, *args, **kwargs):
        os._exit(17)
original = ArxivRuntimeStore.begin_upstream_request
def delayed(self, *args):
    original(self, *args)
    clock[0] += 4.2
ArxivRuntimeStore.begin_upstream_request = delayed
store = ArxivRuntimeStore(Path(sys.argv[1]), scheduler_database=Path(sys.argv[2]))
source = ArxivSource(Http(), 'https://export.arxiv.org/api/query', runtime_store=store)
asyncio.run(source._request_upstream(sys.argv[3], int(sys.argv[4]), 'GET', source.endpoint))
""", str(tmp_path / "crashed-cache.sqlite3"), str(scheduler), crashed_scope, str(interval)],
        capture_output=True, text=True, timeout=10)
    assert crashed.returncode == 17, crashed.stderr
    clock = [105.0]
    starts = []
    monkeypatch.setattr(time, "time", lambda: clock[0])

    async def sleep(delay: float) -> None:
        clock[0] += delay

    monkeypatch.setattr(asyncio, "sleep", sleep)

    class Http:
        async def request(self, provider: str, method: str, url: str, **kwargs):
            starts.append(clock[0])
            return httpx.Response(200, request=httpx.Request(method, url))

    store = ArxivRuntimeStore(tmp_path / "recovered-cache.sqlite3", scheduler_database=scheduler)
    source = ArxivSource(Http(), "https://export.arxiv.org/api/query", runtime_store=store)
    other_scope = "main" if crashed_scope == "api" else "api"
    try:
        await source._request_upstream(other_scope, 8 if other_scope == "main" else 4, "GET", source.endpoint)
        assert starts == [108.0], "crash recovery conservatively restores global spacing without an eight-second wait"
        assert store.upstream_delay(crashed_scope) == max(interval - 3, 3)
        deadline = store.scheduler_connection.execute(
            "SELECT next_allowed_at FROM arxiv_access_slots WHERE scope=?", (crashed_scope,)
        ).fetchone()[0]
        assert deadline == 105 + interval
        assert store.scheduler_connection.execute("SELECT count(*) FROM arxiv_upstream_intent").fetchone()[0] == 0
    finally:
        source.close()
