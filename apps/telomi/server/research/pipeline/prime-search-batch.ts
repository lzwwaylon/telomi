import { primeExecutionToken } from "../../../../extensions/telomi-srt/prime-workspace.js";
import { effectiveProviderWorkerSkills } from "../../agent-runtime/provider-skills.js";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { appendScheduledResearchSystemPrompt, renderScheduledResearchUserContext } from "../scheduled-research-context.js";
import type { ResearchHarnessSnapshot } from "../harness/snapshot.js";
import { snapshotLogicalWorkspace } from "../../agent-runtime/logical-workspace-snapshot.js";
import { resolvePrimeAgentModels } from "../../agent-runtime/model-policy.js";
import type { PiSettings } from "../../config/settings.js";
import {
	resolveStageThinkingLevel,
	type ThinkingLevel,
} from "../../agent-runtime/model-config/resolve.js";
import {
	agentSessionPath,
	appendResearchNodeRecord,
	appendRuntimeContext,
	latestNodeDependencyIds,
} from "../../observability/run-records.js";
import { renderAgentPrompt } from "../../agent-runtime/prompt-registry.js";
import {
	materializedSkillIdentity,
	materializeSkills,
	snapshotSkills,
	type SkillSnapshot,
} from "../../agent-runtime/skill-registry.js";
import { inspectAgentSourceView, materializeAgentSourceView } from "./agent-source-view.js";
import {
	PRIME_AUTONOMOUS_CONFIG,
	PRIME_AUTO_REFINE_ENABLED,
	primeAgentModulePath,
	primeKernelPython,
	primeModelErrorText,
} from "../../agent-runtime/prime-agent-paths.js";
import { observeModelFailureText, observeModelOutcome } from "../../agent-runtime/model-config/model-verdicts.js";
import { spawnPrimeWorker } from "../../agent-runtime/prime-worker.js";
import { preparePythonSkillEnvironment } from "../../agent-runtime/python-environment.js";
import { resolveDataDir } from "../../config/data-dir.js";
import { hashJson, sha256, stableJson } from "../../lib/hash.js";
import { materializeProviderSdkAssets, renderProviderApiReference, resolveWorkerPythonTool } from "../provider-sdk-assets.js";
import { readProviderCallRecords, type ProviderCallRecord, type ProviderCallRecorder } from "../../providers/provider-call-record.js";
import { ProviderOverloadBudget, type ProviderOverloadState } from "../sources/provider-runtime.js";
import type { ResearchSourceRegistry } from "../sources/registry.js";
import type { ResearchSearchResult } from "../../providers/search-types.js";
import type { ResearchModelUsage } from "../../agent-runtime/model-usage.js";
import type { ResearchTemporalContext } from "../research-types.js";
import {
	derivePrimeSearchSourceId,
	validateSearchExecutionRecord,
	type ProviderExecution,
	type SearchExecutionRecord,
} from "../../providers/search-contracts.js";
import { cloneFilesBatched } from "../../lib/cow.js";
import {
	snapshotSourceDirectory,
	validateSourceBundleDirectory,
	writeSourceBundleIndex,
} from "./source-bundle.js";
import type {
	SearchBatchExecutor,
	SearchBatchRequest,
	SearchBatchResult,
} from "./search-batch.js";
import type { AgentStageActivity } from "../../agent-runtime/agent-stage-runtime.js";
import {
	materializeFindOutSources,
	type FindOutSourceMember,
	type FindOutSourceOrganization,
} from "./find-out-sources.js";
import {
	ORGANIZER_COMPLETE_MARKER,
	ORGANIZER_RUNTIME_INDEX,
	PROVIDER_EXECUTIONS_DIRECTORY,
	primeProviderAssignments,
	validatePrimeOrganizerDecisionFile,
	validatePrimeSearchCandidateLedger,
} from "./prime-search-contract.js";
import { preserveProviderChildTasks, providerExecutionWorkspace } from "./provider-execution-workspace.js";
import { materializeBrowserSource, parseMaterializeSource } from "./browser-materialize.js";
import { assertBrowserToolChild, browserToolClientConfigFromEnv, executeBrowserTool, type BrowserToolClientConfig } from "../../providers/browser/tool-router.js";
import { providerToolRuntime } from "./provider-tool-runtime.js";
import {
	loadPrimeSourceOrganizerIndex,
	preparePrimeSourceOrganizerIndex,
	projectPrimeSourceOrganizerInput,
	projectPrimeSourceOrganizerMembers,
	projectPrimeSourceOrganization,
	writePrimeSourceOrganizerIndex,
	type PrimeSourceOrganizerIndex,
	type PrimeSourceOrganizerItem,
} from "./prime-source-organizer-index.js";
import { emptyWorkspaceSnapshot, snapshotWorkspaceTree } from "../../agent-runtime/workspace-snapshot.js";
import { isInsideRoot } from "../../lib/paths.js";
import { isRecord, toErrorMessage } from "../../lib/values.js";
import { ResearchNodeError } from "../../agent-runtime/retry-policy.js";
import { listFilesRecursive } from "../../lib/fs.js";
import { comparePaths } from "../../lib/paths.js";

const PRIME_SEARCH_SDK_WORKER = fileURLToPath(new URL("./prime-search-sdk-worker.ts", import.meta.url));
/**
 * Root 只做子 Agent 编排，Provider children 使用同一轻量 child model。
 */
/** The Stage's reasoning depth as this execution froze it. */
function primeSearchRootThinking(env: NodeJS.ProcessEnv, settingsOverride?: PiSettings): ThinkingLevel {
	return resolveStageThinkingLevel("primeRoot", "searchAcquisition", env, settingsOverride).thinkingLevel;
}

interface PrimeSourceItem {
	provider_execution_id: string;
	provider_id: string;
	candidate_id: string;
	title: string;
	url: string;
	query: string;
	summary: string;
	metadata: Record<string, unknown>;
	directory: string;
}

interface PrimeLedgerCandidate extends Omit<PrimeSourceItem, "directory" | "candidate_id"> {
	candidate_ref: string;
	material_paths: string[];
	material_root: string;
}

type PrimeProviderExecution = ProviderExecution & { workspace_path?: string };

export interface PrimeProviderLogEntry {
	child_id?: string;
	source: string;
	operation: string;
	query: string;
	status: "succeeded" | "failed";
	result_count: number;
	error?: string;
}

export interface PrimeAvailableProvider {
	provider_id: string;
	capability: string;
	capabilities: readonly string[];
	evidence_types: readonly string[];
	full_text_availability: string;
	worker_interface: {
		kind: "python_skill";
		required_skills: string[];
		required_skill_paths?: string[];
	} | {
		kind: "runtime_tool";
		required_tools: ["browser", "materialize_source"];
		required_skills: string[];
		required_skill_paths?: string[];
	};
	candidate_ledger: string;
}

export function primeSearchBatchContractIdentity(
	env: NodeJS.ProcessEnv = process.env,
	settingsOverride?: PiSettings,
) {
	const models = resolvePrimeAgentModels(env, settingsOverride);
	return {
		id: "prime-search-batch",
		version: 65,
		rootModel: models.root.selector,
		childModel: models.child.selector,
		thinkingLevel: primeSearchRootThinking(env, settingsOverride),
		autoRefine: PRIME_AUTO_REFINE_ENABLED,
		autonomous: PRIME_AUTONOMOUS_CONFIG.enabled,
		executionAdapter: "prime-sdk-rlm-quiescence-v2",
		candidateLedgerValidation: "sdk-custom-tool-candidate-materials-v6",
		providerWorkerSkills: "catalog-declared-bundled-skill-with-goal-override",
		organizerWorkspace: "metadata-only-ipython-no-rlm",
		promptBundle: {
		acquisition: "root-web-native-provider-children-v51",
			organizer: "incremental-source-group-patch-v7",
		},
		schema: {
			candidate_ledger: 2,
			organizer_decision: 2,
			organizer_index: 2,
			source_index: 2,
			source_record: 2,
			organizer_groups: 1,
		},
	};
}

/** Prime acquisition Module: Provider children discover and retain, Runtime materializes every Ledger candidate. */
export class PrimeSearchBatchExecutor implements SearchBatchExecutor {
	private readonly env: NodeJS.ProcessEnv;

	constructor(
		private readonly registry: ResearchSourceRegistry,
		private readonly harness: ResearchHarnessSnapshot,
		private readonly options: {
			env?: NodeJS.ProcessEnv;
			skillWorkspaceDirectory?: string;
			rootUserPromptOverride?: string;
		} = {},
	) {
		this.env = options.env ?? process.env;
	}

	async execute(request: SearchBatchRequest): Promise<SearchBatchResult> {
		const catalog = this.registry.catalog();
		const sources = [...new Set(request.availableProviderIds)].map((providerId) => {
			const source = catalog.find((entry) => entry.id === providerId);
			if (!source) throw new Error(`Search Root received unknown available Provider '${providerId}'`);
			return source;
		});
		if (sources.length === 0) throw new Error("Search Root requires at least one available Provider");
		const selectedSources = [...new Map(sources.filter((source) => source.id !== "general_web").map((source) => [source.id, source])).values()];
		if (!catalog.some((source) => source.id === "general_web")) throw new Error("Search Root requires the General Web Provider");
		// Stage 目录按生命周期归属分三段，而不是一个混用的临时目录：
		//   agent/    Provider children 写 ledger/artifact，Runtime 写 source/，Organizer 写 organizer/。
		//   runtime/  Runtime 拥有：Agent 会话、Provider 日志、sandbox profile、隔离的 SDK。
		//   bundles/  Runtime 私有的 Source Bundle 组装区，Agent 不可见。
		// 一次性目录会把"回收执行现场"和"删除产物"变成同一个动作，中断即全失。
		const stageRoot = join(request.controlDirectory, "workspaces", safeId(`search-batch-${request.sequence}`));
		const root = join(stageRoot, "agent");
		const runtimeRoot = join(stageRoot, "runtime");
		const bundlesRoot = join(stageRoot, "bundles");
		const reuse = reuseInterruptedStage(stageRoot, root, request);
		for (const directory of [root, runtimeRoot, bundlesRoot]) mkdirSync(directory, { recursive: true });
		mkdirSync(join(root, "work"), { recursive: true });
		const workspace = Object.assign(request.workspaceSnapshot ?? emptyWorkspaceSnapshot(), {
			input_tree_source: "empty-work-dir" as const,
		});
		await snapshotWorkspaceTree(workspace, "input", root);
		if (reuse.archivedPath) {
			appendRuntimeContext(request.controlDirectory, "research", {
				type: "runtime.prime_search_scene_archived",
				sequence: request.sequence,
				archived_path: reuse.archivedPath,
			});
		}
		if (reuse.sources) {
			appendRuntimeContext(request.controlDirectory, "research", {
				type: "runtime.prime_search_checkpoint_reused",
					sequence: request.sequence,
					source_count: reuse.sources?.length ?? 0,
				});
		}
		const sdkRoot = join(runtimeRoot, "sdk");
		// SDK 是每次重新铺的 Runtime 输入，且以只读权限落盘，复用旧目录会让拷贝直接 EACCES。
		rmSync(sdkRoot, { recursive: true, force: true });
		mkdirSync(sdkRoot, { recursive: true });
		// Provider children are sandboxed away from Runtime-private paths.
		const providerLogPath = join(root, "work", "provider.jsonl");
		const primeModule = primeAgentModulePath(this.env);
		let bridge: Awaited<ReturnType<typeof startPrimeSourceBridge>> | undefined;
		const stageId = `prime-search-batch-${request.sequence}`;
		const executionId = request.attemptId ?? `${stageId}-${randomUUID().slice(0, 8)}`;
		const providerTools = providerToolRuntime(selectedSources, request, executionId, this.env);
		const browserSignal = providerTools ? AbortSignal.any([request.signal, providerTools.signal]) : request.signal;
		const startedAt = new Date().toISOString();
		const dependencies = latestNodeDependencyIds(request.controlDirectory, "research");
		const sessionPath = agentSessionPath(request.controlDirectory, "prime_search", executionId);
		appendFileSync(sessionPath, `${JSON.stringify({
			type: "message",
			timestamp: Date.now(),
			message: { role: "assistant", content: [{ type: "text", text: "Prime Search 正在检索资料" }] },
		})}\n`, "utf-8");
		appendRuntimeContext(request.controlDirectory, "research", {
			type: "runtime.agent_bound",
			stage_id: stageId,
			execution_id: executionId,
			attempt: 1,
			agent: "prime_search",
			session_file: basename(sessionPath),
		});
		let terminalStatus: "succeeded" | "failed" | "cancelled" = "failed";
		let terminalOutput: Record<string, unknown> = {};
		let unregisterProviderToolWorkspace: (() => void) | undefined;
		try {
			if (providerTools) unregisterProviderToolWorkspace = providerTools.registerWorkspace(root);
			stageProviderSdk(sdkRoot, selectedSources);
			// A Goal Skill named after a Provider worker Skill overrides that Provider's bundled Skill.
			// It must not also register as a Root Agent Skill, or Prime would load the name twice.
			const goalSkills = new Map(this.harness.agentSkills["prime-search"].skills.map((asset) => [
				asset.name,
				this.options.skillWorkspaceDirectory
					? join(this.options.skillWorkspaceDirectory, "prime-search", asset.name)
					: asset.sourcePath,
			]));
			const providerSkillNames = new Set(catalog.flatMap((source) => source.workerSkills ?? []));
			const configuredRootAgentSkills = [...goalSkills]
				.filter(([name]) => !providerSkillNames.has(name))
				.map(([, path]) => path);
			const rootAgentSkillRoots = stageRootAgentSkills(root, configuredRootAgentSkills);
			const rootAgentSkillFiles = rootAgentSkillRoots.map((skill) =>
				relative(root, lstatSync(skill).isDirectory() ? join(skill, "SKILL.md") : skill));
			const rootPythonPaths = (await Promise.all(rootAgentSkillRoots.map((skill) =>
				lstatSync(skill).isDirectory()
					? preparePythonSkillEnvironment(skill, { dataDir: resolveDataDir(), env: this.env })
					: undefined))).flatMap((prepared) => prepared?.pythonPaths ?? []);
			const providerWorkerSkills = stageProviderWorkerSkills(
				root,
				effectiveProviderWorkerSkills(selectedSources, goalSkills),
				selectedSources,
				primeKernelPython(this.env),
			);
			const providerSkillRoots = Object.values(providerWorkerSkills).flat();
			const availableProviders = primeProviderCatalog(
				selectedSources,
				providerWorkerSkills,
			);
			const browserBridgeConfig = providerTools ? browserToolClientConfigFromEnv({ ...this.env, ...providerTools.env }) : undefined;
			bridge = await startPrimeSourceBridge(
				this.registry,
				new Set(selectedSources.map((source) => source.id)),
				{ ...request, signal: browserSignal },
				root,
				{ runDir: request.controlDirectory, nodeId: stageId, attemptId: executionId },
				{
					...(browserBridgeConfig ? { browser: { config: browserBridgeConfig, root } } : {}),
					conditionsPath: join(runtimeRoot, "execution-conditions.jsonl"),
				},
			);
			const models = resolvePrimeAgentModels(this.env);
			const rootProvider = models.root.provider;
			const rootModel = models.root.modelId;
			const childModel = models.child.selector;
			const rootEnv: NodeJS.ProcessEnv = {
				PRIME_AGENT_SOURCE_URL: bridge.baseUrl,
				PRIME_AGENT_SOURCE_TOKEN: bridge.token,
				PRIME_AGENT_SOURCE_IDS: selectedSources.map((source) => source.id).join(","),
				PRIME_AGENT_SOURCE_LOG: providerLogPath,
				PRIME_AGENT_ARTIFACT_WORKSPACE: root,
				TELOMI_PROVIDER_EXECUTION_WORKSPACES: "1",
				PRIME_AGENT_USER_WORKSPACE: request.workspaceDirectory,
				...(providerSkillRoots.length === 0 && rootAgentSkillRoots.length === 0 ? {} : {
					PYTHONPATH: [
						sdkRoot,
						...providerSkillRoots.map((skill) => join(skill, "src")),
						...rootAgentSkillRoots.filter((skill) => lstatSync(skill).isDirectory()).map((skill) => join(skill, "src")),
						...rootPythonPaths,
						this.env.PYTHONPATH,
					].filter(Boolean).join(delimiter),
					// 隔离的 SDK 目录对 Agent 只读，Python 不能在其中写 __pycache__。
					PYTHONDONTWRITEBYTECODE: "1",
				}),
				...(request.temporalContext.resolvedRange ? {
					PRIME_AGENT_TEMPORAL_START: request.temporalContext.resolvedRange.startDate,
					PRIME_AGENT_TEMPORAL_END: request.temporalContext.resolvedRange.endDate,
				} : {}),
				...providerTools?.env,
			};
			let acquisition: Awaited<ReturnType<typeof runPrime>>;
			let providerToolReleaseReason: "completed" | "aborted" | "error" = "completed";
			try {
				acquisition = reuse.sources ? skippedPrimeRun() : await runPrime({
					module: primeModule,
					cwd: root,
					runtimeRoot,
					readonlyRoots: [sdkRoot, join(root, "skills"), ...rootPythonPaths],
					privateRoots: [bundlesRoot],
					sessionDir: join(runtimeRoot, "acquisition-session", "session"),
					provider: rootProvider,
					model: rootModel,
					prompt: this.options.rootUserPromptOverride ?? primeSearchRootUserPrompt({
						question: request.question,
						temporalContext: request.temporalContext,
						scheduledResearch: request.scheduledResearch,
						topicPlan: request.topicPlan,
						childModel,
						availableProviders,
						rootAgentSkills: rootAgentSkillFiles,
					}),
					contractTools: true,
					skills: [
						...providerSkillRoots,
						...rootAgentSkillRoots,
					],
					tools: ["ipython", "submit_candidate_ledger"],
					thinking: primeSearchRootThinking(this.env),
					scopedModels: [childModel],
					rlmMaxDepth: 1,
					extraEnv: rootEnv,
					env: this.env,
					signal: browserSignal,
					onChildEvent: providerTools?.onChildEvent,
					onActivity: request.onActivity,
					activity: { stageId, attemptId: executionId, role: "prime_search" },
					tracePath: sessionPath,
					conditionsPath: join(runtimeRoot, "execution-conditions.jsonl"),
					launchKind: "root_with_native_rlm_children",
					...(request.logicalWorkspaceCaptureRoot ? { logicalWorkspaceCapture: { root: request.logicalWorkspaceCaptureRoot, key: "root" } } : {}),
				});
			} catch (error) {
				providerToolReleaseReason = request.signal.aborted ? "aborted" : "error";
				throw error;
			} finally {
				await providerTools?.release(providerToolReleaseReason);
			}
			const providerExecutions = primeProviderExecutions(root, request, acquisition.rootError);
			const items = reuse.sources ?? materializePrimeSources(root, providerExecutions, (duplicate) => {
				appendRuntimeContext(request.controlDirectory, "research", {
					type: "runtime.prime_search_duplicate_candidate",
					sequence: request.sequence,
					...duplicate,
				});
			});
			const organizerCache = organizerCachePath(request);
			const organizerItems = primeSourceOrganizerItems(root, items, dirname(organizerCache));
			const preparedOrganizer = preparePrimeSourceOrganizerIndex(
				loadPrimeSourceOrganizerIndex(organizerCache),
				organizerItems,
			);
			const organizerRoot = join(root, "organizer");
			rmSync(organizerRoot, { recursive: true, force: true });
			mkdirSync(organizerRoot, { recursive: true });
			writeFileSync(join(organizerRoot, "input.json"), `${JSON.stringify(
				projectPrimeSourceOrganizerInput(preparedOrganizer.index, preparedOrganizer.newSourceIds),
				null,
				2,
			)}\n`);
			const canGroup = Object.keys(preparedOrganizer.index.sources).length > 1;
			mkdirSync(join(organizerRoot, dirname(ORGANIZER_RUNTIME_INDEX)), { recursive: true });
			writeFileSync(join(organizerRoot, ORGANIZER_RUNTIME_INDEX), `${JSON.stringify({
				index: preparedOrganizer.index,
				new_source_ids: preparedOrganizer.newSourceIds,
			}, null, 2)}\n`);
			const organizerEnv: NodeJS.ProcessEnv = {
				RLM_MAX_DEPTH: "0",
			};
			const organizer = preparedOrganizer.newSourceIds.length === 0 || !canGroup ? skippedPrimeRun() : await runPrime({
				module: primeModule,
				cwd: organizerRoot,
				runtimeRoot,
				privateRoots: [bundlesRoot],
				kernelLogPath: join(runtimeRoot, "organizer-kernel-launches.jsonl"),
				sessionDir: join(runtimeRoot, "organizer-session", "session"),
				provider: rootProvider,
				model: rootModel,
				prompt: primeSourceOrganizerPrompt(preparedOrganizer.newSourceIds.length),
				skills: [],
				tools: ["ipython", "submit_organizer_decision"],
				organizerTools: true,
				thinking: primeSearchRootThinking(this.env),
				scopedModels: [],
				rlmMaxDepth: 0,
				extraEnv: organizerEnv,
				env: this.env,
				signal: request.signal,
				onActivity: request.onActivity,
				activity: { stageId, attemptId: executionId, role: "prime_search" },
				tracePath: sessionPath,
				conditionsPath: join(runtimeRoot, "execution-conditions.jsonl"),
				launchKind: "standalone_organizer",
				...(request.logicalWorkspaceCaptureRoot ? { logicalWorkspaceCapture: { root: request.logicalWorkspaceCaptureRoot, key: "organizer" } } : {}),
			});
			const organizerIndex = preparedOrganizer.newSourceIds.length > 0 && canGroup
				? acceptOrganizerDecision(request, organizerRoot, preparedOrganizer)
				: preparedOrganizer.index;
			writePrimeSourceOrganizerIndex(join(organizerRoot, "index.json"), organizerIndex);
			writePrimeSourceOrganizerIndex(organizerCache, organizerIndex);
			const organized = materializeOrganizerProjection(root, organizerIndex, organizerItems);
			const organizedMembers = projectPrimeSourceOrganizerMembers(
				organizerIndex,
				organizerItems,
				dirname(organizerCache),
				preparedOrganizer.newSourceIds,
				preparedOrganizer.changedSourceIds,
			);
			const organizationPath = `artifacts/source-organizer/sequence-${request.sequence}.json`;
			existsSync(join(request.artifactStore.root, organizationPath))
				? request.artifactStore.describeFile(organizationPath)
				: request.artifactStore.publishFile(join(root, "organizer", "groups.json"), organizationPath);
			const organizerIndexPath = `artifacts/source-organizer/index-${request.sequence}.json`;
			if (!existsSync(join(request.artifactStore.root, organizerIndexPath))) {
				request.artifactStore.publishFile(join(organizerRoot, "index.json"), organizerIndexPath);
			}
			const result = materializeResult(
				request,
				root,
				bundlesRoot,
				items,
				readProviderLogs(root),
				organized,
				organizedMembers,
				providerExecutions,
				addUsage(acquisition.usage, organizer.usage),
				acquisition.toolCalls + organizer.toolCalls,
				acquisition.agentStages + organizer.agentStages,
			);
			terminalStatus = "succeeded";
			terminalOutput = {
				metrics: {
					input_tokens: result.usage.inputTokens,
					output_tokens: result.usage.outputTokens,
					cost_usd: result.usage.costUsd,
					model_calls: result.usage.calls,
					tool_calls: result.toolCalls,
				},
			};
			return result;
		} catch (error) {
			terminalStatus = request.signal.aborted ? "cancelled" : "failed";
			terminalOutput = { error: toErrorMessage(error) };
			throw error;
		} finally {
			unregisterProviderToolWorkspace?.();
			await bridge?.close();
			preserveProviderChildTasks(root, join(runtimeRoot, "acquisition-session", "session-artifacts"));
			await snapshotWorkspaceTree(workspace, "output", root);
			if (terminalStatus === "succeeded") {
				preserveProviderLogs(root, runtimeRoot);
				preservePrimeDecisionArtifacts(root, runtimeRoot);
				// 产物已经发布，回收体积大的执行现场，但把 Agent 会话另存为可观测证据。
				// 收尾后 Stage 目录不再存在，它的存在因此精确表示"上一次没有跑完"。
				rmSync(sdkRoot, { recursive: true, force: true });
				const traceTarget = join(request.controlDirectory, "prime-search-traces", safeId(executionId));
				mkdirSync(dirname(traceTarget), { recursive: true });
				rmSync(traceTarget, { recursive: true, force: true });
				renameSync(runtimeRoot, traceTarget);
				rmSync(stageRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
			} else {
				appendRuntimeContext(request.controlDirectory, "research", {
					type: "runtime.prime_search_scene_retained",
					sequence: request.sequence,
					status: terminalStatus,
					stage_root: stageRoot,
				});
			}
			const finishedAt = new Date().toISOString();
			appendFileSync(sessionPath, `${JSON.stringify({
				type: "message",
				timestamp: Date.now(),
				message: { role: "assistant", content: [{
					type: "text",
					text: terminalStatus === "succeeded" ? "Prime Search 已完成" : terminalStatus === "cancelled" ? "Prime Search 已取消" : "Prime Search 失败",
				}] },
			})}\n`, "utf-8");
			appendResearchNodeRecord(request.controlDirectory, {
				node_id: stageId,
				node_type: "agent",
				agent: "prime_search",
				execution_id: executionId,
				attempt: 1,
				status: terminalStatus,
					group_id: null,
					depends_on: dependencies,
					input: { sequence: request.sequence, available_provider_ids: request.availableProviderIds },
				output: terminalOutput,
				time: {
					started_at: startedAt,
					finished_at: finishedAt,
					duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
				},
				trace_ref: basename(sessionPath),
				workspace,
			});
		}
	}
}

export function primeProviderCatalog(
	sources: ReturnType<ResearchSourceRegistry["catalog"]>,
	providerWorkerSkills: Record<string, string[]>,
): PrimeAvailableProvider[] {
	const providerSkillNames = Object.fromEntries(Object.entries(providerWorkerSkills).map(([providerId, skills]) => [
		providerId,
		skills.map((skill) => basename(skill)),
	]));
	return sources.filter((source) => source.id !== "general_web").map((source) => {
		const ledgerPrefix = `work/${safeId(source.id)}`;
		const requiredSkills = providerSkillNames[source.id] ?? [];
		const requiredSkillPaths = requiredSkills.map((skill) =>
			`skills/provider-workers/${safeId(source.id)}/${skill}/SKILL.md`);
		return {
			provider_id: source.id,
			capability: source.capability,
			capabilities: source.capabilities ?? [],
			evidence_types: source.evidenceTypes ?? [],
			full_text_availability: source.fullTextAvailability,
			worker_interface: source.workerTool
				? {
					kind: "runtime_tool" as const,
					required_tools: [...source.workerTool.tools] as ["browser", "materialize_source"],
					required_skills: requiredSkills,
					required_skill_paths: requiredSkillPaths,
				}
				: {
					kind: "python_skill" as const,
					required_skills: requiredSkills,
					required_skill_paths: requiredSkillPaths,
				},
			candidate_ledger: `${ledgerPrefix}_candidates.json`,
		};
	});
}

function primeSearchRunContract() {
	return {
		candidateLedger: {
			candidates: [{
				title: "Source title",
				url: "canonical HTTP(S) URL",
				query: "input that found the Source",
				summary: "brief Provider-grounded description for the Organizer and later stages",
				metadata: {},
				materials: ["Provider Tool result record; CandidateLedger derives Runtime-owned paths"],
			}],
		},
		materialPolicy: "Acquire original material when supported and pass Provider Tool result records to CandidateLedger. Never copy, rename, group, or author material paths; Runtime owns storage and derives each Candidate's artifacts.",
	};
}

export function primeSearchRootUserPrompt(input: {
	question: string;
	temporalContext: ResearchTemporalContext;
	scheduledResearch?: SearchBatchRequest["scheduledResearch"];
	topicPlan?: SearchBatchRequest["topicPlan"];
	childModel: string;
	availableProviders: readonly PrimeAvailableProvider[];
	rootAgentSkills: readonly string[];
}): string {
	const runContract = primeSearchRunContract();
	return appendScheduledResearchSystemPrompt(renderAgentPrompt("research", "prime-search", "user", { run_input_json: JSON.stringify({
	question: input.question,
	temporal_context: {
		current_date: input.temporalContext.currentDate,
		time_zone: input.temporalContext.timeZone,
		...(input.temporalContext.resolvedRange ? { resolved_range: {
			kind: input.temporalContext.resolvedRange.kind,
			start_date: input.temporalContext.resolvedRange.startDate,
			end_date: input.temporalContext.resolvedRange.endDate,
			inclusive: input.temporalContext.resolvedRange.inclusive,
			source_text: input.temporalContext.resolvedRange.sourceText,
		} } : {}),
	},
	...(input.scheduledResearch ? { scheduled_research: renderScheduledResearchUserContext(input.scheduledResearch) } : {}),
	...(input.topicPlan ? { topic_plan: input.topicPlan } : {}),
	child_model: input.childModel,
	current_run: {
		available_providers: input.availableProviders,
		provider_child_output_contract: runContract.candidateLedger,
		material_policy: runContract.materialPolicy,
	},
	...(input.rootAgentSkills.length > 0 ? { root_agent_skills: input.rootAgentSkills } : {}),
}, null, 2) }, "acquire").content, input.scheduledResearch);
}

export function primeSourceOrganizerPrompt(newSourceCount: number): string {
	return renderAgentPrompt("research", "prime-search", "user", {
		new_source_count: newSourceCount,
	}, "organize").content;
}

export function stageProviderSdk(
	sdkRoot: string,
	sources: ReturnType<ResearchSourceRegistry["catalog"]>,
): void {
	const pythonSources = sources.filter((source) => source.workerPython);
	if (pythonSources.length > 0) materializeProviderSdkAssets(sdkRoot, pythonSources[0]!, pythonSources.slice(1));
}

/** Rendered from the Provider's Python module into every staged Python-backed Provider Skill. */
const GENERATED_PROVIDER_REFERENCE = "references/API.md";

export function stageProviderWorkerSkills(
	root: string,
	skills: Readonly<Record<string, string[]>>,
	sources: ReturnType<ResearchSourceRegistry["catalog"]>,
	python: string,
): Record<string, string[]> {
	const sourcesById = new Map(sources.map((source) => [source.id, source]));
	return Object.fromEntries(Object.entries(skills).map(([providerId, paths]) => {
		const source = sourcesById.get(providerId);
		if (!source) throw new Error(`Provider '${providerId}' skill has no selected Provider`);
		let hasPythonSkill = false;
		const staged = [...materializeSkills(
			snapshotSkills(paths),
			join(root, "skills", "provider-workers", safeId(providerId)),
		).values()].map((target) => {
			if (!lstatSync(target).isDirectory() || !existsSync(join(target, "SKILL.md"))) {
				throw new Error(`Provider '${providerId}' skill must be a Skill directory`);
			}
			if (!existsSync(join(target, "pyproject.toml"))) return target;
			hasPythonSkill = true;
			const references = join(target, "references");
			mkdirSync(references, { recursive: true });
			writeFileSync(
				join(target, GENERATED_PROVIDER_REFERENCE),
				renderProviderApiReference(resolveWorkerPythonTool(source).module, python),
				"utf-8",
			);
			return target;
		});
		if (source.workerPython && !hasPythonSkill) {
			throw new Error(`Provider '${providerId}' requires one Python-backed Skill`);
		}
		return [providerId, staged];
	}));
}

function stageRootAgentSkills(root: string, skills: readonly string[]): string[] {
	return [...materializeSkills(snapshotSkills(skills), join(root, "skills", "root-agent")).values()];
}

/** Every candidate a Provider child retained in its Ledger becomes a Source; the Organizer merges duplicates later. */
export function materializePrimeSources(
	root: string,
	executions: readonly PrimeProviderExecution[],
	onDuplicate: (duplicate: { candidate_ref: string; kept_candidate_ref: string; url: string }) => void = () => {},
): PrimeSourceItem[] {
	const candidates: PrimeLedgerCandidate[] = [];
	const seenCandidates = new Set<string>();
	for (const execution of executions) {
		const providerId = execution.provider_id;
		const executionRoot = execution.workspace_path
			? safeDirectory(join(root, execution.workspace_path), root, `Provider execution '${execution.execution_id}'`)
			: root;
		const executionWorkRoot = safeDirectory(join(executionRoot, "work"), executionRoot,
			`Provider execution '${execution.execution_id}' work output`);
		const prefix = join(executionWorkRoot, safeId(providerId));
		const executionIdentity = execution.workspace_path ? basename(execution.workspace_path) : undefined;
		validatePrimeSearchCandidateLedger(
			executionRoot, providerId, `${prefix}_candidates.json`, executionIdentity,
		);
		const candidateLedger = JSON.parse(readFileSync(
			safeFile(`${prefix}_candidates.json`, executionWorkRoot, `${providerId} candidate ledger`),
			"utf-8",
		)) as unknown;
		if (!isRecord(candidateLedger) || candidateLedger.schema_version !== 2
			|| candidateLedger.provider_id !== providerId || !Array.isArray(candidateLedger.candidates)) {
			throw new Error(`Provider Worker '${providerId}' candidate ledger has an invalid shape`);
		}
		for (const [index, value] of candidateLedger.candidates.entries()) {
			if (!isRecord(value) || !Array.isArray(value.material_paths) || value.material_paths.length === 0) {
				throw new Error(`Provider Worker '${providerId}' candidate ${index} must include material_paths`);
			}
			const candidateRef = requiredString(value.candidate_ref, `${providerId} candidate ${index} candidate_ref`);
			assertUnique(seenCandidates, candidateRef, "Provider candidate reference");
			candidates.push({
				provider_execution_id: execution.execution_id,
				provider_id: providerId,
				candidate_ref: candidateRef,
				title: requiredString(value.title, `${providerId} candidate ${index} title`),
				url: requiredString(value.url, `${providerId} candidate ${index} url`),
				query: requiredString(value.query, `${providerId} candidate ${index} query`),
				summary: requiredString(value.summary, `${providerId} candidate ${index} summary`),
				metadata: isRecord(value.metadata) ? value.metadata : {},
				material_paths: value.material_paths.map((path, pathIndex) =>
					requiredString(path, `${providerId} candidate ${index} material_paths[${pathIndex}]`)),
				material_root: executionRoot,
			});
		}
	}
	const sourceRoot = join(root, "source");
	rmSync(sourceRoot, { recursive: true, force: true });
	mkdirSync(sourceRoot, { recursive: true });
	const usedDirectories = new Set<string>();
	// Two executions of one Provider may list the same URL; that is one object, so the first record wins.
	const keptByCandidateId = new Map<string, PrimeLedgerCandidate>();
	const unique = candidates.filter((candidate) => {
		const candidateId = derivePrimeSearchSourceId(candidate.provider_id, candidate.url).replace(/^source:/u, "candidate:");
		const kept = keptByCandidateId.get(candidateId);
		if (kept) {
			onDuplicate({ candidate_ref: candidate.candidate_ref, kept_candidate_ref: kept.candidate_ref, url: candidate.url });
			return false;
		}
		keptByCandidateId.set(candidateId, candidate);
		return true;
	});
	const items = unique.map((candidate, index): PrimeSourceItem => {
		const candidateId = derivePrimeSearchSourceId(candidate.provider_id, candidate.url)
			.replace(/^source:/u, "candidate:");
		let slug = safeId(candidate.title).toLowerCase();
		if (usedDirectories.has(`${candidate.provider_id}/${slug}`)) slug = `${slug}-${index + 1}`;
		usedDirectories.add(`${candidate.provider_id}/${slug}`);
		const directory = `source/${candidate.provider_id}/${slug}`;
		const destination = join(root, directory);
		mkdirSync(destination, { recursive: true });
		const materials = candidate.material_paths.map((path) => resolvePrimeMaterial(candidate.material_root, path));
		const hasDirectory = materials.some((path) => lstatSync(path).isDirectory());
		const retainedMaterials = hasDirectory
			? materials.filter((path) => lstatSync(path).isDirectory()
				|| isInsideRoot(join(candidate.material_root, "work", "materials"), path))
			: materials;
		for (const [materialIndex, material] of retainedMaterials.entries()) {
			// Independent documents share parser filenames; preserve each tree and its relative asset links.
			const materialDestination = retainedMaterials.length === 1
				? destination : join(destination, "materials", String(materialIndex + 1));
			copyPrimeMaterial(material, materialDestination, true);
		}
		writeFileSync(join(destination, "record.json"), `${JSON.stringify({
			schema_version: 2,
			provider_execution_id: candidate.provider_execution_id,
			provider_id: candidate.provider_id,
			candidate_id: candidateId,
			title: candidate.title,
			url: candidate.url,
			query: candidate.query,
			summary: candidate.summary,
			metadata: candidate.metadata,
		}, null, 2)}\n`);
		return {
			provider_execution_id: candidate.provider_execution_id,
			provider_id: candidate.provider_id,
			candidate_id: candidateId,
			title: candidate.title,
			url: candidate.url,
			query: candidate.query,
			summary: candidate.summary,
			metadata: candidate.metadata,
			directory,
		};
	});
	writeFileSync(join(sourceRoot, "index.json"), `${JSON.stringify({ schema_version: 2, items }, null, 2)}\n`);
	writeFileSync(join(sourceRoot, ".complete"), "");
	try {
		return validatePrimeSource(root, executions);
	} catch (error) {
		rmSync(join(sourceRoot, ".complete"), { force: true });
		throw error;
	}
}

function primeProviderExecutions(root: string, request: Pick<SearchBatchRequest,
	"availableProviderIds" | "sequence">, rootError?: string): PrimeProviderExecution[] {
	const allowed = new Set(request.availableProviderIds);
	const isolated = primeProviderAssignments(root)
		.filter((assignment) => allowed.has(assignment.providerId))
		.map((assignment) => ({
			execution_id: `provider-execution:${request.sequence}:${safeId(assignment.providerId)}:${assignment.childId}`,
			provider_id: assignment.providerId,
			workspace_path: relative(root, dirname(assignment.workRoot)),
		}));
	const dispatched = isolated.sort((left, right) => left.execution_id.localeCompare(right.execution_id));
	if (dispatched.length === 0) {
		// A Root whose model call failed never reached dispatch; report that failure, not its consequence.
		throw new Error(rootError
			? `Search Root model call failed: ${rootError}`
			: "Search Root must dispatch at least one available Provider");
	}
	return dispatched;
}

function primeSourceOrganizerItems(
	root: string,
	items: readonly PrimeSourceItem[],
	organizerRoot: string,
): PrimeSourceOrganizerItem[] {
	return items.map((item) => ({
		...snapshotOrganizerSource(root, item, organizerRoot),
	}));
}

function snapshotOrganizerSource(root: string, item: PrimeSourceItem, organizerRoot: string): PrimeSourceOrganizerItem {
	const sourceId = derivePrimeSearchSourceId(item.provider_id, item.url);
	const sourceDirectory = join(root, item.directory);
	const sourceView = inspectAgentSourceView(sourceDirectory);
	const revisionSha256 = sha256(stableJson([...sourceView.contentFiles, ...sourceView.assetFiles]
		.sort((left, right) => comparePaths(left.relativePath, right.relativePath))
		.map((file) => ({
		path: file.relativePath,
		sha256: file.sha256,
	}))));
	const snapshotPath = `snapshots/${safeId(sourceId)}/${revisionSha256}`;
	const destination = join(organizerRoot, snapshotPath);
	if (!existsSync(destination)) materializeAgentSourceView(sourceDirectory, destination);
	return {
		candidateId: item.candidate_id,
		sourceId,
		providerId: item.provider_id,
		title: item.title,
		url: item.url,
		summary: item.summary,
		revisionSha256,
		snapshotPath,
	};
}

function organizerCachePath(request: Pick<SearchBatchRequest, "organizerStorageRoot" | "controlDirectory">): string {
	const organizerStorageRoot = request.organizerStorageRoot ?? join(dirname(request.controlDirectory), "research-sources");
	return join(organizerStorageRoot, "source-organizer", "index.json");
}

function materializeOrganizerProjection(
	root: string,
	index: ReturnType<typeof loadPrimeSourceOrganizerIndex>,
	organizerItems: readonly PrimeSourceOrganizerItem[],
): FindOutSourceOrganization {
	const organization = projectPrimeSourceOrganization(index, organizerItems);
	const organizerRoot = join(root, "organizer");
	mkdirSync(organizerRoot, { recursive: true });
	writePrimeSourceOrganizerIndex(join(organizerRoot, "index.json"), index);
	writeFileSync(join(organizerRoot, "groups.json"), `${JSON.stringify({ schema_version: 1, ...organization }, null, 2)}\n`);
	writeFileSync(join(organizerRoot, ".complete"), "");
	return organization;
}

function resolvePrimeMaterial(root: string, value: string): string {
	const logical = value.startsWith("/workspace/") ? join(root, value.slice("/workspace/".length)) : value;
	const path = isAbsolute(logical) ? logical : join(root, logical);
	const resolved = realpathSync(path);
	const allowed = [join(root, "artifacts"), join(root, "work", "materials")]
		.filter(existsSync)
		.map((allowedRoot) => realpathSync(allowedRoot));
	if (!allowed.some((allowedRoot) => isInsideRoot(allowedRoot, resolved))) {
		throw new Error(`Provider material must stay under artifacts/ or work/materials/: '${value}'`);
	}
	return resolved;
}

function copyPrimeMaterial(source: string, destination: string, copyDirectoryContents: boolean): void {
	// 先只遍历、建目录、收集 (源, 目标) 对，再一次性批量克隆。逐文件起 `cp -c`
	// 子进程约 5.8ms/文件，对一个两千多文件的仓库要十几秒；批量克隆把子进程数
	// 压到每个目标目录一次。克隆不可用（跨卷等）时退回逐文件拷贝。
	const pairs: Array<{ source: string; target: string }> = [];
	const claimed = new Set<string>();
	collectPrimeMaterial(source, destination, copyDirectoryContents, pairs, claimed);
	if (cloneFilesBatched(pairs)) return;
	for (const pair of pairs) {
		mkdirSync(dirname(pair.target), { recursive: true });
		copyFileSync(pair.source, pair.target);
	}
}

function collectPrimeMaterial(
	source: string,
	destination: string,
	copyDirectoryContents: boolean,
	pairs: Array<{ source: string; target: string }>,
	claimed: Set<string>,
): void {
	const stat = lstatSync(source);
	if (stat.isSymbolicLink()) throw new Error(`Provider material contains symlink '${source}'`);
	if (stat.isDirectory()) {
		const target = copyDirectoryContents ? destination : join(destination, basename(source));
		if (existsSync(join(source, "parser-manifest.json"))) {
			collectAgentSourceView(source, target, pairs, claimed);
			return;
		}
		mkdirSync(target, { recursive: true });
		for (const entry of readdirSync(source)) {
			if (entry === ".git") continue;
			if (entry === ".gitmodules") {
				claim(claimed, join(target, "gitmodules.txt"));
				pairs.push({ source: join(source, entry), target: join(target, "gitmodules.txt") });
				continue;
			}
			if (copyDirectoryContents && ["record.json", "source.json", "manifest.json"].includes(entry)) {
				claim(claimed, join(target, `provider-${entry}`));
				pairs.push({ source: join(source, entry), target: join(target, `provider-${entry}`) });
				continue;
			}
			collectPrimeMaterial(join(source, entry), target, false, pairs, claimed);
		}
		return;
	}
	if (!stat.isFile()) throw new Error(`Provider material must be a file or directory: '${source}'`);
	if (copyDirectoryContents && source.endsWith(".md") && existsSync(join(dirname(source), "parser-manifest.json"))) {
		collectAgentSourceView(dirname(source), destination, pairs, claimed);
		return;
	}
	let name = basename(source);
	if (copyDirectoryContents && name === "record.json") name = "provider-record.json";
	const target = join(destination, name);
	claim(claimed, target);
	pairs.push({ source, target });
}

function collectAgentSourceView(
	sourceDirectory: string,
	destination: string,
	pairs: Array<{ source: string; target: string }>,
	claimed: Set<string>,
): void {
	const view = inspectAgentSourceView(sourceDirectory);
	for (const file of [...view.contentFiles, ...view.assetFiles]) {
		const target = join(destination, file.relativePath);
		claim(claimed, target);
		pairs.push({ source: file.absolutePath, target });
	}
}

// 冲突检查必须同时看磁盘和本批次已认领的目标，否则同一批里两个素材会互相覆盖。
function claim(claimed: Set<string>, target: string): void {
	if (claimed.has(target) || existsSync(target)) throw new Error(`Provider material collision at '${target}'`);
	claimed.add(target);
}

/**
 * The Organizer validates through submit_organizer_decision; if it still ends without a valid decision, the Run keeps
 * going with every new Source ungrouped instead of discarding the whole acquisition.
 */
function acceptOrganizerDecision(
	request: SearchBatchRequest,
	organizerRoot: string,
	prepared: ReturnType<typeof preparePrimeSourceOrganizerIndex>,
): PrimeSourceOrganizerIndex {
	try {
		const index = validatePrimeOrganizerDecisionFile(organizerRoot);
		if (!existsSync(join(organizerRoot, ORGANIZER_COMPLETE_MARKER))) {
			appendRuntimeContext(request.controlDirectory, "research", {
				type: "runtime.prime_search_organizer_unsubmitted",
				sequence: request.sequence,
			});
		}
		return index;
	} catch (error) {
		appendRuntimeContext(request.controlDirectory, "research", {
			type: "runtime.prime_search_organizer_decision_rejected",
			sequence: request.sequence,
			error: toErrorMessage(error),
			new_source_count: prepared.newSourceIds.length,
		});
		return prepared.index;
	}
}

function parseJsonFile(path: string, label: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch (error) {
		throw new Error(`${label} must be valid JSON: ${toErrorMessage(error)}`);
	}
}

function validatePrimeSource(root: string, executions: readonly ProviderExecution[]): PrimeSourceItem[] {
	const sourceRoot = safeDirectory(join(root, "source"), root, "Prime source output");
	if (!safeFile(join(sourceRoot, ".complete"), sourceRoot, "Prime completion marker")) {
		throw new Error("Prime Agent did not create source/.complete");
	}
	const raw = parseJsonFile(safeFile(join(sourceRoot, "index.json"), sourceRoot, "Prime source index"), "Prime source index");
	if (!isRecord(raw) || raw.schema_version !== 2 || !Array.isArray(raw.items)) {
		throw new Error("Prime source/index.json must have schema_version 2 and items[]");
	}
	const executionsById = new Map(executions.map((execution) => [execution.execution_id, execution]));
	const seenCandidates = new Set<string>();
	const seenDirectories = new Set<string>();
	return raw.items.map((value, index) => {
		if (!isRecord(value)) throw new Error(`Prime source item ${index} must be an object`);
		const item: PrimeSourceItem = {
			provider_execution_id: requiredString(value.provider_execution_id, `item ${index} provider_execution_id`),
			provider_id: requiredString(value.provider_id, `item ${index} provider_id`),
			candidate_id: requiredString(value.candidate_id, `item ${index} candidate_id`),
			title: requiredString(value.title, `item ${index} title`),
			url: requiredString(value.url, `item ${index} url`),
			query: requiredString(value.query, `item ${index} query`),
			summary: requiredString(value.summary, `item ${index} summary`),
			metadata: isRecord(value.metadata) ? value.metadata : {},
			directory: requiredString(value.directory, `item ${index} directory`),
		};
		const execution = executionsById.get(item.provider_execution_id);
		if (!execution || execution.provider_id !== item.provider_id) {
			throw new Error(`Prime source item '${item.candidate_id}' does not match a Provider execution`);
		}
		if (!/^https?:\/\//iu.test(item.url)) throw new Error(`Prime source item '${item.candidate_id}' URL must be HTTP(S)`);
		const expectedPrefix = `source/${item.provider_id}/`;
		if (!item.directory.startsWith(expectedPrefix)) {
			throw new Error(`Prime source item '${item.candidate_id}' directory must start with '${expectedPrefix}'`);
		}
		assertUnique(seenCandidates, item.candidate_id, "candidate_id");
		assertUnique(seenDirectories, item.directory, "directory");
		const directory = safeDirectory(join(root, item.directory), sourceRoot, `Source '${item.candidate_id}'`);
		safeFile(join(directory, "record.json"), directory, `Source '${item.candidate_id}' record`);
		if (!hasMaterial(directory)) throw new Error(`Source '${item.candidate_id}' has no downloaded material`);
		return item;
	});
}

function materializeResult(
	request: SearchBatchRequest,
	root: string,
	bundlesRoot: string,
	items: readonly PrimeSourceItem[],
	providerLog: readonly PrimeProviderLogEntry[],
	organization: FindOutSourceOrganization,
	members: readonly (FindOutSourceMember & { changeKind: "new" | "changed" | "unchanged" })[],
	providerExecutions: readonly ProviderExecution[],
	usage: ResearchModelUsage,
	toolCalls: number,
	agentStages: number,
): SearchBatchResult {
	const sourceBundles: SearchBatchResult["sourceBundles"] = [];
	const executionRecords: SearchBatchResult["executionRecords"] = [];
	const providerCalls = readProviderCallRecords(request.controlDirectory)
		.filter((call) => call.node_id === `prime-search-batch-${request.sequence}`);
	for (const execution of providerExecutions) {
		const executionItems = items.filter((item) => item.provider_execution_id === execution.execution_id);
		const attemptId = `attempt:prime:${safeId(execution.execution_id)}:${randomUUID().slice(0, 8)}`;
		const bundleRoot = join(bundlesRoot, safeId(execution.execution_id));
		mkdirSync(join(bundleRoot, "sources"), { recursive: true });
		const indexed = executionItems.map((item, index) => {
			const path = `sources/${String(index + 1).padStart(4, "0")}`;
			snapshotSourceDirectory(join(root, item.directory), join(bundleRoot, path));
			return { path, candidate_id: item.candidate_id, url: item.url, title: item.title };
		});
		writeFileSync(join(bundleRoot, "result.json"), `${JSON.stringify({ sources: indexed.map((item) => ({ path: item.path })) }, null, 2)}\n`);
		writeSourceBundleIndex(bundleRoot, execution.provider_id, indexed);
		const validated = validateSourceBundleDirectory(bundleRoot, execution);
		const relativePath = `artifacts/source-bundles/${safeId(execution.execution_id)}/${safeId(attemptId)}`;
		const bundle = request.artifactStore.publishDirectory(bundleRoot, relativePath, bundlesRoot);
		validateSourceBundleDirectory(bundle.absolutePath, execution);
		sourceBundles.push(bundle);
		const operations = primeProviderOperations(providerLog, execution);
		const providerAccess = primeProviderAccess(providerCalls, execution);
		if (operations.length === 0) operations.push({
			operation: "prime_agent",
			request_ref: "prime:1",
			response_count: 0,
			source_count: executionItems.length,
			status: "succeeded",
		});
		const record = validateSearchExecutionRecord({
			schema_version: 3,
			run_id: request.runId,
			execution_id: execution.execution_id,
			attempt_id: attemptId,
			provider_id: execution.provider_id,
			operations,
			...(providerAccess ? { provider_access: providerAccess } : {}),
			terminal_status: operations.some((operation) => operation.status === "failed") ? "degraded_bundle" : "valid_bundle",
			bundle_ref: bundle.relativePath,
			bundle_quality: {
				source_unit: validated.quality.sourceUnit,
				exact_content_duplicate_count: validated.quality.exactContentDuplicateCount,
				generic_title_count: validated.quality.genericTitleCount,
			},
		}, { runId: request.runId, execution });
		const artifact = request.artifactStore.publishText(
			`${JSON.stringify(record, null, 2)}\n`,
			`artifacts/search-executions/${safeId(attemptId)}.json`,
		);
		executionRecords.push({ record, artifact });
	}
	const findOut = materializeFindOutSources({
		artifactStore: request.artifactStore,
		sequence: request.sequence,
		workingDirectory: root,
		organization,
		members,
	});
	return {
		logicalSources: findOut.sources.sort((left, right) => left.id.localeCompare(right.id)),
		sourceBundles: sourceBundles.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
		findOutSources: findOut.artifact,
		executionRecords: executionRecords.sort((left, right) => left.record.attempt_id.localeCompare(right.record.attempt_id)),
		usage,
		agentStages,
		toolCalls,
	};
}

export async function runPrime(args: {
	/** 只用于 Launch Conditions 记录；启动器自己解析同一模块路径。 */
	module: string;
	cwd: string;
	runtimeRoot: string;
	readonlyRoots?: readonly string[];
	privateRoots?: readonly string[];
	kernelLogPath?: string;
	sessionDir: string;
	provider: string;
	model: string;
	prompt: string;
	skills: string[];
	tools?: string[];
	contractTools?: boolean;
	generalWeb?: { baseUrl: string; token: string };
	organizerTools?: boolean;
	browserTools?: boolean;
	thinking: string;
	scopedModels: string[];
	rlmMaxDepth: number;
	/** Worker 专属变量；Kernel 沙箱、HOME 与 Agent Directory 由启动器提供。 */
	extraEnv: NodeJS.ProcessEnv;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	onActivity?: (activity: AgentStageActivity) => void;
	activity: Pick<AgentStageActivity, "stageId" | "attemptId" | "role">;
	tracePath: string;
	conditionsPath: string;
	launchKind: "root_with_native_rlm_children" | "standalone_organizer" | "provider_child";
	childReplayId?: string;
	serviceTier?: "default" | "priority" | "flex";
	onChildEvent?: (event: unknown) => void;
	logicalWorkspaceCapture?: { root: string; key: "root" | "organizer" };
}): Promise<{ usage: ResearchModelUsage; toolCalls: number; agentStages: number; rootError?: string }> {
	mkdirSync(args.sessionDir, { recursive: true });
	appendFileSync(args.conditionsPath, `${JSON.stringify(primeLaunchConditions(args))}\n`, "utf-8");
	const inputPath = join(dirname(args.sessionDir), "sdk-input.json");
	writeFileSync(inputPath, `${JSON.stringify({
		cwd: args.cwd,
		...(args.childReplayId ? { childReplayId: args.childReplayId, serviceTier: args.serviceTier } : {}),
		sessionDir: args.sessionDir,
		provider: args.provider,
		model: args.model,
		thinking: args.thinking,
		prompt: args.prompt,
		skills: args.skills,
		...(args.tools ? { tools: args.tools } : {}),
		...(args.contractTools ? { contractTools: true } : {}),
		...(args.generalWeb ? { generalWeb: args.generalWeb } : {}),
		...(args.organizerTools ? { organizerTools: true } : {}),
		...(args.browserTools ? { browserTools: true } : {}),
		scopedModels: args.scopedModels,
		rlmMaxDepth: args.rlmMaxDepth,
		...(args.logicalWorkspaceCapture ? { logicalWorkspaceCaptureRoot: args.logicalWorkspaceCapture.root } : {}),
	}, null, 2)}\n`);
	if (args.logicalWorkspaceCapture) snapshotLogicalWorkspace({
		guestCwd: "/workspace",
		mounts: [{ hostPath: args.cwd, guestPath: "/workspace", access: "read-write" }],
	}, join(args.logicalWorkspaceCapture.root, args.logicalWorkspaceCapture.key));
	let liveText = "";
	let rootError: string | undefined;
	let lastTextEmissionAt = 0;
	const emit = (
		status: AgentStageActivity["status"],
		kind: AgentStageActivity["kind"],
		detail: Pick<AgentStageActivity, "text" | "toolName"> = {},
	) => args.onActivity?.({ ...args.activity, status, kind, ...detail });
	emit("running", "status");
	try {
		await spawnPrimeWorker({
			name: "Prime Agent source acquisition",
			worker: PRIME_SEARCH_SDK_WORKER,
			agentRoot: args.cwd,
			runtimeRoot: args.runtimeRoot,
			...(args.readonlyRoots ? { readonlyRoots: args.readonlyRoots } : {}),
			...(args.privateRoots ? { privateRoots: args.privateRoots } : {}),
			...(args.kernelLogPath ? { kernelLogPath: args.kernelLogPath } : {}),
			logDirectory: dirname(args.sessionDir),
			env: args.env,
			extraEnv: { ...args.extraEnv, PRIME_SEARCH_SDK_INPUT: inputPath },
			signal: args.signal,
			onStdoutLine: (line) => {
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					return;
				}
				args.onChildEvent?.(event);
				observeChildModelFailure(event);
				const assistantEvent = event.assistantMessageEvent;
				if (event.type === "message_end" && event.message && typeof event.message === "object") {
					const message = event.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown; provider?: unknown; model?: unknown };
					// The latest Root answer decides: a failed attempt Prime's auto-retry recovered from is not the Root's error.
					if (message.role === "assistant") {
						rootError = message.stopReason === "error" && typeof message.errorMessage === "string" ? primeModelErrorText(message) : undefined;
					}
					appendFileSync(args.tracePath, `${JSON.stringify({
						type: "message",
						timestamp: Date.now(),
						message: event.message,
					})}\n`, "utf-8");
				}
				if (
					event.type === "message_update"
					&& assistantEvent
					&& typeof assistantEvent === "object"
					&& (assistantEvent as Record<string, unknown>).type === "text_delta"
					&& typeof (assistantEvent as Record<string, unknown>).delta === "string"
				) {
					liveText = `${liveText}${(assistantEvent as Record<string, unknown>).delta}`.slice(-2_000);
					const now = Date.now();
					if (now - lastTextEmissionAt >= 200) {
						lastTextEmissionAt = now;
						emit("running", "text", { text: liveText });
					}
				}
				if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
					emit("running", "tool", { text: liveText, toolName: event.toolName });
				}
			},
		});
	} catch (error) {
		emit(args.signal.aborted ? "cancelled" : "failed", "status", { text: liveText });
		throw error;
	}
	emit("succeeded", liveText ? "text" : "status", { text: liveText });
	if (rootError) observeModelFailureText(rootError);
	return {
		...readPrimeUsage([args.sessionDir, join(dirname(args.sessionDir), "session-artifacts")]),
		agentStages: 1,
		...(rootError ? { rootError } : {}),
	};
}

/** A Provider child whose model was refused fails on its own while the Root carries on; its model is still reported. */
function observeChildModelFailure(event: Record<string, unknown>): void {
	if (event.type !== "rlm_child_update" || !event.child || typeof event.child !== "object") return;
	const child = event.child as { model?: unknown; error?: unknown };
	if (typeof child.model === "string" && typeof child.error === "string" && child.error.trim()) observeModelOutcome(child.model, child.error);
}

function primeLaunchConditions(args: Parameters<typeof runPrime>[0]): Record<string, unknown> {
	const skills = snapshotSkills(args.skills, { allowOverrides: true });
	const normalizedPythonPath = args.extraEnv.PYTHONPATH
		?.split(delimiter)
		.map((path) => normalizeConditionPath(path, args))
		.join(delimiter);
	return {
		schema_version: 1,
		launch_kind: args.launchKind,
		stage_id: args.activity.stageId,
		execution_adapter: "sdk",
		prime_module: fileCondition(args.module),
		model: `${args.provider}/${args.model}`,
		thinking: args.thinking,
		prompt: { sha256: sha256(args.prompt), byte_length: Buffer.byteLength(args.prompt) },
		system_prompt: {
			override: null,
			append: null,
			effective_sha256: null,
			reason: "Prime does not expose the rendered effective system prompt to this Runtime",
		},
		skills: skillConditions(skills.skills),
		custom_tools: [
			...(args.contractTools ? ["submit_candidate_ledger"] : []),
			...(args.generalWeb ? ["search_general_web"] : []),
			...(args.organizerTools ? ["submit_organizer_decision"] : []),
			...(args.browserTools ? ["browser", "materialize_source", "read_skill"] : []),
		],
		tools: args.tools ?? "prime-default",
		context_files: false,
		autonomous: {
			enabled: false,
		},
		rlm_quiescence: true,
		...(args.childReplayId ? { agent_session_id: args.childReplayId, rlm_depth: 1, service_tier: args.serviceTier } : {}),
		environment: {
			rlm_max_depth: String(args.rlmMaxDepth),
			provider_source_ids: args.extraEnv.PRIME_AGENT_SOURCE_IDS?.split(",").filter(Boolean) ?? [],
			provider_execution_workspaces: args.extraEnv.TELOMI_PROVIDER_EXECUTION_WORKSPACES ?? null,
			pythonpath_sha256: normalizedPythonPath ? sha256(normalizedPythonPath) : null,
		},
		cwd_scope: relative(dirname(args.conditionsPath), args.cwd).split(sep).join("/") || ".",
		session_scope: relative(dirname(args.conditionsPath), args.sessionDir).split(sep).join("/") || ".",
	};
}

/** Source identities, so a Runtime-generated reference does not change which Skill was loaded. */
function skillConditions(skills: readonly SkillSnapshot[]): { sha256: string; items: Array<{ name: string; sha256: string }> } {
	const items = skills.map((skill) => ({ name: skill.name, sha256: materializedSkillIdentity(skill, [GENERATED_PROVIDER_REFERENCE]) }));
	return { sha256: hashJson(items), items };
}

function normalizeConditionPath(value: string, args: Pick<Parameters<typeof runPrime>[0], "cwd" | "conditionsPath">): string {
	return value
		.replaceAll(args.cwd, "<CWD>")
		.replaceAll(dirname(args.conditionsPath), "<RUNTIME>")
		.replaceAll(dirname(dirname(args.conditionsPath)), "<STAGE>");
}

function fileCondition(path: string): { name: string; sha256: string } {
	return { name: basename(path), sha256: sha256(readFileSync(path)) };
}

function readPrimeUsage(sessionRoots: readonly string[]): { usage: ResearchModelUsage; toolCalls: number } {
	const usage = emptyUsage();
	let toolCalls = 0;
	for (const path of sessionRoots.flatMap((root) => listFilesRecursive(root).map((rel) => join(root, rel))).filter((value) => value.endsWith(".jsonl"))) {
		for (const line of readFileSync(path, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			const event = JSON.parse(line) as unknown;
			if (!isRecord(event) || !isRecord(event.message) || event.message.role !== "assistant") continue;
			if (isRecord(event.message.usage)) {
				usage.inputTokens += finiteNumber(event.message.usage.input);
				usage.outputTokens += finiteNumber(event.message.usage.output);
				usage.calls += 1;
				if (isRecord(event.message.usage.cost)) usage.costUsd += finiteNumber(event.message.usage.cost.total);
			}
			if (Array.isArray(event.message.content)) {
				toolCalls += event.message.content.filter((part) => isRecord(part) && part.type === "toolCall").length;
			}
		}
	}
	return { usage, toolCalls };
}

function readProviderLog(path: string, childId?: string): PrimeProviderLogEntry[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line, index) => {
		const value = JSON.parse(line) as unknown;
		if (!isRecord(value)) throw new Error(`Prime Provider log line ${index + 1} is invalid`);
		// SDK Tools log `contained` for a single-item failure they skipped; it degrades the bundle instead of failing the Run.
		const contained = value.status === "contained";
		const status = contained ? "failed" : value.status;
		if (status !== "succeeded" && status !== "failed") throw new Error(`Prime Provider log line ${index + 1} has invalid status`);
		const error = typeof value.error === "string" && value.error.trim() ? value.error.trim().slice(0, 1000) : contained ? "Contained Tool failure" : undefined;
		return {
			...(childId ? { child_id: childId } : {}),
			source: requiredString(value.source, `Provider log ${index + 1} source`),
			operation: requiredString(value.operation, `Provider log ${index + 1} operation`),
			query: requiredString(value.query, `Provider log ${index + 1} query`),
			status,
			result_count: Math.max(0, Math.trunc(finiteNumber(value.result_count))),
			...(error ? { error } : {}),
		};
	});
}

function providerLogPaths(root: string): Array<{ path: string; childId?: string }> {
	const paths: Array<{ path: string; childId?: string }> = [{ path: join(root, "work", "provider.jsonl") }];
	const executionRoot = join(root, PROVIDER_EXECUTIONS_DIRECTORY);
	if (existsSync(executionRoot)) {
		paths.push(...readdirSync(executionRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && /^sub-[A-Za-z0-9-]+$/u.test(entry.name))
			.map((entry) => ({ path: join(executionRoot, entry.name, "work", "provider.jsonl"), childId: entry.name })));
	}
	return paths.filter((entry) => existsSync(entry.path)).sort((left, right) => left.path.localeCompare(right.path));
}

export function readProviderLogs(root: string): PrimeProviderLogEntry[] {
	return providerLogPaths(root).flatMap((entry) => readProviderLog(entry.path, entry.childId));
}

function preserveProviderLogs(root: string, runtimeRoot: string): void {
	const lines = providerLogPaths(root)
		.flatMap(({ path }) => readFileSync(path, "utf-8").split("\n").filter(Boolean));
	if (lines.length > 0) writeFileSync(join(runtimeRoot, "provider.jsonl"), `${lines.join("\n")}\n`);
}

export function primeProviderOperations(
	providerLog: readonly PrimeProviderLogEntry[],
	execution: Pick<PrimeProviderExecution, "provider_id" | "workspace_path">,
) {
	const childId = execution.workspace_path ? basename(execution.workspace_path) : undefined;
	return providerLog
		.filter((entry) => entry.source === execution.provider_id && (entry.child_id === undefined || entry.child_id === childId))
		.map((entry, index) => ({
			operation: entry.operation,
			request_ref: `prime:${index + 1}`,
			response_count: entry.result_count,
			source_count: entry.result_count,
			status: entry.status,
			...(entry.error ? { error: entry.error } : {}),
		}));
}

/** What the Provider Runtime spent for one Provider execution, from its own call records rather than the Agent-writable log. */
export function primeProviderAccess(
	calls: readonly ProviderCallRecord[],
	execution: Pick<PrimeProviderExecution, "provider_id" | "workspace_path">,
): SearchExecutionRecord["provider_access"] {
	const childId = execution.workspace_path ? basename(execution.workspace_path) : undefined;
	const scoped = calls.flatMap((call) =>
		call.provider === execution.provider_id && call.sub_execution_id === childId && call.execution ? [{ ...call, execution: call.execution }] : []);
	if (scoped.length === 0) return undefined;
	const total = (field: "attempts" | "interval_wait_ms" | "rate_limit_wait_ms") =>
		scoped.reduce((sum, call) => sum + call.execution[field], 0);
	const terminal = scoped.find((call) => call.response.error_code === "source_unavailable");
	return {
		upstream_attempts: total("attempts"),
		interval_wait_ms: total("interval_wait_ms"),
		rate_limit_wait_ms: total("rate_limit_wait_ms"),
		...(terminal ? {
			termination: {
				code: "source_unavailable",
				...(terminal.response.termination_reason ? { reason: terminal.response.termination_reason } : {}),
			},
		} : {}),
	};
}

/**
 * Everything the Prime kernel reaches through `research_runtime` (Python), keyed by the caller's
 * execution id: `root` for the Search Root, `sub-…` for a Provider child (its `work/.execution-id`).
 */
export interface PrimeBridgeOptions {
	/** Runtime Browser Tool bridge for this scope plus the stage root the material paths resolve against. */
	browser?: { config: BrowserToolClientConfig; root: string };
	/** Where skill-read receipts are appended (the stage's execution-conditions.jsonl). */
	conditionsPath?: string;
}

const BRIDGE_ROUTES = new Set([
	"/v1/search",
	"/v1/root-search",
	"/v1/browser",
	"/v1/browser/materialize",
	"/v1/skill-read",
	"/v1/provider-fallback",
]);

function bridgeExecutionId(value: unknown): string {
	const id = typeof value === "string" ? value.trim() : "";
	if (id === "root" || /^sub-[A-Za-z0-9-]+$/u.test(id)) return id;
	throw new Error("agent_session_id must be 'root' or a Provider child execution id");
}

function commandVector(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 64 || value.some((item) => typeof item !== "string")) {
		throw new Error(`${label} must be a non-empty array of strings`);
	}
	return value as string[];
}

export async function startPrimeSourceBridge(
	registry: ResearchSourceRegistry,
	allowedSources: ReadonlySet<string>,
	request: Pick<SearchBatchRequest, "workspaceDirectory" | "temporalContext" | "signal" | "onActivity">,
	artifactWorkspace: string,
	recorder: ProviderCallRecorder,
	options: PrimeBridgeOptions = {},
): Promise<{ baseUrl: string; token: string; close(): Promise<void> }> {
	const token = randomBytes(32).toString("base64url");
	const providerCatalog = new Map(registry.catalog().map((provider) => [provider.id, provider]));
	// One overload budget per Provider Child and Provider, alive as long as this Search Root.
	const overloadBudgets = new Map<string, ProviderOverloadBudget>();
	const selectedFallbacks = new Map<string, string>();
	const providerAccess = (state: ProviderOverloadState, childId: string) => {
		appendRuntimeContext(recorder.runDir, "research", {
			type: "runtime.provider_access",
			provider_id: state.providerId,
			sub_execution_id: childId,
			state: state.state,
			failure_class: state.failureClass,
			wait_started_at: new Date(state.waitStartedAt).toISOString(),
			...(state.state === "cooling" ? {
				budget_deadline_at: new Date(state.budgetDeadlineAt).toISOString(),
				next_attempt_at: new Date(state.nextAttemptAt).toISOString(),
			} : {
				ended_at: new Date(state.endedAt).toISOString(),
				...(state.state === "unavailable" ? { reason: state.reason } : {}),
			}),
		});
		request.onActivity?.({
			stageId: recorder.nodeId,
			attemptId: recorder.attemptId,
			role: "prime_search",
			status: "running",
			kind: "status",
			text: state.state === "cooling"
				? `${state.providerId} 正在等待上游限流窗口`
				: state.state === "recovered"
					? `${state.providerId} 已恢复访问`
					: `${state.providerId} 本轮已停止重试`,
		});
	};
	const server = createServer(async (incoming, response) => {
		response.setHeader("content-type", "application/json");
		const route = incoming.url ?? "";
		if (incoming.method !== "POST" || !BRIDGE_ROUTES.has(route)) {
			response.statusCode = 404;
			response.end(JSON.stringify({ error: "not_found" }));
			return;
		}
		try {
			let raw = "";
			for await (const chunk of incoming) {
				raw += chunk;
				if (raw.length > 1_000_000) throw new Error("Provider request exceeds 1 MB");
			}
			const body = JSON.parse(raw) as unknown;
			if (!isRecord(body)) throw new Error("Provider request must be an object");
			const executionId = bridgeExecutionId(body.agent_session_id);
			const authorization = Buffer.from(incoming.headers.authorization ?? "");
			const expected = Buffer.from(`Bearer ${primeExecutionToken(token, executionId)}`);
			if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
				response.statusCode = 401;
				response.end(JSON.stringify({ error: "unauthorized execution" }));
				return;
			}
			if (route === "/v1/root-search") {
				// Discovery belongs to the Root; children get the specialized Providers below.
				if (bridgeExecutionId(body.agent_session_id) !== "root") throw new Error("General Web search is available only to the Search Root");
				const results = await registry.search("general_web", {
					query: requiredString(body.query, "Search query"),
					maxResults: positiveInteger(body.max_results, "Search max_results", 50),
					criterionIds: [],
					purpose: "Prime Search Root discovery",
					workspaceDir: artifactWorkspace,
					signal: request.signal,
				}, { recorder });
				response.end(JSON.stringify({ results: agentFacingRows(results) }));
				return;
			}
			if (route === "/v1/browser") {
				if (!options.browser) throw new Error("Browser is not available in this Prime Search run");
				await assertBrowserToolChild(options.browser.config, executionId);
				const program = body.program !== undefined
					? (Array.isArray(body.program) && body.program.length > 0 && body.program.length <= 32
						? body.program.map((item) => commandVector(item, "program command"))
						: (() => { throw new Error("program must hold 1 to 32 commands"); })())
					: [commandVector(body.args, "args")];
				const steps: Array<{ args: string[]; exitCode: number; output: string; truncated: boolean }> = [];
				for (const args of program) {
					const result = await executeBrowserTool(options.browser.config, executionId, args, request.signal);
					steps.push({ args, ...result });
					if (result.exitCode !== 0) break;
				}
				response.end(JSON.stringify({ steps }));
				return;
			}
			if (route === "/v1/browser/materialize") {
				if (!options.browser) throw new Error("Browser is not available in this Prime Search run");
				await assertBrowserToolChild(options.browser.config, executionId);
				const root = options.browser.root;
				const artifactRoot = providerExecutionWorkspace(root, executionId).absolutePath;
				const result = await materializeBrowserSource(
					options.browser.config,
					{ artifactRoot, scopeRoot: root },
					executionId,
					{
						source: parseMaterializeSource(body.source),
						...(typeof body.title === "string" ? { title: body.title.slice(0, 512) } : {}),
					},
					request.signal,
				);
				response.end(JSON.stringify(result));
				return;
			}
			if (route === "/v1/skill-read") {
				// The Runtime reads the bytes itself and records the receipt, so an Evolution can prove
				// a child really opened a reference without a native Tool.
				const executionId = bridgeExecutionId(body.agent_session_id);
				const path = requiredString(body.path, "Skill path").replaceAll("\\", "/");
				if (isAbsolute(path) || path.split("/").includes("..") || !path.startsWith("skills/")) {
					throw new Error("Skill reads require a workspace-relative skills/... path");
				}
				const skillRoot = realpathSync(join(artifactWorkspace, "skills"));
				const resolved = realpathSync(resolve(artifactWorkspace, path));
				if (!resolved.startsWith(`${skillRoot}${sep}`)) throw new Error("Skill read escapes the staged Skill directory");
				const stat = statSync(resolved);
				if (!stat.isFile() || stat.size > 1_048_576) throw new Error("Skill reads require a regular file of at most 1 MiB");
				const bytes = readFileSync(resolved);
				const digest = sha256(bytes);
				if (options.conditionsPath) {
					appendFileSync(options.conditionsPath, `${JSON.stringify({
						schema_version: 1,
						kind: "skill_read",
						agent_session_id: executionId,
						path,
						sha256: digest,
						recorded_at: new Date().toISOString(),
					})}\n`, "utf-8");
				}
				response.end(JSON.stringify({ path, sha256: digest, text: bytes.toString("utf-8") }));
				return;
			}
			if (route === "/v1/provider-fallback") {
				if (bridgeExecutionId(body.agent_session_id) !== "root") throw new Error("Only the Search Root may select a Provider fallback");
				const fromSourceId = requiredString(body.from_source_id, "Fallback from_source_id");
				const toSourceId = requiredString(body.to_source_id, "Fallback to_source_id");
				if (fromSourceId === toSourceId || !allowedSources.has(fromSourceId) || !allowedSources.has(toSourceId)) {
					throw new Error("Provider fallback must name two different enabled Providers");
				}
				const fromCapabilities = providerCatalog.get(fromSourceId)?.capabilities ?? [];
				const toCapabilities = new Set(providerCatalog.get(toSourceId)?.capabilities ?? []);
				if (!fromCapabilities.some((capability) => toCapabilities.has(capability))) {
					throw new Error(`Provider fallback '${toSourceId}' does not share a capability with '${fromSourceId}'`);
				}
				if (![...overloadBudgets.entries()].some(([key, budget]) => key.endsWith(`\0${fromSourceId}`) && budget.terminal)) {
					throw new Error(`Provider fallback requires '${fromSourceId}' to be unavailable first`);
				}
				const selected = selectedFallbacks.get(fromSourceId);
				if (selected && selected !== toSourceId) throw new Error(`Provider '${fromSourceId}' already has fallback '${selected}'`);
				if (selected === toSourceId) {
					response.end(JSON.stringify({ accepted: true }));
					return;
				}
				selectedFallbacks.set(fromSourceId, toSourceId);
				appendRuntimeContext(recorder.runDir, "research", {
					type: "runtime.provider_fallback_selected",
					from_provider_id: fromSourceId,
					to_provider_id: toSourceId,
				});
				request.onActivity?.({
					stageId: recorder.nodeId,
					attemptId: recorder.attemptId,
					role: "prime_search",
					status: "running",
					kind: "status",
					text: `正在改用 ${toSourceId} 补充 ${fromSourceId} 未覆盖的证据`,
				});
				response.end(JSON.stringify({ accepted: true }));
				return;
			}
			const sourceId = requiredString(body.source_id, "Provider source_id");
			if (sourceId === "general_web") throw new Error("General Web is available only through the Search Root tool");
			if (!allowedSources.has(sourceId)) throw new Error(`Provider is not enabled for this Prime Search run: ${sourceId}`);
			const providerRequest = isRecord(body.provider_request)
				? {
					operation: requiredString(body.provider_request.operation, "Provider operation"),
					parameters: isRecord(body.provider_request.parameters) ? body.provider_request.parameters : {},
				}
				: undefined;
			const providerWorkspace = primeProviderArtifactWorkspace(
				artifactWorkspace,
				requiredString(body.workspace_dir, "Provider workspace_dir"),
			);
			const childId = basename(providerWorkspace);
			const budgetKey = `${childId}\0${sourceId}`;
			const overloadBudget = overloadBudgets.get(budgetKey)
				?? new ProviderOverloadBudget((state) => providerAccess(state, childId));
			overloadBudgets.set(budgetKey, overloadBudget);
			const results = await registry.search(sourceId, {
				query: requiredString(body.query, "Provider query"),
				maxResults: positiveInteger(body.max_results, "Provider max_results", 100),
				criterionIds: Array.isArray(body.criterion_ids)
					? body.criterion_ids.map((value) => requiredString(value, "Provider criterion_id"))
					: [],
				purpose: typeof body.purpose === "string" && body.purpose.trim()
					? body.purpose.trim()
					: "Prime Agent source acquisition",
				workspaceDir: sourceId === "user_documents"
					? request.workspaceDirectory
					: providerWorkspace,
				...(request.temporalContext.resolvedRange ? {
					temporalRange: {
						startDate: request.temporalContext.resolvedRange.startDate,
						endDate: request.temporalContext.resolvedRange.endDate,
					},
				} : {}),
				...(providerRequest ? { providerRequest } : {}),
				signal: request.signal,
			}, { recorder: { ...recorder, subExecutionId: childId }, overloadBudget });
			response.statusCode = 200;
			response.end(JSON.stringify({
				schema_version: 1,
				source_id: sourceId,
				results: agentFacingRows(results),
			}));
		} catch (error) {
			response.statusCode = 422;
			response.end(JSON.stringify({ error: bridgeError(error) }));
		}
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Prime Source bridge did not bind a TCP port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		token,
		close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
	};
}

/** Runtime failures keep their machine-readable fields, so the SDK can tell an unavailable Provider from an empty result. */
function bridgeError(error: unknown): unknown {
	if (!(error instanceof ResearchNodeError)) return toErrorMessage(error);
	return {
		message: error.message,
		code: error.code,
		failure_class: error.failureClass,
		retryable: error.retryable,
		...(error.retryAfterMs === undefined ? {} : { retry_after_ms: Math.round(error.retryAfterMs) }),
		// Provider errors may echo upstream bodies; only the Runtime-authored unavailability details reach the Agent.
		...(error.code === "source_unavailable" ? { details: error.details } : {}),
	};
}

export function primeProviderArtifactWorkspace(root: string, requested: string): string {
	const resolvedRoot = realpathSync(root);
	const resolved = realpathSync(requested);
	const path = relative(resolvedRoot, resolved).split(sep).join("/");
	if (!path) return resolvedRoot;
	if (!/^provider-executions\/sub-[A-Za-z0-9-]+$/u.test(path)) {
		throw new Error("Provider workspace_dir must be its Runtime-assigned execution workspace");
	}
	return resolved;
}

// Every byte of Provider metadata is paid for twice: once when the Agent prints a page of rows and
// again on each following turn. Paging cursors are the worst offender because they describe the page,
// not the row, yet get stamped on all of it: one base64 cursor repeated across a 100-row Hugging Face
// page cost 6329 tokens, 22% of the largest tool result observed in production. Carry the cursor on
// the first row that has one, which is also the row the SDK's cursor lookup returns, and drop the
// request echo beside it. Runtime bookkeeping no Provider contract promises the Agent goes too.
const RUNTIME_ONLY_METADATA = new Set(["provider_implementation", "reliability_tier"]);

export function agentFacingRows(results: readonly ResearchSearchResult[]): Array<Record<string, unknown>> {
	let cursorCarried = false;
	return results.map((result) => {
		const metadata = result.metadata ? agentFacingMetadata(result.metadata, !cursorCarried) : undefined;
		if (metadata && Object.keys(metadata).some((key) => key.endsWith("_page"))) cursorCarried = true;
		return {
			id: result.id,
			title: result.title,
			url: result.url,
			snippet: result.snippet,
			...(result.publishedAt ? { published_at: result.publishedAt } : {}),
			...(result.authors ? { authors: result.authors } : {}),
			...(metadata ? { metadata } : {}),
		};
	});
}

function agentFacingMetadata(metadata: Record<string, unknown>, carryCursor: boolean): Record<string, unknown> {
	const projected: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (RUNTIME_ONLY_METADATA.has(key)) continue;
		if (key.endsWith("_page") && isRecord(value)) {
			const cursor = value.next_cursor;
			if (carryCursor && typeof cursor === "string" && cursor) projected[key] = { next_cursor: cursor };
			continue;
		}
		projected[key] = value;
	}
	return projected;
}

/**
 * Agent 输出契约声明的路径，也是唯一会被复用的部分。Provider child 的 Candidate Ledger 提交在
 * 各自的执行工作区里，复用时靠它们重建执行身份，所以同属契约。
 * 之外的一切要么是 Agent 自己的草稿，要么是 Runtime 每次重铺的输入（skills、.prime），
 * 一律清掉：留着既占空间，也会让下一次执行继承来路不明的状态。
 */
const AGENT_CONTRACT_PATHS = new Set(["source", "work", "organizer", "artifacts", PROVIDER_EXECUTIONS_DIRECTORY]);

/**
 * 判定上一次中断留下的现场封存到了哪一步。
 *
 * Agent 会在工作目录里留下契约之外的草稿（一次实测中占 167M 里的 98M），所以先按声明的
 * 契约路径清扫，再交给既有校验器判定。`source/.complete` 由 Agent 在全部下载完成后最后
 * 写入，所以它存在就意味着采集已整体完成，不需要再逐个文件校验完整性。
 * 判不出封存就归档现场重来，且只保留最近一次，避免下载材料无界堆积。
 */
export function reuseInterruptedStage(stageRoot: string, root: string, request: Pick<SearchBatchRequest,
	"availableProviderIds" | "sequence">): {
	sources?: PrimeSourceItem[];
	archivedPath?: string;
} {
	if (!existsSync(root)) return {};
	for (const entry of readdirSync(root)) {
		if (!AGENT_CONTRACT_PATHS.has(entry)) rmSync(join(root, entry), { recursive: true, force: true });
	}
	let sources: PrimeSourceItem[];
	try {
		// 执行身份来自已经提交的 Provider Ledger。
		sources = validatePrimeSource(root, primeProviderExecutions(root, request));
	} catch {
		if (primeProviderAssignments(root).length > 0) {
			try {
				const executions = primeProviderExecutions(root, request);
				materializePrimeSources(root, executions);
				return { sources: validatePrimeSource(root, executions) };
			} catch {}
		}
		const archive = `${stageRoot}.interrupted`;
		rmSync(archive, { recursive: true, force: true });
		renameSync(stageRoot, archive);
		return { archivedPath: archive };
	}
	return { sources };
}

/** 复用封存产物时跳过一次 Agent 执行：没有新增用量，也不计入 Agent Stage。 */
function skippedPrimeRun(): { usage: ResearchModelUsage; toolCalls: number; agentStages: number; rootError?: string } {
	return { usage: emptyUsage(), toolCalls: 0, agentStages: 0 };
}

function safeDirectory(path: string, root: string, label: string): string {
	const resolvedRoot = realpathSync(root);
	const resolved = realpathSync(path);
	if (!lstatSync(resolved).isDirectory() || !isInsideRoot(resolvedRoot, resolved)) throw new Error(`${label} must be a safe directory`);
	return resolved;
}

function safeFile(path: string, root: string, label: string): string {
	if (!existsSync(path)) throw new Error(`${label} does not exist`);
	const resolvedRoot = realpathSync(root);
	const resolved = realpathSync(path);
	const stat = lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink() || !isInsideRoot(resolvedRoot, resolved)) throw new Error(`${label} must be a safe regular file`);
	return resolved;
}

function hasMaterial(directory: string): boolean {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Source material contains symlink '${path}'`);
		if (entry.isDirectory() && hasMaterial(path)) return true;
		if (entry.isFile() && entry.name !== "record.json" && lstatSync(path).size > 0) return true;
	}
	return false;
}

function preservePrimeDecisionArtifacts(root: string, runtimeRoot: string): void {
	const executionRoot = join(root, PROVIDER_EXECUTIONS_DIRECTORY);
	if (existsSync(executionRoot)) {
		for (const source of listFilesRecursive(executionRoot).map((rel) => join(executionRoot, rel)).filter((path) => path.endsWith("_candidates.json"))) {
			const destination = join(runtimeRoot, "decisions", relative(root, source));
			mkdirSync(dirname(destination), { recursive: true });
			copyFileSync(source, destination);
		}
	}
	for (const name of ["decision.json", "index.json", "groups.json"]) {
		const organizer = join(root, "organizer", name);
		if (!existsSync(organizer)) continue;
		const destination = join(runtimeRoot, "decisions", "organizer", name);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(organizer, destination);
	}
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${label} must be an integer between 1 and ${maximum}`);
	}
	return value;
}

function assertUnique(seen: Set<string>, value: string, label: string): void {
	if (seen.has(value)) throw new Error(`Prime output contains duplicate ${label} '${value}'`);
	seen.add(value);
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeId(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100) || "item";
}

function emptyUsage(): ResearchModelUsage {
	return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
}

function addUsage(left: ResearchModelUsage, right: ResearchModelUsage): ResearchModelUsage {
	return {
		inputTokens: left.inputTokens + right.inputTokens,
		outputTokens: left.outputTokens + right.outputTokens,
		costUsd: left.costUsd + right.costUsd,
		calls: left.calls + right.calls,
	};
}
