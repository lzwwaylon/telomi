import type { ResolvedOutputLanguage } from "../../shared/languages.js";
import { sha256 } from "../lib/hash.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { ResearchHarnessSnapshot } from "./harness/snapshot.js";
import { createHarnessResearchSourceRegistry } from "./sources/builtin-registry.js";
import type { ResearchExecutionResult } from "./types.js";
import {
	researchConfigFromEnv,
} from "./config.js";
import {
	freezeRunModelSelection,
	runModelSelection,
	trackRunModelSelection,
} from "./run-model-selection.js";
import {
	cornellNoteAgentContractIdentity,
	createProductionCornellNotesMaterializer,
} from "./cornell-note-agent.js";
import { getResearchSourceServiceClient } from "../providers/source-service-client.js";
import {
	Run,
	initializeRunState,
	buildFindOutReportWriterSystemPrompt,
	PrimeSearchBatchExecutor,
	createProductionResearchStageRunner,
	primeReportWriterContractIdentity,
	primeProviderCatalog,
	primeSearchBatchContractIdentity,
	WriterOutputSchema,
	type CornellNotesMaterializer,
	type SearchBatchExecutor,
} from "./pipeline/index.js";
import {
	CheckpointingAgentStageRunner,
	type AgentStageRunner,
	type AgentStageActivity,
	type AgentStageRequest,
} from "../agent-runtime/agent-stage-runtime.js";
import { ExecutableReportPlanSchema } from "./pipeline/report-plan.js";
import { RunStateStore, type RunIdentityPins, type RunStateV2 } from "./run-state.js";
import { type PublishedArtifactRef } from "../agent-runtime/artifact-store.js";
import {
	resolveResearchTemporalContext,
	resolveScheduledResearchTemporalContext,
} from "./temporal-context.js";
import type { ScheduledResearchContext } from "./scheduled-research-context.js";
import type { ResearchProgressEvent, ResearchRuntimeConfig } from "./research-types.js";
import type { RunContextSnapshot } from "./run-context.js";
import type { GoalTopicPlan } from "../goals/topic-plan/index.js";
import { createGoalLlmWikiTools, LlmWikiCompiler,
	type WikiCompilationResult } from "../wiki/index.js";
import { publishCompilation } from "../wiki/publication.js";
import { materializeSkills } from "../agent-runtime/skill-registry.js";
import { caseCapture } from "../observability/case-capture.js";

export interface ResearchRunRequest {
	runId: string;
	goalId?: string;
	goalTitle?: string;
	goalDescription?: string;
	goalLanguage?: ResolvedOutputLanguage;
	question: string;
	reportContext: string;
	noteFocus?: string;
	discoveryEnabled: boolean;
	workspaceDirectory: string;
	controlDirectory: string;
	goalWorkspaceDirectory?: string;
	workspaceRootDirectory?: string;
	organizerStorageRoot?: string;
	env?: Record<string, string | undefined>;
	config?: Partial<ResearchRuntimeConfig>;
	signal?: AbortSignal;
	onProgress?: (event: ResearchProgressEvent) => void;
	onAgentOutput?: (activity: AgentStageActivity) => void;
	/** 没有 wikiCompilation 就是 Find Out 模式：Knowledge 视图当场从冻结的 Cornell Notes 物化。 */
	reportInput?: {
		sourceRunId: string;
		cornellNotesArtifact: PublishedArtifactRef;
		wikiCompilation?: WikiCompilationResult;
		knowledgeInput?: { ref: string; sha256: string; byteLength: number };
	};
	reportTools?: readonly AgentTool[];
	scheduledResearch?: ScheduledResearchContext;
	researchHarnessSnapshot?: ResearchHarnessSnapshot;
	runContextSnapshot: RunContextSnapshot;
	topicPlan?: GoalTopicPlan;
	/** Registry ids left out of this Run's Provider Catalog: sources switched off or verified unusable. */
	excludedSources?: readonly string[];
}

export interface ResearchRunResult {
	execution: ResearchExecutionResult;
	state: RunStateV2;
	config: ResearchRuntimeConfig;
}

export class ResearchRuntime {
	constructor(private readonly options: {
		stageRunner?: AgentStageRunner;
		searchBatchExecutor?: SearchBatchExecutor;
		evidenceMaterializer?: CornellNotesMaterializer;
	} = {}) {}

	async run(request: ResearchRunRequest): Promise<ResearchRunResult> {
		if (typeof request.reportContext !== "string" || !request.reportContext.trim()) {
			throw new Error("Research Runtime requires non-empty reportContext");
		}
		if (!request.question.trim()) throw new Error("Research Run requires a non-empty question");
		if (!request.goalWorkspaceDirectory || !request.workspaceRootDirectory) {
			throw new Error("Research Run requires a Goal Workspace for Wiki compilation");
		}
		if (!request.researchHarnessSnapshot) {
			throw new Error("Research Run requires a pinned Research Harness Snapshot");
		}
		const signal = request.signal ?? new AbortController().signal;
		// Run start is the boundary: from here the Run's models are fixed, whatever the global
		// configuration becomes while it executes.
		const env = freezeRunModelSelection(
			{
				...request.env,
				...(request.config?.cornellNoteModel ? { TELOMI_RESEARCH_CORNELL_NOTE_MODEL: request.config.cornellNoteModel } : {}),
				...(request.config?.cornellNoteThinkingLevel ? { TELOMI_RESEARCH_CORNELL_NOTE_THINKING_LEVEL: request.config.cornellNoteThinkingLevel } : {}),
			},
			request.controlDirectory,
		);
		const config = runConfig(researchConfigFromEnv(env), request.config);
		const releaseRunSelection = trackRunModelSelection(runModelSelection(env));
		try {
			mkdirSync(request.workspaceDirectory, { recursive: true });
			mkdirSync(request.controlDirectory, { recursive: true });
			const identityPins = buildIdentityPins(request, env, config);
			initializeRunState({
				runId: request.runId,
				goalId: request.goalId ?? request.runId,
				question: request.question.trim(),
				language: config.outputLanguage,
				identityPins,
				topicPlan: request.topicPlan,
				workspaceDirectory: request.workspaceDirectory,
				controlDirectory: request.controlDirectory,
			});
			const skillWorkspaceDirectory = join(request.controlDirectory, "skill-snapshot");
			for (const [agentId, snapshot] of Object.entries(request.researchHarnessSnapshot.agentSkills)) {
				materializeSkills(snapshot.skills, join(skillWorkspaceDirectory, agentId));
			}
			const registry = createHarnessResearchSourceRegistry(request.researchHarnessSnapshot, env);
			const primeOptions = { env };
			const productionStageRunner = this.options.stageRunner ?? createProductionResearchStageRunner(primeOptions);
			// Capture 关闭时 Research Run 直接使用生产 Stage Runner，不写任何 Evaluation Case。
			const capture = caseCapture();
			const baseStageRunner = new CheckpointingAgentStageRunner(
				capture?.researchStages
					? capture.researchStages(productionStageRunner, request.researchHarnessSnapshot.workspaceDir)
					: productionStageRunner,
			);
			const stageRunner = request.onAgentOutput
				? withAgentOutput(baseStageRunner, request.onAgentOutput)
				: baseStageRunner;
			const wikiTools = createGoalLlmWikiTools({ goalDir: request.goalWorkspaceDirectory });
			const evidenceMaterializer = this.options.evidenceMaterializer
				?? await createProductionCornellNotesMaterializer({
					harness: request.researchHarnessSnapshot,
					config,
					stageRunner,
					dataDir: request.workspaceRootDirectory,
					env,
					skillWorkspaceDirectory,
				});
			const sourceCatalog = registry.catalog();
			const productionSearchBatchExecutor = new PrimeSearchBatchExecutor(
				registry, request.researchHarnessSnapshot, { env, skillWorkspaceDirectory },
			);
			const searchBatchExecutor = this.options.searchBatchExecutor
				?? (capture?.primeSearchBatch
					? capture.primeSearchBatch(productionSearchBatchExecutor, {
						env,
						skillWorkspaceDirectory,
						availableProviders: primeProviderCatalog(sourceCatalog, Object.fromEntries(sourceCatalog.map((provider) => [
							provider.id, provider.workerSkills ?? [],
						]))),
					})
					: productionSearchBatchExecutor);
			const temporalContext = request.scheduledResearch
				? resolveScheduledResearchTemporalContext(request.scheduledResearch)
				: resolveResearchTemporalContext(request.question);
			const providerCatalog = sourceCatalog.filter((provider) => {
				const allowed = request.researchHarnessSnapshot!.primeSearch.policy.allowedSources;
				return Boolean(provider.workerPython || provider.workerTool)
					&& (allowed.includes("*") || allowed.includes(provider.id))
					&& !request.excludedSources?.includes(provider.id);
			});
			if (providerCatalog.length === 0) {
				throw new Error("Prime Search has no allowed Provider");
			}
			const run = new Run({
				stageRunner,
				searchBatchExecutor,
				evidenceMaterializer,
				validateCitationUrls: (markdown, signal) =>
					getResearchSourceServiceClient().validateCitationUrls(markdown, signal),
				wikiAgent: new LlmWikiCompiler(),
				publishWikiCompilation: publishCompilation,
			});
			const result = await run.run({
					runId: request.runId,
					goalId: request.goalId ?? request.runId,
					goalTitle: request.goalTitle,
					goalDescription: request.goalDescription,
					...(request.goalLanguage ? { goalLanguage: request.goalLanguage } : {}),
					question: request.question.trim(),
					reportContext: request.reportContext,
					...(request.noteFocus ? { noteFocus: request.noteFocus } : {}),
					discoveryEnabled: request.discoveryEnabled,
					language: config.outputLanguage,
					workspaceDirectory: request.workspaceDirectory,
					controlDirectory: request.controlDirectory,
					skillWorkspaceDirectory,
					...(request.goalWorkspaceDirectory ? { goalWorkspaceDirectory: request.goalWorkspaceDirectory } : {}),
					...(request.workspaceRootDirectory ? { workspaceRootDirectory: request.workspaceRootDirectory } : {}),
					...(request.organizerStorageRoot ? { organizerStorageRoot: request.organizerStorageRoot } : {}),
					providerCatalog,
					temporalContext,
					pipeline: {
						...cornellNoteAgentContractIdentity(),
					},
				identityPins,
				...(request.topicPlan ? { topicPlan: request.topicPlan } : {}),
					env,
					signal,
					...(request.reportInput ? { reportInput: request.reportInput } : {}),
					...(wikiTools.length ? { wikiTools } : {}),
					...(request.reportTools?.length ? { reportTools: request.reportTools } : {}),
					...(request.scheduledResearch ? { scheduledResearch: request.scheduledResearch } : {}),
					onProgress: (event) => request.onProgress?.({
						stage: event.stage as ResearchProgressEvent["stage"],
						status: event.status,
						...(event.sequence === undefined ? {} : { sequence: event.sequence }),
						...(event.detail ? { detail: event.detail } : {}),
					}),
					onAgentOutput: request.onAgentOutput,
			});
			return { execution: result.execution, state: result.state, config };
		} catch (error) {
			// Initialization can fail before the pipeline installs its own failure handling.
			try {
				const store = new RunStateStore(request.controlDirectory);
				if (signal.aborted && store.isActive()) {
					const state = store.load()!;
					const now = new Date().toISOString();
					store.save(state, {
						...state, status: "cancelled", updated_at: now, finished_at: now,
						failure: {
							failure_class: "cancelled", failed_stage: state.status,
							message: "Research Run cancelled by request", cancellation_source: "request_signal",
						},
					});
				} else {
					store.recoverInterrupted();
				}
			} catch { /* preserve the original error */ }
			throw error;
		} finally {
			releaseRunSelection();
		}
	}
}

function runConfig(
	envConfig: ResearchRuntimeConfig,
	requestConfig?: Partial<ResearchRuntimeConfig>,
): ResearchRuntimeConfig {
	return {
		...envConfig,
		...requestConfig,
		cornellNoteModel: envConfig.cornellNoteModel,
		cornellNoteThinkingLevel: envConfig.cornellNoteThinkingLevel,
	};
}

function withAgentOutput(
	stageRunner: AgentStageRunner,
	onAgentOutput: (activity: AgentStageActivity) => void,
): AgentStageRunner {
	return {
		runStage: <T>(stageRequest: AgentStageRequest<T>) =>
			stageRunner.runStage({
				...stageRequest,
				onActivity: (activity) => {
					stageRequest.onActivity?.(activity);
					onAgentOutput(activity);
				},
			}),
	};
}

function buildIdentityPins(
	request: ResearchRunRequest,
	env: NodeJS.ProcessEnv,
	config: ResearchRuntimeConfig,
): RunIdentityPins {
	const harness = request.researchHarnessSnapshot!;
	const findOutContract = cornellNoteAgentContractIdentity();
	// The Run's own frozen environment, so the pinned identity names the models it will run on.
	const primeSearchContract = primeSearchBatchContractIdentity(env);
	const primeReportContract = primeReportWriterContractIdentity(env);
	return {
		harness_snapshot: hashRuntimeIdentityJson({
			contract_version: harness.contractVersion,
			source: harness.source,
			run_policy_hash: harness.runPolicyHash,
			prime_search_hash: harness.primeSearch.snapshotHash,
			agent_skills: Object.fromEntries(Object.entries(harness.agentSkills).map(([agentId, value]) => [
				agentId, value.skills.map((skill) => skill.sha256),
			])),
		}),
		workspace_content_hash: request.runContextSnapshot.workspaceContentHash,
		knowledge_memory_hash: request.runContextSnapshot.knowledgeMemoryHash,
		run_context_snapshot: hashRunContextIdentity(request.runContextSnapshot, request),
		pipeline: hashRuntimeIdentityJson(findOutContract),
		prompt_bundle: hashRuntimeIdentityJson({
			search_acquisition: primeSearchContract.promptBundle,
			find_out: findOutContract,
			report_flow: {
				prime_writer: primeReportContract,
				writer_system: buildFindOutReportWriterSystemPrompt(),
			},
		}),
			schema_bundle: hashRuntimeIdentityJson({
			search_acquisition: primeSearchContract.schema,
			executable_report_plan: ExecutableReportPlanSchema,
			writer_output: WriterOutputSchema,
			run_state: 2,
			report_flow: 1,
			find_out: findOutContract,
		}),
		model_policy: hashRuntimeIdentityJson({
			prime_search: { root: primeSearchContract.rootModel, child: primeSearchContract.childModel },
			prime_report: primeReportContract,
			cornell_note: config.cornellNoteModel,
			// Reasoning depth is configuration too, so it belongs to the Run's identity: a Run that
			// reasoned less deeply is not the same Run as one that reasoned more.
			stage_thinking: runModelSelection(env).stageThinkingLevels,
		}),
		skill_bundle: hashRuntimeIdentityJson(Object.fromEntries(
			Object.entries(harness.agentSkills).map(([agentId, snapshot]) => [
				agentId,
				snapshot.skills.map((skill) => skill.sha256).sort(),
			]),
		)),
		tool_schema: hashRuntimeIdentityJson({
			bash: "pi-coding-agent-bash",
			// research_runtime.search_general_web(query, max_results) over the Prime bridge.
			search_general_web: { query: "string", max_results: "integer 1..50, default 10" },
			submit_stage_output: {},
		}),
		...(request.scheduledResearch
			? { scheduled_research: hashRuntimeIdentityJson(request.scheduledResearch) }
			: {}),
	};
}

/** The Run Context pin. `note_focus` is only present when set, so Runs without one keep their historical pin. */
export function hashRunContextIdentity(
	snapshot: unknown,
	request: { question: string; reportContext: string; noteFocus?: string },
): string {
	return hashRuntimeIdentityJson({
		snapshot,
		search_question: request.question,
		report_context: request.reportContext,
		...(request.noteFocus ? { note_focus: request.noteFocus } : {}),
	});
}

export function hashRuntimeIdentityJson(value: unknown): string {
	// Persisted Run identity pins use insertion-order JSON, including checkpoint resume checks.
	return sha256(JSON.stringify(value));
}
