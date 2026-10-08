import { existsSync } from "node:fs";
import { join } from "node:path";

import { readJson, writeJsonAtomic } from "../lib/fs.js";
import { assertNoDuplicates, isRecord } from "../lib/values.js";
import { validateSourceNotesSnapshot, type SourceNotesSnapshot } from "../notes/contracts.js";
import { serverRuntimeDirForGoalDir } from "../workspaces/server-runtime-paths.js";
import { noteWikiEntries } from "./note-entries.js";
import { hashJson } from '../lib/hash.js';

export interface WikiDeferredEvidence {
	snapshots: SourceNotesSnapshot[];
	entryIds: string[];
}

export function validateDeferredWikiEvidence(value: unknown): WikiDeferredEvidence {
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "snapshots" && key !== "entryIds")
		|| !Array.isArray(value.snapshots) || !Array.isArray(value.entryIds)
		|| !value.entryIds.every((id): id is string => typeof id === "string" && id.length > 0)) {
		throw new Error("Invalid deferred Wiki evidence");
	}
	const entryIds = value.entryIds;
	assertNoDuplicates(entryIds, "Deferred Wiki entryIds");
	const snapshots = value.snapshots.map(validateSourceNotesSnapshot);
	const required = new Set(entryIds);
	const revisions = new Map<string, string>();
	for (const snapshot of snapshots) {
		for (const entry of noteWikiEntries(snapshot)) {
			if (!required.has(entry.id)) continue;
			const previous = revisions.get(entry.id);
			if (previous !== undefined && previous !== entry.revisionSha256) {
				throw new Error(`Deferred Wiki evidence has conflicting revision for '${entry.id}'`);
			}
			revisions.set(entry.id, entry.revisionSha256);
		}
	}
	for (const id of entryIds) {
		if (!revisions.has(id)) throw new Error(`Deferred Wiki evidence has unknown entry '${id}'`);
	}
	// Keep entire Notes: removing neighboring Cues changes index-based ordinary Cue identities.
	return { snapshots, entryIds };
}

export function readDeferredWikiEvidence(goalDir: string): WikiDeferredEvidence {
	const path = join(serverRuntimeDirForGoalDir(goalDir), "wiki-deferred-evidence.json");
	return existsSync(path) ? validateDeferredWikiEvidence(readJson(path)) : { snapshots: [], entryIds: [] };
}

export function pinDeferredWikiEvidence(controlDirectory: string, goalDir: string): WikiDeferredEvidence {
	const path = join(controlDirectory, "deferred-evidence-input.json");
	if (existsSync(path)) return validateDeferredWikiEvidence(readJson(path));
	const value = readDeferredWikiEvidence(goalDir);
	writeJsonAtomic(path, value);
	return value;
}

/** Call only after successful publication; failed attempts keep the previous deferred state. */
export function writeDeferredWikiEvidence(goalDir: string, value: WikiDeferredEvidence): void {
	writeJsonAtomic(join(serverRuntimeDirForGoalDir(goalDir), "wiki-deferred-evidence.json"), validateDeferredWikiEvidence(value));
}

/** A resumed older Update may decide only its own inputs, preserving later pending Cues. */
export function prepareDeferredWikiEvidence(goalDir: string, processedEntryIds: readonly string[], next: WikiDeferredEvidence): WikiDeferredEvidence {
	const accepted = validateDeferredWikiEvidence(next);
	const current = readDeferredWikiEvidence(goalDir);
	const processed = new Set(processedEntryIds);
	const entryIds = [...new Set([...current.entryIds.filter(id => !processed.has(id)), ...accepted.entryIds])];
	const remaining = new Set(entryIds);
	const snapshots = [...new Map([...current.snapshots, ...accepted.snapshots]
		.filter(snapshot => noteWikiEntries(snapshot).some(entry => remaining.has(entry.id)))
		.map(snapshot => [hashJson(snapshot), snapshot])).values()];
	return validateDeferredWikiEvidence({ snapshots, entryIds });
}

export function advanceDeferredWikiEvidence(goalDir: string, processedEntryIds: readonly string[], next: WikiDeferredEvidence): void {
	writeDeferredWikiEvidence(goalDir, prepareDeferredWikiEvidence(goalDir, processedEntryIds, next));
}
