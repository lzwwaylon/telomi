import type { WorkspaceSnapshotRecord } from "../observability/run-records.js";
import { getResearchSourceServiceClient } from "../providers/source-service-client.js";
import { toErrorMessage } from "../lib/values.js";

/** Entries never captured in workspace tree snapshots; replay applies the same list. */
export const WORKSPACE_SNAPSHOT_EXCLUDE: readonly string[] = [
	".venv",
	"node_modules",
	"__pycache__",
	".git",
	"*.log",
	".DS_Store",
	// Node runtime scaffolding at the workspace root: auth.json, models.json, settings.json. Path-anchored on purpose,
	// cloned repositories legitimately contain nested runtime/ directories.
	"runtime/agent",
];

export function emptyWorkspaceSnapshot(): WorkspaceSnapshotRecord {
	return { input_tree_sha: null, output_tree_sha: null, exclude: [...WORKSPACE_SNAPSHOT_EXCLUDE] };
}

/** Stores the work directory as a material_cache tree. Never throws: an unavailable service yields null plus a warning. */
export async function snapshotWorkspaceTree(
	snapshot: WorkspaceSnapshotRecord,
	phase: "input" | "output",
	workDirectory: string,
): Promise<void> {
	try {
		const stored = await getResearchSourceServiceClient().storeTree(workDirectory, snapshot.exclude);
		snapshot[`${phase}_tree_sha`] = stored.treeSha;
	} catch (error) {
		snapshot[`${phase}_tree_sha`] = null;
		(snapshot.warnings ??= []).push(
			`${phase} workspace tree snapshot unavailable: ${toErrorMessage(error)}`,
		);
	}
}
