import os
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from vad import (
    DEFAULT_SILERO_VAD_CONFIG,
    SILERO_VAD_MODEL_VERSION,
    SpeechSegment,
    SileroVadProcessor,
    build_speech_segments,
    extract_speech_audio,
    sanitize_silero_vad_config,
)


class SileroVadConfigTests(unittest.TestCase):
    def test_defaults_and_limits_match_the_pinned_openwhispr_contract(self):
        self.assertEqual(
            sanitize_silero_vad_config(None),
            DEFAULT_SILERO_VAD_CONFIG,
        )

        config = sanitize_silero_vad_config(
            {
                "threshold": 99,
                "min_speech_duration_ms": -20,
                "min_silence_duration_ms": "bad",
                "max_speech_duration_s": 0,
                "speech_pad_ms": None,
                "samples_overlap": -1,
            }
        )

        self.assertEqual(config.threshold, 0.95)
        self.assertEqual(config.min_speech_duration_ms, 50)
        self.assertEqual(config.min_silence_duration_ms, 200)
        self.assertEqual(config.max_speech_duration_s, 5)
        self.assertEqual(config.speech_pad_ms, 100)
        self.assertEqual(config.samples_overlap, 0)


class SileroVadSegmentationTests(unittest.TestCase):
    def test_hysteresis_keeps_real_speech_and_drops_too_short_bursts(self):
        config = sanitize_silero_vad_config(
            {
                "threshold": 0.5,
                "min_speech_duration_ms": 50,
                "min_silence_duration_ms": 50,
                "max_speech_duration_s": 30,
                "speech_pad_ms": 0,
                "samples_overlap": 0,
            }
        )
        segments = build_speech_segments(
            [0.1, 0.8, 0.8, 0.2, 0.2, 0.2],
            audio_length_samples=6 * 512,
            sample_rate=16_000,
            config=config,
        )
        self.assertEqual(segments, [SpeechSegment(start=512, end=1536)])

        too_short = build_speech_segments(
            [0.1, 0.8, 0.2, 0.2, 0.2],
            audio_length_samples=5 * 512,
            sample_rate=16_000,
            config=config,
        )
        self.assertEqual(too_short, [])

    def test_padding_never_overlaps_or_escapes_the_original_audio(self):
        config = sanitize_silero_vad_config(
            {
                "threshold": 0.5,
                "min_speech_duration_ms": 20,
                "min_silence_duration_ms": 20,
                "max_speech_duration_s": 30,
                "speech_pad_ms": 100,
                "samples_overlap": 0,
            }
        )
        segments = build_speech_segments(
            [0.8, 0.2, 0.8, 0.2],
            audio_length_samples=4 * 512,
            sample_rate=16_000,
            config=config,
        )
        self.assertEqual(segments, [SpeechSegment(start=0, end=2048)])


class SileroVadExtractionTests(unittest.TestCase):
    def test_extraction_removes_long_gaps_and_maps_processed_time_back(self):
        sample_rate = 100
        audio = np.arange(1_000, dtype=np.float32)
        extracted = extract_speech_audio(
            audio,
            [SpeechSegment(start=100, end=200), SpeechSegment(start=600, end=700)],
            sample_rate=sample_rate,
            samples_overlap=0.5,
        )

        self.assertEqual(extracted.intervals, [
            SpeechSegment(start=75, end=225),
            SpeechSegment(start=575, end=725),
        ])
        self.assertEqual(extracted.audio.shape[0], 300)
        np.testing.assert_array_equal(extracted.audio[:150], audio[75:225])
        np.testing.assert_array_equal(extracted.audio[150:], audio[575:725])
        self.assertAlmostEqual(extracted.map_processed_seconds(0), 0.75)
        self.assertAlmostEqual(extracted.map_processed_seconds(1.5), 5.75)
        self.assertAlmostEqual(extracted.map_processed_seconds(3), 7.25)


class SileroVadModelIntegrationTests(unittest.TestCase):
    @staticmethod
    def _model_path() -> Path:
        configured = os.environ.get("TELOMI_AUDIO_VAD_MODEL_PATH", "").strip()
        if configured:
            return Path(configured).expanduser()
        return (
            Path.home()
            / ".cache"
            / "telomi-audio"
            / "models"
            / f"silero-vad-{SILERO_VAD_MODEL_VERSION}.onnx"
        )

    def test_model_hash_is_verified_before_onnx_load(self):
        with tempfile.NamedTemporaryFile() as invalid_model:
            invalid_model.write(b"not a Silero model")
            invalid_model.flush()
            processor = SileroVadProcessor(invalid_model.name)
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                processor.load()

    def test_pinned_onnx_model_rejects_silence(self):
        model_path = self._model_path()
        if not model_path.is_file():
            self.skipTest(f"pinned VAD model not installed: {model_path}")
        processor = SileroVadProcessor(model_path)
        result = processor.process(
            np.zeros(32_000, dtype=np.float32),
            16_000,
            DEFAULT_SILERO_VAD_CONFIG,
        )
        self.assertTrue(processor.loaded)
        self.assertFalse(result.has_speech)
        self.assertEqual(result.processed_duration_sec, 0)
        self.assertLess(max(result.probabilities), 0.1)

    def test_pinned_onnx_model_detects_a_real_human_fixture(self):
        model_path = self._model_path()
        if not model_path.is_file():
            self.skipTest(f"pinned VAD model not installed: {model_path}")
        configured_fixture = os.environ.get("TELOMI_AUDIO_VAD_TEST_AUDIO", "").strip()
        fixture = (
            Path(configured_fixture).expanduser()
            if configured_fixture
            else Path(__file__).resolve().parent
            / "../telomi/.pi/voice/evaluation-fixtures/"
            / "46dbc998c9d1d48111267c40741dd3200f2e5bcf4075f8c4c97f4451160dce50.wav"
        )
        if not fixture.is_file():
            self.skipTest(
                "real speech fixture unavailable; set TELOMI_AUDIO_VAD_TEST_AUDIO"
            )

        audio, sample_rate = sf.read(fixture, dtype="float32", always_2d=False)
        result = SileroVadProcessor(model_path).process(
            audio,
            sample_rate,
            DEFAULT_SILERO_VAD_CONFIG,
        )

        self.assertTrue(result.has_speech)
        self.assertGreater(result.speech_ratio, 0.5)
        self.assertLess(result.processed_duration_sec, result.original_duration_sec)
        self.assertGreater(max(result.probabilities), 0.9)


if __name__ == "__main__":
    unittest.main()
