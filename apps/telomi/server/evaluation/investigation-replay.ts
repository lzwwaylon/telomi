import { writeTaskContext } from "../research/task-context.js";
import { validateInvestigationResult, type InvestigationResult } from "../citations/contracts.js";
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type { AgentStageRequest, ValidatedStageArtifact } from "../agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { beginNodeEvaluationCase, finishNodeEvaluationCase, readNodeEvaluationFile,
	type NodeEvaluationInteraction, type NodeReplayRecipe } from "../agent-runtime/node-evaluation.js";
import type { ThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { resolvePrimeModel, pinTaskModelSelection } from "../agent-runtime/model-policy.js";
import { primeAgentModulePath } from "../agent-runtime/prime-agent-paths.js";
import { materializeSkills, snapshotSkills } from "../agent-runtime/skill-registry.js";
import { sha256 } from "../lib/hash.js";
import { isRecord, toErrorMessage } from "../lib/values.js";
import { recordCaseCaptureFailure } from "../observability/case-capture.js";

import { createInvestigationCitationScope, type InvestigationCitationCue } from "../research/investigation-citations.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { runPrime, startPrimeSourceBridge } from "../research/pipeline/prime-search-batch.js";
import { ResearchSourceRegistry } from "../research/sources/registry.js";
import { resolveOutputLanguage } from "../../shared/languages.js";
import { executeInvestigationAnswer, writeInvestigationAnswerInput,
	type InvestigationAnswer, type InvestigationAnswerEvidence } from "../research/investigation-answer.js";
import { readLatestInvestigationWriter } from "../research/investigation-handoff.js";

export const INVESTIGATION_RECIPE = { id: "prime-investigation", version: 1 } as const;
const WIKI_OPERATIONS = ["wiki_list_topics", "wiki_search", "wiki_read_page"] as const;
type InvestigationOperation = "knowledge_search" | "read_sources" | "github_read" | "external_search" | "write_answer" | typeof WIKI_OPERATIONS[number];

interface InvestigationCaptureInput {
	goalDir: string;
	goalId: string;
	runDir: string;
	question: string;
	context?: string;
	language?: string;
	allowExternal?: boolean;
	handoffMode?: "file" | "inline";
	threadId?: string;
	wikiSha256: string;
	model: string;
	thinking: ThinkingLevel;
	/** Native Prime usage is filled by the execute closure, after runPrime settles. */
	metrics?: { usage?: ResearchModelUsage; toolCalls?: number };
	execute: () => Promise<InvestigationResult>;
	candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
}

/** Capture surrounds the validated product result, so a missing result is a Recovery Case. */
export async function withInvestigationNodeCapture(input: InvestigationCaptureInput): Promise<InvestigationResult> {
	const candidateEvidence = input.candidateCase !== undefined;
	const report = (error: unknown): void => {
		if (candidateEvidence) throw error instanceof Error ? error : new Error(String(error));
		recordCaseCaptureFailure("prime-investigation", error);
	};
	let draft: ReturnType<typeof beginNodeEvaluationCase>;
	try {
		const inputDir = join(input.runDir, "input");
		mkdirSync(inputDir, { recursive: true });
		const prompt = readFileSync(join(input.runDir, "prompt.md"), "utf-8");
		const captured = {
			schema_version: 1,
			goal_id: input.goalId,
			question: input.question,
			context: input.context ?? "",
			language: input.language ?? resolveOutputLanguage("auto", input.question),
			allow_external: input.allowExternal !== false,
			...(input.handoffMode ? { handoff_mode: input.handoffMode } : {}),
			...(input.threadId ? { thread_id: input.threadId } : {}),
			wiki_sha256: input.wikiSha256,
			model: input.model,
			thinking: input.thinking,
			prompt_sha256: sha256(prompt),
		};
		writeFileSync(join(inputDir, "request.json"), `${JSON.stringify(captured, null, 2)}\n`);
		const stage: AgentStageRequest<unknown> = {
			runId: input.candidateCase?.sourceRunId ?? basename(input.runDir),
			stageId: "prime-investigation",
			attemptId: "attempt-1",
			role: "prime_search",
			promptConfig: { domain: "research", id: "prime-search", sandboxRole: "research.prime_search", userVariant: "investigate" } as never,
			recordKind: "research",
			evaluation: {
				agentId: "prime-investigation",
				recipe: INVESTIGATION_RECIPE,
				recipeInput: { goalId: input.goalId, question: input.question, wikiSha256: input.wikiSha256 },
				inputRelativePath: "input",
				harnessMounts: [],
				liveExternalState: false,
			},
			session: { key: "prime-investigation", policy: "fresh" },
			modelPolicy: { preferred: [input.model], reasoning: input.thinking },
			systemPrompt: "",
			userPrompt: prompt,
			workDirectory: join(input.runDir, "workspace"),
			readonlyMounts: [],
			controlDirectory: input.runDir,
			recordDirectory: input.runDir,
			artifactStore: new RunArtifactStore(input.runDir),
			output: { kind: "json_candidate", publishRelativePath: "artifacts/node-evaluation/investigation-result.json", validate: () => ({}) },
			signal: new AbortController().signal,
		};
		draft = beginNodeEvaluationCase({
			request: stage,
			recordDirectory: input.runDir,
			promptConfig: stage.promptConfig!,
			sessionContextFile: join(input.runDir, ".missing-session"),
			composedSystemPrompt: "",
			actualModel: input.model,
			...(input.candidateCase ? { capabilitySnapshotId: input.candidateCase.capabilitySnapshotId } : {}),
		});
	} catch (error) {
		report(error);
	}
	if (!draft) {
		if (candidateEvidence) report("Prime Investigation Case draft was not created");
		return input.execute();
	}
	const startedAt = Date.now();
	let result: InvestigationResult;
	try {
		result = await input.execute();
	} catch (error) {
		const capture = finishNodeEvaluationCase(draft, {
			status: "failed",
			workDirectory: join(input.runDir, "workspace"),
			sessionPath: join(input.runDir, "trace.jsonl"),
			validationErrors: [],
			error: toErrorMessage(error),
			interactions: readInvestigationInteractions(input.runDir),
			traceDirectories: nativeSessionDirectories(input.runDir),
			durationMs: Date.now() - startedAt,
		});
		if (capture.status === "capture_failed") report(capture.reason);
		throw error;
	}
	try {
		if (!input.metrics?.usage || input.metrics.toolCalls === undefined) {
			throw new Error("Prime Investigation native usage is missing from Case Capture");
		}
		const outputDir = join(input.runDir, "investigation-output");
		mkdirSync(outputDir, { recursive: true });
		writeFileSync(join(outputDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
		const citationsPath = join(input.runDir, "citations.json");
		if (existsSync(citationsPath)) copyFileSync(citationsPath, join(outputDir, "citations.json"));
		else writeFileSync(join(outputDir, "citations.json"), '{"schema_version":1,"citations":[]}\n');
		const store = new RunArtifactStore(input.runDir);
		const artifact = store.publishDirectory(outputDir,
			"artifacts/node-evaluation/investigation-output", outputDir);
		const stageResult: ValidatedStageArtifact<unknown> = {
			value: result, artifact, submissionCount: 1, validationErrors: [],
			session: { id: "prime-investigation", mode: "fresh" },
			turns: input.metrics.usage.calls, toolCalls: input.metrics.toolCalls, toolCounts: {},
			usage: input.metrics.usage,
			sessionPath: join(input.runDir, "trace.jsonl"),
		};
		const capture = finishNodeEvaluationCase(draft, {
			status: "succeeded",
			workDirectory: join(input.runDir, "workspace"),
			result: stageResult,
			validationErrors: [],
			interactions: readInvestigationInteractions(input.runDir),
			traceDirectories: nativeSessionDirectories(input.runDir),
			durationMs: Date.now() - startedAt,
		});
		if (capture.status === "capture_failed") report(capture.reason);
	} catch (error) {
		report(error);
	}
	return result;
}

function readInvestigationInteractions(runDir: string): NodeEvaluationInteraction[] {
	const path = join(runDir, "interactions.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line): NodeEvaluationInteraction => {
		const row = JSON.parse(line) as { operation: string; request: unknown; response: unknown };
		if (row.operation !== "knowledge_search" && row.operation !== "read_sources" && row.operation !== "github_read" && row.operation !== "external_search" && row.operation !== "write_answer" && !(WIKI_OPERATIONS as readonly string[]).includes(row.operation)) {
			throw new Error("Unknown Prime investigation interaction");
		}
		return { kind: "tool", name: row.operation, label: row.operation, description: "Frozen investigation Tool result",
			arguments: row.request, result: row.response };
	});
}

function nativeSessionDirectories(runDir: string): string[] {
	const root = join(runDir, "runtime", "session");
	return existsSync(root) && readdirSync(root).length ? [root] : [];
}

interface FrozenInvestigationRequest {
	schema_version: 1;
	goal_id: string;
	question: string;
	context?: string;
	language?: string;
	allow_external?: boolean;
	handoff_mode?: "file" | "inline";
	thread_id?: string;
	wiki_sha256: string;
	model: string;
	thinking: ThinkingLevel;
	prompt_sha256: string;
}

export function createInvestigationReplayRecipe(options: {
	execute?: NodeReplayRecipe["replay"];
} = {}): NodeReplayRecipe {
	return {
		identity: INVESTIGATION_RECIPE,
		async replay(input) {
			if (input.value.agentId !== "prime-investigation") {
				throw new Error(`Node Case belongs to Agent '${input.value.agentId}'`);
			}
			return (options.execute ?? executeProductionInvestigationReplay)(input);
		},
	};
}

export const investigationReplayRecipe = createInvestigationReplayRecipe();

/** Normalize file handoffs and historical inline outputs without changing the frozen Writer result. */
export function resolveInvestigationReplayResult(input: {
	workspace: string; value: unknown; lastAnswer?: InvestigationAnswer;
	id: string; question: string; wikiSha256: string;
}): InvestigationResult {
	let value = input.value;
	if (isRecord(value) && "answer_ref" in value) {
		if (Object.keys(value).length !== 1) throw new Error("Prime investigation result must contain only answer_ref");
		const answer = readLatestInvestigationWriter(input.workspace, value.answer_ref);
		if (!isRecord(answer)) throw new Error("Invalid Writer handoff result");
		value = { answer: answer.answer, citation_refs: answer.citation_refs, gaps: answer.gaps };
	}
	if (!isRecord(value)) throw new Error("Invalid Prime investigation result");
	const authored = validateInvestigationResult({ ...value, id: input.id,
		question: input.question, wiki_sha256: input.wikiSha256 }, input.id, input.question);
	if (!input.lastAnswer || authored.answer !== input.lastAnswer.answer
		|| JSON.stringify(authored.citation_refs) !== JSON.stringify(input.lastAnswer.citation_refs)
		|| JSON.stringify(authored.gaps) !== JSON.stringify(input.lastAnswer.gaps)) {
		throw new Error("Prime must deliver the delegated Writer's answer without rewriting it");
	}
	return authored;
}

/** Frozen Tool replay never contacts Providers; newly acquired evidence comes from the observed response. */
export function createFrozenInvestigationReplayPlan(
	frozen: readonly Extract<NodeEvaluationInteraction, { kind: "tool" }>[],
	initialCues: readonly InvestigationCitationCue[] = [],
) {
	if (!frozen.some((interaction) => interaction.name === "write_answer")) {
		throw new Error("Candidate Prime Investigation requires a captured Writer assignment; use promptMode 'observed' for the historical excerpt-only Writer fallback");
	}
	const scope = createInvestigationCitationScope();
	scope.projectCues(initialCues);
	const steps = frozen.map((interaction, index) => {
		let args = interaction.arguments;
		if (interaction.name === "write_answer") {
			if (!isRecord(args) || !Array.isArray(args.evidence_refs) || !args.evidence_refs.every((ref) => typeof ref === "string")
				|| !Array.isArray(args.requirements) || !args.requirements.every((requirement) => typeof requirement === "string")) {
				throw new Error("Frozen Writer Replay plan requires captured evidence refs and requirements");
			}
			args = { evidence_refs: args.evidence_refs.map((ref) => scope.project(ref)), requirements: [...args.requirements] };
		} else {
			const response = interaction.result as {
				cues?: InvestigationCitationCue[]; reading?: { cues?: InvestigationCitationCue[] };
				pages?: Array<{ evidence?: Array<{ cite_ref?: string }> }>;
				evidence?: Array<{ cite_ref?: string }>;
			};
			if (interaction.name === "wiki_read_page") for (const entry of response.evidence ?? []) {
				if (entry.cite_ref) scope.allowWikiRef(entry.cite_ref);
			}
			for (const page of response.pages ?? []) for (const evidence of page.evidence ?? []) {
				if (evidence.cite_ref) scope.allowWikiRef(evidence.cite_ref);
			}
			scope.projectCues(response.cues ?? response.reading?.cues ?? []);
		}
		return { step: index + 1, operation: interaction.name, arguments: args };
	});
	return { schema_version: 1, mode: "frozen-coordination", steps };
}

/** Keep the referenced plan in Case inputs so observed Replay can restore the captured file. */
export function stageFrozenInvestigationReplayPlan(
	caseInputDirectory: string,
	recordDirectory: string,
	plan?: ReturnType<typeof createFrozenInvestigationReplayPlan>,
): void {
	const capturedPath = join(caseInputDirectory, "replay-plan.json");
	if (!plan && !existsSync(capturedPath)) return;
	const workspacePath = join(recordDirectory, "workspace", "inputs", "replay-plan.json");
	mkdirSync(dirname(workspacePath), { recursive: true });
	if (plan) writeFileSync(workspacePath, `${JSON.stringify(plan, null, 2)}\n`);
	else copyFileSync(capturedPath, workspacePath);
	mkdirSync(join(recordDirectory, "input"), { recursive: true });
	copyFileSync(workspacePath, join(recordDirectory, "input", "replay-plan.json"));
}

export function createFrozenInvestigationTools(
	frozen: readonly Extract<NodeEvaluationInteraction, { kind: "tool" }>[],
	allowExternal: boolean,
	recordInteraction: (operation: string, request: unknown, response: unknown) => void,
	initialCues: readonly InvestigationCitationCue[] = [],
) {
	let unmatchedInteraction: Error | undefined;
	let nextInteraction = 0;
	const citationsScope = createInvestigationCitationScope();
	const evidence = new Map<string, InvestigationAnswerEvidence>();
	const registerCues = (cues: readonly InvestigationCitationCue[]) => {
		for (const cue of cues) {
			const projected = citationsScope.projectCues([cue])[0]!;
			evidence.set(projected.ref, { ref: projected.ref, section_title: cue.section_title, cue: cue.cue, note: cue.note,
				evidence: projected.evidence.filter((anchor): anchor is typeof anchor & { excerpt: string } => typeof anchor.excerpt === "string") });
		}
	};
	registerCues(initialCues);
	const replayCall = (name: InvestigationOperation, request: unknown): unknown => {
		if ((name === "external_search" || name === "github_read") && !allowExternal) {
			unmatchedInteraction = new Error("This Case disallows external sources");
			throw unmatchedInteraction;
		}
		const observed = frozen[nextInteraction];
		if (!observed || observed.name !== name) {
			unmatchedInteraction = new Error(`No frozen Tool interaction matches '${name}' at step ${nextInteraction + 1}`);
			throw unmatchedInteraction;
		}
		if ((WIKI_OPERATIONS as readonly string[]).includes(name)) {
			if (!isDeepStrictEqual(request, observed.arguments)) {
				unmatchedInteraction = new Error("Frozen Wiki result belongs to different arguments or Topic filter");
				throw unmatchedInteraction;
			}
			nextInteraction++;
			recordInteraction(name, request, observed.result);
			if (name === "wiki_read_page") {
				const page = observed.result as { evidence?: Array<{ cite_ref?: string; section?: string; cue?: string; note?: string;
					anchors?: Array<{ path: string; startLine: number; endLine: number; content?: string }> }> };
				for (const entry of page.evidence ?? []) {
					if (!entry.cite_ref) continue;
					citationsScope.allowWikiRef(entry.cite_ref);
					if (entry.cue && entry.note) evidence.set(entry.cite_ref, { ref: entry.cite_ref,
						section_title: entry.section ?? "Saved Wiki", cue: entry.cue, note: entry.note,
						evidence: (entry.anchors ?? []).flatMap(anchor => typeof anchor.content === "string" ? [{
							source_path: anchor.path, start_line: anchor.startLine, end_line: anchor.endLine, excerpt: anchor.content,
						}] : []) });
				}
			}
			return observed.result;
		}
		if (name === "write_answer") {
			const args = request as { evidence_refs: string[]; requirements: string[] };
			const expected = observed.arguments as { evidence_refs: string[]; requirements: string[] };
			if (JSON.stringify(args.evidence_refs.map((ref) => citationsScope.resolve(ref)).sort())
				!== JSON.stringify([...expected.evidence_refs].sort()) || JSON.stringify(args.requirements) !== JSON.stringify(expected.requirements)) {
				unmatchedInteraction = new Error("Frozen Writer answer belongs to different evidence or requirements");
				throw unmatchedInteraction;
			}
			nextInteraction++;
			const answer = observed.result as InvestigationAnswer;
			const projected = { ...answer,
				answer: answer.answer.replace(/<cite>([^<>\s]+)<\/cite>/gu, (_tag, ref: string) => `<cite>${citationsScope.project(ref)}</cite>`),
				citation_refs: answer.citation_refs.map((ref) => citationsScope.project(ref)),
				coverage: answer.coverage.map((row) => ({ ...row, citation_refs: row.citation_refs.map((ref) => citationsScope.project(ref)) })) };
			recordInteraction(name, observed.arguments, answer);
			return projected;
		}
		if (name === "github_read") {
			const identity = (value: unknown): string => {
				const item = value as { repository?: unknown; ref?: unknown; paths?: unknown };
				return typeof item?.repository === "string" && typeof item.ref === "string" && Array.isArray(item.paths)
					&& item.paths.every((path) => typeof path === "string")
					? JSON.stringify([item.repository.toLowerCase(), item.ref, [...item.paths].sort()]) : "";
			};
			if (!identity(request) || identity(request) !== identity(observed.arguments)) {
				unmatchedInteraction = new Error("Frozen GitHub reading belongs to another repository, ref, or file set");
				throw unmatchedInteraction;
			}
		}
		nextInteraction++;
		// The user's question and frozen evidence are fixed; Prime may word its Tool query differently on replay.
		const response = observed.result as {
			cues?: InvestigationCitationCue[];
			pages?: Array<{ evidence?: Array<{ cite_ref?: string }> }>;
			reading?: { cues?: InvestigationCitationCue[] };
			sources?: Array<{ title: string; url: string }>;
		};
		recordInteraction(name, request, response);
		for (const page of response.pages ?? []) for (const evidence of page.evidence ?? []) {
			if (evidence.cite_ref) citationsScope.allowWikiRef(evidence.cite_ref);
		}
		const cueBodies = response.cues ?? response.reading?.cues ?? [];
		registerCues(cueBodies);
		for (const page of response.pages ?? []) for (const raw of page.evidence ?? []) {
			const item = raw as { cite_ref?: string; cue?: string; note?: string };
			if (item.cite_ref && item.cue && item.note) evidence.set(item.cite_ref, {
				ref: item.cite_ref, section_title: "Saved Wiki", cue: item.cue, note: item.note, evidence: [],
			});
		}
		const projected = response.cues ? { ...response, cues: citationsScope.projectCues(response.cues) }
			: response.reading?.cues ? { ...response,
				reading: { ...response.reading, cues: citationsScope.projectCues(response.reading.cues) } } : response;
		return (name === "github_read" || name === "external_search") && response.sources
			? { ...projected, sources: response.sources.map(({ title, url }) => ({ title, url })) }
			: projected;
	};
	return { replayCall, citationsScope, evidence,
		hasFrozenWriter: () => frozen[nextInteraction]?.name === "write_answer",
		assertMatched() {
			if (unmatchedInteraction) throw unmatchedInteraction;
			if (nextInteraction !== frozen.length) throw new Error("Prime left frozen Tool interactions unused");
		} };
}

async function executeProductionInvestigationReplay(
	input: Parameters<NodeReplayRecipe["replay"]>[0],
): ReturnType<NodeReplayRecipe["replay"]> {
	if (input.promptOverride?.systemPrompt) throw new Error("Prime Investigation replay does not accept systemPrompt override");
	const caseDir = dirname(input.casePath);
	const captured = JSON.parse(readFileSync(join(caseDir, "input", "request.json"), "utf-8")) as FrozenInvestigationRequest;
	const historicalPrompt = readNodeEvaluationFile(input.casePath, input.value.request.userPrompt);
	if (captured.schema_version !== 1 || !captured.question || !captured.goal_id
		|| (captured.thread_id !== undefined && !/^[a-f0-9]{24}$/u.test(captured.thread_id))
		|| (captured.handoff_mode !== undefined && captured.handoff_mode !== "file" && captured.handoff_mode !== "inline")
		|| !/^[a-f0-9]{64}$/u.test(captured.wiki_sha256)
		|| !/^[a-f0-9]{64}$/u.test(captured.prompt_sha256)
		|| sha256(historicalPrompt) !== captured.prompt_sha256) {
		throw new Error("Prime Investigation Case request is invalid");
	}
	const interactions = input.value.request.interactions
		? JSON.parse(readNodeEvaluationFile(input.casePath, input.value.request.interactions)) as NodeEvaluationInteraction[]
		: [];
	const frozen = interactions.filter((item): item is Extract<NodeEvaluationInteraction, { kind: "tool" }> => item.kind === "tool"
		&& (item.name === "knowledge_search" || item.name === "read_sources" || item.name === "github_read" || item.name === "external_search" || item.name === "write_answer" || (WIKI_OPERATIONS as readonly string[]).includes(item.name)));
	const prompt = input.promptOverride?.userPrompt ?? historicalPrompt;
	const responseMode = captured.handoff_mode === "file" || input.promptMode === "candidate"
		|| (input.promptMode !== "observed" && input.promptOverride?.userPrompt !== undefined) ? "file" : "inline";
	const env = pinTaskModelSelection(["primeRoot"], {
		...process.env, TELOMI_PRIME_AGENT_ROOT_MODEL: captured.model,
	});
	const root = join(input.recordDirectory, "workspace");
	const sdkRoot = join(input.recordDirectory, "sdk");
	const skillRoot = join(root, "skills", "root-agent");
	mkdirSync(join(root, "work"), { recursive: true });
	mkdirSync(join(root, "inputs"), { recursive: true });
	writeTaskContext(join(root, "inputs"), captured.context ?? "");
	writeFileSync(join(root, "inputs", "request.json"), `${JSON.stringify({ schema_version: 1,
		question: captured.question, context_ref: "inputs/context.md",
		...(input.promptMode === "candidate" ? {} : { context: captured.context ?? "" }),
		language: captured.language ?? resolveOutputLanguage("auto", captured.question),
		external_allowed: captured.allow_external !== false,
		...(captured.thread_id ? { thread_id: captured.thread_id, thread_ref: "inputs/thread.json",
			previous_evidence_ref: "inputs/thread-evidence.json" } : {}) }, null, 2)}\n`);
	mkdirSync(sdkRoot, { recursive: true });
	cpSync(join(caseDir, "input"), join(input.recordDirectory, "input"), { recursive: true });
	const capturedCitations = input.value.observed.output?.directory
		? join(caseDir, input.value.observed.output.ref, "citations.json") : "";
	if (capturedCitations && existsSync(capturedCitations)) {
		copyFileSync(capturedCitations, join(input.recordDirectory, "citations.json"));
	}
	writeFileSync(join(input.recordDirectory, "prompt.md"), prompt);
	cpSync(fileURLToPath(new URL("../research/python-tools/research_runtime.py", import.meta.url)),
		join(sdkRoot, "research_runtime.py"));
	const skillSource = fileURLToPath(new URL("../../agents/research/prime-search/skills/note-investigation", import.meta.url));
	const skills = [...materializeSkills(snapshotSkills([skillSource]), skillRoot).values()];
	const signal = input.signal;
	let initialEvidence: { cues: InvestigationCitationCue[]; recovery_gaps: string[] } = { cues: [], recovery_gaps: [] };
	if (captured.thread_id) {
		const sourceStore = new RunArtifactStore(input.sourceRunDirectory);
		const capturedInput = sourceStore.openDirectory({ relative_path: input.value.input.ref,
			sha256: input.value.input.sha256, byte_length: input.value.input.byteLength });
		for (const file of capturedInput.files.filter((file) => file.relativePath === "thread.json" || file.relativePath.startsWith("history/"))) {
			const artifact = sourceStore.openFile({ relative_path: `${input.value.input.ref}/${file.relativePath}`,
				sha256: file.sha256, byte_length: file.byteLength });
			mkdirSync(dirname(join(root, "inputs", file.relativePath)), { recursive: true });
			copyFileSync(artifact.absolutePath, join(root, "inputs", file.relativePath));
		}
		const evidenceFile = capturedInput.files.find((file) => file.relativePath === "thread-evidence.json");
		if (!evidenceFile) throw new Error("Continued investigation Case is missing its frozen thread evidence");
		const artifact = sourceStore.openFile({ relative_path: `${input.value.input.ref}/thread-evidence.json`,
			sha256: evidenceFile.sha256, byte_length: evidenceFile.byteLength });
		initialEvidence = sourceStore.readJson(artifact);
		if (!Array.isArray(initialEvidence.cues) || !Array.isArray(initialEvidence.recovery_gaps)) {
			throw new Error("Invalid frozen thread evidence");
		}
	}
	stageFrozenInvestigationReplayPlan(join(caseDir, "input"), input.recordDirectory,
		input.promptMode === "candidate" ? createFrozenInvestigationReplayPlan(frozen, initialEvidence.cues) : undefined);
	const { replayCall, citationsScope, evidence, hasFrozenWriter, assertMatched } = createFrozenInvestigationTools(
		frozen, captured.allow_external !== false, (operation, request, response) => {
			appendFileSync(join(input.recordDirectory, "interactions.jsonl"), `${JSON.stringify({ operation, request, response })}\n`);
		}, initialEvidence.cues,
	);
	if (captured.thread_id) writeFileSync(join(root, "inputs", "thread-evidence.json"), `${JSON.stringify({
		schema_version: 1, cues: citationsScope.projectCues(initialEvidence.cues), recovery_gaps: initialEvidence.recovery_gaps }, null, 2)}\n`);
	let writerCount = 0;
	const writerState: { lastAnswer?: InvestigationAnswer } = {};
	const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(), new Set(), {
		workspaceDirectory: root,
		temporalContext: { schemaVersion: 1, currentDate: "1970-01-01", timeZone: "UTC" },
		signal,
	}, root, { runDir: input.recordDirectory, nodeId: "prime-investigation", attemptId: "attempt-1" }, {
		investigation: {
			responseMode,
			wikiTool: async (operation, args) => replayCall(operation as typeof WIKI_OPERATIONS[number], args),
			knowledgeSearch: async (query, limit) => replayCall("knowledge_search", { query, limit }),
			readSources: async (question) => replayCall("read_sources", { question }),
			externalSearch: async (question) => replayCall("external_search", { question }),
			githubRead: async (question, repository, ref, paths) => {
				return replayCall("github_read", { question, repository, ref, paths });
			},
			writeAnswer: async (refs, requirements) => {
				if (hasFrozenWriter()) {
					writerState.lastAnswer = replayCall("write_answer", { evidence_refs: refs, requirements }) as InvestigationAnswer;
					return writerState.lastAnswer;
				}
				const assigned = refs.map((ref) => {
					const item = evidence.get(ref);
					if (!item) throw new Error(`No frozen answer evidence '${ref}'`);
					return item;
				});
				const writerDirectory = join(input.recordDirectory, `answer-${++writerCount}`);
				const inputRoot = join(writerDirectory, "input");
				// Older Root Cases captured excerpts, not full Sources. Preserve that scope instead of reading a live Goal.
				writeInvestigationAnswerInput({ inputRoot, evidence: assigned,
					request: { schema_version: 1, question: captured.question, context: captured.context ?? "",
						language: captured.language ?? resolveOutputLanguage("auto", captured.question), evidence_refs: refs,
						requirements: requirements.map((part, index) => ({ id: `Q${index + 1}`, question: part })) } });
				writerState.lastAnswer = await executeInvestigationAnswer({ inputRoot, recordDirectory: input.recordDirectory,
					goalDir: input.harnessWorkspaceDirectory, invocationId: `frozen-answer-${writerCount}`, env, signal,
					modelPolicy: { preferred: [captured.model], reasoning: captured.thinking } });
				const restored = citationsScope.restore(writerState.lastAnswer);
				appendFileSync(join(input.recordDirectory, "interactions.jsonl"), `${JSON.stringify({ operation: "write_answer",
					request: { evidence_refs: refs.map((ref) => citationsScope.resolve(ref)), requirements },
					response: { ...restored, coverage: writerState.lastAnswer.coverage.map((row) => ({ ...row,
						citation_refs: row.citation_refs.map((ref) => citationsScope.resolve(ref)) })) } })}\n`);
				return writerState.lastAnswer;
			},
		},
	});
	let result: InvestigationResult;
	const metrics: NonNullable<InvestigationCaptureInput["metrics"]> = {};
	try {
		result = await withInvestigationNodeCapture({
			goalDir: input.harnessWorkspaceDirectory,
			goalId: captured.goal_id,
			runDir: input.recordDirectory,
			question: captured.question,
			context: captured.context, language: captured.language,
			allowExternal: captured.allow_external,
			handoffMode: responseMode, threadId: captured.thread_id,
			wikiSha256: captured.wiki_sha256,
			model: captured.model,
			thinking: captured.thinking,
			metrics,
			candidateCase: input.candidateCase,
			execute: async () => {
				const model = resolvePrimeModel("primeRoot", env);
				const run = await runPrime({
					module: primeAgentModulePath(env), cwd: root, runtimeRoot: join(input.recordDirectory, "runtime"),
					readonlyRoots: [sdkRoot, skillRoot, join(root, "inputs")],
					sessionDir: join(input.recordDirectory, "runtime", "session", "session"),
					provider: model.provider, model: model.modelId, prompt, skills, tools: ["ipython"],
					thinking: captured.thinking, scopedModels: [], rlmMaxDepth: 0,
					extraEnv: { PRIME_AGENT_SOURCE_URL: bridge.baseUrl, PRIME_AGENT_SOURCE_TOKEN: bridge.token,
						PRIME_INVESTIGATION_HANDOFF_MODE: responseMode,
						PRIME_AGENT_SOURCE_IDS: "", PRIME_AGENT_ARTIFACT_WORKSPACE: root,
						PYTHONPATH: sdkRoot, PYTHONDONTWRITEBYTECODE: "1", RLM_MAX_DEPTH: "0" },
					env, signal,
					activity: { stageId: "prime-investigation", attemptId: "attempt-1", role: "prime_search" },
					tracePath: join(input.recordDirectory, "trace.jsonl"),
					conditionsPath: join(input.recordDirectory, "execution-conditions.jsonl"),
					launchKind: "local_investigation",
				});
				metrics.usage = run.usage;
				metrics.toolCalls = run.toolCalls;
				if (run.rootError) throw new Error(run.rootError);
				assertMatched();
				const output = join(root, "work", "result.json");
				const stat = lstatSync(output, { throwIfNoEntry: false });
				if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128_000) {
					throw new Error(run.rootError ?? "Prime Investigation did not write a valid result file");
				}
				const authored = resolveInvestigationReplayResult({ workspace: root,
					value: JSON.parse(readFileSync(output, "utf-8")), lastAnswer: writerState.lastAnswer,
					id: basename(input.workDirectory), question: captured.question, wikiSha256: captured.wiki_sha256 });
				return validateInvestigationResult({ ...citationsScope.restore(authored),
					...(captured.thread_id ? { thread_id: captured.thread_id } : {}) },
					basename(input.workDirectory), captured.question);
			},
		});
	} finally {
		await bridge.close();
	}
	return {
		caseId: input.value.caseId,
		agentId: "prime-investigation",
		artifact: input.artifactStore.publishText(`${JSON.stringify(result, null, 2)}\n`, "result.json"),
		usage: metrics.usage!,
		turns: metrics.usage!.calls,
		toolCalls: metrics.toolCalls!,
	};
}
