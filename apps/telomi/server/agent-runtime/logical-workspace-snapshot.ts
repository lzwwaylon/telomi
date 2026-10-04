import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SandboxMountSpec } from "../../../extensions/telomi-srt/sandbox-spec.js";

export interface LogicalWorkspaceSnapshot {
	guestCwd: string;
	mounts: readonly SandboxMountSpec[];
	sessionId?: string;
	sessionRole?: "root" | "child";
	stage?: { kind: string; key: string };
	captureMoment?: "before-first-agent-turn";
	excludedMounts?: ReadonlyArray<{ guestPath: string; access: SandboxMountSpec["access"]; reason: "runtime-library" | "runtime-state" }>;
}

/** Materializes one Agent-visible filesystem view under stable guest paths. */
export function snapshotLogicalWorkspace(input: LogicalWorkspaceSnapshot, destination: string): void {
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	for (const mount of input.mounts) {
		copyVisibleTree(mount.hostPath, join(destination, mount.guestPath.slice(1)), mount.shadowPaths ?? [], "");
	}
	writeFileSync(`${destination}.json`, `${JSON.stringify({
		schemaVersion: 1,
		guestCwd: input.guestCwd,
		mounts: input.mounts.map(({ guestPath, access }) => ({ guestPath, access })),
		...(input.sessionId ? { sessionId: input.sessionId, role: input.sessionRole, stage: input.stage,
			captureMoment: input.captureMoment, capturedAt: new Date().toISOString(), excludedMounts: input.excludedMounts ?? [] } : {}),
	}, null, 2)}\n`, { mode: 0o600 });
}

/** Captures each RLM child's shared Workspace before its first Agent turn. */
export function createRlmChildLogicalWorkspaceSnapshotter(
	workspace: LogicalWorkspaceSnapshot | ((childId: string) => LogicalWorkspaceSnapshot),
	destinationRoot: string,
	kind: "provider" | "child" = "provider",
): (event: unknown) => void {
	const attempted = new Set<string>();
	return (event) => {
		const value = event as { type?: string; child?: { id?: string; status?: string } };
		const childId = value.child?.id;
		if (value.type !== "rlm_child_update" || value.child?.status !== "running"
			|| !childId || !/^sub-[A-Za-z0-9-]+$/u.test(childId) || attempted.has(childId)) return;
		// SDK emitters swallow subscriber exceptions. Later running updates must
		// never retry an initial capture after the child's first model turn.
		attempted.add(childId);
		const destination = join(destinationRoot, kind, childId);
		try {
			snapshotLogicalWorkspace(typeof workspace === "function" ? workspace(childId) : workspace, destination);
		} catch (error) {
			rmSync(destination, { recursive: true, force: true });
			rmSync(`${destination}.json`, { force: true });
			mkdirSync(join(destinationRoot, kind), { recursive: true });
			writeFileSync(`${destination}.failed.json`, `${JSON.stringify({
				schemaVersion: 1, childId, status: "failed", reason: "initial-workspace-capture-failed",
				attemptedAt: new Date().toISOString(),
			}, null, 2)}\n`, { mode: 0o600 });
			throw error;
		}
	};
}

function copyVisibleTree(source: string, destination: string, shadows: readonly string[], relativePath: string): void {
	if (shadows.some((shadow) => {
		const path = shadow.replace(/^\/+/, "");
		return relativePath === path || relativePath.startsWith(`${path}/`);
	})) return;
	const stat = lstatSync(source);
	if (stat.isSymbolicLink()) return;
	if (stat.isDirectory()) {
		mkdirSync(destination, { recursive: true });
		for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			copyVisibleTree(join(source, entry.name), join(destination, entry.name), shadows, relativePath ? `${relativePath}/${entry.name}` : entry.name);
		}
		return;
	}
	if (stat.isFile()) copyFileSync(source, destination);
}
