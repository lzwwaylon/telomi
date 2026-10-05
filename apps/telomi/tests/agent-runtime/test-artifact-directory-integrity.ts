import assert from "node:assert/strict";
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { readNodeEvaluationCase, type NodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";

const root = mkdtempSync(join(tmpdir(), "telomi-legacy-artifact-"));
try {
	const store = new RunArtifactStore(root);
	mkdirSync(join(root, "output"));
	writeFileSync(join(root, "output/中文.txt"), "one");
	writeFileSync(join(root, "output/阿文.txt"), "two");
	writeFileSync(join(root, "output/z.txt"), "three");
	// Recorded directory digests from the same three files under the two historical locales.
	const englishHash = "39ff74da33446f68ca8018a77ca97f576478e971b4105a5b8fc364bf7e89fea1";
	const chineseHash = "18f9b461ab054b85dc17769557c1f89d9a07f6c3ee84c9a33e66703b15411f6a";
	const published = store.publishDirectory(join(root, "output"), "published");
	assert.equal(published.sha256, englishHash);
	const expected = { relative_path: "output", sha256: chineseHash, byte_length: 11 };
	assert.throws(() => store.openDirectory(expected), /hash changed/);
	assert.equal(store.describeDirectory("output").sha256, englishHash);
	assert.equal(store.openDirectory({ ...expected, sha256: englishHash }).sha256, englishHash);
	assert.throws(() => store.openDirectory({ ...expected, sha256: englishHash, byte_length: 12 }), /byte length changed/);
	assert.throws(() => store.openDirectory({ ...expected, relative_path: "../outside" }), /escapes its store/);

	const prompt = store.publishText("prompt", "prompt.txt");
	const promptRef = { ref: prompt.relativePath, sha256: prompt.sha256, byteLength: prompt.byteLength };
	const directory = { ref: "output", sha256: englishHash, byteLength: 11 };
	const value: NodeEvaluationCase = {
		schemaVersion: 1, caseId: "legacy", runId: "run", nodeId: "node", attemptId: "attempt",
		agentId: "agent", role: "role", status: "succeeded", capturedAt: "2026-09-11T20:26:58.684Z",
		recipe: { id: "recipe", version: 1 }, recipeInput: {},
		input: { ...directory, root: "case", fileCount: 3 }, mounts: [], liveExternalState: false,
		request: {
			promptConfig: { domain: "research", id: "agent", sandboxRole: "role" },
			systemPrompt: promptRef, composedSystemPrompt: promptRef, userPrompt: promptRef,
			session: { key: "agent", policy: "fresh" }, actualModel: "model",
			outputContract: { kind: "source_bundle", publishRelativePath: "output" },
		},
		observed: { output: { ...directory, directory: true }, validationErrors: [] },
	};
	const manifestPath = join(root, "manifest.json");
	const save = () => writeFileSync(manifestPath, JSON.stringify(value));
	save();
	assert.equal(readNodeEvaluationCase(manifestPath, root).observed.output?.sha256, englishHash);
	value.input.sha256 = chineseHash;
	save();
	assert.throws(() => readNodeEvaluationCase(manifestPath, root), /hash changed|artifact changed/);
	value.input.sha256 = englishHash;
	value.input.fileCount = 4;
	save();
	assert.throws(() => readNodeEvaluationCase(manifestPath, root), /directory file count changed/);
	value.input.fileCount = 3;
	save();

	writeFileSync(join(root, "output/中文.txt"), "ONE");
	assert.throws(() => store.openDirectory({ ...expected, sha256: englishHash }), /hash changed/);
	assert.throws(() => readNodeEvaluationCase(manifestPath, root), /artifact changed|hash changed/);
	writeFileSync(join(root, "output/中文.txt"), "one");
	symlinkSync(join(root, "prompt.txt"), join(root, "output/link"));
	assert.throws(() => store.openDirectory(expected), /symlink/);
	rmSync(join(root, "output/link"));
	linkSync(join(root, "prompt.txt"), join(root, "output/link"));
	assert.throws(() => store.openDirectory(expected), /hardlink/);
	console.log("Current directory artifacts verify; legacy, changed and unsafe contents are rejected");
} finally {
	rmSync(root, { recursive: true, force: true });
}
