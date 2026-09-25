# Audio

## Purpose

Every Telomi speech consumer (push-to-talk, live preview, live voice conversations, playback, podcasts, YouTube transcription, and media ingestion) needs STT or TTS. A user's speech service may be a cloud API, a GPU machine on the LAN, local Speaches, or Telomi's bundled telomi-audio. Audio unifies these differences behind one Provider boundary: consumers supply a connection, and the module issues HTTP requests using that connection's declared wire protocol. Cloud and local services share the same abstraction and differ only in base URL; inference never runs inside the Node process.

## Interface

- Transcription: `transcribe` and `warmupStt` in `server/audio/providers/stt.ts`. Callers may supply a recognition selection; otherwise, the currently active recognition configuration applies.
- Speech generation: `server/audio/providers/tts.ts`. Callers first pin a selection at the operation boundary with `captureAudioGeneration(consumer)`, then pass it to `speak` (file), `speakStream` (playback stream), `speakPcm16Stream` (live PCM16), or `speakMany` (podcast batch). Consumers are `playback`, `local` (the live voice Worker), and `podcast`; each resolves its own connection.
- Local process: `getAudioLocalRuntimeManager().prepare(connection)`. Recognition consumers call it before using a connection; `tts.ts` calls it itself for each speech-generation request. This is the only place that decides whether to start a process.
- Audio generation configuration: save for later and save-and-apply at `/api/audio-config/generation`. Table edits initially remain on the settings page. Users may save for later (write `pending` without changing active configuration), save and apply (activate after validation), or discard changes. If application fails, the rejected configuration remains `pending`; reopening settings lets users apply it again or discard it. The [Voice module](voice.md) provides recognition configuration.
- Voice preview: `POST /api/audio-config/voice-preview` synthesizes preview text using the connection, model, voice, and speed from any settings-table row, without applying that configuration first. Identical selections and text reuse a cached mp3.
- Model and voice discovery belongs to the Provider connection catalog (`server/providers/custom-models.ts`); Audio reads the models and voices it stores for each connection.

## Main capabilities

- Select wire protocols per connection: OpenAI-compatible multipart transcription, JSON transcription, and OpenAI-compatible `/audio/speech`.
- Discover extensions declared by an endpoint at `/health`; use transcription Jobs, warmup, and concurrency limits only when declared.
- Obtain defaults from the endpoint's `/models` when a selection omits the model or voice.
- If an endpoint rejects an uploaded media type, convert it to wav with ffmpeg and retry once. Request speech in a format the model supports, then convert it to the caller's requested file format.
- Manage bundled telomi-audio startup, installation progress, and health readiness.

## Out of scope

- Vendor SDKs, brand-based dispatch, and inference inside Node.
- Transport, VAD, and turn control, which belong to the [Voice module](voice.md) and LiveKit.
- Starting user-operated services, including telomi-audio at other addresses.
- Managing LLM or embedding endpoints such as Ollama or LM Studio.
- Agent selection of speech Providers. Selections come from configuration applied by the user.

## Constraints and tradeoffs

### Models and voices

- If no model is selected, query the connection's `/models` for the capability: prefer the endpoint's declared `modality`, otherwise classify the model, including any listed Hugging Face `task`. If the endpoint lists nothing, the request fails with an error identifying the endpoint; Telomi does not invent a model ID.
- Available voices combine those the endpoint lists for the model (`supported_voices` or `voices`, plus `default_voice`) with voices saved for the connection during discovery. Only when both are empty does the built-in table of known cloud models in `registry.ts` apply. The list is advisory: gateways such as OpenRouter list only some vendor voices, so applying a manually entered, unlisted voice validates it by synthesizing a sentence. It fails only if the endpoint rejects it, retaining the endpoint's reason. If all three sources are empty, any manually entered voice is accepted directly.
- If voice is blank, use the endpoint's `default_voice`, then the first available voice. If neither exists, omit `voice` from the request. Services such as Speaches that require `voice` depend on endpoint-listed voices.
- Applying configuration rejects speeds outside the endpoint's reported `min_speed`/`max_speed`.

### Connections and protocols

- Connections default to OpenAI-compatible multipart transcription. Only connections declaring `compat.transcription: "json"` in the catalog, or built-in OpenRouter connections confirmed by the model registry, use the JSON transcription contract. A user-created OpenRouter-style gateway is not a built-in connection: that declaration must be added manually to `models.json`; the settings page does not write it.
- A built-in cloud Provider that can serve more than chat (OpenRouter, OpenAI) is a connection for every capability once it has a key, with no `models.json` entry: the chat credential signs in to embedding, speech and transcription too. `server/providers/builtin-connections.ts` owns its fixed endpoint, its key and its discovered embedding, speech and transcription models, which are saved per credential and relisted daily. A connection definition with the same id replaces the built-in. The key follows pi's rule: a stored credential owns the connection, and the environment variable applies only when nothing is stored. An OpenRouter OAuth login counts as a key because the login issues a permanent API key. Other Providers' OAuth sessions are chat-only tokens and serve chat only.
- Applying recognition checks each model against the endpoint's `/models`, then against its transcription listing (`/models?output_modalities=transcription`), because gateways such as OpenRouter list transcription models only there.
- Live snapshot recognition supports only multipart, so the local live selection cannot point to a JSON transcription connection.
- Applying speech-generation configuration requires the connection to declare audio generation, unless the model is in the built-in table or the connection declares no single capability (as with OpenRouter) and discovery classifies the model as speech generation. Those two model cases require only that the connection can authenticate, not that the model appears in the endpoint's `/models` list. Recognition rejects connections declared for other capabilities. Connections created through the individual capability settings pages are pinned to that capability, so that workflow requires separate STT and TTS connections. An existing connection with no single capability declaration can be reused when discovery identifies its STT and TTS models.
- Transcription base URLs allow plain HTTP only for loopback and private LAN addresses; public addresses require HTTPS. Link-local and cloud metadata addresses are rejected. URLs cannot contain credentials or queries, and audio uploads do not follow redirects.

### Extensions and health discovery

- Transcription Jobs are used only when requested by the caller and declared through `transcription-jobs`; otherwise, long input uses a single request. Only Job submission occupies a concurrency slot; the server queues running Jobs.
- Health responses and model lists are cached by connection catalog version. Endpoint responses, including 404, are cached. No response (connection failure or a three-second timeout) is not cached, so every request to an unreachable endpoint incurs another discovery timeout.
- `max_concurrency` limits simultaneous in-flight requests per base URL. Streaming responses occupy a slot through the final byte. Without a declaration, requests run in parallel.
- `speakMany` retries a segment refused with 429 or 5xx, or whose connection dropped, up to five attempts with exponential backoff. A batch is long and costly to restart, and one throttled request among dozens must not fail it. Other refusals fail at once, and the single-utterance calls do not retry, because a live listener is better served by a fast failure.
- A rejected media type (415, or 400 with a body indicating a decoding failure) triggers one retry after conversion to wav. If ffmpeg is unavailable, the error includes the endpoint, status code, and missing ffmpeg dependency.
- Live PCM frames use `TELOMI_AUDIO_TTS_SAMPLE_RATE` (24 kHz by default, the OpenAI contract's sample rate). This is a global setting, not per connection; endpoints with a different PCM sample rate require adjusting it.

### Managed telomi-audio

- Connection ID `telomi-audio` (`MANAGED_AUDIO_CONNECTION_ID`) is the only connection Telomi may start, and only when it points to the local runtime address (`TELOMI_AUDIO_STT_BASE_URL`, default `http://127.0.0.1:9595/v1`). The same service at another user-entered address, or another connection pointing to this address, is treated as externally operated and is never started.
- Protocols, extensions, and defaults do not depend on managed status; they always come from the endpoint's declarations.
- When the runtime turns healthy, including one already running when the server starts, Runtime writes the `telomi-audio` catalog entry from the service's own model listing, so settings offer, test and preview its models and voices like any connection. An entry the user deleted or pointed at another address is not rewritten.
- Starting telomi-audio installs its pinned STT and TTS models before the service answers `/health`, so no speech request downloads a model. Each model writes its own install status; the runtime reports whichever is downloading, else a failure, and ignores statuses written before the current start.
- A running service Telomi started that stops answering `/health` is waited on for up to a minute before it is stopped and replaced, and is replaced at once if it exits. The service answers `/health` while it is generating or transcribing, so only a wedged process is replaced and an in-flight request is never cut off by another request's readiness check.

### Adding a vendor without OpenAI compatibility

The speech Provider boundary requires only one protocol file and one dispatch branch to add a vendor without OpenAI compatibility. A protocol is an ID in `registry.ts`, selected by the catalog's connection declaration, not by connection ID. The implementation goes in a new protocol file, with one additional branch in each STT and speech-generation entry point. If other changes are required, the dispatch boundary no longer holds and must be reassessed first.

## Node and telomi-audio contract

Node treats telomi-audio as an ordinary OpenAI-compatible speech endpoint. The service declares the additional endpoints below, and Node uses them only when declared. The service implementation in `apps/telomi-audio-local/app.py` is authoritative for field names and payload shapes; see `apps/telomi-audio-local/README.md` for server configuration.

| Endpoint | Contract |
|---|---|
| `GET /health` | Sits beside the API root (`<host>/v1` corresponds to `<host>/health`). Declares available extensions (`warmup`, `transcription-jobs`) and the desired number of simultaneous in-flight requests. Extensions whose corresponding optional models cannot load are not declared. Must answer while requests are being served. Other content is diagnostic only. |
| `GET /v1/models` | Each available model declares whether it serves STT or TTS. TTS models also declare their default voice, available voices, output formats, and accepted speed range. |
| `GET /v1/audio/voices` | Endpoint-wide voice list following the Open WebUI convention, with the same voices as the model list. Discovery uses this list for TTS models without their own voices. |
| `POST /v1/audio/warmup` | Loads a model by capability (ASR or TTS) and model, without inference. The service must report the requested model as loaded, otherwise Node treats warmup as failed. An unavailable model returns 409. |
| `POST /v1/audio/transcriptions` | OpenAI multipart contract. Services without VAD support ignore the optional VAD form fields. |
| `POST /v1/audio/transcription-jobs` | The same multipart request as transcription, plus an idempotency key derived from the audio and parameters. Resubmitting the same key returns the original Job unless it failed or was cancelled. Returns 200 if complete, otherwise 202. |
| `GET /v1/audio/transcription-jobs/{id}` | Job status. Node polls at the service-recommended interval (at most five seconds) until success, failure, or cancellation. A successful status carries a result with the same shape as a transcription response. Unknown Jobs return 404. |
| `DELETE /v1/audio/transcription-jobs/{id}` | Cancels a Job. Returns 202 when cancellation starts, or 200 if already finished. Node sends it when a caller aborts its wait. |
| `POST /v1/audio/speech` | OpenAI contract. PCM output is streamed whether or not streaming was requested. |

Undecodable uploads, such as webm/opus browser recordings that `soundfile` cannot read, return 415 to request transcoding and resubmission by the caller.
