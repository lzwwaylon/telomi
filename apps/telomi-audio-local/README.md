# Telomi Audio Local

Optional Apple Silicon speech service for Telomi. Python dependencies live in
this directory's uv-managed `.venv`; model weights remain in
`~/.cache/telomi-audio` so they are not committed or duplicated with the
environment. When Telomi starts the service, install progress and transcription
jobs are kept in Telomi's data directory; run on its own, they default to
`~/.cache/telomi-audio` as well.

```bash
cd ../..
npm run setup:audio
apps/telomi-audio-local/run.sh
```

The locked runtime requires Python 3.12 on Apple Silicon macOS. `run.sh`
performs a frozen uv sync before startup and refuses dependency drift. Before
the service starts, it installs the pinned Qwen3-ASR (about 0.7 GB) and
Qwen3-TTS (about 2 GB) models and verifies every file by SHA-256, so the first
start downloads both and later starts only verify them. Setting
`TELOMI_AUDIO_ASR_MODEL_PATH` or `TELOMI_AUDIO_TTS_MODEL_PATH` uses an
externally managed copy instead and skips that model's install. Set
`TELOMI_AUDIO_VENV_PATH` only when intentionally supplying an externally
managed compatible environment.

The optional systemd unit under `deploy/` assumes the repository is installed
at `/opt/telomi`. It loads host and port overrides from this directory's ignored
`.env.local` and expects `vllm` on the service `PATH`.

## Node to Python contract

Telomi talks to this service as an ordinary OpenAI-compatible speech endpoint
and uses an extension only where the service declares it. The contract (health
`capabilities` and `max_concurrency`, the models fields, the voices endpoint,
warmup, transcription Jobs and the 415 for undecodable uploads) is stated once,
in the [Audio module](../telomi/docs/modules/audio.md#node-and-telomi-audio-contract).

What this service declares depends on its configuration:

- `max_concurrency` is 1 because each model is single-threaded MLX inference
  over one GPU. Raise `TELOMI_AUDIO_MAX_CONCURRENCY` for a deployment that
  batches.
- Browser recordings are webm/opus, which `soundfile` does not read, so the 415
  and the caller's wav retry are the normal path for dictation audio.

Callers may send a long passage in one speech request. The service speaks it in
passes of at most `TELOMI_AUDIO_TTS_CHUNK_CHARS` characters (default 200),
split at sentence ends, and returns one continuous stream. One long generation
drifts into skipped words and noise after about a minute, and each pass has a
token budget sized to its own text, so no text is cut off.
