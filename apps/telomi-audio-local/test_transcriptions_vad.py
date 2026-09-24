import asyncio
import io
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import numpy as np
import soundfile as sf
from starlette.datastructures import UploadFile

import app as audio_app
from vad import SpeechSegment, VadProcessingResult


def _wav_upload(audio: np.ndarray, sample_rate: int = 16_000) -> UploadFile:
    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
    buffer.seek(0)
    return UploadFile(filename="capture.wav", file=buffer)


def _vad_result(*, has_speech: bool) -> VadProcessingResult:
    if not has_speech:
        return VadProcessingResult(
            audio=np.empty(0, dtype=np.float32),
            sample_rate=16_000,
            speech_segments=[],
            copied_intervals=[],
            probabilities=[0.01] * 63,
            original_duration_sec=2.0,
            processed_duration_sec=0.0,
        )
    return VadProcessingResult(
        audio=np.ones(16_000, dtype=np.float32) * 0.05,
        sample_rate=16_000,
        speech_segments=[SpeechSegment(16_000, 32_000)],
        copied_intervals=[SpeechSegment(12_000, 36_000)],
        probabilities=[0.01, 0.99],
        original_duration_sec=3.0,
        processed_duration_sec=1.5,
    )


async def _transcribe(file: UploadFile, **overrides):
    values = {
        "file": file,
        "model": None,
        "language": "en",
        "prompt": None,
        "response_format": "verbose_json",
        "temperature": None,
        "chunk_duration": None,
        "vad_enabled": True,
        "vad_threshold": 0.5,
        "vad_min_speech_duration_ms": 250,
        "vad_min_silence_duration_ms": 200,
        "vad_max_speech_duration_s": 30,
        "vad_speech_pad_ms": 100,
        "vad_samples_overlap": 0.5,
    }
    values.update(overrides)
    return await audio_app.transcriptions(**values)


class VadTranscriptionEndpointTests(unittest.IsolatedAsyncioTestCase):

    async def test_asr_generation_does_not_block_the_http_event_loop(self):
        asr = Mock()

        def generate(*_args, **_kwargs):
            time.sleep(0.1)
            return SimpleNamespace(text="responsive", language=["en"], segments=[])

        asr.generate.side_effect = generate
        probe_delay = None

        async def probe():
            nonlocal probe_delay
            await asyncio.sleep(0.01)
            probe_delay = time.perf_counter() - started

        with patch.object(
            audio_app, "_ensure_asr", new=AsyncMock(return_value=asr)
        ):
            started = time.perf_counter()
            await asyncio.gather(
                _transcribe(
                    _wav_upload(np.zeros(16_000, dtype=np.float32)),
                    vad_enabled=False,
                ),
                probe(),
            )

        self.assertIsNotNone(probe_delay)
        self.assertLess(probe_delay, 0.05)

    async def test_no_speech_returns_empty_result_without_loading_asr(self):
        processor = Mock()
        processor.process.return_value = _vad_result(has_speech=False)

        with (
            patch.object(audio_app, "_vad_processor", processor),
            patch.object(audio_app, "_ensure_asr", new=AsyncMock()) as ensure_asr,
        ):
            result = await _transcribe(
                _wav_upload(np.zeros(32_000, dtype=np.float32))
            )

        self.assertEqual(result["text"], "")
        self.assertEqual(result["segments"], [])
        self.assertTrue(result["vad"]["enabled"])
        self.assertTrue(result["vad"]["applied"])
        self.assertFalse(result["vad"]["speech_detected"])
        self.assertFalse(result["vad"]["fail_open"])
        ensure_asr.assert_not_awaited()

    async def test_vad_failure_fails_open_and_still_transcribes_original_audio(self):
        processor = Mock()
        processor.process.side_effect = FileNotFoundError("missing VAD model")
        asr = Mock()
        asr.generate.return_value = SimpleNamespace(
            text="kept original audio",
            language=["en"],
            segments=[{"start": 0.0, "end": 1.0, "text": "kept original audio"}],
        )

        with (
            patch.object(audio_app, "_vad_processor", processor),
            patch.object(audio_app, "_ensure_asr", new=AsyncMock(return_value=asr)),
        ):
            result = await _transcribe(
                _wav_upload(np.ones(16_000, dtype=np.float32) * 0.01)
            )

        self.assertEqual(result["text"], "kept original audio")
        self.assertTrue(result["vad"]["enabled"])
        self.assertFalse(result["vad"]["applied"])
        self.assertTrue(result["vad"]["fail_open"])
        self.assertEqual(result["vad"]["reason"], "model_unavailable")
        generated_path = asr.generate.call_args.args[0]
        self.assertTrue(generated_path.endswith(".wav"))

    async def test_processed_audio_is_transcribed_and_segments_map_to_source_time(self):
        processor = Mock()
        processor.process.return_value = _vad_result(has_speech=True)
        asr = Mock()
        asr.generate.return_value = SimpleNamespace(
            text="mapped",
            language=["en"],
            segments=[{"start": 0.25, "end": 1.25, "text": "mapped"}],
        )

        generated_audio = None

        def generate(path, **_kwargs):
            nonlocal generated_audio
            generated_audio, generated_rate = sf.read(path, dtype="float32")
            self.assertEqual(generated_rate, 16_000)
            return asr.generate.return_value

        asr.generate.side_effect = generate

        with (
            patch.object(audio_app, "_vad_processor", processor),
            patch.object(audio_app, "_ensure_asr", new=AsyncMock(return_value=asr)),
        ):
            result = await _transcribe(
                _wav_upload(np.zeros(48_000, dtype=np.float32))
            )

        self.assertIsNotNone(generated_audio)
        self.assertEqual(generated_audio.shape[0], 16_000)
        self.assertAlmostEqual(result["segments"][0]["start"], 1.0)
        self.assertAlmostEqual(result["segments"][0]["end"], 2.0)
        self.assertTrue(result["vad"]["speech_detected"])
        self.assertAlmostEqual(result["vad"]["processed_duration_sec"], 1.5)
        self.assertAlmostEqual(result["duration"], 3.0)

    async def test_disabled_vad_preserves_the_existing_request_path(self):
        processor = Mock()
        asr = Mock()
        asr.generate.return_value = SimpleNamespace(
            text="unchanged",
            language=["en"],
            segments=[],
        )

        with (
            patch.object(audio_app, "_vad_processor", processor),
            patch.object(audio_app, "_ensure_asr", new=AsyncMock(return_value=asr)),
        ):
            result = await _transcribe(
                _wav_upload(np.zeros(16_000, dtype=np.float32)),
                vad_enabled=False,
            )

        processor.process.assert_not_called()
        self.assertFalse(result["vad"]["enabled"])
        self.assertFalse(result["vad"]["applied"])
        self.assertFalse(result["vad"]["fail_open"])
        self.assertEqual(result["text"], "unchanged")
        self.assertEqual(asr.generate.call_args.kwargs["chunk_duration"], 300.0)


if __name__ == "__main__":
    unittest.main()
