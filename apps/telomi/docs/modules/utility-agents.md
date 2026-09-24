# Utility Agents

## Purpose

Utility Agents provide supporting semantic capabilities to the main workflows. They do not share a business state machine, but each connects through an explicit, narrow interface. They must not grow into a second Main Agent or Research Runtime.

## Current capabilities

| Capability | Main function | Execution |
|---|---|---|
| Model Connectivity Test | Verify that a specified Provider and model return `OK` under the contract | Codex uses Research Model Gateway; other Providers issue a minimal completion directly with the same model registry and credentials |
| Voice Cleanup | Clean punctuation and formatting and apply the custom dictionary to raw STT text, retaining the original on failure | Direct small-model call without tools |
| Podcast Writer | Generate a single-narrator Podcast Script from a Canonical Report and frozen Podcast Generation Brief | Prime Root and RLM children |
| LiveKit Voice Entry | Connect VAD, STT, streaming Goal Main Agent interaction, and TTS | LiveKit Agent Session; semantic answers still come from Goal Main Agent |

## Main capabilities

- Model Connectivity Test independently checks authentication, Provider connectivity, and model connectivity.
- Voice Cleanup cleans raw transcription with fail-soft behavior, without blocking the user from sending a message.
- Podcast Writer reads a Canonical Report and one frozen Podcast Generation Brief, generates a segmented script, then hands it to TTS and audio assembly.
- Runtime renders Podcast Writer's segment-child contract into `inputs/segment-contract.md` in Worker Workspace (the `podcast-writer` `reference` Prompt). Root references it in assignments rather than paraphrasing it. During segmentation, Runtime checks that assignments reference the contract, omit transitions between segments, and include every contract-listed field in the ledger, allowing at most two repair rounds per stage. Transitions and the episode's single ending belong to Root's merge stage: a child given a transition will include it in its body, and the last segment has no next segment to introduce, so its transition field contains an ending, causing the episode to end more than once.
- LiveKit Voice Entry turns live voice input into the same Goal conversation and streams Main Agent output as speech.

## Responsibility boundaries

- Model Connectivity Test verifies only a minimal call to the target model, not availability of the full Agent toolchain.
- Voice Cleanup must not change user intent; callers fall back to the original transcript on failure.
- Podcast Writer does not perform Research or search User Memory. It consumes only the generated report and a Brief resolved by the caller.
- Podcast Root edits existing text to own the opening, transitions, and single ending; an extra closing segment is not required. Style comes from the Podcast Generation Brief resolved by the caller from User Memory and the current instruction. The listener cold read examines both script and Brief and offers editorial advice; it does not independently decide information density, technical depth, or publication acceptance. Root verifies the advice before revising, preserving factual qualifications and necessary conditions.
- LiveKit Agent does not duplicate Main Agent reasoning or tools. `PiGoalLiveKitLLM` is only a streaming Goal adapter.

## Verification

Final acceptance of model connectivity, Voice Cleanup, and Podcast Writer uses real Providers; deterministic tests are not a substitute.
