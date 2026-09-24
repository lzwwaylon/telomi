import asyncio
import os
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch

import numpy as np

import app as audio_app
from fastapi import HTTPException


class AudioWarmupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.previous_tts = audio_app._tts_model
        self.previous_tts_last_used = audio_app._tts_last_used
        self.previous_model = audio_app._asr_model
        self.previous_last_used = audio_app._asr_last_used

    def tearDown(self):
        audio_app._tts_model = self.previous_tts
        audio_app._tts_last_used = self.previous_tts_last_used
        audio_app._asr_model = self.previous_model
        audio_app._asr_last_used = self.previous_last_used

    async def test_tts_warmup_and_speech_reject_unavailable_selections(self):
        sentinel = object()
        async def ensure_tts():
            audio_app._tts_model = sentinel
            return sentinel

        with patch.object(audio_app, "_ensure_tts", side_effect=ensure_tts):
            result = await audio_app.warmup_audio(
                audio_app.AudioWarmupRequest(capability="tts", model=audio_app.TTS_MODEL_ID)
            )
            self.assertTrue(result["loaded"])
            self.assertEqual(result["model"], audio_app.TTS_MODEL_ID)
            self.assertGreater(audio_app._tts_last_used, 0)
            with self.assertRaises(HTTPException) as unavailable:
                await audio_app.warmup_audio(
                    audio_app.AudioWarmupRequest(capability="tts", model="unavailable")
                )
            self.assertEqual(unavailable.exception.status_code, 409)
            with self.assertRaises(HTTPException) as mismatch:
                await audio_app.speech(audio_app.SpeechRequest(input="Check", model="unavailable"), None)
            self.assertEqual(mismatch.exception.status_code, 409)
            with self.assertRaises(HTTPException) as speed:
                await audio_app.speech(audio_app.SpeechRequest(input="Check", speed=1.5), None)
            self.assertEqual(speed.exception.status_code, 400)

    async def test_warmup_loads_asr_and_refreshes_idle_clock(self):
        sentinel = object()
        audio_app._asr_model = None
        audio_app._asr_last_used = 0.0

        async def ensure_asr():
            audio_app._asr_model = sentinel
            return sentinel

        before = time.time()
        with patch.object(audio_app, "_ensure_asr", side_effect=ensure_asr) as ensure:
            result = await audio_app.warmup_audio(
                audio_app.AudioWarmupRequest(
                    capability="asr",
                    model=audio_app.ASR_MODEL_ID,
                )
            )

        self.assertTrue(result["ok"])
        self.assertTrue(result["loaded"])
        self.assertFalse(result["ready_before_request"])
        self.assertEqual(result["model"], audio_app.ASR_MODEL_ID)
        self.assertGreaterEqual(audio_app._asr_last_used, before)
        ensure.assert_awaited_once()

    async def test_warmup_reports_an_already_loaded_model(self):
        sentinel = object()
        audio_app._asr_model = sentinel
        audio_app._asr_last_used = 0.0

        with patch.object(
            audio_app,
            "_ensure_asr",
            new=AsyncMock(return_value=sentinel),
        ) as ensure:
            result = await audio_app.warmup_audio(audio_app.AudioWarmupRequest())

        self.assertTrue(result["ready_before_request"])
        self.assertTrue(result["loaded"])
        ensure.assert_awaited_once()

    async def test_warmup_rejects_unknown_capability_and_model(self):
        with self.assertRaises(HTTPException) as capability_error:
            await audio_app.warmup_audio(
                audio_app.AudioWarmupRequest(capability="aligner")
            )
        self.assertEqual(capability_error.exception.status_code, 400)

        with self.assertRaises(HTTPException) as model_error:
            await audio_app.warmup_audio(
                audio_app.AudioWarmupRequest(capability="asr", model="unknown")
            )
        self.assertEqual(model_error.exception.status_code, 409)

    async def test_health_exposes_managed_install_stage(self):
        install_status = {
            "schema_version": 1,
            "model_id": audio_app.ASR_MODEL_ID,
            "stage": "downloading",
            "detail": "fetching pinned model asset 4/8",
            "completed_files": 3,
            "total_files": 8,
            "updated_at_unix_ms": 123,
        }
        with patch.object(
            audio_app,
            "read_install_status",
            return_value=install_status,
        ):
            result = await audio_app.health()

        self.assertEqual(result["asr"]["install"]["stage"], "downloading")
        self.assertEqual(result["asr"]["install"]["completed_files"], 3)
        self.assertIn("managed", result["asr"]["install"])

    async def test_health_exposes_managed_tts_install_stage(self):
        install_status = {
            "schema_version": 1,
            "model_id": audio_app.TTS_MODEL_ID,
            "stage": "downloading",
            "detail": "fetching pinned model asset 4/12",
            "completed_files": 3,
            "total_files": 12,
            "updated_at_unix_ms": 123,
        }
        with patch.object(
            audio_app,
            "read_tts_install_status",
            return_value=install_status,
        ):
            result = await audio_app.health()

        self.assertEqual(result["tts"]["install"]["stage"], "downloading")
        self.assertEqual(result["tts"]["install"]["total_files"], 12)
        self.assertIn("managed", result["tts"]["install"])

    async def test_health_answers_while_speech_is_generating(self):
        release = threading.Event()

        class SlowResult:
            audio = np.zeros(2400, dtype=np.float32)
            sample_rate = 24000

        class SlowTts:
            sample_rate = 24000

            def generate(self, **kwargs):
                release.wait(timeout=5)
                yield SlowResult()

        async def ensure_tts():
            return SlowTts()

        class ConnectedRequest:
            async def is_disconnected(self):
                return False

        with patch.object(audio_app, "_ensure_tts", side_effect=ensure_tts):
            for stream in (False, True):
                release.clear()
                speech = asyncio.create_task(
                    audio_app.speech(audio_app.SpeechRequest(input="Check", stream=stream), ConnectedRequest())
                )
                if stream:
                    response = await speech
                    speech = asyncio.create_task(anext(response.body_iterator))
                    await speech  # the WAV header, sent before generation starts
                    speech = asyncio.create_task(anext(response.body_iterator))
                await asyncio.sleep(0.05)
                self.assertFalse(speech.done())
                health = await asyncio.wait_for(audio_app.health(), timeout=1)
                self.assertTrue(health["ok"])
                release.set()
                await asyncio.wait_for(speech, timeout=5)

    def test_default_model_paths_are_not_machine_specific(self):
        if "TELOMI_AUDIO_ASR_MODEL_PATH" not in os.environ:
            self.assertNotIn("/Volumes/", audio_app.ASR_MODEL_PATH)
        if "TELOMI_AUDIO_TTS_MODEL_PATH" not in os.environ:
            self.assertNotIn("/Volumes/", audio_app.TTS_MODEL_PATH)

    async def test_concurrent_ensure_asr_calls_share_one_model_load(self):
        sentinel = object()
        audio_app._asr_model = None
        loads = 0

        def load_model(_path):
            nonlocal loads
            loads += 1
            return sentinel

        with patch("mlx_audio.stt.utils.load_model", side_effect=load_model):
            await audio_app._asr_load_lock.acquire()
            try:
                first_task = asyncio.create_task(audio_app._ensure_asr())
                second_task = asyncio.create_task(audio_app._ensure_asr())
                await asyncio.sleep(0)
                self.assertFalse(first_task.done())
                self.assertFalse(second_task.done())
            finally:
                audio_app._asr_load_lock.release()

            first, second = await asyncio.gather(first_task, second_task)

        self.assertIs(first, sentinel)
        self.assertIs(second, sentinel)
        self.assertEqual(loads, 1)

    def test_integer_environment_values_are_parsed_and_invalid_values_fall_back(self):
        with patch.dict(os.environ, {"TELOMI_AUDIO_TEST_INTEGER": "9596"}):
            self.assertEqual(audio_app._env_int("TELOMI_AUDIO_TEST_INTEGER", 9595), 9596)
        with patch.dict(
            os.environ,
            {
                "TELOMI_AUDIO_TEST_INTEGER": "9596",
                "TELOMI_AUDIO_TEST_INTEGER": "9597",
            },
        ):
            self.assertEqual(audio_app._env_int("TELOMI_AUDIO_TEST_INTEGER", 9595), 9597)
        with patch.dict(os.environ, {"TELOMI_AUDIO_TEST_INTEGER": "invalid"}):
            self.assertEqual(audio_app._env_int("TELOMI_AUDIO_TEST_INTEGER", 9595), 9595)


if __name__ == "__main__":
    unittest.main()
