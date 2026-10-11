"""Pi-compatible UTF-8 text reads for print(read(...)) in an existing SRT kernel.

The sandbox still owns file permissions. Unlike Pi's multimodal tool, this
helper rejects binary/non-UTF-8 input and returns only text, not image blocks or
tool metadata. Paths are literal apart from ~ expansion and declared Source
paths in the supplied Source view; Pi's @/macOS filename fallbacks are not
applied. Source text uses original citation line labels and continuation offsets.
Long-line notices offer Python instead of bash. File permissions remain SRT's.
"""

import json
import os
import stat
from pathlib import Path

_MAX_LINES = 2000
_MAX_BYTES = 50 * 1024
_MAX_DISPLAY_BYTES = 32 * 1024
_SOURCE_ROOT = Path.cwd() / "source"
_manifest = _SOURCE_ROOT / "source-manifest.json"
_SOURCE_PATHS = {
    item["path"] for item in json.loads(_manifest.read_text(encoding="utf-8")).get("content_files", [])
    if isinstance(item, dict) and isinstance(item.get("path"), str)
    and not Path(item["path"]).is_absolute() and ".." not in Path(item["path"]).parts
} if _manifest.is_file() else set()


def _display(text: str, offset: int, limit: int | None) -> str:
    lines = text.removeprefix("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if offset > len(lines):
        raise ValueError(f"Offset {offset} is beyond end of file ({len(lines)} lines total)")

    def footer(end: int) -> str:
        continuation = (f"next_offset={end + 1}; use offset={end + 1} to continue."
                        if end < len(lines) else "End of file; next_offset=null.")
        return f"\n\n[Showing original lines {offset}-{end} of {len(lines)}. {continuation}]"

    page = []
    used = 0
    stop = min(len(lines), offset - 1 + min(limit if limit is not None else _MAX_LINES, _MAX_LINES))
    for index in range(offset - 1, stop):
        labelled = f"L{index + 1} | {lines[index]}"
        size = len(labelled.encode("utf-8")) + (1 if page else 0)
        if used + size + len(footer(index + 1).encode("utf-8")) > _MAX_DISPLAY_BYTES:
            break
        page.append(labelled)
        used += size
    if not page:
        return (f"[Original line {offset} exceeds the 32 KiB display budget. No lines were displayed or skipped. "
                "Use bash/Python to inspect bounded character ranges of this line; normalize CRLF and CR to LF "
                "when selecting original citation lines. A line fragment is not a complete line. No next_offset is provided.]")
    return "\n".join(page) + footer(offset + len(page) - 1)


def _size(count: int) -> str:
    if count < 1024:
        return f"{count}B"
    unit, suffix = (1024, "KB") if count < 1024 * 1024 else (1024 * 1024, "MB")
    tenths = (count * 10 + unit // 2) // unit
    return f"{tenths // 10}.{tenths % 10}{suffix}"


def read(path: str, offset: int = 1, limit: int | None = None, format: str = "auto") -> str:
    """Read text; Source passages share Pi's 2000-line/32-KiB numbered display."""
    if format not in ("auto", "numbered", "raw"):
        raise ValueError("Unknown read format")
    if not isinstance(path, str) or not path or "\0" in path:
        raise ValueError("read requires a file path")
    if (type(offset) is not int or not 1 <= offset <= 2**53 - 1
            or limit is not None and (type(limit) is not int or not 1 <= limit <= 2**53 - 1)):
        raise ValueError("read offset and limit must be positive safe integers")
    file_path = Path(path).expanduser()
    # Manifest paths name Source files, while output and other existing paths remain workspace-relative.
    if path in _SOURCE_PATHS and not file_path.is_absolute() and not file_path.exists():
        file_path = _SOURCE_ROOT / file_path
    absolute = Path(os.path.abspath(file_path))
    view = format
    is_source = (absolute.suffix.lower() in (".md", ".markdown", ".txt")
                 and absolute.is_relative_to(_SOURCE_ROOT))
    if format == "auto":
        view = "numbered" if is_source else "raw"
    # Nonblocking open lets us reject a FIFO before it can stall the kernel.
    with open(file_path, "rb", opener=lambda name, flags: os.open(name, flags | os.O_NONBLOCK)) as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError("read supports regular UTF-8 text files only")
        data = file.read()
    if b"\0" in data or data.startswith((b"GIF87a", b"GIF89a", b"%PDF-", b"PK\x03\x04")):
        raise ValueError("read supports UTF-8 text only; binary formats are unsupported")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("read supports UTF-8 text only; binary or invalid UTF-8 input") from error

    if view != "raw":
        return _display(text, offset, limit)

    # splitlines() would change CRLF and Pi's trailing-empty-line offsets.
    all_lines = text.split("\n")
    start = max(0, offset - 1)
    if start >= len(all_lines):
        raise ValueError(f"Offset {offset} is beyond end of file ({len(all_lines)} lines total)")
    end = len(all_lines) if limit is None else min(start + limit, len(all_lines))
    selected = "\n".join(all_lines[start:end])
    lines = selected.split("\n") if selected else []
    if selected.endswith("\n"):
        lines.pop()
    if len(lines) <= _MAX_LINES and len(selected.encode("utf-8")) <= _MAX_BYTES:
        if limit is not None and end < len(all_lines):
            return f"{selected}\n\n[{len(all_lines) - end} more lines in file. Use offset={end + 1} to continue.]"
        return selected

    first_size = len(lines[0].encode("utf-8"))
    if first_size > _MAX_BYTES:
        fallback = (f"with open({str(file_path)!r}, 'rb') as f: "
                    f"print(f.read().split(b'\\n')[{start}][:{_MAX_BYTES}]"
                    ".decode('utf-8', errors='ignore'), end='')")
        return f"[Line {start + 1} is {_size(first_size)}, exceeds {_size(_MAX_BYTES)} limit. Use Python: {fallback}]"
    shown = []
    used = 0
    truncated_by = "lines"
    for line in lines[:_MAX_LINES]:
        size = len(line.encode("utf-8")) + (1 if shown else 0)
        if used + size > _MAX_BYTES:
            truncated_by = "bytes"
            break
        shown.append(line)
        used += size
    suffix = f" ({_size(_MAX_BYTES)} limit)" if truncated_by == "bytes" else ""
    last = start + len(shown)
    return ("\n".join(shown)
            + f"\n\n[Showing lines {start + 1}-{last} of {len(all_lines)}{suffix}. Use offset={last + 1} to continue.]")
