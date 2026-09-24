import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const testDataDir = mkdtempSync(join(tmpdir(), "telomi-stt-no-ffmpeg-"));
const previousDataDir = process.env.TELOMI_DATA_DIR;
process.env.TELOMI_DATA_DIR = testDataDir;
// One process, one ffmpeg resolution: this suite is the deployment whose ffmpeg cannot run. The
// configured binary exists (an absent one falls back to the system ffmpeg) but never succeeds.
const brokenFfmpeg = join(testDataDir, "ffmpeg");
writeFileSync(brokenFfmpeg, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
const previousFfmpeg = process.env.TELOMI_AUDIO_FFMPEG_PATH;
process.env.TELOMI_AUDIO_FFMPEG_PATH = brokenFfmpeg;

const { transcribe } = await import("../../server/audio/providers/stt.js");
const { configureManagedSpeech } = await import("./managed-speech.js");

after(() => {
	if (previousDataDir === undefined) delete process.env.TELOMI_DATA_DIR;
	else process.env.TELOMI_DATA_DIR = previousDataDir;
	if (previousFfmpeg === undefined) delete process.env.TELOMI_AUDIO_FFMPEG_PATH;
	else process.env.TELOMI_AUDIO_FFMPEG_PATH = previousFfmpeg;
	rmSync(testDataDir, { recursive: true, force: true });
});

test("a rejected media type without ffmpeg fails with the endpoint, status and what is missing", async () => {
	let uploads = 0;
	const server = createServer((request, response) => {
		request.on("data", () => undefined);
		request.on("end", () => {
			if (request.url === "/v1/audio/transcriptions") uploads += 1;
			response.writeHead(request.url === "/v1/audio/transcriptions" ? 415 : 404, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ detail: "failed to decode audio: Format not recognised" }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	await configureManagedSpeech({ connection: "strict-stt", model: "asr-model", baseUrl, apiKey: "strict-key" });
	try {
		const result = await transcribe({
			buffer: Buffer.from("not really webm"),
			filename: "dictation.webm",
			mime: "audio/webm",
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.reason, /HTTP 415/);
		assert.match(result.reason, new RegExp(baseUrl));
		assert.match(result.reason, /ffmpeg is not installed to transcode audio\/webm to wav/);
		assert.equal(uploads, 1, "the audio is uploaded once; there is nothing to retry with");
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
