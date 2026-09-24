import { getSourceStatusMonitor } from "../providers/source-status.js";
import { resolvePrimeAgentModels } from "../agent-runtime/model-policy.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { loadResearchHarnessSnapshot, type ResearchHarnessSnapshot } from "./harness/snapshot.js";
import type { ResearchExecutionResult, ResearchNodeStatus } from "./types.js";
import { cornellNoteAgentContractIdentity } from "./cornell-note-agent.js";
import {
	hashRuntimeIdentityJson,
	ResearchRuntime,
} from "./runtime.js";
import { freezeRunModelSelection, runModelSelection } from "./run-model-selection.js";
import { RunStateStore, type RunStateV2 } from "./run-state.js";
import { type AgentStageActivity } from "../agent-runtime/agent-stage-runtime.js";
import type { ResearchRenderFormat, RunStageReport } from "./research-types.js";
import {
	buildRunContextSnapshotFromHarness,
	type PinnedRunContext,
} from "./run-context.js";
import type { RunContextSnapshot } from "./run-context.js";
import {
	appendResearchRuntimeNode,
	appendRuntimeContext,
	readRunRecords,
	runtimeContextPath,
	sealInterruptedAgentExecutions,
} from "../observability/run-records.js";
import type { ScheduledResearchContext } from "./scheduled-research-context.js";
import type { GoalTopicPlan } from "../goals/topic-plan/index.js";
import { type ResolvedOutputLanguage } from "../../shared/languages.js";

export interface ResearchNodeTrace {
	nodeId: string;
	status: string;
	visit: number;
	attempt: number;
	startedAt?: string;
	finishedAt?: string;
	error?: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	items: number;
	nodeVersion: string;
	promptVersion?: string;
	schemaVersion?: string;
	modelPolicy?: unknown;
	inputHash?: string;
	failureClass?: string;
	gateResults: Array<{ name: string; passed: boolean }>;
	artifactPaths: string[];
}

export interface ResearchTraceSummary {
	version: 2;
	source: "research_runtime";
	workflowId: string;
	workflowVersion: number;
	controlStatePath: string;
	messageCount: number;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	toolErrors: number;
	nodeAttempts: number;
	nodeFailures: number;
	bashExecutions: number;
	modelChanges?: number;
	thinkingLevelChanges?: number;
	compactions?: number;
	stopReasons: Record<string, number>;
	tools: Record<string, number>;
	usage: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens: number;
		cost: number;
	};
	nodes: ResearchNodeTrace[];
	repairRoutes: Array<{
		fromNodeId: string;
		toNodeId: string;
		fromVisit: number;
		reason: string;
		createdAt: string;
	}>;
	run: {
		status: ResearchExecutionResult["status"];
		durationMs: number;
		items: number;
	};
}

/** A verification this recent stands for the Run; older than this and the logins are read again. */
const SOURCE_STATUS_MAX_AGE_MS = 5 * 60_000;

export interface ResearchWorkspaceRunRequest {
	goalDir: string;
	goalTitle?: string;
	goalDescription?: string;
	/** Optional published Goal state when execution artifacts live elsewhere. */
	stateContext?: { goalId: string; goalDir: string; dataDir: string };
	workspaceDirectory: string;
	controlDirectory: string;
	/** Goal-scoped physical cache root. Prime Search receives Branch-filtered immutable views. */
	organizerStorageRoot?: string;
	runId: string;
	question: string;
	reportContext: string;
	discoveryEnabled: boolean;
	outputLanguage?: ResolvedOutputLanguage;
	/** Goal-level output language for the Wiki, which outlives this Run. */
	goalLanguage?: ResolvedOutputLanguage;
	env?: Record<string, string>;
	signal?: AbortSignal;
	onNodeState?: (event: {
		nodeId: string;
		status: ResearchNodeStatus;
		visit: number;
		attempt: number;
		detail?: string;
		error?: string;
	}) => void;
	onAgentOutput?: (activity: AgentStageActivity) => void;
	scheduledResearch?: ScheduledResearchContext;
	topicPlan?: GoalTopicPlan;
}

export interface ResearchRenderArtifact {
	format: ResearchRenderFormat;
	kind: "report" | "plan" | "image" | "copy" | "video";
	relativePath: string;
	absolutePath: string;
	mediaType: string;
}

export interface ResearchWorkspaceRunResult {
	execution: ResearchExecutionResult;
	model: string;
	traceSummary: ResearchTraceSummary;
	traceSummaryPath: string;
	finalReportPath: string;
	finalReportContent: string;
	renderFormats: ResearchRenderFormat[];
	renderArtifacts: ResearchRenderArtifact[];
	researchHarnessSnapshot: ResearchHarnessSnapshot;
	stageReports: RunStageReport[];
	state: RunStateV2;
}

export interface RuntimeStageReport {
	schema_version: 1;
	run_id: string;
	stage_id: string;
	attempt_id: string;
	attempt: number;
	role: string;
	status: "succeeded" | "failed" | "cancelled" | "interrupted";
	started_at: string;
	finished_at: string;
	duration_ms: number;
	model_policy: unknown;
	sandbox: unknown;
	session: unknown;
	system_prompt_file?: string;
	input_mounts: unknown[];
	metrics: {
		turns: number;
		tool_calls: number;
		tool_counts: Record<string, number>;
		input_tokens: number;
		output_tokens: number;
		cost_usd: number;
		model_calls: number;
	};
	submission_count: number;
	validation_errors: string[];
	output?: {
		relative_path: string;
		sha256: string;
		byte_length: number;
	};
	failure_class?: string;
	error?: string;
}

/**
 * The language resolved for this Run outranks the Harness default: without it every Run fell back
 * to the configured default language, whatever the Goal asked for.
 */
export function researchRunConfig<T extends object>(
	overrides: T | undefined,
	outputLanguage: ResolvedOutputLanguage | undefined,
): T & { outputLanguage?: ResolvedOutputLanguage } {
	return { ...(overrides as T), ...(outputLanguage ? { outputLanguage } : {}) };
}

export async function runResearchWorkspace(
	request: ResearchWorkspaceRunRequest,
): Promise<ResearchWorkspaceRunResult> {
	// Freeze the Run's role selections before anything reads a model, so the Harness Snapshot,
	// the identity pins and every Stage describe the same models.
	// The run presents whatever the user is logged into right now, not what the server saw at boot:
	// verification re-reads the browser logins first, and a source that is switched off, logged out
	// or failing stays out of this Run's Provider Catalog instead of failing inside it.
	const sourceStatus = getSourceStatusMonitor();
	await sourceStatus.verifyIfStale(SOURCE_STATUS_MAX_AGE_MS).catch(() => undefined);
	const excludedSources = sourceStatus.excludedSourceIds();
	if (excludedSources.length > 0) console.log(`[telomi][research] ${request.runId} runs without sources: ${excludedSources.join(", ")}`);
	const envOverride = freezeRunModelSelection(
		{ ...process.env, ...(request.env ?? {}) },
		request.controlDirectory,
	);
	const runSelection = runModelSelection(envOverride);
	const researchHarnessSnapshot = loadResearchHarnessSnapshot(request.goalDir);
	const goalId = request.stateContext?.goalId ?? request.goalDir.split(/[\\/]/u).filter(Boolean).at(-1) ?? request.runId;
	const stateGoalDir = request.stateContext?.goalDir ?? request.goalDir;
	const stateDataDir = request.stateContext?.dataDir ?? dirname(request.goalDir);
	const pinnedRunContext = existingPinnedRunContext({
		goalId,
		goalDir: stateGoalDir,
		dataDir: stateDataDir,
		harness: researchHarnessSnapshot,
	}, request.controlDirectory, request);
	const cornellNoteAgentContract = cornellNoteAgentContractIdentity();
	mkdirSync(request.controlDirectory, { recursive: true });
	writeFileSync(join(request.controlDirectory, "research-harness-snapshot.json"), `${JSON.stringify({
		schema_version: researchHarnessSnapshot.schemaVersion,
		contract_version: researchHarnessSnapshot.contractVersion,
		snapshot_hash: researchHarnessSnapshot.snapshotHash,
		source: researchHarnessSnapshot.source,
		cornell_note: {
			execution: "single_source_prime_cornell_note_v1",
			contract_id: cornellNoteAgentContract.id,
			contract_version: cornellNoteAgentContract.version,
			contract_hash: cornellNoteAgentContract.sha256,
			thinking: runSelection.stageThinkingLevels["cornellNote.evidenceNote"],
		},
		run_policy_id: researchHarnessSnapshot.runPolicy.id,
		run_policy_version: researchHarnessSnapshot.runPolicy.version,
		run_policy_hash: researchHarnessSnapshot.runPolicyHash,
		agent_skills: Object.fromEntries(Object.entries(researchHarnessSnapshot.agentSkills).map(([agentId, skills]) => [
			agentId,
			{
				skills: skills.skills.map((asset) => ({
					path: relative(researchHarnessSnapshot.workspaceDir, asset.sourcePath),
					sha256: asset.sha256,
				})),
			},
		])),
		prime_search: {
			source: researchHarnessSnapshot.primeSearch.source,
			policy_path: researchHarnessSnapshot.primeSearch.policyPath,
			policy_id: researchHarnessSnapshot.primeSearch.policy.id,
			policy_version: researchHarnessSnapshot.primeSearch.policy.version,
			policy_hash: researchHarnessSnapshot.primeSearch.policyHash,
			snapshot_hash: researchHarnessSnapshot.primeSearch.snapshotHash,
			allowed_sources: researchHarnessSnapshot.primeSearch.policy.allowedSources,
			general_web_backend: researchHarnessSnapshot.primeSearch.policy.generalWebBackend,
		},
		// What this Run is pinned to. No secret belongs in a Run record.
		model_routing: runSelection.models,
		stage_thinking_levels: runSelection.stageThinkingLevels,
		discovery_enabled: request.discoveryEnabled,
	}, null, 2)}\n`, "utf-8");
	writeFileSync(join(request.controlDirectory, "run-context-snapshot.json"), `${JSON.stringify(pinnedRunContext.snapshot, null, 2)}\n`, "utf-8");
	const startedAtMs = Date.now();
	appendRuntimeContext(request.controlDirectory, "research", {
		type: "runtime.pipeline_started",
		run_id: request.runId,
		goal_id: goalId,
	});
	appendResearchRuntimeNode(request.controlDirectory, {
		node_id: "research-pipeline-start",
		status: "succeeded",
		input: {
			run_id: request.runId,
			goal_id: goalId,
			question: request.question,
			report_context: request.reportContext,
			discovery_enabled: request.discoveryEnabled,
		},
		output: { status: "started" },
	});
	const runtime = new ResearchRuntime();
	const execution = await runtime.run({
		runId: request.runId,
		goalId,
		goalTitle: request.goalTitle,
		goalDescription: request.goalDescription,
		...(request.goalLanguage ? { goalLanguage: request.goalLanguage } : {}),
		discoveryEnabled: request.discoveryEnabled,
		...(request.topicPlan ? { topicPlan: request.topicPlan } : {}),
		question: request.question,
		reportContext: request.reportContext,
		workspaceDirectory: request.workspaceDirectory,
		controlDirectory: request.controlDirectory,
		goalWorkspaceDirectory: stateGoalDir,
		workspaceRootDirectory: stateDataDir,
		organizerStorageRoot: request.organizerStorageRoot ?? join(dirname(request.controlDirectory), "research-sources"),
		env: envOverride,
		config: researchRunConfig(researchHarnessSnapshot.runPolicy.configOverrides, request.outputLanguage),
		signal: request.signal,
		onProgress: (event) => request.onNodeState?.({
			nodeId: event.sequence === undefined ? event.stage : `${event.stage}:${event.sequence}`,
			status: event.status === "running"
				? "running"
				: event.status === "succeeded"
					? "succeeded"
					: event.status === "cancelled"
						? "cancelled"
						: "failed",
			visit: event.sequence ?? 1,
			attempt: 1,
			...(event.detail ? {
				detail: event.detail,
				...(event.status === "failed" ? { error: event.detail } : {}),
			} : {}),
		}),
		onAgentOutput: request.onAgentOutput,
		...(request.scheduledResearch ? { scheduledResearch: request.scheduledResearch } : {}),
		researchHarnessSnapshot,
		runContextSnapshot: pinnedRunContext.snapshot,
		excludedSources,
	});
	sealInterruptedAgentExecutions(request.controlDirectory, "research", execution.execution.finishedAt);
	const runtimeStageReports = readRuntimeStageReports(request.controlDirectory, request.runId);
	const traceSummary = researchTrace(
		execution.state,
		execution.execution,
		request.controlDirectory,
		Date.now() - startedAtMs,
		runtimeStageReports,
	);
	const traceSummaryPath = runtimeContextPath(request.controlDirectory, "research");
	appendRuntimeContext(request.controlDirectory, "research", {
		type: "runtime.pipeline_completed",
		run_id: request.runId,
		status: execution.execution.status,
	});
	appendResearchRuntimeNode(request.controlDirectory, {
		node_id: "research-pipeline-finish",
		status: execution.execution.status === "succeeded" || execution.execution.status === "skipped"
			? "succeeded"
			: execution.execution.status === "cancelled"
				? "cancelled"
				: execution.execution.status === "blocked"
					? "interrupted"
				: "failed",
		input: {
			run_id: request.runId,
			workflow_id: execution.execution.workflowId,
			workflow_version: execution.execution.workflowVersion,
		},
		output: {
			status: execution.execution.status,
			...(execution.execution.status === "succeeded"
				? { final_report_ref: "report/final.md" }
				: {}),
		},
		started_at: new Date(startedAtMs).toISOString(),
		finished_at: execution.execution.finishedAt,
	});
	const finalReportPath = join(request.workspaceDirectory, "report", "final.md");
	const finalReportContent = existsSync(finalReportPath) ? readFileSync(finalReportPath, "utf-8") : "";
	const renderArtifacts = collectRenderArtifacts(request.workspaceDirectory);
		return { execution: execution.execution, model: resolvePrimeAgentModels(envOverride).root.selector, traceSummary, traceSummaryPath, finalReportPath, finalReportContent,
			renderFormats: ["markdown"], renderArtifacts,
				researchHarnessSnapshot,
		stageReports: runtimeStageReports.map(toPublicStageReport), state: execution.state };
}

function existingPinnedRunContext(
	input: Parameters<typeof buildRunContextSnapshotFromHarness>[0],
	controlDir: string,
	request: Pick<ResearchWorkspaceRunRequest, "question" | "reportContext">,
): PinnedRunContext {
	const current = buildRunContextSnapshotFromHarness(input);
	const state = new RunStateStore(controlDir).load();
	if (!state) return current;
	const path = join(controlDir, "run-context-snapshot.json");
	if (!existsSync(path)) {
		throw new Error("checkpoint_identity_drift: Run Context snapshot is missing");
	}
	const snapshot = JSON.parse(readFileSync(path, "utf-8")) as RunContextSnapshot;
	if (
		hashRuntimeIdentityJson({ snapshot, search_question: request.question, report_context: request.reportContext }) !== state.pins.run_context_snapshot
		|| snapshot.schemaVersion !== 2
		|| snapshot.goalId !== input.goalId
		|| snapshot.harnessSnapshotHash !== current.snapshot.harnessSnapshotHash
	) {
		throw new Error("checkpoint_identity_drift: Run Context snapshot changed");
	}
	return { ...current, snapshot };
}

function collectRenderArtifacts(workspaceDir: string): ResearchRenderArtifact[] {
	const candidates: Array<Omit<ResearchRenderArtifact, "absolutePath">> = [
		{ format: "markdown", kind: "report", relativePath: "report/final.md", mediaType: "text/markdown" },
	];
	return candidates.flatMap((artifact) => {
		const absolutePath = join(workspaceDir, artifact.relativePath);
		return existsSync(absolutePath) ? [{ ...artifact, absolutePath }] : [];
	});
}

export function readRuntimeStageReports(controlDir: string, runId: string): RuntimeStageReport[] {
	const events = readRunRecords(controlDir).runtime?.events ?? [];
	return events
		.filter((event) => event.type === "runtime.agent_bound")
		.map((bound) => {
			const stageId = String(bound.stage_id ?? "");
			const executionId = String(bound.execution_id ?? "");
			const related = events.filter((event) =>
				event.execution_id === executionId
				&& (event.stage_id === stageId || event.node_id === stageId));
			const terminal = [...related].reverse().find((event) =>
				["runtime.stage_completed", "runtime.stage_failed", "runtime.stage_cancelled"].includes(event.type));
			const terminalNode = [...related].reverse().find((event) => event.type === "node_execution");
			const accepted = [...related].reverse().find((event) => event.type === "runtime.stage_output_accepted");
			const recovered = [...events].reverse().find((event) =>
				event.type === "runtime.writer_output_checkpointed"
				&& event.stage_id === stageId
				&& event.checkpoint_action === "recovered");
			const status = terminal?.type === "runtime.stage_completed"
				? "succeeded" as const
				: terminal?.type === "runtime.stage_cancelled"
					? "cancelled" as const
					: terminal?.type === "runtime.stage_failed"
						? "failed" as const
						: recovered || terminalNode?.status === "succeeded"
							? "succeeded" as const
							: terminalNode?.status === "interrupted"
								? "interrupted" as const
								: "failed" as const;
			const validationErrors = related
				.filter((event) => event.type === "runtime.stage_output_rejected")
				.map((event) => String(event.validation_error ?? "validation failed"));
			const startedAt = String(bound.created_at ?? "");
			const nodeTime = terminalNode?.time && typeof terminalNode.time === "object"
				? terminalNode.time as Record<string, unknown>
				: undefined;
			const finishedAt = String(terminal?.created_at ?? recovered?.created_at ?? nodeTime?.finished_at ?? startedAt);
			const nodeOutput = terminalNode?.output && typeof terminalNode.output === "object"
				? terminalNode.output as Record<string, unknown>
				: undefined;
			const metrics = runtimeStageMetrics(terminal?.metrics ?? nodeOutput?.metrics);
			return {
				schema_version: 1,
				run_id: runId,
					stage_id: stageId,
					attempt_id: executionId,
					attempt: typeof bound.attempt === "number" && Number.isInteger(bound.attempt) && bound.attempt > 0
						? bound.attempt
						: 1,
					role: String(bound.agent ?? "agent"),
					status,
				started_at: startedAt,
				finished_at: finishedAt,
				duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) || 0,
				model_policy: { model: bound.model },
				sandbox: {
					runtime: "srt",
					execution_profile: bound.execution_profile,
				},
				session: {
					id: bound.session_id,
					file: bound.session_file,
					mode: bound.session_mode,
				},
				...(typeof bound.system_prompt_file === "string"
					? { system_prompt_file: bound.system_prompt_file }
					: {}),
				input_mounts: [],
				metrics,
				submission_count: related.filter((event) =>
					event.type === "runtime.stage_output_accepted" || event.type === "runtime.stage_output_rejected").length,
				validation_errors: validationErrors,
				...(accepted ? {
					output: {
						relative_path: String(accepted.output_ref ?? ""),
						sha256: String(accepted.output_sha256 ?? ""),
						byte_length: 0,
					},
				} : {}),
				...(status !== "succeeded" ? {
					failure_class: status === "cancelled" ? "cancelled" : status === "interrupted" ? "infrastructure" : "agent_stage_failed",
					error: String(terminal?.error ?? "stage did not complete"),
				} : {}),
			} satisfies RuntimeStageReport;
		})
		.sort((left, right) =>
			left.started_at.localeCompare(right.started_at)
			|| left.stage_id.localeCompare(right.stage_id)
			|| left.attempt_id.localeCompare(right.attempt_id));
}

function runtimeStageMetrics(value: unknown): RuntimeStageReport["metrics"] {
	const metrics = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const counts = metrics.tool_counts && typeof metrics.tool_counts === "object"
		? Object.fromEntries(Object.entries(metrics.tool_counts as Record<string, unknown>)
			.filter((entry): entry is [string, number] => typeof entry[1] === "number"))
		: {};
	const number = (key: string) => typeof metrics[key] === "number" ? metrics[key] : 0;
	return {
		turns: number("turns"),
		tool_calls: number("tool_calls"),
		tool_counts: counts,
		input_tokens: number("input_tokens"),
		output_tokens: number("output_tokens"),
		cost_usd: number("cost_usd"),
		model_calls: number("model_calls"),
	};
}

function toPublicStageReport(report: RuntimeStageReport): RunStageReport {
	return {
		schemaVersion: 1,
		runId: report.run_id,
		stageId: report.stage_id,
		status: report.status,
		startedAt: report.started_at,
		finishedAt: report.finished_at,
		durationMs: report.duration_ms,
		expected: {
			role: report.role,
			model_policy: report.model_policy,
			input_mounts: report.input_mounts,
		},
		actual: {
			attempt_id: report.attempt_id,
			sandbox: report.sandbox,
			session: report.session,
			...(report.system_prompt_file ? { system_prompt_file: report.system_prompt_file } : {}),
			submission_count: report.submission_count,
			validation_errors: report.validation_errors,
			...(report.output ? { output: report.output } : {}),
			...(report.failure_class ? { failure_class: report.failure_class } : {}),
			...(report.error ? { error: report.error } : {}),
		},
		metrics: {
			inputCount: report.metrics.turns,
			outputCount: report.output ? 1 : 0,
			modelCalls: report.metrics.model_calls,
			inputTokens: report.metrics.input_tokens,
			outputTokens: report.metrics.output_tokens,
		},
	};
}

function researchTrace(
	state: RunStateV2,
	execution: ResearchExecutionResult,
	controlDir: string,
	durationMs: number,
	stageReports: RuntimeStageReport[],
): ResearchTraceSummary {
	const artifactPaths = [
		...state.source_bundles,
		...state.cornell_note_snapshots,
		...state.writer_outputs.map((checkpoint) => checkpoint.output),
		...state.accepted_chapters.map((chapter) => chapter.chapter),
		...(state.canonical_report ? [state.canonical_report] : []),
	].map((artifact) => artifact.relative_path);
	const nodes = Object.entries(execution.nodeStatuses).map(([nodeId, status]) => ({
		...traceNode(nodeId, artifactPathsForNode(nodeId, artifactPaths), stageReports),
		status,
	}));
	const toolCounts: Record<string, number> = {};
	for (const report of stageReports) {
		for (const [name, count] of Object.entries(report.metrics.tool_counts)) {
			toolCounts[name] = (toolCounts[name] ?? 0) + count;
		}
	}
	const toolCalls = stageReports.reduce((total, report) => total + report.metrics.tool_calls, 0);
	const records = readRunRecords(controlDir);
	let messageCount = 0;
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	for (const session of records.agentSessions) {
		for (const entry of session.entries) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			if (record.type !== "message" || !record.message || typeof record.message !== "object") continue;
			const role = (record.message as Record<string, unknown>).role;
			messageCount += 1;
			if (role === "user") userMessages += 1;
			else if (role === "assistant") assistantMessages += 1;
			else if (role === "toolResult" || role === "tool_result") toolResults += 1;
		}
	}
	const toolErrors = records.agentSessions.reduce((total, session) =>
		total + session.toolCompletions.filter((completion) => completion.isError).length, 0);
	const nodeExecutions = records.runtime?.events.filter((event) => event.type === "node_execution") ?? [];
	return {
		version: 2,
		source: "research_runtime",
		workflowId: execution.workflowId,
		workflowVersion: execution.workflowVersion,
		controlStatePath: join(controlDir, "run-state.json"),
		messageCount,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		toolErrors,
		nodeAttempts: nodeExecutions.length,
		nodeFailures: nodeExecutions.filter((event) => event.status === "failed").length,
		bashExecutions: toolCounts.bash ?? 0,
		stopReasons: { [execution.status]: 1 },
		tools: toolCounts,
		usage: { input: execution.usage.inputTokens, output: execution.usage.outputTokens,
			totalTokens: execution.usage.inputTokens + execution.usage.outputTokens,
			cost: execution.usage.costUsd },
		nodes,
		repairRoutes: [],
		run: { status: execution.status, durationMs, items: state.accepted_chapters.length },
	};
}

function artifactPathsForNode(nodeId: string, paths: string[]): string[] {
	const [token, rawSequence] = nodeId.split(":");
	if (token === "report_writer") {
		const sequence = rawSequence ? Number.parseInt(rawSequence, 10) : 1;
		if (sequence !== 1) return [];
		return paths.filter((path) =>
			path.includes("artifacts/report-flow/writer/")
			|| path.includes("artifacts/accepted-chapters/"));
	}
	const hints: Record<string, string[]> = {
		search_batch: ["source-bundles", "search-executions"],
		cornell_notes: ["cornell-note"],
		citation_compiler: ["report/final.md"],
		complete: ["report/final.md"],
	};
	const selected = hints[token] ?? [];
	return paths.filter((path) => selected.some((hint) => path.includes(hint)));
}

function traceNode(
	nodeId: string,
	artifactPaths: string[],
	stageReports: RuntimeStageReport[],
): ResearchNodeTrace {
	const reports = reportsForTraceNode(nodeId, stageReports);
	const startedAt = reports.map((report) => report.started_at).sort()[0];
	const finishedAt = reports.map((report) => report.finished_at).sort().at(-1);
	return {
		nodeId,
		status: "succeeded",
		visit: traceNodeSequence(nodeId) ?? 1,
		attempt: reports.length > 0 ? Math.max(...reports.map((report) => report.attempt)) : 1,
		...(startedAt ? { startedAt } : {}),
		...(finishedAt ? { finishedAt } : {}),
		inputTokens: reports.reduce((total, report) => total + report.metrics.input_tokens, 0),
		outputTokens: reports.reduce((total, report) => total + report.metrics.output_tokens, 0),
		costUsd: reports.reduce((total, report) => total + report.metrics.cost_usd, 0),
		items: artifactPaths.length,
		nodeVersion: `research-v1:${nodeId}`,
		gateResults: reports.flatMap((report) => [
			{ name: `${report.stage_id}:stage_succeeded`, passed: report.status === "succeeded" },
			{ name: `${report.stage_id}:output_validated`, passed: Boolean(report.output) && report.validation_errors.length === 0 },
		]),
		artifactPaths,
	};
}

function reportsForTraceNode(nodeId: string, reports: RuntimeStageReport[]): RuntimeStageReport[] {
	const [node, rawSequence] = nodeId.split(":");
	const sequence = rawSequence ? Number.parseInt(rawSequence, 10) : undefined;
	if (node === "search_batch") return reports.filter((report) => report.stage_id.startsWith("prime-search-batch-"));
	if (node === "cornell_notes") return reports.filter((report) => report.stage_id.startsWith("cornell-note-"));
	if (node === "report_writer") {
		if (!sequence) return [];
		return sequence === 1
			? reports.filter((report) => report.stage_id === "writer-report")
			: [];
	}
	return [];
}

function traceNodeSequence(nodeId: string): number | undefined {
	const raw = nodeId.split(":")[1];
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}
