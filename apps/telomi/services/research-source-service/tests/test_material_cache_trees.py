from __future__ import annotations

import hashlib
import importlib.util
import os
import shutil
import tempfile
from pathlib import Path

import httpx
import pytest
from conftest import client_for

from research_source_service.material_cache import MaterialCache

EXCLUDE = [".venv", "node_modules", "__pycache__", ".git", "*.log", ".DS_Store", "runtime/agent"]
EMPTY_TREE_SHA = hashlib.sha256(b"").hexdigest()
SCRATCH_VOLUME = os.environ.get("TELOMI_TEST_APFS_VOLUME")


def unused_provider(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"Unexpected provider request: {request.method} {request.url}")


@pytest.fixture
def scratch() -> Path:
    if not SCRATCH_VOLUME:
        pytest.skip("TELOMI_TEST_APFS_VOLUME is not configured")
    volume = Path(SCRATCH_VOLUME).expanduser()
    if not volume.is_dir():
        pytest.skip(f"{volume} is not mounted")
    parent = volume / "telomi-eval-scratch"
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="trees-", dir=parent))
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def test_store_tree_applies_exclusions_and_restore_clones_real_files(scratch: Path, authorization) -> None:
    source = scratch / "work"
    write(source / "notes.md", b"# notes\n")
    write(source / "sub" / "data.json", b'{"a": 1}\n')
    write(source / "node_modules" / "pkg" / "index.js", b"module.exports = 1;\n")
    write(source / ".venv" / "bin" / "python", b"#!/bin/sh\n")
    write(source / "sub" / "__pycache__" / "x.pyc", b"\x00")
    write(source / ".git" / "HEAD", b"ref: refs/heads/main\n")
    write(source / "debug.log", b"log\n")
    write(source / ".DS_Store", b"\x00")
    write(source / "runtime" / "agent" / "auth.json", b'{"token": "secret"}\n')
    write(source / "repo" / "runtime" / "agent" / "kept.py", b"x = 1\n")
    restored = scratch / "restored"
    restored.mkdir()

    with client_for(scratch, unused_provider, material_cache_root=scratch / "cache") as client:
        stored = client.post("/v1/trees", headers=authorization, json={"path": str(source), "exclude": EXCLUDE})
        assert stored.status_code == 200, stored.text
        body = stored.json()
        assert body["file_count"] == 3
        assert body["total_bytes"] == len(b"# notes\n") + len(b'{"a": 1}\n') + len(b"x = 1\n")
        tree_sha = body["tree_sha"]
        # Same content twice yields the same tree.
        again = client.post("/v1/trees", headers=authorization, json={"path": str(source), "exclude": EXCLUDE})
        assert again.json()["tree_sha"] == tree_sha

        restore = client.post(f"/v1/trees/{tree_sha}/restore", headers=authorization, json={"path": str(restored)})
        assert restore.status_code == 200, restore.text
        assert restore.json() == {"schema_version": 1, "tree_sha": tree_sha, "materialize_mode": "clone"}
        cache = client.app.state.registry.material_cache
        assert cache.last_materialize_mode == "clone"

        conflict = client.post(f"/v1/trees/{tree_sha}/restore", headers=authorization, json={"path": str(restored)})
        assert conflict.status_code == 409
        (scratch / "x").mkdir()
        unknown = client.post(f"/v1/trees/{'0' * 64}/restore", headers=authorization, json={"path": str(scratch / "x")})
        assert unknown.status_code == 404
        missing = client.post("/v1/trees", headers=authorization, json={"path": str(scratch / "nope"), "exclude": []})
        assert missing.status_code == 400

    assert sorted(str(p.relative_to(restored)) for p in restored.rglob("*") if p.is_file()) == [
        "notes.md",
        "repo/runtime/agent/kept.py",
        "sub/data.json",
    ]
    assert (restored / "notes.md").read_bytes() == b"# notes\n"
    assert (restored / "sub" / "data.json").read_bytes() == b'{"a": 1}\n'
    for excluded in ("node_modules", ".venv", "sub/__pycache__", ".git", "debug.log", ".DS_Store"):
        assert not (restored / excluded).exists(), excluded
    # clonefile produces independent regular files: not symlinks, not hard links into trees/.
    for name in ("notes.md", "sub/data.json"):
        stat = os.lstat(restored / name)
        assert not (restored / name).is_symlink()
        assert stat.st_nlink == 1
        digest = hashlib.sha256((restored / name).read_bytes()).hexdigest()
        assert stat.st_ino != os.stat(scratch / "cache" / "objects" / digest[:2] / digest).st_ino
    # Writing into the clone must not touch the cache object.
    (restored / "notes.md").write_bytes(b"changed\n")
    digest = hashlib.sha256(b"# notes\n").hexdigest()
    assert (scratch / "cache" / "objects" / digest[:2] / digest).read_bytes() == b"# notes\n"


def test_empty_directory_has_a_tree_sha_and_restores(scratch: Path, authorization) -> None:
    empty = scratch / "empty"
    empty.mkdir()
    target = scratch / "target"
    target.mkdir()
    with client_for(scratch, unused_provider, material_cache_root=scratch / "cache") as client:
        stored = client.post("/v1/trees", headers=authorization, json={"path": str(empty), "exclude": EXCLUDE})
        assert stored.status_code == 200, stored.text
        assert stored.json() == {"schema_version": 1, "tree_sha": EMPTY_TREE_SHA, "file_count": 0, "total_bytes": 0}
        restore = client.post(f"/v1/trees/{EMPTY_TREE_SHA}/restore", headers=authorization, json={"path": str(target)})
        assert restore.status_code == 200, restore.text
    assert target.is_dir() and not any(target.iterdir())


def test_gc_keeps_referenced_snapshots_and_provider_acquisitions(scratch: Path, authorization) -> None:
    kept = scratch / "kept"
    write(kept / "shared.txt", b"shared")
    write(kept / "kept.txt", b"kept")
    dead = scratch / "dead"
    write(dead / "shared.txt", b"shared")
    write(dead / "dead.txt", b"dead")
    provider = scratch / "provider"
    write(provider / "provider.txt", b"provider")

    with client_for(scratch, unused_provider, material_cache_root=scratch / "cache") as client:
        kept_sha = client.post("/v1/trees", headers=authorization, json={"path": str(kept), "exclude": []}).json()[
            "tree_sha"
        ]
        dead_sha = client.post("/v1/trees", headers=authorization, json={"path": str(dead), "exclude": []}).json()[
            "tree_sha"
        ]
        cache = client.app.state.registry.material_cache
        cache.store_tree("provider", "immutable-key", provider, immutable=True)

        expected = {"trees_removed": 1, "blobs_removed": 1, "bytes_freed": len(b"dead")}
        dry_run = client.post(
            "/v1/trees/gc", headers=authorization, json={"keep_tree_shas": [kept_sha], "dry_run": True}
        )
        assert dry_run.status_code == 200, dry_run.text
        assert dry_run.json() == expected
        assert cache.restore_tree_sha(dead_sha, scratch / "dry-run-restore")

        applied = client.post(
            "/v1/trees/gc", headers=authorization, json={"keep_tree_shas": [kept_sha], "dry_run": False}
        )
        assert applied.status_code == 200, applied.text
        assert applied.json() == expected
        with pytest.raises(LookupError):
            cache.restore_tree_sha(dead_sha, scratch / "dead-restore")
        assert cache.restore_tree_sha(kept_sha, scratch / "kept-restore")
        assert cache.restore_tree("provider", "immutable-key", scratch / "provider-restore")


def test_overlay_reads_base_but_writes_and_gc_stay_local(tmp_path: Path) -> None:
    """Candidate overlay：读得到 base 的对象，写只落 overlay，GC 动不了 base。"""
    base_root, overlay_root = tmp_path / "base", tmp_path / "overlay"
    base = MaterialCache(base_root, ttl_seconds=3600)
    produced = tmp_path / "production-work"
    write(produced / "paper.md", b"produced by the production instance\n")
    base_sha, _, _ = base.store_tree_sha(produced)
    base_digest = hashlib.sha256(b"produced by the production instance\n").hexdigest()
    base_object = base_root / "objects" / base_digest[:2] / base_digest

    overlay = MaterialCache(overlay_root, ttl_seconds=3600, base_root=base_root)
    assert overlay.restore_tree_sha(base_sha, tmp_path / "restored")
    assert (tmp_path / "restored" / "paper.md").read_bytes() == b"produced by the production instance\n"
    assert os.access(tmp_path / "restored" / "paper.md", os.W_OK)   # 还原的是扫描时的 mode，不是 objects/ 的 0444

    candidate = tmp_path / "candidate-work"
    write(candidate / "answer.md", b"written by the candidate\n")
    candidate_sha, _, _ = overlay.store_tree_sha(candidate)
    candidate_digest = hashlib.sha256(b"written by the candidate\n").hexdigest()
    assert (overlay_root / "objects" / candidate_digest[:2] / candidate_digest).exists()
    assert not (base_root / "objects" / candidate_digest[:2] / candidate_digest).exists()
    assert not (base_root / "trees" / candidate_sha[:2] / candidate_sha).exists()
    assert base.stats() == {"blobs": 1, "blob_bytes": len(b"produced by the production instance\n"),
                            "trees": 1, "tree_entries": 1,
                            "logical_bytes": len(b"produced by the production instance\n"), "acquisitions": 1}

    # keep 空集：overlay 里的一切都是垃圾，base 的对象仍然必须留下并且可读。
    overlay.collect_garbage(keep_workspace_tree_shas=set())
    assert base_object.read_bytes() == b"produced by the production instance\n"
    assert overlay.restore_tree_sha(base_sha, tmp_path / "restored-after-gc")
    with pytest.raises(LookupError):
        overlay.restore_tree_sha(candidate_sha, tmp_path / "candidate-after-gc")


def test_overlay_root_must_differ_from_base_root(tmp_path: Path) -> None:
    MaterialCache(tmp_path / "cache", ttl_seconds=3600)
    with pytest.raises(ValueError):
        MaterialCache(tmp_path / "cache", ttl_seconds=3600, base_root=tmp_path / "cache")


def test_gc_discovers_workspace_trees_referenced_by_runs_and_cases(tmp_path: Path, monkeypatch) -> None:
    script = Path(__file__).parents[1] / "scripts" / "gc_material_cache.py"
    spec = importlib.util.spec_from_file_location("gc_material_cache", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    first, second = "1" * 64, "2" * 64
    write(tmp_path / "goal" / "run" / "manifest.json", f'{{"input_tree_sha":"{first}"}}'.encode())
    write(tmp_path / "goal" / "run" / "runtime--research.jsonl",
          f'{{"workspace":{{"output_tree_sha":"{second}"}}}}\n'.encode())
    write(tmp_path / "goal" / "run" / "ignored.txt", f'{{"input_tree_sha":"{"3" * 64}"}}'.encode())
    monkeypatch.setenv("TELOMI_DATA_DIR", str(tmp_path))
    assert module.referenced_workspace_tree_shas() == {first, second}


def test_trees_require_material_cache_root_and_workspace_roots(tmp_path: Path, authorization) -> None:
    with client_for(tmp_path, unused_provider) as client:
        disabled = client.post("/v1/trees", headers=authorization, json={"path": str(tmp_path), "exclude": []})
    assert disabled.status_code == 503
    assert disabled.json()["error"]["code"] == "material_cache_disabled"

    outside = Path(tempfile.mkdtemp())
    try:
        with client_for(tmp_path, unused_provider, material_cache_root=tmp_path / "cache") as client:
            rejected = client.post("/v1/trees", headers=authorization, json={"path": str(outside), "exclude": []})
        assert rejected.status_code == 403
        assert rejected.json()["error"]["code"] == "workspace_outside_allowed_roots"
    finally:
        shutil.rmtree(outside, ignore_errors=True)
