from __future__ import annotations

import hashlib
import mimetypes
import shutil
from pathlib import Path

from ..models import SearchRequest, SearchResult
from ..security import safe_workspace_dir
from .base import SourceSpec

TEXT_EXTENSIONS = {
    ".md", ".markdown", ".txt", ".rst", ".tex", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".toml",
    ".ini", ".cfg", ".conf", ".env", ".log", ".sql", ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java",
    ".kt",
    ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".rb", ".php", ".swift", ".sh", ".bash", ".zsh", ".ps1",
    ".css", ".scss", ".less", ".vue", ".svelte", ".graphql", ".proto", ".html", ".htm",
}
# Formats the document parsing service handles natively. Anything else under attachments is an
# unrecognised binary the user chose to keep as an original; it is never offered as a source.
PARSE_EXTENSIONS = {".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm"}
DURABLE_SOURCES_README_PREFIX = "# Durable Sources"


class UserDocumentsSource:
    def __init__(self, allowed_roots: tuple[Path, ...]) -> None:
        self.allowed_roots = allowed_roots

    async def search(self, request: SearchRequest) -> list[SearchResult]:
        if not request.workspace_dir:
            from ..errors import ServiceError

            raise ServiceError(
                "workspace_required",
                "workspace_dir is required for user_documents",
                status_code=400,
                provider="user_documents",
            )
        workspace_dir = safe_workspace_dir(request.workspace_dir, self.allowed_roots)
        terms = [term for term in split_terms(request.query) if len(term) >= 2]
        scored: list[tuple[int, SearchResult]] = []
        for path, artifact_path in list_user_documents(workspace_dir, 500):
            sha256, materialized = materialize(workspace_dir, path)
            snippet = ""
            if path.suffix.lower() in TEXT_EXTENSIONS and path.stat().st_size <= 5 * 1024 * 1024:
                snippet = " ".join(path.read_text("utf-8", errors="replace")[:4_000].split())
            haystack = f"{artifact_path}\n{snippet}".lower()
            score = sum(term in haystack for term in terms)
            if score == 0 and terms:
                continue
            media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            scored.append(
                (
                    score,
                    SearchResult(
                        id=f"user_documents-{sha256[:32]}",
                        title=path.name,
                        url=f"https://workspace.local/user-documents/{sha256}/{path.name}",
                        snippet=snippet,
                        metadata={
                            "provider_implementation": "workspace_user_documents_v1",
                            "reliability_tier": "user_supplied",
                            "relative_path": artifact_path,
                            "artifact_path": artifact_path,
                            "provider_artifact_path": str(materialized),
                            "provider_artifact_media_type": media_type,
                            "content_sha256": sha256,
                        },
                    ),
                )
            )
        scored.sort(key=lambda item: (-item[0], item[1].title.casefold()))
        return [result for _, result in scored[: request.max_results]]


def split_terms(query: str) -> list[str]:
    import re

    return [term.lower() for term in re.split(r"[^\w]+", query, flags=re.UNICODE) if term]


def workspace_wiki_dir(workspace_dir: Path) -> Path:
    return workspace_dir.parent.parent if workspace_dir.parent.name == "runs" else workspace_dir


def list_user_documents(workspace_dir: Path, limit: int) -> list[tuple[Path, str]]:
    wiki_dir = workspace_wiki_dir(workspace_dir)
    goal_dir = wiki_dir.parent
    roots = ((goal_dir / "attachments", "attachments"), (wiki_dir / "sources", "wiki/sources"))
    result: list[tuple[Path, str]] = []
    seen: set[Path] = set()
    for root, prefix in roots:
        if not root.is_dir():
            continue
        real_root = root.resolve()
        for path in sorted(real_root.rglob("*")):
            if len(result) >= limit:
                return result
            if path.is_symlink() or not path.is_file():
                continue
            real_path = path.resolve()
            if not real_path.is_relative_to(real_root) or real_path in seen or is_generated_readme(real_path):
                continue
            if real_path.suffix.lower() not in TEXT_EXTENSIONS and real_path.suffix.lower() not in PARSE_EXTENSIONS:
                continue
            seen.add(real_path)
            result.append((real_path, f"{prefix}/{real_path.relative_to(real_root).as_posix()}"))
    return result


def is_generated_readme(path: Path) -> bool:
    if path.name.casefold() != "readme.md":
        return False
    try:
        return path.read_text("utf-8").lstrip().startswith(DURABLE_SOURCES_README_PREFIX)
    except OSError:
        return False


def materialize(workspace_dir: Path, source: Path) -> tuple[str, Path]:
    content = source.read_bytes()
    sha256 = hashlib.sha256(content).hexdigest()
    target_dir = workspace_dir / "artifacts" / "provider-plugins" / "user_documents" / sha256
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / source.name
    if not target.exists():
        shutil.copyfile(source, target)
    return sha256, target.resolve()


SPECS = (
    SourceSpec(
        id="user_documents",
        build=lambda deps: UserDocumentsSource(deps.settings.resolved_workspace_roots()),
        max_concurrency=lambda settings: settings.user_documents_max_concurrency,
    ),
)
