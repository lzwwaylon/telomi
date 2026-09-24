import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireAudioFixture } from "./audio-fixture.js";

const root = mkdtempSync(join(tmpdir(), "telomi-audio-fixture-"));
try {
	const preload = join(root, "no-network.mjs");
	writeFileSync(preload, 'globalThis.fetch = async () => { throw new Error("FIXTURE_FETCH_SENTINEL"); };');
	for (const generator of ["generate-voice-vad-fixtures.ts", "generate-public-acoustic-fixtures.ts"]) {
		const entry = resolve(import.meta.dirname, "../../scripts", generator);
		for (const flags of [[], ["--fetch-remote-fixtures"]]) {
			const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
				"--import", preload, entry, ...flags], { cwd: root, encoding: "utf8", timeout: 15_000 });
			assert.ifError(result.error);
			assert.equal(result.status, 1, result.stderr);
			if (flags.length) assert.match(result.stderr, /FIXTURE_FETCH_SENTINEL/u);
			else {
				assert.match(result.stderr, /Missing cached audio fixture/u);
				assert.match(result.stderr, /--fetch-remote-fixtures/u);
				assert.doesNotMatch(result.stderr, /FIXTURE_FETCH_SENTINEL/u);
			}
		}
	}
	const custom = join(root, "custom.wav");
	writeFileSync(custom, "local fixture");
	await requireAudioFixture(custom);
	await assert.rejects(requireAudioFixture(join(root, "missing.wav")), { code: "ENOENT" });
	await assert.rejects(requireAudioFixture(resolve(import.meta.dirname,
		`../../voice-evals/generated/v1/missing-${process.pid}-${Date.now()}.wav`)),
		(error: Error) => error.message.includes("npm run generate:voice-vad-fixtures -- --fetch-remote-fixtures")
			&& (error.cause as NodeJS.ErrnoException).code === "ENOENT");
	// Directory traversal failures must remain filesystem errors, not download instructions.
	await assert.rejects(requireAudioFixture(join(custom, "child.wav")), { code: "ENOTDIR" });
	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		chmodSync(custom, 0);
		await assert.rejects(requireAudioFixture(custom), { code: "EACCES" });
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("Audio fixture prerequisites preserve custom paths and filesystem errors");
