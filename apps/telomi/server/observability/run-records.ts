import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { safeSegment } from "../lib/paths.js";

import { PROVIDER_CALLS_FILE } from "../providers/provider-call-record.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { listFilesRecursive, readJsonl } from "../lib/fs.js";

export type RuntimeRecordKind = "main" | "research" | "evaluation";

export interface RuntimeContextEvent {
	type: string;
	created_at?: string;
	[key: string]: unknown;
}

/** Content-addressed snapshots of the node work directory at entry and exit (see material_cache trees). */
export interface WorkspaceSnapshotRecord {
	input_tree_sha: string | null;
	output_tree_sha: string | null;
	exclude: string[];
	/** Set when input_tree_sha is the empty tree because the node starts in an empty work directory. */
	input_tree_source?: "empty-work-dir";
	warnings?: string[];
}

export interface NodeExecutionRecord {
	node_id: string;
	node_type: "runtime" | "agent";
	agent?: string;
	execution_id?: string;
	attempt?: number;
	status: "succeeded" | "failed" | "cancelled" | "interrupted";
	group_id?: string | null;
	depends_on: number[];
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	time: {
		started_at: string;
		finished_at: string;
		duration_ms: number;
	};
	trace_ref?: string;
	workspace?: WorkspaceSnapshotRecord;
}

export interface ParsedRunRecords {
	runId: string;
	runtime: {
		kind: RuntimeRecordKind;
		path: string;
		events: RuntimeContextEvent[];
	} | undefined;
	agentSessions: Array<{
		agent: string;
		executionId: string;
		path: string;
		entries: unknown[];
		toolCompletions: PiToolCompletion[];
	}>;
}

export interface PiToolCompletion {
	toolName?: string;
	toolCallId?: string;
	isError: boolean;
	message: unknown;
}

export interface ParsedPiSession {
	path: string;
	entries: unknown[];
	toolCompletions: PiToolCompletion[];
}

export interface AgentNodeUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	modelCalls: number;
	completeExecutions: number;
	incompleteExecutionIds: string[];
}

export interface TraceIntegrityResult {
	ok: boolean;
	issues: string[];
}

export function runRecordsDir(dataDir: string, goalId: string): string {
	return join(serverRuntimeDirForGoal(goalId, dataDir), "runs");
}

export function runRecordDir(dataDir: string, goalId: string, runId: string): string {
	return join(runRecordsDir(dataDir, goalId), pathIdentity(runId, "run"));
}

export function runtimeContextPath(runDir: string, kind: RuntimeRecordKind): string {
	return join(runDir, `runtime--${kind}.jsonl`);
}

export function agentSessionPath(runDir: string, agent: string, executionId: string): string {
	return join(runDir, `${safeSegment(agent, "agent")}--${safeSegment(executionId, "execution")}.jsonl`);
}

export function agentSystemPromptPath(
	runDir: string,
	agent: string,
	stageId: string,
	attemptId: string,
): string {
	return join(
		runDir,
		`${safeSegment(agent, "agent")}--${safeSegment(stageId, "stage")}--${safeSegment(attemptId, "attempt")}.system-prompt.txt`,
	);
}

export function writeAgentSystemPrompt(
	runDir: string,
	agent: string,
	stageId: string,
	attemptId: string,
	systemPrompt: string,
): string {
	const path = agentSystemPromptPath(runDir, agent, stageId, attemptId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, systemPrompt, { encoding: "utf-8", mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

export function appendRuntimeContext(
	runDir: string,
	kind: RuntimeRecordKind,
	event: RuntimeContextEvent,
): string {
	const path = runtimeContextPath(runDir, kind);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify({
		...event,
		created_at: event.created_at ?? new Date().toISOString(),
	})}\n`, "utf-8");
	return path;
}

export function appendResearchNodeRecord(
	runDir: string,
	record: NodeExecutionRecord,
): NodeExecutionRecord & { event_id: number; type: "node_execution" } {
	return appendNodeExecutionRecord(runDir, "research", record);
}

export function appendNodeExecutionRecord(
	runDir: string,
	kind: RuntimeRecordKind,
	record: NodeExecutionRecord,
): NodeExecutionRecord & { event_id: number; type: "node_execution" } {
	const path = runtimeContextPath(runDir, kind);
	const eventId = existsSync(path)
		? readFileSync(path, "utf-8").split(/\r?\n/u).filter(Boolean).length + 1
		: 1;
	const value = {
		type: "node_execution" as const,
		event_id: eventId,
		...record,
	};
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(value)}\n`, "utf-8");
	return value;
}

export function appendResearchRuntimeNode(
	runDir: string,
	record: {
		node_id: string;
		status: NodeExecutionRecord["status"];
		input: Record<string, unknown>;
		output: Record<string, unknown>;
		started_at?: string;
		finished_at?: string;
	},
): NodeExecutionRecord & { event_id: number; type: "node_execution" } {
	const finishedAt = record.finished_at ?? new Date().toISOString();
	const startedAt = record.started_at ?? finishedAt;
	return appendResearchNodeRecord(runDir, {
		node_id: record.node_id,
		node_type: "runtime",
		status: record.status,
		group_id: null,
		depends_on: latestNodeDependencyIds(runDir, "research"),
		input: record.input,
		output: record.output,
		time: {
			started_at: startedAt,
			finished_at: finishedAt,
			duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) || 0,
		},
	});
}

export function sealInterruptedAgentExecutions(
	runDir: string,
	kind: RuntimeRecordKind,
	finishedAt = new Date().toISOString(),
): Array<NodeExecutionRecord & { event_id: number; type: "node_execution" }> {
	const events = readRuntimeRecords(runDir, kind);
	const terminalExecutions = new Set(events.flatMap((event) =>
		event.type === "node_execution" && typeof event.execution_id === "string"
			? [event.execution_id]
			: []));
	const sealed: Array<NodeExecutionRecord & { event_id: number; type: "node_execution" }> = [];
	for (const bound of events) {
		if (
			bound.type !== "runtime.agent_bound"
			|| typeof bound.stage_id !== "string"
			|| typeof bound.execution_id !== "string"
			|| terminalExecutions.has(bound.execution_id)
		) continue;
		terminalExecutions.add(bound.execution_id);
		const related = events.filter((event) =>
			event.stage_id === bound.stage_id && event.execution_id === bound.execution_id);
		const terminal = [...related].reverse().find((event) =>
			["runtime.stage_completed", "runtime.stage_failed", "runtime.stage_cancelled"].includes(event.type));
		const status: NodeExecutionRecord["status"] = terminal?.type === "runtime.stage_completed"
			? "succeeded"
			: terminal?.type === "runtime.stage_failed"
				? "failed"
				: terminal?.type === "runtime.stage_cancelled"
					? "cancelled"
					: "interrupted";
		const startedAt = typeof bound.created_at === "string" ? bound.created_at : finishedAt;
		const endedAt = typeof terminal?.created_at === "string" ? terminal.created_at : finishedAt;
		const sessionFile = typeof bound.session_file === "string" && basename(bound.session_file) === bound.session_file
			? bound.session_file
			: undefined;
		const metrics = recordMetrics(terminal?.metrics)
			?? (sessionFile && readableSessionFile(runDir, sessionFile)
				? sessionUsage(join(runDir, sessionFile), positiveInteger(bound.message_count_before) ?? 0)
				: undefined);
		sealed.push(appendNodeExecutionRecord(runDir, kind, {
			node_id: bound.stage_id,
			node_type: "agent",
			...(typeof bound.agent === "string" ? { agent: bound.agent } : {}),
			execution_id: bound.execution_id,
			...(positiveInteger(bound.attempt) ? { attempt: positiveInteger(bound.attempt) } : {}),
			status,
			group_id: null,
			depends_on: latestNodeDependencyIds(runDir, kind),
			input: { stage_id: bound.stage_id, recovery: "sealed_after_process_interruption" },
			output: {
				...(typeof terminal?.output_ref === "string" ? { artifact_ref: terminal.output_ref } : {}),
				...(typeof terminal?.error === "string" ? { error: terminal.error } : {}),
				...(metrics ? { metrics } : {}),
			},
			time: {
				started_at: startedAt,
				finished_at: endedAt,
				duration_ms: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || 0,
			},
			...(sessionFile && readableSessionFile(runDir, sessionFile) ? { trace_ref: sessionFile } : {}),
		}));
	}
	return sealed;
}

export function readAgentNodeUsage(runDir: string, kind: RuntimeRecordKind): AgentNodeUsage {
	const usage: AgentNodeUsage = {
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		modelCalls: 0,
		completeExecutions: 0,
		incompleteExecutionIds: [],
	};
	const seenExecutions = new Set<string>();
	for (const event of readRuntimeRecords(runDir, kind)) {
		if (event.type !== "node_execution" || event.node_type !== "agent") continue;
		const executionId = typeof event.execution_id === "string"
			? event.execution_id
			: `event:${String(event.event_id)}`;
		if (seenExecutions.has(executionId)) continue;
		seenExecutions.add(executionId);
		const metrics = recordMetrics(record(event.output)?.metrics) ?? nativeSessionMetrics(runDir, event);
		if (!metrics) {
			usage.incompleteExecutionIds.push(executionId);
			continue;
		}
		usage.inputTokens += metrics.input_tokens;
		usage.outputTokens += metrics.output_tokens;
		usage.costUsd += metrics.cost_usd;
		usage.modelCalls += metrics.model_calls;
		usage.completeExecutions += 1;
	}
	return usage;
}

export function validateNodeExecutionTrace(runDir: string, kind: RuntimeRecordKind): TraceIntegrityResult {
	const events = readRuntimeRecords(runDir, kind);
	const issues: string[] = [];
	const eventIds = new Set<number>();
	const executions = new Set<string>();
	let previousEventId = 0;
	for (const event of events) {
		if (event.type !== "node_execution") continue;
		const eventId = positiveInteger(event.event_id);
		if (!eventId || eventIds.has(eventId) || eventId <= previousEventId) {
			issues.push(`invalid event_id '${String(event.event_id)}'`);
		} else {
			eventIds.add(eventId);
			previousEventId = eventId;
		}
		if (!["succeeded", "failed", "cancelled", "interrupted"].includes(String(event.status))) {
			issues.push(`node '${String(event.node_id)}' has non-terminal status '${String(event.status)}'`);
		}
		for (const dependency of Array.isArray(event.depends_on) ? event.depends_on : []) {
			if (!eventId || !positiveInteger(dependency) || dependency >= eventId || !eventIds.has(dependency)) {
				issues.push(`node '${String(event.node_id)}' has invalid dependency '${String(dependency)}'`);
			}
		}
		if (event.node_type !== "agent") continue;
		if (typeof event.agent !== "string" || !event.agent) issues.push(`agent node '${String(event.node_id)}' has no agent`);
		const executionId = typeof event.execution_id === "string" ? event.execution_id : "";
		if (!executionId) issues.push(`agent node '${String(event.node_id)}' has no execution_id`);
		else if (executions.has(executionId)) issues.push(`duplicate agent execution_id '${executionId}'`);
		else executions.add(executionId);
		if (!positiveInteger(event.attempt)) issues.push(`agent execution '${executionId || "unknown"}' has no explicit attempt`);
		const traceRef = typeof event.trace_ref === "string" ? event.trace_ref : "";
		if (!traceRef || !readableSessionFile(runDir, traceRef)) {
			issues.push(`agent execution '${executionId || "unknown"}' has no readable trace_ref`);
		}
	}
	for (const event of events) {
		if (event.type === "runtime.agent_bound" && typeof event.execution_id === "string" && !executions.has(event.execution_id)) {
			issues.push(`agent execution '${event.execution_id}' has no terminal Node Execution Record`);
		}
	}
	return { ok: issues.length === 0, issues };
}

/**
 * Dependencies for a node that starts now: the latest terminal node, or every member of
 * its group when the latest node belongs to one.
 *
 * A member of a parallel fanout passes its own group. The first member decides what the
 * fanout depends on and every later member reuses that record, so a staggered start, a
 * retry or a resume after unrelated nodes cannot make siblings, or the fanout's own
 * downstream, look like dependencies.
 */
export function latestNodeDependencyIds(
	runDir: string,
	kind: RuntimeRecordKind,
	options: { group?: string | null } = {},
): number[] {
	const path = runtimeContextPath(runDir, kind);
	if (!existsSync(path)) return [];
	const nodes = readJsonl<RuntimeContextEvent>(path)
		.filter((event): event is RuntimeContextEvent & {
			event_id: number;
			group_id?: string | null;
			depends_on?: unknown;
		} => event.type === "node_execution" && typeof event.event_id === "number");
	const recordedMember = options.group
		? nodes.find((event) => event.group_id === options.group)
		: undefined;
	if (recordedMember) {
		return Array.isArray(recordedMember.depends_on)
			? recordedMember.depends_on.filter((id): id is number => positiveInteger(id) !== undefined)
			: [];
	}
	const latest = nodes.at(-1);
	if (!latest) return [];
	if (!latest.group_id) return [latest.event_id];
	return nodes
		.filter((event) => event.group_id === latest.group_id)
		.map((event) => event.event_id);
}

export function readRunRecords(runDir: string): ParsedRunRecords {
	const files = existsSync(runDir)
		? readdirSync(runDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => entry.name)
			.sort()
		: [];
	const runtimeFiles = files.filter((name) => name.startsWith("runtime--"));
	if (runtimeFiles.length > 1) throw new Error(`Run directory contains multiple Runtime Context files: ${runDir}`);
	const runtimeName = runtimeFiles[0];
	const runtime = runtimeName
		? {
			kind: parseRuntimeKind(runtimeName),
			path: join(runDir, runtimeName),
			events: readJsonl<RuntimeContextEvent>(join(runDir, runtimeName)),
		}
		: undefined;
	const agentSessions = files
		.filter((name) => !name.startsWith("runtime--") && name !== PROVIDER_CALLS_FILE)
		.map((name) => {
			const identity = parseAgentSessionName(name);
			const path = join(runDir, name);
			return { ...identity, ...readPiSession(path) };
		});
	return { runId: basename(runDir), runtime, agentSessions };
}

export function readRuntimeRecords(
	runDir: string,
	kind: RuntimeRecordKind,
): RuntimeContextEvent[] {
	const path = runtimeContextPath(runDir, kind);
	return existsSync(path) ? readJsonl<RuntimeContextEvent>(path) : [];
}

export function readPiSession(path: string): ParsedPiSession {
	if (!existsSync(path)) throw new Error(`Pi session is missing: ${path}`);
	const entries = readJsonl(path);
	const toolCompletions = entries.flatMap((entry): PiToolCompletion[] => {
		if (!entry || typeof entry !== "object") return [];
		const record = entry as Record<string, unknown>;
		const message = record.type === "message" && record.message && typeof record.message === "object"
			? record.message as Record<string, unknown>
			: record;
		if (message.role !== "toolResult" && message.role !== "tool_result") return [];
		return [{
			...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
			...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
			isError: message.isError === true,
			message,
		}];
	});
	return { path, entries, toolCompletions };
}

function parseRuntimeKind(name: string): RuntimeRecordKind {
	const match = /^runtime--(main|research|evaluation)\.jsonl$/u.exec(name);
	if (!match) throw new Error(`Invalid Runtime Context filename: ${name}`);
	return match[1] as RuntimeRecordKind;
}

function parseAgentSessionName(name: string): { agent: string; executionId: string } {
	const match = /^([a-z0-9][a-z0-9._-]*)--([a-z0-9][a-z0-9._-]*)\.jsonl$/u.exec(name);
	if (!match) throw new Error(`Invalid Agent Session filename: ${name}`);
	return { agent: match[1]!, executionId: match[2]! };
}


function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readableSessionFile(runDir: string, value: string): boolean {
	if (basename(value) !== value) return false;
	const path = join(runDir, value);
	return existsSync(path) && !lstatSync(path).isSymbolicLink() && lstatSync(path).isFile();
}

function recordMetrics(value: unknown): {
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	model_calls: number;
} | undefined {
	const metrics = record(value);
	if (!metrics) return undefined;
	const input = metrics.input_tokens;
	const output = metrics.output_tokens;
	const cost = metrics.cost_usd;
	const calls = metrics.model_calls;
	return typeof input === "number" && Number.isFinite(input) && input >= 0
		&& typeof output === "number" && Number.isFinite(output) && output >= 0
		&& typeof cost === "number" && Number.isFinite(cost) && cost >= 0
		&& typeof calls === "number" && Number.isInteger(calls) && calls >= 0
		? { input_tokens: input, output_tokens: output, cost_usd: cost, model_calls: calls }
		: undefined;
}

function sessionUsage(path: string, messageCountBefore: number): ReturnType<typeof recordMetrics> {
	const messages = readJsonl<Record<string, unknown>>(path).flatMap((entry) => {
		const message = entry.type === "message" ? record(entry.message) : undefined;
		return message ? [message] : [];
	}).slice(messageCountBefore);
	return messageUsage(messages);
}

function nativeSessionMetrics(runDir: string, event: RuntimeContextEvent): ReturnType<typeof recordMetrics> {
	const executionId = typeof event.execution_id === "string" ? event.execution_id : undefined;
	const primeTraceRoot = executionId && event.agent === "prime_search"
		? join(runDir, "prime-search-traces", safeSegment(executionId, "execution"))
		: undefined;
	if (primeTraceRoot && existsSync(primeTraceRoot)) {
		return messageUsage(listFilesRecursive(primeTraceRoot, { absolute: true, sort: false, strict: true }).filter((path) => path.endsWith(".jsonl")).flatMap((path) =>
			readJsonl<Record<string, unknown>>(path).flatMap((entry) => {
				const message = entry.type === "message" ? record(entry.message) : undefined;
				return message ? [message] : [];
			})));
	}
	const traceRef = typeof event.trace_ref === "string" ? event.trace_ref : undefined;
	return traceRef && readableSessionFile(runDir, traceRef) ? sessionUsage(join(runDir, traceRef), 0) : undefined;
}


function messageUsage(messages: Record<string, unknown>[]): ReturnType<typeof recordMetrics> {
	const metrics = { input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 0 };
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = record(message.usage);
		if (!usage) continue;
		const cost = record(usage?.cost);
		const input = usage?.input;
		const output = usage?.output;
		const total = cost?.total;
		if (
			typeof input !== "number" || !Number.isFinite(input) || input < 0
			|| typeof output !== "number" || !Number.isFinite(output) || output < 0
			|| typeof total !== "number" || !Number.isFinite(total) || total < 0
		) return undefined;
		metrics.input_tokens += input;
		metrics.output_tokens += output;
		metrics.cost_usd += total;
		metrics.model_calls += 1;
	}
	return metrics.model_calls > 0 ? metrics : undefined;
}

function pathIdentity(value: string, label: string): string {
	const safe = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 160);
	if (!safe || safe === "." || safe === "..") throw new Error(`${label} identity is empty`);
	return safe;
}
