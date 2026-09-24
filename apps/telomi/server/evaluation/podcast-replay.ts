import { resolveStageThinkingLevel, type ThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { pinTaskModelSelection, resolvePrimeAgentModels } from "../agent-runtime/model-policy.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { bundledAgentSkillPath } from "../agent-runtime/skill-registry.js";
import type { PrimePodcastWritingResult } from "../media/podcast/writer.js";
import { writePrimePodcast } from "../media/podcast/writer.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import type { AgentStageRequest, ValidatedStageArtifact } from "../agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore, type PublishedArtifactDirectoryRef, type PublishedArtifactRef } from "../agent-runtime/artifact-store.js";
import {
	beginNodeEvaluationCase,
	finishNodeEvaluationCase,
	type NodeEvaluationCaseDraft,
	type NodeReplayRecipe,
} from "../agent-runtime/node-evaluation.js";
import { recordCaseCaptureFailure } from "../observability/case-capture.js";
import { emptyWorkspaceSnapshot, snapshotWorkspaceTree } from "../agent-runtime/workspace-snapshot.js";
import { toErrorMessage } from "../lib/values.js";
import { listFilesRecursive, readJson } from "../lib/fs.js";

const RECIPE_VERSION = 1;
const RUBRIC = join(bundledAgentSkillPath("main", "podcast-writer", "podcast-writing"), "references", "evaluation-rubric.md");

type PodcastInput = Parameters<typeof writePrimePodcast>[0];

interface FrozenPodcastRequest {
	schema_version: 1;
	title: string;
	language: string;
	audience: string;
	generation_brief: PodcastInput["generationBrief"];
	/** Older v1 Cases omitted thinking; Replay then resolves the depth from the current stage configuration. */
	models: { root: string; child: string; thinking?: ThinkingLevel };
}

export async function runPodcastWriterNodeEvaluation(
	input: PodcastInput,
	options: {
		recordDirectory: string;
		runId: string;
		execute?: (input: PodcastInput) => Promise<PrimePodcastWritingResult>;
		env?: NodeJS.ProcessEnv;
	},
): Promise<PrimePodcastWritingResult> {
	const env = pinTaskModelSelection(["primeRoot", "primeChild"], options.env ?? input.env ?? process.env);
	const execute = () => (options.execute ?? writePrimePodcast)({ ...input, env });
	const workDirectory = join(options.recordDirectory, "media", "podcast", "writer", "agent-workspace");
	const workspace = emptyWorkspaceSnapshot();
	let draft: NodeEvaluationCaseDraft | undefined;
	let artifactStore: RunArtifactStore | undefined;
	try {
		const models = resolvePrimeAgentModels(env);
		const inputDirectory = resetDirectory(join(options.recordDirectory, "node-evaluation", "podcast-writer-input"));
		const frozen: FrozenPodcastRequest = {
			schema_version: 1,
			title: input.title,
			language: input.language,
			audience: input.audience,
			generation_brief: input.generationBrief,
			models: { root: models.root.selector, child: models.child.selector, thinking: resolveStageThinkingLevel("primeRoot", "podcastWriter", env).thinkingLevel },
		};
		writeFileSync(join(inputDirectory, "request.json"), `${JSON.stringify(frozen, null, 2)}\n`);
		writeFileSync(join(inputDirectory, "canonical-report.md"), input.sourceText);
		mkdirSync(workDirectory, { recursive: true });
		await snapshotWorkspaceTree(workspace, "input", workDirectory);
		artifactStore = new RunArtifactStore(options.recordDirectory);
		const stage = captureRequest({ ...input, env }, options.runId, inputDirectory, workDirectory, artifactStore, models.root.selector);
		draft = beginNodeEvaluationCase({
			request: stage,
			recordDirectory: options.recordDirectory,
			promptConfig: stage.promptConfig!,
			sessionContextFile: join(options.recordDirectory, "media", "podcast", "writer", "runtime", "session", "missing.jsonl"),
			composedSystemPrompt: stage.systemPrompt,
			actualModel: models.root.selector,
		});
	} catch (error) {
		recordCaseCaptureFailure("podcast-writer", error);
	}
	// fail-open：Capture 不可用时仍然执行产品 Podcast Writer。
	if (!draft || !artifactStore) return execute();
	const startedAt = Date.now();
	let result: PrimePodcastWritingResult;
	try {
		result = await execute();
	} catch (error) {
		try {
			await snapshotWorkspaceTree(workspace, "output", workDirectory);
			finishNodeEvaluationCase(draft, {
				status: input.signal.aborted ? "cancelled" : "failed",
				workDirectory,
				validationErrors: [],
				error: toErrorMessage(error),
				durationMs: Date.now() - startedAt,
				workspace,
			});
		} catch (captureError) {
			recordCaseCaptureFailure("podcast-writer", captureError);
		}
		throw error;
	}
	try {
		await snapshotWorkspaceTree(workspace, "output", workDirectory);
		const runtimeRoot = join(options.recordDirectory, "media", "podcast", "writer", "runtime");
		const metrics = readMetrics(runtimeRoot);
		const artifact = publishPodcastOutput(result, metrics, artifactStore, "artifacts/node-evaluation/podcast-writer");
		const capture = finishNodeEvaluationCase(draft, {
			status: "succeeded",
			workDirectory,
			result: validatedResult(result, metrics, artifact, runtimeRoot),
			validationErrors: [],
			traceDirectories: [join(options.recordDirectory, "media", "podcast", "writer")],
			durationMs: Date.now() - startedAt,
			workspace,
		});
		if (capture.status !== "captured") recordCaseCaptureFailure("podcast-writer", capture.reason);
	} catch (captureError) {
		recordCaseCaptureFailure("podcast-writer", captureError);
	}
	return result;
}

export interface PodcastReplayExecutionInput {
	caseInputDirectory: string;
	harnessWorkspaceDirectory: string;
	recordDirectory: string;
	workDirectory: string;
	artifactStore: RunArtifactStore;
	candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
	signal: AbortSignal;
}

export interface PodcastReplayExecutionResult {
	artifact: PublishedArtifactDirectoryRef | PublishedArtifactRef;
	usage: ResearchModelUsage;
	turns: number;
	toolCalls: number;
}

export function createPodcastWriterReplayRecipe(options: {
	execute?: (input: PodcastReplayExecutionInput) => Promise<PodcastReplayExecutionResult>;
} = {}): NodeReplayRecipe {
	return {
		identity: { id: "podcast-writer", version: RECIPE_VERSION },
		async replay(input) {
			if (input.value.agentId !== "podcast-writer") throw new Error(`Node Case belongs to Agent '${input.value.agentId}'`);
			const sourceInputDirectory = join(dirname(input.casePath), "input");
			const caseInputDirectory = input.candidateCase
				? resetDirectory(join(input.recordDirectory, "node-evaluation", "podcast-writer-replay-input"))
				: sourceInputDirectory;
			if (input.candidateCase) cpSync(sourceInputDirectory, caseInputDirectory, { recursive: true });
			const execute = options.execute ?? executeProductionPodcastReplay;
			const executionInput: PodcastReplayExecutionInput = {
				caseInputDirectory,
				harnessWorkspaceDirectory: input.harnessWorkspaceDirectory,
				recordDirectory: input.recordDirectory,
				workDirectory: input.workDirectory,
				artifactStore: input.artifactStore,
				...(input.candidateCase ? { candidateCase: input.candidateCase } : {}),
				signal: input.signal,
			};
			const result = input.candidateCase
				? await capturePodcastReplayExecution(executionInput, execute)
				: await execute(executionInput);
			return { caseId: input.value.caseId, agentId: "podcast-writer", ...result };
		},
	};
}

export const podcastWriterReplayRecipe = createPodcastWriterReplayRecipe();

async function capturePodcastReplayExecution(
	input: PodcastReplayExecutionInput,
	execute: (input: PodcastReplayExecutionInput) => Promise<PodcastReplayExecutionResult>,
): Promise<PodcastReplayExecutionResult> {
	if (!input.candidateCase) throw new Error("Podcast Writer Candidate Replay Case metadata is required");
	const request = readJson<FrozenPodcastRequest>(join(input.caseInputDirectory, "request.json"));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TELOMI_PRIME_AGENT_ROOT_MODEL: request.models.root,
		TELOMI_PRIME_AGENT_CHILD_MODEL: request.models.child,
		TELOMI_PODCAST_WRITER_THINKING_LEVEL: request.models.thinking ?? resolveStageThinkingLevel("primeRoot", "podcastWriter").thinkingLevel,
	};
	const workDirectory = join(input.workDirectory, "media", "podcast", "writer", "agent-workspace");
	mkdirSync(workDirectory, { recursive: true });
	const workspace = emptyWorkspaceSnapshot();
	await snapshotWorkspaceTree(workspace, "input", workDirectory);
	const stage = captureRequest({
		sourceText: readFileSync(join(input.caseInputDirectory, "canonical-report.md"), "utf-8"),
		sessionDir: input.recordDirectory,
		title: request.title,
		language: request.language,
		audience: request.audience,
		generationBrief: request.generation_brief,
		emitProgress: () => undefined,
		observe: () => undefined,
		signal: input.signal,
		env,
		skillWorkspaceDirectory: input.harnessWorkspaceDirectory,
	}, input.candidateCase.sourceRunId, input.caseInputDirectory, workDirectory, input.artifactStore, request.models.root);
	const draft = beginNodeEvaluationCase({
		request: stage,
		recordDirectory: input.recordDirectory,
		promptConfig: stage.promptConfig!,
		sessionContextFile: join(input.recordDirectory, ".missing-podcast-writer-session"),
		composedSystemPrompt: stage.systemPrompt,
		actualModel: request.models.root,
		capabilitySnapshotId: input.candidateCase.capabilitySnapshotId,
	});
	if (!draft) throw new Error("Podcast Writer Candidate Replay Case draft was not created");
	const startedAt = Date.now();
	try {
		const result = await execute(input);
		await snapshotWorkspaceTree(workspace, "output", workDirectory);
		const capture = finishNodeEvaluationCase(draft, {
			status: "succeeded",
			workDirectory,
			result: validatedReplayResult(result, input.workDirectory),
			validationErrors: [],
			traceDirectories: [join(input.workDirectory, "media", "podcast", "writer")],
			durationMs: Date.now() - startedAt,
			workspace,
		});
		if (capture.status !== "captured") throw new Error(capture.reason);
		return result;
	} catch (error) {
		await snapshotWorkspaceTree(workspace, "output", workDirectory);
		finishNodeEvaluationCase(draft, {
			status: input.signal.aborted ? "cancelled" : "failed",
			workDirectory,
			validationErrors: [],
			error: toErrorMessage(error),
			durationMs: Date.now() - startedAt,
			workspace,
		});
		throw error;
	}
}

async function executeProductionPodcastReplay(input: PodcastReplayExecutionInput): Promise<PodcastReplayExecutionResult> {
	const request = readJson<FrozenPodcastRequest>(join(input.caseInputDirectory, "request.json"));
	const result = await writePrimePodcast({
			sourceText: readFileSync(join(input.caseInputDirectory, "canonical-report.md"), "utf-8"),
			sessionDir: input.workDirectory,
			title: request.title,
			language: request.language,
			audience: request.audience,
			generationBrief: request.generation_brief,
			emitProgress: () => undefined,
			observe: () => undefined,
			signal: input.signal,
			env: {
				...process.env,
				TELOMI_PRIME_AGENT_ROOT_MODEL: request.models.root,
				TELOMI_PRIME_AGENT_CHILD_MODEL: request.models.child,
		TELOMI_PODCAST_WRITER_THINKING_LEVEL: request.models.thinking ?? resolveStageThinkingLevel("primeRoot", "podcastWriter").thinkingLevel,
			},
			skillWorkspaceDirectory: input.harnessWorkspaceDirectory,
	});
	const runtimeRoot = join(input.workDirectory, "media", "podcast", "writer", "runtime");
	const metrics = readMetrics(runtimeRoot);
	return {
		artifact: publishPodcastOutput(result, metrics, input.artifactStore, "result"),
		usage: metrics.usage,
		turns: metrics.usage.calls,
		toolCalls: metrics.toolCalls,
	};
}

function validatedReplayResult(
	result: PodcastReplayExecutionResult,
	workDirectory: string,
): ValidatedStageArtifact<unknown> {
	const runtimeRoot = join(workDirectory, "media", "podcast", "writer", "runtime");
	return {
		value: result,
		artifact: result.artifact,
		submissionCount: 1,
		validationErrors: [],
		session: { id: "podcast-writer", mode: "fresh" },
		turns: result.turns,
		toolCalls: result.toolCalls,
		toolCounts: {},
		usage: result.usage,
		sessionPath: listFilesRecursive(join(runtimeRoot, "session"), { absolute: true, sort: false }).find((path) => path.endsWith(".jsonl"))
			?? join(runtimeRoot, "missing-root-session.jsonl"),
	};
}

function captureRequest(
	input: PodcastInput,
	runId: string,
	inputDirectory: string,
	workDirectory: string,
	artifactStore: RunArtifactStore,
	model: string,
): AgentStageRequest<unknown> {
	const systemPrompt = renderAgentPrompt("main", "podcast-writer", "system-append").content;
	const userPrompt = renderAgentPrompt("main", "podcast-writer", "user", {
		child_model: resolvePrimeAgentModels(input.env ?? process.env).child.selector,
	}, "plan").content;
	return {
		runId,
		stageId: "podcast-writer",
		attemptId: "1",
		attempt: 1,
		role: "podcast_writer",
		promptConfig: { domain: "main", id: "podcast-writer", sandboxRole: "media.podcast-writer" as never },
		recordKind: "evaluation",
		evaluation: {
			agentId: "podcast-writer",
			recipe: { id: "podcast-writer", version: RECIPE_VERSION },
			recipeInput: {},
			inputRelativePath: relative(input.sessionDir, inputDirectory).split(sep).join("/"),
			harnessMounts: [],
			liveExternalState: false,
		},
		session: { key: "podcast-writer", policy: "fresh" },
		modelPolicy: { preferred: [model], fallback: [], reasoning: resolveStageThinkingLevel("primeRoot", "podcastWriter", input.env).thinkingLevel },
		systemPrompt,
		userPrompt,
		workDirectory,
		readonlyMounts: [],
		controlDirectory: input.sessionDir,
		recordDirectory: input.sessionDir,
		artifactStore,
		output: { kind: "chapter", publishRelativePath: "artifacts/node-evaluation/podcast-writer", validate: () => ({}) },
		signal: input.signal,
	};
}

function publishPodcastOutput(
	result: PrimePodcastWritingResult,
	metrics: PodcastMetrics,
	store: RunArtifactStore,
	target: string,
): PublishedArtifactDirectoryRef {
	const staging = mkdtempSync(join(dirname(result.artifactRoot), ".podcast-evaluation-"));
	try {
		cpSync(result.artifactRoot, join(staging, "writer-output"), { recursive: true });
		cpSync(RUBRIC, join(staging, "rubric.md"));
		writeFileSync(join(staging, "evaluation.json"), `${JSON.stringify({
			schema_version: 1,
			title: result.title,
			section_count: result.sections.length,
			character_count: result.sections.reduce((sum, section) => sum + section.text.length, 0),
			usage: metrics.usage,
			tool_calls: metrics.toolCalls,
		}, null, 2)}\n`);
		return store.publishDirectory(staging, target, staging);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

function validatedResult(
	result: PrimePodcastWritingResult,
	metrics: PodcastMetrics,
	artifact: PublishedArtifactDirectoryRef,
	runtimeRoot: string,
): ValidatedStageArtifact<unknown> {
	return {
		value: result,
		artifact,
		submissionCount: 1,
		validationErrors: [],
		session: { id: "podcast-writer", mode: "fresh" },
		turns: metrics.usage.calls,
		toolCalls: metrics.toolCalls,
		toolCounts: {},
		usage: metrics.usage,
		sessionPath: listFilesRecursive(join(runtimeRoot, "session"), { absolute: true, sort: false }).find((path) => path.endsWith(".jsonl"))
			?? join(runtimeRoot, "missing-root-session.jsonl"),
	};
}

interface PodcastMetrics { usage: ResearchModelUsage; toolCalls: number }

function readMetrics(runtimeRoot: string): PodcastMetrics {
	const value = readJson<{ usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number; model_calls?: number } }>(
		join(runtimeRoot, "result.json"),
	);
	return {
		usage: {
			inputTokens: value.usage?.input_tokens ?? 0,
			outputTokens: value.usage?.output_tokens ?? 0,
			costUsd: value.usage?.cost_usd ?? 0,
			calls: value.usage?.model_calls ?? 0,
		},
		toolCalls: countToolCalls([join(runtimeRoot, "session"), join(runtimeRoot, "session-artifacts")]),
	};
}

function countToolCalls(roots: string[]): number {
	let count = 0;
	for (const path of roots.flatMap((root) => listFilesRecursive(root, { absolute: true, sort: false })).filter((file) => file.endsWith(".jsonl"))) {
		for (const line of readFileSync(path, "utf-8").split(/\r?\n/u).filter(Boolean)) {
			try {
				const value = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
				if (value.type !== "message" || value.message?.role !== "assistant" || !Array.isArray(value.message.content)) continue;
				count += value.message.content.filter((item) => item && typeof item === "object"
					&& (item as { type?: unknown }).type === "toolCall").length;
			} catch {
				// Ignore an incomplete final trace line.
			}
		}
	}
	return count;
}

function resetDirectory(path: string): string {
	rmSync(path, { recursive: true, force: true });
	mkdirSync(path, { recursive: true });
	return path;
}

