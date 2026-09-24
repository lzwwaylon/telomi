import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RunStateStore } from "../run-state.js";
import { FIND_OUT_SOURCE_MANIFEST_SCHEMA_VERSION } from "../pipeline/find-out-sources.js";
import type { ResearchScheduleSource } from "./types.js";

interface CornellNoteSnapshot {
	schema_version: number;
	notes?: Array<{ note: { source_id: string } }>;
}

interface ProcessedSourceCandidate {
	sourceId: string;
	sourceIdentity: string;
	contentSha256: string;
}

export interface ProcessedResearchRun {
	runId: string;
	question: string;
	startedAt: string;
	status: string;
	sources: ResearchScheduleSource[];
	/**
	 * Sources this Run published without a Cornell Note, each one recorded in the Run's own
	 * Cornell Note failure manifest. They are deliberately kept out of `sources` so the next
	 * occurrence treats them as unprocessed and reads them again.
	 */
	unprocessedSources: ResearchScheduleSource[];
	discoveredSources: number;
	cornellNotes: number;
}

export function readProcessedResearchRun(args: {
	goalDir: string;
	controlRunDir: string;
	runId: string;
}): ProcessedResearchRun {
	const state = new RunStateStore(args.controlRunDir).load();
	if (!state || state.run_id !== args.runId) {
		throw new Error(`Research Run '${args.runId}' has no valid state`);
	}
	const wikiRunDir = join(args.goalDir, "wiki", "runs", args.runId);
	const findOutRefs = state.find_out_sources ?? [];
	if (findOutRefs.length === 0 && !(state.status === "skipped" && state.skip_reason === "no_source_increment")) {
		throw new Error(`Research Run '${args.runId}' has no Find Out Source snapshot`);
	}
	const sources = readFindOutSources(wikiRunDir, findOutRefs);
	const discoveredSources = new Set(sources.map((source) => source.sourceIdentity)).size;

	const evidenceRef = state.cornell_note_snapshots.at(-1);
	if (!evidenceRef && state.status === "skipped" && state.skip_reason === "no_source_increment") {
		return {
			runId: state.run_id,
			question: state.question,
			startedAt: state.started_at,
			status: state.status,
			sources: [],
			unprocessedSources: [],
			discoveredSources,
			cornellNotes: 0,
		};
	}
	if (!evidenceRef) throw new Error(`Research Run '${args.runId}' has no Evidence snapshot`);
	const evidence = JSON.parse(
		readFileSync(join(wikiRunDir, evidenceRef.relative_path), "utf-8"),
	) as CornellNoteSnapshot;
	if (evidence.schema_version !== 1 || !Array.isArray(evidence.notes)) {
		throw new Error(`Research Run '${args.runId}' has no completed Cornell Note snapshot`);
	}
	const noteSourceIds = new Set(evidence.notes.map((record) => record.note.source_id));
	// A published Run is allowed to carry Cornell Note gaps it recorded itself; an unrecorded gap
	// means the snapshot and the manifests disagree, and that is still a broken Run.
	const recordedFailures = readRecordedNoteFailures(
		wikiRunDir,
		args.runId,
		state.cornell_note_failure_manifests ?? [],
	);
	const processedSources = new Map<string, ResearchScheduleSource>();
	const unprocessedSources = new Map<string, ResearchScheduleSource>();
	const unrecorded = new Set<string>();
	for (const source of sources) {
		const scheduleSource: ResearchScheduleSource = {
			sourceIdentity: source.sourceIdentity,
			contentSha256: source.contentSha256,
		};
		const key = `${scheduleSource.sourceIdentity}\0${scheduleSource.contentSha256}`;
		// A Note produced after an earlier attempt failed wins: the Source is covered either way.
		if (noteSourceIds.has(source.sourceId)) processedSources.set(key, scheduleSource);
		else if (recordedFailures.has(source.sourceId)) unprocessedSources.set(key, scheduleSource);
		else unrecorded.add(source.sourceId);
	}
	if (unrecorded.size > 0) {
		throw new Error(
			`Research Run '${args.runId}' produced ${discoveredSources} Sources, and ${unrecorded.size} of them have`
			+ ` neither a Cornell Note nor a recorded Note failure: ${[...unrecorded].join(", ")}.`
			+ " Use another published Research Run, or run this research again.",
		);
	}
	return {
		runId: state.run_id,
		question: state.question,
		startedAt: state.started_at,
		status: state.status,
		sources: [...processedSources.values()],
		unprocessedSources: [...unprocessedSources.values()],
		discoveredSources,
		cornellNotes: evidence.notes.length,
	};
}

/**
 * Every Source the Run itself reported as a failed Cornell Note, across all of its manifests.
 * The manifest has to name this Run: only a Run's own record may excuse its own missing Notes.
 */
function readRecordedNoteFailures(
	wikiRunDir: string,
	runId: string,
	refs: readonly { relative_path: string }[],
): Set<string> {
	const failed = new Set<string>();
	for (const ref of refs) {
		const manifest = JSON.parse(readFileSync(join(wikiRunDir, ref.relative_path), "utf-8")) as {
			schema_version?: number;
			run_id?: unknown;
			failures?: unknown;
		};
		if (manifest.schema_version !== 1 || manifest.run_id !== runId || !Array.isArray(manifest.failures)) {
			throw new Error(`Cornell Note failure manifest '${ref.relative_path}' is invalid`);
		}
		for (const failure of manifest.failures as Array<{ source_id?: unknown }>) {
			if (typeof failure?.source_id !== "string" || !failure.source_id) {
				throw new Error(`Cornell Note failure manifest '${ref.relative_path}' has an invalid failure`);
			}
			failed.add(failure.source_id);
		}
	}
	return failed;
}

function readFindOutSources(
	wikiRunDir: string,
	refs: readonly { relative_path: string }[],
): ProcessedSourceCandidate[] {
	return refs.flatMap((ref) => {
		const manifest = JSON.parse(
			readFileSync(join(wikiRunDir, ref.relative_path, "manifest.json"), "utf-8"),
		) as {
			schema_version: number;
			sources: Array<{
				source_id: string;
				revision_sha256: string;
				members: Array<{ canonical_locator: string }>;
			}>;
		};
		if (manifest.schema_version !== FIND_OUT_SOURCE_MANIFEST_SCHEMA_VERSION || !Array.isArray(manifest.sources)) {
			throw new Error(`Find Out Source manifest '${ref.relative_path}' is invalid`);
		}
		return manifest.sources.map((source) => {
			const locator = source.members?.[0]?.canonical_locator;
			if (
				typeof source.source_id !== "string"
				|| typeof locator !== "string"
				|| !/^[a-f0-9]{64}$/u.test(source.revision_sha256)
			) {
				throw new Error(`Find Out Source manifest '${ref.relative_path}' has an invalid Source`);
			}
			return {
				sourceId: source.source_id,
				sourceIdentity: source.source_id,
				contentSha256: source.revision_sha256,
			};
		});
	});
}
