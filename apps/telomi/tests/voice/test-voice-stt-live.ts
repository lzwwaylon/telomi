import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { VoiceGlossaryStore } from "../../server/voice/glossary.js";
import { VoiceHistoryStore } from "../../server/voice/history.js";
import { runVoiceTranscriptionPipeline } from "../../server/voice/transcription-pipeline.js";
import { VoiceUtteranceContextStore } from "../../server/voice/utterance-context.js";
import { warmupStt } from "../../server/audio/providers/stt.js";
import { getAudioLocalRuntimeManager } from "../../server/audio/local-runtime.js";

import { requireAudioFixture } from "./audio-fixture.js";

const fixturePath = resolve(import.meta.dirname, "../../voice-evals/generated/v1/librispeech-long-pause.wav");
await requireAudioFixture(fixturePath);
const localAudio = getAudioLocalRuntimeManager();

const startedAt = performance.now();
const workspace = mkdtempSync(resolve(tmpdir(), "telomi-voice-live-"));
try {
	const audio = await readFile(fixturePath);
	const history = new VoiceHistoryStore(workspace);
	const glossary = new VoiceGlossaryStore(workspace);
	glossary.replace([
		{
			id: "term_quilter",
			canonical: "Quilter",
			enabled: true,
		},
		{
			id: "term_gospel",
			canonical: "gospel",
			enabled: true,
		},
	]);
	const retryContext = new VoiceUtteranceContextStore(workspace).capture({
		languageHint: "en",
	});
	assert.ok(retryContext.speech, "the retry must freeze the managed speech configuration");
	await localAudio.prepare(retryContext.speech.recognition.connection);
	const readiness = await warmupStt({ ...retryContext.speech.recognition, signal: AbortSignal.timeout(45_000) });
	assert.equal(readiness.ok, true, readiness.ok ? undefined : readiness.reason);
	history.updateSettings({
		dataRetentionEnabled: true,
		audioRetentionDays: 30,
	});
	const failed = history.record({
		goalId: "voice-live-test",
		status: "failed",
		provider: "unknown-provider",
		mime: "audio/wav",
		audio,
		errorMessage: "intentional provider failure",
		contextSnapshotId: retryContext.id,
	}).entry!;
	assert.equal(failed.status, "failed");
	assert.equal(failed.hasAudio, true);
	const retained = history.readAudio(failed.id);
	assert.ok(retained);
	assert.deepEqual(retained.buffer, audio);

	const result = await runVoiceTranscriptionPipeline({
		buffer: retained.buffer,
		mime: retained.mime,
		speech: retryContext.speech,
		language: "en",
		cleanupRequested: false,
		glossary: retryContext.glossary,
	});
	const elapsedMs = Math.round(performance.now() - startedAt);

	assert.equal(result.ok, true, result.ok ? undefined : result.reason);
	if (!result.ok) {
		process.exitCode = 1;
	} else {
		assert.equal(result.provider, retryContext.speech.recognition.connection);
		assert.match(result.rawText, /quilter/i);
		assert.match(result.rawText, /middle classes/i);
		assert.ok(
			result.rawText.length > 100,
			"real transcript is unexpectedly short",
		);
		assert.ok(
			(result.durationSec ?? 0) > 10,
			"fixture duration was not propagated",
		);
		assert.match(result.text, /welcome his gospel/i);
		const recovered = history.applyRetry(failed.id, {
			status: "completed",
			text: result.text,
			rawText: result.rawText,
			canonicalText: result.canonicalText,
			provider: result.provider,
			contextSnapshotId: retryContext.id,
			model: result.model,
			language: result.language,
			durationSec: result.durationSec,
			glossaryRevision: result.glossary.revision,
			cleanup: { requested: false, applied: false },
		});
		assert.equal(recovered.id, failed.id);
		assert.equal(recovered.status, "completed");
		assert.equal(recovered.attemptCount, 2);
		assert.equal(recovered.hasAudio, true);
		assert.equal(recovered.contextSnapshotId, retryContext.id);

		console.log(
			JSON.stringify(
				{
					ok: true,
					provider: result.provider,
					model: result.model,
					language: result.language,
					audioDurationSec: result.durationSec,
					requestElapsedMs: elapsedMs,
					text: result.rawText,
					historyRetry: {
						idPreserved: recovered.id === failed.id,
						attemptCount: recovered.attemptCount,
						audioBytes: recovered.audioBytes,
						contextSnapshotId: recovered.contextSnapshotId,
					},
				},
				null,
				2,
			),
		);
	}
} finally {
	await localAudio.close();
	rmSync(workspace, { recursive: true, force: true });
}
