import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { assertInsideRoot, isInsideRoot } from "../lib/paths.js";
import { parsedDocumentsDir } from "../workspaces/goal-runtime-paths.js";
import { REPORTS_GUEST_PATH, syncPublishedReportView } from "../media/report-view.js";

import {
	SANDBOX_TOOL_NAMES,
	parseSandboxExecutionSpec,
	type SandboxExecutionSpec,
	type SandboxRole,
	type SandboxMountSpec,
} from "../../../extensions/telomi-srt/sandbox-spec.js";

export { SANDBOX_TOOL_NAMES };
export type { SandboxExecutionSpec, SandboxRole };

/** Main Agent 沙箱内的附件挂载点。交给主 Agent 的 guest 路径都从这里派生。 */
export const MAIN_AGENT_ATTACHMENTS_GUEST_PATH = "/attachments";

/** Main Agent 沙箱内的解析产物挂载点。只含解析产物，不含 Ingestion 缓存里的原件。 */
export const MAIN_AGENT_PARSED_DOCUMENTS_GUEST_PATH = "/documents";

export function createMainAgentSandboxExecutionSpec(args: {
	id: string;
	goalDir: string;
	sandboxDir: string;
	historyDirectory: string;
}): SandboxExecutionSpec {
	const goalDir = requireRealDirectory(args.goalDir, "Main Agent Goal workspace");
	const sandboxDir = requireRealDirectory(args.sandboxDir, "Main Agent isolated directory");
	const historyDirectory = requireRealDirectory(args.historyDirectory, "Main Agent Topic history");
	if (pathsOverlap(goalDir, sandboxDir)) {
		throw new Error("Main Agent isolated directory must not overlap the live Goal workspace");
	}
	const work = requireRealDirectory(path.join(sandboxDir, "artifacts", "main"), "Main Agent work directory");
	const artifacts = requireRealDirectory(path.join(sandboxDir, "artifacts"), "Main Agent artifacts");
	requireRealDirectory(path.join(goalDir, "attachments"), "Main Agent attachments");
	ensureRealDirectory(parsedDocumentsDir(goalDir), goalDir, "Main Agent parsed documents");
	const capabilitySkills = requireRealDirectory(
		path.join(sandboxDir, "skills", "main-agent"),
		"Main Agent Skill snapshot",
	);

	for (const candidatePath of [
		work,
		artifacts,
		capabilitySkills,
	]) {
		if (!isInsideRoot(sandboxDir, candidatePath, { rejectDotPrefix: true })) {
			throw new Error(`Main Agent mount resolves outside its isolated directory: ${candidatePath}`);
		}
	}
	return parseSandboxExecutionSpec({
		version: 1,
		id: args.id,
		role: "main.goal_agent",
		sessionLabel: `main.goal_agent:${args.id}`,
		hostCwd: work,
		guestCwd: "/work",
		mounts: [
			...createMainAgentBusinessMounts({ goalDir, workDirectory: work, artifactsDirectory: artifacts }),
			{
				hostPath: capabilitySkills,
				guestPath: "/capabilities/skills",
				access: "read-only",
			},
			{
				hostPath: historyDirectory,
				guestPath: "/history",
				access: "read-only",
			},
		],
		activeTools: [...SANDBOX_TOOL_NAMES],
		env: { HOME: "/tmp" },
		network: { mode: "deny" },
		writablePaths: [{ guestPath: "/work", kind: "tree" }],
	});
}

/** The business files shared by Main Agent and the user's workspace browser. */
export function createMainAgentBusinessMounts(args: {
	goalDir: string;
	workDirectory?: string;
	artifactsDirectory?: string;
}): SandboxMountSpec[] {
	const goalDir = requireRealDirectory(args.goalDir, "Main Agent Goal workspace");
	const artifactsDirectory = args.artifactsDirectory ?? path.join(goalDir, "artifacts");
	const mounts: SandboxMountSpec[] = [
		{ hostPath: args.workDirectory ?? path.join(artifactsDirectory, "main"), guestPath: "/work", access: "read-write" },
		{ hostPath: artifactsDirectory, guestPath: "/artifacts", access: "read-only", shadowPaths: ["/main"] },
		{ hostPath: path.join(goalDir, "attachments"), guestPath: MAIN_AGENT_ATTACHMENTS_GUEST_PATH, access: "read-only" },
		{ hostPath: parsedDocumentsDir(goalDir), guestPath: MAIN_AGENT_PARSED_DOCUMENTS_GUEST_PATH, access: "read-only" },
		{ hostPath: syncPublishedReportView(goalDir), guestPath: REPORTS_GUEST_PATH, access: "read-only" },
	];
	return mounts.filter((mount) => existsSync(mount.hostPath)).map((mount) => {
		const root = mount.guestPath === "/work" || mount.guestPath === "/artifacts"
			? artifactsDirectory : goalDir;
		assertBusinessDirectory(root, mount.hostPath);
		return { ...mount, hostPath: requireRealDirectory(mount.hostPath, "Main Agent business files") };
	});
}

function assertBusinessDirectory(root: string, candidate: string): void {
	assertInsideRoot(root, candidate, "Main Agent business mount");
	let current = root;
	for (const part of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		if (lstatSync(current).isSymbolicLink()) throw new Error("Main Agent business mounts cannot contain symbolic links");
	}
	assertInsideRoot(requireRealDirectory(root, "Main Agent business root"), realpathSync(candidate), "Main Agent business mount");
}

/**
 * The parsed document mirror appears only after the first parse; an empty mount beats a failed Main Agent start.
 * A recursive create follows symlinked ancestors, so the deepest existing ancestor is guarded before the
 * write and the created directory again afterwards: neither the mount nor the create may leave `root`.
 */
function ensureRealDirectory(value: string, root: string, label: string): string {
	const resolved = path.resolve(value);
	let existingAncestor = resolved;
	while (!existsSync(existingAncestor)) existingAncestor = path.dirname(existingAncestor);
	assertInsideRoot(root, realpathSync(existingAncestor), label, { rejectDotPrefix: true });
	mkdirSync(resolved, { recursive: true });
	const created = requireRealDirectory(resolved, label);
	assertInsideRoot(root, created, label, { rejectDotPrefix: true, allowRoot: false });
	return created;
}

function requireRealDirectory(value: string, label: string): string {
	const resolved = path.resolve(value);
	if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) {
		throw new Error(`${label} must exist and be a directory: ${resolved}`);
	}
	return realpathSync(resolved);
}

function pathsOverlap(left: string, right: string): boolean {
	return isInsideRoot(left, right, { rejectDotPrefix: true }) || isInsideRoot(right, left, { rejectDotPrefix: true });
}
