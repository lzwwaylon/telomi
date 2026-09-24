import { captureEvaluationVersionSnapshot } from "../observability/version-snapshot.js";
import type { WorkspaceKnowledgeSnapshot } from "../goals/memory/knowledge-reflection.js";
import { readWorkspaceKnowledge } from "../goals/memory/workspace-knowledge-runtime.js";
import type { ResearchHarnessSnapshot } from "./harness/snapshot.js";

export interface RunContextSnapshot {
	schemaVersion: 2;
	goalId: string;
	telomiRepository: string;
	telomiCommit: string;
	telomiBranch: string;
	telomiDirty: boolean;
	telomiPatchSha256?: string;
	telomiStatusSha256?: string;
	packageLockSha256?: string;
	nodeVersion: string;
	piRuntimeVersion?: string;
	evidenceSchemaVersion: 1;
	harnessSnapshotHash: string;
	workspaceContentHash: string;
	knowledgeMemoryHash: string;
	createdAt: string;
}

export interface PinnedRunContext {
	snapshot: RunContextSnapshot;
	knowledge: WorkspaceKnowledgeSnapshot;
}

export function buildRunContextSnapshotFromHarness(input: {
	goalId: string;
	goalDir: string;
	dataDir: string;
	harness: ResearchHarnessSnapshot;
	createdAt?: string;
}): PinnedRunContext {
	const memory = readWorkspaceKnowledge(input.goalDir, input.goalId);
	const telomi = captureEvaluationVersionSnapshot({
		repositoryCwd: process.env.TELOMI_REPOSITORY_CWD ?? process.cwd(),
		workspaceContentHash: memory.workspaceContentHash,
		knowledgeMemoryHash: memory.knowledgeMemoryHash,
	});
	return {
		snapshot: {
			schemaVersion: 2,
			goalId: input.goalId,
			telomiRepository: telomi.telomi_repository,
			telomiCommit: telomi.telomi_commit,
			telomiBranch: telomi.telomi_branch,
			telomiDirty: telomi.telomi_dirty,
			...(telomi.telomi_patch_sha256 ? { telomiPatchSha256: telomi.telomi_patch_sha256 } : {}),
			...(telomi.telomi_status_sha256 ? { telomiStatusSha256: telomi.telomi_status_sha256 } : {}),
			...(telomi.package_lock_sha256 ? { packageLockSha256: telomi.package_lock_sha256 } : {}),
			nodeVersion: telomi.node_version,
			...(telomi.pi_runtime_version ? { piRuntimeVersion: telomi.pi_runtime_version } : {}),
			evidenceSchemaVersion: 1,
			harnessSnapshotHash: input.harness.snapshotHash,
			workspaceContentHash: memory.workspaceContentHash,
			knowledgeMemoryHash: memory.knowledgeMemoryHash,
			createdAt: input.createdAt ?? new Date().toISOString(),
		},
		knowledge: memory.knowledge,
	};
}
