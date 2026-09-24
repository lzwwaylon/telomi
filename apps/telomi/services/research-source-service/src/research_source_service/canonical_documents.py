from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from typing import Any

CANONICAL_DOCUMENT_SCHEMA = "CanonicalDocument"
CANONICAL_DOCUMENT_VERSION = 1


def canonical_document_from_parser_output(
    *,
    markdown: str,
    structured_document: dict[str, Any] | None,
    source_name: str,
    content_type: str | None,
    parser: str,
    content_sha256: str,
    page_range: tuple[int, int] | None,
) -> dict[str, Any]:
    if structured_document is not None and structured_document.get("schema_name") == "DoclingDocument":
        canonical = _canonical_from_docling(
            structured_document,
            source_name=source_name,
            content_type=content_type,
            parser=parser,
            content_sha256=content_sha256,
            page_range=page_range,
        )
        if canonical_document_has_content(canonical):
            return canonical
    if structured_document is not None and structured_document.get("schema_name") == "TimedTranscript":
        return _canonical_from_timed_transcript(
            structured_document,
            source_name=source_name,
            content_type=content_type,
            parser=parser,
            content_sha256=content_sha256,
        )
    return _canonical_from_markdown(
        markdown,
        source_name=source_name,
        content_type=content_type,
        parser=parser,
        content_sha256=content_sha256,
        page_range=page_range,
    )


def _canonical_from_timed_transcript(
    document: dict[str, Any],
    *,
    source_name: str,
    content_type: str | None,
    parser: str,
    content_sha256: str,
) -> dict[str, Any]:
    source = document["source"]
    chapters = document["chapters"]
    segments = document["segments"]
    assert isinstance(source, dict)
    assert isinstance(chapters, list)
    assert isinstance(segments, list)
    nodes: list[dict[str, Any]] = []
    chapter_node_by_id: dict[str, str] = {}
    segment_node_by_id: dict[str, str] = {}

    def add(kind: str, text: str, collection: str, index: int, **extra: Any) -> str:
        node_id = f"node:{len(nodes) + 1}"
        nodes.append(
            {
                "id": node_id,
                "kind": kind,
                "page": 1,
                "text": text.strip(),
                "source": {"collection": collection, "index": index, "label": kind},
                **extra,
            }
        )
        return node_id

    add("heading", str(source["title"]), "source", 0, level=1)
    description = source.get("description")
    if isinstance(description, str) and description.strip():
        add("heading", "Video Description", "source", 1, level=2)
        add("paragraph", description, "source", 2)
    segments_by_chapter: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    unchaptered: list[tuple[int, dict[str, Any]]] = []
    for index, segment in enumerate(segments):
        assert isinstance(segment, dict)
        chapter_id = segment.get("chapter_id")
        if isinstance(chapter_id, str):
            segments_by_chapter.setdefault(chapter_id, []).append((index, segment))
        else:
            unchaptered.append((index, segment))

    if chapters:
        for chapter_index, chapter in enumerate(chapters):
            assert isinstance(chapter, dict)
            chapter_id = str(chapter["id"])
            chapter_node_by_id[chapter_id] = add(
                "heading", str(chapter["title"]), "chapters", chapter_index, level=2
            )
            for segment_index, segment in segments_by_chapter.get(chapter_id, []):
                segment_node_by_id[str(segment["id"])] = add(
                    "paragraph", str(segment["text"]), "segments", segment_index
                )
        if unchaptered:
            add("heading", "Unchaptered", "generated", 0, level=2)
            for segment_index, segment in unchaptered:
                segment_node_by_id[str(segment["id"])] = add(
                    "paragraph", str(segment["text"]), "segments", segment_index
                )
    else:
        add("heading", "Transcript", "generated", 0, level=2)
        for segment_index, segment in enumerate(segments):
            assert isinstance(segment, dict)
            segment_node_by_id[str(segment["id"])] = add(
                "paragraph", str(segment["text"]), "segments", segment_index
            )

    timeline: dict[str, Any] = {
        **({"duration_ms": source["duration_ms"]} if isinstance(source.get("duration_ms"), int) else {}),
        "chapters": [
            {
                "node_id": chapter_node_by_id[str(chapter["id"])],
                "start_ms": chapter["start_ms"],
                "end_ms": chapter["end_ms"],
            }
            for chapter in chapters
            if isinstance(chapter, dict) and str(chapter["id"]) in chapter_node_by_id
        ],
        "segments": [
            {
                "node_id": segment_node_by_id[str(segment["id"])],
                "start_ms": segment["start_ms"],
                "end_ms": segment["end_ms"],
                **(
                    {"chapter_node_id": chapter_node_by_id[str(segment["chapter_id"])]}
                    if isinstance(segment.get("chapter_id"), str)
                    and str(segment["chapter_id"]) in chapter_node_by_id
                    else {}
                ),
            }
            for segment in segments
            if isinstance(segment, dict) and str(segment["id"]) in segment_node_by_id
        ],
    }
    return _assemble_document(
        source_name=source_name,
        content_type=content_type,
        parser=parser,
        parser_schema_name="TimedTranscript",
        parser_schema_version=str(document["version"]),
        content_sha256=content_sha256,
        page_range=None,
        nodes=nodes,
        page_numbers=[1],
        page_labels=[],
        notes=[],
        cleaning={
            "raw_text_nodes": len(nodes),
            "retained_nodes": len(nodes),
            "retained_picture_text_nodes": 0,
            "dropped_picture_text_nodes": 0,
            "dropped_table_text_nodes": 0,
            "dropped_page_furniture_nodes": 0,
            "retained_page_labels": 0,
            "retained_document_notes": 0,
            "dropped_empty_text_nodes": 0,
            "raw_table_cells": 0,
            "retained_table_cells": 0,
            "coordinates_removed": True,
            "reference_graph_removed": True,
        },
        timeline=timeline,
    )


def canonical_document_sha256(document: dict[str, Any]) -> str:
    encoded = json.dumps(
        document,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def canonical_document_has_content(document: dict[str, Any]) -> bool:
    for node in document.get("nodes", []):
        if isinstance(node, dict):
            if isinstance(node.get("text"), str) and node["text"].strip():
                return True
            if any(
                isinstance(item, dict)
                and isinstance(item.get("text"), str)
                and item["text"].strip()
                for item in node.get("content", [])
            ):
                return True
            if any(
                isinstance(cell, dict) and isinstance(cell.get("text"), str) and cell["text"].strip()
                for cell in node.get("cells", [])
            ):
                return True
            if any(isinstance(caption, str) and caption.strip() for caption in node.get("captions", [])):
                return True
    return False


def _canonical_from_docling(
    document: dict[str, Any],
    *,
    source_name: str,
    content_type: str | None,
    parser: str,
    content_sha256: str,
    page_range: tuple[int, int] | None,
) -> dict[str, Any]:
    texts = _records(document.get("texts"))
    tables = _records(document.get("tables"))
    pictures = _records(document.get("pictures"))
    groups = _records(document.get("groups"))
    text_by_ref = {f"#/texts/{index}": value for index, value in enumerate(texts)}
    cleaning = {
        "raw_text_nodes": len(texts),
        "retained_nodes": 0,
        "retained_picture_text_nodes": 0,
        "dropped_picture_text_nodes": 0,
        "dropped_table_text_nodes": 0,
        "dropped_page_furniture_nodes": 0,
        "retained_page_labels": 0,
        "retained_document_notes": 0,
        "dropped_empty_text_nodes": 0,
        "raw_table_cells": 0,
        "retained_table_cells": 0,
        "coordinates_removed": True,
        "reference_graph_removed": True,
    }
    page_labels: list[dict[str, Any]] = []
    page_label_keys: set[tuple[int | None, str]] = set()
    notes: list[dict[str, Any]] = []
    note_keys: set[tuple[str, str]] = set()
    nodes: list[dict[str, Any]] = []
    visited: set[str] = set()

    def project_text(index: int) -> dict[str, Any] | None:
        if index < 0 or index >= len(texts):
            return None
        value = texts[index]
        text = _readable_text(value)
        if not text:
            cleaning["dropped_empty_text_nodes"] += 1
            return None
        label = _string(value.get("label")) or "text"
        kind = _node_kind(label)
        node: dict[str, Any] = {
            "id": f"node:text:{index}",
            "kind": kind,
            "page": _page_number(value),
            "text": text,
            "source": {"collection": "texts", "index": index, "label": label},
        }
        level = _non_negative_integer(value.get("level"))
        if kind == "heading":
            node["level"] = max(1, level or 1)
        if kind == "list_item":
            node["depth"] = level or 0
        return node

    def add_text(index: int) -> None:
        ref = f"#/texts/{index}"
        if ref in visited or index < 0 or index >= len(texts):
            return
        visited.add(ref)
        value = texts[index]
        parent = _reference(value.get("parent"))
        label = _string(value.get("label")) or "text"
        if parent and parent.startswith("#/pictures/"):
            match = re.fullmatch(r"#/pictures/(\d+)", parent)
            if match and int(match.group(1)) < len(pictures):
                visited.remove(ref)
                add_picture(int(match.group(1)))
                return
        if parent and parent.startswith("#/tables/"):
            cleaning["dropped_table_text_nodes"] += 1
            return
        text = _readable_text(value)
        page = _page_number(value)
        if label in {"page_header", "page_footer"}:
            key = (page, text)
            if _is_page_label(text) and key not in page_label_keys:
                page_label_keys.add(key)
                page_labels.append({"page": page, "text": text})
                return
            note_key = (label, re.sub(r"\s+", " ", text).casefold())
            if not _is_meaningful_note(text) or note_key in note_keys:
                cleaning["dropped_page_furniture_nodes"] += 1
                return
            note_keys.add(note_key)
            notes.append({"label": label, "page": page, "text": text})
            return
        if not text:
            cleaning["dropped_empty_text_nodes"] += 1
            return
        node = project_text(index)
        if node is not None:
            nodes.append(node)

    def add_table(index: int) -> None:
        ref = f"#/tables/{index}"
        if ref in visited or index < 0 or index >= len(tables):
            return
        visited.add(ref)
        table = tables[index]
        data = table.get("data") if isinstance(table.get("data"), dict) else {}
        raw_cells = _records(data.get("table_cells"))
        cleaning["raw_table_cells"] += len(raw_cells)
        cells: list[dict[str, Any]] = []
        for raw_cell in raw_cells:
            text = _string(raw_cell.get("text")).strip()
            if not text:
                continue
            role = (
                "column_header"
                if raw_cell.get("column_header") is True
                else "row_header"
                if raw_cell.get("row_header") is True
                else "row_section"
                if raw_cell.get("row_section") is True
                else None
            )
            cell = {
                "row": _non_negative_integer(raw_cell.get("start_row_offset_idx")) or 0,
                "column": _non_negative_integer(raw_cell.get("start_col_offset_idx")) or 0,
                "row_span": _positive_integer(raw_cell.get("row_span")) or 1,
                "column_span": _positive_integer(raw_cell.get("col_span")) or 1,
                "text": text,
            }
            if role:
                cell["role"] = role
            cells.append(cell)
        cleaning["retained_table_cells"] += len(cells)
        nodes.append(
            {
                "id": f"node:table:{index}",
                "kind": "table",
                "page": _page_number(table),
                "captions": _resolve_captions(table.get("captions"), text_by_ref),
                "row_count": _non_negative_integer(data.get("num_rows")) or 0,
                "column_count": _non_negative_integer(data.get("num_cols")) or 0,
                "cells": cells,
                "source": {"collection": "tables", "index": index, "label": "table"},
            }
        )

    def add_picture(index: int) -> None:
        ref = f"#/pictures/{index}"
        if ref in visited or index < 0 or index >= len(pictures):
            return
        visited.add(ref)
        picture = pictures[index]
        caption_refs = {
            caption_ref
            for value in _values(picture.get("captions"))
            if (caption_ref := _reference(value)) is not None
        }
        ordered_text_refs: list[str] = []
        seen_descendants: set[str] = set()

        def collect_descendant(child_ref: str, stack: set[str]) -> None:
            if child_ref in seen_descendants or child_ref in stack:
                return
            seen_descendants.add(child_ref)
            match = re.fullmatch(r"#/(texts|groups)/(\d+)", child_ref)
            if not match:
                return
            collection, raw_index = match.groups()
            child_index = int(raw_index)
            if collection == "texts":
                if child_index < len(texts):
                    ordered_text_refs.append(child_ref)
                return
            if child_index >= len(groups):
                return
            next_stack = {*stack, child_ref}
            for child in _values(groups[child_index].get("children")):
                nested_ref = _reference(child)
                if nested_ref:
                    collect_descendant(nested_ref, next_stack)

        for child in _values(picture.get("children")):
            child_ref = _reference(child)
            if child_ref:
                collect_descendant(child_ref, set())

        # Preserve valid picture children even when a Docling version omits them
        # from PictureItem.children. Array order is deterministic as a fallback.
        for text_index, value in enumerate(texts):
            if _reference(value.get("parent")) == ref:
                text_ref = f"#/texts/{text_index}"
                if text_ref not in seen_descendants:
                    seen_descendants.add(text_ref)
                    ordered_text_refs.append(text_ref)

        content: list[dict[str, Any]] = []
        for text_ref in ordered_text_refs:
            text_index = int(text_ref.rsplit("/", 1)[1])
            projected = project_text(text_index)
            visited.add(text_ref)
            if projected is None:
                continue
            cleaning["retained_picture_text_nodes"] += 1
            if text_ref not in caption_refs:
                content.append(projected)

        for caption_ref in caption_refs:
            match = re.fullmatch(r"#/texts/(\d+)", caption_ref)
            if not match or caption_ref in seen_descendants:
                continue
            caption_index = int(match.group(1))
            if project_text(caption_index) is not None:
                cleaning["retained_picture_text_nodes"] += 1
            visited.add(caption_ref)
        nodes.append(
            {
                "id": f"node:figure:{index}",
                "kind": "figure",
                "page": _page_number(picture),
                "captions": _resolve_captions(picture.get("captions"), text_by_ref),
                "content": content,
                "source": {"collection": "pictures", "index": index, "label": "picture"},
            }
        )

    def visit_ref(ref: str, stack: set[str]) -> None:
        if ref in stack:
            return
        match = re.fullmatch(r"#/(texts|tables|pictures|groups)/(\d+)", ref)
        if not match:
            return
        collection, raw_index = match.groups()
        index = int(raw_index)
        if collection == "texts":
            add_text(index)
        elif collection == "tables":
            add_table(index)
        elif collection == "pictures":
            add_picture(index)
        elif index < len(groups):
            next_stack = {*stack, ref}
            for child in _values(groups[index].get("children")):
                child_ref = _reference(child)
                if child_ref:
                    visit_ref(child_ref, next_stack)

    body = document.get("body") if isinstance(document.get("body"), dict) else {}
    for child in _values(body.get("children")):
        ref = _reference(child)
        if ref:
            visit_ref(ref, set())

    # Some Docling versions omit leaves from body.children. Preserve all useful
    # nodes deterministically after the ordered traversal rather than losing text.
    for index in range(len(texts)):
        add_text(index)
    for index in range(len(tables)):
        add_table(index)
    for index in range(len(pictures)):
        add_picture(index)

    cleaning["retained_nodes"] = len(nodes)
    cleaning["retained_page_labels"] = len(page_labels)
    cleaning["retained_document_notes"] = len(notes)
    origin = document.get("origin") if isinstance(document.get("origin"), dict) else {}
    return _assemble_document(
        source_name=_string(origin.get("filename")) or source_name,
        content_type=_string(origin.get("mimetype")) or content_type,
        parser=parser,
        parser_schema_name=_string(document.get("schema_name")),
        parser_schema_version=_string(document.get("version")),
        content_sha256=content_sha256,
        page_range=page_range,
        nodes=nodes,
        page_numbers=_docling_page_numbers(document.get("pages"), nodes),
        page_labels=page_labels,
        notes=notes,
        cleaning=cleaning,
    )


def _canonical_from_markdown(
    markdown: str,
    *,
    source_name: str,
    content_type: str | None,
    parser: str,
    content_sha256: str,
    page_range: tuple[int, int] | None,
) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    pages: set[int] = {page_range[0] if page_range else 1}
    page = page_range[0] if page_range else 1
    paragraph: list[str] = []
    table_lines: list[str] = []
    in_code = False
    code_lines: list[str] = []

    def add(kind: str, text: str, **extra: Any) -> None:
        cleaned = text.strip()
        if not cleaned:
            return
        nodes.append(
            {
                "id": f"node:{len(nodes) + 1}",
                "kind": kind,
                "page": page,
                "text": cleaned,
                "source": {"collection": "rendered_text", "index": len(nodes), "label": kind},
                **extra,
            }
        )

    def flush_paragraph() -> None:
        if paragraph:
            add("paragraph", " ".join(paragraph))
            paragraph.clear()

    def flush_table() -> None:
        if not table_lines:
            return
        rows = [_markdown_table_row(line) for line in table_lines]
        table_lines.clear()
        if len(rows) < 2 or not all(re.fullmatch(r":?-{3,}:?", cell) for cell in rows[1]):
            paragraph.extend(" | ".join(row) for row in rows)
            return
        content_rows = [rows[0], *rows[2:]]
        column_count = max((len(row) for row in content_rows), default=0)
        cells = [
            {
                "row": row_index,
                "column": column_index,
                "row_span": 1,
                "column_span": 1,
                "text": cell,
                **({"role": "column_header"} if row_index == 0 else {}),
            }
            for row_index, row in enumerate(content_rows)
            for column_index, cell in enumerate(row)
            if cell
        ]
        index = len(nodes)
        nodes.append(
            {
                "id": f"node:{index + 1}",
                "kind": "table",
                "page": page,
                "captions": [],
                "row_count": len(content_rows),
                "column_count": column_count,
                "cells": cells,
                "source": {"collection": "rendered_text", "index": index, "label": "table"},
            }
        )

    for raw_line in markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if not in_code and line.startswith("|") and line.endswith("|"):
            flush_paragraph()
            table_lines.append(line)
            continue
        flush_table()
        if line.startswith("```"):
            flush_paragraph()
            if in_code:
                add("code", "\n".join(code_lines))
                code_lines.clear()
            in_code = not in_code
            continue
        if in_code:
            code_lines.append(raw_line)
            continue
        page_match = re.fullmatch(r"#{1,6}\s+(?:Page|Slide)\s+([1-9]\d*)", line, re.IGNORECASE)
        if page_match:
            flush_paragraph()
            page = int(page_match.group(1))
            pages.add(page)
            continue
        heading = re.fullmatch(r"(#{1,6})\s+(.+)", line)
        if heading:
            flush_paragraph()
            add("heading", heading.group(2), level=len(heading.group(1)))
            continue
        item = re.fullmatch(r"([-*+] |\d+[.)] )(.*)", line)
        if item:
            flush_paragraph()
            indentation = len(raw_line) - len(raw_line.lstrip(" "))
            add("list_item", item.group(2), depth=indentation // 2)
            continue
        if not line:
            flush_paragraph()
            continue
        paragraph.append(line)
    flush_table()
    flush_paragraph()
    if code_lines:
        add("code", "\n".join(code_lines))
    return _assemble_document(
        source_name=source_name,
        content_type=content_type,
        parser=parser,
        parser_schema_name=None,
        parser_schema_version=None,
        content_sha256=content_sha256,
        page_range=page_range,
        nodes=nodes,
        page_numbers=sorted(pages),
        page_labels=[],
        notes=[],
        cleaning={
            "raw_text_nodes": len(nodes),
            "retained_nodes": len(nodes),
            "retained_picture_text_nodes": 0,
            "dropped_picture_text_nodes": 0,
            "dropped_table_text_nodes": 0,
            "dropped_page_furniture_nodes": 0,
            "retained_page_labels": 0,
            "retained_document_notes": 0,
            "dropped_empty_text_nodes": 0,
            "raw_table_cells": 0,
            "retained_table_cells": 0,
            "coordinates_removed": True,
            "reference_graph_removed": True,
        },
    )


def _assemble_document(
    *,
    source_name: str,
    content_type: str | None,
    parser: str,
    parser_schema_name: str | None,
    parser_schema_version: str | None,
    content_sha256: str,
    page_range: tuple[int, int] | None,
    nodes: list[dict[str, Any]],
    page_numbers: list[int],
    page_labels: list[dict[str, Any]],
    notes: list[dict[str, Any]],
    cleaning: dict[str, Any],
    timeline: dict[str, Any] | None = None,
) -> dict[str, Any]:
    page_label_by_number = {value["page"]: value["text"] for value in page_labels if isinstance(value.get("page"), int)}
    pages = [
        {
            "number": number,
            "label": page_label_by_number.get(number),
            "node_ids": [node["id"] for node in nodes if node.get("page") == number],
        }
        for number in page_numbers
    ]
    outline: list[dict[str, Any]] = []
    heading_stack: list[dict[str, Any]] = []
    for node in nodes:
        if node.get("kind") != "heading":
            continue
        level = _positive_integer(node.get("level")) or 1
        while heading_stack and int(heading_stack[-1]["level"]) >= level:
            heading_stack.pop()
        entry = {
            "node_id": node["id"],
            "level": level,
            "title": node.get("text", ""),
            "parent_node_id": heading_stack[-1]["node_id"] if heading_stack else None,
        }
        outline.append(entry)
        heading_stack.append(entry)
    return {
        "schema_name": CANONICAL_DOCUMENT_SCHEMA,
        "version": CANONICAL_DOCUMENT_VERSION,
        "source": {
            "filename": source_name,
            "mimetype": content_type,
            "page_count": len(page_numbers),
        },
        "nodes": nodes,
        "pages": pages,
        "outline": outline,
        "page_labels": page_labels,
        "document_notes": notes,
        "cleaning": cleaning,
        "provenance": {
            "parser": parser,
            "parser_schema_name": parser_schema_name,
            "parser_schema_version": parser_schema_version,
            "content_sha256": content_sha256,
            "page_range": list(page_range) if page_range else None,
        },
        **({"timeline": timeline} if timeline is not None else {}),
    }


def _docling_page_numbers(value: Any, nodes: list[dict[str, Any]]) -> list[int]:
    numbers: set[int] = set()
    if isinstance(value, dict):
        numbers.update(int(key) for key in value if str(key).isdigit())
    elif isinstance(value, list):
        numbers.update(range(1, len(value) + 1))
    numbers.update(node["page"] for node in nodes if isinstance(node.get("page"), int))
    return sorted(numbers)


def _resolve_captions(value: Any, text_by_ref: dict[str, dict[str, Any]]) -> list[str]:
    captions: list[str] = []
    for item in _values(value):
        ref = _reference(item)
        text = _readable_text(text_by_ref.get(ref, {})) if ref else ""
        if text and text not in captions:
            captions.append(text)
    return captions


def _markdown_table_row(value: str) -> list[str]:
    return [cell.replace("\\|", "|").strip() for cell in re.split(r"(?<!\\)\|", value.strip().strip("|"))]


def _node_kind(label: str) -> str:
    if label in {"section_header", "title"}:
        return "heading"
    if label in {"list_item", "checkbox_selected", "checkbox_unselected"}:
        return "list_item"
    if label == "formula":
        return "formula"
    if label == "code":
        return "code"
    return "paragraph"


def _readable_text(value: dict[str, Any]) -> str:
    text = _string(value.get("text")).strip()
    if text:
        return text
    return _string(value.get("orig")).strip() if value.get("label") == "formula" else ""


def _page_number(value: dict[str, Any]) -> int | None:
    provenance = _records(value.get("prov"))
    return _non_negative_integer(provenance[0].get("page_no")) if provenance else None


def _reference(value: Any) -> str | None:
    return _string(value.get("$ref")) or None if isinstance(value, dict) else None


def _records(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _values(value: Any) -> Iterable[Any]:
    return value if isinstance(value, list) else []


def _string(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return ""


def _non_negative_integer(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _positive_integer(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _is_page_label(value: str) -> bool:
    return bool(re.fullmatch(r"(?:(?:page\s*)?(?:\d+|[ivxlcdm]+)|\d+\s*(?:/|of)\s*\d+)", value, re.IGNORECASE))


def _is_meaningful_note(value: str) -> bool:
    return (
        len(value) >= 4
        and not re.fullmatch(r"(?:page\s*)?\d+", value, re.IGNORECASE)
        and sum(char.isalpha() for char in value) >= 2
    )
