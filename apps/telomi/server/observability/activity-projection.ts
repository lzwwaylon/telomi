import { manifestSessionSections, reporterSessionSections, safeSessionPath, wikiSessionSections, type SessionSection } from "./session-traces.js";
import { sha256 } from "../lib/hash.js";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { agentSessionPath, readPiSession, readRunRecords, type NodeExecutionRecord } from "./run-records.js";
import { redactResearchSecrets } from "../agent-runtime/models/error-classifier.js";
import { readJsonl } from "../lib/fs.js";
import { activityTiming, humanize, stageTitle } from "../events/projection-helpers.js";
import { providerErrorMessage } from "../../shared/provider-error.js";
import type { ActivityLifecycle, ActivityMessage, ActivityOutcome, ActivityOutput, ActivityOutputLine, ActivityStep, ActivityText, AgentActivity } from "../../shared/events/activity-projection.js";
import { chrome } from "../../shared/events/activity-text.js";
import { safeSegment } from "../lib/paths.js";

type OutputPointer = {
		kind: "recorded-agent";
		goalId: string;
		runId: string;
		runDirectory: string;
		agent: string;
		executionId: string;
		sessionFile?: string;
		/** Locate a Prime Search stage whose traces were not moved out: its batch sequence and execution window. */
		stageSequence?: number;
		startedAt?: string;
		finishedAt?: string;
		lifecycle: ActivityLifecycle;
		outcome?: ActivityOutcome;
	} | {
		kind: "wiki-agent";
		goalId: string;
		controlDirectory: string;
		traceRoot?: string;
		traceRef: string;
		lifecycle: ActivityLifecycle;
		outcome?: ActivityOutcome;
	};

export class ObservabilityActivityProjection {
	private readonly outputPointers = new Map<string, OutputPointer>();

	readOutput(goalId: string, outputRef: string, options: { line?: string } = {}): ActivityOutput | null {
		const pointer = this.outputPointers.get(outputRef);
		if (!pointer || pointer.goalId !== goalId) return null;
		const lines = readPointerLines(pointer);
		if (!lines) return null;
		return {
			outputRef,
			lifecycle: pointer.lifecycle,
			...(pointer.outcome ? { outcome: pointer.outcome } : {}),
			lines: options.line === undefined
				? lines.map(previewLine)
				: lines.filter((line) => line.ref === options.line),
		};
	}

	private fromNode(
		goalId: string,
		runId: string,
		runDirectory: string,
		node: NodeExecutionRecord & { event_id: number },
	): ActivityStep {
		const outcome = nodeOutcome(node.status);
		const agentActivities: AgentActivity[] = node.node_type === "agent" && node.agent && node.execution_id
			? [this.fromRecordedAgent(goalId, runId, runDirectory, {
				...node,
				agent: node.agent,
				execution_id: node.execution_id,
			})]
			: [];
		return {
			stepId: `node:${node.event_id}`,
			title: stageTitle(node.node_id),
			summary: nodeSummary(node),
			lifecycle: "finished",
			outcome,
			timing: activityTiming(node.time.started_at, node.time.finished_at, node.time.finished_at),
			...(node.attempt ? { round: node.attempt } : {}),
			dependsOnStepIds: node.depends_on.map((id) => `node:${id}`),
			parallelSteps: [],
			agentActivities,
		};
	}

	fromNodes(
		goalId: string,
		runId: string,
		runDirectory: string,
		nodes: Array<NodeExecutionRecord & { event_id: number }>,
	): ActivityStep[] {
		const logicalNodes = new Map<string, Array<NodeExecutionRecord & { event_id: number }>>();
		for (const node of withoutRelayedFailures(nodes)) {
			const key = node.node_type === "agent" && node.agent && node.execution_id && node.attempt
				? `agent:${node.agent}:${node.node_id}`
				: `event:${node.event_id}`;
			const attempts = logicalNodes.get(key) ?? [];
			attempts.push(node);
			logicalNodes.set(key, attempts);
		}
		const nodeSteps = [...logicalNodes.values()].map((attempts) => {
			const ordered = attempts.sort((left, right) => (left.attempt ?? 1) - (right.attempt ?? 1));
			const node = ordered[0]!;
			return {
				node,
				step: ordered.length === 1
					? this.fromNode(goalId, runId, runDirectory, node)
					: this.fromNodeAttempts(goalId, runId, runDirectory, ordered),
			};
		});
		const emittedGroups = new Set<string>();
		return nodeSteps.flatMap(({ node, step }): ActivityStep[] => {
			if (!node.group_id) return [step];
			if (emittedGroups.has(node.group_id)) return [];
			emittedGroups.add(node.group_id);
			const members = nodeSteps.filter((candidate) => candidate.node.group_id === node.group_id);
			const memberEventIds = new Set(members.map((member) => member.node.event_id));
			const startedAt = members.map((member) => member.node.time.started_at).sort()[0]!;
			const finishedAt = members.map((member) => member.node.time.finished_at).sort().at(-1)!;
			const failed = members.some((member) => member.step.outcome === "failed");
			const cancelled = members.some((member) => member.step.outcome === "cancelled");
			return [{
				stepId: `group:${node.group_id}`,
				title: chrome("activityChrome.step.parallel", { count: members.length }),
				summary: members.flatMap((member) => textParts(member.step.title)),
				lifecycle: "finished",
				outcome: failed ? "failed" : cancelled ? "cancelled" : "succeeded",
				timing: activityTiming(startedAt, finishedAt, finishedAt),
				dependsOnStepIds: [...new Set(
					members.flatMap((member) => member.node.depends_on)
						.filter((eventId) => !memberEventIds.has(eventId))
						.map((eventId) => `node:${eventId}`),
				)],
				parallelSteps: members.map((member) => member.step),
				agentActivities: members.flatMap((member) => member.step.agentActivities),
			}];
		});
	}

	private fromNodeAttempts(
		goalId: string,
		runId: string,
		runDirectory: string,
		nodes: Array<NodeExecutionRecord & { event_id: number }>,
	): ActivityStep {
		const first = nodes[0]!;
		const latest = nodes.at(-1)!;
		const activities = nodes.map((node) => this.fromRecordedAgent(goalId, runId, runDirectory, {
			...node,
			agent: node.agent!,
			execution_id: node.execution_id!,
		}));
		const latestActivity = activities.at(-1)!;
		const startedAt = nodes.map((node) => node.time.started_at).sort()[0]!;
		const finishedAt = nodes.map((node) => node.time.finished_at).sort().at(-1)!;
		const timing = activityTiming(startedAt, finishedAt, finishedAt);
		const outcome = nodeOutcome(latest.status);
		return {
			stepId: `node:${first.event_id}`,
			title: stageTitle(first.node_id),
			summary: nodeSummary(latest),
			lifecycle: "finished",
			outcome,
			timing,
			dependsOnStepIds: first.depends_on.map((id) => `node:${id}`),
			parallelSteps: [],
			agentActivities: [{
				...latestActivity,
				agentActivityId: `agent:${first.event_id}`,
				timing,
				attempts: activities.flatMap((activity) => activity.attempts),
			}],
		};
	}

	private fromRecordedAgent(
		goalId: string,
		runId: string,
		runDirectory: string,
		node: NodeExecutionRecord & { event_id: number; agent: string; execution_id: string },
	): AgentActivity {
		const outcome = nodeOutcome(node.status);
		const outputRef = this.registerOutput({
			kind: "recorded-agent",
			goalId,
			runId,
			runDirectory,
			agent: node.agent,
			executionId: node.execution_id,
			sessionFile: node.trace_ref,
			...(typeof node.input.sequence === "number" ? { stageSequence: node.input.sequence } : {}),
			startedAt: node.time.started_at,
			finishedAt: node.time.finished_at,
			lifecycle: "finished",
			outcome,
		});
		const timing = activityTiming(node.time.started_at, node.time.finished_at, node.time.finished_at);
		return {
			agentActivityId: `agent:${node.event_id}`,
			agentName: node.agent,
			summary: nodeSummary(node),
			lifecycle: "finished",
			outcome,
			timing,
			outputRef,
			attempts: [{
				attemptId: `attempt:${node.execution_id}:${node.attempt ?? 1}`,
				number: node.attempt ?? 1,
				lifecycle: "finished",
				outcome,
				timing,
				outputRef,
			}],
		};
	}

	registerOutput(pointer: OutputPointer): string {
		const identity = pointer.kind === "recorded-agent"
			? `${pointer.kind}\0${pointer.goalId}\0${pointer.runId}\0${pointer.runDirectory}\0${pointer.agent}\0${pointer.executionId}\0${pointer.sessionFile ?? ""}`
			: `${pointer.kind}\0${pointer.goalId}\0${pointer.controlDirectory}\0${pointer.traceRef}`;
		const outputRef = sha256(identity, "base64url");
		this.outputPointers.set(outputRef, pointer);
		return outputRef;
	}
}


function nodeOutcome(status: NodeExecutionRecord["status"]): ActivityOutcome {
	if (status === "succeeded") return "succeeded";
	if (status === "cancelled" || status === "interrupted") return "cancelled";
	return "failed";
}

function nodeSummary(node: NodeExecutionRecord): ActivityMessage[] {
	const error = failedNodeError(node);
	const reason = error ? failureReason(clipReason(redactResearchSecrets(error))) : [];
	const metrics = node.output.metrics;
	if (metrics && typeof metrics === "object") {
		const record = metrics as Record<string, unknown>;
		const usage: ActivityMessage[] = [
			...(typeof record.model_calls === "number" ? chrome("activityChrome.usage.modelCalls", { count: record.model_calls }) : []),
			...(typeof record.tool_calls === "number" ? chrome("activityChrome.usage.toolCalls", { count: record.tool_calls }) : []),
		];
		if (usage.length > 0) return [...reason, ...usage];
	}
	return reason.length > 0 ? reason : nodeStatusText(node.status);
}

/** Why a Stage failed, as the user reads it: a model Provider's HTTP error, or the recorded error itself. */
function failureReason(error: string): ActivityMessage[] {
	return providerErrorMessage(error) ?? [{ text: error }];
}

function failedNodeError(node: NodeExecutionRecord): string | undefined {
	const error = node.output.error;
	return node.status === "failed" && typeof error === "string" && error.trim() ? error.trim() : undefined;
}

function clipReason(text: string, limit = 500): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * A Stage that fails because an earlier one did records the same error. The reason belongs to the
 * Stage where it happened; the Stages it was relayed to read only as failed.
 */
function withoutRelayedFailures<T extends NodeExecutionRecord>(nodes: T[]): T[] {
	const reported = new Set<string>();
	return nodes.map((node) => {
		const error = failedNodeError(node);
		if (!error) return node;
		if (!reported.has(error)) {
			reported.add(error);
			return node;
		}
		const { error: _relayed, ...output } = node.output;
		return { ...node, output };
	});
}

function nodeStatusText(status: NodeExecutionRecord["status"]): ActivityMessage[] {
	if (status === "succeeded") return chrome("goalActivity.stateSucceeded");
	if (status === "cancelled") return chrome("goalActivity.statusCancelled");
	if (status === "interrupted") return chrome("activityChrome.status.interrupted");
	return chrome("goalActivity.stateFailed");
}

/** Composable parts of an Activity Text, so a group summary can join the titles of its members. */
function textParts(value: ActivityText): ActivityMessage[] {
	return typeof value === "string" ? [{ text: value }] : value;
}

function safeSessionLines(entries: unknown[]): ActivityOutputLine[] {
	const lines: ActivityOutputLine[] = [];
	const pendingTools = new Map<string, ActivityOutputLine>();
	const pendingToolsByName = new Map<string, ActivityOutputLine[]>();
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "message" || !record.message || typeof record.message !== "object") continue;
		const message = record.message as Record<string, unknown>;
		const at = traceTimestamp(message.timestamp ?? record.timestamp);
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const model = typeof message.model === "string" && message.model ? { model: message.model } : {};
			for (const content of message.content) {
				if (!content || typeof content !== "object") continue;
				const block = content as Record<string, unknown>;
				if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
					lines.push(traceLine(lines, "thinking", `思考\n${safeTraceText(block.thinking)}`, at, model));
				} else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
					lines.push(traceLine(lines, "text", `输出\n${safeTraceText(block.text)}`, at, model));
				} else if (block.type === "toolCall" && typeof block.name === "string") {
					const toolCallId = typeof block.id === "string" ? block.id : undefined;
					const line = traceLine(
						lines,
						"tool",
						`工具 · ${humanize(block.name)}`,
						at,
						{
							...model,
							...(toolCallId ? { toolCallId } : {}),
							toolName: block.name,
							toolInput: safeTraceRecord(block.arguments),
						},
					);
					lines.push(line);
					if (toolCallId) pendingTools.set(toolCallId, line);
					const byName = pendingToolsByName.get(block.name) ?? [];
					byName.push(line);
					pendingToolsByName.set(block.name, byName);
				}
			}
		} else if (message.role === "toolResult") {
			const output = traceContentText(message.content);
			const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
			const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
			const byName = pendingToolsByName.get(toolName);
			const line = (toolCallId ? pendingTools.get(toolCallId) : undefined)
				?? byName?.find((candidate) => candidate.toolOutput === undefined);
			const safeOutput = safeTraceText(output);
			const toolDetails = safeTraceValue(message.details);
			if (line) {
				line.toolOutput = safeOutput;
				if (toolDetails !== undefined) line.toolDetails = toolDetails;
				line.isError = message.isError === true;
				line.text = `工具 · ${humanize(toolName)}${safeOutput ? `\n${safeOutput}` : ""}`;
				if (toolCallId) pendingTools.delete(toolCallId);
			} else if (output || toolDetails !== undefined) {
				lines.push(traceLine(lines, "tool", `工具 · ${humanize(toolName)}\n${safeOutput}`, at, {
					...(toolCallId ? { toolCallId } : {}),
					toolName,
					toolOutput: safeOutput,
					...(toolDetails !== undefined ? { toolDetails } : {}),
					isError: message.isError === true,
				}));
			}
		}
	}
	return lines;
}

/**
 * What a running Agent is doing right now and when it last recorded anything of its own. The session
 * is that one Agent's evidence: sibling workers write their own, so a pool's progress never speaks for
 * a worker that stopped. A Tool step is chrome the UI locale owns; the Agent's own thinking or output
 * stays in the language the Agent wrote it in.
 */
export function currentSessionActivity(path: string): { summary?: ActivityText; at?: string } {
	if (!existsSync(path)) return {};
	const lines = safeSessionLines(readPiSession(path).entries);
	const latest = lines.at(-1);
	if (!latest) return {};
	const summary = sessionLineSummary(latest);
	// Trace entries carry their own timestamps, so a copied or restored session reads by its content.
	const at = [...lines].reverse().find((line) => line.at)?.at;
	return { ...(summary ? { summary } : {}), ...(at ? { at } : {}) };
}

/**
 * When a running recorded Agent last wrote to any session its replay reads. A Root that delegated to
 * native RLM children (Prime Search Provider children, Report Section children) waits silently in one
 * Tool call while they work, and their turns are this execution's progress, not a sibling's.
 */
export function recordedAgentActivityAt(pointer: RecordedAgentPointer): string | undefined {
	const sessionRef = pointer.sessionFile ? basename(pointer.sessionFile)
		: pointer.agent === "report_writer" ? basename(agentSessionPath(pointer.runDirectory, pointer.agent, pointer.executionId)) : undefined;
	let sections: SessionSection[] = [];
	try {
		sections = sessionRef
			? pointer.agent === "report_writer"
				? reporterSessionSections(pointer.runDirectory, sessionRef)
				: manifestSessionSections(pointer.runDirectory, `${sessionRef}.sessions.json`) ?? []
			: [];
	} catch {
		// A manifest mid-write reads as no delegated sessions yet; the Agent's own evidence still counts.
	}
	if (sections.length === 0 && pointer.agent === "prime_search") sections = primeSearchSessionSections(pointer);
	let latest: string | undefined;
	for (const section of sections) {
		const at = lastRecordedAt(section.path);
		if (at && (!latest || at > latest)) latest = at;
	}
	return latest;
}

/** Enough tail to hold the last few session entries; a longer final entry widens the read to the whole file. */
const SESSION_TAIL_BYTES = 64 * 1024;

/** The newest timestamp a session file recorded, read from its tail so polling long child sessions stays cheap. */
function lastRecordedAt(path: string, tailBytes = SESSION_TAIL_BYTES): string | undefined {
	let text: string;
	let size: number;
	try {
		const fd = openSync(path, "r");
		try {
			size = fstatSync(fd).size;
			const length = Math.min(size, tailBytes);
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, size - length);
			text = buffer.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
	const lines = text.split(/\r?\n/u);
	// A cut first line is not a whole entry.
	if (tailBytes < size) lines.shift();
	for (const line of lines.reverse()) {
		try {
			const entry = JSON.parse(line) as { timestamp?: unknown; message?: { timestamp?: unknown } };
			const at = traceTimestamp(entry.timestamp) ?? traceTimestamp(entry.message?.timestamp);
			if (at) return at;
		} catch {
			// Blank, or the last line still being appended.
		}
	}
	return tailBytes < size ? lastRecordedAt(path, size) : undefined;
}

function sessionLineSummary(latest: ActivityOutputLine): ActivityText | undefined {
	if (latest.toolName) return toolStepText(latest.toolOutput === undefined, humanize(latest.toolName));
	const line = latest.text;
	const parts = line.split(/\r?\n/u).map((part) => part.replace(/\s+/gu, " ").trim()).filter(Boolean);
	const label = parts[0] ?? "";
	const detail = parts.at(-1) ?? label;
	if (label === "思考" || label === "输出") return detail.slice(0, 240);
	for (const [prefix, running] of [["工具输入 · ", true], ["工具输出 · ", false], ["工具 · ", true]] as const) {
		if (label.startsWith(prefix)) return toolStepText(running, label.slice(prefix.length));
	}
	return parts.join(" · ").slice(0, 240);
}

function toolStepText(running: boolean, tool: string): ActivityMessage[] {
	return chrome(running ? "activityChrome.agent.usingTool" : "activityChrome.agent.finishedTool", {
		tool: tool.slice(0, 200),
	});
}

function traceLine(
	lines: ActivityOutputLine[],
	kind: ActivityOutputLine["kind"],
	text: string,
	at?: string,
	extra: Partial<ActivityOutputLine> = {},
): ActivityOutputLine {
	return { sequence: lines.length + 1, ...(at ? { at } : {}), kind, text, ...extra };
}

function traceTimestamp(value: unknown): string | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function traceContentText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (!Array.isArray(value)) return "";
	return value.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const block = item as Record<string, unknown>;
		return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
	}).join("\n").trim();
}

function safeTraceText(value: unknown): string {
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			text = JSON.stringify(value ?? {}, (key, nested) =>
				/api.?key|authorization|cookie|password|secret|token/iu.test(key) ? "[REDACTED]" : nested,
			2);
		} catch {
			text = String(value ?? "");
		}
	}
	return redactResearchSecrets(text).trim();
}

/** Structured tool details with credential-shaped keys and text redacted; undefined when absent or not an object. */
function safeTraceValue(value: unknown): unknown {
	if (value === null || typeof value !== "object") return undefined;
	try {
		return JSON.parse(safeTraceText(value)) as unknown;
	} catch {
		return undefined;
	}
}

function safeTraceRecord(value: unknown): Record<string, unknown> {
	const text = safeTraceText(value);
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: { value: parsed };
	} catch {
		return text ? { value: text } : {};
	}
}

type RecordedAgentPointer = Extract<OutputPointer, { kind: "recorded-agent" }>;

/** List payloads keep every text bounded; a caller reads one line in full by its ref. */
const TRACE_PREVIEW_CHARS = 2_000;
/** Status lines the Prime Search Runtime appends to its merged session; the traces hold everything else. */
const PRIME_SEARCH_RUNTIME_STATUS = /^Prime Search (?:正在检索资料|已完成|已取消|失败)$/u;

function readPointerLines(pointer: OutputPointer): ActivityOutputLine[] | null {
	if (pointer.kind === "wiki-agent") {
		const sections = wikiSessionSections(pointer.controlDirectory, pointer.traceRef, pointer.traceRoot);
		return withTracePlaceholder(sectionLines(sections), pointer.lifecycle);
	}
	const sessionRef = pointer.sessionFile ? basename(pointer.sessionFile)
		: pointer.agent === "report_writer" ? basename(agentSessionPath(pointer.runDirectory, pointer.agent, pointer.executionId)) : undefined;
	const sessionPath = sessionRef ? safeSessionPath(pointer.runDirectory, sessionRef) : undefined;
	if (sessionRef) {
		const sections = pointer.agent === "report_writer"
			? reporterSessionSections(pointer.runDirectory, sessionRef)
			: manifestSessionSections(pointer.runDirectory, `${sessionRef}.sessions.json`);
		if (sections) return withTracePlaceholder(sectionLines(sections), pointer.lifecycle);
	}
	if (pointer.agent === "prime_search") {
		const sections = primeSearchSessionSections(pointer);
		if (sections.length > 0) {
			const statuses = sessionPath && existsSync(sessionPath)
				? primeSearchRuntimeStatuses(readPiSession(sessionPath).entries)
				: [];
			return withTracePlaceholder(numberLines([
				...statuses.slice(0, 1),
				...sections.flatMap((section) => {
					const entries = readPiSession(section.path).entries;
					const depth = sessionDepth(entries);
					return safeSessionLines(entries)
						.map((line) => ({ ...line, ref: `${section.key}#${line.sequence}`, section: section.label, ...depth }));
				}),
				...statuses.slice(1),
			]), pointer.lifecycle);
		}
	}
	if (sessionRef && !sessionPath) return withTracePlaceholder([], pointer.lifecycle);
	const session = sessionPath
		? readPiSession(sessionPath)
		: readRunRecords(pointer.runDirectory).agentSessions.find(
			(value) => value.agent === pointer.agent && value.executionId === pointer.executionId,
		);
	return session ? withTracePlaceholder(numberLines(safeSessionLines(session.entries)), pointer.lifecycle) : null;
}

function numberLines(lines: ActivityOutputLine[]): ActivityOutputLine[] {
	return lines.map((line, index) => ({ ...line, sequence: index + 1, ref: line.ref ?? `#${line.sequence}` }));
}

function withTracePlaceholder(lines: ActivityOutputLine[], lifecycle: ActivityLifecycle = "finished"): ActivityOutputLine[] {
	return lines.length > 0 ? lines : [{ sequence: 1, ref: "#1", kind: "status", text: lifecycle === "finished"
		? "Agent 已完成，未产生可展示的 Trace" : "Agent 已启动，等待第一条可展示输出" }];
}

function normalizedSessionEntries(path: string): unknown[] {
	return readPiSession(path).entries.map((entry) => {
		if (!entry || typeof entry !== "object") return entry;
		if ("role" in entry) return { type: "message", message: entry };
		if ((entry as { type?: unknown }).type === "message_end" && "message" in entry) {
			return { type: "message", message: entry.message };
		}
		return entry;
	});
}

function sectionLines(sections: SessionSection[]): ActivityOutputLine[] {
	return numberLines(sections.flatMap((section) => {
		const entries = normalizedSessionEntries(section.path);
		const header = entries.find((entry) => entry && typeof entry === "object" && "type" in entry && entry.type === "session") as { id?: unknown } | undefined;
		// Native session identity survives live-to-archive moves, including an open full-line request.
		const key = typeof header?.id === "string" ? `session:${header.id}` : section.key;
		const depth = sessionDepth(entries);
		return safeSessionLines(entries).map((line) => ({ ...line, ref: `${key}#${line.sequence}`, section: section.label, ...depth }));
	}));
}

/** The session header's RLM depth: 0 for a Root, 1 for a child it delegated to; absent when the session has no header. */
function sessionDepth(entries: unknown[]): { sectionDepth?: number } {
	const header = entries.find((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "session") as { rlmDepth?: unknown } | undefined;
	return typeof header?.rlmDepth === "number" ? { sectionDepth: header.rlmDepth } : {};
}

function previewLine(line: ActivityOutputLine): ActivityOutputLine {
	let truncated = false;
	const clip = (value: string) => {
		if (value.length <= TRACE_PREVIEW_CHARS) return value;
		truncated = true;
		return `${value.slice(0, TRACE_PREVIEW_CHARS)}…`;
	};
	const toolInput = line.toolInput && Object.fromEntries(Object.entries(line.toolInput).map(([key, value]) => {
		if (typeof value === "string") return [key, clip(value)];
		const json = JSON.stringify(value) ?? "";
		return [key, json.length > TRACE_PREVIEW_CHARS ? clip(json) : value];
	}));
	const { toolDetails, ...rest } = line;
	// Structured details are kept whole or left for the full line; a partial structure would mislead.
	const keepDetails = toolDetails !== undefined && (JSON.stringify(toolDetails)?.length ?? 0) <= TRACE_PREVIEW_CHARS;
	if (toolDetails !== undefined && !keepDetails) truncated = true;
	const text = clip(line.text);
	const toolOutput = line.toolOutput === undefined ? undefined : clip(line.toolOutput);
	return {
		...rest,
		text,
		...(toolInput ? { toolInput } : {}),
		...(toolOutput !== undefined ? { toolOutput } : {}),
		...(keepDetails ? { toolDetails } : {}),
		...(truncated ? { truncated: true } : {}),
	};
}

/**
 * Prime Search runs one Root, native Provider children and a Source Organizer, each in its own session.
 * A finished stage moves them to `prime-search-traces/<execution>`; a running or failed stage keeps them
 * in its workspace, and a resume archives that workspace as `.interrupted`. A workspace is only trusted
 * when its Root session started inside this execution's window, since sequences repeat across attempts.
 */
function primeSearchSessionSections(pointer: RecordedAgentPointer): Array<{ key: string; label: string; path: string }> {
	const candidates = [
		{ runtimeRoot: join(pointer.runDirectory, "prime-search-traces", safeSegment(pointer.executionId, "execution")), owned: true },
		...(pointer.stageSequence === undefined ? [] : [`search-batch-${pointer.stageSequence}`, `search-batch-${pointer.stageSequence}.interrupted`]
			.map((name) => ({ runtimeRoot: join(pointer.runDirectory, "workspaces", name, "runtime"), owned: false }))),
	];
	for (const { runtimeRoot, owned } of candidates) {
		const rootSessions = jsonlFiles(join(runtimeRoot, "acquisition-session", "session"));
		if (rootSessions.length === 0) continue;
		if (!owned && !startedWithin(rootSessions[0]!, pointer)) continue;
		return [
			...rootSessions.map((path) => ({ key: `root:${basename(path, ".jsonl")}`, label: "Prime Search Root", path })),
			...providerChildSections(runtimeRoot),
			...jsonlFiles(join(runtimeRoot, "organizer-session", "session"))
				.map((path) => ({ key: `organizer:${basename(path, ".jsonl")}`, label: "Source Organizer", path })),
		];
	}
	return [];
}

function providerChildSections(runtimeRoot: string): Array<{ key: string; label: string; path: string }> {
	const artifacts = join(runtimeRoot, "acquisition-session", "session-artifacts");
	if (!existsSync(artifacts)) return [];
	const names = childSessionNames(join(runtimeRoot, "acquisition-session", "sdk-events.jsonl"));
	return readdirSync(artifacts, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^sub-[A-Za-z0-9-]+$/u.test(entry.name))
		.flatMap((entry) => jsonlFiles(join(artifacts, entry.name))
			.map((path) => ({ childId: entry.name, path, startedAt: sessionStartedAt(path) ?? Number.MAX_SAFE_INTEGER })))
		.sort((left, right) => left.startedAt - right.startedAt || left.childId.localeCompare(right.childId))
		.map(({ childId, path }) => ({
			key: `${childId}:${basename(path, ".jsonl")}`,
			label: ["Provider child", names.get(childId) ?? childId, childProvider(runtimeRoot, childId)].filter(Boolean).join(" · "),
			path,
		}));
}

function childSessionNames(sdkEventsPath: string): Map<string, string> {
	const names = new Map<string, string>();
	if (!existsSync(sdkEventsPath)) return names;
	try {
		for (const event of readJsonl<{ type?: unknown; child?: { id?: unknown; sessionName?: unknown } }>(sdkEventsPath)) {
			if (event.type === "rlm_child_update" && typeof event.child?.id === "string" && typeof event.child.sessionName === "string") {
				names.set(event.child.id, event.child.sessionName);
			}
		}
	} catch {
		// A running stage may still be writing its last event; names are presentation only.
	}
	return names;
}

/** The Provider a child served: its submitted Ledger in finished traces, or its assignment marker in a stage workspace. */
function childProvider(runtimeRoot: string, childId: string): string | undefined {
	for (const work of [
		join(runtimeRoot, "decisions", "provider-executions", childId, "work"),
		join(dirname(runtimeRoot), "agent", "provider-executions", childId, "work"),
	]) {
		if (!existsSync(work)) continue;
		const marker = join(work, ".provider-assignment");
		if (existsSync(marker) && lstatSync(marker).isFile()) {
			const provider = readFileSync(marker, "utf-8").trim();
			if (provider) return provider;
		}
		const ledger = readdirSync(work).find((name) => name.endsWith("_candidates.json"));
		if (ledger) return ledger.slice(0, -"_candidates.json".length);
	}
	return undefined;
}

function primeSearchRuntimeStatuses(entries: unknown[]): ActivityOutputLine[] {
	return entries.flatMap((entry, index): ActivityOutputLine[] => {
		if (!entry || typeof entry !== "object") return [];
		const record = entry as { timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
		const text = record.message?.role === "assistant" ? traceContentText(record.message.content) : "";
		if (!PRIME_SEARCH_RUNTIME_STATUS.test(text)) return [];
		const at = traceTimestamp(record.timestamp);
		return [{ sequence: index + 1, ref: `runtime#${index + 1}`, ...(at ? { at } : {}), kind: "status", text }];
	});
}

function jsonlFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => join(directory, entry.name))
		.sort();
}

function sessionStartedAt(path: string): number | undefined {
	try {
		const header = JSON.parse(readFileSync(path, "utf-8").split("\n", 1)[0] ?? "") as { type?: unknown; timestamp?: unknown };
		const at = header.type === "session" && typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
		return Number.isFinite(at) ? at : undefined;
	} catch {
		return undefined;
	}
}

function startedWithin(sessionPath: string, pointer: RecordedAgentPointer): boolean {
	const startedAt = sessionStartedAt(sessionPath);
	const windowStart = Date.parse(pointer.startedAt ?? "");
	if (startedAt === undefined || !Number.isFinite(windowStart)) return false;
	const windowEnd = pointer.finishedAt ? Date.parse(pointer.finishedAt) : Number.POSITIVE_INFINITY;
	return startedAt >= windowStart && startedAt <= windowEnd;
}
