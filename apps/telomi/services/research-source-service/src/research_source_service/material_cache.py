"""Provider 素材缓存：内容寻址存储 + copy-on-write 物化。

公开接口与旧实现一致（restore_tree / store_tree），调用方无需改动。差别在于：

  旧：每个 (namespace, key) 存一份完整 payload 目录，命中时 shutil.copytree 拷回来。
      同一个仓库被两条路径取用就在磁盘上留两份字节。
  新：字节按 sha256 存进 objects/ 全局去重；trees/ 是硬链接组装的只读逻辑树；
      命中时对整棵树做一次 clonefile，零字节且写时分裂。

macOS 上 Python 的 shutil 和 Node 的 COPYFILE_FICLONE 都不会真正克隆，必须走
`cp -Rc`，由内核的 clonefile(2) 执行。
"""

from __future__ import annotations

import fcntl
import fnmatch
import hashlib
import json
import math
import os
import shutil
import sqlite3
import subprocess
import time
import uuid
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS blobs(
    sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, first_seen_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS trees(
    tree_sha TEXT PRIMARY KEY, built_at REAL NOT NULL,
    file_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tree_entries(
    tree_sha TEXT NOT NULL, rel_path TEXT NOT NULL, sha256 TEXT NOT NULL, mode INTEGER NOT NULL,
    PRIMARY KEY(tree_sha, rel_path));
CREATE INDEX IF NOT EXISTS tree_entries_by_blob ON tree_entries(sha256);
CREATE TABLE IF NOT EXISTS acquisitions(
    namespace TEXT NOT NULL, key TEXT NOT NULL, tree_sha TEXT NOT NULL,
    immutable INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, last_accessed_at REAL,
    PRIMARY KEY(namespace, key));
-- 单飞：并行的 Provider 子进程请求同一个 key 时，只有抢到这一行的去下载，
-- 其余等待它落库后直接物化，避免同一份内容被下载多次。
CREATE TABLE IF NOT EXISTS inflight(
    namespace TEXT NOT NULL, key TEXT NOT NULL, owner TEXT NOT NULL,
    started_at REAL NOT NULL, PRIMARY KEY(namespace, key));
CREATE TABLE IF NOT EXISTS gc_pending(
    kind TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(kind, digest));
CREATE TABLE IF NOT EXISTS gc_status(
    id INTEGER PRIMARY KEY CHECK(id=1), last_sweep_at REAL NOT NULL, report TEXT NOT NULL);
"""

WORKSPACE_TREE_NAMESPACE = "workspace-tree"


class MaterialCache:
    """Process-independent cache for Provider material directories.

    Candidate 实例把正式缓存配成只读 base：查找先看自己（overlay），miss 再看 base；
    写入、inflight 和 GC 只作用于 overlay，所以实验实例不可能改动正式缓存的字节、
    目录或 catalog。base 与 overlay 必须同卷，硬链接和 clonefile 才能跨两侧工作。
    """

    def __init__(
        self,
        root: Path | None,
        *,
        ttl_seconds: int,
        base_root: Path | None = None,
        read_only: bool = False,
    ) -> None:
        self.root = root.expanduser().resolve() if root else None
        self.ttl_seconds = ttl_seconds
        self.read_only = read_only
        self.base: MaterialCache | None = None
        self.last_materialize_mode: str | None = None
        self._owned: dict[tuple[str, str], str] = {}
        if self.root is None or read_only:
            return
        (self.root / "objects").mkdir(parents=True, exist_ok=True)
        (self.root / "trees").mkdir(parents=True, exist_ok=True)
        with self._access(write=True):
            with self._connect() as db:
                db.executescript(_SCHEMA)
                columns = {row[1] for row in db.execute("PRAGMA table_info(acquisitions)")}
                if "last_accessed_at" not in columns:
                    db.execute("ALTER TABLE acquisitions ADD COLUMN last_accessed_at REAL")
                db.execute("UPDATE acquisitions SET last_accessed_at=created_at WHERE last_accessed_at IS NULL")
            self._finish_pending_gc()
        if base_root is not None:
            base = base_root.expanduser().resolve()
            if base == self.root:
                raise ValueError("material cache base root must differ from the writable root")
            # 正式实例还没产生过缓存时 base 目录不存在，当作空 base：Candidate 自己重新取材料。
            if (base / "catalog.sqlite").exists():
                self.base = MaterialCache(base, ttl_seconds=ttl_seconds, read_only=True)

    # ---------- 公开接口（与旧实现同签名） ----------

    def restore_tree(self, namespace: str, key: str, target: Path) -> bool:
        if self.root is None:
            return False
        with self._access():
            tree_sha = self._fresh_tree(namespace, key)
            if tree_sha is None:
                return False
            return self._restore(tree_sha, target)

    def restore_tree_sha(self, tree_sha: str, target: Path) -> bool:
        """按 tree_sha 物化一棵树。未知的树抛 LookupError；目标非空目录返回 False。"""
        if self.root is None:
            return False
        with self._access():
            if not self._has_tree(tree_sha):
                raise LookupError(f"unknown tree {tree_sha}")
            return self._restore(tree_sha, target)

    def _restore(self, tree_sha: str, target: Path) -> bool:
        if target.exists():
            if not target.is_dir() or any(target.iterdir()):
                return False
            target.rmdir()
        source = self._tree_path(tree_sha)
        if not source.is_dir():
            base_source = self.base._tree_path(tree_sha) if self.base is not None else None
            if base_source is not None and base_source.is_dir():
                source = base_source                # base 已有组装好的树，直接克隆，不回写它
            else:
                try:
                    self._build_tree(tree_sha)      # 缺树时在 overlay 里重建，对象可来自 base
                except (OSError, LookupError):
                    return False
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.cache.tmp")
        temporary.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.last_materialize_mode = _clone_tree(source, temporary)
            # trees/ 里是指向只读 objects/ 的硬链接，克隆出来的文件继承了 0444。
            # 克隆体是独立 inode，把扫描时记录的原始 mode 还回去，工作区才可写。
            for rel_path, _digest, mode in self._tree_entries(tree_sha):
                os.chmod(temporary / rel_path, mode)
            temporary.rename(target)
        except BaseException:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        self._touch_tree(tree_sha)
        return True

    def store_tree(self, namespace: str, key: str, source: Path, *, immutable: bool = False) -> None:
        if self.root is None:
            return
        with self._access(write=True):
            self._finish_pending_gc()
            existing = self._fresh_tree(namespace, key)
            if existing is not None:
                self._touch_tree(existing)
                return
            tree_sha, _total = self._store_entries(source, _scan(source))
            self._acquire(namespace, key, tree_sha, immutable)

    def store_tree_sha(self, source: Path, exclude: tuple[str, ...] = ()) -> tuple[str, int, int]:
        """工作区快照：按内容寻址存一棵树，返回 (tree_sha, file_count, total_bytes)。

        与 store_tree 不同，这里没有 (namespace, key) 身份，树只由内容决定；空目录
        也有确定的 tree_sha。快照以不可变 acquisition 登记，避免被 GC 当作死树回收。
        """
        if self.root is None:
            raise RuntimeError("material cache root is unset")
        with self._access(write=True):
            self._finish_pending_gc()
            entries = _scan(source, exclude)
            tree_sha, total = self._store_entries(source, entries)
            self._acquire(WORKSPACE_TREE_NAMESPACE, tree_sha, tree_sha, True)
            return tree_sha, len(entries), total

    def _store_entries(self, source: Path, entries: list[tuple[str, str, int]]) -> tuple[str, int]:
        tree_sha = _tree_sha(entries)
        now = time.time()
        total = sum((source / rel_path).stat().st_size for rel_path, _, _ in entries)
        # Local ownership keeps Workspace Snapshots valid after base cache eviction.
        with self._connect() as db:
            local = db.execute("SELECT 1 FROM trees WHERE tree_sha=?", (tree_sha,)).fetchone()
        if not local:
            for rel_path, digest, _mode in entries:
                self._put_object(source / rel_path, digest)
            with self._connect() as db:
                db.execute(
                    "INSERT OR IGNORE INTO trees(tree_sha, built_at, file_count, total_bytes) VALUES (?,?,?,?)",
                    (tree_sha, now, len(entries), total),
                )
                db.executemany(
                    "INSERT OR IGNORE INTO tree_entries(tree_sha, rel_path, sha256, mode) VALUES (?,?,?,?)",
                    [(tree_sha, rel_path, digest, mode) for rel_path, digest, mode in entries],
                )
                db.executemany(
                    "INSERT OR IGNORE INTO blobs(sha256, bytes, first_seen_at) VALUES (?,?,?)",
                    [(digest, (source / rel_path).stat().st_size, now) for rel_path, digest, _ in entries],
                )
            self._build_tree(tree_sha)
        return tree_sha, total

    def _acquire(self, namespace: str, key: str, tree_sha: str, immutable: bool) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT INTO acquisitions(namespace, key, tree_sha, immutable, created_at, last_accessed_at) "
                "VALUES (?,?,?,?,?,?) "
                "ON CONFLICT(namespace, key) DO UPDATE SET tree_sha=excluded.tree_sha, "
                "immutable=excluded.immutable, created_at=excluded.created_at, "
                "last_accessed_at=excluded.last_accessed_at",
                (namespace, key, tree_sha, 1 if immutable else 0, time.time(), time.time()),
            )

    def collect_garbage(
        self, *, dry_run: bool = False, keep_workspace_tree_shas: set[str] | None = None,
        max_idle_seconds: float | None = None, max_bytes: int | None = None, blocking: bool = True,
    ) -> dict[str, int]:
        """Evict idle/LRU downloads; only an explicit keep set may retire Workspace Snapshots.

        Exclusive cross-process access covers planning, catalog changes and physical deletion.
        Deletions are journaled before unlinking, so an interrupted sweep can finish safely.
        """
        if max_idle_seconds is not None and (not math.isfinite(max_idle_seconds) or max_idle_seconds <= 0):
            raise ValueError("max_idle_seconds must be positive")
        if max_bytes is not None and max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        report = dict.fromkeys(("expired_acquisitions", "dead_trees", "dead_blobs", "freed_bytes",
                               "evicted_by_age", "evicted_by_size", "retained_bytes", "protected_bytes",
                               "over_limit_bytes", "skipped_busy"), 0)
        if self.root is None:
            return report
        with self._access(write=not dry_run, blocking=blocking) as acquired:
            if not acquired:
                return {**report, "skipped_busy": 1}
            if not dry_run:
                self._finish_pending_gc()
            now = time.time()
            with self._connect() as db:
                columns = {row[1] for row in db.execute("PRAGMA table_info(acquisitions)")}
                accessed_column = ("COALESCE(last_accessed_at, created_at)"
                                   if "last_accessed_at" in columns else "created_at")
                rows = db.execute(
                    f"SELECT namespace, key, tree_sha, immutable, created_at, {accessed_column} FROM acquisitions"
                ).fetchall()
                inflight = {(ns, key) for ns, key, owner in db.execute(
                    "SELECT namespace, key, owner FROM inflight") if _owner_alive(owner)}
                protected = set(keep_workspace_tree_shas or ())
                removed: set[tuple[str, str]] = set()
                remaining = []
                for ns, key, tree, immutable, created, accessed in rows:
                    if (ns, key) in inflight:
                        protected.add(tree)
                    elif ns == WORKSPACE_TREE_NAMESPACE:
                        if keep_workspace_tree_shas is not None and tree not in keep_workspace_tree_shas:
                            removed.add((ns, key))
                            continue
                        protected.add(tree)
                    else:
                        expired = not immutable and now - created > self.ttl_seconds
                        idle = max_idle_seconds is not None and now - accessed > max_idle_seconds
                        if (max_idle_seconds is None and expired) or idle:
                            removed.add((ns, key))
                            report["expired_acquisitions"] += int(expired)
                            report["evicted_by_age"] += 1
                            continue
                    remaining.append((ns, key, tree, accessed))

                live_trees = {row[2] for row in remaining} | protected
                # Join instead of an unbounded IN list: large stores exceed SQLite's variable limit.
                db.execute("CREATE TEMP TABLE gc_live_trees(tree_sha TEXT PRIMARY KEY, protected INTEGER)")
                db.executemany("INSERT INTO gc_live_trees VALUES (?,?)",
                               ((tree, int(tree in protected)) for tree in live_trees))
                blob_bytes = dict(db.execute("SELECT sha256, bytes FROM blobs"))
                refs = Counter()
                for digest, count, pinned in db.execute(
                    "SELECT e.sha256, COUNT(DISTINCT e.tree_sha), MAX(t.protected) "
                    # A blob-index scan causes random table reads for every file on external disks.
                    "FROM tree_entries e NOT INDEXED JOIN gc_live_trees t USING(tree_sha) GROUP BY e.sha256"
                ):
                    refs[digest] = count
                    if pinned:
                        report["protected_bytes"] += blob_bytes[digest]
                retained = sum(blob_bytes[digest] for digest in refs)
                access: dict[str, float] = {}
                keys_by_tree: dict[str, set[tuple[str, str]]] = {}
                for ns, key, tree, accessed in remaining:
                    access[tree] = max(access.get(tree, accessed), accessed)
                    keys_by_tree.setdefault(tree, set()).add((ns, key))
                for tree in sorted(access, key=lambda tree: (access[tree], tree)):
                    if max_bytes is None or retained <= max_bytes:
                        break
                    if tree in protected:
                        continue
                    live_trees.remove(tree)
                    for digest, in db.execute("SELECT DISTINCT sha256 FROM tree_entries WHERE tree_sha=?", (tree,)):
                        refs[digest] -= 1
                        if refs[digest] == 0:
                            retained -= blob_bytes[digest]
                    keys = keys_by_tree[tree]
                    removed.update(keys)
                    report["evicted_by_size"] += len(keys)
                dead_trees = {row[0] for row in db.execute("SELECT tree_sha FROM trees")} - live_trees
                dead_blobs = {digest for digest in blob_bytes if refs[digest] == 0}
                report.update(dead_trees=len(dead_trees), dead_blobs=len(dead_blobs),
                              freed_bytes=sum(blob_bytes[digest] for digest in dead_blobs),
                              retained_bytes=retained, over_limit_bytes=max(0, retained - (max_bytes or retained)))
                if not dry_run:
                    db.executemany("INSERT OR IGNORE INTO gc_pending VALUES ('tree',?)", ((t,) for t in dead_trees))
                    db.executemany("INSERT OR IGNORE INTO gc_pending VALUES ('blob',?)", ((b,) for b in dead_blobs))
                    db.executemany("DELETE FROM acquisitions WHERE namespace=? AND key=?", sorted(removed))
                    db.executemany("DELETE FROM tree_entries WHERE tree_sha=?", ((t,) for t in dead_trees))
                    db.executemany("DELETE FROM trees WHERE tree_sha=?", ((t,) for t in dead_trees))
                    db.executemany("DELETE FROM blobs WHERE sha256=?", ((b,) for b in dead_blobs))
            if not dry_run:
                self._finish_pending_gc()
                with self._connect() as db:
                    db.execute("INSERT OR REPLACE INTO gc_status VALUES (1,?,?)", (now, json.dumps(report)))
            return report

    def gc_status(self) -> dict | None:
        if self.root is None:
            return None
        with self._connect() as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='gc_status'").fetchone():
                return None
            row = db.execute("SELECT last_sweep_at, report FROM gc_status WHERE id=1").fetchone()
        return {"last_sweep_at": row[0], "report": json.loads(row[1])} if row else None

    def _finish_pending_gc(self) -> None:
        # Call only under the writable root's exclusive lock, before admitting new stores.
        with self._connect() as db:
            pending = db.execute("SELECT kind, digest FROM gc_pending ORDER BY kind DESC").fetchall()
            for kind, digest in pending:
                if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                    raise ValueError("Invalid pending cache digest")
                if kind == "tree":
                    if not db.execute("SELECT 1 FROM trees WHERE tree_sha=?", (digest,)).fetchone():
                        path = self._tree_path(digest)
                        if path.exists():
                            shutil.rmtree(path)
                elif kind == "blob":
                    if not db.execute("SELECT 1 FROM blobs WHERE sha256=?", (digest,)).fetchone():
                        self._object_path(digest).unlink(missing_ok=True)
                else:
                    raise ValueError("Invalid pending cache object kind")
            db.executemany("DELETE FROM gc_pending WHERE kind=? AND digest=?", pending)

    @contextmanager
    def _access(self, *, write: bool = False, blocking: bool = True) -> Iterator[bool]:
        if write and self.read_only:
            raise PermissionError("Cannot modify a read-only material cache")
        roots = ([self.root] if self.root is not None else []) + ([self.base.root] if self.base else [])
        handles = []
        try:
            for root in sorted(roots):
                # Lock the directory inode: read-only bases need no lock-file mutation.
                handle = os.open(root, os.O_RDONLY)
                handles.append(handle)
                mode = fcntl.LOCK_EX if write and root == self.root else fcntl.LOCK_SH
                try:
                    fcntl.flock(handle, mode | (0 if blocking else fcntl.LOCK_NB))
                except BlockingIOError:
                    yield False
                    return
            yield True
        finally:
            for handle in reversed(handles):
                os.close(handle)

    def _touch_tree(self, tree_sha: str) -> None:
        if not self.read_only:
            with self._connect() as db:
                db.execute("UPDATE acquisitions SET last_accessed_at=? WHERE tree_sha=?", (time.time(), tree_sha))

    def begin_acquire(self, namespace: str, key: str, *, wait_seconds: float = 300.0) -> bool:
        """尝试成为这个 key 的下载者。

        返回 True 表示调用方应当执行下载；返回 False 表示已经有可用结果，调用方
        应当重新走一次 restore_tree。抢到锁之后还会再确认一次缓存（double-check），
        否则前一个持有者刚落库、后一个刚拿到锁的进程会重复下载一遍。

        等待超时会强行接管，避免一个崩溃的下载者永久堵住这个 key。
        """
        if self.root is None:
            return True
        owner = f"{os.getpid()}:{uuid.uuid4().hex[:8]}"
        deadline = time.time() + wait_seconds
        while True:
            if self._fresh_tree(namespace, key) is not None:
                return False
            acquired = False
            started_at: float | None = None
            with self._connect() as db:
                try:
                    db.execute(
                        "INSERT INTO inflight(namespace, key, owner, started_at) VALUES (?,?,?,?)",
                        (namespace, key, owner, time.time()),
                    )
                    acquired = True
                except sqlite3.IntegrityError:
                    row = db.execute(
                        "SELECT started_at FROM inflight WHERE namespace=? AND key=?", (namespace, key)
                    ).fetchone()
                    started_at = float(row[0]) if row else None
            if acquired:
                if self._fresh_tree(namespace, key) is not None:   # double-check
                    self._release(namespace, key, owner)
                    return False
                self._owned[(namespace, key)] = owner
                return True
            if started_at is None:
                continue                                            # 持有者刚释放，重试抢占
            if time.time() > deadline or time.time() - started_at > wait_seconds:
                with self._connect() as db:                         # 接管一个卡死的下载者
                    db.execute(
                        "UPDATE inflight SET owner=?, started_at=? WHERE namespace=? AND key=?",
                        (owner, time.time(), namespace, key),
                    )
                self._owned[(namespace, key)] = owner
                return True
            time.sleep(0.25)

    def end_acquire(self, namespace: str, key: str) -> None:
        """释放本进程持有的下载权。不是本进程持有的行不会被误删。"""
        owner = self._owned.pop((namespace, key), None)
        if owner is not None:
            self._release(namespace, key, owner)

    def _release(self, namespace: str, key: str, owner: str) -> None:
        if self.root is None:
            return
        with self._connect() as db:
            db.execute(
                "DELETE FROM inflight WHERE namespace=? AND key=? AND owner=?", (namespace, key, owner)
            )

    def stats(self) -> dict[str, int]:
        if self.root is None:
            return {}
        with self._connect() as db:
            blobs, blob_bytes = db.execute("SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM blobs").fetchone()
            trees, = db.execute("SELECT COUNT(*) FROM trees").fetchone()
            entries, logical = db.execute(
                "SELECT COALESCE(SUM(file_count),0), COALESCE(SUM(total_bytes),0) FROM trees"
            ).fetchone()
            acquisitions, = db.execute("SELECT COUNT(*) FROM acquisitions").fetchone()
        return {
            "blobs": blobs, "blob_bytes": blob_bytes, "trees": trees,
            "tree_entries": entries, "logical_bytes": logical, "acquisitions": acquisitions,
        }

    # ---------- 内部 ----------

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        assert self.root is not None
        path = self.root / "catalog.sqlite"
        if self.read_only:
            # mode=ro 让 base catalog 在 SQLite 这一层就不可能被写。
            db = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=30)
        else:
            db = sqlite3.connect(path, timeout=30)
        try:
            if not self.read_only:
                db.execute("PRAGMA journal_mode=WAL")
                # GC intent must be durable before any referenced filesystem object is unlinked.
                db.execute("PRAGMA synchronous=FULL")
            with db:
                yield db
        finally:
            db.close()

    def _object_path(self, digest: str) -> Path:
        assert self.root is not None
        return self.root / "objects" / digest[:2] / digest

    def _tree_path(self, tree_sha: str) -> Path:
        assert self.root is not None
        return self.root / "trees" / tree_sha[:2] / tree_sha

    def _fresh_tree(self, namespace: str, key: str) -> str | None:
        if self.root is None:
            return None
        with self._connect() as db:
            row = db.execute(
                "SELECT tree_sha, created_at, immutable FROM acquisitions WHERE namespace=? AND key=?",
                (namespace, key),
            ).fetchone()
        if row is not None:
            tree_sha, created_at, immutable = row
            # 不可变 key（内容由 commit SHA / 论文版本号唯一确定）没有陈旧的可能，
            # TTL 对它只会造成无谓的重新下载。
            if immutable or time.time() - float(created_at) <= self.ttl_seconds:
                return tree_sha
        return self.base._fresh_tree(namespace, key) if self.base is not None else None

    def _has_tree(self, tree_sha: str) -> bool:
        with self._connect() as db:
            if db.execute("SELECT 1 FROM trees WHERE tree_sha=?", (tree_sha,)).fetchone() is not None:
                return True
        return self.base is not None and self.base._has_tree(tree_sha)

    def _tree_entries(self, tree_sha: str) -> list[tuple[str, str, int]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT rel_path, sha256, mode FROM tree_entries WHERE tree_sha=? ORDER BY rel_path", (tree_sha,)
            ).fetchall()
        if rows or self.base is None:
            return rows
        return self.base._tree_entries(tree_sha)

    def _read_object_path(self, digest: str) -> Path:
        """读路径：overlay 没有这个对象时用 base 里的那一份（只读，不复制）。"""
        path = self._object_path(digest)
        if path.exists() or self.base is None:
            return path
        return self.base._object_path(digest)

    def _put_object(self, absolute: Path, digest: str) -> None:
        target = self._object_path(digest)
        if target.exists():
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{digest}.{uuid.uuid4().hex}.tmp")
        base_object = self.base._object_path(digest) if self.base else None
        if base_object is not None and base_object.exists():
            os.link(base_object, temporary)
        else:
            shutil.copyfile(absolute, temporary)
            os.chmod(temporary, 0o444)
        os.replace(temporary, target)

    def _build_tree(self, tree_sha: str) -> None:
        target = self._tree_path(tree_sha)
        if target.is_dir():
            return
        rows = self._tree_entries(tree_sha)
        if not self._has_tree(tree_sha):
            raise LookupError(f"unknown tree {tree_sha}")
        temporary = target.with_name(f".{tree_sha}.{uuid.uuid4().hex}.tmp")
        temporary.mkdir(parents=True)
        try:
            for rel_path, digest, _mode in rows:
                destination = temporary / rel_path
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.link(self._read_object_path(digest), destination)
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary.rename(target)
        except BaseException:
            shutil.rmtree(temporary, ignore_errors=True)
            if not target.is_dir():
                raise


def _scan(source: Path, exclude: tuple[str, ...] = ()) -> list[tuple[str, str, int]]:
    """exclude 是 fnmatch 模式，匹配目录名（整棵剪掉）、文件名或相对路径。"""
    def excluded(name: str, rel_path: str) -> bool:
        return any(fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(rel_path, pattern) for pattern in exclude)

    entries: list[tuple[str, str, int]] = []
    for current, directories, files in os.walk(source):
        directories[:] = sorted(
            name for name in directories
            if not excluded(name, str((Path(current) / name).relative_to(source)))
        )
        for name in sorted(files):
            absolute = Path(current) / name
            if excluded(name, str(absolute.relative_to(source))):
                continue
            if not absolute.is_file():           # 跳过断链 symlink / socket / fifo
                continue
            digest = hashlib.sha256()
            with absolute.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            entries.append((
                str(absolute.relative_to(source)),
                digest.hexdigest(),
                absolute.stat().st_mode & 0o7777,
            ))
    entries.sort(key=lambda entry: entry[0])
    return entries


def _tree_sha(entries: list[tuple[str, str, int]]) -> str:
    digest = hashlib.sha256()
    for rel_path, sha256, mode in entries:
        digest.update(f"{rel_path}\0{sha256}\0{mode}\n".encode())
    return digest.hexdigest()


def _clone_tree(source: Path, target: Path) -> str:
    """优先 clonefile；不支持的文件系统退化为全拷贝。"""
    try:
        subprocess.run(["/bin/cp", "-Rc", str(source), str(target)], check=True, capture_output=True)
        return "clone"
    except (subprocess.CalledProcessError, FileNotFoundError):
        shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(source, target, symlinks=False)
        return "copy"


def _owner_alive(owner: str) -> bool:
    try:
        pid = int(owner.split(":", 1)[0])
        if pid <= 0:
            return False
        os.kill(pid, 0)
        return True
    except (ValueError, ProcessLookupError):
        return False
    except PermissionError:
        return True
