import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { initializeLogger } from "@livekit/agents";
import { configureManagedAudioGeneration } from "./managed-speech.js";

initializeLogger({ pretty: false, level: "fatal" });

/** Raw PCM under the OpenAI `/audio/speech` contract. */
const PCM_SAMPLE_RATE = 24_000;

const home = mkdtempSync(join(tmpdir(), "telomi-livekit-cloud-tts-"));
const previousDataDir = process.env.TELOMI_DATA_DIR;
const previousSampleRate = process.env.TELOMI_AUDIO_TTS_SAMPLE_RATE;
process.env.TELOMI_DATA_DIR = home;
delete process.env.TELOMI_AUDIO_TTS_SAMPLE_RATE;

after(() => {
	rmSync(home, { recursive: true, force: true });
	if (previousDataDir === undefined) delete process.env.TELOMI_DATA_DIR; else process.env.TELOMI_DATA_DIR = previousDataDir;
	if (previousSampleRate !== undefined) process.env.TELOMI_AUDIO_TTS_SAMPLE_RATE = previousSampleRate;
});

interface Captured { url?: string; authorization?: string; body: Record<string, unknown> }

/** Distinguishable PCM16 so a transcode or a dropped byte cannot pass as a pass-through. */
function pcm16(samples: number): Buffer {
	const bytes = Buffer.alloc(samples * 2);
	for (let index = 0; index < samples; index += 1) {
		bytes.writeInt16LE(((index * 37) % 30_000) - 15_000, index * 2);
	}
	return bytes;
}

/** Applies a cloud audio generation connection served by a fake OpenAI-compatible upstream. */
async function cloudConnection(reply: { status: number; body: Buffer | string }): Promise<{ server: Server; endpoint: string; requests: Captured[] }> {
	const requests: Captured[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			// A plain OpenAI-compatible server: no health document and no model listing.
			if (req.url !== "/v1/audio/speech") { res.writeHead(404); res.end(); return; }
			requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) as Record<string, unknown> });
			res.writeHead(reply.status, { "Content-Type": "audio/pcm" });
			res.end(reply.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const endpoint = `http://127.0.0.1:${address.port}/v1`;
	await configureManagedAudioGeneration({
		connection: "cloud-speech",
		model: "gpt-4o-mini-tts",
		voice: "coral",
		rate: 1,
		baseUrl: endpoint,
		apiKey: "cloud-speech-key",
	});
	return { server, endpoint, requests };
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("the real-time voice adapter synthesizes through the configured cloud connection", async () => {
	const speech = pcm16(2_400);
	const { server, requests } = await cloudConnection({ status: 200, body: speech });
	try {
		const { QwenLiveKitTTS } = await import("../../server/voice/livekit-qwen-tts.js");
		const adapter = new QwenLiveKitTTS();
		assert.equal(adapter.provider, "cloud-speech");
		assert.equal(adapter.model, "gpt-4o-mini-tts");

		const frames = [];
		for await (const event of adapter.synthesize("云端语音测试")) frames.push(event);

		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, "/v1/audio/speech");
		assert.equal(requests[0].authorization, "Bearer cloud-speech-key");
		assert.deepEqual(
			[requests[0].body.model, requests[0].body.voice, requests[0].body.response_format, requests[0].body.input],
			["gpt-4o-mini-tts", "coral", "pcm", "云端语音测试"],
		);
		assert.ok(frames.length > 1, "audio is framed rather than emitted as one blob");
		assert.equal(frames.at(-1)?.final, true);
		assert.ok(frames.every((event) => event.frame.sampleRate === PCM_SAMPLE_RATE && event.frame.channels === 1));
		const played = Buffer.concat(frames.map((event) => Buffer.from(event.frame.data.buffer, event.frame.data.byteOffset, event.frame.data.byteLength)));
		assert.deepEqual(played, speech, "PCM16 reaches LiveKit unchanged");
	} finally {
		await close(server);
	}
});

test("a rejected real-time synthesis names the endpoint and status", async () => {
	const { server, endpoint } = await cloudConnection({ status: 502, body: "upstream unavailable" });
	try {
		const { speakPcm16Stream } = await import("../../server/audio/providers/tts.js");
		await assert.rejects(
			(async () => { for await (const _chunk of speakPcm16Stream({ text: "云端语音测试" })) { /* drain */ } })(),
			new RegExp(`HTTP 502 from ${endpoint.replace(/[.]/gu, "[.]")}/audio/speech`, "u"),
		);
	} finally {
		await close(server);
	}
});
