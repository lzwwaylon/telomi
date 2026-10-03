import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { DataDirectoryError } from "./data-dir.js";
import type { DataMigration } from "./data-format.js";
import { resolveAgentDir } from "./agent-directory.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { serverRuntimeRoot } from "../workspaces/server-runtime-paths.js";

/** Format version 5 changes mutable preferences and job metadata; historical evidence stays byte-identical. */
export const canonicalizeAgentNames: DataMigration = {
	name: "use canonical Agent model preferences and Wiki compiler job names",
	run(dataDir) {
		const path = join(resolveAgentDir(dataDir), "settings.json");
		const updates: Array<{ path: string; value: Record<string, unknown> }> = [];
		if (existsSync(path) && readFileSync(path, "utf8").trim()) {
			const settings = readRecord(path);
			if (renameTaskModelPreferences(settings, path)) updates.push({ path, value: settings });
		}
		// Only the direct control records of Research Runs and standalone Wiki Updates are mutable.
		// Never descend into captured Cases, retained Trace, artifacts or published Wiki Editions.
		for (const goalDir of directories(serverRuntimeRoot(dataDir))) {
			for (const queue of ["runs", "wiki-updates"]) {
				for (const controlDir of directories(join(goalDir, queue))) {
					const jobPath = join(controlDir, "wiki-update-job.json");
					if (!existsSync(jobPath)) continue;
					const job = readRecord(jobPath);
					if (job.compiler === "legacy" || job.compiler === "note-first") {
						job.compiler = job.compiler === "legacy" ? "shards" : "wiki-compilation";
						updates.push({ path: jobPath, value: job });
					}
				}
			}
		}
		// Validate every planned record before writing; each atomic replacement is independently reentrant.
		for (const update of updates) writeJsonAtomic(update.path, update.value, { mode: 0o600 });
	},
};

function renameTaskModelPreferences(settings: Record<string, unknown>, path: string): boolean {
	let changed = false;
	for (const field of ["taskModels", "stageThinkingLevels"] as const) {
		if (settings[field] === undefined) continue;
		const values = record(settings[field], field);
		for (const key of Object.keys(values)) {
			const next = field === "taskModels"
				? key === "cornellNote" ? "noteAgent" : key === "wikiMaintainer" ? "wikiCurator" : key
				: key.replace(/^cornellNote\./u, "noteAgent.").replace(/^wikiMaintainer\./u, "wikiCurator.");
			if (next === key) continue;
			if (Object.hasOwn(values, next) && !isDeepStrictEqual(values[next], values[key])) {
				throw new DataDirectoryError(`Cannot migrate ${path}: ${field}.${key} conflicts with ${field}.${next}; reconcile these preferences before starting Telomi.`);
			}
			values[next] = values[key];
			delete values[key];
			changed = true;
		}
	}
	return changed;
}

function readRecord(path: string): Record<string, unknown> {
	try {
		return record(JSON.parse(readFileSync(path, "utf8")), path);
	} catch (error) {
		throw new DataDirectoryError(`Cannot migrate ${path}: ${(error as Error).message}`);
	}
}

function directories(path: string): string[] {
	return existsSync(path) ? readdirSync(path, { withFileTypes: true })
		.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name)) : [];
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new DataDirectoryError(`${label} must contain an object`);
	}
	return value as Record<string, unknown>;
}
