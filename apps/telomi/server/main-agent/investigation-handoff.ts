import { existsSync } from "node:fs";
import { join } from "node:path";

import { RunArtifactStore, type RunArtifactRef } from "../agent-runtime/artifact-store.js";
import { sha256 } from "../lib/hash.js";
import type { InvestigationResult } from "../research/investigate.js";

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
	else store.publishText(content, artifact.relative_path);
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
