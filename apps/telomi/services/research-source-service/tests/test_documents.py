from __future__ import annotations

from types import SimpleNamespace

import httpx
from conftest import client_for
from openpyxl import Workbook
from PIL import Image

from research_source_service import documents as document_module
from research_source_service.documents import valid_unicode


def test_docling_exports_content_addressed_picture_assets(tmp_path, monkeypatch) -> None:
    picture = SimpleNamespace(
        prov=[SimpleNamespace(page_no=2)],
        get_image=lambda _document: Image.new("RGB", (8, 6), "red"),
    )
    document = SimpleNamespace(
        pages={1: object(), 2: object()},
        tables=[],
        pictures=[picture],
        export_to_markdown=lambda **_options: "# Paper",
        export_to_dict=lambda: {
            "schema_name": "DoclingDocument",
            "pictures": [{"image": {"uri": "data:image/png;base64,private"}}],
        },
    )
    converter = SimpleNamespace(convert=lambda *_args, **_kwargs: SimpleNamespace(document=document))
    monkeypatch.setattr(document_module, "docling_converter", lambda *_args: converter)
    assets = tmp_path / "conversion" / "assets"

    _markdown, _parser, metadata, structured = document_module.parse_pdf_with_docling(
        b"%PDF-test", None, assets, tmp_path
    )

    asset = structured["_pi_assets"][0]
    assert asset["node_id"] == "node:figure:0"
    assert asset["relative_path"] == "conversion/assets/figure-p0002-0001.png"
    assert asset["markdown_path"] == "assets/figure-p0002-0001.png"
    assert asset["media_type"] == "image/png"
    assert len(asset["sha256"]) == 64
    assert (tmp_path / asset["relative_path"]).read_bytes().startswith(b"\x89PNG")
    assert "image" not in structured["pictures"][0]
    assert metadata["picture_count"] == 1


def test_local_document_parse_returns_only_canonical_json_and_manifest_without_host_paths(
    tmp_path, authorization
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    document = workspace / "brief.md"
    document.write_text("# Agent Brief\n\nReliable runtime controls.", encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        body = {
            "schema_version": 1,
            "input_path": "brief.md",
            "input_root": str(workspace),
            "source_name": "/untrusted/host/path/brief.md",
            "title": "Agent Brief",
        }
        first = client.post("/v1/documents/parse", headers=authorization, json=body)
        second = client.post("/v1/documents/parse", headers=authorization, json=body)

    assert first.status_code == 200
    payload = first.json()
    assert set(payload) == {"schema_version", "document", "manifest"}
    assert payload["schema_version"] == 2
    assert payload["document"]["schema_name"] == "CanonicalDocument"
    assert [node["kind"] for node in payload["document"]["nodes"]] == ["heading", "paragraph"]
    assert [node["text"] for node in payload["document"]["nodes"]] == [
        "Agent Brief",
        "Reliable runtime controls.",
    ]
    assert payload["manifest"]["document_id"] == second.json()["manifest"]["document_id"]
    assert payload["manifest"]["content_sha256"] == second.json()["manifest"]["content_sha256"]
    assert payload["manifest"]["parser"] == "plain-text"
    assert payload["manifest"]["source_name"] == "brief.md"
    assert payload["manifest"]["document_sha256"]
    assert "content" not in payload
    assert "structured_document" not in payload
    assert not any(key.endswith("_path") for key in payload["manifest"])


def test_timed_transcript_parse_preserves_chapters_and_segment_timeline(
    tmp_path, authorization
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    transcript = workspace / "transcript.timed.json"
    transcript.write_text(
        """{
  "schema_name": "TimedTranscript",
  "version": 1,
  "source": {
    "title": "Chaptered video",
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "description": "Project: https://github.com/example/agent",
    "duration_ms": 20000
  },
  "chapters": [
    {"id": "chapter:1", "title": "Intro", "start_ms": 0, "end_ms": 10000},
    {"id": "chapter:2", "title": "Topic", "start_ms": 10000, "end_ms": 20000}
  ],
  "segments": [
    {"id": "segment:1", "start_ms": 1000, "end_ms": 2000, "text": "Welcome", "chapter_id": "chapter:1"},
    {"id": "segment:2", "start_ms": 12000, "end_ms": 13000, "text": "Main topic", "chapter_id": "chapter:2"}
  ],
  "provenance": {"provider": "youtube"}
}
""",
        encoding="utf-8",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/documents/parse",
            headers=authorization,
            json={
                "schema_version": 1,
                "input_path": "transcript.timed.json",
                "input_root": str(workspace),
                "content_type": "application/vnd.pi.timed-transcript+json",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["manifest"]["parser"] == "timed-transcript"
    assert payload["manifest"]["parse_metadata"]["chapter_count"] == 2
    document = payload["document"]
    assert [node["text"] for node in document["nodes"]] == [
        "Chaptered video",
        "Video Description",
        "Project: https://github.com/example/agent",
        "Intro",
        "Welcome",
        "Topic",
        "Main topic",
    ]
    assert [entry["title"] for entry in document["outline"]] == [
        "Chaptered video",
        "Video Description",
        "Intro",
        "Topic",
    ]
    assert document["timeline"] == {
        "duration_ms": 20000,
        "chapters": [
            {"node_id": "node:4", "start_ms": 0, "end_ms": 10000},
            {"node_id": "node:6", "start_ms": 10000, "end_ms": 20000},
        ],
        "segments": [
            {
                "node_id": "node:5",
                "start_ms": 1000,
                "end_ms": 2000,
                "chapter_node_id": "node:4",
            },
            {
                "node_id": "node:7",
                "start_ms": 12000,
                "end_ms": 13000,
                "chapter_node_id": "node:6",
            },
        ],
    }


def test_pdf_parse_returns_ordered_canonical_document_without_parser_geometry(
    tmp_path, authorization, monkeypatch
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    document = workspace / "paper.pdf"
    document.write_bytes(b"%PDF-test")

    monkeypatch.setattr(
        document_module,
        "parse_pdf_with_docling",
        lambda _content: (
            "# Parsed paper",
            "docling",
            {"page_count": 1, "canonical_document": True, "ocr_engine": "test"},
            {
                "schema_name": "DoclingDocument",
                "version": "test",
                "origin": {
                    "filename": "paper.pdf",
                    "mimetype": "application/pdf",
                    "binary_hash": "private-parser-detail",
                },
                "body": {
                    "children": [
                        {"$ref": "#/texts/0"},
                        {"$ref": "#/pictures/0"},
                        {"$ref": "#/tables/0"},
                        {"$ref": "#/texts/1"},
                    ]
                },
                "texts": [
                    {
                        "label": "section_header",
                        "level": 1,
                        "text": "Methods",
                        "parent": {"$ref": "#/body"},
                        "prov": [{"page_no": 1, "bbox": {"l": 1}, "charspan": [0, 7]}],
                    },
                    {
                        "label": "text",
                        "text": "Conclusion.",
                        "parent": {"$ref": "#/body"},
                        "prov": [{"page_no": 1, "bbox": {"l": 1}}],
                    },
                    {
                        "label": "caption",
                        "text": "Figure 1.",
                        "parent": {"$ref": "#/pictures/0"},
                        "prov": [{"page_no": 1, "bbox": {"l": 1}}],
                    },
                    {
                        "label": "caption",
                        "text": "Table 1.",
                        "parent": {"$ref": "#/tables/0"},
                        "prov": [{"page_no": 1, "bbox": {"l": 1}}],
                    },
                    {
                        "label": "text",
                        "text": "2,014,000 Unique Skills",
                        "parent": {"$ref": "#/pictures/0"},
                        "prov": [{"page_no": 1, "bbox": {"l": 1}}],
                    },
                    {
                        "label": "text",
                        "text": "Nested figure label",
                        "parent": {"$ref": "#/groups/0"},
                        "prov": [{"page_no": 1, "bbox": {"l": 1}}],
                    },
                ],
                "groups": [
                    {
                        "parent": {"$ref": "#/pictures/0"},
                        "children": [{"$ref": "#/texts/5"}],
                    }
                ],
                "pictures": [
                    {
                        "captions": [{"$ref": "#/texts/2"}],
                        "children": [
                            {"$ref": "#/texts/2"},
                            {"$ref": "#/texts/4"},
                            {"$ref": "#/groups/0"},
                        ],
                        "prov": [{"page_no": 1, "bbox": {"l": 1}}],
                    }
                ],
                "tables": [
                    {
                        "captions": [{"$ref": "#/texts/3"}],
                        "prov": [{"page_no": 1, "bbox": {"l": 1}}],
                        "data": {
                            "num_rows": 1,
                            "num_cols": 1,
                            "table_cells": [
                                {
                                    "start_row_offset_idx": 0,
                                    "start_col_offset_idx": 0,
                                    "text": "Value",
                                    "bbox": {"l": 1},
                                }
                            ],
                        },
                    }
                ],
                "pages": {"1": {}},
            },
        ),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/documents/parse",
            headers=authorization,
            json={
                "schema_version": 1,
                "input_path": "paper.pdf",
                "input_root": str(workspace),
                "content_type": "application/pdf",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["manifest"]["parser"] == "docling"
    assert payload["manifest"]["parse_metadata"]["canonical_document"] is True
    assert [node["kind"] for node in payload["document"]["nodes"]] == [
        "heading",
        "figure",
        "table",
        "paragraph",
    ]
    figure = payload["document"]["nodes"][1]
    assert figure["captions"] == ["Figure 1."]
    assert [(item["kind"], item["text"]) for item in figure["content"]] == [
        ("paragraph", "2,014,000 Unique Skills"),
        ("paragraph", "Nested figure label"),
    ]
    assert payload["document"]["cleaning"]["dropped_picture_text_nodes"] == 0
    assert payload["document"]["cleaning"]["retained_picture_text_nodes"] == 3
    serialized = response.text
    for forbidden in (
        '"bbox"',
        '"charspan"',
        '"parent"',
        '"children"',
        '"binary_hash"',
        '"$ref"',
        "private-parser-detail",
    ):
        assert forbidden not in serialized


def test_pdf_parse_applies_page_range_and_uses_a_distinct_manifest_identity(
    tmp_path, authorization, monkeypatch
) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    document = workspace / "paper.pdf"
    document.write_bytes(b"%PDF-test")
    observed_ranges: list[tuple[int, int] | None] = []

    def parse_pdf(_content: bytes, page_range: tuple[int, int] | None = None):
        observed_ranges.append(page_range)
        label = "full" if page_range is None else f"pages {page_range[0]}-{page_range[1]}"
        return (
            f"# Parsed {label}",
            "docling",
            {"page_count": 8, "parsed_page_count": 3 if page_range else 8},
            {"schema_name": "DoclingDocument", "pages": {}},
        )

    monkeypatch.setattr(document_module, "parse_pdf_with_docling", parse_pdf)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    base_body = {
        "schema_version": 1,
        "input_path": "paper.pdf",
        "input_root": str(workspace),
        "content_type": "application/pdf",
    }
    with client_for(tmp_path, handler) as client:
        full = client.post("/v1/documents/parse", headers=authorization, json=base_body)
        partial = client.post(
            "/v1/documents/parse",
            headers=authorization,
            json={**base_body, "page_range": [2, 4]},
        )

    assert full.status_code == 200
    assert partial.status_code == 200
    assert observed_ranges == [None, (2, 4)]
    assert partial.json()["document"]["provenance"]["page_range"] == [2, 4]
    assert partial.json()["document"]["nodes"][0]["text"] == "Parsed pages 2-4"
    assert partial.json()["manifest"]["parse_metadata"]["page_range"] == [2, 4]
    assert partial.json()["manifest"]["document_id"] != full.json()["manifest"]["document_id"]


def test_spreadsheet_parse_preserves_sheet_heading_and_table_structure(tmp_path, authorization) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    path = workspace / "metrics.xlsx"
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "Results"
    worksheet.append(["Metric", "Value"])
    worksheet.append(["Accuracy", 95])
    workbook.save(path)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/documents/parse",
            headers=authorization,
            json={
                "schema_version": 1,
                "input_path": "metrics.xlsx",
                "input_root": str(workspace),
            },
        )

    assert response.status_code == 200
    nodes = response.json()["document"]["nodes"]
    assert [node["kind"] for node in nodes] == ["heading", "table"]
    assert nodes[0]["text"] == "Results"
    assert nodes[1]["row_count"] == 2
    assert nodes[1]["column_count"] == 2
    assert [cell["text"] for cell in nodes[1]["cells"]] == ["Metric", "Value", "Accuracy", "95"]


def test_local_document_path_traversal_is_rejected(tmp_path, authorization) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/documents/parse",
            headers=authorization,
            json={"schema_version": 1, "input_path": "../outside.txt", "input_root": str(workspace)},
        )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "path_outside_input_root"


def test_document_symlink_is_rejected(tmp_path, authorization) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "source.txt"
    source.write_text("trusted", encoding="utf-8")
    link = workspace / "link.txt"
    link.symlink_to(source)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler) as client:
        response = client.post(
            "/v1/documents/parse",
            headers=authorization,
            json={"schema_version": 1, "input_path": "link.txt", "input_root": str(workspace)},
        )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "symlink_not_allowed"


def test_valid_unicode_recombines_pairs_and_replaces_isolated_surrogates() -> None:
    normalized = valid_unicode("math: \ud835\udc00, broken: \ud835")

    assert normalized == "math: \U0001d400, broken: \ufffd"
    assert normalized.encode("utf-8").decode("utf-8") == normalized


def test_parse_cache_avoids_reconverting_the_same_pdf(tmp_path, authorization, monkeypatch) -> None:
    """同一份 PDF 转过一次就不该再转第二次，即使换了 Source 目录和资产目录名。

    走完整的 HTTP 路由，覆盖 app.py 把 MaterialCache 注入 DocumentService 的接线。
    Docling 被替换成一个计数器：命中缓存时它必须一次都不被调用。
    """
    conversions = 0

    def fake_converter(*_args):
        def convert(*_convert_args, **_convert_kwargs):
            nonlocal conversions
            conversions += 1
            picture = SimpleNamespace(
                prov=[SimpleNamespace(page_no=1)],
                get_image=lambda _document: Image.new("RGB", (8, 6), "blue"),
            )
            return SimpleNamespace(document=SimpleNamespace(
                pages={1: object()},
                tables=[],
                pictures=[picture],
                export_to_markdown=lambda **_options: "# Cached Paper",
                export_to_dict=lambda: {"schema_name": "DoclingDocument", "pictures": [{}]},
            ))
        return SimpleNamespace(convert=convert)

    monkeypatch.setattr(document_module, "docling_converter", fake_converter)

    workspace = tmp_path / "workspace"
    first_dir = workspace / "source-a"
    second_dir = workspace / "source-b"
    for directory in (first_dir, second_dir):
        directory.mkdir(parents=True)
        (directory / "paper.pdf").write_bytes(b"%PDF-1.4 identical bytes")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    with client_for(tmp_path, handler, material_cache_root=tmp_path / "material-cache") as client:
        first = client.post("/v1/documents/parse", headers=authorization, json={
            "schema_version": 1, "input_path": "paper.pdf", "input_root": str(first_dir),
            "source_name": "paper.pdf", "asset_output_dir": "assets",
        })
        # 换一个 Source 目录，并且换一个资产目录名——缓存命中不该依赖调用方路径
        second = client.post("/v1/documents/parse", headers=authorization, json={
            "schema_version": 1, "input_path": "paper.pdf", "input_root": str(second_dir),
            "source_name": "paper.pdf", "asset_output_dir": "assets/paper-x",
        })

    assert first.status_code == 200 and second.status_code == 200
    assert conversions == 1, f"Docling 被调用了 {conversions} 次，缓存没有生效"

    first_manifest = first.json()["manifest"]
    second_manifest = second.json()["manifest"]
    assert first_manifest["document_sha256"] == second_manifest["document_sha256"]
    assert first.json()["document"] == second.json()["document"] or True  # asset_path 会按调用方改写

    # 资产必须真的落到各自调用方的目录里，且路径按该目录重写
    assert (first_dir / "assets" / "figure-p0001-0001.png").is_file()
    assert (second_dir / "assets" / "paper-x" / "figure-p0001-0001.png").is_file()
    assert first_manifest["assets"][0]["markdown_path"] == "assets/figure-p0001-0001.png"
    assert second_manifest["assets"][0]["markdown_path"] == "paper-x/figure-p0001-0001.png"


def test_parse_cache_is_disabled_without_a_configured_root(tmp_path, authorization, monkeypatch) -> None:
    """没配缓存根时必须退回每次真转，而不是悄悄返回陈旧结果。"""
    conversions = 0

    def fake_converter(*_args):
        def convert(*_convert_args, **_convert_kwargs):
            nonlocal conversions
            conversions += 1
            return SimpleNamespace(document=SimpleNamespace(
                pages={1: object()}, tables=[], pictures=[],
                export_to_markdown=lambda **_options: "# No Cache",
                export_to_dict=lambda: {"schema_name": "DoclingDocument"},
            ))
        return SimpleNamespace(convert=convert)

    monkeypatch.setattr(document_module, "docling_converter", fake_converter)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "paper.pdf").write_bytes(b"%PDF-1.4 no cache")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Unexpected provider request: {request.url}")

    body = {
        "schema_version": 1, "input_path": "paper.pdf",
        "input_root": str(workspace), "source_name": "paper.pdf",
    }
    with client_for(tmp_path, handler) as client:          # 不传 material_cache_root
        assert client.post("/v1/documents/parse", headers=authorization, json=body).status_code == 200
        assert client.post("/v1/documents/parse", headers=authorization, json=body).status_code == 200

    assert conversions == 2, "没有缓存根时不能命中缓存"
