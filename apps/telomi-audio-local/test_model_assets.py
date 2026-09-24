import json
import os
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

import model_assets


def _asset(name: str, content: bytes) -> model_assets.ModelAsset:
    return model_assets.ModelAsset(
        filename=name,
        repo_id="example/model",
        revision="0123456789abcdef0123456789abcdef01234567",
        size=len(content),
        sha256=sha256(content).hexdigest(),
    )


class ModelAssetTests(unittest.TestCase):
    def test_default_model_path_is_portable_and_home_scoped(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(
            os.environ,
            {"HOME": home},
            clear=False,
        ):
            path = model_assets.default_asr_model_path()

        self.assertEqual(
            path,
            Path(home)
            / ".cache"
            / "telomi-audio"
            / "models"
            / model_assets.DEFAULT_ASR_MODEL_DIRECTORY,
        )
        self.assertNotIn("/Volumes/", str(path))

    def test_missing_model_reports_not_installed(self):
        with tempfile.TemporaryDirectory() as root:
            result = model_assets.inspect_asr_model(Path(root) / "missing")

        self.assertEqual(result.stage, "not_installed")
        self.assertFalse(result.ready)

    def test_missing_or_malformed_install_status_is_safe(self):
        with tempfile.TemporaryDirectory() as root:
            status_path = Path(root) / "status.json"
            missing = model_assets.read_install_status(status_path)
            status_path.write_text("[]", encoding="utf-8")
            malformed = model_assets.read_install_status(status_path)

        self.assertEqual(missing["stage"], "not_installed")
        self.assertEqual(malformed["stage"], "not_installed")

    def test_install_composes_verified_cached_files_with_symlinks(self):
        contents = {
            "config.json": b'{"model_type":"test"}',
            "model.safetensors": b"model-weights",
            "preprocessor_config.json": b'{"feature_size":128}',
        }
        assets = tuple(_asset(name, content) for name, content in contents.items())
        downloads = 0

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source_dir = root_path / "hub"
            source_dir.mkdir()
            for name, content in contents.items():
                (source_dir / name).write_bytes(content)

            def download(asset: model_assets.ModelAsset, _cache_dir: Path) -> Path:
                nonlocal downloads
                downloads += 1
                return source_dir / asset.filename

            target = root_path / "model"
            status_path = root_path / "install-status.json"
            installed = model_assets.ensure_asr_model(
                target,
                cache_dir=root_path / "cache",
                status_path=status_path,
                assets=assets,
                download=download,
            )

            self.assertEqual(installed, target.resolve())
            self.assertEqual(downloads, len(assets))
            for name, content in contents.items():
                linked = target / name
                self.assertTrue(linked.is_symlink())
                self.assertEqual(linked.read_bytes(), content)
            manifest = json.loads(
                (target / model_assets.INSTALL_MANIFEST_NAME).read_text("utf-8")
            )
            self.assertEqual(manifest["schema_version"], 1)
            self.assertEqual(manifest["model_id"], model_assets.DEFAULT_ASR_MODEL_ID)
            self.assertEqual(manifest["assets"], [asset.as_dict() for asset in assets])
            self.assertEqual(
                json.loads(status_path.read_text("utf-8"))["stage"],
                "ready",
            )
            self.assertTrue(model_assets.inspect_asr_model(target, assets=assets).ready)

            reused = model_assets.ensure_asr_model(
                target,
                cache_dir=root_path / "cache",
                status_path=status_path,
                assets=assets,
                download=lambda *_args: self.fail("ready model should reuse cache"),
            )

            self.assertEqual(reused, target.resolve())

    def test_tts_install_links_nested_assets_and_reports_its_own_status(self):
        contents = {
            "config.json": b'{"model_type":"qwen3_tts"}',
            "speech_tokenizer/model.safetensors": b"tokenizer-weights",
        }
        assets = tuple(_asset(name, content) for name, content in contents.items())

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source_dir = root_path / "hub"
            for name, content in contents.items():
                (source_dir / name).parent.mkdir(parents=True, exist_ok=True)
                (source_dir / name).write_bytes(content)
            target = root_path / "tts"
            status_path = root_path / "tts-install.json"

            installed = model_assets.ensure_tts_model(
                target,
                cache_dir=root_path / "cache",
                status_path=status_path,
                assets=assets,
                download=lambda asset, _cache: source_dir / asset.filename,
            )

            self.assertEqual(
                (installed / "speech_tokenizer/model.safetensors").read_bytes(),
                b"tokenizer-weights",
            )
            self.assertTrue(model_assets.inspect_tts_model(target, assets=assets).ready)
            status = model_assets.read_tts_install_status(status_path)
            self.assertEqual(status["stage"], "ready")
            self.assertEqual(status["model_id"], model_assets.DEFAULT_TTS_MODEL_ID)

    def test_pinned_tts_assets_are_the_complete_model_from_one_revision(self):
        self.assertEqual(
            {asset.filename for asset in model_assets.PINNED_TTS_ASSETS},
            {
                "config.json",
                "generation_config.json",
                "merges.txt",
                "model.safetensors",
                "model.safetensors.index.json",
                "preprocessor_config.json",
                "speech_tokenizer/config.json",
                "speech_tokenizer/configuration.json",
                "speech_tokenizer/model.safetensors",
                "speech_tokenizer/preprocessor_config.json",
                "tokenizer_config.json",
                "vocab.json",
            },
        )
        revisions = {asset.revision[:8] for asset in model_assets.PINNED_TTS_ASSETS}
        self.assertEqual(len(revisions), 1)
        self.assertTrue(model_assets.DEFAULT_TTS_MODEL_DIRECTORY.endswith(revisions.pop()))

    def test_corrupted_download_never_becomes_the_active_model(self):
        expected = _asset("model.safetensors", b"expected")

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            corrupt = root_path / "corrupt.bin"
            corrupt.write_bytes(b"wrong")
            target = root_path / "model"
            status_path = root_path / "install-status.json"

            with self.assertRaisesRegex(ValueError, "size mismatch"):
                model_assets.ensure_asr_model(
                    target,
                    cache_dir=root_path / "cache",
                    status_path=status_path,
                    assets=(expected,),
                    download=lambda *_args: corrupt,
                )

            self.assertFalse(target.exists())
            status = json.loads(status_path.read_text("utf-8"))
            self.assertEqual(status["stage"], "failed")
            self.assertNotIn(str(corrupt), status["detail"])

    def test_retry_replaces_an_invalid_default_managed_model_atomically(self):
        expected_content = b"verified-model"
        expected = _asset("model.safetensors", expected_content)

        with tempfile.TemporaryDirectory() as home, patch.dict(
            os.environ,
            {"HOME": home},
            clear=False,
        ):
            target = model_assets.default_asr_model_path()
            target.mkdir(parents=True)
            (target / "model.safetensors").write_bytes(b"corrupt")
            status_path = Path(home) / "install-status.json"
            source = Path(home) / "verified.safetensors"
            source.write_bytes(expected_content)

            installed = model_assets.ensure_asr_model(
                cache_dir=Path(home) / "hub",
                status_path=status_path,
                assets=(expected,),
                download=lambda *_args: source,
            )

            self.assertEqual(installed, target.resolve())
            self.assertEqual((installed / expected.filename).read_bytes(), expected_content)
            self.assertTrue(
                model_assets.inspect_asr_model(installed, assets=(expected,)).ready
            )
            self.assertEqual(
                json.loads(status_path.read_text("utf-8"))["stage"],
                "ready",
            )
            self.assertEqual(
                list(target.parent.glob(f".{target.name}.invalid-*")),
                [],
            )

    def test_retry_never_replaces_an_invalid_explicit_model_path(self):
        expected = _asset("model.safetensors", b"expected")

        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "external-model"
            target.mkdir()
            corrupt = target / "model.safetensors"
            corrupt.write_bytes(b"user-owned-corrupt")

            with self.assertRaisesRegex(ValueError, "existing local ASR model"):
                model_assets.ensure_asr_model(
                    target,
                    cache_dir=Path(root) / "hub",
                    status_path=Path(root) / "install-status.json",
                    assets=(expected,),
                    download=lambda *_args: self.fail(
                        "an explicit invalid model must not be replaced"
                    ),
                )

            self.assertEqual(corrupt.read_bytes(), b"user-owned-corrupt")

    def test_corrupted_huggingface_cache_is_forced_to_redownload_once(self):
        expected_content = b"verified-model"
        expected = _asset("model.safetensors", expected_content)

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            cache = root_path / "hub"
            cache.mkdir()
            cached = cache / "cached-model.safetensors"
            cached.write_bytes(b"corrupt")
            force_downloads = []

            def fake_hf_hub_download(**kwargs):
                force_download = kwargs.get("force_download", False)
                force_downloads.append(force_download)
                if force_download:
                    cached.write_bytes(expected_content)
                return str(cached)

            with patch(
                "huggingface_hub.hf_hub_download",
                side_effect=fake_hf_hub_download,
            ):
                installed = model_assets.ensure_asr_model(
                    root_path / "model",
                    cache_dir=cache,
                    status_path=root_path / "install-status.json",
                    assets=(expected,),
                )

            self.assertEqual(force_downloads, [False, True])
            self.assertEqual(
                (installed / expected.filename).read_bytes(),
                expected_content,
            )
            self.assertTrue(
                model_assets.inspect_asr_model(installed, assets=(expected,)).ready
            )

    def test_network_failure_preserves_progress_and_the_next_retry_recovers(self):
        contents = {
            "config.json": b"verified-config",
            "model.safetensors": b"verified-model",
        }
        assets = tuple(_asset(name, content) for name, content in contents.items())

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            sources = root_path / "sources"
            sources.mkdir()
            for name, content in contents.items():
                (sources / name).write_bytes(content)
            target = root_path / "model"
            status_path = root_path / "install-status.json"
            network_available = False

            def download(asset: model_assets.ModelAsset, _cache_dir: Path) -> Path:
                if asset.filename == "model.safetensors" and not network_available:
                    raise ConnectionError("offline")
                return sources / asset.filename

            with self.assertRaisesRegex(ConnectionError, "offline"):
                model_assets.ensure_asr_model(
                    target,
                    cache_dir=root_path / "hub",
                    status_path=status_path,
                    assets=assets,
                    download=download,
                )

            failed = json.loads(status_path.read_text("utf-8"))
            self.assertEqual(failed["stage"], "failed")
            self.assertEqual(failed["completed_files"], 1)
            self.assertFalse(target.exists())

            network_available = True
            installed = model_assets.ensure_asr_model(
                target,
                cache_dir=root_path / "hub",
                status_path=status_path,
                assets=assets,
                download=download,
            )

            self.assertTrue(model_assets.inspect_asr_model(installed, assets=assets).ready)
            ready = json.loads(status_path.read_text("utf-8"))
            self.assertEqual(ready["stage"], "ready")
            self.assertEqual(ready["completed_files"], 2)

    def test_insufficient_disk_space_fails_before_download_and_retry_recovers(self):
        expected_content = b"verified-model"
        expected = _asset("model.safetensors", expected_content)

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source = root_path / "verified.safetensors"
            source.write_bytes(expected_content)
            target = root_path / "model"
            status_path = root_path / "install-status.json"
            available_bytes = 0
            downloads = 0

            def download(_asset, _cache_dir):
                nonlocal downloads
                downloads += 1
                return source

            with self.assertRaisesRegex(OSError, "insufficient disk space"):
                model_assets.ensure_asr_model(
                    target,
                    cache_dir=root_path / "hub",
                    status_path=status_path,
                    assets=(expected,),
                    download=download,
                    disk_free=lambda _path: available_bytes,
                )

            self.assertEqual(downloads, 0)
            self.assertFalse(target.exists())
            failed = json.loads(status_path.read_text("utf-8"))
            self.assertEqual(failed["stage"], "failed")

            available_bytes = 1024 * 1024 * 1024
            installed = model_assets.ensure_asr_model(
                target,
                cache_dir=root_path / "hub",
                status_path=status_path,
                assets=(expected,),
                download=download,
                disk_free=lambda _path: available_bytes,
            )

            self.assertEqual(downloads, 1)
            self.assertTrue(model_assets.inspect_asr_model(installed, assets=(expected,)).ready)

    def test_verified_cache_does_not_require_model_sized_free_space(self):
        expected_content = b"verified-model"
        expected = _asset("model.safetensors", expected_content)

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            cache = root_path / "hub"
            cache.mkdir()
            cached = cache / "verified-model.blob"
            cached.write_bytes(expected_content)

            installed = model_assets.ensure_asr_model(
                root_path / "model",
                cache_dir=cache,
                status_path=root_path / "install-status.json",
                assets=(expected,),
                download=lambda *_args: cached,
                disk_free=lambda _path: 0,
            )

            self.assertTrue(model_assets.inspect_asr_model(installed, assets=(expected,)).ready)

    def test_low_disk_never_moves_an_invalid_managed_model(self):
        expected = _asset("model.safetensors", b"expected")

        with tempfile.TemporaryDirectory() as home, patch.dict(
            os.environ,
            {"HOME": home},
            clear=False,
        ):
            target = model_assets.default_asr_model_path()
            target.mkdir(parents=True)
            corrupt = target / "model.safetensors"
            corrupt.write_bytes(b"corrupt")

            with self.assertRaisesRegex(OSError, "insufficient disk space"):
                model_assets.ensure_asr_model(
                    cache_dir=Path(home) / "hub",
                    status_path=Path(home) / "install-status.json",
                    assets=(expected,),
                    download=lambda *_args: self.fail("download must not start"),
                    disk_free=lambda _path: 0,
                )

            self.assertEqual(corrupt.read_bytes(), b"corrupt")
            self.assertEqual(
                list(target.parent.glob(f".{target.name}.invalid-*")),
                [],
            )

    def test_pinned_manifest_includes_base_preprocessor_compatibility_asset(self):
        by_name = {asset.filename: asset for asset in model_assets.PINNED_ASR_ASSETS}

        self.assertEqual(
            by_name["model.safetensors"].repo_id,
            "aufklarer/Qwen3-ASR-0.6B-MLX-4bit",
        )
        self.assertEqual(
            by_name["model.safetensors"].revision,
            "bc441bd1e4295c1f42d9879f056049a925b6e013",
        )
        self.assertEqual(
            by_name["preprocessor_config.json"].repo_id,
            "Qwen/Qwen3-ASR-0.6B",
        )
        self.assertEqual(
            by_name["preprocessor_config.json"].revision,
            "5eb144179a02acc5e5ba31e748d22b0cf3e303b0",
        )


if __name__ == "__main__":
    unittest.main()
