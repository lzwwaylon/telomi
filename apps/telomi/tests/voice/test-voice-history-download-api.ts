import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { GoalService } from "../../server/goals/service.js";
import { createVoiceRouter } from "../../server/voice/api.js";
import { VoiceHistoryStore } from "../../server/voice/history.js";

test("original-audio download preserves the retained History entry", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "telomi-voice-download-api-"));
	const audio = Buffer.from("deterministic retained voice audio");
	let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

	try {
		const now = new Date();
		const history = new VoiceHistoryStore(workspace, {
			now: () => now,
		});
		history.updateSettings({
			dataRetentionEnabled: true,
			audioRetentionDays: 30,
		});
		const entry = history.record({
			goalId: "goal-download-api",
			status: "completed",
			text: "下载原音频",
			rawText: "下载原音频",
			canonicalText: "下载原音频",
			provider: "telomi-audio",
			mime: "audio/webm; codecs=opus",
			audio,
		}).entry!;

		const app = express();
		app.use(createVoiceRouter({} as GoalService, workspace));
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server!.once("listening", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const before = await fetch(`${baseUrl}/api/voice/history`);
		assert.equal(before.status, 200);
		assert.equal((await before.json()).entries[0].hasAudio, true);

		const response = await fetch(
			`${baseUrl}/api/voice/history/${entry.id}/audio?download=1`,
		);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "audio/webm");
		assert.equal(response.headers.get("content-length"), String(audio.length));
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.equal(
			response.headers.get("content-disposition"),
			`attachment; filename="Telomi-${entry.id}.webm"`,
		);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);

		const after = await fetch(`${baseUrl}/api/voice/history`);
		assert.equal(after.status, 200);
		const afterSnapshot = await after.json();
		assert.equal(afterSnapshot.entries[0].id, entry.id);
		assert.equal(afterSnapshot.entries[0].hasAudio, true);
		assert.equal(afterSnapshot.entries[0].audioBytes, audio.length);
		assert.deepEqual(history.readAudio(entry.id)?.buffer, audio);
	} finally {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()));
		}
		rmSync(workspace, { recursive: true, force: true });
	}
});
