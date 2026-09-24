"""Local Silero VAD preprocessing for the Qwen ASR Provider.

The ONNX state wrapper and segmentation state machine are NumPy adaptations of
Silero VAD v5.1.2 ``utils_vad.py``. Silero VAD is MIT licensed. Telomi keeps
model acquisition, fail-open routing, audio extraction, and timestamp mapping
inside this module so the FastAPI surface does not depend on ONNX details.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping, Sequence

import numpy as np
from scipy import signal


SILERO_VAD_MODEL_VERSION = "v5.1.2"
SILERO_VAD_MODEL_SHA256 = (
    "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f"
)
SILERO_VAD_SAMPLE_RATE = 16_000
SILERO_VAD_WINDOW_SAMPLES = 512


@dataclass(frozen=True)
class SileroVadConfig:
    threshold: float = 0.5
    min_speech_duration_ms: int = 250
    min_silence_duration_ms: int = 200
    max_speech_duration_s: int = 30
    speech_pad_ms: int = 100
    samples_overlap: float = 0.5

    def as_dict(self) -> dict[str, float | int]:
        return asdict(self)


DEFAULT_SILERO_VAD_CONFIG = SileroVadConfig()

_CONFIG_LIMITS: dict[str, tuple[float, float, bool]] = {
    "threshold": (0.1, 0.95, False),
    "min_speech_duration_ms": (50, 2_000, True),
    "min_silence_duration_ms": (50, 2_000, True),
    "max_speech_duration_s": (5, 120, True),
    "speech_pad_ms": (0, 1_000, True),
    "samples_overlap": (0, 0.95, False),
}


@dataclass(frozen=True)
class SpeechSegment:
    start: int
    end: int

    def duration_samples(self) -> int:
        return max(0, self.end - self.start)


@dataclass(frozen=True)
class ExtractedSpeechAudio:
    audio: np.ndarray
    intervals: list[SpeechSegment]
    sample_rate: int

    def map_processed_seconds(self, seconds: float) -> float:
        """Map a timestamp in concatenated speech back to the source audio."""
        if not self.intervals or self.sample_rate <= 0:
            return max(0.0, seconds)
        processed_sample = max(0.0, seconds * self.sample_rate)
        total_samples = sum(segment.duration_samples() for segment in self.intervals)
        if processed_sample >= total_samples:
            return self.intervals[-1].end / self.sample_rate

        cursor = 0
        for segment in self.intervals:
            segment_samples = segment.duration_samples()
            segment_end = cursor + segment_samples
            if processed_sample < segment_end:
                return (segment.start + processed_sample - cursor) / self.sample_rate
            cursor = segment_end
        return self.intervals[-1].end / self.sample_rate


@dataclass(frozen=True)
class VadProcessingResult:
    audio: np.ndarray
    sample_rate: int
    speech_segments: list[SpeechSegment]
    copied_intervals: list[SpeechSegment]
    probabilities: list[float]
    original_duration_sec: float
    processed_duration_sec: float

    @property
    def has_speech(self) -> bool:
        return bool(self.speech_segments)

    @property
    def speech_duration_sec(self) -> float:
        return sum(
            segment.duration_samples() for segment in self.speech_segments
        ) / self.sample_rate

    @property
    def speech_ratio(self) -> float:
        if self.original_duration_sec <= 0:
            return 0.0
        return min(1.0, self.speech_duration_sec / self.original_duration_sec)

    def map_processed_seconds(self, seconds: float) -> float:
        extracted = ExtractedSpeechAudio(
            audio=self.audio,
            intervals=self.copied_intervals,
            sample_rate=self.sample_rate,
        )
        return extracted.map_processed_seconds(seconds)


def sanitize_silero_vad_config(
    values: Mapping[str, object] | None,
) -> SileroVadConfig:
    source = values or {}
    defaults = DEFAULT_SILERO_VAD_CONFIG.as_dict()
    normalized: dict[str, float | int] = {}
    for key, fallback in defaults.items():
        raw = source.get(key, fallback)
        if raw is None or raw == "":
            numeric = float(fallback)
        else:
            try:
                numeric = float(raw)
            except (TypeError, ValueError):
                numeric = float(fallback)
        if not math.isfinite(numeric):
            numeric = float(fallback)
        minimum, maximum, should_round = _CONFIG_LIMITS[key]
        numeric = min(maximum, max(minimum, numeric))
        normalized[key] = int(round(numeric)) if should_round else numeric
    return SileroVadConfig(**normalized)


def build_speech_segments(
    probabilities: Sequence[float],
    *,
    audio_length_samples: int,
    sample_rate: int,
    config: SileroVadConfig,
) -> list[SpeechSegment]:
    """Convert Silero window probabilities to padded speech intervals.

    This state machine preserves the v5.1.2 hysteresis behavior: speech starts
    at ``threshold`` and ends below ``threshold - 0.15`` only after the minimum
    silence duration. Very short speech bursts are discarded.
    """
    if sample_rate not in (8_000, 16_000):
        raise ValueError("Silero VAD supports only 8 kHz or 16 kHz audio")
    if audio_length_samples <= 0:
        return []
    window_size = 512 if sample_rate == 16_000 else 256
    min_speech_samples = sample_rate * config.min_speech_duration_ms / 1_000
    speech_pad_samples = sample_rate * config.speech_pad_ms / 1_000
    max_speech_samples = (
        sample_rate * config.max_speech_duration_s
        - window_size
        - 2 * speech_pad_samples
    )
    min_silence_samples = sample_rate * config.min_silence_duration_ms / 1_000
    min_silence_at_max_speech = sample_rate * 98 / 1_000
    negative_threshold = max(0.01, config.threshold - 0.15)

    triggered = False
    segments: list[SpeechSegment] = []
    current_start: int | None = None
    temporary_end = 0
    previous_end = 0
    next_start = 0

    for index, probability in enumerate(probabilities):
        current_sample = window_size * index
        if probability >= config.threshold and temporary_end:
            temporary_end = 0
            if next_start < previous_end:
                next_start = current_sample

        if probability >= config.threshold and not triggered:
            triggered = True
            current_start = current_sample
            continue

        if (
            triggered
            and current_start is not None
            and current_sample - current_start > max_speech_samples
        ):
            if previous_end:
                segments.append(SpeechSegment(current_start, previous_end))
                if next_start < previous_end:
                    triggered = False
                    current_start = None
                else:
                    current_start = next_start
                previous_end = next_start = temporary_end = 0
            else:
                segments.append(SpeechSegment(current_start, current_sample))
                current_start = None
                previous_end = next_start = temporary_end = 0
                triggered = False
                continue

        if probability < negative_threshold and triggered:
            if not temporary_end:
                temporary_end = current_sample
            if current_sample - temporary_end > min_silence_at_max_speech:
                previous_end = temporary_end
            if current_sample - temporary_end < min_silence_samples:
                continue
            if current_start is not None:
                duration = temporary_end - current_start
                if duration > min_speech_samples:
                    segments.append(SpeechSegment(current_start, temporary_end))
            current_start = None
            previous_end = next_start = temporary_end = 0
            triggered = False

    if (
        current_start is not None
        and audio_length_samples - current_start > min_speech_samples
    ):
        segments.append(SpeechSegment(current_start, audio_length_samples))

    return _apply_speech_padding(
        segments,
        audio_length_samples=audio_length_samples,
        speech_pad_samples=int(speech_pad_samples),
    )


def extract_speech_audio(
    audio: np.ndarray,
    segments: Sequence[SpeechSegment],
    *,
    sample_rate: int,
    samples_overlap: float,
) -> ExtractedSpeechAudio:
    """Concatenate speech while retaining bounded context around each span."""
    source = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not segments:
        return ExtractedSpeechAudio(
            audio=np.empty(0, dtype=np.float32),
            intervals=[],
            sample_rate=sample_rate,
        )
    half_overlap = max(0, int(round(samples_overlap * sample_rate / 2)))
    expanded = [
        SpeechSegment(
            start=max(0, segment.start - half_overlap),
            end=min(source.shape[0], segment.end + half_overlap),
        )
        for segment in segments
        if segment.end > segment.start
    ]
    intervals = _merge_segments(expanded)
    chunks = [source[segment.start : segment.end] for segment in intervals]
    processed = (
        np.concatenate(chunks).astype(np.float32, copy=False)
        if chunks
        else np.empty(0, dtype=np.float32)
    )
    return ExtractedSpeechAudio(
        audio=processed,
        intervals=intervals,
        sample_rate=sample_rate,
    )


class SileroOnnxModel:
    """Minimal stateful ONNX wrapper without a PyTorch dependency."""

    def __init__(self, model_path: str | Path):
        import onnxruntime

        options = onnxruntime.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        self.session = onnxruntime.InferenceSession(
            str(model_path),
            providers=["CPUExecutionProvider"],
            sess_options=options,
        )

    def probabilities(self, audio: np.ndarray, sample_rate: int) -> list[float]:
        if sample_rate != SILERO_VAD_SAMPLE_RATE:
            raise ValueError("Silero ONNX inference requires 16 kHz audio")
        waveform = np.asarray(audio, dtype=np.float32).reshape(-1)
        state = np.zeros((2, 1, 128), dtype=np.float32)
        context = np.zeros((1, 64), dtype=np.float32)
        probabilities: list[float] = []
        for offset in range(0, waveform.shape[0], SILERO_VAD_WINDOW_SAMPLES):
            chunk = waveform[offset : offset + SILERO_VAD_WINDOW_SAMPLES]
            if chunk.shape[0] < SILERO_VAD_WINDOW_SAMPLES:
                chunk = np.pad(
                    chunk,
                    (0, SILERO_VAD_WINDOW_SAMPLES - chunk.shape[0]),
                )
            batch = chunk.reshape(1, -1)
            model_input = np.concatenate([context, batch], axis=1)
            output, state = self.session.run(
                None,
                {
                    "input": model_input,
                    "state": state,
                    "sr": np.array(sample_rate, dtype=np.int64),
                },
            )
            probabilities.append(float(np.asarray(output).reshape(-1)[0]))
            context = model_input[:, -64:]
        return probabilities


class SileroVadProcessor:
    def __init__(self, model_path: str | Path):
        self.model_path = Path(model_path).expanduser().resolve()
        self._model: SileroOnnxModel | None = None

    @property
    def model_exists(self) -> bool:
        return self.model_path.is_file()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        if self._model is not None:
            return
        if not self.model_exists:
            raise FileNotFoundError(f"Silero VAD model not found: {self.model_path}")
        digest = _sha256_file(self.model_path)
        if digest != SILERO_VAD_MODEL_SHA256:
            raise ValueError(
                "Silero VAD model SHA-256 mismatch: "
                f"expected {SILERO_VAD_MODEL_SHA256}, received {digest}"
            )
        self._model = SileroOnnxModel(self.model_path)

    def process(
        self,
        audio: np.ndarray,
        sample_rate: int,
        config: SileroVadConfig,
    ) -> VadProcessingResult:
        source = _resample_mono(audio, sample_rate, SILERO_VAD_SAMPLE_RATE)
        if self._model is None:
            self.load()
        if self._model is None:
            raise RuntimeError("Silero VAD model failed to load")
        probabilities = self._model.probabilities(source, SILERO_VAD_SAMPLE_RATE)
        segments = build_speech_segments(
            probabilities,
            audio_length_samples=source.shape[0],
            sample_rate=SILERO_VAD_SAMPLE_RATE,
            config=config,
        )
        extracted = extract_speech_audio(
            source,
            segments,
            sample_rate=SILERO_VAD_SAMPLE_RATE,
            samples_overlap=config.samples_overlap,
        )
        return VadProcessingResult(
            audio=extracted.audio,
            sample_rate=SILERO_VAD_SAMPLE_RATE,
            speech_segments=segments,
            copied_intervals=extracted.intervals,
            probabilities=probabilities,
            original_duration_sec=source.shape[0] / SILERO_VAD_SAMPLE_RATE,
            processed_duration_sec=extracted.audio.shape[0] / SILERO_VAD_SAMPLE_RATE,
        )


def _apply_speech_padding(
    segments: Sequence[SpeechSegment],
    *,
    audio_length_samples: int,
    speech_pad_samples: int,
) -> list[SpeechSegment]:
    if not segments:
        return []
    # Keep this transformation structurally equivalent to Silero v5.1.2's
    # get_speech_timestamps padding pass. In particular, close segments retain
    # a shared boundary instead of being collapsed into one metadata segment.
    padded = [[segment.start, segment.end] for segment in segments]
    for index, speech in enumerate(padded):
        if index == 0:
            speech[0] = int(max(0, speech[0] - speech_pad_samples))
        if index < len(padded) - 1:
            silence_duration = padded[index + 1][0] - speech[1]
            if silence_duration < 2 * speech_pad_samples:
                speech[1] += int(silence_duration // 2)
                padded[index + 1][0] = int(
                    max(0, padded[index + 1][0] - silence_duration // 2)
                )
            else:
                speech[1] = int(
                    min(audio_length_samples, speech[1] + speech_pad_samples)
                )
                padded[index + 1][0] = int(
                    max(0, padded[index + 1][0] - speech_pad_samples)
                )
        else:
            speech[1] = int(
                min(audio_length_samples, speech[1] + speech_pad_samples)
            )
    return [
        SpeechSegment(start, end)
        for start, end in padded
        if end > start
    ]


def _merge_segments(segments: Sequence[SpeechSegment]) -> list[SpeechSegment]:
    merged: list[SpeechSegment] = []
    for segment in sorted(segments, key=lambda item: (item.start, item.end)):
        if segment.end <= segment.start:
            continue
        if not merged or segment.start > merged[-1].end:
            merged.append(segment)
            continue
        previous = merged[-1]
        merged[-1] = SpeechSegment(previous.start, max(previous.end, segment.end))
    return merged


def _resample_mono(
    audio: np.ndarray,
    original_sample_rate: int,
    target_sample_rate: int,
) -> np.ndarray:
    if original_sample_rate <= 0:
        raise ValueError("audio sample rate must be positive")
    waveform = np.asarray(audio, dtype=np.float32)
    if waveform.ndim > 1:
        waveform = waveform.mean(axis=-1)
    waveform = waveform.reshape(-1)
    if original_sample_rate == target_sample_rate:
        return waveform.astype(np.float32, copy=False)
    divisor = math.gcd(original_sample_rate, target_sample_rate)
    return signal.resample_poly(
        waveform,
        target_sample_rate // divisor,
        original_sample_rate // divisor,
        padtype="line",
    ).astype(np.float32, copy=False)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()
