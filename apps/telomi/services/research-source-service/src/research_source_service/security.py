from __future__ import annotations

import hmac
from pathlib import Path

from fastapi import Header

from .errors import ServiceError


def require_api_token(expected: str):
    async def dependency(
        authorization: str | None = Header(default=None),
        x_source_service_token: str | None = Header(default=None),
    ) -> None:
        bearer = None
        if authorization:
            scheme, _, credentials = authorization.partition(" ")
            if scheme.lower() == "bearer" and credentials:
                bearer = credentials
        supplied = bearer or x_source_service_token
        if not supplied or not hmac.compare_digest(supplied, expected):
            raise ServiceError("unauthorized", "Valid source service credentials are required", status_code=401)

    return dependency


# 服务自身的包目录。任何 workspace_dir 落进这里都意味着下载会污染代码树——
# 这是配置错误，不是合法用法，所以无条件拒绝，不依赖 allowed_roots 的配置。
_SERVICE_TREE = Path(__file__).resolve().parents[2]


def safe_workspace_dir(workspace_dir: str, allowed_roots: tuple[Path, ...]) -> Path:
    if not allowed_roots:
        raise ServiceError(
            "workspace_access_disabled",
            "Local workspace access is disabled because no workspace roots are configured",
            status_code=403,
        )
    try:
        candidate = Path(workspace_dir).expanduser().resolve(strict=True)
    except OSError as error:
        raise ServiceError(
            "invalid_workspace", "workspace_dir must be an existing directory", status_code=400
        ) from error
    if not candidate.is_dir():
        raise ServiceError("invalid_workspace", "workspace_dir must be a directory", status_code=400)
    if candidate.is_relative_to(_SERVICE_TREE):
        raise ServiceError(
            "workspace_inside_service_tree",
            f"workspace_dir must not be inside the source service package tree ({_SERVICE_TREE}); "
            "downloads would land in the repository instead of the configured data directory",
            status_code=400,
        )
    if not any(candidate.is_relative_to(root) for root in allowed_roots):
        raise ServiceError(
            "workspace_outside_allowed_roots", "workspace_dir is outside configured roots", status_code=403
        )
    return candidate


def safe_local_file(input_path: str, input_root: Path) -> Path:
    raw = Path(input_path).expanduser()
    lexical = input_root / raw if not raw.is_absolute() else raw
    try:
        candidate = lexical.resolve(strict=True)
    except OSError as error:
        raise ServiceError("invalid_document", "Local input is not a readable file", status_code=400) from error
    if not candidate.is_relative_to(input_root):
        raise ServiceError("path_outside_input_root", "Local input is outside input_root", status_code=403)
    current = lexical.absolute()
    while True:
        if current.is_symlink():
            raise ServiceError("symlink_not_allowed", "Document input cannot contain symlinks", status_code=403)
        try:
            if current.resolve(strict=True) == input_root:
                break
        except OSError as error:
            raise ServiceError("invalid_document", "Local input is not a readable file", status_code=400) from error
        if current.parent == current:
            raise ServiceError("path_outside_input_root", "Local input is outside input_root", status_code=403)
        current = current.parent
    if not candidate.is_file():
        raise ServiceError("invalid_document", "Local input must be a readable file", status_code=400)
    return candidate


def safe_output_dir(output_dir: str, input_root: Path) -> Path:
    raw = Path(output_dir)
    if raw.is_absolute():
        raise ServiceError("invalid_asset_output", "asset_output_dir must be relative to input_root", status_code=400)
    lexical = (input_root / raw).absolute()
    candidate = lexical.resolve()
    if candidate == input_root or not candidate.is_relative_to(input_root):
        raise ServiceError("invalid_asset_output", "asset_output_dir must stay inside input_root", status_code=403)
    current = lexical
    while current != input_root:
        if current.exists() and current.is_symlink():
            raise ServiceError("symlink_not_allowed", "asset_output_dir cannot contain symlinks", status_code=403)
        current = current.parent
    candidate.mkdir(parents=True, exist_ok=True)
    if not candidate.is_dir():
        raise ServiceError("invalid_asset_output", "asset_output_dir must be a directory", status_code=400)
    return candidate
