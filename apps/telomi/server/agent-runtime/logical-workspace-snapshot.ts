import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SandboxMountSpec } from "../../../extensions/telomi-srt/sandbox-spec.js";

export interface LogicalWorkspaceSnapshot {
	guestCwd: string;
	mounts: readonly SandboxMountSpec[];
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
	}, null, 2)}\n`, { mode: 0o600 });
}

/** Captures each RLM child's shared Workspace before its first Agent turn. */
export function createRlmChildLogicalWorkspaceSnapshotter(
	workspace: LogicalWorkspaceSnapshot | ((childId: string) => LogicalWorkspaceSnapshot),
	destinationRoot: string,
	kind: "provider" | "child" = "provider",
): (event: unknown) => void {
	const captured = new Set<string>();
	return (event) => {
		const value = event as { type?: string; child?: { id?: string; status?: string } };
		const childId = value.child?.id;
		if (value.type !== "rlm_child_update" || value.child?.status !== "running"
			|| !childId || !/^sub-[A-Za-z0-9-]+$/u.test(childId) || captured.has(childId)) return;
		snapshotLogicalWorkspace(typeof workspace === "function" ? workspace(childId) : workspace, join(destinationRoot, kind, childId));
		captured.add(childId);
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
