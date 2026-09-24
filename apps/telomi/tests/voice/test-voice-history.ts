import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VoiceHistoryStore } from "../../server/voice/history.js";

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "telomi-voice-history-"));
}

test("voice history is privacy-off by default and does not write audio", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir);
		assert.deepEqual(store.getSettings(), {
			dataRetentionEnabled: false,
			audioRetentionDays: 30,
			saveDiscardedTranscriptions: false,
			updatedAt: null,
		});
		assert.deepEqual(
			store.record({
				goalId: "goal-1",
				status: "completed",
				text: "Telomi",
				rawText: "Telomi",
				canonicalText: "Telomi",
				provider: "telomi-audio",
				mime: "audio/webm",
				audio: Buffer.from("private audio"),
			}),
			{ saved: false },
		);
		assert.equal(existsSync(join(dir, ".pi", "voice", "history")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("voice history stores completed and failed results with retriable audio", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir);
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const completed = store.record({
			goalId: "goal-1",
			sessionId: "voice_session_history",
			utteranceId: "utt_history_latency",
			status: "completed",
			text: "Telomi final",
			rawText: "Telomi",
			canonicalText: "Telomi",
			provider: "telomi-audio",
			model: "Qwen3-ASR",
			language: "en",
			durationSec: 2.4,
			mime: "audio/webm;codecs=opus",
			audio: Buffer.from("completed audio"),
			glossaryRevision: "glossary-a",
			cleanup: {
				requested: true,
				applied: true,
				modelId: "cleanup-model",
				durationMs: 30,
			},
			microphone: {
				deviceLabel: "MacBook Pro麦克风",
				deviceFingerprint:
					"03726da7b71d9ff9625322948fcfddeaac17a12983254aa624922310cd392ff8",
				selectionStatus: "exact",
				usedFallback: false,
			},
		});
		const failed = store.record({
			goalId: "goal-1",
			status: "failed",
			provider: "telomi-audio",
			mime: "audio/webm",
			audio: Buffer.from("failed audio"),
			errorMessage: "Provider unavailable",
			errorCode: "PROVIDER_UNAVAILABLE",
		});

		assert.equal(completed.saved, true);
		assert.equal(failed.saved, true);
		assert.equal(completed.entry?.hasAudio, true);
		assert.equal(completed.entry?.mime, "audio/webm");
		assert.equal(completed.entry?.sessionId, "voice_session_history");
		assert.equal(completed.entry?.utteranceId, "utt_history_latency");
		assert.deepEqual(completed.entry?.microphone, {
			deviceLabel: "MacBook Pro麦克风",
			deviceFingerprint:
				"03726da7b71d9ff9625322948fcfddeaac17a12983254aa624922310cd392ff8",
			selectionStatus: "exact",
			usedFallback: false,
		});
		assert.deepEqual(
			new VoiceHistoryStore(dir).getEntry(completed.entry!.id)?.microphone,
			completed.entry?.microphone,
		);
		assert.equal(failed.entry?.status, "failed");
		assert.equal(
			store.readAudio(failed.entry!.id)?.buffer.toString(),
			"failed audio",
		);
		const snapshot = store.getSnapshot();
		assert.deepEqual(snapshot.entries.map((entry) => entry.id), [
			failed.entry?.id,
			completed.entry?.id,
		]);
		assert.deepEqual(snapshot.usage, {
			entryCount: 2,
			completedCount: 1,
			failedCount: 1,
			discardedCount: 0,
			audioFileCount: 2,
			audioBytes: Buffer.byteLength("completed audio") + Buffer.byteLength("failed audio"),
			userEdit: {
				measuredCount: 0,
				unmeasuredCount: 0,
				totalOriginalCharacters: 0,
				totalEditDistance: 0,
				modificationRate: null,
			},
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy streaming telemetry in a stored ledger is dropped when read", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir);
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 0,
		});
		const entry = store.record({
			goalId: "goal-legacy-ledger",
			status: "completed",
			text: "normalized transcript",
			provider: "telomi-audio",
			mime: "audio/wav",
		}).entry!;
		const ledgerPath = join(dir, ".pi", "voice", "history", "ledger.json");
		const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
			entries: Array<Record<string, unknown>>;
		};
		const stored = ledger.entries.find((candidate) => candidate.id === entry.id)!;
		stored.streaming = { outcome: "first_partial", firstPartial: { text: "partial" } };
		writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

		const reloaded = new VoiceHistoryStore(dir).getEntry(entry.id)!;
		assert.equal("streaming" in reloaded, false);
		assert.equal(reloaded.text, "normalized transcript");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("voice history records a submitted user edit as an auditable character rate", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir, {
			now: () => new Date("2026-07-22T06:30:00.000Z"),
		});
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 0,
		});
		const entry = store.record({
			goalId: "goal-edit-rate",
			status: "completed",
			text: "cat",
			rawText: "cat",
			canonicalText: "cat",
			provider: "telomi-audio",
			mime: "audio/wav",
		}).entry!;

		const updated = store.recordUserEdit(entry.id, {
			outcome: "measured",
			editedText: "cut",
			elapsedMs: 1_234.5678,
		});

		assert.deepEqual(updated.userEdit, {
			outcome: "measured",
			unit: "unicode-code-point",
			originalCharacterCount: 3,
			submittedCharacterCount: 3,
			editDistance: 1,
			modificationRate: 1 / 3,
			elapsedMs: 1_234.568,
			recordedAt: "2026-07-22T06:30:00.000Z",
		});
		assert.equal(updated.updatedAt, "2026-07-22T06:30:00.000Z");
		assert.deepEqual(store.getSnapshot().usage.userEdit, {
			measuredCount: 1,
			unmeasuredCount: 0,
			totalOriginalCharacters: 3,
			totalEditDistance: 1,
			modificationRate: 1 / 3,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("voice history aggregates unmeasured edits without inventing a rate", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir, {
			now: () => new Date("2026-07-22T07:00:00.000Z"),
		});
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 0,
		});
		const entry = store.record({
			goalId: "goal-unmeasured-edit",
			status: "completed",
			text: "Telomi",
			provider: "telomi-audio",
			mime: "audio/wav",
		}).entry!;

		const updated = store.recordUserEdit(entry.id, {
			outcome: "unmeasured",
			reason: "multiple_voice_inputs",
			elapsedMs: 2_000,
		});

		assert.deepEqual(updated.userEdit, {
			outcome: "unmeasured",
			reason: "multiple_voice_inputs",
			elapsedMs: 2_000,
			recordedAt: "2026-07-22T07:00:00.000Z",
		});
		assert.deepEqual(store.getSnapshot().usage.userEdit, {
			measuredCount: 0,
			unmeasuredCount: 1,
			totalOriginalCharacters: 0,
			totalEditDistance: 0,
			modificationRate: null,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("invalid optional user-edit evidence is stripped without dropping its history entry", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir);
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 0,
		});
		const entry = store.record({
			goalId: "goal-invalid-edit-evidence",
			status: "completed",
			text: "transcript survives",
			provider: "telomi-audio",
			mime: "audio/wav",
		}).entry!;
		const ledgerPath = join(dir, ".pi", "voice", "history", "ledger.json");
		const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
			entries: Array<{ id: string; userEdit?: unknown }>;
		};
		const stored = ledger.entries.find((candidate) => candidate.id === entry.id)!;
		stored.userEdit = {
			outcome: "measured",
			unit: "unicode-code-point",
			originalCharacterCount: 3,
			submittedCharacterCount: 3,
			editDistance: 2,
			modificationRate: 0,
			elapsedMs: 10,
			recordedAt: "not-a-timestamp",
		};
		writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

		const reopened = new VoiceHistoryStore(dir);
		assert.equal(reopened.getEntry(entry.id)?.text, "transcript survives");
		assert.equal(reopened.getEntry(entry.id)?.userEdit, undefined);
		assert.equal(reopened.getSnapshot().usage.userEdit.measuredCount, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("discarded recovery follows every OpenWhispr privacy and duration gate", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir);
		const input = {
			goalId: "goal-1",
			mime: "audio/webm",
			audio: Buffer.from("cancelled audio"),
			durationMs: 1_500,
		};
		assert.equal(store.recordDiscarded(input).saved, false);

		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
			saveDiscardedTranscriptions: false,
		});
		assert.equal(store.recordDiscarded(input).saved, false);

		store.updateSettings({ saveDiscardedTranscriptions: true });
		assert.equal(
			store.recordDiscarded({ ...input, durationMs: 999 }).saved,
			false,
		);
		const saved = store.recordDiscarded(input);
		assert.equal(saved.saved, true);
		assert.equal(saved.entry?.status, "discarded");
		assert.equal(saved.entry?.provider, "not-transcribed");
		assert.equal(saved.entry?.durationSec, 1.5);
		assert.equal(saved.entry?.hasAudio, true);
		assert.equal(store.getSnapshot().usage.discardedCount, 1);

		store.updateSettings({ audioRetentionDays: 0 });
		assert.equal(store.recordDiscarded(input).saved, false);
		assert.equal(store.getEntry(saved.entry!.id)?.hasAudio, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("discarded history is hidden by default without consuming the visible limit", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir);
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
			saveDiscardedTranscriptions: true,
		});
		const completed = store.record({
			goalId: "goal-visible-history",
			status: "completed",
			text: "普通转写",
			provider: "telomi-audio",
			mime: "audio/webm",
			audio: Buffer.from("completed audio"),
		}).entry!;
		const discarded = store.recordDiscarded({
			goalId: "goal-visible-history",
			mime: "audio/webm",
			audio: Buffer.from("discarded audio"),
			durationMs: 1_500,
		}).entry!;

		const ordinary = store.getSnapshot(1);
		assert.deepEqual(ordinary.entries.map((entry) => entry.id), [completed.id]);
		assert.equal(ordinary.usage.entryCount, 2);
		assert.equal(ordinary.usage.discardedCount, 1);

		const withDiscarded = store.getSnapshot(1, { includeDiscarded: true });
		assert.deepEqual(withDiscarded.entries.map((entry) => entry.id), [
			discarded.id,
		]);
		assert.equal(withDiscarded.usage.entryCount, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("zero-day audio retention keeps transcript history but removes raw audio", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir);
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 0,
		});
		const result = store.record({
			goalId: "goal-1",
			status: "failed",
			provider: "telomi-audio",
			mime: "audio/webm",
			audio: Buffer.from("must not persist"),
			errorMessage: "No speech",
		});
		assert.equal(result.entry?.hasAudio, false);
		assert.equal(result.entry?.audioBytes, 0);
		assert.equal(store.readAudio(result.entry!.id), null);
		assert.equal(store.getSnapshot().usage.entryCount, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("retry updates a failed record in place and increments attempt count", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir);
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const failed = store.record({
			goalId: "goal-1",
			status: "failed",
			provider: "telomi-audio",
			mime: "audio/wav",
			audio: Buffer.from("wave"),
			errorMessage: "First failure",
			microphone: {
				deviceLabel: "External Mic",
				deviceFingerprint: "a".repeat(64),
				selectionStatus: "remapped",
				usedFallback: false,
			},
		}).entry!;
		const completed = store.applyRetry(failed.id, {
			status: "completed",
			text: "Sinead",
			rawText: "Sinead",
			canonicalText: "Sinead",
			provider: "telomi-audio",
			model: "Qwen3-ASR",
			language: "en",
			durationSec: 1,
			glossaryRevision: "g2",
		});
		assert.equal(completed.id, failed.id);
		assert.equal(completed.status, "completed");
		assert.equal(completed.attemptCount, 2);
		assert.equal(completed.errorMessage, undefined);
		assert.equal(completed.text, "Sinead");
		assert.equal(completed.hasAudio, true);
		assert.deepEqual(completed.microphone, failed.microphone);
		store.recordUserEdit(completed.id, {
			outcome: "measured",
			editedText: "Sinead corrected",
			elapsedMs: 500,
		});
		assert.equal(store.getEntry(completed.id)?.userEdit?.outcome, "measured");

		const failedAgain = store.applyRetry(failed.id, {
			status: "failed",
			provider: "telomi-audio",
			errorMessage: "Second failure",
			errorCode: "RETRY_FAILED",
		});
		assert.equal(failedAgain.attemptCount, 3);
		assert.equal(failedAgain.status, "completed");
		assert.equal(failedAgain.text, "Sinead");
		assert.equal(failedAgain.errorMessage, "Second failure");
		assert.equal(failedAgain.hasAudio, true);
		assert.equal(failedAgain.userEdit?.outcome, "measured");

		const recovered = store.applyRetry(failed.id, {
			status: "completed",
			text: "Recovered text",
			rawText: "Recovered text",
			canonicalText: "Recovered text",
			provider: "telomi-audio",
		});
		assert.equal(recovered.userEdit, undefined);
		const preserved = store.applyRetry(failed.id, {
			status: "failed",
			provider: "telomi-audio",
			errorMessage: "Transient retry error",
		});
		assert.equal(preserved.status, "completed");
		assert.equal(preserved.text, recovered.text);
		assert.equal(preserved.provider, recovered.provider);
		assert.equal(preserved.errorMessage, "Transient retry error");
		assert.equal(preserved.attemptCount, 5);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("history persists the exact utterance context and advances it only after a successful retry", () => {
	const dir = workspace();
	const originalContextSnapshotId = `voice_ctx_${"a".repeat(64)}`;
	const retryContextSnapshotId = `voice_ctx_${"b".repeat(64)}`;
	try {
		const store = new VoiceHistoryStore(dir);
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const original = store.record({
			goalId: "goal-context",
			status: "completed",
			text: "MFlow",
			provider: "telomi-audio",
			mime: "audio/wav",
			audio: Buffer.from("wave"),
			contextSnapshotId: originalContextSnapshotId,
		}).entry!;

		assert.equal(original.contextSnapshotId, originalContextSnapshotId);
		assert.equal(
			new VoiceHistoryStore(dir).getEntry(original.id)?.contextSnapshotId,
			originalContextSnapshotId,
		);
		const compatibleRetry = store.applyRetry(original.id, {
			status: "completed",
			text: "MFlow compatible retry",
			provider: "telomi-audio",
		});
		assert.equal(
			compatibleRetry.contextSnapshotId,
			originalContextSnapshotId,
		);

		const failedRetry = store.applyRetry(original.id, {
			status: "failed",
			provider: "telomi-audio",
			errorMessage: "Temporary provider failure",
			contextSnapshotId: retryContextSnapshotId,
		});
		assert.equal(failedRetry.status, "completed");
		assert.equal(failedRetry.contextSnapshotId, originalContextSnapshotId);

		const successfulRetry = store.applyRetry(original.id, {
			status: "completed",
			text: "MFlow corrected",
			rawText: "M flow corrected",
			canonicalText: "MFlow corrected",
			provider: "telomi-audio",
			contextSnapshotId: retryContextSnapshotId,
		});
		assert.equal(successfulRetry.contextSnapshotId, retryContextSnapshotId);
		assert.equal(
			new VoiceHistoryStore(dir).getEntry(original.id)?.contextSnapshotId,
			retryContextSnapshotId,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("retention cleanup, delete and clear remove audio without path traversal", () => {
	const dir = workspace();
	let now = new Date("2026-01-01T00:00:00.000Z");
	try {
		const store = new VoiceHistoryStore(dir, { now: () => now });
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 7,
		});
		const old = store.record({
			goalId: "goal-1",
			status: "completed",
			text: "old",
			provider: "telomi-audio",
			mime: "audio/webm",
			audio: Buffer.from("old audio"),
		}).entry!;
		now = new Date("2026-01-09T00:00:00.000Z");
		assert.equal(store.getSnapshot().entries[0]?.hasAudio, false);
		assert.equal(store.getSnapshot().entries[0]?.text, "old");
		assert.throws(() => store.readAudio("../../secret"), /Invalid voice history entry id/);

		const recent = store.record({
			goalId: "goal-1",
			status: "completed",
			text: "recent",
			provider: "telomi-audio",
			mime: "audio/ogg",
			audio: Buffer.from("recent audio"),
		}).entry!;
		assert.equal(store.delete(recent.id), true);
		assert.equal(store.delete(recent.id), false);
		assert.equal(store.getEntry(old.id)?.text, "old");
		assert.deepEqual(store.clear(), {
			deletedEntries: 1,
			deletedAudioFiles: 0,
		});
		assert.equal(store.getSnapshot().usage.entryCount, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing audio files are repaired in the ledger on read", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir);
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const entry = store.record({
			goalId: "goal-1",
			status: "failed",
			provider: "telomi-audio",
			mime: "audio/flac",
			audio: Buffer.from("audio"),
			errorMessage: "failed",
		}).entry!;
		const audioDir = join(dir, ".pi", "voice", "history", "audio");
		const audioName = readFileSync(
			join(dir, ".pi", "voice", "history", "ledger.json"),
			"utf8",
		);
		assert.match(audioName, new RegExp(entry.id));
		for (const extension of [".flac", ".audio"]) {
			const path = join(audioDir, `${entry.id}${extension}`);
			if (existsSync(path)) writeFileSync(path, "");
		}
		rmSync(audioDir, { recursive: true, force: true });
		assert.equal(store.getSnapshot().entries[0]?.hasAudio, false);
		assert.equal(store.readAudio(entry.id), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("history persists a bounded STT fallback audit trail", () => {
	const dir = workspace();
	try {
		const store = new VoiceHistoryStore(dir);
		store.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 0,
		});
		const entry = store.record({
			goalId: "goal-1",
			status: "completed",
			text: "MFlow organizes knowledge",
			provider: "openrouter-stt",
			model: "openai/gpt-4o-mini-transcribe",
			mime: "audio/wav",
			routing: {
				primaryProvider: "telomi-audio",
				fallback: {
					enabled: true,
					eligible: true,
					used: true,
					provider: "openrouter-stt",
					model: "openai/gpt-4o-mini-transcribe",
				},
				attempts: [
					{
						provider: "telomi-audio",
						ok: false,
						durationMs: 12.6,
						reason: "local service unavailable",
					},
					{
						provider: "openrouter-stt",
						model: "openai/gpt-4o-mini-transcribe",
						ok: true,
						durationMs: 842.2,
					},
				],
			},
		}).entry!;

		assert.equal(entry.routing?.fallback.used, true);
		assert.equal(entry.routing?.attempts[0]?.durationMs, 13);
		assert.equal(
			store.getEntry(entry.id)?.routing?.attempts[1]?.provider,
			"openrouter-stt",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
