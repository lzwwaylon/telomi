# Speaches local speech guide

English | [简体中文](local-speech-server.zh-CN.md)

Use this guide to configure a third-party local STT/TTS service or troubleshoot local speech support. Speaches is a tested third-party OpenAI-compatible speech service. Telomi uses the same path for it as for a cloud API; only the base URL differs. See the [Audio module](modules/audio.md) for the speech Provider contract.

## Tested version

| Item | Value |
|---|---|
| Speaches | `v0.9.0-rc.3` (commit `24f209c`), installed from source with uv; Docker is not required |
| STT model | `Systran/faster-whisper-small` |
| TTS model | `speaches-ai/Kokoro-82M-v1.0-ONNX` |
| Platform | Apple Silicon macOS, Python 3.12 (installed by uv) |

## Install and start

Speaches requires uv `~=0.8.14`. If your local uv is older, use `uvx` to run a temporary 0.8 version without upgrading the global installation.

```bash
git clone --depth 1 --branch v0.9.0-rc.3 https://github.com/speaches-ai/speaches.git
cd speaches
uvx --from 'uv>=0.8.14,<0.9' uv python install
uvx --from 'uv>=0.8.14,<0.9' uv sync
.venv/bin/uvicorn --factory --host 127.0.0.1 --port 8011 speaches.main:create_app
```

Speaches normally listens on `0.0.0.0:8000`. These commands bind it to loopback on a different port to avoid exposing it to the LAN or conflicting with other local services. Verify that `curl http://127.0.0.1:8011/health` returns 200.

Download the models once into the Hugging Face cache:

```bash
curl -X POST http://127.0.0.1:8011/v1/models/Systran/faster-whisper-small
curl -X POST http://127.0.0.1:8011/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX
```

Verify that `curl http://127.0.0.1:8011/v1/models` lists both models.

## Configure Telomi

These steps create dedicated connections from the speech output and recognition pages:

1. Open Settings > Speech output > Add connection. Use Provider ID `speaches-tts`, base URL `http://127.0.0.1:8011/v1`, and an empty API key. Select "Discover", then "Save and apply". Kokoro and its voices should appear under Speech output.
2. Open Settings > Speech recognition > Add connection. Use Provider ID `speaches-stt` with the same base URL and an empty API key. Discover the models, then save and apply. faster-whisper should appear under Speech recognition.
3. Test both connections. Both should show `OK`.
4. Under Settings > Speech recognition, select `speaches-stt` and `Systran/faster-whisper-small` as the recognition default, then save and apply.
5. Under Settings > Speech output, select `speaches-tts` and Kokoro as the audio generation default. Leave the voice empty to use the service default. Keep consumers such as Podcast Narrator following the default; reset any existing individual selection to follow the default first. Save and apply.

Connections added from the speech output or recognition page are pinned to that capability, so this example uses two connections. If an existing unpinned connection has discovered models for both TTS and STT, you can reuse it on both pages without creating duplicates.

## Verify

- Dictation: hold the voice button in a Goal conversation and speak a sentence. The transcript should appear in the input, and speech history should record Provider `speaches-stt`. The browser records webm/opus, which Speaches decodes directly without wav transcoding.
- Podcast: generate a podcast from an existing report and verify that it completes and plays. An LLM writes the podcast script, so a working chat model is required; speech generation and assembly use `speaches-tts`.
- Realtime voice conversation also uses `speaches-tts` for TTS. Kokoro's PCM output is 24 kHz, matching Telomi's default frame rate.

## Differences from telomi-audio

Speaches does not declare `capabilities` or `max_concurrency` in `/health`. Telomi treats it as an ordinary OpenAI-compatible service:

- Long transcriptions (YouTube and media imports) use a single request instead of a transcription Job.
- No warmup request is sent. Speaches loads the model on the first transcription, which takes a few extra seconds.
- Requests are not serialized on the client; Speaches manages its own concurrency queue.

Speaches requires `voice` in `/audio/speech`. When the voice is empty, Telomi uses the first voice listed for that model in `/v1/models` (`af_heart` for Kokoro).

This version of Speaches logs `ERROR ... Unexpected streaming transcription response type` even when transcription succeeds. If the request returns 200 with a correct result, this log line can be ignored during troubleshooting.
