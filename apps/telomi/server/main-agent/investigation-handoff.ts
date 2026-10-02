import { validateInvestigationResult, type InvestigationResult } from "../citations/contracts.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { RunArtifactStore, type RunArtifactRef } from "../agent-runtime/artifact-store.js";
import { sha256 } from "../lib/hash.js";
import { readInvestigationResult } from "../research/investigate.js";
import { serverRuntimeDirForGoalDir } from "../workspaces/server-runtime-paths.js";

/** Publish only the validated result; Main receives its mapped reference instead of its body. */
export function publishInvestigationHandoff(goalDir: string, result: InvestigationResult): {
	artifact: RunArtifactRef;
	receipt: { investigation_id: string; thread_id?: string; result_ref: string; sha256: string; byte_length: number };
} {
	if (!/^[a-f0-9]{24}$/u.test(result.id)) throw new Error("Invalid investigation id");
	if (result.thread_id !== undefined && !/^[a-f0-9]{24}$/u.test(result.thread_id)) throw new Error("Invalid investigation thread id");
	const content = `${JSON.stringify(result, null, 2)}\n`;
	const artifact = {
		relative_path: `investigations/${result.id}/result.json`,
		sha256: sha256(content),
		byte_length: Buffer.byteLength(content),
	};
	const store = new RunArtifactStore(join(goalDir, "artifacts"));
	if (existsSync(join(store.root, artifact.relative_path))) store.openFile(artifact);
	const citationsRef = `investigations/${result.id}/citations.json`;
	const control = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", result.id);
	if (!existsSync(join(store.root, citationsRef)) && existsSync(join(control, "citations.json"))) {
		// Older handoffs had only a result. Never pair that frozen answer with changed control evidence.
		const source = new RunArtifactStore(control);
		const recorded = validateInvestigationResult(JSON.parse(readFileSync(source.describeFile("result.json").absolutePath, "utf-8")),
			result.id, result.question);
		if (!isDeepStrictEqual(recorded, result)) throw new Error("Investigation evidence does not belong to the saved result");
		store.publishFile(source.describeFile("citations.json").absolutePath, citationsRef);
	}
	// Complete current investigations publish their evidence before making the result discoverable.
	if (!existsSync(join(store.root, artifact.relative_path))) store.publishText(content, artifact.relative_path);
	return {
		artifact,
		receipt: {
			investigation_id: result.id,
			...(result.thread_id ? { thread_id: result.thread_id } : {}),
			result_ref: `/artifacts/${artifact.relative_path}`,
			sha256: artifact.sha256,
			byte_length: artifact.byte_length,
		},
	};
}

/** Freeze existing completed handoffs before Main's next input snapshot; never include future results. */
export function migrateInvestigationHandoffs(goalDir: string): void {
	const root = join(goalDir, "artifacts", "investigations");
	if (!existsSync(root)) return;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[a-f0-9]{24}$/u.test(entry.name)
			|| !existsSync(join(root, entry.name, "result.json")) || existsSync(join(root, entry.name, "citations.json"))) continue;
		publishInvestigationHandoff(goalDir, readInvestigationResult(goalDir, entry.name));
	}
}
