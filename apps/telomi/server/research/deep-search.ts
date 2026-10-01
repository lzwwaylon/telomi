import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../lib/hash.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { renderCornellNoteAgentSystemPrompt } from "./pipeline/cornell-note-agent-prompt.js";
import type { AgentStageRunner } from "../agent-runtime/agent-stage-runtime.js";
import type { ThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { createProductionResearchStageRunner } from "./pipeline/production-stage-runner.js";
import { loadFindOutSources } from "./pipeline/find-out-sources.js";
import { materializeAgentSourceView, isReadableTextContent } from "./pipeline/agent-source-view.js";
import type { SourceFileRecord } from "./pipeline/source-bundle.js";
import { researchConfigFromEnv } from "./config.js";
import { findLogicalSourceInRun } from "../workspaces/source-view.js";
import { caseCapture } from "../observability/case-capture.js";
import { inspectAgentSourceView } from "./pipeline/agent-source-view.js";
import { assertSafeRelativePath } from "../lib/paths.js";
import type { InvestigationCitationCue } from "./investigation-citations.js";

const SAFE_ID = /^[A-Za-z0-9._-]{1,100}$/u;
const CUE_REF = /^deep-search:([A-Za-z0-9._-]{1,100}):cue-([1-9]\d*)$/u;

export interface DeepSearchEvidence {
	source_run_id: string;
	source_id: string;
	source_revision_sha256: string;
	source_path: string;
	start_line: number;
	end_line: number;
	content_sha256: string;
	/** Frozen original lines for Case review; older saved Cues may omit them. */
	excerpt?: string;
}

export interface DeepSearchCue {
	ref: string;
	section_title: string;
	cue: string;
	note: string;
	evidence: DeepSearchEvidence[];
}

export interface DeepSearchResult {
	schema_version: 1;
	question: string;
	status: "found" | "partial" | "not_found";
	summary: string;
	gaps: string[];
	cues: DeepSearchCue[];
}

interface CorpusSource {
	ref: string;
	runId: string;
	id: string;
	revision: string;
	title: string;
	url: string;
	files: SourceFileRecord[];
}

/** A single question-scoped Cornell reading over the Goal's pinned original Source views. */
export async function executeDeepSearch(input: {
	goalDir: string;
	goalId: string;
	question: string;
	invocationId: string;
	preferredSourceRunId?: string;
	originalQuestion?: string;
	knownCues?: readonly InvestigationCitationCue[];
	signal: AbortSignal;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	env?: NodeJS.ProcessEnv;
	stageRunner?: AgentStageRunner;
}): Promise<DeepSearchResult> {
	if (!SAFE_ID.test(input.invocationId)) throw new Error("Deep Search invocationId is invalid");
	const question = input.question.trim();
	if (!question) throw new Error("Deep Search requires a question");
	input.signal.throwIfAborted();
	const artifactPath = `artifacts/deep-search/${input.invocationId}.json`;
	const artifactStore = new RunArtifactStore(input.goalDir);
	if (existsSync(join(input.goalDir, artifactPath))) {
		const saved = readDeepSearchArtifact(input.goalDir, input.invocationId);
		if (saved.question !== question) throw new Error("Deep Search invocationId belongs to another question");
		return saved;
	}
	const controlDir = join(input.goalDir, ".pi", "runtime", "deep-search", input.invocationId);
	const corpusDir = join(controlDir, "source");
	const sources = materializeCorpus(input.goalDir, corpusDir, input.preferredSourceRunId);
	writeReaderContext(corpusDir, sources, input.originalQuestion?.trim() || question,
		input.knownCues ?? [], input.preferredSourceRunId);
	const env = input.env ?? process.env;
	const config = input.model && input.thinkingLevel ? undefined : researchConfigFromEnv(env);
	const system = renderCornellNoteAgentSystemPrompt(undefined, "deep-search");
	const userPrompt = [
		`Question: ${question}`,
		"Read source/reader-context.json for the original question, verified prior Cue navigation, current anchor mappings and preferred Source refs. It is navigation only; cite exact original Source lines.",
		`The Goal has ${sources.length} pinned Source views in source/catalog.json, available as needed to resolve the assigned question. Source refs are navigation handles, not evidence.`,
		"Write cornell-note.json with exactly this shape:",
		'{"status":"found|partial|not_found","summary":"short answer or search outcome","gaps":["specific unresolved point"],"sections":[{"section_title":"topic","cue_notes":[{"cue":"topic + keywords","note":"supported conclusion","evidence":[{"source_ref":"S1","source_path":"exact path within that Source","start_line":1,"end_line":2}]}]}]}',
		"Use found only when the question is answered with evidence; partial when some evidence exists but a gap remains; not_found with empty sections when no evidence was found. Every Cue needs at least one exact original-text citation. Do not cite the catalog or manifests. Do not include hashes, IDs, or extra fields: Runtime supplies them.",
	].join("\n\n");
	const runner = input.stageRunner ?? createProductionResearchStageRunner({ env });
	const capturedRunner = caseCapture()?.cornellNote?.(runner,
		{ mode: "deep-search", question, invocationId: input.invocationId }, []) ?? runner;
	const result = await capturedRunner.runStage<DeepSearchResult>({
		runId: input.invocationId,
		stageId: `deep-search-${input.invocationId}`,
		attemptId: "attempt-1",
		role: "cornell_note",
		promptConfig: { domain: "research", id: "cornell-note", sandboxRole: "report.cornell_note",
			userVariant: "deep-search", revisions: { system: system.revision } },
		session: { key: `deep-search/${input.invocationId}`, policy: "fresh" },
		modelPolicy: { preferred: [input.model ?? config!.cornellNoteModel],
			reasoning: input.thinkingLevel ?? config!.cornellNoteThinkingLevel },
		systemPrompt: system.content,
		userPrompt,
		workDirectory: join(controlDir, "stage"),
		readonlyMounts: [{ hostPath: corpusDir, guestPath: "/source", access: "read-only" }],
		controlDirectory: controlDir,
		recordDirectory: controlDir,
		artifactStore,
		output: {
			kind: "cornell_note",
			entryRelativePath: "cornell-note.json",
			publishRelativePath: artifactPath,
			validate: ({ entryPath }) => {
				const validated = validateDeepSearchDraft(
					JSON.parse(readFileSync(entryPath, "utf-8")) as unknown, question, input.invocationId, sources);
				writeFileSync(entryPath, `${JSON.stringify(validated, null, 2)}\n`);
				return validated;
			},
		},
		signal: input.signal,
	});
	// The Runtime trace remains under controlDir; only the temporary corpus is disposable.
	rmSync(corpusDir, { recursive: true, force: true });
	return result.value;
}

/** Prior Notes guide incremental reading; only matching original Source bytes permit reuse. */
function writeReaderContext(corpusDir: string, sources: readonly CorpusSource[], originalQuestion: string,
	knownCues: readonly InvestigationCitationCue[], preferredSourceRunId?: string): void {
	type Identity = Partial<Pick<DeepSearchEvidence, "source_id" | "source_run_id" | "source_revision_sha256" | "content_sha256">>;
	const cues = knownCues.map((cue) => {
		const identity = cue as InvestigationCitationCue & Identity;
		const evidence = cue.evidence.map((raw) => {
			const anchor = raw as typeof raw & Identity;
			const sourceId = anchor.source_id ?? identity.source_id;
			const runId = anchor.source_run_id ?? identity.source_run_id;
			const revision = anchor.source_revision_sha256 ?? identity.source_revision_sha256;
			const url = anchor.url ?? cue.canonical_locator;
			const mapped = sources.filter((source) => sourceId ? source.id === sourceId
				: source.files.some((file) => file.relativePath === anchor.source_path)
					&& (!url || source.url === url));
			const reasons: string[] = [];
			if (mapped.length !== 1) reasons.push(mapped.length ? "ambiguous_source" : "source_unavailable");
			if (!sourceId && !url) reasons.push("source_identity_unavailable");
			const source = mapped.length === 1 ? mapped[0] : undefined;
			const file = source?.files.find((item) => item.relativePath === anchor.source_path);
			if (source) {
				if (runId && source.runId !== runId) reasons.push("source_run_changed");
				if (revision && source.revision !== revision) reasons.push("source_revision_changed");
				if (!file) reasons.push("source_path_unavailable");
			}
			let contentSha256: string | undefined;
			if (file) {
				const lines = readFileSync(file.absolutePath, "utf-8").replace(/\r\n?/gu, "\n").split("\n");
				if (!Number.isSafeInteger(anchor.start_line) || !Number.isSafeInteger(anchor.end_line)
					|| anchor.start_line < 1 || anchor.end_line < anchor.start_line || anchor.end_line > lines.length) {
					reasons.push("line_range_invalid");
				} else {
					const excerpt = lines.slice(anchor.start_line - 1, anchor.end_line).join("\n");
					contentSha256 = sha256(`${excerpt}\n`);
					// Cornell display excerpts strip Markdown assets and whitespace; the hash retains original bytes.
					if (anchor.content_sha256) {
						if (anchor.content_sha256 !== contentSha256) reasons.push("content_hash_changed");
					} else if (anchor.excerpt !== undefined && anchor.excerpt.replace(/\r\n?/gu, "\n") !== excerpt) reasons.push("excerpt_changed");
					if (!anchor.content_sha256 && anchor.excerpt === undefined) reasons.push("original_bytes_unavailable");
				}
			}
			return { source_path: anchor.source_path, start_line: anchor.start_line, end_line: anchor.end_line,
				source_refs: mapped.map((item) => item.ref),
				status: reasons.length ? "recheck_required" : "verified",
				recheck_reasons: reasons, ...(contentSha256 ? { current_content_sha256: contentSha256 } : {}) };
		});
		return { ref: cue.ref, section_title: cue.section_title, cue: cue.cue, note: cue.note,
			status: evidence.length && evidence.every((anchor) => anchor.status === "verified") ? "verified" : "recheck_required",
			evidence };
	});
	writeFileSync(join(corpusDir, "reader-context.json"), `${JSON.stringify({ schema_version: 1,
		original_question: originalQuestion, catalog_ref: "source/catalog.json",
		preferred_source_refs: sources.filter((source) => source.runId === preferredSourceRunId).map((source) => source.ref),
		known_cues: cues,
	}, null, 2)}\n`);
}

/** Previously verified Cue Notes become visible to the next knowledge search before Wiki rebuilds. */
export function searchSavedDeepSearchCues(goalDir: string, query: string, limit = 8): Array<DeepSearchCue & {
	question: string;
	summary: string;
}> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Deep Search limit is invalid");
	const words = searchWords(query);
	if (!words.length) return [];
	const scored: Array<{ score: number; cue: DeepSearchCue; question: string; summary: string }> = [];
	for (const cue of listSavedDeepSearchCues(goalDir)) {
			const title = `${cue.section_title} ${cue.cue}`.toLocaleLowerCase();
			const note = cue.note.toLocaleLowerCase();
			const originalQuestion = cue.question.toLocaleLowerCase();
			const score = words.reduce((sum, word) => sum
				+ (title.includes(word) ? 4 : 0)
				+ (note.includes(word) ? 2 : 0)
				+ (originalQuestion.includes(word) ? 1 : 0), 0);
			if (score) scored.push({ score, cue, question: cue.question, summary: cue.summary });
	}
	return scored.sort((a, b) => b.score - a.score || a.cue.ref.localeCompare(b.cue.ref))
		.slice(0, limit).map(({ cue, question, summary }) => ({ ...cue, question, summary }));
}

/** Complete durable Cue catalog for unified ranking alongside historical Cornell Cues. */
export function listSavedDeepSearchCues(goalDir: string): Array<DeepSearchCue & { question: string; summary: string }> {
	return files(join(goalDir, "artifacts", "deep-search"))
		.filter((name) => /^[A-Za-z0-9._-]{1,100}\.json$/u.test(name))
		.flatMap((file) => {
			const saved = readDeepSearchArtifact(goalDir, file.slice(0, -5));
			return saved.cues.map((cue) => ({ ...cue, question: saved.question, summary: saved.summary }));
		});
}

export function resolveDeepSearchCue(goalDir: string, ref: string): (Omit<DeepSearchCue, "evidence"> & {
	evidence: Array<DeepSearchEvidence & { excerpt: string; title: string; url: string }>;
}) | null {
	const match = CUE_REF.exec(ref);
	if (!match) return null;
	if (!existsSync(join(goalDir, "artifacts", "deep-search", `${match[1]}.json`))) return null;
	const result = readDeepSearchArtifact(goalDir, match[1]!);
	const cue = result.cues[Number(match[2]) - 1];
	if (!cue || cue.ref !== ref) return null;
	return {
		...cue,
		evidence: cue.evidence.map((evidence) => {
			if (!SAFE_ID.test(evidence.source_run_id)) throw new Error("Deep Search Source run ID is invalid");
			assertSafeRelativePath(evidence.source_path, "Deep Search evidence path");
			const runRoot = join(goalDir, "wiki", "runs", evidence.source_run_id);
			const resolved = findLogicalSourceInRun(runRoot, evidence.source_id);
			if (!resolved || resolved.source.revision_sha256 !== evidence.source_revision_sha256) {
				throw new Error(`Deep Search Source revision is unavailable: ${evidence.source_id}`);
			}
			const sourceFile = join(resolved.sourceRoot, evidence.source_path);
			const content = readFileSync(sourceFile);
			if (!isReadableTextContent(content)) throw new Error("Deep Search cited Source is not readable text");
			const lines = new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/\r\n?/gu, "\n").split("\n");
			const excerpt = lines.slice(evidence.start_line - 1, evidence.end_line).join("\n");
			if (evidence.start_line < 1 || evidence.end_line > lines.length
				|| sha256(`${excerpt}\n`) !== evidence.content_sha256) {
				throw new Error(`Deep Search evidence changed: ${evidence.source_id}:${evidence.source_path}`);
			}
			const member = resolved.source.members?.find((item) => typeof item.path === "string"
				&& evidence.source_path.startsWith(`${item.path}/`));
			return { ...evidence, excerpt,
				title: typeof member?.title === "string" ? member.title : String(resolved.source.title ?? evidence.source_id),
				url: typeof member?.canonical_locator === "string" ? member.canonical_locator : "" };
		}),
	};
}

function readDeepSearchArtifact(goalDir: string, invocationId: string): DeepSearchResult {
	const value = JSON.parse(readFileSync(join(goalDir, "artifacts", "deep-search", `${invocationId}.json`), "utf-8")) as DeepSearchResult;
	if (value.schema_version !== 1 || typeof value.question !== "string" || !value.question.trim()
		|| !["found", "partial", "not_found"].includes(value.status)
		|| typeof value.summary !== "string" || !value.summary.trim()
		|| !Array.isArray(value.gaps) || !value.gaps.every((gap) => typeof gap === "string")
		|| !Array.isArray(value.cues)
		|| value.cues.some((cue, index) => cue.ref !== `deep-search:${invocationId}:cue-${index + 1}`)) {
		throw new Error("Deep Search artifact is invalid");
	}
	return value;
}

function materializeCorpus(goalDir: string, outputDir: string, preferredSourceRunId?: string): CorpusSource[] {
	// ponytail: one mounted Goal snapshot inherits Source bundle's 20k-file/512 MiB cap; mount Source views in pages if a real Goal exceeds it.
	rmSync(outputDir, { recursive: true, force: true });
	mkdirSync(outputDir, { recursive: true });
	const runsRoot = join(goalDir, "wiki", "runs");
	if (preferredSourceRunId && (!SAFE_ID.test(preferredSourceRunId)
		|| !existsSync(join(runsRoot, preferredSourceRunId, "artifacts", "find-out-sources")))) {
		throw new Error("Preferred Source Run is unavailable");
	}
	const latest = new Map<string, { runId: string; source: ReturnType<typeof loadFindOutSources>[number] }>();
	const runIds = directories(runsRoot).sort().filter((runId) => runId !== preferredSourceRunId);
	if (preferredSourceRunId) runIds.push(preferredSourceRunId);
	for (const runId of runIds) {
		const runRoot = join(runsRoot, runId);
		const store = new RunArtifactStore(runRoot);
		for (const sequence of directories(join(runRoot, "artifacts", "find-out-sources"))
			.filter((name) => /^sequence-\d+$/u.test(name))
			.sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)))) {
			const artifact = store.describeDirectory(`artifacts/find-out-sources/${sequence}`);
			for (const source of loadFindOutSources(artifact)) latest.set(source.id, { runId, source });
		}
	}
	const sources = [...latest.values()].map(({ runId, source }, index) => {
		const ref = `S${index + 1}`;
		const view = materializeAgentSourceView(source.directoryPath, join(outputDir, ref), source);
		return { ref, runId, id: source.id, revision: source.revisionSha256,
			title: source.title, url: source.url, files: view.contentFiles };
	});
	writeFileSync(join(outputDir, "catalog.json"), `${JSON.stringify({ schema_version: 1,
		sources: sources.map(({ ref, runId, id, revision, title, url, files }) => ({
			ref, source_id: id, source_run_id: runId, source_revision_sha256: revision,
			title, url, path: ref, readable_file_count: files.length,
		})) }, null, 2)}\n`);
	return sources;
}

/** Replay validates against the captured /source corpus, never the live Goal directory. */
export function validateDeepSearchDraftFromCorpus(value: unknown, question: string,
	invocationId: string, corpusDir: string): DeepSearchResult {
	const catalog = record(JSON.parse(readFileSync(join(corpusDir, "catalog.json"), "utf-8")) as unknown,
		"Deep Search catalog");
	if (catalog.schema_version !== 1 || !Array.isArray(catalog.sources)) throw new Error("Deep Search catalog is invalid");
	const sources = catalog.sources.map((raw, index): CorpusSource => {
		const source = record(raw, `catalog.sources[${index}]`);
		const ref = nonEmpty(source.ref, "Source ref");
		if (!/^S[1-9]\d*$/u.test(ref)) throw new Error("Deep Search Source ref is invalid");
		return {
			ref,
			runId: nonEmpty(source.source_run_id, "Source run ID"),
			id: nonEmpty(source.source_id, "Source ID"),
			revision: nonEmpty(source.source_revision_sha256, "Source revision"),
			title: nonEmpty(source.title, "Source title"),
			url: nonEmpty(source.url, "Source URL"),
			files: inspectAgentSourceView(join(corpusDir, ref)).contentFiles,
		};
	});
	return validateDeepSearchDraft(value, question, invocationId, sources);
}

function validateDeepSearchDraft(value: unknown, question: string, invocationId: string,
	sources: readonly CorpusSource[]): DeepSearchResult {
	const draft = record(value, "Deep Search");
	keys(draft, ["status", "summary", "gaps", "sections"], "Deep Search");
	if (draft.status !== "found" && draft.status !== "partial" && draft.status !== "not_found") {
		throw new Error("Deep Search status is invalid");
	}
	const summary = nonEmpty(draft.summary, "summary");
	if (!Array.isArray(draft.gaps) || !Array.isArray(draft.sections)) throw new Error("Deep Search gaps and sections must be arrays");
	const gaps = draft.gaps.map((gap, index) => nonEmpty(gap, `gaps[${index}]`));
	const byRef = new Map(sources.map((source) => [source.ref, source]));
	const cues: DeepSearchCue[] = [];
	for (const [sectionIndex, rawSection] of draft.sections.entries()) {
		const section = record(rawSection, `sections[${sectionIndex}]`);
		keys(section, ["section_title", "cue_notes"], `sections[${sectionIndex}]`);
		const sectionTitle = nonEmpty(section.section_title, `sections[${sectionIndex}].section_title`);
		if (!Array.isArray(section.cue_notes) || section.cue_notes.length === 0) throw new Error("Deep Search section needs Cue Notes");
		for (const [cueIndex, rawCue] of section.cue_notes.entries()) {
			const label = `sections[${sectionIndex}].cue_notes[${cueIndex}]`;
			const cue = record(rawCue, label);
			keys(cue, ["cue", "note", "evidence"], label);
			if (!Array.isArray(cue.evidence) || cue.evidence.length === 0) throw new Error(`${label} requires evidence`);
			const evidence = cue.evidence.map((rawEvidence, evidenceIndex): DeepSearchEvidence => {
				const where = `${label}.evidence[${evidenceIndex}]`;
				const candidate = record(rawEvidence, where);
				keys(candidate, ["source_ref", "source_path", "start_line", "end_line"], where);
				const source = byRef.get(nonEmpty(candidate.source_ref, `${where}.source_ref`));
				if (!source) throw new Error(`${where} has unknown Source ref`);
				const path = nonEmpty(candidate.source_path, `${where}.source_path`);
				const file = source.files.find((item) => item.relativePath === path);
				if (!file) throw new Error(`${where} has undeclared Source path '${path}'`);
				const start = positiveInteger(candidate.start_line, `${where}.start_line`);
				const end = positiveInteger(candidate.end_line, `${where}.end_line`);
				const content = readFileSync(file.absolutePath);
				if (!isReadableTextContent(content)) throw new Error(`${where} is not readable text`);
				const lines = new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/\r\n?/gu, "\n").split("\n");
				if (end < start || end > lines.length) throw new Error(`${where} line range is invalid`);
				const excerpt = lines.slice(start - 1, end).join("\n");
				if (excerpt.length > 32_000) throw new Error(`${where} excerpt is too large`);
				return { source_run_id: source.runId, source_id: source.id, source_revision_sha256: source.revision,
					source_path: path, start_line: start, end_line: end,
					content_sha256: sha256(`${excerpt}\n`), excerpt };
			});
			cues.push({ ref: `deep-search:${invocationId}:cue-${cues.length + 1}`,
				section_title: sectionTitle, cue: nonEmpty(cue.cue, `${label}.cue`),
				note: nonEmpty(cue.note, `${label}.note`), evidence });
		}
	}
	if (draft.status === "not_found" && (cues.length || gaps.length === 0)) throw new Error("not_found requires no Cues and a gap");
	if (draft.status === "found" && (cues.length === 0 || gaps.length)) throw new Error("found requires Cues and no gaps");
	if (draft.status === "partial" && gaps.length === 0) throw new Error("partial requires a gap");
	return { schema_version: 1, question, status: draft.status, summary, gaps, cues };
}

function directories(path: string): string[] {
	try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
	catch { return []; }
}

function files(path: string): string[] {
	try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name); }
	catch { return []; }
}

function searchWords(query: string): string[] {
	const text = query.toLocaleLowerCase();
	const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
	return [...new Set(words.flatMap((word) => {
		if (!/[\p{Script=Han}]/u.test(word) || word.length < 3) return [word];
		return [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))];
	}))];
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: string[], label: string): void {
	if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value))) {
		throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
	}
}

function nonEmpty(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty text`);
	return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
	return value as number;
}
