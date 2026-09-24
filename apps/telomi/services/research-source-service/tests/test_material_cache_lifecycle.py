from __future__ import annotations

import threading
import time
from pathlib import Path
from queue import Queue
from types import SimpleNamespace

import httpx
import pytest
from conftest import client_for, make_settings
from pydantic import ValidationError

from research_source_service import material_cache
from research_source_service.material_cache import MaterialCache


def unused_provider(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"Unexpected provider request: {request.method} {request.url}")


def material(root: Path, name: str, contents: bytes) -> Path:
    source = root / name
    source.mkdir()
    (source / "contents.txt").write_bytes(contents)
    return source


def test_startup_periodic_collection_and_restart_keep_persisted_access(tmp_path, monkeypatch, authorization):
    now = [1_000.0]
    monkeypatch.setattr(material_cache, "time", SimpleNamespace(time=lambda: now[0], sleep=time.sleep,
                                                              monotonic=time.monotonic))
    root = tmp_path / "cache"
    cache = MaterialCache(root, ttl_seconds=60)
    cache.store_tree("download", "old", material(tmp_path, "old", b"old"), immutable=True)
    snapshot = material(tmp_path, "snapshot", b"retained evidence")
    tree_sha, _, _ = cache.store_tree_sha(snapshot)
    now[0] = 1_101.0
    cache.store_tree("document-parse", "recent", material(tmp_path, "recent", b"recent"), immutable=True)

    sweeps: Queue[dict[str, int]] = Queue()
    collect = MaterialCache.collect_garbage

    def observed(self, **kwargs):
        assert "keep_workspace_tree_shas" not in kwargs
        assert kwargs["blocking"] is False
        report = collect(self, **kwargs)
        sweeps.put(report)
        return report

    monkeypatch.setattr(MaterialCache, "collect_garbage", observed)

    settings = dict(material_cache_root=root, material_cache_retention_seconds=100,
                    material_cache_gc_interval_seconds=1)
    with client_for(tmp_path, unused_provider, **settings) as client:
        assert sweeps.get(timeout=5)["evicted_by_age"] == 1
        assert client.get("/v1/health", headers=authorization).status_code == 200
        running = client.app.state.registry.material_cache
        assert not running.restore_tree("download", "old", tmp_path / "missing")
        now[0] = 1_150.0
        assert running.restore_tree("document-parse", "recent", tmp_path / "used")

    now[0] = 1_240.0
    # A slow runner may have queued another periodic pass before shutdown.
    while not sweeps.empty():
        sweeps.get_nowait()
    with client_for(tmp_path, unused_provider, **settings) as client:
        assert sweeps.get(timeout=5)["evicted_by_age"] == 0
        running = client.app.state.registry.material_cache
        assert running.stats()["acquisitions"] == 2
        assert running.gc_status()["last_sweep_at"] == now[0]
        now[0] = 1_251.0
        assert sweeps.get(timeout=5)["evicted_by_age"] == 1
        assert running.gc_status()["last_sweep_at"] == now[0]
        assert running.restore_tree_sha(tree_sha, tmp_path / "restored-snapshot")
        assert (tmp_path / "restored-snapshot" / "contents.txt").read_bytes() == b"retained evidence"
        assert (tmp_path / "used" / "contents.txt").read_bytes() == b"recent"
    assert client.app.state.material_cache_gc_task.done()


def test_collection_failure_retries_and_reports_protected_capacity(tmp_path, monkeypatch, authorization, caplog):
    root = tmp_path / "cache"
    cache = MaterialCache(root, ttl_seconds=60)
    cache.store_tree("download", "extra", material(tmp_path, "extra", b"extra"), immutable=True)
    cache.store_tree_sha(material(tmp_path, "protected", b"evidence"))
    sweeps: Queue[dict[str, int] | Exception] = Queue()
    collect = MaterialCache.collect_garbage
    calls = 0

    def fails_once(self, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            error = OSError("temporary storage failure")
            sweeps.put(error)
            raise error
        report = collect(self, **kwargs)
        sweeps.put(report)
        return report

    monkeypatch.setattr(MaterialCache, "collect_garbage", fails_once)
    with client_for(tmp_path, unused_provider, material_cache_root=root,
                    material_cache_max_bytes=2, material_cache_gc_interval_seconds=1) as client:
        assert isinstance(sweeps.get(timeout=5), OSError)
        assert client.get("/v1/health", headers=authorization).status_code == 200
        report = sweeps.get(timeout=5)
        assert report["evicted_by_size"] == 1
        assert report["over_limit_bytes"] == len(b"evidence") - 2
        assert client.get("/v1/health", headers=authorization).status_code == 200
    assert "Material cache GC failed" in caplog.text
    assert "protected workspace snapshots are retained" in caplog.text


def test_shutdown_waits_for_collection_worker(tmp_path, monkeypatch, authorization):
    started, release, closed = threading.Event(), threading.Event(), threading.Event()

    def held_collection(self, **kwargs):
        started.set()
        assert release.wait(5), "test failed to release the collection worker"
        return {}

    monkeypatch.setattr(MaterialCache, "collect_garbage", held_collection)
    client = client_for(tmp_path, unused_provider, material_cache_root=tmp_path / "cache")
    client.__enter__()

    def close_client():
        try:
            client.__exit__(None, None, None)
        finally:
            closed.set()

    closer = threading.Thread(target=close_client)
    try:
        assert started.wait(5)
        assert client.get("/v1/health", headers=authorization).status_code == 200
        closer.start()
        assert not closed.wait(0.05)
    finally:
        release.set()
        if closer.ident is None:
            closer.start()
        closer.join(5)
    assert closed.is_set()
    assert client.app.state.material_cache_gc_task.done()


def test_collection_requires_positive_configuration_and_skips_disabled_cache(tmp_path, authorization):
    for field in ("material_cache_retention_seconds", "material_cache_max_bytes", "material_cache_gc_interval_seconds"):
        with pytest.raises(ValidationError):
            make_settings(tmp_path, **{field: 0})
    with client_for(tmp_path, unused_provider) as client:
        assert client.get("/v1/health", headers=authorization).status_code == 200
        assert client.app.state.material_cache_gc_task is None
