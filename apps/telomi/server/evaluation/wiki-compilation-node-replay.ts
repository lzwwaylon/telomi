/** Formal capture at the complete Notes-to-Wiki boundary, including Topic-only reindex. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { RunArtifactStore, type PublishedArtifactDirectoryRef } from "../agent-runtime/artifact-store.js";
import type { AgentStageRequest, ValidatedStageArtifact } from "../agent-runtime/agent-stage-runtime.js";
import { beginNodeEvaluationCase, finishNodeEvaluationCase, type NodeReplayRecipe } from "../agent-runtime/node-evaluation.js";
import { pinWikiModelSelection } from "../wiki/compilation-runtime.js";
import { isThinkingLevel, resolveLLMConfig, resolveStageThinkingLevel, type ThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { resolvePrimeModel } from "../agent-runtime/model-policy.js";
import { TASK_MODEL_ROLE_INFO } from "../config/settings.js";
import { validateCornellNotesSnapshot } from "../cornell/contracts.js";
import { requireWikiGoalContext, validateGoalTopicPlan, type GoalTopicPlan, type WikiCompilationRequest, type WikiCompilationResult, type WikiGoalContext } from "../wiki/contracts.js";
import { WikiCompiler, type WikiReindexRequest, type WikiReindexResult } from "../wiki/wiki-compiler.js";
import { hashWikiDirectory } from "../wiki/files.js";
import { PAGE_TOPIC_MODEL, PAGE_TOPIC_THINKING } from "../wiki/page-topic-stage.js";
import { hashJson } from "../lib/hash.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { isRecord, toErrorMessage } from "../lib/values.js";
import { recordCaseCaptureFailure } from "../observability/case-capture.js";
import { WikiCueOriginSchema, type WikiCueOrigin } from "../wiki/wiki-update-job.js";
import { validateJsonSchema } from "../agent-runtime/structured-output.js";

const RECIPE = { id: "wiki-compilation", version: 1 };
interface FrozenWikiModels { root: string; child: string; thinking: ThinkingLevel }

function wikiModels(env: NodeJS.ProcessEnv): FrozenWikiModels {
	const root = resolveLLMConfig({ envVarName: TASK_MODEL_ROLE_INFO.wikiCompilation.modelEnvVar,
		taskModelRole: "wikiCompilation", envOverride: env });
	if (!root.model) throw new Error("Wiki evaluation requires a configured Root model");
	return { root: root.model, child: resolvePrimeModel("primeChild", env).selector,
		thinking: resolveStageThinkingLevel("wikiCompilation", "maintenance", env).thinkingLevel };
}

function frozenWikiEnv(models: FrozenWikiModels): NodeJS.ProcessEnv {
	return { ...process.env, TELOMI_WIKI_COMPILATION_MODEL: models.root,
		TELOMI_PRIME_AGENT_CHILD_MODEL: models.child, TELOMI_WIKI_COMPILATION_THINKING_LEVEL: models.thinking };
}
interface FrozenRequest {
	schema_version: 1;
	operation: "compile" | "reindex";
	goalContext: WikiGoalContext;
	models: FrozenWikiModels;
	goal?: string;
	rebuild: boolean;
	has_previous_edition: boolean;
}
interface Execution {
	baseKnowledgeSha256: string;
	knowledgeRoot: string;
	usage: WikiCompilationResult["usage"];
	sessionPaths: string[];
	failureCount: number;
}

/** Reject incomplete legacy cases instead of filling missing inputs from a live Goal. */
export function readWikiCompilationCaseInput(directory: string) {
	const manifest: unknown = JSON.parse(readFileSync(join(directory, "input-manifest.json"), "utf8"));
	const files = describe(directory).files.filter(file => file.relativePath !== "input-manifest.json");
	if (!isRecord(manifest) || manifest.schema_version !== 1 || hashJson(manifest.files) !== hashJson(files)) throw new Error("Wiki compilation frozen input hash mismatch");
	const raw: unknown = JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
	if (!isRecord(raw) || raw.schema_version !== 1 || !["compile", "reindex"].includes(String(raw.operation))
		|| typeof raw.rebuild !== "boolean" || typeof raw.has_previous_edition !== "boolean"
		|| (raw.goal !== undefined && typeof raw.goal !== "string") || !isRecord(raw.models)
		|| typeof raw.models.root !== "string" || !/^[^/]+\/.+$/u.test(raw.models.root)
		|| typeof raw.models.child !== "string" || !/^[^/]+\/.+$/u.test(raw.models.child)
		|| !isThinkingLevel(raw.models.thinking)) throw new Error("Invalid Wiki compilation frozen request");
	const request: FrozenRequest = { schema_version: 1, operation: raw.operation as FrozenRequest["operation"],
		goalContext: requireWikiGoalContext(raw.goalContext), models: { root: raw.models.root, child: raw.models.child, thinking: raw.models.thinking },
		rebuild: raw.rebuild, has_previous_edition: raw.has_previous_edition, ...(typeof raw.goal === "string" ? { goal: raw.goal } : {}) };
	if (request.has_previous_edition !== existsSync(join(directory, "previous-edition"))
		|| (request.operation === "reindex" && (!request.has_previous_edition || request.rebuild))
		|| (request.operation === "compile") !== existsSync(join(directory, "evidence.json"))) throw new Error("Wiki compilation operation/input mismatch");
	const originsPath = join(directory, "cue-origins.json");
	const cueOrigins = existsSync(originsPath) ? readCueOrigins(originsPath) : undefined;
	return { request, topicPlan: validateGoalTopicPlan(JSON.parse(readFileSync(join(directory, "topic-plan.json"), "utf8"))),
		...(cueOrigins ? { cueOrigins } : {}),
		...(request.operation === "compile" ? { evidence: validateCornellNotesSnapshot(JSON.parse(readFileSync(join(directory, "evidence.json"), "utf8"))) } : {}) };
}

export async function runWikiCompilationNodeEvaluation(request: WikiCompilationRequest, options: {
	execute: (request: WikiCompilationRequest) => Promise<WikiCompilationResult>;
}): Promise<WikiCompilationResult> {
	const env = pinWikiModelSelection(request.controlDirectory, request.env ?? process.env);
	return captureProduction({ recordDirectory: request.controlDirectory, runId: request.runId, signal: request.signal,
		freeze: destination => freezeInput(destination, { operation: "compile", goalContext: request.goalContext, models: wikiModels(env),
			goal: request.goal, rebuild: request.rebuild ?? false, has_previous_edition: existsSync(join(request.goalDir, "wiki", "knowledge")) },
			request.topicPlan, join(request.goalDir, "wiki", "knowledge"),
			new RunArtifactStore(request.runDirectory).openFile(request.cornellNotesSnapshot).absolutePath, request.cueOrigins),
		execute: () => options.execute({ ...request, env }),
		result: result => ({ baseKnowledgeSha256: result.baseKnowledgeSha256, knowledgeRoot: result.knowledge.absolutePath, usage: result.usage,
			sessionPaths: result.sessionPaths, failureCount: result.failedBatches.length }), traceRoot: request.controlDirectory });
}

export async function runWikiReindexNodeEvaluation(request: WikiReindexRequest, options: {
	recordDirectory: string;
	runId: string;
	execute: (request: WikiReindexRequest) => Promise<WikiReindexResult>;
}): Promise<WikiReindexResult> {
	const env = pinWikiModelSelection(request.workRoot, request.env ?? process.env);
	return captureProduction({ recordDirectory: options.recordDirectory, runId: options.runId, signal: request.signal,
		freeze: destination => freezeInput(destination, { operation: "reindex", goalContext: request.goalContext, models: wikiModels(env),
			rebuild: false, has_previous_edition: true }, request.topicPlan, request.knowledgeRoot),
		execute: () => options.execute({ ...request, env }),
		result: result => ({ ...result, baseKnowledgeSha256: hashWikiDirectory(request.knowledgeRoot), failureCount: result.failedTopics.length }), traceRoot: request.workRoot });
}

function freezeInput(directory: string, request: Omit<FrozenRequest, "schema_version">, topicPlan: GoalTopicPlan, previousRoot: string, notesPath?: string, cueOrigins?: WikiCueOrigin[]): void {
	const store = new RunArtifactStore(directory);
	writeJsonAtomic(join(directory, "request.json"), { schema_version: 1, ...request });
	writeJsonAtomic(join(directory, "topic-plan.json"), validateGoalTopicPlan(topicPlan));
	if (request.has_previous_edition) store.publishDirectory(previousRoot, "previous-edition");
	if (notesPath) store.publishFile(notesPath, "evidence.json");
	if (cueOrigins) writeJsonAtomic(join(directory, "cue-origins.json"), cueOrigins);
	writeJsonAtomic(join(directory, "input-manifest.json"), { schema_version: 1, files: describe(directory).files });
	readWikiCompilationCaseInput(directory);
}

function readCueOrigins(path: string): WikiCueOrigin[] {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(value) || !value.length) throw new Error("Wiki Cue provenance is invalid");
	for (const origin of value) validateJsonSchema(WikiCueOriginSchema, origin);
	return value as WikiCueOrigin[];
}

async function captureProduction<T>(input: {
	recordDirectory: string; runId: string; signal: AbortSignal;
	freeze: (directory: string) => void; execute: () => Promise<T>; result: (result: T) => Execution; traceRoot: string;
}): Promise<T> {
	let prepared: ReturnType<typeof prepareCapture> | undefined;
	try {
		const root = join(input.recordDirectory, "node-evaluation");
		mkdirSync(root, { recursive: true });
		const directory = mkdtempSync(join(root, "wiki-compilation-"));
		input.freeze(join(directory, "input"));
		prepared = prepareCapture({ ...input, directory });
	} catch (error) { recordCaseCaptureFailure(RECIPE.id, error); }
	if (!prepared) return input.execute();
	let result: T;
	try { result = await input.execute(); }
	catch (error) {
		try { finishCapture(prepared, { error, signal: input.signal, traceRoot: input.traceRoot }); }
		catch (captureError) { recordCaseCaptureFailure(RECIPE.id, captureError); }
		throw error;
	}
	try {
		const captured = finishCapture(prepared, { result: input.result(result), signal: input.signal, traceRoot: input.traceRoot });
		if (captured.inputDrift) recordCaseCaptureFailure(RECIPE.id, captured.inputDrift);
	}
	catch (error) { recordCaseCaptureFailure(RECIPE.id, error); }
	return result;
}

function prepareCapture(input: { recordDirectory: string; directory: string; runId: string; signal: AbortSignal; capabilitySnapshotId?: string }) {
	const frozen = readWikiCompilationCaseInput(join(input.directory, "input"));
	const navigationOnly = frozen.request.operation === "reindex";
	const model = navigationOnly ? PAGE_TOPIC_MODEL : frozen.request.models.root;
	const thinking = navigationOnly ? PAGE_TOPIC_THINKING : frozen.request.models.thinking;
	const store = new RunArtifactStore(input.recordDirectory);
	const evidence = join(input.directory, "evidence");
	mkdirSync(evidence);
	const trace = join(evidence, "lifecycle.jsonl");
	writeFileSync(trace, `${JSON.stringify({ type: "start", operation: frozen.request.operation })}\n`);
	const stage: AgentStageRequest<unknown> = { runId: input.runId, stageId: RECIPE.id, attemptId: basename(input.directory), role: "wiki_compilation",
		evaluation: { agentId: RECIPE.id, recipe: RECIPE, recipeInput: { operation: frozen.request.operation },
			inputRelativePath: relative(input.recordDirectory, join(input.directory, "input")).split(sep).join("/"), harnessMounts: [], liveExternalState: false },
		session: { key: RECIPE.id, policy: "fresh" }, modelPolicy: { preferred: [model], fallback: [], reasoning: thinking },
		systemPrompt: "", userPrompt: JSON.stringify(frozen.request.goalContext), workDirectory: evidence,
		readonlyMounts: [], controlDirectory: input.directory, artifactStore: store,
		output: { kind: "stage_report", publishRelativePath: "output", validate: () => ({}) }, signal: input.signal };
	const draft = beginNodeEvaluationCase({ request: stage, recordDirectory: input.recordDirectory,
		promptConfig: { domain: "wiki", id: "wiki-compilation", sandboxRole: "wiki.wiki-compilation" },
		sessionContextFile: join(input.directory, ".no-prior-session"), composedSystemPrompt: "", actualModel: model,
		...(input.capabilitySnapshotId ? { capabilitySnapshotId: input.capabilitySnapshotId } : {}) });
	if (!draft) throw new Error("Wiki compilation Case capture did not start");
	return { ...input, store, draft, evidence, trace, startedAt: Date.now() };
}

function finishCapture(prepared: ReturnType<typeof prepareCapture>, input: { result?: Execution; error?: unknown; signal: AbortSignal; traceRoot: string }) {
	const evidenceStore = new RunArtifactStore(prepared.evidence);
	collectEvidence(input.traceRoot, evidenceStore, "stages");
	for (const [index, path] of (input.result?.sessionPaths ?? []).entries()) collectEvidence(path, evidenceStore, `sessions/${index}`);
	const inputDrift = input.result && input.result.baseKnowledgeSha256 !== hashWikiDirectory(join(prepared.directory, "input", "previous-edition"))
		? new Error("Wiki execution base differs from its frozen Case input") : undefined;
	const error = input.error ?? inputDrift ?? (input.result?.failureCount ? new Error(`Wiki compilation has ${input.result.failureCount} failed tasks`) : undefined);
	const status = error ? input.signal.aborted ? "cancelled" : "failed" : "succeeded";
	if (input.result && error) evidenceStore.publishDirectory(input.result.knowledgeRoot, "terminal-knowledge");
	appendFileSync(prepared.trace, `${JSON.stringify({ type: "finish", status, ...(error ? { error: toErrorMessage(error) } : {}) })}\n`);
	const tools = countRecordedToolCalls(prepared.evidence, describe(prepared.evidence).files);
	let result: ValidatedStageArtifact<unknown> | undefined;
	if (input.result && !error) {
		const output = join(prepared.directory, "output");
		const store = new RunArtifactStore(output);
		store.publishDirectory(input.result.knowledgeRoot, "knowledge");
		store.publishFile(fileURLToPath(new URL("../../agents/wiki/wiki-compilation/references/evaluation-rubric.md", import.meta.url)), "rubric.md");
		writeJsonAtomic(join(output, "evaluation.json"), { schema_version: 1, usage: input.result.usage, toolCalls: tools.count, toolMetricsComplete: tools.complete });
		const artifact = prepared.store.describeDirectory(relative(prepared.recordDirectory, output));
		result = { value: {}, artifact, submissionCount: 1, validationErrors: [], session: { id: prepared.runId, mode: "fresh" },
			turns: input.result.usage.calls, toolCalls: tools.count, toolCounts: tools.byName, usage: input.result.usage, sessionPath: prepared.trace };
	}
	const captured = finishNodeEvaluationCase(prepared.draft, { status, workDirectory: prepared.evidence, sessionPath: prepared.trace,
		...(result ? { result } : {}), validationErrors: [], ...(error ? { error: toErrorMessage(error) } : {}),
		traceDirectories: [prepared.evidence], durationMs: Date.now() - prepared.startedAt });
	if (captured.status !== "captured") throw new Error(`Wiki compilation Case capture failed: ${captured.reason}`);
	return { captured, result, error, inputDrift };
}

export function createWikiCompilationReplayRecipe(compiler: Pick<WikiCompiler, "compile" | "reindex"> = new WikiCompiler()): NodeReplayRecipe {
	return { identity: RECIPE, async replay(input) {
		if (input.value.agentId !== RECIPE.id || input.value.recipe.id !== RECIPE.id || input.value.recipe.version !== RECIPE.version) throw new Error("Expected a formal Wiki compilation Case");
		if (input.promptOverride) throw new Error("Wiki compilation uses the Candidate Agent Bundle, not a historical node Prompt override");
		const directory = join(input.recordDirectory, "wiki-compilation");
		const store = new RunArtifactStore(directory);
		store.publishDirectory(join(dirname(input.casePath), "input"), "input");
		const frozen = readWikiCompilationCaseInput(join(directory, "input"));
		const goalDir = join(directory, "goal");
		mkdirSync(goalDir);
		if (frozen.request.has_previous_edition) new RunArtifactStore(goalDir).publishDirectory(join(directory, "input", "previous-edition"), "wiki/knowledge");
		const traceRoot = join(directory, "control");
		mkdirSync(traceRoot);
		const prepared = prepareCapture({ recordDirectory: input.recordDirectory, directory,
			runId: input.candidateCase?.sourceRunId ?? input.value.runId, signal: input.signal,
			...(input.candidateCase ? { capabilitySnapshotId: input.candidateCase.capabilitySnapshotId } : {}) });
		let outcome: Execution;
		try {
			input.signal.throwIfAborted();
			const common = { goalContext: frozen.request.goalContext, topicPlan: frozen.topicPlan, env: frozenWikiEnv(frozen.request.models), signal: input.signal };
			if (frozen.request.operation === "compile") {
				const notes = store.publishFile(join(directory, "input", "evidence.json"), "cornell-notes.json");
				const result = await compiler.compile({ ...common, goalDir, runId: prepared.runId, runDirectory: directory, controlDirectory: traceRoot,
					goal: frozen.request.goal, rebuild: frozen.request.rebuild, cueOrigins: frozen.cueOrigins, cornellNotesSnapshot: { relative_path: notes.relativePath, sha256: notes.sha256, byte_length: notes.byteLength } });
				outcome = { baseKnowledgeSha256: result.baseKnowledgeSha256, knowledgeRoot: result.knowledge.absolutePath, usage: result.usage, sessionPaths: result.sessionPaths, failureCount: result.failedBatches.length };
			} else {
				const result = await compiler.reindex({ ...common, knowledgeRoot: join(goalDir, "wiki", "knowledge"), workRoot: traceRoot });
				outcome = { ...result, baseKnowledgeSha256: hashWikiDirectory(join(goalDir, "wiki", "knowledge")), failureCount: result.failedTopics.length };
			}
		} catch (error) {
			finishCapture(prepared, { error, signal: input.signal, traceRoot });
			throw error;
		}
		const capture = finishCapture(prepared, { result: outcome, signal: input.signal, traceRoot });
		if (capture.error) throw capture.error;
		if (!capture.result) throw new Error("Wiki compilation Candidate output is missing");
		return { caseId: input.value.caseId, agentId: RECIPE.id, artifact: capture.result.artifact as PublishedArtifactDirectoryRef,
			usage: outcome.usage, turns: outcome.usage.calls, toolCalls: capture.result.toolCalls };
	} };
}

export const wikiCompilationReplayRecipe = createWikiCompilationReplayRecipe();

function describe(directory: string): PublishedArtifactDirectoryRef {
	return new RunArtifactStore(dirname(directory)).describeDirectory(basename(directory));
}

function countRecordedToolCalls(root: string, files: PublishedArtifactDirectoryRef["files"]) {
	const calls = new Map<string, string>();
	let sessionMessages = 0;
	let missingCallIds = false;
	for (const file of files.filter((item) => item.relativePath.endsWith(".jsonl"))) {
		for (const line of readFileSync(join(root, file.relativePath), "utf8").split("\n").filter(Boolean)) {
			let value: unknown;
			try { value = JSON.parse(line); } catch { continue; }
			if (!isRecord(value) || !["message", "message_end"].includes(String(value.type)) || !isRecord(value.message)
				|| value.message.role !== "assistant" || !Array.isArray(value.message.content)) continue;
			sessionMessages += 1;
			for (const call of value.message.content) {
				if (!isRecord(call) || call.type !== "toolCall") continue;
				if (typeof call.id !== "string" || typeof call.name !== "string") { missingCallIds = true; continue; }
				calls.set(call.id, call.name);
			}
		}
	}
	const byName: Record<string, number> = {};
	for (const name of calls.values()) byName[name] = (byName[name] ?? 0) + 1;
	return { count: calls.size, byName, sessionMessages, complete: sessionMessages > 0 && !missingCallIds };
}

/** Keep semantic inputs, outputs and sessions; never copy staged credentials or SDK environments. */
function collectEvidence(root: string, store: RunArtifactStore, prefix: string): void {
	if (!existsSync(root)) return;
	const stat = lstatSync(root);
	if (stat.isSymbolicLink()) throw new Error("Wiki compilation trace root must not be a symlink");
	if (stat.isFile()) {
		if (!root.endsWith(".jsonl")) throw new Error("Wiki compilation session file must be JSONL");
		store.publishFile(root, `${prefix}/${basename(root)}`);
		return;
	}
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || ["agent", "sdk", "skills", "node-evaluation", "credentials"].includes(entry.name)) continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error("Wiki compilation stage evidence must not contain symlinks");
			if (entry.isDirectory()) {
				if (entry.name === "logical-workspaces" && basename(directory) === "runtime") {
					store.publishDirectory(path, `${prefix}/${relative(root, path)}`);
				} else walk(path);
				continue;
			}
			const rel = relative(root, path);
			if (!entry.isFile() || !/\.(?:json|jsonl|md)$/u.test(entry.name)) continue;
			if (entry.name.endsWith(".jsonl") || /^(?:result|accepted|accepted-result|submitted-result|agent-context|response|failure|receipts|input|failures|partial-result|checkpoint|plan|effective-system-prompt|tool-definitions|mounted-skills|model-metadata|workspace-capture|.*contract|.*prompt)\.(?:json|md)$/u.test(entry.name)
				|| rel.split("/").some((part) => ["input", "work", "decisions", "results"].includes(part))) store.publishFile(path, `${prefix}/${rel}`);
		}
	};
	if (!stat.isDirectory()) throw new Error("Wiki compilation trace root must be a directory or JSONL file");
	walk(root);
}
