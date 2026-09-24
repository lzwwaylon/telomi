import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../lib/hash.js";
import { preparePythonSkillEnvironment } from "../agent-runtime/python-environment.js";
import { loadAgentPromptConfig } from "../agent-runtime/prompt-registry.js";
import type {
	CornellEvidence,
	CornellNote,
	CornellNoteBatchResult,
	CornellNoteInput,
	CornellNoteProcessor,
	CornellSourceNote,
} from "./cornell-note.js";
import type { ResearchRuntimeConfig } from "./research-types.js";
import { AgentStageExecutionError, type AgentStageRunner } from "../agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import {
	buildCornellNoteAgentSystemPrompt,
	buildCornellNoteAgentUserPrompt,
	renderCornellNoteAgentSystemPrompt,
	renderCornellNoteAgentUserPrompt,
} from "./pipeline/cornell-note-agent-prompt.js";
import { mapConcurrentFairly } from "./pipeline/fair-concurrency.js";
import { caseCapture } from "../observability/case-capture.js";
import { cornellNoteArtifactPath, RuntimeCornellNotesMaterializer } from "./pipeline/cornell-notes.js";
import { isReadableTextContent, materializeAgentSourceView } from "./pipeline/agent-source-view.js";
import type { SourceFileRecord } from "./pipeline/source-bundle.js";
import type { ResearchHarnessSnapshot } from "./harness/snapshot.js";
import { goalTopicReferences, type GoalTopicPlan } from "../goals/topic-plan/index.js";
import { toErrorMessage } from "../lib/values.js";
import { safeName } from "../lib/paths.js";

export function cornellNoteAgentToolNames(): string[] {
	const config = loadAgentPromptConfig("research", "cornell-note");
	if (config.sandbox?.role !== "report.cornell_note"
		|| config.sandbox.executionProfile !== "prime_ipython"
		|| config.sandbox.network !== "deny"
		|| config.sandbox.tools.join("\0") !== "ipython") {
		throw new Error("Cornell Note Prompt Tool contract must be ipython with network denied");
	}
	return [...config.sandbox.tools];
}

export function cornellNoteAgentContractIdentity(): {
	id: "research-cornell-note";
	version: "12";
	sha256: string;
} {
	const id = "research-cornell-note" as const;
	const version = "12" as const;
	return {
		id,
		version,
		sha256: sha256(JSON.stringify({
			id,
			version,
			system_prompt: buildCornellNoteAgentSystemPrompt(),
			user_prompt: buildCornellNoteAgentUserPrompt({
				question: "<question>",
				goal: { title: "<goal>", description: "<description>" },
				discoveryEnabled: true,
			}),
			output: "Cornell Note",
			execution_profile: "prime_ipython",
			thinking: "medium",
			tools: cornellNoteAgentToolNames(),
		})),
	};
}

/** One fresh Prime Agent reads one complete organized Source. */
/**
 * Cornell Note 的生产构造入口。Research Run 与 Cornell Note 的节点 Evaluation 都从这里取
 * Materializer，两边因此拿到同一套 Skill 上下文与同一份 Python Skill 环境。
 */
export async function createProductionCornellNoteProcessor(input: {
	harness: ResearchHarnessSnapshot;
	config: ResearchRuntimeConfig;
	stageRunner: AgentStageRunner;
	dataDir: string;
	env: Record<string, string | undefined>;
	skillWorkspaceDirectory: string;
}): Promise<RuntimeCornellNoteAgentProcessor> {
	const snapshot = input.harness.agentSkills["cornell-note"];
	const bindings = await Promise.all(snapshot.skills.map(async (asset) => {
		const hostPath = join(input.skillWorkspaceDirectory, "cornell-note", asset.name);
		const python = await preparePythonSkillEnvironment(hostPath, { dataDir: input.dataDir, env: input.env });
		return {
			hostPath,
			workspaceRelativePath: `skills/cornell-note/${asset.name}`,
			pythonPaths: python?.pythonPaths ?? [],
		};
	}));
	return new RuntimeCornellNoteAgentProcessor(
		input.config,
		input.stageRunner,
		bindings,
	);
}

export async function createProductionCornellNotesMaterializer(
	input: Parameters<typeof createProductionCornellNoteProcessor>[0],
): Promise<RuntimeCornellNotesMaterializer> {
	return new RuntimeCornellNotesMaterializer(await createProductionCornellNoteProcessor(input));
}

export class RuntimeCornellNoteAgentProcessor implements CornellNoteProcessor {
	constructor(
		private readonly config: ResearchRuntimeConfig,
		private readonly stageRunner: AgentStageRunner,
		private readonly skills: Array<{ hostPath: string; workspaceRelativePath: string; pythonPaths: string[] }> = [],
	) {}

	async process(input: CornellNoteInput): Promise<CornellNoteBatchResult> {
		input.signal.throwIfAborted();
		const outcomes = await mapConcurrentFairly(
			input.sources,
			this.config.documentConcurrency,
			async (document) => {
				try {
					return { note: await this.processDocument(input, document) };
				} catch (error) {
					input.signal.throwIfAborted();
					if (!(error instanceof AgentStageExecutionError) || error.failureClass === "budget") throw error;
					return { failure: {
						source: document,
						message: toErrorMessage(error),
					} };
				}
			},
			input.signal,
		);
		return {
			notes: outcomes.flatMap((outcome) => outcome.note ? [outcome.note] : []),
			failures: outcomes.flatMap((outcome) => outcome.failure ? [outcome.failure] : []),
		};
	}

	private async processDocument(
		input: CornellNoteInput,
		document: CornellSourceNote["source"],
	): Promise<CornellSourceNote> {
		input.signal.throwIfAborted();
		// Stage 身份按 Source batch 与 Source 固定。恢复后 pending 列表会因复用检查点而缩短或重排，
		// 按位置编号会让同一个逻辑节点换一个身份，也会和另一批次的另一个 Source 撞号。
		const segment = `${input.sequence}-${safeName(document.id, { maxLength: 100, fallback: "source" })}`;
		const workRoot = join(input.controlDir, "workspaces", "cornell-notes", segment);
		rmSync(workRoot, { recursive: true, force: true });
		mkdirSync(workRoot, { recursive: true });
		const sourceView = materializeAgentSourceView(document.directoryPath, join(workRoot, "source"), document);
		const sourceDirectory = sourceView.directoryPath;
		const sourceFiles = sourceView.contentFiles;
		const artifactStore = input.artifactStore ?? new RunArtifactStore(input.workspaceDir);
		const request = {
			question: input.question,
			goal: input.goal,
			discoveryEnabled: input.discoveryEnabled,
			...(input.topicPlan ? { topicPlan: input.topicPlan } : {}),
			...(document.updateContext ? { sourceUpdate: document.updateContext } : {}),
		};
		const systemPrompt = renderCornellNoteAgentSystemPrompt();
		const userPrompt = renderCornellNoteAgentUserPrompt(request);
		const runner = caseCapture()?.cornellNote(this.stageRunner, {
			...request, document: { id: document.id, title: document.title, url: document.url, provider: document.providerId },
		}, this.skills) ?? this.stageRunner;
		const result = await runner.runStage<CornellNote>({
			runId: input.runId,
			stageId: `cornell-note-${segment}`,
			attemptId: `attempt-${randomUUID().slice(0, 8)}`,
			attempt: 1,
			role: "cornell_note",
			// 一次 Source batch 的所有 Note 是同一次逻辑扇出，并发上限只决定它们分几波起跑。
			parallelGroup: `sequence-${input.sequence}`,
			promptConfig: {
				domain: "research",
				id: "cornell-note",
				sandboxRole: "report.cornell_note",
				revisions: { system: systemPrompt.revision, user: userPrompt.revision },
			},
			session: { key: `cornell-note/${document.id}`, policy: "fresh" },
			modelPolicy: {
				preferred: [this.config.cornellNoteModel],
				reasoning: this.config.cornellNoteThinkingLevel,
			},
			systemPrompt: systemPrompt.content,
			userPrompt: userPrompt.content,
			executionProfile: "prime_ipython",
			workDirectory: workRoot,
			readonlyMounts: [
				{ hostPath: sourceDirectory, guestPath: "/source", access: "read-only" },
				...this.skills.map((skill, skillIndex) => ({
					hostPath: skill.hostPath,
					guestPath: `/skills/${String(skillIndex + 1).padStart(3, "0")}-${safeName(skill.workspaceRelativePath, { maxLength: 100, fallback: "source" })}`,
					access: "read-only" as const,
				})),
			],
			sandbox: {
				env: {
					TELOMI_SKILL_PYTHONPATH: this.skills.flatMap((skill) => skill.pythonPaths).join(":"),
					TELOMI_DISCOVERY_ENABLED: String(input.discoveryEnabled),
				},
			},
			controlDirectory: input.controlDir,
			artifactStore,
			output: {
				kind: "cornell_note",
				entryRelativePath: "cornell-note.json",
				publishRelativePath: cornellNoteArtifactPath(input.sequence, document.id, document.revisionSha256),
				validate: ({ entryPath }) => {
					const note = validateCornellNote(
						parseCornellNoteJson(entryPath),
						document.id,
						sourceFiles,
						input.topicPlan,
						input.discoveryEnabled,
					);
					writeFileSync(entryPath, `${JSON.stringify(note, null, 2)}\n`);
					return note;
				},
			},
			signal: input.signal,
		});
		input.onAgentStageCompleted?.(result.usage);
		return { source: document, note: result.value, artifactRef: result.artifact.relativePath };
	}
}

export function validateCornellNote(
	value: unknown,
	expectedSourceId: string,
	sourceFiles: readonly SourceFileRecord[],
	topicPlan?: GoalTopicPlan,
	discoveryEnabled = false,
): CornellNote {
	const record = requireRecord(value, "Cornell Note");
	assertExactKeys(record, ["sections"], "Cornell Note");
	if (!Array.isArray(record.sections)) {
		throw new Error("Cornell Note.sections must be an array");
	}
	const files = new Map(sourceFiles.map((file) => [file.relativePath, file]));
	return {
		schema_version: 1,
		source_id: expectedSourceId,
		sections: record.sections.map((candidate, sectionIndex) => {
			const sectionLabel = `sections[${sectionIndex}]`;
			const section = requireRecord(candidate, sectionLabel);
			assertExactKeys(section, ["section_title", "summary", "cue_notes"], sectionLabel);
			if (!Array.isArray(section.cue_notes) || section.cue_notes.length === 0) {
				throw new Error(`${sectionLabel}.cue_notes must be a non-empty array`);
			}
			return {
				section_title: nonEmpty(section.section_title, `${sectionLabel}.section_title`),
				summary: nonEmpty(section.summary, `${sectionLabel}.summary`),
				cue_notes: section.cue_notes.map((candidateNote, noteIndex) => {
					const noteLabel = `${sectionLabel}.cue_notes[${noteIndex}]`;
					const note = requireRecord(candidateNote, noteLabel);
					const expected = ["cue", "note", "evidence"];
					if (topicPlan) expected.push("topic_refs");
					if (discoveryEnabled) expected.push("discovery");
					assertExactKeys(note, expected, noteLabel);
					if (!Array.isArray(note.evidence) || note.evidence.length === 0) {
						throw new Error(`${noteLabel}.evidence must be a non-empty array`);
					}
					return {
						cue: nonEmpty(note.cue, `${noteLabel}.cue`),
						note: nonEmpty(note.note, `${noteLabel}.note`),
						...validateCueTopics(note, topicPlan, discoveryEnabled, noteLabel),
						evidence: note.evidence.map((candidateEvidence, evidenceIndex) => validateEvidence(
							candidateEvidence,
							files,
							`${noteLabel}.evidence[${evidenceIndex}]`,
						)),
					};
				}),
			};
		}),
	};
}

function validateEvidence(
	value: unknown,
	files: ReadonlyMap<string, SourceFileRecord>,
	label: string,
): CornellEvidence {
	const evidence = requireRecord(value, label);
	assertExactKeys(evidence, ["source_path", "start_line", "end_line"], label, ["content_sha256"]);
	const requestedPath = nonEmpty(evidence.source_path, `${label} source_path`);
	const [sourcePath, file] = resolveSourceFile(requestedPath, files, label);
	const startLine = integer(evidence.start_line, `${label} start_line`);
	const endLine = integer(evidence.end_line, `${label} end_line`);
	const lines = readTextLines(file.absolutePath, label);
	if (startLine < 1 || endLine < startLine || endLine > lines.length) {
		throw new Error(`${label} line range ${startLine}-${endLine} is invalid; '${sourcePath}' has ${lines.length} lines`);
	}
	const contentSha256 = sha256(`${lines.slice(startLine - 1, endLine).join("\n")}\n`);
	if (evidence.content_sha256 !== undefined && evidence.content_sha256 !== contentSha256) {
		throw new Error(`${label} content_sha256 does not match the cited lines`);
	}
	return { source_path: sourcePath, start_line: startLine, end_line: endLine, content_sha256: contentSha256 };
}

function resolveSourceFile(
	requestedPath: string,
	files: ReadonlyMap<string, SourceFileRecord>,
	label: string,
): [string, SourceFileRecord] {
	const normalized = requestedPath.replaceAll("\\", "/").replace(/^\.\//u, "");
	if (normalized.split("/").includes("..")) throw new Error(`${label} source_path escapes the Source root`);
	for (const candidate of [normalized, normalized.startsWith("source/") ? normalized.slice(7) : normalized]) {
		const file = files.get(candidate);
		if (file) return [candidate, file];
	}
	const foldedCandidates = new Set([
		normalized,
		normalized.startsWith("source/") ? normalized.slice(7) : normalized,
	].map((candidate) => candidate.toLocaleLowerCase()));
	const caseMatches = [...files].filter(([path]) => foldedCandidates.has(path.toLocaleLowerCase()));
	if (caseMatches.length === 1) return caseMatches[0]!;
	const suffixMatches = [...files].filter(([path]) => normalized.endsWith(`/${path}`));
	if (suffixMatches.length === 1) return suffixMatches[0]!;
	const foldedSuffixMatches = [...files].filter(([path]) => normalized.toLocaleLowerCase().endsWith(`/${path.toLocaleLowerCase()}`));
	if (foldedSuffixMatches.length === 1) return foldedSuffixMatches[0]!;
	const ambiguous = caseMatches.length > 1 || suffixMatches.length > 1 || foldedSuffixMatches.length > 1;
	throw new Error(`${label} references ${ambiguous ? "an ambiguous" : "an undeclared"} Source file '${requestedPath}'`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string, optional: string[] = []): void {
	const keys = Object.keys(value);
	const missing = expected.filter((key) => !keys.includes(key));
	const unexpected = keys.filter((key) => !expected.includes(key) && !optional.includes(key));
	if (missing.length || unexpected.length) {
		const details = [
			...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
			...(unexpected.length ? [`unexpected: ${unexpected.join(", ")}`] : []),
		].join("; ");
		throw new Error(optional.length
			? `${label} must contain ${expected.join(", ")} and optional ${optional.join(", ")}; ${details}`
			: `${label} must contain exactly ${expected.join(", ")}; ${details}`);
	}
}

function validateCueTopics(
	note: Record<string, unknown>,
	plan: GoalTopicPlan | undefined,
	discoveryEnabled: boolean,
	label: string,
): Pick<CornellNote["sections"][number]["cue_notes"][number], "topic_refs" | "discovery"> {
	const topicRefs = plan ? validateTopicRefs(note.topic_refs, plan, label) : undefined;
	if (!discoveryEnabled) return topicRefs ? { topic_refs: topicRefs } : {};
	const discovery = requireRecord(note.discovery, `${label} discovery`);
	assertExactKeys(discovery, ["finding"], `${label} discovery`);
	if (typeof discovery.finding !== "string") throw new Error(`${label} discovery finding must be a string`);
	const finding = discovery.finding.trim();
	return {
		...(topicRefs ? { topic_refs: topicRefs } : {}),
		...(finding ? { discovery: { finding } } : {}),
	};
}

function validateTopicRefs(value: unknown, plan: GoalTopicPlan, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label}.topic_refs must be an array`);
	const references = goalTopicReferences(plan);
	const known = new Map(references.map(({ ref, topic }) => [ref, topic]));
	const refs = value.map((ref, index) => nonEmpty(ref, `${label}.topic_refs[${index}]`));
	const duplicate = refs.find((ref, index) => refs.indexOf(ref) !== index);
	if (duplicate) throw new Error(`${label}.topic_refs contains duplicate reference '${duplicate}'`);
	const unknownIndex = refs.findIndex((ref) => !known.has(ref));
	if (unknownIndex >= 0) {
		throw new Error(`${label}.topic_refs[${unknownIndex}] contains unknown Goal Topic reference '${refs[unknownIndex]}'; allowed references: ${references.map(({ ref, topic }) => `${ref} (${topic.title})`).join(", ")}`);
	}
	return refs.map((ref) => known.get(ref)!.id);
}

function parseCornellNoteJson(path: string): unknown {
	if (!existsSync(path)) throw new Error("cornell-note.json is missing; create the complete fixed output file");
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch (error) {
		throw new Error(`cornell-note.json must be valid JSON: ${toErrorMessage(error)}`);
	}
}

function nonEmpty(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function integer(value: unknown, label: string): number {
	if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
	return value as number;
}

function readTextLines(path: string, label: string): string[] {
	const content = readFileSync(path);
	if (!isReadableTextContent(content)) throw new Error(`${label} must cite a text Source file`);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(content).replace(/\r\n?/gu, "\n").split("\n");
	} catch {
		throw new Error(`${label} must cite a UTF-8 Source file`);
	}
}

