import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";

/**
 * Node reaches every speech service as an ordinary endpoint: what the bundled service runs and how
 * it authenticates are the service's to report. Tests, which seed old data with these values, and
 * the Python service, which owns them, are exempt.
 */
const app = join(import.meta.dirname, "../..");
const roots = ["server", "shared", "web/src", "scripts", "../extensions"].map((root) => join(app, root));
const LOCAL_MODEL_ID = /Qwen3-(?:TTS|ASR|ForcedAligner)-\d|mlx-community\//i;
/** The retired key, anywhere except inside a longer number or after a port colon. */
const PLACEHOLDER_KEY = /(?<![\w:.])12345(?!\w)/;
const forbidden = [
	{ name: "local model id", pattern: LOCAL_MODEL_ID },
	{ name: "placeholder API key", pattern: PLACEHOLDER_KEY },
];

function* sources(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules") yield* sources(path);
		} else if ([".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"].includes(extname(entry.name))) yield path;
	}
}

test("the gate recognises what it guards against", () => {
	assert.match(`model: "Qwen3-ASR-0.6B-MLX-4bit"`, LOCAL_MODEL_ID);
	assert.match(`const repo = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"`, LOCAL_MODEL_ID);
	assert.doesNotMatch(`url: "https://example.com/Qwen3-ASR-Repo/asr_zh.wav"`, LOCAL_MODEL_ID);
	assert.match(`return audioEnv("STT_API_KEY") || "12345";`, PLACEHOLDER_KEY);
	assert.match(`headers: { Authorization: "Bearer 12345" }`, PLACEHOLDER_KEY);
	assert.doesNotMatch(`HINDSIGHT_URL = "http://127.0.0.1:12345/v1"`, PLACEHOLDER_KEY);
	assert.doesNotMatch(`twitter.thread("1234567890123456789")`, PLACEHOLDER_KEY);
});

test("Node sources name no local model id and no placeholder API key", () => {
	const findings: string[] = [];
	for (const root of roots) {
		for (const path of sources(root)) {
			const lines = readFileSync(path, "utf8").split("\n");
			lines.forEach((line, index) => {
				for (const { name, pattern } of forbidden) {
					if (pattern.test(line)) findings.push(`${relative(app, path)}:${index + 1} ${name}: ${line.trim()}`);
				}
			});
		}
	}
	assert.deepEqual(findings, []);
});
