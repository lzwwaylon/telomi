import { existsSync } from "node:fs";
import { join } from "node:path";

import { readJson, writeJsonAtomic } from "../lib/fs.js";
import { runtimeStateDir } from "../workspaces/goal-runtime-paths.js";

/** Activity id to the `timing.updatedAt` of the failure the user dismissed; a later failure has a new time. */
export type ActivityDismissalRecord = Record<string, string>;

export interface ActivityDismissalStore {
	read(goalId: string): ActivityDismissalRecord;
	write(goalId: string, record: ActivityDismissalRecord): void;
}

export function goalActivityDismissalStore(goalDirOf: (goalId: string) => string): ActivityDismissalStore {
	const path = (goalId: string) => join(runtimeStateDir(goalDirOf(goalId)), "activity-dismissals.json");
	return {
		read(goalId) {
			const file = path(goalId);
			if (!existsSync(file)) return {};
			const value = readJson<unknown>(file);
			if (!value || typeof value !== "object" || Array.isArray(value)) return {};
			return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
		},
		write(goalId, record) {
			writeJsonAtomic(path(goalId), record);
		},
	};
}
