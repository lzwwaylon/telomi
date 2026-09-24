# Voice

## Purpose

Voice owns user-facing speech interaction: dictation in Goal conversations, live voice conversations and their live transcript preview, and their configuration, history, and dictionaries. It turns a recording into sendable text and Goal Main Agent answers into speech while ensuring that settings changed during recording do not alter its result. STT and TTS requests themselves belong to the [Audio module](audio.md).

## Interface

- Dictation: `/api/goals/:goalId/voice/transcribe` (browser-uploaded recordings), `/voice/warmup`, `/voice/context-snapshots`, and `/voice/discarded`.
- Live voice conversations: `/api/goals/:goalId/voice/livekit/token` issues room tokens; `server/voice/livekit-agent-worker.ts` is the LiveKit Agent Worker entry point.
- Recognition configuration: save for later and save-and-apply at `/api/audio-config/recognition` (`mountSpeechConfigurationApi`). Voice preferences, previews, and the voice library use `/api/audio-config`.
- Dictionaries, snippets, correction learning, and voice history: `/api/voice/*`.

## Main capabilities

- Transcription pipeline: build the STT prompt from the dictionary, call Audio for transcription, reject dictionary echo, normalize Chinese character forms, expand snippets, optionally perform AI text cleanup, and write voice history.
- Live preview: during a live voice conversation, periodically retranscribe all PCM accumulated in the current utterance. Each result is a replaceable hypothesis; the final text still comes from transcription of the complete utterance. Dictation has no preview and transcribes once after the user stops.
- Live voice conversations: LiveKit owns transport, Silero VAD, and turn control. `TelomiVoiceInputSTT` uses the same transcription path as dictation; `PiGoalLiveKitLLM` connects streaming Goal Main Agent output to the session; `QwenLiveKitTTS` synthesizes PCM using the `local` consumer's audio-generation selection.
- Recognition configuration: ordinary recognition, local live/snapshot recognition, and explicit fallback recognition selections, with validation and tracking of when each consumer adopts new configuration.
- Correction learning and voice-history retention.

## Out of scope

- Wire protocols and endpoint, model, or voice selection; Audio resolves these by connection.
- Official LiveKit STT/TTS plugins. The LiveKit Worker is a thin adapter over Telomi Providers.
- Duplicating Main Agent reasoning and tools in LiveKit sessions. Goal Main Agent supplies semantic answers.
- Agent or LLM decisions about which speech Provider to use.
- Language-selection contracts, documented in [Localization](localization.md).

## Constraints and tradeoffs

- Each recording pins an utterance context at startup: language, VAD parameters, cleanup toggle, cleanup model and instructions, and dictionary and snippet versions. Settings changed while recording take effect on the next recording. A transcription request whose parameters disagree with the pinned context returns 409.
- If AI text cleanup fails, retain the original transcript and notify the user without blocking sending.
- A transcription request whose client disconnects before the response is cancelled: recognition and cleanup are aborted and the utterance is never recorded as completed or failed. It is kept only as a discarded recording, under the same retention rules as a cancel during recording.
- Explicit fallback recognition applies only when the primary recognition connection is managed telomi-audio, the user enabled fallback, and the failure is neither silence nor cancellation. The fallback cannot be a managed connection.
- Live preview takes snapshots through the ordinary transcription endpoint and requires no streaming interface, so any multipart transcription endpoint can provide previews. The local live selection therefore cannot be a JSON transcription connection. The snapshot cadence is a Runtime constant tuned against local model load, not a user setting.
- Warmup is sent only when the endpoint declares `warmup`; other endpoints load models on first transcription. Preview readiness copy depends on whether the connection is managed (warming up the local model for managed connections, connecting to the speech service otherwise), independently of the `warmup` declaration.
- Local VAD parameters are sent as form fields. Only supporting endpoints (telomi-audio) apply them; other endpoints ignore them while the configuration remains stored.
- Calling `prepare` from voice routes can start only managed telomi-audio. Selections pointing to other services never start a process.
- Correction learning learns only words in Latin letters. It splits at whitespace and Chinese-character boundaries and filters by character edit distance, so English words without surrounding spaces in Chinese sentences can still be learned. Chinese corrections cannot be segmented reliably and do not enter the dictionary.
