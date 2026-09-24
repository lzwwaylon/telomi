import io
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient

import app as audio_app
from transcription_jobs import TranscriptionJobStore


class TranscriptionJobStoreTests(unittest.TestCase):
    def test_jobs_are_idempotent_persistent_and_restart_safe(self):
        with tempfile.TemporaryDirectory() as root:
            store = TranscriptionJobStore(Path(root))
            first = store.create("same-input", "/tmp/audio.wav", {"language": "zh"})
            duplicate = store.create(
                "same-input", "/tmp/duplicate.wav", {"language": "zh"}
            )
            self.assertEqual(duplicate["id"], first["id"])
            self.assertTrue(duplicate["reused"])

            store.mark_running(first["id"])
            self.assertEqual(store.summary()["counts"], {"running": 1})
            self.assertEqual(store.summary()["active"][0]["id"], first["id"])
            store.succeed(first["id"], {"text": "完成"})
            store.close()

            reopened = TranscriptionJobStore(Path(root))
            persisted = reopened.get(first["id"])
            self.assertEqual(persisted["status"], "succeeded")
            self.assertEqual(persisted["result"], {"text": "完成"})
            self.assertEqual(
                reopened.create("same-input", "/tmp/retry.wav", {"language": "zh"})[
                    "id"
                ],
                first["id"],
            )

            interrupted = reopened.create(
                "interrupted", "/tmp/interrupted.wav", {"language": "en"}
            )
            reopened.mark_running(interrupted["id"])
            reopened.close()

            recovered = TranscriptionJobStore(Path(root))
            self.assertEqual(recovered.get(interrupted["id"])["status"], "failed")
            replacement = recovered.create(
                "interrupted", "/tmp/replacement.wav", {"language": "en"}
            )
            self.assertNotEqual(replacement["id"], interrupted["id"])
            recovered.close()

    def test_http_job_runs_once_and_reuses_the_persisted_result(self):
        with tempfile.TemporaryDirectory() as root:
            store = TranscriptionJobStore(Path(root))
            asr = Mock()
            asr.generate.return_value = SimpleNamespace(
                text="state managed",
                language=["en"],
                segments=[{"start": 0, "end": 1, "text": "state managed"}],
            )
            wav = io.BytesIO()
            sf.write(wav, np.zeros(16_000, dtype=np.float32), 16_000, format="WAV")
            payload = wav.getvalue()

            with (
                patch.object(audio_app, "_transcription_jobs", store),
                patch.object(
                    audio_app, "_ensure_asr", new=AsyncMock(return_value=asr)
                ),
                TestClient(audio_app.app) as client,
            ):
                submitted = client.post(
                    "/v1/audio/transcription-jobs",
                    data={"idempotency_key": "a" * 64, "vad_enabled": "false"},
                    files={"file": ("long.wav", payload, "audio/wav")},
                )
                self.assertEqual(submitted.status_code, 202)
                job_id = submitted.json()["id"]
                state = submitted.json()
                for _ in range(100):
                    state = client.get(
                        f"/v1/audio/transcription-jobs/{job_id}"
                    ).json()
                    if state["status"] == "succeeded":
                        break
                    time.sleep(0.01)
                self.assertEqual(state["status"], "succeeded")
                self.assertEqual(state["result"]["text"], "state managed")

                duplicate = client.post(
                    "/v1/audio/transcription-jobs",
                    data={"idempotency_key": "a" * 64, "vad_enabled": "false"},
                    files={"file": ("long.wav", payload, "audio/wav")},
                )
                self.assertEqual(duplicate.status_code, 200)
                self.assertEqual(duplicate.json()["id"], job_id)
                self.assertEqual(asr.generate.call_count, 1)

                with patch.object(audio_app, "ASR_JOB_MAX_UPLOAD_BYTES", 10):
                    oversized = client.post(
                        "/v1/audio/transcription-jobs",
                        data={"idempotency_key": "b" * 64},
                        files={"file": ("large.wav", payload, "audio/wav")},
                    )
                self.assertEqual(oversized.status_code, 413)
                self.assertEqual(list(Path(root).glob("upload-*")), [])
            store.close()


if __name__ == "__main__":
    unittest.main()
