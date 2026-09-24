"""Pinned, shared-cache assets for the portable local Qwen ASR and TTS installs."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import shutil
import tempfile
import time
import fcntl
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Literal, Sequence

from environment import audio_env


DEFAULT_ASR_MODEL_ID = "Qwen3-ASR-0.6B-MLX-4bit"
DEFAULT_ASR_MODEL_DIRECTORY = (
    "Qwen3-ASR-0.6B-MLX-4bit-bc441bd1"
)
DEFAULT_TTS_MODEL_ID = "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
DEFAULT_TTS_MODEL_DIRECTORY = (
    "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit-049ef77f"
)
INSTALL_MANIFEST_NAME = "telomi-audio-model.json"


@dataclass(frozen=True)
class ModelAsset:
    filename: str
    repo_id: str
    revision: str
    size: int
    sha256: str

    def as_dict(self) -> dict[str, str | int]:
        return asdict(self)


PINNED_ASR_ASSETS: tuple[ModelAsset, ...] = (
    ModelAsset(
        "README.md",
        "aufklarer/Qwen3-ASR-0.6B-MLX-4bit",
        "bc441bd1e4295c1f42d9879f056049a925b6e013",
        1065,
        "225f13ecdd9a64c642b685a0fcfecb4c533856d4add4cc6eff0d18c3f1724f9c",
    ),
    ModelAsset(
        "config.json",
        "aufklarer/Qwen3-ASR-0.6B-MLX-4bit",
        "bc441bd1e4295c1f42d9879f056049a925b6e013",
        7187,
        "923618cf5ca452fda0253a6be5c1a17f94a2e4851d3b98beb45848565587bd72",
    ),
    ModelAsset(
        "merges.txt",
        "aufklarer/Qwen3-ASR-0.6B-MLX-4bit",
        "bc441bd1e4295c1f42d9879f056049a925b6e013",
        1671853,
        "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
    ),
    ModelAsset(
        "model.safetensors",
        "aufklarer/Qwen3-ASR-0.6B-MLX-4bit",
        "bc441bd1e4295c1f42d9879f056049a925b6e013",
        708236945,
        "70c7e67e588062adce4f10796e47ad42ead51c6671eda61a0987eae38ca95ddf",
    ),
    ModelAsset(
        "model.safetensors.index.json",
        "aufklarer/Qwen3-ASR-0.6B-MLX-4bit",
        "bc441bd1e4295c1f42d9879f056049a925b6e013",
        71814,
        "e3bb80ef0fd42a5be07b04e90c97d60460bbde8af3531e0bfe9100a61404d81a",
    ),
    ModelAsset(
        "tokenizer_config.json",
        "aufklarer/Qwen3-ASR-0.6B-MLX-4bit",
        "bc441bd1e4295c1f42d9879f056049a925b6e013",
        12487,
        "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
    ),
    ModelAsset(
        "vocab.json",
        "aufklarer/Qwen3-ASR-0.6B-MLX-4bit",
        "bc441bd1e4295c1f42d9879f056049a925b6e013",
        2776833,
        "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
    ),
    # The quantized repository omits this file, but mlx-audio 0.4.3 requires
    # it. Pin the matching official base-model asset instead of generating it.
    ModelAsset(
        "preprocessor_config.json",
        "Qwen/Qwen3-ASR-0.6B",
        "5eb144179a02acc5e5ba31e748d22b0cf3e303b0",
        330,
        "45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d",
    ),
)


PINNED_TTS_ASSETS: tuple[ModelAsset, ...] = (
    ModelAsset(
        "config.json",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        6058,
        "2eea3665564268139c3beb8d497fd3c2e4524e9eed5452836cdf1de96ed3cdbd",
    ),
    ModelAsset(
        "generation_config.json",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        245,
        "f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa",
    ),
    ModelAsset(
        "merges.txt",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        1671839,
        "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3",
    ),
    ModelAsset(
        "model.safetensors",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        1286743170,
        "3bcb2c4a127e6243e81a30b7126c7865f686d3559de4f938e5d3b150c6a9560d",
    ),
    ModelAsset(
        "model.safetensors.index.json",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        71447,
        "0c92041960fa189cf35ae538c8d9ca07c468edddd0c9bb52274c5d4d287a860b",
    ),
    ModelAsset(
        "preprocessor_config.json",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        127,
        "efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119",
    ),
    ModelAsset(
        "speech_tokenizer/config.json",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        2336,
        "ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167",
    ),
    ModelAsset(
        "speech_tokenizer/configuration.json",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        76,
        "6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd",
    ),
    ModelAsset(
        "speech_tokenizer/model.safetensors",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        682293092,
        "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
    ),
    ModelAsset(
        "speech_tokenizer/preprocessor_config.json",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        234,
        "fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb",
    ),
    ModelAsset(
        "tokenizer_config.json",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        7344,
        "dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670",
    ),
    ModelAsset(
        "vocab.json",
        "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
        "049ef77fe8816b536193c0c25f9a214d17921282",
        2776833,
        "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
    ),
)


InstallStage = Literal[
    "not_installed",
    "downloading",
    "validating",
    "ready",
    "invalid",
    "failed",
]


@dataclass(frozen=True)
class ModelInspection:
    stage: InstallStage
    ready: bool
    detail: str


DownloadAsset = Callable[[ModelAsset, Path], Path]
DiskFree = Callable[[Path], int]
MIN_INSTALL_HEADROOM_BYTES = 64 * 1024 * 1024


def default_asr_model_path() -> Path:
    configured = audio_env("TELOMI_AUDIO_ASR_MODEL_PATH", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (
        Path.home()
        / ".cache"
        / "telomi-audio"
        / "models"
        / DEFAULT_ASR_MODEL_DIRECTORY
    )


def default_tts_model_path() -> Path:
    configured = audio_env("TELOMI_AUDIO_TTS_MODEL_PATH", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (
        Path.home()
        / ".cache"
        / "telomi-audio"
        / "models"
        / DEFAULT_TTS_MODEL_DIRECTORY
    )


def default_huggingface_cache_dir() -> Path:
    configured = audio_env("TELOMI_AUDIO_HF_CACHE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".cache" / "telomi-audio" / "huggingface"


def default_install_status_path() -> Path:
    configured = audio_env("TELOMI_AUDIO_ASR_INSTALL_STATUS", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".cache" / "telomi-audio" / "state" / "asr-install.json"


def default_tts_install_status_path() -> Path:
    configured = audio_env("TELOMI_AUDIO_TTS_INSTALL_STATUS", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / ".cache" / "telomi-audio" / "state" / "tts-install.json"


def read_install_status(status_path: Path | None = None) -> dict[str, object]:
    path = (status_path or default_install_status_path()).expanduser().resolve()
    return _read_install_status(
        path,
        model_id=DEFAULT_ASR_MODEL_ID,
        assets=PINNED_ASR_ASSETS,
        label="local ASR",
    )


def read_tts_install_status(status_path: Path | None = None) -> dict[str, object]:
    path = (status_path or default_tts_install_status_path()).expanduser().resolve()
    return _read_install_status(
        path,
        model_id=DEFAULT_TTS_MODEL_ID,
        assets=PINNED_TTS_ASSETS,
        label="local TTS",
    )


def _read_install_status(
    path: Path,
    *,
    model_id: str,
    assets: Sequence[ModelAsset],
    label: str,
) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text("utf-8"))
        if (
            not isinstance(payload, dict)
            or payload.get("schema_version") != 1
            or payload.get("model_id") != model_id
            or payload.get("stage")
            not in {
                "not_installed",
                "downloading",
                "validating",
                "ready",
                "invalid",
                "failed",
            }
        ):
            raise ValueError("invalid install status")
        return payload
    except (OSError, ValueError, json.JSONDecodeError):
        return {
            "schema_version": 1,
            "model_id": model_id,
            "stage": "not_installed",
            "detail": f"{label} install status is unavailable",
            "completed_files": 0,
            "total_files": len(assets),
            "updated_at_unix_ms": 0,
        }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _missing_verified_cache_bytes(
    cache_dir: Path,
    assets: Sequence[ModelAsset],
) -> int:
    missing = {
        (asset.size, asset.sha256): asset.size
        for asset in assets
    }
    seen_files: set[tuple[int, int]] = set()
    try:
        candidates = cache_dir.rglob("*")
        for candidate in candidates:
            try:
                if not candidate.is_file():
                    continue
                resolved = candidate.resolve()
                stat = resolved.stat()
                identity = (stat.st_dev, stat.st_ino)
                if identity in seen_files:
                    continue
                seen_files.add(identity)
                possible = [key for key in missing if key[0] == stat.st_size]
                if not possible:
                    continue
                digest = sha256_file(resolved)
                for key in possible:
                    if key[1] == digest:
                        missing.pop(key, None)
            except OSError:
                continue
    except OSError:
        pass
    return sum(missing.values())


def _validate_asset(path: Path, asset: ModelAsset) -> None:
    if not path.is_file():
        raise ValueError(f"missing model asset: {asset.filename}")
    actual_size = path.stat().st_size
    if actual_size != asset.size:
        raise ValueError(
            f"model asset size mismatch for {asset.filename}: "
            f"expected {asset.size}, received {actual_size}"
        )
    actual_sha256 = sha256_file(path)
    if actual_sha256 != asset.sha256:
        raise ValueError(f"model asset SHA-256 mismatch for {asset.filename}")


def inspect_asr_model(
    model_path: Path | None = None,
    *,
    assets: Sequence[ModelAsset] = PINNED_ASR_ASSETS,
) -> ModelInspection:
    target = (model_path or default_asr_model_path()).expanduser().resolve()
    return _inspect_model(
        target,
        model_id=DEFAULT_ASR_MODEL_ID,
        label="local ASR",
        assets=assets,
    )


def inspect_tts_model(
    model_path: Path | None = None,
    *,
    assets: Sequence[ModelAsset] = PINNED_TTS_ASSETS,
) -> ModelInspection:
    target = (model_path or default_tts_model_path()).expanduser().resolve()
    return _inspect_model(
        target,
        model_id=DEFAULT_TTS_MODEL_ID,
        label="local TTS",
        assets=assets,
    )


def _inspect_model(
    target: Path,
    *,
    model_id: str,
    label: str,
    assets: Sequence[ModelAsset],
) -> ModelInspection:
    if not target.exists():
        return ModelInspection("not_installed", False, f"{label} model is not installed")
    if not target.is_dir():
        return ModelInspection("invalid", False, f"{label} model path is not a directory")
    try:
        for asset in assets:
            _validate_asset(target / asset.filename, asset)
        manifest = json.loads((target / INSTALL_MANIFEST_NAME).read_text("utf-8"))
        expected_assets = [asset.as_dict() for asset in assets]
        if (
            manifest.get("schema_version") != 1
            or manifest.get("model_id") != model_id
            or manifest.get("assets") != expected_assets
        ):
            raise ValueError("model install manifest does not match the pinned assets")
    except (OSError, ValueError, json.JSONDecodeError):
        return ModelInspection("invalid", False, f"{label} model failed validation")
    return ModelInspection("ready", True, f"{label} model is installed and verified")


def _download_from_huggingface(asset: ModelAsset, cache_dir: Path) -> Path:
    from huggingface_hub import hf_hub_download

    for force_download in (False, True):
        downloaded = Path(
            hf_hub_download(
                repo_id=asset.repo_id,
                filename=asset.filename,
                revision=asset.revision,
                cache_dir=str(cache_dir),
                force_download=force_download,
            )
        ).resolve()
        try:
            _validate_asset(downloaded, asset)
            return downloaded
        except ValueError:
            if force_download:
                raise
    raise AssertionError("unreachable Hugging Face download state")


def _write_status(
    status_path: Path,
    stage: InstallStage,
    detail: str,
    *,
    completed_files: int,
    total_files: int,
    model_id: str = DEFAULT_ASR_MODEL_ID,
) -> None:
    status_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "model_id": model_id,
        "stage": stage,
        "detail": detail,
        "completed_files": completed_files,
        "total_files": total_files,
        "updated_at_unix_ms": int(time.time() * 1000),
    }
    fd, temporary_name = tempfile.mkstemp(
        dir=status_path.parent,
        prefix=f".{status_path.name}.",
        suffix=".tmp",
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, status_path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_install_manifest(
    directory: Path,
    assets: Sequence[ModelAsset],
    *,
    model_id: str = DEFAULT_ASR_MODEL_ID,
) -> None:
    payload = {
        "schema_version": 1,
        "model_id": model_id,
        "assets": [asset.as_dict() for asset in assets],
    }
    (directory / INSTALL_MANIFEST_NAME).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def ensure_asr_model(
    model_path: Path | None = None,
    *,
    cache_dir: Path | None = None,
    status_path: Path | None = None,
    assets: Sequence[ModelAsset] = PINNED_ASR_ASSETS,
    download: DownloadAsset = _download_from_huggingface,
    disk_free: DiskFree = lambda path: shutil.disk_usage(path).free,
) -> Path:
    replace_invalid_managed_model = (
        model_path is None
        and not audio_env("TELOMI_AUDIO_ASR_MODEL_PATH", "").strip()
    )
    target = (model_path or default_asr_model_path()).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.parent / f".{target.name}.install.lock"
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        return _ensure_model_locked(
            target,
            cache_dir=cache_dir,
            status_path=status_path,
            assets=assets,
            download=download,
            replace_invalid_managed_model=replace_invalid_managed_model,
            disk_free=disk_free,
            model_id=DEFAULT_ASR_MODEL_ID,
            label="local ASR",
            path_variable="TELOMI_AUDIO_ASR_MODEL_PATH",
            inspect=inspect_asr_model,
        )


def ensure_tts_model(
    model_path: Path | None = None,
    *,
    cache_dir: Path | None = None,
    status_path: Path | None = None,
    assets: Sequence[ModelAsset] = PINNED_TTS_ASSETS,
    download: DownloadAsset = _download_from_huggingface,
    disk_free: DiskFree = lambda path: shutil.disk_usage(path).free,
) -> Path:
    replace_invalid_managed_model = (
        model_path is None
        and not audio_env("TELOMI_AUDIO_TTS_MODEL_PATH", "").strip()
    )
    target = (model_path or default_tts_model_path()).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.parent / f".{target.name}.install.lock"
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        return _ensure_model_locked(
            target,
            cache_dir=cache_dir,
            status_path=status_path or default_tts_install_status_path(),
            assets=assets,
            download=download,
            replace_invalid_managed_model=replace_invalid_managed_model,
            disk_free=disk_free,
            model_id=DEFAULT_TTS_MODEL_ID,
            label="local TTS",
            path_variable="TELOMI_AUDIO_TTS_MODEL_PATH",
            inspect=inspect_tts_model,
        )


def _ensure_model_locked(
    target: Path,
    *,
    cache_dir: Path | None,
    status_path: Path | None,
    assets: Sequence[ModelAsset],
    download: DownloadAsset,
    replace_invalid_managed_model: bool,
    disk_free: DiskFree,
    model_id: str,
    label: str,
    path_variable: str,
    inspect: Callable[..., ModelInspection],
) -> Path:
    cache = (cache_dir or default_huggingface_cache_dir()).expanduser().resolve()
    status = (status_path or default_install_status_path()).expanduser().resolve()
    total = len(assets)

    existing = inspect(target, assets=assets)
    if existing.ready:
        _write_status(
            status,
            "ready",
            existing.detail,
            completed_files=total,
            total_files=total,
            model_id=model_id,
        )
        return target

    cache.mkdir(parents=True, exist_ok=True)
    missing_cache_bytes = _missing_verified_cache_bytes(cache, assets)
    required_bytes = (
        missing_cache_bytes + MIN_INSTALL_HEADROOM_BYTES
        if missing_cache_bytes > 0
        else 0
    )
    available_bytes = disk_free(cache)
    if available_bytes < required_bytes:
        detail = (
            f"insufficient disk space for {label} model: "
            f"need {required_bytes} bytes, available {available_bytes} bytes"
        )
        _write_status(
            status,
            "failed",
            detail,
            completed_files=0,
            total_files=total,
            model_id=model_id,
        )
        raise OSError(errno.ENOSPC, detail)

    invalid_backup: Path | None = None
    if target.exists():
        _write_status(
            status,
            "invalid",
            f"existing {label} model failed validation",
            completed_files=0,
            total_files=total,
            model_id=model_id,
        )
        if not replace_invalid_managed_model:
            raise ValueError(
                f"existing {label} model failed validation; remove or override "
                f"{path_variable} before reinstalling"
            )
        invalid_backup = target.parent / (
            f".{target.name}.invalid-{os.getpid()}-{time.time_ns()}"
        )
        os.replace(target, invalid_backup)
    temporary = Path(
        tempfile.mkdtemp(dir=target.parent, prefix=f".{target.name}.install-")
    )
    completed_files = 0
    try:
        for index, asset in enumerate(assets):
            _write_status(
                status,
                "downloading",
                f"fetching pinned {label} model asset {index + 1}/{total}",
                completed_files=index,
                total_files=total,
                model_id=model_id,
            )
            downloaded = download(asset, cache).expanduser().resolve()
            _validate_asset(downloaded, asset)
            link = temporary / asset.filename
            link.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(downloaded, link)
            completed_files = index + 1

        _write_install_manifest(temporary, assets, model_id=model_id)
        _write_status(
            status,
            "validating",
            f"validating pinned {label} model",
            completed_files=total,
            total_files=total,
            model_id=model_id,
        )
        inspection = inspect(temporary, assets=assets)
        if not inspection.ready:
            raise ValueError(inspection.detail)
        os.replace(temporary, target)
        if invalid_backup is not None:
            _remove_path(invalid_backup)
        _write_status(
            status,
            "ready",
            f"{label} model is installed and verified",
            completed_files=total,
            total_files=total,
            model_id=model_id,
        )
        return target
    except Exception:
        if invalid_backup is not None and invalid_backup.exists() and not target.exists():
            os.replace(invalid_backup, target)
        _write_status(
            status,
            "failed",
            f"{label} model installation failed validation or download",
            completed_files=completed_files,
            total_files=total,
            model_id=model_id,
        )
        raise
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)
