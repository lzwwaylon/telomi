import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { createVoiceRouter } from "../../server/voice/api.js";
import { VoiceHistoryStore } from "../../server/voice/history.js";
import {
	createPendingVoiceUserEdit,
	readSavedVoiceHistoryId,
	resolveVoiceUserEditSubmissions,
} from "../../web/src/features/voice/voiceUserEdit.js";

test("only a validated saved history response exposes a user-edit attribution id", () => {
	const id = `voice_${"d".repeat(32)}`;
	assert.equal(readSavedVoiceHistoryId({ saved: true, id }), id);
	assert.equal(readSavedVoiceHistoryId({ saved: false, id }), undefined);
	assert.equal(readSavedVoiceHistoryId({ saved: true, id: "voice_invalid" }), undefined);
	assert.equal(readSavedVoiceHistoryId(null), undefined);
});

test("a single voice insertion isolates the edited transcript from unchanged composer context", () => {
	const pending = createPendingVoiceUserEdit({
		historyId: `voice_${"a".repeat(32)}`,
		insertion: {
			text: "Before cat after",
			selection: { start: 10, end: 10 },
		},
		transcript: "cat",
		startedAt: 1_000,
	});
	assert.ok(pending);
	assert.deepEqual(
		resolveVoiceUserEditSubmissions([pending], "Before cut after", 2_234.5678),
		[{
			historyId: `voice_${"a".repeat(32)}`,
			body: {
				outcome: "measured",
				editedText: "cut",
				elapsedMs: 1_234.568,
			},
		}],
	);
});

test("ambiguous composer edits and multiple voice inputs are excluded instead of scored", () => {
	const first = createPendingVoiceUserEdit({
		historyId: `voice_${"b".repeat(32)}`,
		insertion: {
			text: "Before cat after",
			selection: { start: 10, end: 10 },
		},
		transcript: "cat",
		startedAt: 1_000,
	})!;
	assert.deepEqual(
		resolveVoiceUserEditSubmissions([first], "Changed cut after", 2_000),
		[{
			historyId: `voice_${"b".repeat(32)}`,
			body: {
				outcome: "unmeasured",
				reason: "composer_context_changed",
				elapsedMs: 1_000,
			},
		}],
	);

	const second = createPendingVoiceUserEdit({
		historyId: `voice_${"c".repeat(32)}`,
		insertion: {
			text: "Before cat and dog after",
			selection: { start: 18, end: 18 },
		},
		transcript: "dog",
		startedAt: 1_500,
	})!;
	assert.deepEqual(
		resolveVoiceUserEditSubmissions([first, second], "Before cat and dog after", 2_500),
		[
			{
				historyId: `voice_${"b".repeat(32)}`,
				body: {
					outcome: "unmeasured",
					reason: "multiple_voice_inputs",
					elapsedMs: 1_500,
				},
			},
			{
				historyId: `voice_${"c".repeat(32)}`,
				body: {
					outcome: "unmeasured",
					reason: "multiple_voice_inputs",
					elapsedMs: 1_000,
				},
			},
		],
	);
});

test("voice edits are not tracked when local history did not return an entry id", () => {
	assert.equal(
		createPendingVoiceUserEdit({
			insertion: {
				text: "cat",
				selection: { start: 3, end: 3 },
			},
			transcript: "cat",
			startedAt: 1_000,
		}),
		null,
	);
	assert.deepEqual(resolveVoiceUserEditSubmissions([], "cat", 2_000), []);
});

test("the production API records one user-edit result only after a saved transcription", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "telomi-user-edit-api-"));
	const history = new VoiceHistoryStore(workspace);
	history.updateSettings({
		dataRetentionEnabled: true,
		audioRetentionDays: 0,
	});
	const entry = history.record({
		goalId: "goal-edit-api",
		status: "completed",
		text: "cat",
		rawText: "cat",
		canonicalText: "cat",
		provider: "telomi-audio",
		mime: "audio/wav",
	}).entry!;
	const app = express();
	app.use(express.json());
	app.use(createVoiceRouter({} as never, workspace, {} as never));
	const server = app.listen(0, "127.0.0.1");
	try {
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const url = `http://127.0.0.1:${address.port}/api/voice/history/${entry.id}/user-edit`;
		const requestStartedAt = Date.now();
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				outcome: "measured",
				editedText: "cut",
				elapsedMs: 1_234,
			}),
		});
		assert.equal(response.status, 200);
		const body = await response.json() as {
			id: string;
			userEdit: { outcome: string; editDistance?: number; recordedAt?: string };
		};
		assert.equal(body.id, entry.id);
		const recordedAt = Date.parse(body.userEdit.recordedAt ?? "");
		assert.ok(recordedAt >= requestStartedAt && recordedAt <= Date.now());
		const { recordedAt: _recordedAt, ...userEdit } = body.userEdit;
		assert.deepEqual(userEdit, {
				outcome: "measured",
				unit: "unicode-code-point",
				originalCharacterCount: 3,
				submittedCharacterCount: 3,
				editDistance: 1,
				modificationRate: 1 / 3,
				elapsedMs: 1_234,
		});
		assert.deepEqual(
			new VoiceHistoryStore(workspace).getEntry(entry.id)?.userEdit,
			body.userEdit,
		);

		const duplicate = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				outcome: "measured",
				editedText: "dog",
				elapsedMs: 2_000,
			}),
		});
		assert.equal(duplicate.status, 409);

		const malformedEntry = history.record({
			goalId: "goal-edit-api",
			status: "completed",
			text: "dog",
			provider: "telomi-audio",
			mime: "audio/wav",
		}).entry!;
		const malformed = await fetch(
			`http://127.0.0.1:${address.port}/api/voice/history/${malformedEntry.id}/user-edit`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					outcome: "pretend-measured",
					editedText: "dig",
					elapsedMs: 100,
				}),
			},
		);
		assert.equal(malformed.status, 400);
		assert.equal(history.getEntry(malformedEntry.id)?.userEdit, undefined);
	} finally {
		server.close();
		await once(server, "close");
		rmSync(workspace, { recursive: true, force: true });
	}
});
