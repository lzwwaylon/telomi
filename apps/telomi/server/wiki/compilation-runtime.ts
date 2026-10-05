import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { freezeModelDefinitions, pinTaskModelSelection } from "../agent-runtime/model-policy.js";
import type { SourceNotesSnapshot } from "../notes/contracts.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { isRecord } from "../lib/values.js";

/** Pin once per Wiki Update so recovery keeps its original model selection. */
export function pinWikiModelSelection(controlDirectory: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const selectionPath = join(controlDirectory, "wiki-model-selection.json");
	const saved = existsSync(selectionPath) ? JSON.parse(readFileSync(selectionPath, "utf-8")) : undefined;
	if (saved !== undefined && (!isRecord(saved) || Object.keys(saved).length !== 3
		|| ![saved.TELOMI_WIKI_COMPILATION_MODEL, saved.TELOMI_PRIME_AGENT_CHILD_MODEL]
		.every((model) => typeof model === "string" && /^[^/]+\/.+$/u.test(model))
		|| !isThinkingLevel(saved.TELOMI_WIKI_COMPILATION_THINKING_LEVEL))) {
		throw new Error("Invalid persisted Wiki model selection");
	}
	const pinned = pinTaskModelSelection(["wikiCompilation", "primeChild"], { ...(environment), ...saved });
	mkdirSync(controlDirectory, { recursive: true });
	writeJsonAtomic(selectionPath, {
		TELOMI_WIKI_COMPILATION_MODEL: pinned.TELOMI_WIKI_COMPILATION_MODEL,
		TELOMI_PRIME_AGENT_CHILD_MODEL: pinned.TELOMI_PRIME_AGENT_CHILD_MODEL,
		TELOMI_WIKI_COMPILATION_THINKING_LEVEL: pinned.TELOMI_WIKI_COMPILATION_THINKING_LEVEL,
	});
	return freezeModelDefinitions(pinned, controlDirectory);
}

export function sessionTraceRef(
	controlDirectory: string,
	name: string,
	sessions: ReadonlyArray<{ path: string; label: string }>,
	completedRoots: readonly string[] = [],
): string {
	const traceRef = `wiki-trace-${name}.json`;
	writeJsonAtomic(join(controlDirectory, traceRef), {
		schemaVersion: 1,
		sessions: [...sessions, ...completedRoots.map((path) => ({ path, label: "Wiki Session" }))]
			.map((session) => ({ ...session, path: relative(controlDirectory, session.path) })),
	});
	return traceRef;
}

export function projectWikiEvidence(evidence: SourceNotesSnapshot): SourceNotesSnapshot {
	return {
		...evidence,
		notes: evidence.notes.map((record) => ({
			...record,
			note: {
				...record.note,
				sections: record.note.sections.map((section) => ({
					...section,
					cue_notes: section.cue_notes.map(({ discovery: _discovery, ...cue }) => cue),
				})),
			},
		})),
	};
}
