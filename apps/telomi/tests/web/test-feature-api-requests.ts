import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { ApiError } from "../../web/src/shared/lib/api-client.js";
import { LiveSession } from "../../web/src/features/goals/data/LiveSession.js";
import { fetchMediaProductStatus } from "../../web/src/features/goals/data/useMediaProductStatus.js";
import { submitVoiceUserEditEvidence } from "../../web/src/features/voice/voiceUserEdit.js";

test("Goal messages and configuration use shared JSON serialization and errors", async (t) => {
	const calls: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
	t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), method: init?.method, body: init?.body });
		if (init?.body !== undefined) assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
		if (String(input).endsWith("/abort")) return Response.json({ error: "Run cannot be stopped" }, { status: 409 });
		if (String(input).endsWith("/config")) return new Response(null, { status: 204 });
		return Response.json({ queued: true, queuePosition: 2 });
	});
	const session = new LiveSession("goal-one");
	assert.deepEqual(await session.sendMessage({ content: "Explain streaming" }), { queued: true, queuePosition: 2 });
	await session.setModel("provider/model");
	assert.deepEqual(calls, [
		{ url: "/api/goals/goal-one/messages", method: "POST", body: '{"content":"Explain streaming"}' },
		{ url: "/api/goals/goal-one/config", method: "PATCH", body: '{"modelId":"provider/model"}' },
	]);
	await assert.rejects(session.abort(), { name: "ApiError", status: 409, message: "Run cannot be stopped" });
});

test("media status retains raw diagnostics and the queue recovers after failure", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => ++calls === 1
		? new Response("upstream unavailable", { status: 503 })
		: Response.json({ podcast: { status: "idle", implemented: true } }));
	const first = fetchMediaProductStatus("/api/media/one/status");
	const second = fetchMediaProductStatus("/api/media/two/status");
	await assert.rejects(first, { name: "ApiError", status: 503, message: "status 503: upstream unavailable" });
	assert.deepEqual(await second, { podcast: { status: "idle", implemented: true } });
});

test("voice edit evidence serializes once and exposes shared parse failures", async (t) => {
	t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		assert.equal(input, "/api/voice/history/history%2Fone/user-edit");
		assert.equal(init?.method, "POST");
		assert.equal(init?.body, '{"outcome":"measured","editedText":"corrected","elapsedMs":50}');
		return new Response("invalid JSON");
	});
	await assert.rejects(submitVoiceUserEditEvidence({
		historyId: "history/one", body: { outcome: "measured", editedText: "corrected", elapsedMs: 50 },
	}), (error: unknown) => error instanceof ApiError && error.message === "Invalid JSON response");
});

test("raw responses are limited to the audited text and binary transfers", () => {
	const root = new URL("../../web/src/", import.meta.url);
	const rawCalls: Record<string, number> = {};
	for (const path of readdirSync(root, { recursive: true })) {
		if (!/\.tsx?$/.test(path)) continue;
		const source = readFileSync(new URL(path, root), "utf8");
		const count = [...source.matchAll(/apiClient\.response\s*\(/g)].length;
		if (count) rawCalls[path] = count;
	}
	assert.deepEqual(rawCalls, {
		"features/goals/data/useArtifactMarkdownBody.ts": 1, // Markdown text.
		"features/voice/api.ts": 2, // Binary microphone uploads.
		"shared/artifact-preview/artifact-content.ts": 1, // Arbitrary artifact text, for every preview surface.
		"shared/artifact-renderers/XlsxArtifact.tsx": 1, // Binary workbook.
	});
});
