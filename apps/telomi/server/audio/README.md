# Telomi Audio

This module owns Telomi's STT and TTS Provider seam. Product callers use
`providers/stt.ts` and `providers/tts.ts`; they do not load a Pi Extension and
do not choose infrastructure through an Agent.

Every connection is an endpoint. The execution mode is only whether Telomi may
run the process behind it: the managed connection (`MANAGED_AUDIO_CONNECTION_ID`,
tested by `isManagedAudioConnection`) at the local runtime's address is the
bundled `apps/telomi-audio-local`, started through `local-runtime.ts` `prepare`.
Protocol, extensions and defaults never depend on it; each endpoint declares
them on `/health` and `/models`.

Read before changing this module:

- [Audio module](../../docs/modules/audio.md): responsibilities, the health and
  models contract, the telomi-audio extension endpoints, and the constraints
  that the code does not show.
- [Speaches reference](../../docs/local-speech-server.md): the verified
  third-party local server and its settings.
- `apps/telomi-audio-local/README.md`: running and configuring the bundled
  service.

`TELOMI_AUDIO_*` is the only supported environment namespace.
