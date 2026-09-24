"""
telomi-audio-local - Local audio server wrapping mlx-audio Qwen3 family models
in OpenAI-compatible endpoints.

Backs Telomi's configurable STT and TTS Provider adapters.

Endpoints:
  * POST /v1/audio/speech         — Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit
  * POST /v1/audio/transcriptions — Qwen3-ASR-0.6B-MLX-4bit
  * POST /v1/audio/warmup        - idempotently load the selected local ASR
                                    model before the first transcription

TTS levers added on top of mlx-audio defaults:
  * temperature 0.6 / top_p 0.8 / repetition_penalty 1.05 (the model's own) — env-tunable
  * long input is spoken in passes of at most CHUNK_CHARS (default 200),
    split at sentence ends; one long pass drifts into skipped words and noise
  * per-pass text-length-aware max_tokens: max(MIN, pass_len * PER_CHAR),
    capped at HARD_MAX (default 1200), so a pass that never emits
    END_OF_SPEECH stops early
  * post-generation output-size sanity cap

ASR defaults:
  * chunk_duration=300 bounds long-form inference cost while keeping mlx-audio's
    physical VAD-snapped chunks reasonably large
  * Lazy-loaded on first request

Concurrency: separate asyncio.Lock per model so TTS and ASR can run
concurrently with each other (but each model serializes its own calls - the
underlying MLX models are single-threaded). A second "load lock" guards
double-checked lazy loading.

MLX GPU streams are thread-local. ASR loading and inference share one
dedicated worker thread, keeping their stream affinity without blocking the
HTTP event loop.
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import gc
import io
import logging
import os
import re
import signal
import struct
import tempfile
import textwrap
import threading
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import List, Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from model_assets import (
    default_asr_model_path,
    default_tts_model_path,
    read_install_status,
    read_tts_install_status,
)
from vad import (
    DEFAULT_SILERO_VAD_CONFIG,
    SILERO_VAD_MODEL_SHA256,
    SILERO_VAD_MODEL_VERSION,
    SileroVadConfig,
    SileroVadProcessor,
    VadProcessingResult,
    sanitize_silero_vad_config,
)
from transcription_jobs import TranscriptionJobStore
from environment import audio_env


def _env(key: str, default: str) -> str:
    return audio_env(key, default) or default


def _env_float(key: str, default: float) -> float:
    raw = audio_env(key)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(key: str, default: int) -> int:
    raw = audio_env(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_optional(key: str, default: str) -> str:
    """Source of an optional model; an explicitly blank value disables it.

    Capabilities backed by an optional model are advertised on /health only
    while that model has a source, so blanking the variable is how a
    deployment turns the capability off.
    """
    raw = audio_env(key)
    return (default if raw is None else raw).strip()


def _env_bool(key: str, default: bool) -> bool:
    raw = audio_env(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


HOST = _env("TELOMI_AUDIO_HOST", "127.0.0.1")
PORT = _env_int("TELOMI_AUDIO_PORT", 9595)

# ---- TTS config ----
TTS_MODEL_ID = _env(
    "TELOMI_AUDIO_TTS_MODEL_ID", "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
)
TTS_MODEL_PATH = str(default_tts_model_path())
TTS_MODEL_MANAGED = not bool(audio_env("TELOMI_AUDIO_TTS_MODEL_PATH", "").strip())
# CustomVoice ships 9 named speakers in config.json talker_config.spk_id:
#   serena, vivian, uncle_fu, ryan, aiden, ono_anna, sohee, eric, dylan
SUPPORTED_TTS_VOICES = [
    "vivian",
    "serena",
    "uncle_fu",
    "ryan",
    "aiden",
    "ono_anna",
    "sohee",
    "eric",
    "dylan",
]
DEFAULT_VOICE = _env("TELOMI_AUDIO_TTS_DEFAULT_VOICE", "vivian")


def _normalize_tts_voice(value: str | None) -> str:
    voice = ((value or DEFAULT_VOICE).strip() or DEFAULT_VOICE).lower()
    if voice not in SUPPORTED_TTS_VOICES:
        raise ValueError(
            f"voice={voice} is not supported; choose one of "
            f"{', '.join(SUPPORTED_TTS_VOICES)}"
        )
    return voice


TTS_TEMPERATURE = _env_float("TELOMI_AUDIO_TTS_TEMPERATURE", 0.6)
TTS_TOP_P = _env_float("TELOMI_AUDIO_TTS_TOP_P", 0.8)
# The model's own default. mlx-audio penalizes every codec token generated so far,
# so a stronger penalty starves a long passage of ordinary codes and it degrades
# into skipped words and noise.
TTS_REP_PENALTY = _env_float("TELOMI_AUDIO_TTS_REPETITION_PENALTY", 1.05)
# Longest text generated in one pass; longer input is spoken sentence by sentence
# in passes of at most this many characters, so no single generation runs long.
TTS_CHUNK_CHARS = max(1, _env_int("TELOMI_AUDIO_TTS_CHUNK_CHARS", 200))

TTS_MAX_TOKENS_PER_CHAR = _env_int("TELOMI_AUDIO_TTS_MAX_TOKENS_PER_CHAR", 25)
TTS_MIN_MAX_TOKENS = _env_int("TELOMI_AUDIO_TTS_MIN_MAX_TOKENS", 200)
TTS_HARD_MAX_TOKENS = _env_int("TELOMI_AUDIO_TTS_HARD_MAX_TOKENS", 1200)

TTS_MAX_BYTES_PER_CHAR = _env_int("TELOMI_AUDIO_TTS_MAX_BYTES_PER_CHAR", 25_000)
TTS_MIN_FLOOR_BYTES = _env_int("TELOMI_AUDIO_TTS_MIN_FLOOR_BYTES", 250_000)
TTS_STREAMING_INTERVAL = max(
    0.2, min(5.0, _env_float("TELOMI_AUDIO_TTS_STREAMING_INTERVAL", 0.5))
)

# ---- ASR config ----
ASR_MODEL_PATH = str(default_asr_model_path())
ASR_MODEL_ID = _env("TELOMI_AUDIO_ASR_MODEL_ID", "Qwen3-ASR-0.6B-MLX-4bit")
ASR_MODEL_MANAGED = not bool(audio_env("TELOMI_AUDIO_ASR_MODEL_PATH", "").strip())
# mlx-audio's segments are physical chunk boundaries (VAD-snapped within 5s
# of chunk_duration), not semantic sentences. 300s avoids unbounded long-form
# inference while retaining large chunks.
ASR_CHUNK_DURATION = _env_float("TELOMI_AUDIO_ASR_CHUNK_DURATION", 300.0)
ASR_MIN_CHUNK_DURATION = _env_float("TELOMI_AUDIO_ASR_MIN_CHUNK_DURATION", 0.5)
ASR_MAX_TOKENS = _env_int("TELOMI_AUDIO_ASR_MAX_TOKENS", 8192)
ASR_JOB_ROOT = Path(
    _env(
        "TELOMI_AUDIO_ASR_JOB_ROOT",
        str(Path.home() / ".cache" / "telomi-audio" / "transcription-jobs"),
    )
).expanduser()
ASR_JOB_MAX_UPLOAD_BYTES = _env_int(
    "TELOMI_AUDIO_ASR_JOB_MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024
)

# ---- Local neural VAD config ----
# The parameter contract matches OpenWhispr's pinned Silero defaults. It is
# deliberately disabled by default until the fixed release corpus proves that
# trimming improves long-pause/noise cases without regressing terminology.
VAD_DEFAULT_ENABLED = _env_bool("TELOMI_AUDIO_VAD_ENABLED", False)
VAD_MODEL_PATH = Path(
    _env(
        "TELOMI_AUDIO_VAD_MODEL_PATH",
        str(
            Path.home()
            / ".cache"
            / "telomi-audio"
            / "models"
            / f"silero-vad-{SILERO_VAD_MODEL_VERSION}.onnx"
        ),
    )
).expanduser()
VAD_DEFAULT_CONFIG = sanitize_silero_vad_config(
    {
        "threshold": _env_float(
            "TELOMI_AUDIO_VAD_THRESHOLD", DEFAULT_SILERO_VAD_CONFIG.threshold
        ),
        "min_speech_duration_ms": _env_int(
            "TELOMI_AUDIO_VAD_MIN_SPEECH_DURATION_MS",
            DEFAULT_SILERO_VAD_CONFIG.min_speech_duration_ms,
        ),
        "min_silence_duration_ms": _env_int(
            "TELOMI_AUDIO_VAD_MIN_SILENCE_DURATION_MS",
            DEFAULT_SILERO_VAD_CONFIG.min_silence_duration_ms,
        ),
        "max_speech_duration_s": _env_int(
            "TELOMI_AUDIO_VAD_MAX_SPEECH_DURATION_S",
            DEFAULT_SILERO_VAD_CONFIG.max_speech_duration_s,
        ),
        "speech_pad_ms": _env_int(
            "TELOMI_AUDIO_VAD_SPEECH_PAD_MS",
            DEFAULT_SILERO_VAD_CONFIG.speech_pad_ms,
        ),
        "samples_overlap": _env_float(
            "TELOMI_AUDIO_VAD_SAMPLES_OVERLAP",
            DEFAULT_SILERO_VAD_CONFIG.samples_overlap,
        ),
    }
)

# ---- Advertised contract (see README "Node to Python contract") ----
# Telomi enables these extensions only when /health advertises them, so an
# extension whose model is not configured must be absent rather than
# present-and-failing.
def advertised_capabilities() -> list[str]:
    return ["warmup", "transcription-jobs"]


# Every model here is single-threaded MLX inference over one GPU, so parallel
# requests only queue in the model locks below. Deployments that batch (vLLM
# on a discrete GPU) raise this.
MAX_CONCURRENCY = max(1, _env_int("TELOMI_AUDIO_MAX_CONCURRENCY", 1))

# ---- Idle-TTL eviction ----
# 16 GB unified memory on the dev box; TTS (~1.8 GB) and ASR (~2.3 GB) both
# resident starve the LLM / browser. Idle-evict each model after its own TTL so
# an active speech session keeps everything warm while a long lull releases
# memory back to the host.
#
# Defaults assume "active speech session ≤ 30 min":
#   TTS  / ASR    : 30 min TTL — TTS↔ASR alternate every few seconds inside a
#                   conversation, so a 30-min idle gap reliably means "session
#                   ended" and not "user is thinking".
#   Sweep period  : 30 s — fine enough to react, cheap enough to ignore.
TTS_IDLE_TTL = _env_float("TELOMI_AUDIO_TTS_IDLE_TTL_SEC", 1800.0)
ASR_IDLE_TTL = _env_float("TELOMI_AUDIO_ASR_IDLE_TTL_SEC", 1800.0)
SWEEP_INTERVAL = _env_float("TELOMI_AUDIO_IDLE_SWEEP_SEC", 30.0)
# Eagerly warm TTS at startup so the first user-facing speech call doesn't
# pay the ~10 s load cost. ASR stays lazy regardless.
TTS_EAGER_LOAD = _env("TELOMI_AUDIO_TTS_EAGER_LOAD", "false").lower() != "false"


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [telomi-audio] %(message)s",
)
log = logging.getLogger("telomi-audio")


# Lock discipline:
#   * _xxx_lock      — serializes generate() (model is single-threaded)
#   * _xxx_load_lock — guards lazy load + eviction so concurrent loaders dedupe
#   * Evict ONLY takes _xxx_load_lock, never _xxx_lock — avoids deadlock with
#     generate paths that acquire _xxx_lock first, _xxx_load_lock second (via
#     _ensure_xxx). If a generate is in flight when we evict, its local model
#     reference keeps the buffers alive until it returns; the eviction effectively
#     deferred to that point.
_tts_model = None
_tts_lock = asyncio.Lock()
_tts_load_lock = asyncio.Lock()
_tts_last_used: float = 0.0
# Loading and generation run here, off the event loop, so /health and the model
# listing still answer while a long passage is being spoken.
_tts_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="telomi-audio-tts")

_asr_model = None
_asr_lock = asyncio.Lock()
_asr_load_lock = asyncio.Lock()
_asr_last_used: float = 0.0
_asr_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="telomi-audio-asr")

_vad_processor = SileroVadProcessor(VAD_MODEL_PATH)
_vad_lock = asyncio.Lock()
_transcription_jobs = TranscriptionJobStore(ASR_JOB_ROOT)
_transcription_job_tasks: dict[str, asyncio.Task] = {}


async def _run_tts_worker(function, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _tts_executor,
        partial(function, *args, **kwargs),
    )


async def _run_asr_worker(function, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        _asr_executor,
        partial(function, *args, **kwargs),
    )


# Qwen3-ASR accepts 'language' as either a 2-letter code or an English name.
# Map common codes that the OpenAI Whisper API uses to the English name.
_LANG_CODE_TO_NAME = {
    "zh": "Chinese",
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "ja": "Japanese",
    "ko": "Korean",
    "ar": "Arabic",
    "hi": "Hindi",
    "vi": "Vietnamese",
    "th": "Thai",
    "id": "Indonesian",
    "ms": "Malay",
    "tr": "Turkish",
    "nl": "Dutch",
    "pl": "Polish",
    "sv": "Swedish",
    "fi": "Finnish",
    "no": "Norwegian",
    "da": "Danish",
    "cs": "Czech",
    "el": "Greek",
    "he": "Hebrew",
    "hu": "Hungarian",
    "ro": "Romanian",
    "uk": "Ukrainian",
    "ur": "Urdu",
    "bn": "Bengali",
    "ta": "Tamil",
    "te": "Telugu",
    "fa": "Persian",
}


def _normalize_language(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    s = raw.strip()
    if not s:
        return None
    if s in _LANG_CODE_TO_NAME:
        return _LANG_CODE_TO_NAME[s]
    return s  # already a name like "Chinese", or unknown — pass through


async def _ensure_tts():
    global _tts_model
    if _tts_model is not None:
        return _tts_model
    async with _tts_load_lock:
        if _tts_model is not None:
            return _tts_model
        log.info(f"lazy-loading TTS from {TTS_MODEL_PATH}")
        t0 = time.time()
        from mlx_audio.tts.utils import load_model as load_tts

        _tts_model = await _run_tts_worker(load_tts, TTS_MODEL_PATH)
        log.info(
            f"TTS loaded in {time.time() - t0:.1f}s, sample_rate={_tts_model.sample_rate}"
        )
        return _tts_model


async def _ensure_asr():
    global _asr_model
    if _asr_model is not None:
        return _asr_model
    async with _asr_load_lock:
        if _asr_model is not None:
            return _asr_model
        log.info(f"lazy-loading ASR from {ASR_MODEL_PATH}")
        t0 = time.time()
        from mlx_audio.stt.utils import load_model

        _asr_model = await _run_asr_worker(load_model, ASR_MODEL_PATH)
        log.info(f"ASR loaded in {time.time() - t0:.1f}s")
        return _asr_model


def _mlx_clear_cache() -> None:
    """Release MLX's pool of cached Metal buffers (the unused, reusable ones).
    Live model arrays are unaffected — they go away when the last Python ref
    to the model object is GC'd, which happens after gc.collect() below.
    """
    try:
        import mlx.core as mx

        mx.clear_cache()
    except Exception:
        log.exception("mx.clear_cache failed")


async def _evict_tts() -> bool:
    global _tts_model
    async with _tts_load_lock:
        if _tts_model is None:
            return False
        log.info(
            f"[idle] evicting TTS (idle {time.time() - _tts_last_used:.0f}s > {TTS_IDLE_TTL:.0f}s)"
        )
        _tts_model = None
    gc.collect()
    _mlx_clear_cache()
    return True


async def _evict_asr() -> bool:
    global _asr_model
    async with _asr_load_lock:
        if _asr_model is None:
            return False
        log.info(
            f"[idle] evicting ASR (idle {time.time() - _asr_last_used:.0f}s > {ASR_IDLE_TTL:.0f}s)"
        )
        _asr_model = None
    gc.collect()
    _mlx_clear_cache()
    return True


async def _idle_sweep_loop() -> None:
    """Background task: every SWEEP_INTERVAL seconds, check each loaded model
    against its TTL and evict if idle for too long. Survives transient errors.
    """
    log.info(
        f"idle-sweep loop running: TTS_TTL={TTS_IDLE_TTL:.0f}s "
        f"ASR_TTL={ASR_IDLE_TTL:.0f}s "
        f"sweep_every={SWEEP_INTERVAL:.0f}s"
    )
    while True:
        try:
            await asyncio.sleep(SWEEP_INTERVAL)
        except asyncio.CancelledError:
            raise
        try:
            now = time.time()
            if _tts_model is not None and _tts_last_used and now - _tts_last_used > TTS_IDLE_TTL:
                await _evict_tts()
            if _asr_model is not None and _asr_last_used and now - _asr_last_used > ASR_IDLE_TTL:
                await _evict_asr()
        except Exception:
            log.exception("idle sweep iter failed; continuing")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if TTS_EAGER_LOAD:
        await _ensure_tts()
    else:
        log.info("TTS eager-load disabled; will lazy-load on first request")
    log.info("ASR will lazy-load on first request")
    sweep_task = asyncio.create_task(_idle_sweep_loop())
    try:
        yield
    finally:
        log.info("shutting down")
        sweep_task.cancel()
        try:
            await sweep_task
        except asyncio.CancelledError:
            pass


app = FastAPI(lifespan=lifespan, title="telomi-audio-local")


SPEECH_RESPONSE_FORMATS = ("pcm", "wav")


class SpeechRequest(BaseModel):
    model: Optional[str] = None
    input: str
    voice: Optional[str] = None
    response_format: str = "wav"
    speed: Optional[float] = None
    stream: bool = False


class AudioWarmupRequest(BaseModel):
    capability: str = "asr"
    model: Optional[str] = None


def _idle_seconds(last_used: float) -> Optional[float]:
    if not last_used:
        return None
    return round(time.time() - last_used, 1)


@app.get("/health")
async def health():
    # Liveness only: report up as long as the process is responding. Models
    # may all be evicted under idle-TTL, which is correct behavior, not failure.
    return {
        "ok": True,
        "capabilities": advertised_capabilities(),
        "max_concurrency": MAX_CONCURRENCY,
        "tts": {
            "loaded": _tts_model is not None,
            "model_path": TTS_MODEL_PATH,
            "model_id": TTS_MODEL_ID,
            "sample_rate": getattr(_tts_model, "sample_rate", None),
            "idle_sec": _idle_seconds(_tts_last_used),
            "ttl_sec": TTS_IDLE_TTL,
            "install": {
                **read_tts_install_status(),
                "managed": TTS_MODEL_MANAGED,
            },
        },
        "asr": {
            "loaded": _asr_model is not None,
            "model_path": ASR_MODEL_PATH,
            "model_id": ASR_MODEL_ID,
            "idle_sec": _idle_seconds(_asr_last_used),
            "ttl_sec": ASR_IDLE_TTL,
            "install": {
                **read_install_status(),
                "managed": ASR_MODEL_MANAGED,
            },
        },
        "transcription_jobs": _transcription_jobs.summary(),
        "vad": {
            "provider": "silero-vad",
            "version": SILERO_VAD_MODEL_VERSION,
            "default_enabled": VAD_DEFAULT_ENABLED,
            "model_path": str(VAD_MODEL_PATH),
            "model_exists": _vad_processor.model_exists,
            "model_loaded": _vad_processor.loaded,
            "expected_sha256": SILERO_VAD_MODEL_SHA256,
            "config": VAD_DEFAULT_CONFIG.as_dict(),
        },
        "sweep_interval_sec": SWEEP_INTERVAL,
    }


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": TTS_MODEL_ID,
                "object": "model",
                "created": 0,
                "owned_by": "telomi-audio-local",
                "modality": "tts",
                "default_voice": DEFAULT_VOICE,
                "supported_voices": SUPPORTED_TTS_VOICES,
                "response_formats": list(SPEECH_RESPONSE_FORMATS),
                "min_speed": 1.0,
                "max_speed": 1.0,
            },
            {
                "id": ASR_MODEL_ID,
                "object": "model",
                "created": 0,
                "owned_by": "telomi-audio-local",
                "modality": "stt",
            },
        ],
    }


@app.get("/v1/audio/voices")
async def list_voices():
    """The voices this service can speak, in the Open WebUI convention.

    The models listing carries the same voices per TTS model; this endpoint is
    what a caller that only knows the convention asks for.
    """
    return {"voices": [{"id": voice, "name": voice} for voice in SUPPORTED_TTS_VOICES]}


@app.post("/v1/audio/warmup")
async def warmup_audio(req: AudioWarmupRequest):
    """Make local ASR ready without running inference.

    The first voice session calls this while the browser starts capturing. The
    existing ASR load lock keeps concurrent warmup and transcription requests
    idempotent. Warmup refreshes the same idle-TTL clock as real ASR use so a
    model loaded for an abandoned recording is eventually released.
    """
    global _asr_last_used, _tts_last_used

    capability = (req.capability or "").strip().lower()
    if capability == "tts":
        if req.model and req.model != TTS_MODEL_ID:
            raise HTTPException(409, "Requested TTS model is not available")
        ready_before_request = _tts_model is not None
        started = time.perf_counter()
        try:
            await _ensure_tts()
        except Exception as error:
            log.exception("TTS warmup failed")
            raise HTTPException(503, "TTS model could not be prepared") from error
        _tts_last_used = time.time()
        return {
            "ok": True,
            "capability": "tts",
            "model": TTS_MODEL_ID,
            "loaded": _tts_model is not None,
            "ready_before_request": ready_before_request,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "ttl_sec": TTS_IDLE_TTL,
        }
    if capability != "asr":
        raise HTTPException(400, f"capability={capability or '<empty>'} not supported")

    requested_model = (req.model or "").strip()
    if requested_model and requested_model != ASR_MODEL_ID:
        raise HTTPException(
            409,
            f"model={requested_model} is not available; configured ASR model is {ASR_MODEL_ID}",
        )

    ready_before_request = _asr_model is not None
    started = time.perf_counter()
    try:
        await _ensure_asr()
    except Exception as error:
        log.exception("ASR warmup failed")
        raise HTTPException(503, f"ASR warmup failed: {error}") from error

    _asr_last_used = time.time()
    duration_ms = round((time.perf_counter() - started) * 1000)
    log.info(
        f"ASR warmup ready: model={ASR_MODEL_ID}, "
        f"ready_before_request={ready_before_request}, duration_ms={duration_ms}"
    )
    return {
        "ok": True,
        "capability": "asr",
        "model": ASR_MODEL_ID,
        "loaded": _asr_model is not None,
        "ready_before_request": ready_before_request,
        "duration_ms": duration_ms,
        "ttl_sec": ASR_IDLE_TTL,
    }


def _tts_chunks(text: str, limit: int = TTS_CHUNK_CHARS) -> list[str]:
    """Split text at sentence ends, then clause marks, then hard, into pieces of at most limit characters."""
    pieces: list[str] = []
    for sentence in re.findall(r".+?(?:[。！？!?；;\n]+|\.(?:\s+|$)|$)", text, re.S):
        if len(sentence) <= limit:
            pieces.append(sentence)
            continue
        for clause in re.findall(r".+?(?:[，,、：:]+\s*|$)", sentence, re.S):
            pieces.extend(textwrap.wrap(clause, limit, replace_whitespace=False, drop_whitespace=False))
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if current and len(current) + len(piece) > limit:
            chunks.append(current.strip())
            current = ""
        current += piece
    if current.strip():
        chunks.append(current.strip())
    return [chunk for chunk in chunks if chunk]


def _tts_max_tokens(text: str) -> int:
    return min(TTS_HARD_MAX_TOKENS, max(TTS_MIN_MAX_TOKENS, len(text) * TTS_MAX_TOKENS_PER_CHAR))


def _speak(tts, text: str, voice: str, **options):
    """Generate text one chunk at a time; runs on the TTS thread."""
    for chunk in _tts_chunks(text):
        yield from tts.generate(
            text=chunk,
            voice=voice,
            temperature=TTS_TEMPERATURE,
            top_p=TTS_TOP_P,
            max_tokens=_tts_max_tokens(chunk),
            repetition_penalty=TTS_REP_PENALTY,
            verbose=False,
            **options,
        )


def _pcm16_wav_stream_header(sample_rate: int, channels: int = 1) -> bytes:
    block_align = channels * 2
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        0xFFFFFFFF,
        b"WAVE",
        b"fmt ",
        16,
        1,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        16,
        b"data",
        0xFFFFFFFF,
    )


def _float_audio_to_pcm16(audio: np.ndarray) -> bytes:
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    return np.clip(samples * 32768.0, -32768, 32767).astype("<i2").tobytes()


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest, request: Request):
    global _tts_last_used
    if req.model and req.model != TTS_MODEL_ID:
        raise HTTPException(409, "Requested TTS model is not available")
    if req.speed is not None and req.speed != 1:
        raise HTTPException(400, "This local TTS model supports speed=1 only")
    text = (req.input or "").strip()
    if not text:
        raise HTTPException(400, "input required")
    response_format = (req.response_format or "wav").lower()
    if response_format not in SPEECH_RESPONSE_FORMATS:
        raise HTTPException(
            400,
            f"response_format={req.response_format} not supported; use pcm or wav",
        )
    # Raw PCM has no container to buffer into, so it streams whether or not the
    # caller asked, as OpenAI's endpoint does.
    stream = req.stream or response_format == "pcm"

    text_len = len(text)
    try:
        voice = _normalize_tts_voice(req.voice)
    except ValueError as error:
        raise HTTPException(
            400,
            str(error),
        ) from error

    chunks = len(_tts_chunks(text))

    tts = await _ensure_tts()
    if stream:
        sample_rate = int(tts.sample_rate)
        size_cap = max(text_len * TTS_MAX_BYTES_PER_CHAR, TTS_MIN_FLOOR_BYTES)

        async def stream_audio():
            global _tts_last_used
            byte_length = 44 if response_format == "wav" else 0
            audio_samples = 0
            started_at = time.time()
            async with _tts_lock:
                log.info(
                    f"tts stream: text_len={text_len}, voice={voice}, chunks={chunks}, "
                    f"interval={TTS_STREAMING_INTERVAL}"
                )
                if response_format == "wav":
                    yield _pcm16_wav_stream_header(sample_rate)
                results = _speak(
                    tts,
                    text,
                    voice,
                    stream=True,
                    streaming_interval=TTS_STREAMING_INTERVAL,
                )
                try:
                    while (result := await _run_tts_worker(next, results, None)) is not None:
                        if await request.is_disconnected():
                            return
                        if result.audio is None:
                            continue
                        pcm = _float_audio_to_pcm16(result.audio)
                        if not pcm:
                            continue
                        byte_length += len(pcm)
                        if byte_length > size_cap:
                            raise RuntimeError(
                                f"streaming output exceeded {size_cap}B sanity cap"
                            )
                        audio_samples += len(pcm) // 2
                        yield pcm
                finally:
                    await _run_tts_worker(results.close)
                    _tts_last_used = time.time()
                    log.info(
                        f"tts stream done: text_len={text_len}, voice={voice}, "
                        f"processing={time.time() - started_at:.2f}s, "
                        f"audio={audio_samples / sample_rate:.2f}s, bytes={byte_length}"
                    )

        return StreamingResponse(
            stream_audio(),
            media_type="audio/wav" if response_format == "wav" else "audio/pcm",
        )

    async with _tts_lock:
        log.info(
            f"tts synthesize: text_len={text_len}, voice={voice}, chunks={chunks}, "
            f"temperature={TTS_TEMPERATURE}, top_p={TTS_TOP_P}, rep_penalty={TTS_REP_PENALTY}"
        )
        t0 = time.time()
        try:
            results = await _run_tts_worker(lambda: list(_speak(tts, text, voice)))
        except Exception as e:
            log.exception("TTS generate failed")
            raise HTTPException(500, f"generate failed: {e}")
        elapsed = time.time() - t0
        _tts_last_used = time.time()

    if not results:
        raise HTTPException(500, "no audio generated")

    sample_rate = results[0].sample_rate
    audio_chunks = [np.asarray(r.audio) for r in results if r.audio is not None]
    if not audio_chunks:
        raise HTTPException(500, "empty audio chunks")
    audio_np = (
        np.concatenate(audio_chunks) if len(audio_chunks) > 1 else audio_chunks[0]
    )

    buf = io.BytesIO()
    sf.write(buf, audio_np, sample_rate, format="WAV", subtype="PCM_16")
    wav_bytes = buf.getvalue()
    size_cap = max(text_len * TTS_MAX_BYTES_PER_CHAR, TTS_MIN_FLOOR_BYTES)
    if len(wav_bytes) > size_cap:
        log.warning(
            f"refusing runaway output: {len(wav_bytes)}B > cap {size_cap}B "
            f"for text_len={text_len}"
        )
        raise HTTPException(
            503,
            f"output {len(wav_bytes)}B > sanity cap {size_cap}B "
            f"(text_len={text_len}) — runaway suspected, discarding",
        )

    duration_sec = audio_np.shape[0] / sample_rate
    log.info(
        f"tts synthesize done: text_len={text_len}, voice={voice}, "
        f"processing={elapsed:.2f}s, audio={duration_sec:.2f}s, bytes={len(wav_bytes)}"
    )

    return Response(content=wav_bytes, media_type="audio/wav")


def _decode_audio_bytes(raw: bytes) -> tuple[np.ndarray, int]:
    """Decode arbitrary audio bytes → (float32 mono, sample_rate)."""
    try:
        data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    except Exception as e:
        # 415, not 400: the upload is a media type this service cannot decode, which is what
        # tells a caller to transcode and try again rather than to fix its request.
        raise HTTPException(415, f"failed to decode audio: {e}")
    if data.ndim > 1:
        # average to mono
        data = data.mean(axis=1).astype(np.float32, copy=False)
    return data.astype(np.float32, copy=False), int(sr)


def _resolve_vad_config(
    *,
    threshold: Optional[float],
    min_speech_duration_ms: Optional[int],
    min_silence_duration_ms: Optional[int],
    max_speech_duration_s: Optional[int],
    speech_pad_ms: Optional[int],
    samples_overlap: Optional[float],
) -> SileroVadConfig:
    supplied = {
        "threshold": threshold,
        "min_speech_duration_ms": min_speech_duration_ms,
        "min_silence_duration_ms": min_silence_duration_ms,
        "max_speech_duration_s": max_speech_duration_s,
        "speech_pad_ms": speech_pad_ms,
        "samples_overlap": samples_overlap,
    }
    return sanitize_silero_vad_config(
        {
            key: VAD_DEFAULT_CONFIG.as_dict()[key] if value is None else value
            for key, value in supplied.items()
        }
    )


def _vad_metadata(
    *,
    enabled: bool,
    config: SileroVadConfig,
    result: Optional[VadProcessingResult] = None,
    fail_open: bool = False,
    reason: Optional[str] = None,
) -> dict:
    return {
        "provider": "silero-vad",
        "version": SILERO_VAD_MODEL_VERSION,
        "enabled": enabled,
        "applied": result is not None,
        "fail_open": fail_open,
        "reason": reason,
        "speech_detected": result.has_speech if result is not None else None,
        "speech_ratio": round(result.speech_ratio, 6) if result is not None else None,
        "original_duration_sec": (
            round(result.original_duration_sec, 6) if result is not None else None
        ),
        "processed_duration_sec": (
            round(result.processed_duration_sec, 6) if result is not None else None
        ),
        "segment_count": len(result.speech_segments) if result is not None else 0,
        "config": config.as_dict(),
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),
    language: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    response_format: Optional[str] = Form("json"),
    temperature: Optional[float] = Form(None),
    chunk_duration: Optional[float] = Form(None),
    vad_enabled: Optional[bool] = Form(None),
    vad_threshold: Optional[float] = Form(None),
    vad_min_speech_duration_ms: Optional[int] = Form(None),
    vad_min_silence_duration_ms: Optional[int] = Form(None),
    vad_max_speech_duration_s: Optional[int] = Form(None),
    vad_speech_pad_ms: Optional[int] = Form(None),
    vad_samples_overlap: Optional[float] = Form(None),
):
    """OpenAI-compatible /v1/audio/transcriptions backed by Qwen3-ASR.

    Notes:
      * `language` accepts 2-letter codes (zh/en/...) or English names.
      * `prompt` is forwarded as Qwen3-ASR's system prompt so glossary
        keywords can guide recognition before deterministic correction.
      * `response_format` only supports "json"/"verbose_json"/"text".
        We always return JSON; "text" returns {"text": "..."}.
      * `chunk_duration` defaults to 300s. We pass it through to mlx-audio;
        its "segments" are physical VAD-snapped chunks, not sentences.
      * `vad_*` enables the pinned local Silero preprocessor. Missing or
        invalid models fail open to the original audio. A valid no-speech
        decision returns an empty success without loading the ASR model.
    """
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty file")

    fmt = (response_format or "json").lower()
    if fmt not in ("json", "verbose_json", "text"):
        raise HTTPException(400, f"response_format={fmt} not supported")

    lang_name = _normalize_language(language)
    lang_for_asr = language or lang_name  # ASR is tolerant of either

    chunk_dur = chunk_duration if chunk_duration is not None else ASR_CHUNK_DURATION

    audio_np, sr = _decode_audio_bytes(raw)
    duration_sec = float(audio_np.shape[0]) / float(sr) if sr else 0.0

    use_vad = VAD_DEFAULT_ENABLED if vad_enabled is None else bool(vad_enabled)
    vad_config = _resolve_vad_config(
        threshold=vad_threshold,
        min_speech_duration_ms=vad_min_speech_duration_ms,
        min_silence_duration_ms=vad_min_silence_duration_ms,
        max_speech_duration_s=vad_max_speech_duration_s,
        speech_pad_ms=vad_speech_pad_ms,
        samples_overlap=vad_samples_overlap,
    )
    vad_result: Optional[VadProcessingResult] = None
    vad_info = _vad_metadata(enabled=use_vad, config=vad_config)

    # Write to a temp file: mlx-audio's generate() accepts paths/URLs,
    # but its internal load_audio path also accepts bytes via librosa.
    # Safest: write a temp file and pass the path. The decoded audio_np above
    # serves duration and the optional VAD pass.
    suffix = ""
    if file.filename and "." in file.filename:
        suffix = "." + file.filename.rsplit(".", 1)[-1]
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
        tf.write(raw)
        tmp_path = tf.name

    asr_path = tmp_path
    vad_tmp_path: Optional[str] = None

    try:
        global _asr_last_used
        if use_vad:
            try:
                async with _vad_lock:
                    vad_result = _vad_processor.process(audio_np, sr, vad_config)
                vad_info = _vad_metadata(
                    enabled=True,
                    config=vad_config,
                    result=vad_result,
                )
                log.info(
                    "vad processed: "
                    f"speech={vad_result.has_speech}, "
                    f"segments={len(vad_result.speech_segments)}, "
                    f"original={vad_result.original_duration_sec:.2f}s, "
                    f"processed={vad_result.processed_duration_sec:.2f}s, "
                    f"ratio={vad_result.speech_ratio:.3f}"
                )
            except Exception as error:
                reason = (
                    "model_unavailable"
                    if isinstance(error, (FileNotFoundError, ValueError))
                    else "processing_failed"
                )
                vad_info = _vad_metadata(
                    enabled=True,
                    config=vad_config,
                    fail_open=True,
                    reason=reason,
                )
                log.exception("VAD preprocessing failed open to original audio")
                vad_result = None

        if vad_result is not None and not vad_result.has_speech:
            empty_result = {
                "text": "",
                "language": lang_name,
                "duration": duration_sec,
                "segments": [],
                "vad": vad_info,
            }
            return {"text": "", "vad": vad_info} if fmt == "text" else empty_result

        if vad_result is not None:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as vad_tf:
                vad_tmp_path = vad_tf.name
            sf.write(
                vad_tmp_path,
                vad_result.audio,
                vad_result.sample_rate,
                format="WAV",
                subtype="PCM_16",
            )
            asr_path = vad_tmp_path

        asr = await _ensure_asr()
        async with _asr_lock:
            log.info(
                f"asr transcribe: bytes={len(raw)}, duration={duration_sec:.2f}s, "
                f"language={lang_for_asr!r}, chunk_duration={chunk_dur}, "
                f"prompt={bool(prompt)}"
            )
            t0 = time.time()
            try:
                asr_out = await _run_asr_worker(
                    asr.generate,
                    asr_path,
                    max_tokens=ASR_MAX_TOKENS,
                    chunk_duration=chunk_dur,
                    min_chunk_duration=ASR_MIN_CHUNK_DURATION,
                    language=lang_for_asr,
                    system_prompt=prompt,
                    verbose=False,
                )
            except Exception as e:
                log.exception("ASR generate failed")
                raise HTTPException(500, f"asr generate failed: {e}")
            asr_elapsed = time.time() - t0
            _asr_last_used = time.time()
        log.info(
            f"asr done: text_len={len(asr_out.text or '')}, "
            f"language={getattr(asr_out, 'language', None)!r}, "
            f"segments={len(getattr(asr_out, 'segments', []) or [])}, "
            f"processing={asr_elapsed:.2f}s"
        )

        if fmt == "text":
            return {"text": asr_out.text, "vad": vad_info}

        # Build OpenAI-shaped segments from mlx-audio segments.
        out_segments = []
        for seg in asr_out.segments or []:
            segment_start = float(seg.get("start", 0.0))
            segment_end = float(seg.get("end", 0.0))
            if vad_result is not None:
                segment_start = vad_result.map_processed_seconds(segment_start)
                segment_end = vad_result.map_processed_seconds(segment_end)
            out_segments.append(
                {
                    "id": len(out_segments),
                    "start": segment_start,
                    "end": segment_end,
                    "text": seg.get("text", ""),
                }
            )

        # mlx-audio returns language as a list (e.g. ["zh"]) — flatten to a
        # single string for OpenAI compat. Prefer the explicit `language`
        # form if the caller passed one.
        detected_lang = getattr(asr_out, "language", None)
        if isinstance(detected_lang, (list, tuple)):
            detected_lang = detected_lang[0] if detected_lang else None
        result: dict = {
            "text": asr_out.text or "",
            "language": detected_lang or lang_name,
            "duration": duration_sec,
            "segments": out_segments,
            "vad": vad_info,
        }

        return result
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        if vad_tmp_path:
            try:
                os.unlink(vad_tmp_path)
            except OSError:
                pass


def _public_transcription_job(state: dict) -> dict:
    return {
        "id": state["id"],
        "status": state["status"],
        "created_at": state["created_at"],
        "updated_at": state["updated_at"],
        "heartbeat_at": state["heartbeat_at"],
        "poll_after_ms": state["poll_after_ms"],
        **({"result": state["result"]} if state["result"] is not None else {}),
        **({"error": state["error"]} if state["error"] else {}),
    }


async def _transcription_job_heartbeat(job_id: str) -> None:
    while True:
        await asyncio.sleep(5)
        _transcription_jobs.heartbeat(job_id)


async def _run_transcription_job(job_id: str) -> None:
    heartbeat_task: Optional[asyncio.Task] = None
    upload: Optional[UploadFile] = None
    input_path: Optional[Path] = None
    try:
        state = _transcription_jobs.get(job_id)
        if state["status"] == "cancelling":
            _transcription_jobs.mark_cancelled(job_id)
            return
        _transcription_jobs.mark_running(job_id)
        heartbeat_task = asyncio.create_task(_transcription_job_heartbeat(job_id))
        request = state["request"]
        input_path = Path(state["input_path"])
        input_file = input_path.open("rb")
        upload = UploadFile(filename=request.get("filename") or input_path.name, file=input_file)
        result = await transcriptions(
            file=upload,
            model=request.get("model"),
            language=request.get("language"),
            prompt=request.get("prompt"),
            response_format=request.get("response_format"),
            temperature=request.get("temperature"),
            chunk_duration=request.get("chunk_duration"),
            vad_enabled=request.get("vad_enabled"),
            vad_threshold=request.get("vad_threshold"),
            vad_min_speech_duration_ms=request.get("vad_min_speech_duration_ms"),
            vad_min_silence_duration_ms=request.get("vad_min_silence_duration_ms"),
            vad_max_speech_duration_s=request.get("vad_max_speech_duration_s"),
            vad_speech_pad_ms=request.get("vad_speech_pad_ms"),
            vad_samples_overlap=request.get("vad_samples_overlap"),
        )
        if _transcription_jobs.get(job_id)["status"] == "cancelling":
            _transcription_jobs.mark_cancelled(job_id)
        elif isinstance(result, dict):
            _transcription_jobs.succeed(job_id, result)
        else:
            _transcription_jobs.fail(job_id, "transcription returned an unsupported response")
    except HTTPException as error:
        _transcription_jobs.fail(job_id, f"HTTP {error.status_code}: {error.detail}")
    except Exception as error:
        log.exception("ASR Job failed: id=%s", job_id)
        _transcription_jobs.fail(job_id, str(error))
    finally:
        if heartbeat_task:
            heartbeat_task.cancel()
            with suppress(asyncio.CancelledError):
                await heartbeat_task
        if upload:
            await upload.close()
        if input_path:
            try:
                input_path.unlink(missing_ok=True)
                input_path.parent.rmdir()
            except OSError:
                pass


@app.post("/v1/audio/transcription-jobs")
async def create_transcription_job(
    file: UploadFile = File(...),
    idempotency_key: str = Form(...),
    model: Optional[str] = Form(None),
    language: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    response_format: Optional[str] = Form("json"),
    temperature: Optional[float] = Form(None),
    chunk_duration: Optional[float] = Form(None),
    vad_enabled: Optional[bool] = Form(None),
    vad_threshold: Optional[float] = Form(None),
    vad_min_speech_duration_ms: Optional[int] = Form(None),
    vad_min_silence_duration_ms: Optional[int] = Form(None),
    vad_max_speech_duration_s: Optional[int] = Form(None),
    vad_speech_pad_ms: Optional[int] = Form(None),
    vad_samples_overlap: Optional[float] = Form(None),
):
    if len(idempotency_key) != 64 or any(
        char not in "0123456789abcdef" for char in idempotency_key.lower()
    ):
        raise HTTPException(400, "idempotency_key must be a SHA-256 hex digest")
    suffix = Path(file.filename or "audio.bin").suffix.lower()
    if len(suffix) > 12 or any(
        char not in ".abcdefghijklmnopqrstuvwxyz0123456789" for char in suffix
    ):
        suffix = ".bin"
    job_root = _transcription_jobs.root
    job_root.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix="upload-", suffix=suffix, dir=job_root, delete=False
    ) as target:
        input_path = Path(target.name)
        uploaded_bytes = 0
        while chunk := await file.read(1024 * 1024):
            uploaded_bytes += len(chunk)
            if uploaded_bytes > ASR_JOB_MAX_UPLOAD_BYTES:
                target.close()
                input_path.unlink(missing_ok=True)
                raise HTTPException(413, "transcription upload exceeds the configured limit")
            target.write(chunk)
    if input_path.stat().st_size == 0:
        input_path.unlink(missing_ok=True)
        raise HTTPException(400, "empty file")
    request = {
        "filename": file.filename,
        "model": model,
        "language": language,
        "prompt": prompt,
        "response_format": response_format,
        "temperature": temperature,
        "chunk_duration": chunk_duration,
        "vad_enabled": vad_enabled,
        "vad_threshold": vad_threshold,
        "vad_min_speech_duration_ms": vad_min_speech_duration_ms,
        "vad_min_silence_duration_ms": vad_min_silence_duration_ms,
        "vad_max_speech_duration_s": vad_max_speech_duration_s,
        "vad_speech_pad_ms": vad_speech_pad_ms,
        "vad_samples_overlap": vad_samples_overlap,
    }
    state = _transcription_jobs.create(idempotency_key.lower(), str(input_path), request)
    if state["reused"]:
        input_path.unlink(missing_ok=True)
    else:
        task = asyncio.create_task(_run_transcription_job(state["id"]))
        _transcription_job_tasks[state["id"]] = task
        task.add_done_callback(
            lambda _task, job_id=state["id"]: _transcription_job_tasks.pop(job_id, None)
        )
    return JSONResponse(
        _public_transcription_job(state),
        status_code=200 if state["status"] == "succeeded" else 202,
    )


@app.get("/v1/audio/transcription-jobs/{job_id}")
async def get_transcription_job(job_id: str):
    try:
        return _public_transcription_job(_transcription_jobs.get(job_id))
    except KeyError:
        raise HTTPException(404, "transcription Job not found")


@app.delete("/v1/audio/transcription-jobs/{job_id}")
async def cancel_transcription_job(job_id: str):
    try:
        state = _transcription_jobs.request_cancel(job_id)
    except KeyError:
        raise HTTPException(404, "transcription Job not found")
    return JSONResponse(
        _public_transcription_job(state),
        status_code=202 if state["status"] == "cancelling" else 200,
    )


def _exit_with_parent(parent_pid: int, interval_sec: float = 2.0) -> None:
    """Stop once the launching Telomi process is gone.

    A Telomi that dies without stopping this service would otherwise leave it
    running, and the next Telomi reuses whatever answers on the port, even when
    it is older code with a different contract.
    """
    while os.getppid() == parent_pid:
        time.sleep(interval_sec)
    log.info(f"parent process {parent_pid} exited; shutting down")
    os.kill(os.getpid(), signal.SIGTERM)


if __name__ == "__main__":
    import uvicorn

    parent_pid = audio_env("TELOMI_AUDIO_PARENT_PID")
    if parent_pid:
        threading.Thread(target=_exit_with_parent, args=(int(parent_pid),), daemon=True).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
