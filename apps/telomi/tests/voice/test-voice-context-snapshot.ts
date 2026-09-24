import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { GoalService } from "../../server/goals/service.js";
import { createVoiceRouter } from "../../server/voice/api.js";
import { loadSettings, saveSettings } from "../../server/config/settings.js";
import { VoiceGlossaryStore } from "../../server/voice/glossary.js";
import { VoiceUtteranceContextStore } from "../../server/voice/utterance-context.js";
import { DEFAULT_VOICE_VAD_CONFIG } from "../../server/audio/voice-vad.js";
import {
	parseVoiceStreamClientMessage,
	VOICE_STREAM_PROTOCOL_VERSION,
} from "../../shared/voice-stt.js";

test("an utterance context remains replayable after voice settings change", () => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-voice-context-"));
	try {
		const glossary = new VoiceGlossaryStore(workspace);
		glossary.replace([
			{
				id: "term_mflow",
				canonical: "MFlow",
				enabled: true,
			},
		]);
		let languagePreference = "en-GB";
		let vad = {
			...DEFAULT_VOICE_VAD_CONFIG,
			enabled: true,
			threshold: 0.6,
		};
		let cleanup = {
			enabled: true,
			modelId: "openai-codex/gpt-5.4-mini",
		};
		const contexts = new VoiceUtteranceContextStore(workspace, {
			loadLanguagePreference: () => languagePreference,
			loadVadConfig: () => vad,
			loadCleanupConfig: () => cleanup,
			now: () => new Date("2026-07-21T05:30:00.000Z"),
		});

		const captured = contexts.capture();
		assert.match(captured.id, /^voice_ctx_[a-f0-9]{64}$/);
		assert.equal(captured.languagePreference, "en-GB");
		assert.equal(captured.languageHint, "en");
		assert.deepEqual(captured.vad, vad);
		assert.deepEqual(captured.cleanup, cleanup);
		assert.deepEqual(captured.glossary.entries.map((entry) => entry.canonical), ["MFlow"]);

		languagePreference = "zh-CN";
		vad = { ...DEFAULT_VOICE_VAD_CONFIG };
		cleanup = {
			enabled: false,
			modelId: "openai-codex/gpt-5.4-mini",
		};
		glossary.replace([
			{
				id: "term_telomi",
				canonical: "Telomi",
				enabled: true,
			},
		]);

		const replayed = new VoiceUtteranceContextStore(workspace, {
			loadLanguagePreference: () => languagePreference,
		}).require(captured.id);
		assert.equal(replayed.id, captured.id);
		assert.equal(replayed.capturedAt, "2026-07-21T05:30:00.000Z");
		assert.equal(replayed.languagePreference, "en-GB");
		assert.equal(replayed.languageHint, "en");
		assert.equal(replayed.vad.enabled, true);
		assert.equal(replayed.vad.threshold, 0.6);
		assert.deepEqual(replayed.cleanup, {
			enabled: true,
			modelId: "openai-codex/gpt-5.4-mini",
		});
		assert.deepEqual(replayed.glossary.entries.map((entry) => entry.canonical), ["MFlow"]);

		const next = contexts.capture();
		assert.notEqual(next.id, captured.id);
		assert.equal(next.languageHint, "zh");
		assert.deepEqual(next.vad, DEFAULT_VOICE_VAD_CONFIG);
		assert.deepEqual(next.cleanup, cleanup);
		assert.deepEqual(next.glossary.entries.map((entry) => entry.canonical), ["Telomi"]);

		const retryOverride = contexts.capture({ languageHint: "en" });
		assert.equal(retryOverride.languagePreference, "zh-CN");
		assert.equal(retryOverride.languageHint, "en");
		assert.equal(contexts.require(retryOverride.id).languageHint, "en");
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("a voice stream start pins one validated context snapshot", () => {
	const contextSnapshotId = `voice_ctx_${"a".repeat(64)}`;
	const sessionId = "voice_context_session";
	assert.deepEqual(
		parseVoiceStreamClientMessage({
			type: "start",
			protocolVersion: VOICE_STREAM_PROTOCOL_VERSION,
			sessionId,
			utteranceId: "utt_context_1",
			sampleRate: 48_000,
			contextSnapshotId,
			delay: "medium",
		}),
		{
			type: "start",
			protocolVersion: VOICE_STREAM_PROTOCOL_VERSION,
			sessionId,
			utteranceId: "utt_context_1",
			sampleRate: 48_000,
			contextSnapshotId,
			delay: "medium",
		},
	);
	assert.equal(
		parseVoiceStreamClientMessage({
			type: "start",
			protocolVersion: VOICE_STREAM_PROTOCOL_VERSION,
			sessionId,
			utteranceId: "utt_context_1",
			sampleRate: 48_000,
			contextSnapshotId: "../../glossary.json",
		}),
		null,
	);
});

test("utterance context rejects path traversal and tampered persisted content", () => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-voice-context-integrity-"));
	try {
		const glossary = new VoiceGlossaryStore(workspace);
		glossary.replace([
			{
				id: "term_mflow",
				canonical: "MFlow",
				enabled: true,
			},
		]);
		const contexts = new VoiceUtteranceContextStore(workspace);
		const snapshot = contexts.capture();
		assert.equal(contexts.get("../../glossary.json"), null);

		const path = join(
			workspace,
			".pi",
			"voice",
			"context-snapshots",
			`${snapshot.id}.json`,
		);
		const stored = JSON.parse(readFileSync(path, "utf8")) as {
			glossary: { entries: Array<{ canonical: string }> };
		};
		stored.glossary.entries[0]!.canonical = "Telomi";
		writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

		assert.equal(contexts.get(snapshot.id), null);
		assert.throws(
			() => contexts.require(snapshot.id),
			/Voice utterance context snapshot not found/,
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("the voice start endpoint returns a persisted context descriptor", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-voice-context-api-"));
	const app = express();
	app.use(express.json());
	const goals = {
		getGoal: (goalId: string) => goalId === "goal-context" ? { id: goalId } : null,
	} as unknown as GoalService;
	app.use(createVoiceRouter(goals, workspace));
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/goals/goal-context/voice/context-snapshots`,
			{ method: "POST" },
		);
		assert.equal(response.status, 201);
		const descriptor = await response.json() as Record<string, unknown>;
		assert.match(String(descriptor.contextSnapshotId), /^voice_ctx_[a-f0-9]{64}$/);
		assert.equal(typeof descriptor.capturedAt, "string");
		assert.equal(typeof descriptor.languagePreference, "string");
		assert.equal(typeof descriptor.glossaryRevision, "string");
		assert.equal("entries" in descriptor, false);

		const persisted = new VoiceUtteranceContextStore(workspace).require(
			String(descriptor.contextSnapshotId),
		);
		assert.deepEqual(descriptor.cleanup, persisted.cleanup);
		assert.equal(typeof persisted.cleanup.enabled, "boolean");
		assert.equal(typeof persisted.cleanup.modelId, "string");
		assert.equal(descriptor.glossaryRevision, persisted.glossary.revision);

		// The UI language is not part of a recording's context: naming one yields the same snapshot content.
		const english = await fetch(
			`http://127.0.0.1:${address.port}/api/goals/goal-context/voice/context-snapshots`,
			{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uiLocale: "en-GB" }) },
		);
		const englishDescriptor = await english.json() as { contextSnapshotId: string; cleanup: Record<string, unknown> };
		assert.deepEqual(englishDescriptor.cleanup, descriptor.cleanup);
		assert.equal("promptLocale" in englishDescriptor.cleanup, false);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => error ? reject(error) : resolve()),
		);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("batch final uses the regional script and glossary captured before settings changed", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-voice-context-batch-"));
	const glossary = new VoiceGlossaryStore(workspace);
	glossary.replace([
		{
			id: "term_mflow",
			canonical: "MFlow",
			enabled: true,
		},
	]);

	let providerPrompt = "";
	const providerServer = createServer((request, response) => {
		if (request.url === "/health") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true }));
			return;
		}
		// The model the chosen selection names.
		if (request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "local-asr", modality: "stt" }] }));
			return;
		}
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			providerPrompt = Buffer.concat(chunks).toString("utf8");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				text: "我们使用 MemFlow",
				language: "Chinese",
				duration: 1,
				segments: [],
				words: [],
			}));
		});
	});
	await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
	const providerAddress = providerServer.address();
	assert.ok(providerAddress && typeof providerAddress === "object");
	const previousBaseUrl = process.env.TELOMI_AUDIO_STT_BASE_URL;
	const previousProvider = process.env.TELOMI_AUDIO_STT_PROVIDER;
	process.env.TELOMI_AUDIO_STT_BASE_URL = `http://127.0.0.1:${providerAddress.port}/v1`;
	process.env.TELOMI_AUDIO_STT_PROVIDER = "telomi-audio";
	// Nothing is preselected: the user chose the local runtime, which this endpoint stands in for.
	saveSettings({ ...loadSettings(), speechRecognition: { default: { connection: "telomi-audio", model: "local-asr" }, cleanupEnabled: false, cleanupInstructions: "" } });
	// Captured after the local runtime endpoint is known: the chosen speech selection pins it.
	const capturedContext = new VoiceUtteranceContextStore(workspace, {
		loadLanguagePreference: () => "zh-TW",
		loadCleanupConfig: () => ({
			enabled: false,
			modelId: "openai-codex/gpt-5.4-mini",
		}),
	}).capture();

	const app = express();
	app.use(express.json());
	const goals = {
		getGoal: (goalId: string) => goalId === "goal-context" ? { id: goalId } : null,
	} as unknown as GoalService;
	app.use(createVoiceRouter(goals, workspace));
	const voiceServer = createServer(app);
	await new Promise<void>((resolve) => voiceServer.listen(0, "127.0.0.1", resolve));
	try {
		const voiceAddress = voiceServer.address();
		assert.ok(voiceAddress && typeof voiceAddress === "object");
		const baseUrl = `http://127.0.0.1:${voiceAddress.port}`;
		const historySettingsResponse = await fetch(
			`${baseUrl}/api/voice/history/settings`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					dataRetentionEnabled: true,
					audioRetentionDays: 30,
					saveDiscardedTranscriptions: true,
				}),
			},
		);
		assert.equal(historySettingsResponse.status, 200);
		const context = { contextSnapshotId: capturedContext.id };
		const sessionId = "voice_context_batch_session";
		const discardedUtteranceId = "utt_context_discarded";
		const discardedResponse = await fetch(
			`${baseUrl}/api/goals/goal-context/voice/discarded?durationMs=1500&contextSnapshotId=${encodeURIComponent(context.contextSnapshotId)}&sessionId=${sessionId}&utteranceId=${discardedUtteranceId}`,
			{
				method: "POST",
				headers: { "Content-Type": "audio/wav" },
				body: Buffer.alloc(256),
			},
		);
		assert.equal(discardedResponse.status, 201);

		glossary.replace([
			{
				id: "term_telomi",
				canonical: "Telomi",
				enabled: true,
			},
		]);

		const utteranceId = "utt_context_batch";
		const batchResponse = await fetch(
			`${baseUrl}/api/goals/goal-context/voice/transcribe?contextSnapshotId=${encodeURIComponent(context.contextSnapshotId)}&sessionId=${sessionId}&utteranceId=${utteranceId}`,
			{
				method: "POST",
				headers: { "Content-Type": "audio/wav" },
				body: Buffer.alloc(256),
			},
		);
		assert.equal(batchResponse.status, 200);
		const batch = await batchResponse.json() as Record<string, unknown>;
		assert.match(providerPrompt, /Keywords: MFlow/);
		assert.doesNotMatch(providerPrompt, /Telomi/);
		assert.equal(batch.rawText, "我们使用 MemFlow");
		assert.equal(batch.canonicalText, "我們使用 MemFlow");
		assert.equal(batch.text, "我們使用 MemFlow");
		assert.deepEqual(batch.scriptNormalization, {
			text: "我們使用 MemFlow",
			preference: "zh-TW",
			profile: "opencc-s2tw-v1",
			applied: true,
			changed: true,
		});
		assert.equal(batch.contextSnapshotId, context.contextSnapshotId);
		const historyResponse = await fetch(
			`${baseUrl}/api/voice/history?includeDiscarded=1`,
		);
		assert.equal(historyResponse.status, 200);
		const history = await historyResponse.json() as {
			entries: Array<{
				id: string;
				status: string;
				sessionId?: string;
				utteranceId?: string;
				contextSnapshotId?: string;
			}>;
		};
		assert.equal(
			history.entries.find((entry) => entry.status === "discarded")
				?.contextSnapshotId,
			context.contextSnapshotId,
		);
		assert.equal(
			history.entries.find((entry) => entry.status === "discarded")
				?.sessionId,
			sessionId,
		);
		assert.equal(
			history.entries.find((entry) => entry.status === "discarded")
				?.utteranceId,
			discardedUtteranceId,
		);
		const completedEntry = history.entries.find(
			(entry) => entry.status === "completed",
		);
		assert.equal(
			completedEntry?.contextSnapshotId,
			context.contextSnapshotId,
		);
		assert.equal(completedEntry?.sessionId, sessionId);
		assert.equal(completedEntry?.utteranceId, utteranceId);

		const retryResponse = await fetch(
			`${baseUrl}/api/voice/history/${encodeURIComponent(completedEntry!.id)}/retry`,
			{ method: "POST" },
		);
		assert.equal(retryResponse.status, 200);
		const retry = await retryResponse.json() as {
			entry: { contextSnapshotId?: string; text: string };
		};
		assert.match(providerPrompt, /Keywords: Telomi/);
		assert.notEqual(
			retry.entry.contextSnapshotId,
			context.contextSnapshotId,
		);
		const retryContext = new VoiceUtteranceContextStore(workspace).require(
			retry.entry.contextSnapshotId!,
		);
		assert.deepEqual(
			retryContext.glossary.entries.map((entry) => entry.canonical),
			["Telomi"],
		);
		assert.equal(retryContext.languagePreference, "auto");
		assert.equal(retry.entry.text, "我们使用 MemFlow");

		const replayResponse = await fetch(
			`${baseUrl}/api/voice/history/${encodeURIComponent(completedEntry!.id)}/retry?contextSnapshotId=${encodeURIComponent(context.contextSnapshotId)}`,
			{ method: "POST" },
		);
		assert.equal(replayResponse.status, 200);
		const replay = await replayResponse.json() as {
			entry: { contextSnapshotId?: string; text: string };
		};
		assert.equal(replay.entry.contextSnapshotId, context.contextSnapshotId);
		assert.equal(replay.entry.text, "我們使用 MemFlow");
	} finally {
		if (previousBaseUrl === undefined) delete process.env.TELOMI_AUDIO_STT_BASE_URL;
		else process.env.TELOMI_AUDIO_STT_BASE_URL = previousBaseUrl;
		if (previousProvider === undefined) delete process.env.TELOMI_AUDIO_STT_PROVIDER;
		else process.env.TELOMI_AUDIO_STT_PROVIDER = previousProvider;
		await Promise.all([
			new Promise<void>((resolve, reject) =>
				voiceServer.close((error) => error ? reject(error) : resolve()),
			),
			new Promise<void>((resolve, reject) =>
				providerServer.close((error) => error ? reject(error) : resolve()),
			),
		]);
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("batch cleanup failure returns raw text and public failure metadata", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "pi-voice-cleanup-fail-open-"));
	const providerServer = createServer((request, response) => {
		if (request.url === "/health") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true }));
			return;
		}
		// The model the chosen selection names.
		if (request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "local-asr", modality: "stt" }] }));
			return;
		}
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				text: "keep this raw transcript",
				language: "en",
				duration: 1,
				segments: [],
				words: [],
			}));
		});
	});
	await new Promise<void>((resolve) =>
		providerServer.listen(0, "127.0.0.1", resolve),
	);
	const providerAddress = providerServer.address();
	assert.ok(providerAddress && typeof providerAddress === "object");
	const previousBaseUrl = process.env.TELOMI_AUDIO_STT_BASE_URL;
	const previousProvider = process.env.TELOMI_AUDIO_STT_PROVIDER;
	process.env.TELOMI_AUDIO_STT_BASE_URL =
		`http://127.0.0.1:${providerAddress.port}/v1`;
	process.env.TELOMI_AUDIO_STT_PROVIDER = "telomi-audio";
	// Nothing is preselected: the user chose the local runtime, which this endpoint stands in for.
	saveSettings({ ...loadSettings(), speechRecognition: { default: { connection: "telomi-audio", model: "local-asr" }, cleanupEnabled: false, cleanupInstructions: "" } });
	// Captured after the local runtime endpoint is known: the chosen speech selection pins it.
	const context = new VoiceUtteranceContextStore(workspace, {
		loadCleanupConfig: () => ({
			enabled: true,
			modelId: "missing/cleanup-model",
		}),
	}).capture();

	const app = express();
	app.use(express.json());
	const goals = {
		getGoal: (goalId: string) => goalId === "goal-cleanup" ? { id: goalId } : null,
	} as unknown as GoalService;
	app.use(createVoiceRouter(goals, workspace));
	const voiceServer = createServer(app);
	await new Promise<void>((resolve) =>
		voiceServer.listen(0, "127.0.0.1", resolve),
	);
	try {
		const voiceAddress = voiceServer.address();
		assert.ok(voiceAddress && typeof voiceAddress === "object");
		const response = await fetch(
			`http://127.0.0.1:${voiceAddress.port}/api/goals/goal-cleanup/voice/transcribe?contextSnapshotId=${encodeURIComponent(context.id)}`,
			{
				method: "POST",
				headers: { "Content-Type": "audio/wav" },
				body: Buffer.alloc(256),
			},
		);
		assert.equal(response.status, 200);
		const result = await response.json() as {
			text: string;
			cleanup: {
				requested: boolean;
				applied: boolean;
				modelId?: string;
				reason?: string;
			};
		};
		assert.equal(result.text, "keep this raw transcript");
		assert.equal(result.cleanup.requested, true);
		assert.equal(result.cleanup.applied, false);
		assert.equal(result.cleanup.modelId, "missing/cleanup-model");
		assert.match(result.cleanup.reason ?? "", /unknown model/);
	} finally {
		if (previousBaseUrl === undefined) delete process.env.TELOMI_AUDIO_STT_BASE_URL;
		else process.env.TELOMI_AUDIO_STT_BASE_URL = previousBaseUrl;
		if (previousProvider === undefined) delete process.env.TELOMI_AUDIO_STT_PROVIDER;
		else process.env.TELOMI_AUDIO_STT_PROVIDER = previousProvider;
		await Promise.all([
			new Promise<void>((resolve, reject) =>
				voiceServer.close((error) => error ? reject(error) : resolve()),
			),
			new Promise<void>((resolve, reject) =>
				providerServer.close((error) => error ? reject(error) : resolve()),
			),
		]);
		rmSync(workspace, { recursive: true, force: true });
	}
});
