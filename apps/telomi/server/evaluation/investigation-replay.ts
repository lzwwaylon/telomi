import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentStageRequest, ValidatedStageArtifact } from "../agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { beginNodeEvaluationCase, finishNodeEvaluationCase, readNodeEvaluationFile,
	type NodeEvaluationInteraction, type NodeReplayRecipe } from "../agent-runtime/node-evaluation.js";
import type { ThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { resolvePrimeModel, pinTaskModelSelection } from "../agent-runtime/model-policy.js";
import { primeAgentModulePath } from "../agent-runtime/prime-agent-paths.js";
import { materializeSkills, snapshotSkills } from "../agent-runtime/skill-registry.js";
import { sha256 } from "../lib/hash.js";
import { toErrorMessage } from "../lib/values.js";
import { recordCaseCaptureFailure } from "../observability/case-capture.js";
import { validateInvestigationResult, type InvestigationResult } from "../research/investigate.js";
import { createInvestigationCitationScope, type InvestigationCitationCue } from "../research/investigation-citations.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { runPrime, startPrimeSourceBridge } from "../research/pipeline/prime-search-batch.js";
import { ResearchSourceRegistry } from "../research/sources/registry.js";

export const INVESTIGATION_RECIPE = { id: "prime-investigation", version: 1 } as const;

interface InvestigationCaptureInput {
	goalDir: string;
	goalId: string;
	runDir: string;
	question: string;
	allowExternal?: boolean;
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
			allow_external: input.allowExternal !== false,
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
		if (row.operation !== "knowledge_search" && row.operation !== "deep_search" && row.operation !== "github_read") {
			throw new Error("Unknown Prime investigation interaction");
		}
		return { kind: "tool", name: row.operation, label: row.operation, description: "Frozen local investigation result",
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
	allow_external?: boolean;
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

async function executeProductionInvestigationReplay(
	input: Parameters<NodeReplayRecipe["replay"]>[0],
): ReturnType<NodeReplayRecipe["replay"]> {
	if (input.promptOverride?.systemPrompt) throw new Error("Prime Investigation replay does not accept systemPrompt override");
	const caseDir = dirname(input.casePath);
	const captured = JSON.parse(readFileSync(join(caseDir, "input", "request.json"), "utf-8")) as FrozenInvestigationRequest;
	const historicalPrompt = readNodeEvaluationFile(input.casePath, input.value.request.userPrompt);
	if (captured.schema_version !== 1 || !captured.question || !captured.goal_id
		|| !/^[a-f0-9]{64}$/u.test(captured.wiki_sha256)
		|| !/^[a-f0-9]{64}$/u.test(captured.prompt_sha256)
		|| sha256(historicalPrompt) !== captured.prompt_sha256) {
		throw new Error("Prime Investigation Case request is invalid");
	}
	const interactions = input.value.request.interactions
		? JSON.parse(readNodeEvaluationFile(input.casePath, input.value.request.interactions)) as NodeEvaluationInteraction[]
		: [];
	const frozen = interactions.filter((item): item is Extract<NodeEvaluationInteraction, { kind: "tool" }> => item.kind === "tool"
		&& (item.name === "knowledge_search" || item.name === "deep_search" || item.name === "github_read"));
	const prompt = input.promptOverride?.userPrompt ?? historicalPrompt;
	const env = pinTaskModelSelection(["primeRoot"], {
		...process.env, TELOMI_PRIME_AGENT_ROOT_MODEL: captured.model,
	});
	const root = join(input.recordDirectory, "workspace");
	const sdkRoot = join(input.recordDirectory, "sdk");
	const skillRoot = join(root, "skills", "root-agent");
	mkdirSync(join(root, "work"), { recursive: true });
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
	const skillSource = fileURLToPath(new URL("../../agents/research/prime-search/skills/deep-search", import.meta.url));
	const skills = [...materializeSkills(snapshotSkills([skillSource]), skillRoot).values()];
	const signal = input.signal;
	let unmatchedInteraction: Error | undefined;
	let nextInteraction = 0;
	const citationsScope = createInvestigationCitationScope();
	const replayCall = (name: "knowledge_search" | "deep_search" | "github_read", request: unknown): unknown => {
		const observed = frozen[nextInteraction];
		if (!observed || observed.name !== name) {
			unmatchedInteraction = new Error(`No frozen Tool interaction matches '${name}' at step ${nextInteraction + 1}`);
			throw unmatchedInteraction;
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
		appendFileSync(join(input.recordDirectory, "interactions.jsonl"), `${JSON.stringify({ operation: name, request, response })}\n`);
		for (const page of response.pages ?? []) for (const evidence of page.evidence ?? []) {
			if (evidence.cite_ref) citationsScope.allowWikiRef(evidence.cite_ref);
		}
		const projected = response.cues ? { ...response, cues: citationsScope.projectCues(response.cues) }
			: response.reading?.cues ? { ...response,
				reading: { ...response.reading, cues: citationsScope.projectCues(response.reading.cues) } } : response;
		return name === "github_read" && response.sources
			? { ...projected, sources: response.sources.map(({ title, url }) => ({ title, url })) }
			: projected;
	};
	const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(), new Set(), {
		workspaceDirectory: root,
		temporalContext: { schemaVersion: 1, currentDate: "1970-01-01", timeZone: "UTC" },
		signal,
	}, root, { runDir: input.recordDirectory, nodeId: "prime-investigation", attemptId: "attempt-1" }, {
		investigation: {
			knowledgeSearch: async (query, limit) => replayCall("knowledge_search", { query, limit }),
			deepSearch: async (question) => replayCall("deep_search", { question }),
			githubRead: async (question, repository, ref, paths) => {
				if (captured.allow_external === false) throw new Error("This Case disallows external sources");
				return replayCall("github_read", { question, repository, ref, paths });
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
			allowExternal: captured.allow_external,
			wikiSha256: captured.wiki_sha256,
			model: captured.model,
			thinking: captured.thinking,
			metrics,
			candidateCase: input.candidateCase,
			execute: async () => {
				const model = resolvePrimeModel("primeRoot", env);
				const run = await runPrime({
					module: primeAgentModulePath(env), cwd: root, runtimeRoot: join(input.recordDirectory, "runtime"),
					readonlyRoots: [sdkRoot, skillRoot],
					sessionDir: join(input.recordDirectory, "runtime", "session", "session"),
					provider: model.provider, model: model.modelId, prompt, skills, tools: ["ipython"],
					thinking: captured.thinking, scopedModels: [], rlmMaxDepth: 0,
					extraEnv: { PRIME_AGENT_SOURCE_URL: bridge.baseUrl, PRIME_AGENT_SOURCE_TOKEN: bridge.token,
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
				if (unmatchedInteraction) throw unmatchedInteraction;
				const output = join(root, "work", "result.json");
				const stat = lstatSync(output, { throwIfNoEntry: false });
				if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128_000) {
					throw new Error(run.rootError ?? "Prime Investigation did not write a valid result file");
				}
				const draft = JSON.parse(readFileSync(output, "utf-8")) as Record<string, unknown>;
				const authored = validateInvestigationResult({ ...draft, id: basename(input.workDirectory),
					question: captured.question, wiki_sha256: captured.wiki_sha256 },
					basename(input.workDirectory), captured.question);
				return validateInvestigationResult(citationsScope.restore(authored),
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
