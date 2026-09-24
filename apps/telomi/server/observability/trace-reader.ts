import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { WikiUpdateJobStore } from "../wiki/wiki-update-job.js";
import { PROVIDER_CALLS_FILE, readProviderCallRecords } from "../providers/provider-call-record.js";
import { readAgentNodeUsage, readRunRecords, type NodeExecutionRecord, type WorkspaceSnapshotRecord } from "./run-records.js";

export type TraceKind = "research" | "wiki";
export type TraceStatus = "running" | "succeeded" | "skipped" | "failed" | "cancelled" | "interrupted";

export interface TraceFileRef {
	kind: string;
	ref: string;
	mediaType: string;
	byteLength: number;
}

export interface TraceDirectoryRef {
	type: "directory";
	resolvedFiles: TraceFileRef[];
}

export interface TraceUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	modelCalls: number;
	basis: "terminal_agent_execution_metrics";
	completeness: "complete" | "lower_bound" | "unknown";
	completeExecutions: number;
	incompleteExecutions: number;
}

type TraceUsageTotals = Pick<TraceUsage, "inputTokens" | "outputTokens" | "costUsd" | "modelCalls">;

export interface TraceOrigin {
	goalId: string;
	goalTitle?: string;
	userInput?: string;
	researchTask?: string;
}

export interface TraceMainAgentLinkage {
	executionKind: "main_agent";
	runId: string;
	sessionRef: string;
	routeTraceRef: string;
	runtimeTraceRef: string;
}

export interface TraceNode {
	eventId?: number;
	nodeId: string;
	nodeType: "runtime" | "agent";
	agent?: string;
	executionId?: string;
	attempt?: number;
	status: TraceStatus;
	dependsOn: number[];
	groupId?: string;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	traceRef?: string;
	caseRef?: { sourceRunId: string; caseId: string; fileRef: string };
	/** Lines in provider-calls.jsonl recorded under this node id. Agent nodes only. */
	provider_call_count?: number;
	workspace?: WorkspaceSnapshotRecord;
}

export interface TraceRunSummary {
	schemaVersion: 1;
	goalId: string;
	kind: TraceKind;
	runId: string;
	status: TraceStatus;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	model?: string;
	usage?: TraceUsage;
	finalGate?: { ok: boolean; halt: boolean; ref: string };
	origin: TraceOrigin;
	linkage: { mainAgent?: TraceMainAgentLinkage };
	nodeCount: number;
	warnings: string[];
}

export interface TraceRun extends Omit<TraceRunSummary, "nodeCount"> {
	nodes: TraceNode[];
	files: TraceFileRef[];
}

export function listTraceRuns(input: {
	workspaceDir: string;
	goalId: string;
	kind?: TraceKind;
	limit?: number;
	goalTitle?: string;
}): TraceRunSummary[] {
	const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)));
	const kinds: TraceKind[] = input.kind ? [input.kind] : ["research", "wiki"];
	return kinds.flatMap((kind) => {
		const root = traceRunsRoot(input.workspaceDir, input.goalId, kind);
		if (!existsSync(root)) return [];
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && safeIdentity(entry.name))
			.map((entry) => ({ runId: entry.name, modifiedAt: statSync(join(root, entry.name)).mtimeMs }))
			.sort((left, right) => right.modifiedAt - left.modifiedAt)
			.slice(0, limit)
			.map(({ runId }) => summary(readTraceRun({ ...input, kind, runId })));
	}).sort((left, right) => (right.startedAt ?? right.runId).localeCompare(left.startedAt ?? left.runId)).slice(0, limit);
}

export function readTraceRun(input: {
	workspaceDir: string;
	goalId: string;
	kind: TraceKind;
	runId: string;
	runDirectory?: string;
	wikiRunDirectory?: string;
	goalTitle?: string;
	originalUserInput?: string;
}): TraceRun {
	if (!safeIdentity(input.runId)) throw new Error("Invalid Trace Run id");
	if (input.kind === "wiki") return readWikiTraceRun({ ...input, kind: "wiki" });
	const runDir = input.runDirectory ?? join(traceRunsRoot(input.workspaceDir, input.goalId, input.kind), input.runId);
	if (!existsSync(runDir) || !lstatSync(runDir).isDirectory() || lstatSync(runDir).isSymbolicLink()) {
		throw new Error(`Unknown ${input.kind} Trace Run '${input.runId}'`);
	}
	const wikiRunDir = input.wikiRunDirectory ?? join(input.workspaceDir, input.goalId, "wiki", "runs", input.runId);
	const records = readRunRecords(runDir);
	const warnings: string[] = [];
	const referencedFiles = new Map<string, TraceFileRef>();
	const referenceContext: ReferenceContext = {
		runDir,
		wikiRunDir,
		warnings,
		referencedFiles,
		caseByNodeId: caseIdsByNode(runDir),
		providerCallsByNode: providerCallCounts(runDir),
	};
	if (!records.runtime) warnings.push("Runtime Context is missing");
	else if (records.runtime.kind !== input.kind) {
		warnings.push(`Runtime Context kind '${records.runtime.kind}' does not match '${input.kind}'`);
	}
	const state = readResearchState(runDir, warnings);
	const terminalNodes = (records.runtime?.events ?? []).flatMap((event): TraceNode[] => {
		if (!nodeRecord(event)) return [];
		return [toTraceNode(event, input.runId, referenceContext)];
	});
	const nodes = terminalNodes;
	if (nodes.length === 0) warnings.push("No Node Execution records were found");
	for (const node of nodes) {
		if (node.nodeType === "agent" && node.attempt === undefined) {
			warnings.push(`Agent Node '${node.nodeId}' has no explicit attempt`);
		}
	}
	const startedAt = state?.startedAt ?? earliest(nodes.map((node) => node.startedAt));
	const finishedAt = state?.finishedAt ?? latest(nodes.map((node) => node.finishedAt));
	const durationMs = duration(startedAt, finishedAt);
	if (startedAt && finishedAt && durationMs === undefined) warnings.push("Run duration could not be calculated from authoritative timestamps");
	const taskHistory = readTaskHistory(input.workspaceDir, input.goalId, input.runId, warnings);
	const historyUserInput = text(taskHistory?.originalQuestion);
	const userInput = input.originalUserInput?.trim() || historyUserInput;
	if (input.originalUserInput?.trim() && historyUserInput && input.originalUserInput.trim() !== historyUserInput) {
		warnings.push("Goal state user input differs from the Research task history originalQuestion; Goal state was used");
	}
	const researchTask = text(taskHistory?.canonicalResearchTask) ?? state?.question;
	if (!userInput) warnings.push("Original user input is unavailable");
	if (!researchTask) warnings.push("Research Task is unavailable");
	const model = taskHistoryModel(taskHistory);
	if (!model) warnings.push("Run model is unavailable from task history");
	const finalGate = readFinalGate(wikiRunDir, warnings, referencedFiles);
	const nodeUsage = readAgentNodeUsage(runDir, "research");
	const incompleteExecutions = nodeUsage?.incompleteExecutionIds.length ?? 0;
	const terminalExecutionCount = (nodeUsage?.completeExecutions ?? 0) + incompleteExecutions;
	const usage: TraceUsage | undefined = nodeUsage && terminalExecutionCount > 0
		? {
			inputTokens: nodeUsage.inputTokens,
			outputTokens: nodeUsage.outputTokens,
			costUsd: nodeUsage.costUsd,
			modelCalls: nodeUsage.modelCalls,
			basis: "terminal_agent_execution_metrics",
			completeness: incompleteExecutions === 0 ? "complete" : "lower_bound",
			completeExecutions: nodeUsage.completeExecutions,
			incompleteExecutions,
		}
		: undefined;
	if (incompleteExecutions > 0) {
		warnings.push(`Usage metrics are unavailable for ${incompleteExecutions} terminal Agent executions; reported usage is a lower bound from ${nodeUsage?.completeExecutions ?? 0} complete terminal executions`);
	}
	if (usage?.basis === "terminal_agent_execution_metrics" && state?.usage && !sameUsageTotals(usage, state.usage)) {
		warnings.push("Research run-state usage differs from terminal Agent execution metrics; known terminal attempt metrics were used");
	}
	const mainAgent = userInput
		? findMainAgentLinkage(input.workspaceDir, input.goalId, userInput, startedAt, finishedAt, warnings, referencedFiles)
		: undefined;
	const files = [
		...collectRunFiles(runDir, "runtime"),
		...collectWikiFiles(wikiRunDir),
		...referencedFiles.values(),
	];
	return {
		schemaVersion: 1,
		goalId: input.goalId,
		kind: input.kind,
		runId: input.runId,
		status: finalGate?.halt ? "failed" : state?.status ?? deriveStatus(nodes),
		...(startedAt ? { startedAt } : {}),
		...(finishedAt ? { finishedAt } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(model ? { model } : {}),
		...(usage ? { usage } : {}),
		...(finalGate ? { finalGate } : {}),
		origin: {
			goalId: input.goalId,
			...(input.goalTitle ? { goalTitle: input.goalTitle } : {}),
			...(userInput ? { userInput } : {}),
			...(researchTask ? { researchTask } : {}),
		},
		linkage: { ...(mainAgent ? { mainAgent } : {}) },
		nodes,
		files: dedupeFiles(files),
		warnings: [...new Set(warnings)],
	};
}

function readWikiTraceRun(input: {
	workspaceDir: string;
	goalId: string;
	kind: "wiki";
	runId: string;
	runDirectory?: string;
	goalTitle?: string;
}): TraceRun {
	const runDir = input.runDirectory ?? join(traceRunsRoot(input.workspaceDir, input.goalId, "wiki"), input.runId);
	if (!existsSync(runDir) || !lstatSync(runDir).isDirectory() || lstatSync(runDir).isSymbolicLink()) {
		throw new Error(`Unknown wiki Trace Run '${input.runId}'`);
	}
	const job = new WikiUpdateJobStore(runDir).load();
	if (!job) throw new Error(`Wiki Trace Run '${input.runId}' has no wiki-update-job.json`);
	const warnings: string[] = [];
	const referencedFiles = new Map<string, TraceFileRef>();
	const context: ReferenceContext = { runDir, wikiRunDir: join(runDir, ".unused-wiki-root"), warnings, referencedFiles };
	const batches = (job.progress?.batches ?? []) as unknown as Record<string, unknown>[];
	const stages = (job.progress?.stages ?? []) as unknown as Record<string, unknown>[];
	const cases = nodeEvaluationCases(runDir);
	let eventId = 0;
	const batchNodes = batches.map((batch): TraceNode => {
		eventId += 1;
		const index = Math.max(0, Math.trunc(finiteNumber(batch.batch_index) ?? eventId - 1));
		return wikiTraceNode({
			eventId,
			runId: input.runId,
			caseRunId: `${input.runId}-wiki-shard-${index + 1}`,
			nodeId: `wiki-shard-builder-batch-${String(index + 1).padStart(3, "0")}`,
			nodeType: "agent",
			agent: "wiki_shard_builder",
			attempt: positiveInteger(batch.attempt) ?? 1,
			value: batch,
			dependsOn: [],
			context,
			cases,
		});
	});
	let priorStageId: number | undefined;
	const stageNodes = stages.map((stage): TraceNode => {
		eventId += 1;
		const kind = text(stage.kind) ?? "stage";
		const index = Math.max(0, Math.trunc(finiteNumber(stage.stage_index) ?? eventId - 1));
		const agent = kind === "curation" ? "wiki_curator" : undefined;
		const node = wikiTraceNode({
			eventId,
			runId: input.runId,
			...(agent ? { caseRunId: `${input.runId}-wiki-curator-batch-${String(index + 1).padStart(3, "0")}` } : {}),
			nodeId: `wiki-${kind}-${String(index + 1).padStart(3, "0")}`,
			nodeType: agent ? "agent" : "runtime",
			...(agent ? { agent, attempt: 1 } : {}),
			value: stage,
			dependsOn: priorStageId ? [priorStageId] : batchNodes.flatMap((node) => node.eventId ?? []),
			context,
			cases,
		});
		priorStageId = eventId;
		return node;
	});
	const nodes = [...batchNodes, ...stageNodes];
	const agentItems = [...batches, ...stages.filter((stage) => text(stage.kind) === "curation")];
	const metrics = agentItems.map((item) => wikiUsage(record(item.usage)));
	const complete = metrics.filter((value): value is TraceUsageTotals => Boolean(value));
	const totals = complete.reduce((sum, value) => ({
		inputTokens: sum.inputTokens + value.inputTokens,
		outputTokens: sum.outputTokens + value.outputTokens,
		costUsd: sum.costUsd + value.costUsd,
		modelCalls: sum.modelCalls + value.modelCalls,
	}), { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0 });
	const incompleteExecutions = agentItems.length - complete.length;
	const usage: TraceUsage | undefined = agentItems.length > 0 ? {
		...totals,
		basis: "terminal_agent_execution_metrics",
		completeness: incompleteExecutions > 0 ? "lower_bound" : "complete",
		completeExecutions: complete.length,
		incompleteExecutions,
	} : undefined;
	if (incompleteExecutions > 0) warnings.push(`Usage metrics are unavailable for ${incompleteExecutions} Wiki Agent executions`);
	const sourceRunId = text(job.source_run_id);
	const taskHistory = sourceRunId
		? readTaskHistory(input.workspaceDir, input.goalId, sourceRunId, warnings)
		: undefined;
	const userInput = text(taskHistory?.originalQuestion);
	const researchTask = text(taskHistory?.canonicalResearchTask) ?? text(job.goal);
	const sourceState = sourceRunId
		? readResearchState(join(traceRunsRoot(input.workspaceDir, input.goalId, "research"), sourceRunId), [])
		: undefined;
	const mainAgent = userInput
		? findMainAgentLinkage(input.workspaceDir, input.goalId, userInput, sourceState?.startedAt, sourceState?.finishedAt,
			warnings, referencedFiles)
		: undefined;
	const startedAt = text(job.started_at) ?? earliest(nodes.map((node) => node.startedAt));
	const finishedAt = text(job.finished_at) ?? latest(nodes.map((node) => node.finishedAt));
	// A Wiki Run pins its Curator model at the start; that pin is the model the Run actually used.
	const model = cases.map(({ value }) => text(record(value.request)?.actualModel))
		.find((value): value is string => Boolean(value))
		?? pinnedWikiModel(runDir)
		?? taskHistoryModel(taskHistory);
	const durationMs = duration(startedAt, finishedAt);
	return {
		schemaVersion: 1,
		goalId: input.goalId,
		kind: "wiki",
		runId: input.runId,
		status: traceStatus(job.status),
		...(startedAt ? { startedAt } : {}),
		...(finishedAt ? { finishedAt } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(model ? { model } : {}),
		...(usage ? { usage } : {}),
		origin: {
			goalId: input.goalId,
			...(input.goalTitle ? { goalTitle: input.goalTitle } : {}),
			...(userInput ? { userInput } : {}),
			...(researchTask ? { researchTask } : {}),
		},
		linkage: { ...(mainAgent ? { mainAgent } : {}) },
		nodes,
		files: dedupeFiles([...collectRunFiles(runDir, "runtime"), ...referencedFiles.values()]),
		warnings: [...new Set(warnings)],
	};
}

function wikiTraceNode(input: {
	eventId: number;
	runId: string;
	caseRunId?: string;
	nodeId: string;
	nodeType: "runtime" | "agent";
	agent?: string;
	attempt?: number;
	value: Record<string, unknown>;
	dependsOn: number[];
	context: ReferenceContext;
	cases: Array<{ value: Record<string, unknown> }>;
}): TraceNode {
	const traceRef = text(input.value.trace_ref)
		? normalizeExistingFileReference(text(input.value.trace_ref)!, input.context)
		: undefined;
	const nodeCase = input.caseRunId
		? input.cases.find(({ value }) => text(value.runId) === input.caseRunId)
		: undefined;
	const caseId = text(nodeCase?.value.caseId);
	const caseFileRef = caseId
		? normalizeFileReference(`node-evaluation/cases/${caseId}/manifest.json`, input.context)
		: undefined;
	return {
		eventId: input.eventId,
		nodeId: input.nodeId,
		nodeType: input.nodeType,
		...(input.agent ? { agent: input.agent } : {}),
		executionId: input.caseRunId ?? `${input.runId}-${input.nodeId}`,
		...(input.attempt ? { attempt: input.attempt } : {}),
		status: traceStatus(input.value.status),
		dependsOn: input.dependsOn,
		startedAt: text(input.value.started_at),
		finishedAt: text(input.value.finished_at),
		durationMs: duration(text(input.value.started_at), text(input.value.finished_at)),
		input: {},
		output: {
			...(finiteNumber(input.value.page_count) !== undefined ? { page_count: finiteNumber(input.value.page_count) } : {}),
			...(record(input.value.usage) ? { metrics: input.value.usage } : {}),
		},
		...(traceRef ? { traceRef } : {}),
		...(caseId && caseFileRef ? { caseRef: { sourceRunId: input.runId, caseId, fileRef: caseFileRef } } : {}),
	};
}

function nodeEvaluationCases(runDir: string): Array<{ value: Record<string, unknown> }> {
	const root = join(runDir, "node-evaluation", "cases");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name, "manifest.json");
		if (!entry.isDirectory() || !existsSync(path)) return [];
		const value = record(JSON.parse(readFileSync(path, "utf-8")));
		return value ? [{ value }] : [];
	});
}

function caseIdsByNode(runDir: string): Map<string, string> {
	const ids = new Map<string, string>();
	const ambiguous = new Set<string>();
	for (const { value } of nodeEvaluationCases(runDir)) {
		const nodeId = text(value.nodeId);
		const caseId = text(value.caseId);
		if (!nodeId || !caseId) continue;
		if (ids.has(nodeId)) ambiguous.add(nodeId);
		else ids.set(nodeId, caseId);
	}
	for (const nodeId of ambiguous) ids.delete(nodeId);
	return ids;
}

function wikiUsage(value: Record<string, unknown> | undefined): TraceUsageTotals | undefined {
	if (!value) return undefined;
	const inputTokens = finiteNumber(value.input_tokens);
	const outputTokens = finiteNumber(value.output_tokens);
	const costUsd = finiteNumber(value.cost_usd);
	const modelCalls = finiteNumber(value.model_calls);
	return inputTokens !== undefined && outputTokens !== undefined && costUsd !== undefined && modelCalls !== undefined
		? { inputTokens, outputTokens, costUsd, modelCalls }
		: undefined;
}

function traceStatus(value: unknown): TraceStatus {
	const status = String(value ?? "");
	return ["running", "succeeded", "skipped", "failed", "cancelled", "interrupted"].includes(status)
		? status as TraceStatus
		: "interrupted";
}

export function resolveTraceFile(input: {
	workspaceDir: string;
	goalId: string;
	kind: TraceKind;
	runId: string;
	ref: string;
}): string {
	if (!safeIdentity(input.runId)) throw new Error("Invalid Trace Run id");
	const slash = input.ref.indexOf("/");
	if (slash <= 0) throw new Error("Trace file ref must start with runtime/ or wiki/");
	const source = input.ref.slice(0, slash);
	const relativeRef = input.ref.slice(slash + 1);
	if (!relativeRef || relativeRef.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error("Invalid Trace file ref");
	}
	const root = source === "runtime"
		? join(traceRunsRoot(input.workspaceDir, input.goalId, input.kind), input.runId)
		: source === "wiki" && input.kind === "research"
			? join(input.workspaceDir, input.goalId, "wiki", "runs", input.runId)
			: source === "main"
				? mainRootForAllowedRef(input)
			: undefined;
	if (!root || !existsSync(root)) throw new Error("Unknown Trace file root");
	const rootReal = realpathSync(root);
	const candidate = resolve(rootReal, ...relativeRef.split("/"));
	if (!candidate.startsWith(`${rootReal}${sep}`) || !existsSync(candidate)) throw new Error("Unknown Trace file");
	const fileReal = realpathSync(candidate);
	if (!fileReal.startsWith(`${rootReal}${sep}`)) throw new Error("Trace file escapes its Run root");
	const stat = lstatSync(fileReal);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Trace ref is not a regular file");
	return fileReal;
}

function traceRunsRoot(workspaceDir: string, goalId: string, kind: TraceKind): string {
	return join(serverRuntimeDirForGoal(goalId, workspaceDir), kind === "research" ? "runs" : "wiki-updates");
}

function summary(run: TraceRun): TraceRunSummary {
	const { nodes, files: _files, ...rest } = run;
	return { ...rest, nodeCount: nodes.length };
}

function nodeRecord(event: Record<string, unknown>): event is Record<string, unknown> & NodeExecutionRecord & { event_id: number } {
	return event.type === "node_execution"
		&& typeof event.event_id === "number"
		&& typeof event.node_id === "string"
		&& (event.node_type === "runtime" || event.node_type === "agent")
		&& ["succeeded", "failed", "cancelled", "interrupted"].includes(String(event.status))
		&& Array.isArray(event.depends_on)
		&& Boolean(event.input && typeof event.input === "object")
		&& Boolean(event.output && typeof event.output === "object")
		&& Boolean(event.time && typeof event.time === "object");
}

interface ReferenceContext {
	runDir: string;
	wikiRunDir: string;
	warnings: string[];
	referencedFiles: Map<string, TraceFileRef>;
	caseByNodeId?: Map<string, string>;
	providerCallsByNode?: Map<string, number>;
}

function providerCallCounts(runDir: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const call of readProviderCallRecords(runDir)) counts.set(call.node_id, (counts.get(call.node_id) ?? 0) + 1);
	return counts;
}

function toTraceNode(
	event: Record<string, unknown> & NodeExecutionRecord & { event_id: number },
	runId: string,
	context: ReferenceContext,
): TraceNode {
	const evaluation = event.output.node_evaluation;
	const caseId = (evaluation && typeof evaluation === "object"
		&& typeof (evaluation as Record<string, unknown>).case_id === "string"
		? String((evaluation as Record<string, unknown>).case_id)
		: undefined) ?? context.caseByNodeId?.get(event.node_id);
	const caseFileRef = caseId
		? normalizeFileReference(`node-evaluation/cases/${caseId}/manifest.json`, context)
		: undefined;
	const output = normalizeNodeReferences(event.output, context) as Record<string, unknown>;
	const traceRef = event.trace_ref ? normalizeExistingFileReference(event.trace_ref, context) : undefined;
	if (event.trace_ref && !traceRef) {
		context.warnings.push(`Agent Node '${event.node_id}' has an unreadable raw trace_ref and it was omitted from the projection`);
	}
	return {
		eventId: event.event_id,
		nodeId: event.node_id,
		nodeType: event.node_type,
		...(event.agent ? { agent: event.agent } : {}),
		...(event.execution_id ? { executionId: event.execution_id } : {}),
		...(positiveInteger(event.attempt) ? { attempt: positiveInteger(event.attempt) } : {}),
		status: event.status,
		dependsOn: event.depends_on,
		...(event.group_id ? { groupId: event.group_id } : {}),
		startedAt: event.time.started_at,
		finishedAt: event.time.finished_at,
		durationMs: event.time.duration_ms,
		input: normalizeNodeReferences(event.input, context) as Record<string, unknown>,
		output,
		...(traceRef ? { traceRef } : {}),
		...(caseId && caseFileRef ? { caseRef: { sourceRunId: runId, caseId, fileRef: caseFileRef } } : {}),
		...(event.node_type === "agent" ? { provider_call_count: context.providerCallsByNode?.get(event.node_id) ?? 0 } : {}),
		...(event.workspace ? { workspace: event.workspace } : {}),
	};
}

function readResearchState(runDir: string, warnings: string[]): {
	status: TraceStatus;
	startedAt?: string;
	finishedAt?: string;
	question?: string;
	usage?: TraceUsageTotals;
} | undefined {
	const path = join(runDir, "run-state.json");
	if (!existsSync(path)) {
		warnings.push("Research run-state.json is missing");
		return undefined;
	}
	const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const rawStatus = String(value.status ?? "");
		const finishedAt = typeof value.finished_at === "string" ? value.finished_at : undefined;
	const status: TraceStatus = rawStatus === "published"
			? "succeeded"
			: rawStatus === "skipped"
				? "skipped"
				: ["running", "failed", "cancelled", "interrupted"].includes(rawStatus)
					? rawStatus as TraceStatus
					: finishedAt ? "interrupted" : "running";
	const usage = record(value.usage);
		const parsedUsage = usage
			&& finiteNumber(usage.input_tokens) !== undefined
			&& finiteNumber(usage.output_tokens) !== undefined
			&& finiteNumber(usage.cost_usd) !== undefined
			&& finiteNumber(usage.model_calls) !== undefined
			? {
				inputTokens: finiteNumber(usage.input_tokens)!,
				outputTokens: finiteNumber(usage.output_tokens)!,
				costUsd: finiteNumber(usage.cost_usd)!,
				modelCalls: finiteNumber(usage.model_calls)!,
			}
			: undefined;
	if (!parsedUsage) warnings.push("Research usage is missing or incomplete in run-state.json");
	return {
			status,
			...(typeof value.started_at === "string" ? { startedAt: value.started_at } : {}),
			...(finishedAt ? { finishedAt } : {}),
			...(text(value.question) ? { question: text(value.question) } : {}),
			...(parsedUsage ? { usage: parsedUsage } : {}),
	};
}

function sameUsageTotals(left: TraceUsageTotals, right: TraceUsageTotals): boolean {
	return left.inputTokens === right.inputTokens
		&& left.outputTokens === right.outputTokens
		&& left.costUsd === right.costUsd
		&& left.modelCalls === right.modelCalls;
}

function deriveStatus(nodes: TraceNode[]): TraceStatus {
	if (nodes.some((node) => node.status === "failed")) return "failed";
	if (nodes.some((node) => node.status === "cancelled")) return "cancelled";
	if (nodes.some((node) => node.status === "interrupted")) return "interrupted";
	if (nodes.some((node) => node.status === "running")) return "running";
	if (nodes.length > 0 && nodes.every((node) => node.status === "skipped")) return "skipped";
	return nodes.length > 0 ? "succeeded" : "interrupted";
}

function collectRunFiles(root: string, prefix: string): TraceFileRef[] {
	const descend = (relativePath: string) => {
		const segments = relativePath.split("/");
		if (segments[0] === "node-evaluation") return segments.length <= 3
			&& !segments.some((segment) => ["input", "mounts", "observed-output"].includes(segment));
		if (segments[0] === "stage-artifacts") return segments.length === 1
			|| (segments.length === 2 && segments[1] === "agent-reports");
		return segments.length === 1 && ["agent-reports", "trajectories"].includes(segments[0]!);
	};
	return collectFiles(root, prefix, (relativePath) => {
		const segments = relativePath.split("/");
		if (![".json", ".jsonl", ".md", ".txt"].includes(extname(relativePath))) return false;
		if (segments.length === 1) return true;

		if (segments[0] === "node-evaluation" && segments[1] === "cases") {
			return ["manifest.json", "interactions.json", "system-prompt.txt", "composed-system-prompt.txt", "user-prompt.txt", PROVIDER_CALLS_FILE].includes(basename(relativePath));
		}
		if (segments.length === 2 && segments[0] === "trajectories") return segments[1] === "manifest.json";
		return (segments.length === 2 && segments[0] === "agent-reports")
			|| (segments.length === 3 && segments[0] === "stage-artifacts" && segments[1] === "agent-reports");
	}, descend);
}

function collectWikiFiles(root: string): TraceFileRef[] {
	return collectFiles(root, "wiki", (relativePath) =>
		/^artifacts\/search-executions\/[^/]+\.json$/u.test(relativePath)
		|| /^artifacts\/source-bundles\/.+\/(result|source-index)\.json$/u.test(relativePath)
		|| /^artifacts\/accepted-chapters\/[^/]+\.md$/u.test(relativePath)
		|| relativePath === "artifacts/final_gate.json"
		|| relativePath === "artifacts/report-flow/task.md"
		|| relativePath === "artifacts/report-flow/outline.json"
		|| relativePath === "artifacts/report-flow/executable-plan.json"
		|| relativePath === "artifacts/report-flow/knowledge-url-registry.json"
		|| /^artifacts\/report-flow\/writer\/(?:manifest\.json|sections\/[^/]+\.md)$/u.test(relativePath)
		|| /^artifacts\/cornell-notes\/snapshot-(?:seed|\d+)\.json$/u.test(relativePath)
		|| /^artifacts\/wiki-compilations\/[^/]+\/compilation\.json$/u.test(relativePath)
		|| /^artifacts\/wiki-compilations\/[^/]+\/(?:knowledge|agent-update)\/.+\.md$/u.test(relativePath)
		|| relativePath === "report/final.json"
		|| relativePath === "report/final.md");
}

function collectFiles(
	root: string,
	prefix: string,
	include: (relativePath: string) => boolean,
	descend: (relativePath: string) => boolean = () => true,
): TraceFileRef[] {
	if (!existsSync(root)) return [];
	const files: TraceFileRef[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				const relativePath = relative(root, path).split(sep).join("/");
				if (descend(relativePath)) visit(path);
			}
			else if (entry.isFile()) {
				const relativePath = relative(root, path).split(sep).join("/");
				if (include(relativePath)) files.push({
					kind: fileKind(relativePath),
					ref: `${prefix}/${relativePath}`,
					mediaType: mediaType(path),
					byteLength: statSync(path).size,
				});
			}
		}
	};
	visit(root);
	return files.sort((left, right) => left.ref.localeCompare(right.ref));
}

const NODE_FILE_REF_KEYS = new Set([
	"artifact_ref",
	"gate_ref",
	"final_report_ref",
	"system_prompt_ref",
	"case_ref",
]);

function normalizeNodeReferences(value: unknown, context: ReferenceContext): unknown {
	if (Array.isArray(value)) return value.map((item) => normalizeNodeReferences(item, context));
	const object = record(value);
	if (!object) return value;
	return Object.fromEntries(Object.entries(object).map(([key, item]) => {
		if (NODE_FILE_REF_KEYS.has(key) && typeof item === "string") {
			return [key, normalizeReference(item, context) ?? { type: "unresolved", value: item }];
		}
		return [key, normalizeNodeReferences(item, context)];
	}));
}

function normalizeFileReference(value: string, context: ReferenceContext): string | undefined {
	const resolved = normalizeReference(value, context);
	return typeof resolved === "string" ? resolved : undefined;
}

function normalizeExistingFileReference(value: string, context: ReferenceContext): string | undefined {
	const candidates = referenceCandidates(value, context);
	if (candidates.length !== 1 || !lstatSync(candidates[0]!.path).isFile()) return undefined;
	const candidate = candidates[0]!;
	const file = traceFile(candidate.path, candidate.root, candidate.prefix);
	context.referencedFiles.set(file.ref, file);
	if (basename(candidate.path) === "sdk-events.jsonl") {
		const childRoot = join(dirname(candidate.path), "session-artifacts");
		const childPrefix = `${candidate.prefix}/${relative(candidate.root, childRoot).split(sep).join("/")}`;
		for (const child of collectFiles(childRoot, childPrefix,
			(path) => /^sub-[^/]+\/[^/]+\.jsonl$/u.test(path),
			(path) => /^sub-[^/]+$/u.test(path))) {
			context.referencedFiles.set(child.ref, { ...child, kind: "related_agent_trace" });
		}
	}
	return file.ref;
}

function normalizeReference(value: string, context: ReferenceContext): string | TraceDirectoryRef | undefined {
	const candidates = referenceCandidates(value, context);
	if (candidates.length === 0) {
		context.warnings.push(`Trace reference '${value}' could not be resolved`);
		return undefined;
	}
	if (candidates.length > 1) {
		context.warnings.push(`Trace reference '${value}' is ambiguous across Run roots`);
		return undefined;
	}
	const candidate = candidates[0]!;
	if (lstatSync(candidate.path).isFile()) {
		const file = traceFile(candidate.path, candidate.root, candidate.prefix);
		context.referencedFiles.set(file.ref, file);
		return file.ref;
	}
	const resolvedFiles = collectFiles(
		candidate.path,
		`${candidate.prefix}/${candidate.relativeRef}`,
		(relativePath) => candidate.relativeRef === "artifacts/report-flow/writer"
			? relativePath === "manifest.json" || /^sections\/[^/]+\.md$/u.test(relativePath)
			: ["result.json", "source-index.json"].includes(basename(relativePath))
				&& !relativePath.includes("document-parsing/"),
	).map((file) => ({
		...file,
		kind: candidate.relativeRef === "artifacts/report-flow/writer"
			? basename(file.ref) === "manifest.json" ? "writer_chapter_manifest" : "writer_chapter"
			: basename(file.ref) === "result.json" ? "source_bundle_result" : "source_bundle_index",
	}));
	for (const file of resolvedFiles) context.referencedFiles.set(file.ref, file);
	if (resolvedFiles.length === 0) context.warnings.push(`Trace directory reference '${value}' has no disclosed files`);
	return { type: "directory", resolvedFiles };
}

function referenceCandidates(value: string, context: ReferenceContext): Array<{
	path: string;
	root: string;
	prefix: "runtime" | "wiki";
	relativeRef: string;
}> {
	const explicitSlash = value.indexOf("/");
	const explicitSource = explicitSlash > 0 ? value.slice(0, explicitSlash) : undefined;
	const relativeRef = explicitSource === "runtime" || explicitSource === "wiki"
		? value.slice(explicitSlash + 1)
		: value;
	if (!safeRelativeRef(relativeRef)) return [];
	const roots = explicitSource === "runtime"
		? [{ root: context.runDir, prefix: "runtime" as const }]
		: explicitSource === "wiki"
			? [{ root: context.wikiRunDir, prefix: "wiki" as const }]
			: [
				{ root: context.runDir, prefix: "runtime" as const },
				{ root: context.wikiRunDir, prefix: "wiki" as const },
			];
	return roots.flatMap(({ root, prefix }) => {
		if (!existsSync(root)) return [];
		const path = resolve(root, ...relativeRef.split("/"));
		if (!path.startsWith(`${resolve(root)}${sep}`) || !existsSync(path)) return [];
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return [];
		return [{ path, root, prefix, relativeRef }];
	});
}

function traceFile(path: string, root: string, prefix: string, kind?: string): TraceFileRef {
	const relativePath = relative(root, path).split(sep).join("/");
	return {
		kind: kind ?? fileKind(relativePath),
		ref: `${prefix}/${relativePath}`,
		mediaType: mediaType(path),
		byteLength: statSync(path).size,
	};
}

function readTaskHistory(
	workspaceDir: string,
	goalId: string,
	runId: string,
	warnings: string[],
): Record<string, unknown> | undefined {
	const path = join(serverRuntimeDirForGoal(goalId, workspaceDir), "history", "user_tasks.jsonl");
	if (!existsSync(path)) {
		warnings.push("Research task history is missing");
		return undefined;
	}
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		const value = record(JSON.parse(line));
		if (!value) throw new Error("Research task history line must contain an object");
		const researchRun = record(value.researchRun);
		if (value.type === "task_history" && researchRun?.workspaceRunId === runId) return value;
	}
	warnings.push(`Research task history has no entry for Run '${runId}'`);
	return undefined;
}

function pinnedWikiModel(wikiRunDir: string): string | undefined {
	const path = join(wikiRunDir, "wiki-model-selection.json");
	if (!existsSync(path)) return undefined;
	try { return text(record(JSON.parse(readFileSync(path, "utf-8")))?.TELOMI_WIKI_MAINTAINER_MODEL); }
	catch { return undefined; }
}

function taskHistoryModel(taskHistory: Record<string, unknown> | undefined): string | undefined {
	return text(record(taskHistory?.researchRun)?.model);
}

function readFinalGate(
	wikiRunDir: string,
	warnings: string[],
	files: Map<string, TraceFileRef>,
): TraceRunSummary["finalGate"] {
	const path = join(wikiRunDir, "artifacts", "final_gate.json");
	if (!existsSync(path)) {
		warnings.push("Final gate artifact is missing");
		return undefined;
	}
	const gate = record(JSON.parse(readFileSync(path, "utf-8")));
	if (typeof gate?.ok !== "boolean" || typeof gate.halt !== "boolean") {
		throw new Error("Final gate artifact does not contain boolean ok and halt fields");
	}
	const file = traceFile(path, wikiRunDir, "wiki");
	files.set(file.ref, file);
	return { ok: gate.ok, halt: gate.halt, ref: file.ref };
}

function findMainAgentLinkage(
	workspaceDir: string,
	goalId: string,
	userInput: string,
	researchStartedAt: string | undefined,
	researchFinishedAt: string | undefined,
	warnings: string[],
	files: Map<string, TraceFileRef>,
): TraceMainAgentLinkage | undefined {
	const mainRunsRoot = join(serverRuntimeDirForGoal(goalId, workspaceDir), "main-agent", "runs");
	if (!existsSync(mainRunsRoot)) {
		warnings.push("Main Agent run store is missing");
		return undefined;
	}
	const matches = readdirSync(mainRunsRoot, { withFileTypes: true }).flatMap((entry) => {
		if (!entry.isDirectory() || !safeIdentity(entry.name)) return [];
		const runDir = join(mainRunsRoot, entry.name);
		const runtimePath = join(runDir, "runtime--main.jsonl");
		const events = existsSync(runtimePath) ? readJsonLines(runtimePath, warnings, "Main Agent runtime trace") : [];
		const node = events.find((event) => event.type === "node_execution"
			&& event.node_id === "main-agent"
			&& text(record(event.input)?.question) === userInput);
		const time = record(node?.time);
		const startedAt = text(time?.started_at);
		const finishedAt = text(time?.finished_at);
		if (!node || (researchStartedAt && startedAt && startedAt > researchStartedAt)
			|| (researchFinishedAt && finishedAt && finishedAt < researchFinishedAt)) return [];
		return [{ runId: entry.name, runDir }];
	});
	if (matches.length !== 1) {
		warnings.push(matches.length === 0
			? "No Main Agent run matches the original user input and Research time range"
			: "Multiple Main Agent runs match the original user input and Research time range");
		return undefined;
	}
	const match = matches[0]!;
	const routePath = join(match.runDir, "route-trace.json");
	let sessionName = "main-agent.jsonl";
	if (existsSync(routePath)) {
		const route = record(JSON.parse(readFileSync(routePath, "utf-8")));
		if (!route) throw new Error("Main Agent route trace must contain an object");
		sessionName = text(route.sessionRef) ?? sessionName;
	}
	const refs = {
		sessionRef: { name: sessionName, kind: "main_agent_session" },
		routeTraceRef: { name: "route-trace.json", kind: "main_agent_route_trace" },
		runtimeTraceRef: { name: "runtime--main.jsonl", kind: "main_agent_runtime_trace" },
	};
	const resolved = Object.fromEntries(Object.entries(refs).flatMap(([key, value]) => {
		const path = join(match.runDir, value.name);
		if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
			warnings.push(`Main Agent ${key} is missing for Run '${match.runId}'`);
			return [];
		}
		const file = traceFile(path, mainRunsRoot, "main", value.kind);
		files.set(file.ref, file);
		return [[key, file.ref]];
	})) as Partial<Record<keyof typeof refs, string>>;
	if (!resolved.sessionRef || !resolved.routeTraceRef || !resolved.runtimeTraceRef) return undefined;
	warnings.push("Main Agent linkage was inferred from the exact original user input and enclosing execution time");
	return {
		executionKind: "main_agent",
		runId: match.runId,
		sessionRef: resolved.sessionRef,
		routeTraceRef: resolved.routeTraceRef,
		runtimeTraceRef: resolved.runtimeTraceRef,
	};
}

function dedupeFiles(files: TraceFileRef[]): TraceFileRef[] {
	return [...new Map(files.map((file) => [file.ref, file])).values()]
		.sort((left, right) => left.ref.localeCompare(right.ref));
}

function readJsonLines(path: string, warnings: string[], label: string): Record<string, unknown>[] {
	void warnings;
	return readFileSync(path, "utf-8").split("\n").flatMap((line, index) => {
		if (!line.trim()) return [];
		const value = record(JSON.parse(line));
		if (!value) throw new Error(`${label}:${index + 1} must contain an object`);
		return [value];
	});
}

function fileKind(path: string): string {
	const name = basename(path);
	if (path === "artifacts/final_gate.json") return "final_gate";
	if (path === "report/final.json") return "final_report_json";
	if (path === "report/final.md") return "final_report_markdown";
	if (path === "artifacts/report-flow/task.md") return "research_task";
	if (path === "artifacts/report-flow/outline.json") return "report_outline";
	if (path === "artifacts/report-flow/executable-plan.json") return "executable_report_plan";
	if (path === "artifacts/report-flow/knowledge-url-registry.json") return "knowledge_url_registry";
	if (path === "artifacts/report-flow/writer/manifest.json") return "writer_chapter_manifest";
	if (/^artifacts\/report-flow\/writer\/sections\/[^/]+\.md$/u.test(path)) return "writer_chapter";
	if (/^artifacts\/cornell-notes\/snapshot-(?:seed|\d+)\.json$/u.test(path)) return "cornell_note_snapshot";
	if (/^artifacts\/wiki-compilations\/[^/]+\/compilation\.json$/u.test(path)) return "wiki_compilation";
	if (path.includes("/agent-update/")) return "wiki_agent_update";
	if (path.includes("/wiki-compilations/") && path.includes("/knowledge/")) return "wiki_final_snapshot";
	if (path.startsWith("artifacts/accepted-chapters/")) return "accepted_chapter";
	if (/^artifacts\/source-bundles\/.+\/result\.json$/u.test(path)) return "source_bundle_result";
	if (/^artifacts\/source-bundles\/.+\/source-index\.json$/u.test(path)) return "source_bundle_index";
	if (name.startsWith("runtime--")) return "runtime_context";
	if (name === "run-context-snapshot.json") return "run_context_snapshot";
	if (name.endsWith(".system-prompt.txt")) return "system_prompt";
	if (name === PROVIDER_CALLS_FILE) return "provider_calls";
	if (path.startsWith("artifacts/search-executions/")) return "search_execution";
	if (/gate|verification/u.test(path.toLowerCase())) return "gate";
	if (/final\.md|final-report|report\/final|published/u.test(path.toLowerCase())) return "final_artifact";
	if (name === "manifest.json" && path.startsWith("node-evaluation/")) return "node_evaluation_case";
	if (name.endsWith(".jsonl") && !path.includes("/")) return "agent_session";
	return "artifact";
}

function mediaType(path: string): string {
	if (path.endsWith(".json")) return "application/json";
	if (path.endsWith(".jsonl")) return "application/x-ndjson";
	if (path.endsWith(".md")) return "text/markdown";
	return "text/plain";
}

function mainRootForAllowedRef(input: {
	workspaceDir: string;
	goalId: string;
	kind: TraceKind;
	runId: string;
	ref: string;
}): string {
	const run = readTraceRun({
		workspaceDir: input.workspaceDir,
		goalId: input.goalId,
		kind: input.kind,
		runId: input.runId,
	});
	const main = run.linkage.mainAgent;
	if (!main || ![main.sessionRef, main.routeTraceRef, main.runtimeTraceRef].includes(input.ref)) {
		throw new Error("Main Agent Trace ref is not linked to this Research Run");
	}
	return join(serverRuntimeDirForGoal(input.goalId, input.workspaceDir), "main-agent", "runs");
}

function safeRelativeRef(value: string): boolean {
	return Boolean(value) && value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function duration(startedAt: string | undefined, finishedAt: string | undefined): number | undefined {
	if (!startedAt || !finishedAt) return undefined;
	const started = Date.parse(startedAt);
	const finished = Date.parse(finishedAt);
	return Number.isFinite(started) && Number.isFinite(finished) && finished >= started ? finished - started : undefined;
}

function earliest(values: Array<string | undefined>): string | undefined {
	return values.filter((value): value is string => Boolean(value)).sort()[0];
}

function latest(values: Array<string | undefined>): string | undefined {
	return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function safeIdentity(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value) && value !== "." && value !== "..";
}
