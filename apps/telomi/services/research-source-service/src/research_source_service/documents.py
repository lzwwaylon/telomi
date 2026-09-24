from __future__ import annotations

import asyncio
import hashlib
import io
import json
import mimetypes
import shutil
import tempfile
import threading
from pathlib import Path

from bs4 import BeautifulSoup
from docx import Document
from markdownify import markdownify
from openpyxl import load_workbook
from pptx import Presentation

from .canonical_documents import (
    canonical_document_from_parser_output,
    canonical_document_has_content,
    canonical_document_sha256,
)
from .errors import ServiceError
from .material_cache import MaterialCache
from .models import DocumentManifest, DocumentParseRequest, DocumentParseResponse
from .scheduling import ProviderGate
from .security import safe_local_file, safe_output_dir, safe_workspace_dir

PARSER_VERSION = "python-document-parser-v6-source-assets"
TIMED_TRANSCRIPT_CONTENT_TYPE = "application/vnd.pi.timed-transcript+json"
# docling imports torch at module load (~400 MB); import lazily so the idle service stays small.
_DOCLING_CONVERTERS: dict[bool, object] = {}
_DOCLING_OCR_ENGINE = "uninitialized"
_DOCLING_LOCK = threading.Lock()


# 命名空间带上解析器版本：版本一变，旧的解析产物自然不再命中。
PARSE_CACHE_NAMESPACE = f"document-parse:{PARSER_VERSION}"


def _parse_cache_key(
    *,
    content_sha256: str,
    content_type: str,
    source_name: str,
    page_range: tuple[int, int] | None,
    wants_assets: bool,
) -> str:
    """解析身份。服务本来就用同一组字段算 document_id，只是算在了干完活之后。

    wants_assets 必须进键：Docling 在需要资产时走的是另一套 converter 配置，
    两者产出的 structured_document 不同。
    """
    return hashlib.sha256(
        json.dumps(
            {
                "parser_version": PARSER_VERSION,
                "content_sha256": content_sha256,
                "content_type": content_type,
                "suffix": Path(source_name).suffix.lower(),
                "page_range": list(page_range) if page_range else None,
                "wants_assets": wants_assets,
            },
            sort_keys=True,
        ).encode()
    ).hexdigest()


class DocumentService:
    def __init__(
        self,
        *,
        allowed_workspace_roots: tuple[Path, ...],
        max_bytes: int,
        max_concurrency: int,
        material_cache: MaterialCache | None = None,
    ) -> None:
        self.allowed_workspace_roots = allowed_workspace_roots
        self.max_bytes = max_bytes
        self.gate = ProviderGate(max_concurrency)
        self.material_cache = material_cache

    # ---------- 解析产物缓存 ----------
    #
    # 缓存的是一棵树：response.json 加归一化到 assets/ 下的资产文件。资产的
    # markdown_path 与 relative_path 都带着调用方的目录名，所以存的时候剥掉、
    # 取的时候按当前调用方重新拼，两个不同 source 目录才能命中同一份缓存。

    def _restore_parsed(
        self,
        cache_key: str,
        asset_output_dir: Path | None,
        input_root: Path,
    ) -> tuple[DocumentParseResponse, str] | None:
        if self.material_cache is None:
            return None
        with tempfile.TemporaryDirectory(prefix="telomi-parse-cache-") as directory:
            target = Path(directory) / "entry"
            if not self.material_cache.restore_tree(PARSE_CACHE_NAMESPACE, cache_key, target):
                return None
            try:
                payload = json.loads((target / "response.json").read_text(encoding="utf-8"))
                markdown = (target / "markdown.md").read_text(encoding="utf-8")
            except (OSError, ValueError):
                return None
            response = DocumentParseResponse.model_validate(payload)
            if asset_output_dir is not None:
                self._place_assets(target / "assets", response, asset_output_dir, input_root)
            return response, markdown

    def _store_parsed(
        self,
        cache_key: str,
        response: DocumentParseResponse,
        markdown: str,
        asset_output_dir: Path | None,
    ) -> None:
        if self.material_cache is None:
            return
        try:
            with tempfile.TemporaryDirectory(prefix="telomi-parse-store-") as directory:
                entry = Path(directory) / "entry"
                (entry / "assets").mkdir(parents=True)
                normalized = response.model_copy(deep=True)
                for asset in normalized.manifest.assets:
                    name = Path(str(asset["markdown_path"])).name
                    if asset_output_dir is not None:
                        source = asset_output_dir / name
                        if source.is_file():
                            shutil.copyfile(source, entry / "assets" / name)
                    asset["markdown_path"] = name          # 归一化：去掉调用方目录名
                    asset.pop("relative_path", None)
                entry.joinpath("response.json").write_text(
                    normalized.model_dump_json(), encoding="utf-8"
                )
                entry.joinpath("markdown.md").write_text(markdown, encoding="utf-8")
                # 内容摘要 + 解析器版本唯一确定输出，所以是不可变键，不受 TTL 约束。
                self.material_cache.store_tree(PARSE_CACHE_NAMESPACE, cache_key, entry, immutable=True)
        except (OSError, ValueError):
            return                                          # 缓存写失败不该让解析失败

    @staticmethod
    def _place_assets(
        cached_assets: Path,
        response: DocumentParseResponse,
        asset_output_dir: Path,
        input_root: Path,
    ) -> None:
        asset_output_dir.mkdir(parents=True, exist_ok=True)
        for asset in response.manifest.assets:
            name = Path(str(asset["markdown_path"])).name
            source = cached_assets / name
            target = asset_output_dir / name
            if source.is_file():
                shutil.copyfile(source, target)
            asset["markdown_path"] = f"{asset_output_dir.name}/{name}"
            asset["relative_path"] = target.relative_to(input_root).as_posix()
        paths = {asset["node_id"]: asset["markdown_path"] for asset in response.manifest.assets}
        for node in response.document.get("nodes", []):
            if isinstance(node, dict) and node.get("id") in paths:
                node["asset_path"] = paths[node["id"]]

    async def parse(self, request: DocumentParseRequest) -> DocumentParseResponse:
        response, _markdown = await self.parse_with_markdown(request)
        return response

    async def parse_with_markdown(self, request: DocumentParseRequest) -> tuple[DocumentParseResponse, str]:
        return await self.gate.run(lambda: self._parse_with_markdown(request))

    async def _parse_with_markdown(self, request: DocumentParseRequest) -> tuple[DocumentParseResponse, str]:
        input_root = safe_workspace_dir(request.input_root, self.allowed_workspace_roots)
        path = safe_local_file(request.input_path, input_root)
        size = path.stat().st_size
        if size > self.max_bytes:
            raise ServiceError("document_too_large", "Document exceeds the configured size limit", status_code=413)
        content = await asyncio.to_thread(path.read_bytes)
        requested_name = Path(request.source_name).name.strip() if request.source_name else ""
        source_name = requested_name or path.name
        content_type = normalize_content_type(request.content_type or mimetypes.guess_type(source_name)[0])
        asset_output_dir = safe_output_dir(request.asset_output_dir, input_root) if request.asset_output_dir else None
        content_sha256 = hashlib.sha256(content).hexdigest()

        # 解析产物完全由 (解析器版本, 内容摘要, 类型, 页范围, 是否要资产) 决定，
        # 所以同一份 PDF 转过一次就不该再转第二次。注意资产落在调用方目录里，
        # 缓存树用归一化的 assets/ 存放，命中时再按调用方的目录改写路径。
        cache_key = _parse_cache_key(
            content_sha256=content_sha256,
            content_type=content_type,
            source_name=source_name,
            page_range=request.page_range,
            wants_assets=asset_output_dir is not None,
        )
        cached = self._restore_parsed(cache_key, asset_output_dir, input_root)
        if cached is not None:
            return cached

        markdown, parser, parse_metadata, structured_document = await asyncio.to_thread(
            parse_content,
            content,
            source_name,
            content_type,
            request.page_range,
            asset_output_dir,
            input_root,
        )
        assets = structured_document.pop("_pi_assets", []) if structured_document else []
        markdown = valid_unicode(markdown)
        document = canonical_document_from_parser_output(
            markdown=markdown,
            structured_document=structured_document,
            source_name=source_name,
            content_type=content_type,
            parser=parser,
            content_sha256=content_sha256,
            page_range=request.page_range,
        )
        asset_paths = {asset["node_id"]: asset["markdown_path"] for asset in assets}
        for node in document.get("nodes", []):
            if isinstance(node, dict) and node.get("id") in asset_paths:
                node["asset_path"] = asset_paths[node["id"]]
        if not canonical_document_has_content(document):
            raise ServiceError(
                "empty_document", "Document parser produced no text", status_code=422, provider="document"
            )
        document_sha256 = canonical_document_sha256(document)
        document_id = (
            "doc_"
            + hashlib.sha256(
                json.dumps(
                    {
                        "parser_version": PARSER_VERSION,
                        "content_sha256": content_sha256,
                        "content_type": content_type,
                        "suffix": Path(source_name).suffix.lower(),
                        "page_range": request.page_range,
                    },
                    sort_keys=True,
                ).encode()
            ).hexdigest()[:32]
        )
        response = DocumentParseResponse(
            document=document,
            manifest=DocumentManifest(
                document_id=document_id,
                content_sha256=content_sha256,
                document_sha256=document_sha256,
                parser=parser,
                content_type=content_type,
                source_name=source_name,
                title=request.title,
                parse_metadata={
                    "parser_version": PARSER_VERSION,
                    "input_bytes": size,
                    **({"page_range": list(request.page_range)} if request.page_range else {}),
                    **parse_metadata,
                },
                assets=assets,
            ),
        )
        self._store_parsed(cache_key, response, markdown, asset_output_dir)
        return response, markdown


def parse_content(
    content: bytes,
    source_name: str,
    content_type: str | None,
    page_range: tuple[int, int] | None = None,
    asset_output_dir: Path | None = None,
    input_root: Path | None = None,
) -> tuple[str, str, dict[str, object], dict[str, object] | None]:
    suffix = Path(source_name).suffix.lower()
    if content_type == "application/pdf" or suffix == ".pdf":
        if asset_output_dir is not None and input_root is not None:
            return parse_pdf_with_docling(content, page_range, asset_output_dir, input_root)
        return parse_pdf_with_docling(content, page_range) if page_range else parse_pdf_with_docling(content)
    if page_range is not None:
        raise ServiceError(
            "page_range_unsupported",
            "page_range is supported only for PDF documents",
            status_code=422,
            provider="document",
        )
    if content_type == TIMED_TRANSCRIPT_CONTENT_TYPE:
        return parse_timed_transcript(content)
    if content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" or suffix == ".docx":
        document = Document(io.BytesIO(content))
        lines = [paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip()]
        for table in document.tables:
            lines.extend(markdown_table([[cell.text.strip() for cell in row.cells] for row in table.rows]))
        return (
            "\n\n".join(lines),
            "python-docx",
            {
                "paragraph_count": len(document.paragraphs),
                "table_count": len(document.tables),
            },
            None,
        )
    if content_type == "application/vnd.openxmlformats-officedocument.presentationml.presentation" or suffix == ".pptx":
        presentation = Presentation(io.BytesIO(content))
        sections: list[str] = []
        for index, slide in enumerate(presentation.slides, 1):
            text = [shape.text.strip() for shape in slide.shapes if hasattr(shape, "text") and shape.text.strip()]
            if text:
                sections.append(f"## Slide {index}\n\n" + "\n\n".join(text))
        return "\n\n".join(sections), "python-pptx", {"slide_count": len(presentation.slides)}, None
    if content_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" or suffix == ".xlsx":
        workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        sections: list[str] = []
        for worksheet in workbook.worksheets:
            rows = [
                ["" if value is None else str(value) for value in row] for row in worksheet.iter_rows(values_only=True)
            ]
            while rows and not any(rows[-1]):
                rows.pop()
            if rows:
                sections.append(f"## {worksheet.title}\n\n" + "\n".join(markdown_table(rows)))
        return "\n\n".join(sections), "openpyxl", {"sheet_count": len(workbook.worksheets)}, None
    text = decode_text(content)
    if content_type == "text/html" or suffix in {".html", ".htm"}:
        soup = BeautifulSoup(text, "html.parser")
        for node in soup(["script", "style", "noscript"]):
            node.decompose()
        title = soup.title.string.strip() if soup.title and soup.title.string else None
        markdown = markdownify(str(soup.body or soup), heading_style="ATX").strip()
        return markdown, "beautifulsoup-markdownify", {"html_title": title} if title else {}, None
    if content_type == "application/json" or suffix == ".json":
        try:
            formatted = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
        except json.JSONDecodeError as error:
            raise ServiceError(
                "invalid_document", "Document contains invalid JSON", status_code=422, provider="document"
            ) from error
        return f"```json\n{formatted}\n```\n", "json", {}, None
    return text, "plain-text", {"encoding": "utf-8"}, None


def parse_timed_transcript(
    content: bytes,
) -> tuple[str, str, dict[str, object], dict[str, object]]:
    try:
        document = json.loads(decode_text(content))
    except json.JSONDecodeError as error:
        raise ServiceError(
            "invalid_document", "TimedTranscript contains invalid JSON", status_code=422, provider="document"
        ) from error
    if (
        not isinstance(document, dict)
        or document.get("schema_name") != "TimedTranscript"
        or document.get("version") != 1
    ):
        raise ServiceError(
            "invalid_document", "TimedTranscript must use schema version 1", status_code=422, provider="document"
        )
    source = document.get("source")
    chapters = document.get("chapters")
    segments = document.get("segments")
    if (
        not isinstance(source, dict)
        or not isinstance(source.get("title"), str)
        or not source["title"].strip()
        or (
            source.get("description") is not None
            and not isinstance(source.get("description"), str)
        )
        or not isinstance(chapters, list)
        or not isinstance(segments, list)
    ):
        raise ServiceError(
            "invalid_document", "TimedTranscript source, chapters, or segments are invalid",
            status_code=422, provider="document",
        )
    chapter_ids: set[str] = set()
    for chapter in chapters:
        if (
            not isinstance(chapter, dict)
            or not _valid_identifier(chapter.get("id"), chapter_ids)
            or not isinstance(chapter.get("title"), str)
            or not chapter["title"].strip()
            or not _valid_time_range(chapter)
        ):
            raise ServiceError(
                "invalid_document", "TimedTranscript contains an invalid chapter",
                status_code=422, provider="document",
            )
        chapter_ids.add(chapter["id"])
    segment_ids: set[str] = set()
    for segment in segments:
        chapter_id = segment.get("chapter_id") if isinstance(segment, dict) else None
        if (
            not isinstance(segment, dict)
            or not _valid_identifier(segment.get("id"), segment_ids)
            or not isinstance(segment.get("text"), str)
            or not segment["text"].strip()
            or not _valid_time_range(segment)
            or (chapter_id is not None and chapter_id not in chapter_ids)
        ):
            raise ServiceError(
                "invalid_document", "TimedTranscript contains an invalid segment",
                status_code=422, provider="document",
            )
        segment_ids.add(segment["id"])
    duration_ms = source.get("duration_ms")
    if duration_ms is not None and (
        not isinstance(duration_ms, int) or isinstance(duration_ms, bool) or duration_ms < 0
    ):
        raise ServiceError(
            "invalid_document", "TimedTranscript duration_ms is invalid",
            status_code=422, provider="document",
        )
    markdown = _timed_transcript_markdown(document)
    return (
        markdown,
        "timed-transcript",
        {"chapter_count": len(chapters), "segment_count": len(segments), "canonical_document": True},
        document,
    )


def _valid_identifier(value: object, existing: set[str]) -> bool:
    return isinstance(value, str) and bool(value.strip()) and value not in existing


def _valid_time_range(value: dict[str, object]) -> bool:
    start = value.get("start_ms")
    end = value.get("end_ms")
    return (
        isinstance(start, int)
        and not isinstance(start, bool)
        and isinstance(end, int)
        and not isinstance(end, bool)
        and 0 <= start <= end
    )


def _timed_transcript_markdown(document: dict[str, object]) -> str:
    source = document["source"]
    assert isinstance(source, dict)
    title = str(source["title"]).strip()
    chapters = document["chapters"]
    segments = document["segments"]
    assert isinstance(chapters, list)
    assert isinstance(segments, list)
    lines = [f"# {title}", ""]
    if chapters:
        for chapter in chapters:
            assert isinstance(chapter, dict)
            lines.extend([f"## {chapter['title']}", ""])
            lines.extend(
                str(segment["text"]).strip()
                for segment in segments
                if isinstance(segment, dict) and segment.get("chapter_id") == chapter["id"]
            )
            lines.append("")
    else:
        lines.extend(["## Transcript", ""])
        lines.extend(str(segment["text"]).strip() for segment in segments if isinstance(segment, dict))
    return "\n\n".join(line for line in lines if line).strip()


def parse_pdf_with_docling(
    content: bytes,
    page_range: tuple[int, int] | None = None,
    asset_output_dir: Path | None = None,
    input_root: Path | None = None,
) -> tuple[str, str, dict[str, object], dict[str, object]]:
    with tempfile.TemporaryDirectory(prefix="telomi-docling-") as directory:
        input_path = Path(directory) / "document.pdf"
        input_path.write_bytes(content)
        with _DOCLING_LOCK:
            converter = docling_converter(True) if asset_output_dir is not None else docling_converter()
            result = converter.convert(
                input_path,
                **({"page_range": page_range} if page_range else {}),
            )
        document = result.document
        markdown = document.export_to_markdown(enable_chart_tables=True)
        structured_document = document.export_to_dict()
        assets: list[dict[str, object]] = []
        if asset_output_dir is not None and input_root is not None:
            asset_output_dir.mkdir(parents=True, exist_ok=True)
            for old in asset_output_dir.glob("figure-*.png"):
                old.unlink()
            for index, picture in enumerate(document.pictures):
                image = picture.get_image(document)
                if image is None:
                    continue
                page = picture.prov[0].page_no if picture.prov else 0
                filename = f"figure-p{page:04d}-{index + 1:04d}.png"
                target = asset_output_dir / filename
                image.save(target, format="PNG")
                data = target.read_bytes()
                assets.append(
                    {
                        "node_id": f"node:figure:{index}",
                        "relative_path": target.relative_to(input_root).as_posix(),
                        "markdown_path": f"{asset_output_dir.name}/{filename}",
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "byte_length": len(data),
                        "media_type": "image/png",
                        "page": page,
                        "figure_index": index,
                    }
                )
            structured_document["_pi_assets"] = assets
        for picture in structured_document.get("pictures", []):
            if isinstance(picture, dict):
                picture.pop("image", None)
        return (
            markdown,
            "docling",
            {
                "page_count": len(document.pages),
                "table_count": len(document.tables),
                "picture_count": len(document.pictures),
                "canonical_document": True,
                "canonical_source": "docling",
                "ocr_engine": _DOCLING_OCR_ENGINE,
            },
            structured_document,
        )


def docling_converter(generate_picture_images: bool = False):
    global _DOCLING_OCR_ENGINE
    if generate_picture_images not in _DOCLING_CONVERTERS:
        from docling.datamodel.accelerator_options import AcceleratorDevice, AcceleratorOptions
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions, TesseractCliOcrOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption

        options = PdfPipelineOptions()
        options.generate_picture_images = generate_picture_images
        if generate_picture_images:
            options.images_scale = 2.0
        tesseract = shutil.which("tesseract")
        if tesseract:
            options.ocr_options = TesseractCliOcrOptions(
                lang=["eng"],
                tesseract_cmd=tesseract,
                bitmap_area_threshold=0.05,
            )
            _DOCLING_OCR_ENGINE = "tesseract-cli"
        else:
            options.do_ocr = False
            _DOCLING_OCR_ENGINE = "disabled-no-tesseract"
        options.accelerator_options = AcceleratorOptions(num_threads=4, device=AcceleratorDevice.AUTO)
        _DOCLING_CONVERTERS[generate_picture_images] = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
        )
    return _DOCLING_CONVERTERS[generate_picture_images]


def markdown_table(rows: list[list[str]]) -> list[str]:
    if not rows:
        return []
    width = max(len(row) for row in rows)
    normalized = [row + [""] * (width - len(row)) for row in rows]
    escaped = [[cell.replace("|", "\\|").replace("\n", " ") for cell in row] for row in normalized]
    return [
        "| " + " | ".join(escaped[0]) + " |",
        "| " + " | ".join("---" for _ in range(width)) + " |",
        *["| " + " | ".join(row) + " |" for row in escaped[1:]],
    ]


def decode_text(content: bytes) -> str:
    if content.startswith(b"\xef\xbb\xbf"):
        return content.decode("utf-8-sig")
    for encoding in ("utf-8", "utf-16", "gb18030", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def valid_unicode(value: str) -> str:
    """Recombine valid surrogate pairs and replace isolated PDF extractor surrogates."""
    return value.encode("utf-16", errors="surrogatepass").decode("utf-16", errors="replace")


def normalize_content_type(value: str | None) -> str | None:
    return value.split(";", 1)[0].strip().lower() if value and value.strip() else None
