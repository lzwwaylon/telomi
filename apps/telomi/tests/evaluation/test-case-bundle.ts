import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../../server/lib/hash.js";
import {
	importCaseBundle,
	createCaseBundle,
	readTar,
	writeTar,
	type CaseBundleManifest,
} from "../../server/evaluation/case-bundle.js";
import { captureMainAgentNodeEvaluation } from "../../server/evaluation/main-agent-evaluation.js";
import { prepareMainAgentReplayGoalWorkspace } from "../../server/evaluation/main-agent-replay.js";
import { readNodeEvaluationCase, type NodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";

const root = mkdtempSync(join(tmpdir(), "telomi-case-bundle-"));

try {
	const roundTrip = join(root, "round-trip.tar");
	writeTar(roundTrip, [
		{ name: "manifest.json", content: Buffer.from("manifest\n") },
		{ name: "blobs/one", content: Buffer.from("blob bytes") },
	]);
	const entries = new Map<string, Buffer>();
	readTar(roundTrip, (entry, chunks) => entries.set(entry.name, Buffer.concat([...chunks])));
	assert.deepEqual([...entries], [
		["manifest.json", Buffer.from("manifest\n")],
		["blobs/one", Buffer.from("blob bytes")],
	]);

	const bundle = join(root, "bundle.tar");
	const caseBytes = Buffer.from(`${JSON.stringify({
		schemaVersion: 1,
		caseId: "case_1",
		runId: "run_1",
		nodeId: "prime-search-batch-1",
		attemptId: "1",
		agentId: "prime-search",
		recipe: { id: "prime-search", version: 2 },
		input: {
			ref: "node-evaluation/cases/case_1/input",
			sha256: sha256(""),
			byteLength: 0,
			fileCount: 0,
		},
	})}\n`);
	const caseSha = sha256(caseBytes);
	const manifest: CaseBundleManifest = {
		schema_version: 1,
		goal_id: "goal_imported",
		goal_title: "Imported Goal",
		source_run_id: "run_1",
		case_id: "case_1",
		agent_id: "prime-search",
		node_id: "prime-search-batch-1",
		attempt_id: "1",
		runtime_build: "test-build",
		agent_bundle_sha256: "a".repeat(64),
		capability_snapshot_id: null,
		workspace: null,
		provider_calls: null,
		files: [{ path: "case/manifest.json", sha256: caseSha, mode: 0o600, bytes: caseBytes.byteLength }],
	};
	const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
	writeTar(bundle, [
		{ name: "manifest.json", content: manifestBytes },
		{ name: `blobs/${caseSha}`, content: caseBytes },
	]);
	const dataDir = join(root, "data");
	const goals: string[] = [];
	const options = {
		path: bundle,
		dataDir,
		ensureGoal: (id: string) => {
			goals.push(id);
			mkdirSync(join(dataDir, id), { recursive: true });
		},
		capabilityContentHash: () => "unused",
	};
	const imported = importCaseBundle(options);
	const again = importCaseBundle(options);
	assert.deepEqual(again, imported);
	assert.deepEqual(goals, ["goal_imported", "goal_imported"]);
	assert.equal(imported.bundleSha256, sha256(manifestBytes));
	assert.deepEqual(
		readFileSync(join(
			dataDir,
			".pi/runtime/harness/goal_imported/evaluation/imported-cases",
			imported.bundleSha256,
			"node-evaluation/cases/case_1/manifest.json",
		)),
		caseBytes,
	);
	assert.deepEqual(readdirSync(join(
		dataDir,
		".pi/runtime/harness/goal_imported/evaluation/imported-cases",
		imported.bundleSha256,
		"node-evaluation/cases/case_1/input",
	)), []);

	const corrupt = join(root, "corrupt.tar");
	writeTar(corrupt, [
		{ name: "manifest.json", content: manifestBytes },
		{ name: `blobs/${caseSha}`, content: Buffer.from("corrupt") },
	]);
	assert.throws(() => importCaseBundle({ ...options, path: corrupt }), /bundle rejected/u);
	assert.equal(goals.length, 2, "blob verification fails before creating the goal");

	const exportedCase = join(root, "export-case");
	mkdirSync(exportedCase, { recursive: true });
	const material = "# Frozen document\n\nReplay evidence from GitHub.\n";
	const materialSha = sha256(material);
	const providerCalls = `${JSON.stringify({
		seq: 1,
		node_id: "prime-search-batch-1",
		attempt_id: "1",
		provider: "github",
		at: "2026-09-05T00:00:00.000Z",
		latency_ms: 1,
		request: { query: "replay evidence", purpose: "fixture", criterion_ids: [], max_results: 2 },
		response: { status: "ok", cache: "miss", doc_ids: ["github-doc", "missing-doc"], material_sha256: [materialSha, "f".repeat(64)] },
	})}\n${JSON.stringify({
		seq: 2,
		node_id: "prime-search-batch-1",
		attempt_id: "1",
		provider: "github",
		at: "2026-09-05T00:00:01.000Z",
		latency_ms: 1,
		request: { query: "example/repository", purpose: "fixture", criterion_ids: [], max_results: 1,
			provider_request: { operation: "clone_repository", parameters: { repository: "example/repository" } } },
		response: { status: "ok", cache: "miss", doc_ids: ["github-directory"], material_sha256: [] },
	})}\n`;
	writeFileSync(join(exportedCase, "provider-calls.jsonl"), providerCalls);
	const exportedValue = {
		schemaVersion: 1,
		caseId: "case_exported",
		runId: "run_exported",
		nodeId: "prime-search-batch-1",
		attemptId: "1",
		agentId: "prime-search",
		workspace: { input_tree_sha: "1".repeat(64), output_tree_sha: "2".repeat(64), exclude: [] },
		observed: { providerCalls: { ref: "provider-calls.jsonl", sha256: sha256(providerCalls), byteLength: Buffer.byteLength(providerCalls) } },
	} as unknown as NodeEvaluationCase;
	writeFileSync(join(exportedCase, "manifest.json"), `${JSON.stringify(exportedValue)}\n`);
	const exported = await createCaseBundle({
		dataDir: join(root, "export-data"),
		goalId: "goal_exported",
		goalTitle: "Exported Goal",
		casePath: join(exportedCase, "manifest.json"),
		value: exportedValue,
		runtimeBuild: "test-build",
		agentBundleSha256: "a".repeat(64),
		restoreTree: async (treeSha, destination) => {
			if (treeSha.startsWith("1")) return writeFileSync(join(destination, "input.txt"), "input\n");
			const source = join(destination, "artifacts", "source-bundles", "github", "bundle", "sources", "0001");
			mkdirSync(source, { recursive: true });
			writeFileSync(join(source, "material.md"), material);
			writeFileSync(join(source, "record.json"), `${JSON.stringify({
				title: "Selected GitHub document",
				summary: "Selected source summary",
				metadata: { github_record: { id: "github-doc", title: "GitHub document", url: "https://github.com/example/replay",
					snippet: "Replay evidence", authors: ["Example"], metadata: { repository: "example/replay" } } },
			})}\n`);
			writeFileSync(join(source, "..", "..", "source-index.json"), `${JSON.stringify({ schema_version: 1, provider_id: "github",
				sources: [{ path: "sources/0001", source_id: "source-1", candidate_id: "candidate-1",
					title: "GitHub document", url: "https://github.com/example/replay", files: [] }, {
					path: "sources/0002", source_id: "source-2", candidate_id: "candidate-2",
					title: "GitHub repository", url: "https://github.com/example/repository", files: [],
				}] })}\n`);
			const directorySource = join(source, "..", "0002");
			mkdirSync(directorySource, { recursive: true });
			writeFileSync(join(directorySource, "README.md"), "# Directory-backed repository\n");
			writeFileSync(join(directorySource, "record.json"), `${JSON.stringify({ title: "GitHub repository",
				url: "https://github.com/example/repository", summary: "Directory-backed repository", metadata: { repository: "example/repository" } })}\n`);
		},
	});
	assert.equal(exported.manifest.warnings, undefined);
	const importedExport = importCaseBundle({
		path: exported.path,
		dataDir: join(root, "imported-export"),
		ensureGoal: (id) => mkdirSync(join(root, "imported-export", id), { recursive: true }),
		capabilityContentHash: () => "unused",
	});
	const importedRoot = join(root, "imported-export", ".pi", "runtime", "harness", "goal_exported", "evaluation",
		"imported-cases", importedExport.bundleSha256);
	assert.equal(existsSync(join(importedRoot, "providers")), false, "imported Case must not carry a Provider environment");
	assert.equal(readFileSync(join(importedRoot, "workspace", "input", "input.txt"), "utf-8"), "input\n");
	assert.equal(readFileSync(join(importedRoot, "workspace", "output", "artifacts", "source-bundles", "github", "bundle",
		"sources", "0001", "material.md"), "utf-8"), material);
	const candidateHarness = join(root, "candidate-harness");
	mkdirSync(join(candidateHarness, "skills", "main-agent"), { recursive: true });
	writeFileSync(join(candidateHarness, "skills", "main-agent", "candidate.txt"), "candidate\n");
	const replayGoal = await prepareMainAgentReplayGoalWorkspace({
		value: exportedValue,
		casePath: join(exportedCase, "manifest.json"),
		sourceRunDirectory: importedRoot,
		harnessWorkspaceDirectory: candidateHarness,
		workspaceDirectory: join(root, "main-replay"),
		goalId: "main-agent-backtest",
	});
	assert.equal(readFileSync(join(replayGoal, "input.txt"), "utf-8"), "input\n");
	assert.equal(readFileSync(join(replayGoal, "skills", "main-agent", "candidate.txt"), "utf-8"), "candidate\n");
	const replayRecord = join(root, "main-replay-record");
	mkdirSync(replayRecord, { recursive: true });
	const replaySession = join(replayRecord, "main-agent-trace.jsonl");
	writeFileSync(replaySession, "{}\n");
	const logicalWorkspacePath = join(replayRecord, "main-agent-logical-workspace");
	mkdirSync(join(logicalWorkspacePath, "work"), { recursive: true });
	writeFileSync(join(logicalWorkspacePath, "work", "topic-plan.json"), "{}\n");
	writeFileSync(`${logicalWorkspacePath}.json`, JSON.stringify({ schemaVersion: 1, guestCwd: "/work", mounts: [{ guestPath: "/work", access: "read-write" }] }));
	captureMainAgentNodeEvaluation({
		runId: "nodebt_fixture::executions::candidate_fixture_1",
		runDirectory: replayRecord,
		question: "What changed?",
		systemPrompt: "Reply from the Goal workspace.",
		actualModel: "openai-codex/gpt-5.6-terra",
		thinkingLevel: "medium",
		logicalWorkspacePath,
		sessionPath: replaySession,
		terminal: {
			terminal: true,
			action: "assistant_reply",
			userResponse: "The workspace changed.",
			trace: { coarseAction: "assistant_reply", reasonCode: "assistant_reply" },
		},
		toolCounts: {},
		workspace: { input_tree_sha: "1".repeat(64), output_tree_sha: "2".repeat(64), exclude: [".git"] },
		capabilitySnapshotId: `caps_${"3".repeat(64)}`,
		attachments: [{ id: "att-1", type: "document", fileName: "paper.pdf", mimeType: "application/pdf", size: 3 }],
	});
	const replayCases = join(replayRecord, "node-evaluation", "cases");
	const replayCase = readNodeEvaluationCase(
		join(replayCases, readdirSync(replayCases)[0]!, "manifest.json"),
		replayRecord,
	);
	assert.equal(replayCase.runId, "nodebt_fixture::executions::candidate_fixture_1");
	assert.equal(replayCase.workspace?.input_tree_sha, "1".repeat(64));
	assert.equal(replayCase.workspace?.output_tree_sha, "2".repeat(64));
	assert.equal(replayCase.input.fileCount, 1);
	assert.equal(replayCase.capabilitySnapshotId, `caps_${"3".repeat(64)}`);
	assert.deepEqual((replayCase.recipeInput as { attachments?: unknown }).attachments,
		[{ id: "att-1", type: "document", fileName: "paper.pdf", mimeType: "application/pdf", size: 3 }],
		"an attachment turn records its descriptors so a Candidate Replay can rebuild the hand-off");
	exported.cleanup();
	console.log("Case Bundle round trip and Main Agent replay Case capture preserved workspace trees");
} finally {
	rmSync(root, { recursive: true, force: true });
}
