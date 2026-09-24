import { basename, dirname, join } from "path";
import { runtimeRoot } from "./goal-runtime-paths.js";

import { resolveDataDir } from "../config/data-dir.js";

export function serverRuntimeRoot(dataDir = resolveDataDir()): string {
	return join(runtimeControlRoot(dataDir), "harness");
}

export function serverRuntimeDirForGoal(goalId: string, dataDir = resolveDataDir()): string {
	return join(serverRuntimeRoot(dataDir), safeRuntimeSegment(goalId));
}

export function serverRuntimeDirForGoalDir(goalDir: string): string {
	return serverRuntimeDirForGoal(basename(goalDir), dirname(goalDir));
}

function safeRuntimeSegment(value: string): string {
	const clean = value
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 128);
	return clean || "goal";
}

/** Global Runtime Control Store, outside every Goal directory. */
export function runtimeControlRoot(dataDir = resolveDataDir()): string {
	return runtimeRoot(dataDir);
}

/** Legacy Voice control data stays in .pi/voice for data compatibility. */
export function voiceDataRoot(dataDir: string): string {
	return join(dataDir, ".pi", "voice");
}
