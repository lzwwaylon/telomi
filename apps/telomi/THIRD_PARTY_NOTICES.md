# Third-party notices

## Craft Agents

Portions of Telomi's chat presentation, message attachments, streaming Markdown,
textarea sizing, tool icon resolution, and loading indicator were originally
adapted from Craft Agents and have since been reorganized and modified for
Telomi. The exact upstream revision of the original adaptation was not recorded;
the upstream project and required attribution are retained below.

Source: https://github.com/craft-ai-agents/craft-agents-oss

Licensed under the Apache License, Version 2.0.

Craft Agents

Copyright 2026 Craft Docs Ltd.

This product includes software developed by Craft Docs Ltd.

https://craft.do

## OpenWhispr

Portions of the voice input implementation are adapted from OpenWhispr at local
source commit `e1cb8301d898881e28372e61ba15a8fd57f4f25b`, including the PCM
AudioWorklet buffering strategy, local speech gate, microphone device
selection reconciliation, built-in microphone detection, raw capture
constraints, and track readiness behavior. The deterministic correction learner's tokenization, word-level LCS,
edit-distance filtering, and rewrite threshold are also adapted. The local
history record shape, separate audio-file retention, failed-transcription
recovery, and current-provider retry behavior are based on OpenWhispr's
database, audioStorage, audioManager, discardedRecording, and retry routing
modules. This includes the optional recovery gate for user-cancelled recordings.
The transcription language option registry, `auto` behavior, and conversion
from displayed regional variants to base Provider language codes are adapted
from OpenWhispr's languageRegistry and languageSupport modules. The
explicit, default-off local-to-cloud transcription fallback and the rule that
silence/no-audio must not trigger a cloud attempt are adapted from
OpenWhispr's settingsStore and audioManager behavior. Telomi's Provider-neutral
routing module, structured attempt ledger, cancellation gate, settings UI, and
history presentation are original adaptations for this project. The
Unicode-normalized dictionary prompt echo matcher, including its exact-match,
text-composition, and dictionary-usage thresholds, is a close TypeScript port
of OpenWhispr's dictionaryEchoFilter. Telomi's placement of that matcher inside
the Provider routing boundary, its no-audio result mapping, and its cloud
fallback privacy gate are project-specific integrations.
The literal complete and unterminated lowercase `<think>` block matcher used at
the voice cleanup output boundary is a close TypeScript port of OpenWhispr's
`stripThinkingTags` helper. Telomi additionally excludes structured thinking
content exposed by its model library and maps an empty visible result to the
existing canonical-transcript fail-open path. OpenWhispr's Provider-specific
thinking suppression dialect table was not copied. Telomi delegates request
dialect generation to its existing `pi-ai` Provider adapters by leaving the
reasoning option unset.
The English cleanup rules are Telomi's own translation of that ported zh-CN
prompt, keeping its structure, dictionary block, and preference block.
The user-facing ability to customize the dictation cleanup prompt is adapted
from OpenWhispr's prompt registry, settings store, and Prompt Studio. Telomi does
not copy Prompt Studio, Zustand, localStorage synchronization, or the upstream
rule that a custom prompt completely replaces the default. Telomi keeps its
fixed cleanup safety and output-only contract, adds bounded supplemental
preferences with escaped delimiters, freezes them in its own content-addressed
Utterance Context, and implements its own settings API and React editor.
The 256-byte minimum recording size, received-chunk check, and distinction
between `no-audio-data` and `empty-container` are close TypeScript ports of
OpenWhispr's recordingGuard and recordingValidation modules. Telomi additionally
applies the check at its browser capture result, HTTP boundary, retained-audio
retry Pipeline, and discarded-recording endpoint.
The local ASR wake-time rewarm lifecycle and its concurrency test semantics
are based on OpenWhispr's `whisperWakeRewarm` behavior. Telomi does not copy its
whisper.cpp subprocess implementation; it adapts the lifecycle to an
idempotent `telomi-audio-local` model-load contract with readiness metadata and
idle eviction.
OpenWhispr's language and dictionary read points were also used to
identify configuration drift during a long recording. OpenWhispr does not
provide the content-addressed Utterance Context used here. Telomi's persisted
`voice_ctx_*` schema, integrity validation, replay API, and History version
binding are original project code, not copied OpenWhispr snapshot code.
OpenWhispr preserves `zh-CN` and `zh-TW` in its language registry, reduces the
value to base `zh` at the Whisper Provider boundary, and can ask its optional
cleanup model to use the selected script. Telomi follows the same regional
preference and base-language separation, but its deterministic OpenCC
normalization, script metadata, and script-neutral content CER are original
Telomi integration code rather than copied OpenWhispr code.
OpenWhispr's `scripts/meeting-diarization-eval.js` also informed the evaluation
CLI's fixture selection, machine-readable JSON output, and non-zero failure
behavior. The pinned checkout has no ordinary-dictation WER/CER harness, so
Telomi's manifest validation, transcript normalization, edit-distance metrics,
term metrics, coverage gate, AB/BA run scheduler, latency aggregation, and
production Pipeline runner are original project implementations rather than a
port of OpenWhispr scoring code.
OpenWhispr's `whisperVad.json`, `whisperVadConfig.js`, settings defaults, and
whisper.cpp argument assembly informed Telomi's local VAD parameter names,
defaults, bounds, and fail-open behavior. Telomi does not copy OpenWhispr's
whisper.cpp subprocess or GGML model topology. It maps the same product
contract onto the existing Qwen sidecar with a provider-neutral TypeScript
configuration seam and a Silero ONNX preprocessing module.
OpenWhispr's self-hosted transcription activation, route precedence, endpoint
normalization, optional model, and local/private HTTP versus public HTTPS
behavior informed Telomi's OpenAI-compatible STT Provider contract. Telomi's
endpoint safety policy, masked secret API, dynamic model catalog, mixed-model
filtering, streaming snapshot integration, Workspace settings UI, and History
integration are original project implementations rather than copied
OpenWhispr source.
The exact recognition of `[BLANK_AUDIO]` and `[ blank_audio ]` as no-audio
sentinels is a close TypeScript port of OpenWhispr's `whisper.js` helper.
Telomi places this normalization at its Provider-neutral routing boundary and
uses the resulting no-audio state to prevent text processing and cloud
fallback. That routing placement and privacy integration are project-specific.
The opening-character set, leading-punctuation set, and prepend decision order
used by `voiceComposerText.ts` are a close TypeScript port of OpenWhispr's
`smartSpacing.js` prepend behavior. Telomi applies the rules to its own
ChatComposer state and does not copy OpenWhispr's clipboard, Accessibility, or
cross-application paste integration.
The two-note recording start and stop cue frequencies, timing, gain envelope,
default-on setting, and successful-start/successful-stop trigger boundaries are
a close TypeScript adaptation of OpenWhispr's `dictationCues.js`,
`useAudioRecording.js`, and `settingsStore.ts`. Telomi adds a browser user-gesture
preparation step and freezes the preference for one recording.
The default-off `pauseMediaOnDictation` preference, successful-recording trigger,
immediate release on recording end/error/cancel, and "resume only media paused by
this dictation" behavior are adapted from OpenWhispr's `useAudioRecording.js`,
`settingsStore.ts`, and `mediaPlayer.js`. Telomi's in-app PlayerContext scope,
reference-counted pause leases, track identity check, user-playback-intent
invalidation, and React integration are original project implementations.
The successful-recording-only Escape cancel shortcut lifecycle and its connection
to discarded-recording recovery are based on OpenWhispr's `useAudioRecording.js`,
HotkeyManager cancel slot, IPC handlers, and discardedRecording module. Telomi's
initial recording-only browser listener, IME/repeat/default-prevented guards,
shared cancel callback, and ChatComposer feedback are original project
implementations. The later starting-stage extension is described separately
below and does not create discarded audio before recording begins.
OpenWhispr's sherpa-onnx online stream lifecycle, finalized-segment accumulator,
Done/Done! flush, truncation reporting, generation guard, and chunked/batch
fallback informed Telomi's true-streaming design audit. No Parakeet manager,
sherpa binary launcher, Nemotron model, Electron IPC, or online-stream source was
copied in this slice. Telomi retains its provider-neutral streaming Adapter and
Qwen glossary-aware batch final; any future local streaming Provider must pass
the project's Chinese terminology, latency, memory, and lifecycle gates.
OpenWhispr's OpenAI Realtime 15-second ping/pong liveness interval, missed-pong
termination, ping-failure termination, and cleanup semantics are adapted in
Telomi's optional OpenAI transcription Adapter. Telomi emits a recoverable Runtime
warning and preserves its independent MediaRecorder batch final. It does not
copy OpenWhispr's 55-minute meeting-session reconnect because Telomi's ordinary
dictation Utterance is capped at 120 seconds and owns one Adapter instance.
Telomi does not copy OpenWhispr's Electron or native global-hotkey backends.
OpenWhispr's fresh-install `preferBuiltInMic=true` setting also informs Telomi's
fresh-browser microphone default. Telomi represents system default, built-in
preference, and pinned device as one browser-local tagged preference. Missing
labels or a missing built-in device still fail open to the browser's system
default, while an explicit user choice of system default remains persisted.
The predicate that recognizes an `OverconstrainedError` with a `deviceId`, empty,
or missing constraint as a stale pinned microphone is a close TypeScript port of
OpenWhispr's `staleMicDevice.js`. Telomi's integration into its microphone Module,
separate dead-track recovery, normalized browser errors, one-request permission
failure behavior, and accessible React error notice are project-specific
adaptations.
OpenWhispr's recording start/stop locks and deferred stop during an in-progress
streaming start informed Telomi's starting-stage cancellation behavior. Telomi's
control-state resolver, Utterance generation guard, pending capture ownership,
late-stream cleanup, browser Escape handling, and React UI are original project
implementations. No OpenWhispr Hook, AudioManager, or Electron IPC source was
copied for this behavior.
OpenWhispr's processing-stage cancel control and its check before delivering a
late transcription result informed Telomi's finalizing-stage cancellation
semantics. Telomi uses its existing HTTP AbortController, Utterance generation
guard, control-state resolver, browser Escape lifecycle, and React UI. No
OpenWhispr App, Hook, or AudioManager source was copied for this behavior.
The Today, Yesterday, and explicit-date History grouping semantics are adapted
from OpenWhispr's `dateFormatting.ts` and `HistoryView.tsx`. Telomi adds an
injectable clock for deterministic tests, fixed `zh-CN` display formatting, an
invalid-date fallback, and integration with its own JSON Ledger and React
settings UI.
The `mm:ss` formatter and the rule that a discarded History card displays its
positive recorded duration after rounding to whole seconds are close
TypeScript adaptations of OpenWhispr's `formatDuration.ts` and
`TranscriptionItem.tsx`. Telomi adds finite-value validation and consumes the
existing `durationSec` value from its own Voice History Ledger.
The rule that completed History keeps non-empty Provider raw text inspectable
even when it exactly equals the final text, together with an explicit
unchanged-text explanation, is adapted from OpenWhispr's
`TranscriptionItem.tsx`. Telomi does not copy that component's JSX. It maps the
behavior onto its own History card and uses persisted cleanup metadata to
distinguish "cleanup was not applied" from "cleanup ran but did not change the
text."
The rule that deleting one History entry must first pass through an explicit
destructive confirmation is adapted from OpenWhispr's `ControlPanel.tsx` and
`useDialogs.ts`. Telomi does not copy OpenWhispr's dialog JSX, Electron IPC, or
store implementation. It uses its own Radix dialog, JSON Ledger deletion API,
retained-audio warning, in-flight duplicate guard, failure-retain-and-retry
state, and browser transport error normalization.
The rule that clearing all History must also pass through an explicit
destructive confirmation, together with the warning that all transcriptions
and retained audio files are permanently deleted, is adapted from
OpenWhispr's `ControlPanel.tsx`, `useDialogs.ts`, and `zh-CN` locale. Telomi does
not copy the upstream dialog JSX, Electron IPC, or store implementation. Its
frozen record, hidden-discarded, and retained-audio counts, synchronous
duplicate guard, busy close gate, authoritative-success commit, and
failure-retain-and-retry behavior are original project integrations.
The error-code vocabulary used for failed History entries, the distinction
between configuration, quota, and offline recovery guidance, and the rule that
configuration guidance only promises retry when retained audio exists are
adapted from OpenWhispr's `src/types/electron.ts` and
`src/components/ui/TranscriptionItem.tsx`. Telomi does not copy that component's
JSX, Electron IPC, AudioManager, Zustand, or SQLite implementation. Its
failure classifier and precedence, Provider-to-settings target mapping,
Express and JSON Ledger integration, focus navigation, and browser E2E are
original project implementations.
The persistent History notice shown while data retention is disabled is adapted
from OpenWhispr's `src/components/HistoryView.tsx` and its locale text. Telomi
does not copy the upstream JSX, settings store, Electron IPC, or SQLite
implementation. Its accessible status component, explicit enable-history
action, HTTP settings update and authoritative reload, preservation of existing
records and audio, and browser E2E are original project implementations.
The case-insensitive search of final transcription text is adapted from
OpenWhispr's `src/components/CommandSearch.tsx`. Telomi does not copy the
upstream dialog JSX, global shortcut, notes search, Zustand store, Electron IPC,
or five-result presentation cap. Its inline History control, NFC normalization,
trimmed-query behavior, final-text-only privacy boundary, accessible result and
empty states, clear action, and browser E2E are original project integrations.
The rule that a History load failure must remain explicit and reach a
user-visible recovery path is adapted from OpenWhispr's
`src/stores/transcriptionStore.ts`, `src/components/ControlPanel.tsx`, and
locale text. Telomi does not copy the upstream ControlPanel JSX, alert dialog,
Zustand store, Electron IPC, or SQLite implementation. Its page-local retry,
last-successful-snapshot preservation, request generation, failed filter-target
retention, commit-after-success state, HTTP loader module, and browser fault
injection tests are original project integrations.
The expectation that an already-open History view receives newly added records
is adapted from the event-listener lifecycle in OpenWhispr's
`src/stores/transcriptionStore.ts`. Telomi does not copy the upstream Zustand
store or Electron transcription-added, updated, deleted, or cleared IPC
listeners. Its Web adaptation refreshes the authoritative HTTP snapshot when
the page regains focus or becomes visible, coalesces paired foreground events,
skips refresh while a request is already running, and provides an explicit
manual refresh action. The event helper, React integration, HTTP behavior, and
browser E2E are original project implementations.
The optional `test:voice-stt:openwhispr-parity` development command loads pure
helper modules from a separately supplied, commit-pinned OpenWhispr checkout
and compares them with Telomi production functions on shared boundary vectors.
The optional `test:voice-stt:openwhispr-upstream` command runs a fixed list of
the checkout's unmodified, voice-related tests behind the same commit gate. A
Telomi-authored test-only loader stub supplies the minimal Electron app boundary
needed to load selected pure modules without installing or starting Electron;
it does not replace OpenWhispr production behavior or modify its checkout.
These commands do not bundle OpenWhispr source into Telomi or run in the product
Runtime. Several parity vectors are derived from OpenWhispr's MIT-licensed test
cases; project-specific safety and integration cases remain separate.

Copyright (c) 2024 OpenWhispr Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## opencc-js and opencc-data

Telomi uses `opencc-js` 1.4.1 for deterministic Simplified Chinese and Taiwan
Traditional Chinese normalization after Provider transcription, and for the
script-neutral projection used by content CER. The exact package version is
pinned in `package.json` and `package-lock.json`. Its dictionaries are bundled
at package build time, so Telomi performs no runtime dictionary download.

`opencc-js` is licensed under `MIT AND Apache-2.0`. The JavaScript
implementation carries the MIT license below. The bundled dictionary data is
derived from `opencc-data` and remains under Apache License 2.0. The npm package
ships the complete Apache 2.0 text in `LICENSES/Apache-2.0.txt` and reproduces
it in `THIRD_PARTY_LICENSES.md`.

opencc-js: https://github.com/nk2028/opencc-js

opencc-data: https://github.com/nk2028/opencc-data

MIT License

Copyright (c) 2020-2021 The nk2028 Project

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Silero VAD

`apps/telomi-audio-local/vad.py` contains a NumPy adaptation of the stateful ONNX
wrapper and speech timestamp hysteresis/padding algorithm from Silero VAD
v5.1.2 `utils_vad.py`. Telomi downloads the official v5.1.2 ONNX model from the
Silero repository, pins SHA-256
`2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`,
and validates it before model load. Audio extraction, bounded overlap,
processed-to-source timestamp mapping, Provider fail-open integration, health
metadata, settings persistence, and the evaluation harness are Telomi-specific
code.

MIT License

Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ONNX Runtime

The local audio sidecar uses ONNX Runtime 1.27.0 to execute the pinned Silero
VAD model on CPU.

MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## M-flow evaluation fixture

The provisional local voice evaluation manifest references
`m_flow/tests/test_data/text_to_speech.mp3` from M-flow commit
`9df82e8499a83b68cebc59d1a2eecd2a302e7796`. The audio remains in the separately
checked-out M-flow repository and is not copied into Telomi. M-flow is licensed
under Apache-2.0.

M-flow - Cognitive memory engine for AI agents

Copyright 2026 Junting Hua

## AISHELL-1 and Qwen3-ASR evaluation fixture

The local voice evaluation manifest references the Mandarin utterance
`BAC009S0764W0121.wav` from the AISHELL-1 corpus, distributed under
Apache-2.0. The Qwen3-ASR official example publishes the same bytes as
`asr_zh.wav` and supplies the source transcript in its forced-aligner example.
Telomi pins the audio SHA-256 and only downloads it after the developer passes
the explicit `--fetch-remote-fixtures` flag. The bytes are stored in the local
ignored `.pi` content-addressed cache. `scripts/generate-voice-vad-fixtures.ts`
derives `voice-evals/generated/v1/aishell-white-noise-5db.wav` from them by
adding one second of silence at each edge and seeded 5 dB SNR white noise. The
derived file is regenerated on demand into the ignored
`voice-evals/generated/` directory and is not committed to Telomi. It retains
the source Apache-2.0 license and is not a new human or hardware microphone
recording.

AISHELL-1: An Open-Source Mandarin Speech Corpus and A Speech Recognition Baseline

Qwen3-ASR example commit: `7c6daf77a2421100f5fb066495372c00129d39ff`

AISHELL-1 and Qwen3-ASR are licensed under Apache-2.0.

## Local Qwen3-ASR model bootstrap

The local audio bootstrap downloads the quantized model repository
`aufklarer/Qwen3-ASR-0.6B-MLX-4bit` at commit
`bc441bd1e4295c1f42d9879f056049a925b6e013`. It also downloads the matching
`preprocessor_config.json` from the official `Qwen/Qwen3-ASR-0.6B` repository
at commit `5eb144179a02acc5e5ba31e748d22b0cf3e303b0`, because the pinned quantized
repository does not include that mlx-audio runtime asset. Both repositories
declare Apache-2.0. Model bytes remain in the user's local cache and are not
committed to Telomi.

## Local Qwen3-TTS model bootstrap

The local audio bootstrap downloads the quantized model repository
`mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit` at commit
`049ef77fe8816b536193c0c25f9a214d17921282`, converted from the official
`Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`. Both repositories declare Apache-2.0.
Model bytes remain in the user's local cache and are not committed to Telomi.

## LibriSpeech and Qwen2-Audio evaluation fixture

The local voice evaluation manifest references LibriSpeech dev-clean utterance
`1272-128104-0000.flac` and its source-authored transcript from the official
OpenSLR archive. OpenSLR distributes LibriSpeech under CC BY 4.0. Telomi uses
the official Qwen2-Audio example URL as a stable per-file mirror only after the
developer passes `--fetch-remote-fixtures`; the mirrored bytes have the same
SHA-256 as the FLAC inside the official `dev-clean.tar.gz` archive. The audio
is stored in the ignored `.pi` content-addressed cache.
`scripts/generate-voice-vad-fixtures.ts` derives
`voice-evals/generated/v1/librispeech-long-pause.wav` from it by repeating the
same utterance around pinned leading, internal and trailing silence. The
derived file is regenerated on demand into the ignored
`voice-evals/generated/` directory, is not committed to Telomi, and remains
under CC BY 4.0.

LibriSpeech: An ASR corpus based on public domain audio books

Authors: Vassil Panayotov, Guoguo Chen, Daniel Povey, Sanjeev Khudanpur

LibriSpeech is licensed under CC BY 4.0.

## TaiMECS evaluation fixtures

The local voice evaluation manifests reference TaiMECS human recordings
`001.mp3` and `020.mp3` plus their source-authored transcripts from dataset
commit `83f397e41840ba187cc6833e1320bd2e5fa858f1`. TaiMECS contains Taiwan
Mandarin-English code-switching sentences. Its pinned `metadata.jsonl` marks
both selected rows as `human`. Telomi pins both audio SHA-256 values and only
downloads the files after a developer passes the explicit
`--fetch-remote-fixtures` flag. The bytes remain in the local ignored `.pi`
content-addressed cache and are not committed to Telomi. The dataset does not
identify the physical microphone make and model, so these records never
satisfy the hardware-verified microphone gate.

TaiMECS

Creator: Jacob Lin

Dataset: https://huggingface.co/datasets/JacobLinCool/TaiMECS

TaiMECS is licensed under CC BY 4.0.

## DEMAND living-room evaluation fixture

The public acoustic evaluation manifest uses channel 01 of the 16 kHz
`DLIVING` recording from the Diverse Environments Multichannel Acoustic Noise
Database. `scripts/generate-public-acoustic-fixtures.ts` downloads the pinned
archive, selects a deterministic segment beginning at 60 seconds, and mixes it
with the separately licensed AISHELL-1 utterance at 8 dB SNR. The derived
fixture `voice-evals/generated/public-acoustic-v1/aishell-demand-living-8db.wav`
is regenerated on demand into the ignored `voice-evals/generated/` directory
and is not committed to Telomi, so no ShareAlike-licensed audio is
redistributed with this repository. It is a real environmental-noise recording
combined with separate speech, not a direct microphone or hardware-identity
capture.

DEMAND: A collection of multi-channel recordings of acoustic noise in diverse
environments

Authors: Joachim Thiemann, Nobutaka Ito, Emmanuel Vincent

Dataset: https://zenodo.org/records/1227121

The dataset description distributes the recordings under CC BY-SA 3.0. Telomi
uses that conservative license declaration for the derived fixture.

## Sony Keyboard Sound Dataset evaluation fixture

The public acoustic evaluation manifest uses twelve real pantograph keystroke
recordings from the Sony Keyboard Sound Dataset. The deterministic generator
overlays the selected recordings on the separately licensed AISHELL-1
utterance at an aggregate 8 dB SNR. The derived fixture
`voice-evals/generated/public-acoustic-v1/aishell-sony-keyboard-8db.wav` is
regenerated on demand into the ignored `voice-evals/generated/` directory and
is not committed to Telomi. It is a real keyboard-noise distribution combined
with separate speech, not a direct capture from either locally verified
microphone.

Sony Keyboard Sound Dataset

Authors: Tetsuya Yamamoto, Tsubasa Masuyama, Yuki Mitsufuji

Dataset: https://zenodo.org/records/16564409

The keyboard recordings are licensed under MIT. The AISHELL-1 source speech
remains under Apache-2.0.

## AMI Meeting Corpus far-field evaluation fixture

The public acoustic evaluation manifest includes a deterministic crop from
`ES2008a.Array1-01.wav`, recorded through the AMI table-top microphone array.
The crop covers 32.265 through 44.976 seconds and uses the corresponding AMI
manual word annotations as its source-authored reference. The derived file
`voice-evals/generated/public-acoustic-v1/ami-es2008a-array1-01-segment.wav` is
regenerated on demand into the ignored `voice-evals/generated/` directory and
is not committed to Telomi. It demonstrates a public real far-field recording
condition, but it does not establish a locally observed browser microphone
identity.

AMI Meeting Corpus

Corpus download and license: https://groups.inf.ed.ac.uk/ami/download/

The AMI signals and manual annotations are licensed under CC BY 4.0.

## writing-skill

The Research Report Writer vendors the deterministic prose scanner and the
prose/thesis references from grapeot/writing-skill at commit
`9f2f6974a143de92c52dc5be1bfd931018a09f39`, under
`agents/research/report-writer/skills/writing-skill/`. `formatter.py` and
`external_prose_lint_cli.py` are unmodified; `scanner.py`, `rules.py` and
`models.py` carry small Telomi changes. `run.py` exposes the scanner as Prime's
native awaitable and is Telomi's own. `SKILL.md` is adapted to the Report
Writer's stage contract, and the upstream workflows that Reporter cannot run
are omitted. `VENDORED.md` in that directory records the full delta.

Project: https://github.com/grapeot/writing-skill

Copyright (c) 2026 grapeot. Licensed under the MIT License. The complete
license is retained in
`agents/research/report-writer/skills/writing-skill/LICENSE`.

## OpenWiki

The Wiki Runtime was originally adapted from langchain-ai/openwiki commit
`9a02b3516fe1706d6e8f23557ac42f42a6d0896a` and has since been rewritten. The
remaining upstream material is limited to the `CONTROL_MARKDOWN` filename set,
the `WikiNode` and `WikiGraph` field shapes, and the YAML parse options in
`splitFrontmatter`. Wiki indexing, link validation and Mermaid handling were
written independently and no longer derive from OpenWiki.

Project: https://github.com/langchain-ai/openwiki

OpenWiki is licensed under MIT. The complete notice is retained in
`server/wiki/model/OPENWIKI_LICENSE.md`.

## force-graph

The Wiki visualizer uses force-graph 1.49.5 for the interactive canvas graph.

Project: https://github.com/vasturiano/force-graph

Copyright (c) 2018 Vasco Asturiano. Licensed under the MIT License. The
complete license is distributed with the package at
`node_modules/force-graph/LICENSE`.
