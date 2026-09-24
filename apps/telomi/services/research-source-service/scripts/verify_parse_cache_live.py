"""真实 PDF 转两次：第二次必须命中缓存，且资产路径按调用方目录正确重写。

这是真跑 Docling 的验证（第一次约一分钟，会下载真实论文），不是单元测试。
故意用两个不同的 source 目录和不同的资产目录名，确认缓存命中不依赖调用方路径。

    services/research-source-service/.venv/bin/python \
        services/research-source-service/scripts/verify_parse_cache_live.py
"""
import asyncio, hashlib, json, shutil, sys, time, urllib.request
from pathlib import Path
sys.path.insert(0, 'src')
from research_source_service.documents import DocumentService, PARSE_CACHE_NAMESPACE
from research_source_service.material_cache import MaterialCache
from research_source_service.models import DocumentParseRequest

import os
ARENA = Path(os.environ.get("PARSE_CACHE_TEST_ROOT", "/tmp/pi-parse-cache-test")); shutil.rmtree(ARENA, ignore_errors=True)
ARENA.mkdir(parents=True)
PDF = ARENA / "paper.pdf"
url = "https://arxiv.org/pdf/2504.18425v1"
print(f"下载真实论文 {url}")
req = urllib.request.Request(url, headers={"user-agent": "telomi-parse-cache-test"})
PDF.write_bytes(urllib.request.urlopen(req, timeout=120).read())
print(f"  {PDF.stat().st_size/1024/1024:.1f} MB  sha256={hashlib.sha256(PDF.read_bytes()).hexdigest()[:12]}")

cache = MaterialCache(ARENA / "cache", ttl_seconds=86400)
service = DocumentService(allowed_workspace_roots=(ARENA,), max_bytes=200*1024*1024,
                          max_concurrency=1, material_cache=cache)

async def run(label, workdir_name, asset_dir):
    """模拟两个不同的 source 目录取用同一份 PDF。"""
    work = ARENA / workdir_name; work.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(PDF, work / "paper.pdf")
    t = time.time()
    resp = await service.parse(DocumentParseRequest(
        input_path="paper.pdf", input_root=str(work), source_name="paper.pdf",
        asset_output_dir=asset_dir))
    ms = int((time.time()-t)*1000)
    assets = resp.manifest.assets
    files = sorted(p.name for p in (work/asset_dir).glob("*.png")) if (work/asset_dir).is_dir() else []
    print(f"  {label:<14} {ms:>7} ms   资产 {len(assets)} 条 / 磁盘 {len(files)} 个   "
          f"markdown_path 样例 = {assets[0]['markdown_path'] if assets else '-'}")
    return resp, ms, files

async def main():
    print("\n== 第一次（冷缓存，真跑 Docling）==")
    r1, ms1, f1 = await run("run-1", "source-a", "assets")
    print("\n== 第二次：不同 source 目录、不同资产目录名 ==")
    r2, ms2, f2 = await run("run-2", "source-b", "assets/paper-x")
    print(f"\n  缓存条目数: {cache.stats()['acquisitions']}  (命名空间 {PARSE_CACHE_NAMESPACE})")
    print(f"  提速: {ms1}ms -> {ms2}ms  ({ms1/max(1,ms2):.0f}x)")
    same_doc = r1.manifest.document_sha256 == r2.manifest.document_sha256
    print(f"  document_sha256 一致: {same_doc}")
    print(f"  资产文件数一致: {len(f1) == len(f2)} ({len(f1)} vs {len(f2)})")
    ok_path = all(a["markdown_path"].startswith("paper-x/") for a in r2.manifest.assets) if r2.manifest.assets else True
    print(f"  第二次的 markdown_path 按调用方目录重写: {ok_path}")
    shutil.rmtree(ARENA, ignore_errors=True)

asyncio.run(main())
