from __future__ import annotations

import hashlib
import importlib.util
import multiprocessing
import os
import sqlite3
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from research_source_service import material_cache
from research_source_service.material_cache import MaterialCache


def material(root: Path, name: str, files: dict[str, bytes]) -> Path:
    path = root / name
    path.mkdir()
    for filename, content in files.items():
        (path / filename).write_bytes(content)
    return path


def clock(monkeypatch):
    now = [1_000.0]
    monkeypatch.setattr(material_cache, "time", SimpleNamespace(time=lambda: now[0], sleep=time.sleep))
    return now


def test_lru_counts_unique_bytes_and_keeps_shared_snapshot_objects(tmp_path, monkeypatch):
    now = clock(monkeypatch)
    root = tmp_path / "cache"
    cache = MaterialCache(root, ttl_seconds=60)
    first = material(tmp_path, "first", {"shared": b"shared", "a": b"AAAA"})
    second = material(tmp_path, "second", {"shared": b"shared", "b": b"BBBB"})
    pinned = material(tmp_path, "pinned", {"shared": b"shared"})
    cache.store_tree("download", "first", first, immutable=True)
    cache.store_tree("download", "alias", first, immutable=True)
    tree, _, _ = cache.store_tree_sha(pinned)
    now[0] += 1
    cache.store_tree("parse", "second", second, immutable=True)
    now[0] += 1
    assert cache.restore_tree("download", "first", tmp_path / "used")
    cache = MaterialCache(root, ttl_seconds=60)
    before = (root / "catalog.sqlite").read_bytes()
    planned = cache.collect_garbage(dry_run=True, max_idle_seconds=100, max_bytes=10)
    assert (root / "catalog.sqlite").read_bytes() == before
    assert cache.gc_status() is None
    assert planned["freed_bytes"] == 4
    assert planned["protected_bytes"] == 6
    applied = cache.collect_garbage(max_idle_seconds=100, max_bytes=10)
    assert applied == planned
    assert cache.stats()["blob_bytes"] == 10
    assert not cache.restore_tree("parse", "second", tmp_path / "gone")
    assert cache.restore_tree("download", "alias", tmp_path / "kept")
    assert cache.restore_tree_sha(tree, tmp_path / "snapshot")
    assert MaterialCache(root, ttl_seconds=60).gc_status()["report"] == applied


def test_freshness_expiry_does_not_replace_idle_retention(tmp_path, monkeypatch):
    now = clock(monkeypatch)
    cache = MaterialCache(tmp_path / "cache", ttl_seconds=60)
    cache.store_tree("download", "mutable", material(tmp_path, "source", {"data": b"data"}))
    now[0] += 61
    assert not cache.restore_tree("download", "mutable", tmp_path / "stale")
    assert cache.collect_garbage(max_idle_seconds=100)["dead_trees"] == 0
    now[0] += 40
    assert cache.collect_garbage(max_idle_seconds=100)["evicted_by_age"] == 1


def test_old_catalog_migration_uses_original_creation_time(tmp_path, monkeypatch):
    now = clock(monkeypatch)
    root = tmp_path / "cache"
    cache = MaterialCache(root, ttl_seconds=60)
    cache.store_tree("download", "old", material(tmp_path, "old", {"data": b"old"}), immutable=True)
    with sqlite3.connect(root / "catalog.sqlite") as db:
        db.execute("ALTER TABLE acquisitions DROP COLUMN last_accessed_at")
    now[0] += 101
    preview = MaterialCache(root, ttl_seconds=60, read_only=True)
    assert preview.collect_garbage(dry_run=True, max_idle_seconds=100)["evicted_by_age"] == 1
    with sqlite3.connect(root / "catalog.sqlite") as db:
        assert "last_accessed_at" not in {row[1] for row in db.execute("PRAGMA table_info(acquisitions)")}
    reopened = MaterialCache(root, ttl_seconds=60)
    assert reopened.collect_garbage(max_idle_seconds=100)["evicted_by_age"] == 1


def test_overlay_owns_snapshot_after_base_download_is_evicted(tmp_path, monkeypatch):
    now = clock(monkeypatch)
    base_root, overlay_root = tmp_path / "base", tmp_path / "overlay"
    base = MaterialCache(base_root, ttl_seconds=60)
    source = material(tmp_path, "source", {"data": b"immutable source"})
    base.store_tree("download", "source", source, immutable=True)
    overlay = MaterialCache(overlay_root, ttl_seconds=60, base_root=base_root)
    digest = hashlib.sha256(b"immutable source").hexdigest()
    original = (base_root / "catalog.sqlite").read_bytes()
    now[0] += 10
    assert overlay.restore_tree("download", "source", tmp_path / "from-base")
    assert (base_root / "catalog.sqlite").read_bytes() == original
    tree, _, _ = overlay.store_tree_sha(source)
    assert (overlay_root / "objects" / digest[:2] / digest).exists()
    now[0] += 100
    assert base.collect_garbage(max_idle_seconds=100)["dead_trees"] == 1
    assert overlay.restore_tree_sha(tree, tmp_path / "still-durable")
    assert (tmp_path / "still-durable/data").read_bytes() == b"immutable source"


def test_interrupted_deletion_recovers_without_reviving_dead_entries(tmp_path, monkeypatch):
    cache = MaterialCache(tmp_path / "cache", ttl_seconds=60)
    source = material(tmp_path, "source", {"data": b"data"})
    cache.store_tree("download", "key", source, immutable=True)
    unlink = Path.unlink

    def interrupted(path, *args, **kwargs):
        if "objects" in path.parts:
            raise OSError("injected deletion interruption")
        return unlink(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", interrupted)
        with pytest.raises(OSError, match="injected deletion"):
            cache.collect_garbage(max_bytes=1)
    with sqlite3.connect(tmp_path / "cache/catalog.sqlite") as db:
        assert db.execute("SELECT COUNT(*) FROM gc_pending").fetchone()[0] > 0
    preview = MaterialCache(tmp_path / "cache", ttl_seconds=60, read_only=True)
    preview.collect_garbage(dry_run=True, max_bytes=1)
    assert any(path.is_file() for path in (tmp_path / "cache/objects").rglob("*"))
    cache = MaterialCache(tmp_path / "cache", ttl_seconds=60)
    assert not cache.restore_tree("download", "key", tmp_path / "gone")
    assert not any(path.is_file() for path in (tmp_path / "cache/objects").rglob("*"))
    cache.store_tree("download", "key", source, immutable=True)
    assert cache.restore_tree("download", "key", tmp_path / "downloaded-again")


def collect_in_child(root, ready, collect, reports):
    cache = MaterialCache(Path(root), ttl_seconds=60)
    ready.set()
    assert collect.wait(10)
    reports.put(cache.collect_garbage(max_bytes=1, blocking=False))


@pytest.mark.parametrize("from_base", [False, True])
def test_gc_cannot_delete_while_another_process_materializes(tmp_path, monkeypatch, from_base):
    cache = MaterialCache(tmp_path / "cache", ttl_seconds=60)
    cache.store_tree("download", "key", material(tmp_path, "source", {"data": b"data"}), immutable=True)
    base = cache
    if from_base:
        cache = MaterialCache(tmp_path / "overlay", ttl_seconds=60, base_root=tmp_path / "cache")
    context = multiprocessing.get_context("spawn")
    ready, collect, reports = context.Event(), context.Event(), context.Queue()
    child = context.Process(target=collect_in_child, args=(str(tmp_path / "cache"), ready, collect, reports))
    child.start()
    started, release = threading.Event(), threading.Event()
    clone = material_cache._clone_tree

    def held(source, target):
        started.set()
        assert release.wait(10)
        return clone(source, target)

    monkeypatch.setattr(material_cache, "_clone_tree", held)
    reader = threading.Thread(target=cache.restore_tree, args=("download", "key", tmp_path / "restored"))
    try:
        assert ready.wait(10)
        reader.start()
        assert started.wait(10)
        collect.set()
        assert reports.get(timeout=10)["skipped_busy"] == 1
    finally:
        release.set()
        if reader.ident:
            reader.join(10)
        collect.set()
        child.join(10)
        if child.is_alive():
            child.terminate()
            child.join(10)
    assert child.exitcode == 0
    assert (tmp_path / "restored/data").read_bytes() == b"data"
    assert base.collect_garbage(max_bytes=1)["freed_bytes"] == 4


def test_active_download_entry_is_protected(tmp_path):
    cache = MaterialCache(tmp_path / "cache", ttl_seconds=60)
    cache.store_tree("download", "key", material(tmp_path, "source", {"data": b"data"}), immutable=True)
    with sqlite3.connect(tmp_path / "cache/catalog.sqlite") as db:
        db.execute("INSERT INTO inflight VALUES (?,?,?,?)", ("download", "key", f"{os.getpid()}:active", time.time()))
    report = cache.collect_garbage(max_bytes=1)
    assert report["protected_bytes"] == 4
    assert report["over_limit_bytes"] == 3


def test_cli_never_treats_unknown_workspace_references_as_empty(tmp_path, monkeypatch):
    script = Path(__file__).parents[1] / "scripts/gc_material_cache.py"
    spec = importlib.util.spec_from_file_location("cache_gc_cli", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = tmp_path / "cache"
    cache = MaterialCache(root, ttl_seconds=60)
    tree, _, _ = cache.store_tree_sha(material(tmp_path, "source", {"data": b"snapshot"}))
    monkeypatch.setenv("SOURCE_SERVICE_MATERIAL_CACHE_ROOT", str(root))
    monkeypatch.delenv("TELOMI_DATA_DIR", raising=False)
    assert module.referenced_workspace_tree_shas(root) is None
    monkeypatch.setattr(sys, "argv", [str(script), "--apply", "--max-bytes", "1"])
    assert module.main() == 0
    assert cache.restore_tree_sha(tree, tmp_path / "preserved")
    monkeypatch.setattr(sys, "argv", [str(script), "--apply", "--prune-workspace-snapshots"])
    with pytest.raises(SystemExit) as error:
        module.main()
    assert error.value.code == 2
    monkeypatch.setenv("TELOMI_DATA_DIR", str(tmp_path))
    (tmp_path / "manifest.json").write_bytes(b"\xff")
    assert module.referenced_workspace_tree_shas(root) is None
