import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

import app as audio_app


class AdvertisedCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(audio_app.app)

    def health(self):
        return self.client.get("/health").json()

    def test_health_advertises_the_extensions_node_may_use(self):
        self.assertEqual(self.health()["capabilities"], ["warmup", "transcription-jobs"])

    def test_health_reports_the_serialisation_budget_this_deployment_wants(self):
        with patch.object(audio_app, "MAX_CONCURRENCY", 4):
            self.assertEqual(self.health()["max_concurrency"], 4)
        # Whatever the deployment configures, Node gets a usable request budget.
        budget = self.health()["max_concurrency"]
        self.assertIsInstance(budget, int)
        self.assertGreaterEqual(budget, 1)

    def test_models_report_modality_and_tts_voices(self):
        data = self.client.get("/v1/models").json()["data"]

        by_id = {entry["id"]: entry for entry in data}
        self.assertEqual({entry["modality"] for entry in data}, {"stt", "tts"})
        self.assertEqual(by_id[audio_app.ASR_MODEL_ID]["modality"], "stt")
        tts = by_id[audio_app.TTS_MODEL_ID]
        self.assertEqual(tts["modality"], "tts")
        self.assertEqual(tts["default_voice"], audio_app.DEFAULT_VOICE)
        self.assertEqual(tts["supported_voices"], audio_app.SUPPORTED_TTS_VOICES)
        self.assertEqual(tts["response_formats"], ["pcm", "wav"])
        self.assertEqual((tts["min_speed"], tts["max_speed"]), (1.0, 1.0))

    def test_voices_endpoint_lists_every_supported_voice(self):
        body = self.client.get("/v1/audio/voices").json()

        self.assertEqual(
            body["voices"],
            [{"id": voice, "name": voice} for voice in audio_app.SUPPORTED_TTS_VOICES],
        )

    def test_a_blank_optional_model_source_is_kept_blank(self):
        with patch.dict("os.environ", {"TELOMI_AUDIO_TEST_OPTIONAL": " "}):
            self.assertEqual(
                audio_app._env_optional("TELOMI_AUDIO_TEST_OPTIONAL", "Qwen/x"), ""
            )
        self.assertEqual(
            audio_app._env_optional("TELOMI_AUDIO_TEST_OPTIONAL", "Qwen/x"), "Qwen/x"
        )


class UndecodableUploadTests(unittest.TestCase):
    def test_an_undecodable_container_is_refused_as_an_unsupported_media_type(self):
        with self.assertRaises(HTTPException) as refused:
            audio_app._decode_audio_bytes(b"not an audio container")

        # 415 is what tells a caller to transcode and retry; 400 would mean its request was wrong.
        self.assertEqual(refused.exception.status_code, 415)
        self.assertIn("failed to decode audio", refused.exception.detail)


if __name__ == "__main__":
    unittest.main()
