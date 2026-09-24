#!/usr/bin/env python3
"""回收 Research 存储：素材缓存里不再被引用的树与对象，以及运行库里的空闲页。

默认只做 dry-run，加 --apply 才真正删除。

默认只回收下载缓存。显式 --prune-workspace-snapshots 才按引用删除 Workspace 快照，
该操作必须在产品与评估服务停止、没有 Run 正在发布引用时执行。

缓存根的解析顺序与 TypeScript 侧 resolveAutostartMaterialCacheRoot 保持一致：
    SOURCE_SERVICE_MATERIAL_CACHE_ROOT
    $TELOMI_DATA_DIR/.pi/runtime/research-source-service/material-cache
"""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from research_source_service.material_cache import MaterialCache

TREE_REF = re.compile(r'"(?:input|output)_tree_sha"\s*:\s*"([0-9a-f]{64})"')


def resolve_root() -> Path:
    configured = os.environ.get("SOURCE_SERVICE_MATERIAL_CACHE_ROOT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    data_dir = os.environ.get("TELOMI_DATA_DIR", "").strip()
    if not data_dir:
        raise SystemExit(
            "既没有 SOURCE_SERVICE_MATERIAL_CACHE_ROOT 也没有 TELOMI_DATA_DIR，无法定位缓存根"
        )
    return Path(data_dir).expanduser().resolve() / ".pi" / "runtime" / "research-source-service" / "material-cache"


def mb(value: int) -> str:
    return f"{value / 1024 / 1024:.1f} MB"


def runtime_databases() -> list[Path]:
    """Provider 运行库。它们自带 TTL 清理，但 SQLite 删行只把页放进 freelist，
    不会缩小文件——一个只剩几百行缓存的库仍然可以是一百多 MB。"""
    data_dir = os.environ.get("TELOMI_DATA_DIR", "").strip()
    if not data_dir:
        return []
    root = Path(data_dir).expanduser().resolve() / ".pi" / "runtime" / "research-sources"
    return sorted(root.glob("*.sqlite3")) if root.is_dir() else []


def referenced_workspace_tree_shas(cache_root: Path | None = None) -> set[str] | None:
    """Workspace trees still named by product Runs or retained Evaluation Cases."""
    configured = os.environ.get("TELOMI_DATA_DIR", "").strip()
    if not configured:
        return None
    data_dir = Path(configured).expanduser().resolve()
    if not data_dir.is_dir():
        return None
    refs: set[str] = set()
    errors: list[OSError] = []
    for directory, children, files in os.walk(data_dir, onerror=errors.append):
        parent = Path(directory)
        children[:] = [name for name in children if cache_root is None or parent / name != cache_root]
        for name in files:
            if name != "manifest.json" and not (name.startswith("runtime--") and name.endswith(".jsonl")):
                continue
            try:
                refs.update(TREE_REF.findall((parent / name).read_text(encoding="utf-8")))
            except (OSError, UnicodeError):
                return None
    return None if errors else refs


def vacuum_runtime_databases(databases: list[Path], *, apply: bool) -> None:
    if not databases:
        return
    print()
    for database in databases:
        try:
            with sqlite3.connect(database) as db:
                pages = db.execute("PRAGMA page_count").fetchone()[0]
                free = db.execute("PRAGMA freelist_count").fetchone()[0]
                page_size = db.execute("PRAGMA page_size").fetchone()[0]
        except sqlite3.Error as error:
            print(f"{database.name:<26} 读取失败：{error}")
            continue
        ratio = 100 * free / max(1, pages)
        reclaimable = free * page_size
        print(f"{database.name:<26} {mb(pages * page_size):>10}  空闲页 {ratio:5.1f}%  可回收 {mb(reclaimable)}")
        if not apply or ratio < 10:
            continue
        try:
            # VACUUM 需要独占锁；有进程正在写时会 SQLITE_BUSY 而不是损坏文件。
            with sqlite3.connect(database, timeout=5) as db:
                db.execute("VACUUM")
            print(f"{'':<26} VACUUM 后 {mb(database.stat().st_size)}")
        except sqlite3.Error as error:
            print(f"{'':<26} VACUUM 跳过（可能有进程正在使用）：{error}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="真正执行删除（默认只报告）")
    parser.add_argument("--ttl-seconds", type=int,
                        default=os.environ.get("SOURCE_SERVICE_MATERIAL_CACHE_TTL_SECONDS", 86400))
    parser.add_argument("--retention-seconds", type=int,
                        default=os.environ.get("SOURCE_SERVICE_MATERIAL_CACHE_RETENTION_SECONDS", 30 * 86400))
    parser.add_argument("--max-bytes", type=int,
                        default=os.environ.get("SOURCE_SERVICE_MATERIAL_CACHE_MAX_BYTES", 50 * 1024 ** 3))
    parser.add_argument("--prune-workspace-snapshots", action="store_true",
                        help="仅在服务停止后使用，按 TELOMI_DATA_DIR 下完整引用集合清理快照")
    args = parser.parse_args()
    if min(args.ttl_seconds, args.retention_seconds, args.max_bytes) <= 0:
        parser.error("Cache time and capacity limits must be positive")

    root = resolve_root()
    databases = runtime_databases()
    keep_tree_shas = referenced_workspace_tree_shas(root) if args.prune_workspace_snapshots else None
    if args.prune_workspace_snapshots and keep_tree_shas is None:
        parser.error("Workspace references are unavailable or unreadable; refusing to prune snapshots")

    if not (root / "catalog.sqlite").is_file():
        print(f"缓存根尚未初始化（还没有 catalog.sqlite）: {root}")
        vacuum_runtime_databases(databases, apply=args.apply)
        return 0

    cache = MaterialCache(root, ttl_seconds=args.ttl_seconds, read_only=not args.apply)
    before = cache.stats()
    print(f"缓存根            {root}")
    print(f"回收前            对象 {before['blobs']} 个 / {mb(before['blob_bytes'])}, "
          f"树 {before['trees']} 棵, acquisition {before['acquisitions']} 条")

    plan = cache.collect_garbage(
        dry_run=not args.apply,
        keep_workspace_tree_shas=keep_tree_shas,
        max_idle_seconds=args.retention_seconds,
        max_bytes=args.max_bytes,
    )
    print(f"保留引用          {len(keep_tree_shas) if keep_tree_shas is not None else '全部'} Workspace Trees")
    print(f"{'将回收' if not args.apply else '已回收'}            "
          f"过期 acquisition {plan['expired_acquisitions']} 条, 树 {plan['dead_trees']} 棵, "
          f"对象 {plan['dead_blobs']} 个 / {mb(plan['freed_bytes'])}")
    print(f"淘汰原因          闲置 {plan['evicted_by_age']} 条，容量 {plan['evicted_by_size']} 条")
    if plan["over_limit_bytes"]:
        print(f"保护优先          仍超过容量目标 {mb(plan['over_limit_bytes'])}，保留已引用快照")

    vacuum_runtime_databases(databases, apply=args.apply)

    if args.apply:
        after = cache.stats()
        print(f"回收后            对象 {after['blobs']} 个 / {mb(after['blob_bytes'])}, "
              f"树 {after['trees']} 棵, acquisition {after['acquisitions']} 条")
    else:
        print("\n（这是 dry-run，加 --apply 才会真正删除）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
