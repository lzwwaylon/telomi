import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { GoalService } from "../../server/goals/service.js";
import { createVoiceRouter } from "../../server/voice/api.js";
import { VoiceHistoryStore } from "../../server/voice/history.js";

test("History API requires explicit opt-in before returning discarded rows", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "telomi-voice-discarded-api-"));
	let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

	try {
		const history = new VoiceHistoryStore(workspace);
		history.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
			saveDiscardedTranscriptions: true,
		});
		const completed = history.record({
			goalId: "goal-discarded-api",
			status: "completed",
			text: "普通转写",
			provider: "telomi-audio",
			mime: "audio/webm",
		}).entry!;
		const discarded = history.recordDiscarded({
			goalId: "goal-discarded-api",
			mime: "audio/webm",
			audio: Buffer.from("discarded voice audio"),
			durationMs: 1_500,
		}).entry!;

		const app = express();
		app.use(createVoiceRouter({} as GoalService, workspace));
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server!.once("listening", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const ordinaryResponse = await fetch(
			`${baseUrl}/api/voice/history?limit=1`,
		);
		assert.equal(ordinaryResponse.status, 200);
		const ordinary = await ordinaryResponse.json();
		assert.deepEqual(ordinary.entries.map((entry: { id: string }) => entry.id), [
			completed.id,
		]);
		assert.equal(ordinary.usage.entryCount, 2);
		assert.equal(ordinary.usage.discardedCount, 1);

		const discardedResponse = await fetch(
			`${baseUrl}/api/voice/history?limit=1&includeDiscarded=1`,
		);
		assert.equal(discardedResponse.status, 200);
		const withDiscarded = await discardedResponse.json();
		assert.deepEqual(
			withDiscarded.entries.map((entry: { id: string }) => entry.id),
			[discarded.id],
		);
	} finally {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()));
		}
		rmSync(workspace, { recursive: true, force: true });
	}
});
