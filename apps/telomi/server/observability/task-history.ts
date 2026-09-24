import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../lib/fs.js";

export const USER_TASKS_HISTORY_FILE = "user_tasks.jsonl";
export const USER_TASK_EVENTS_FILE = "task_events.jsonl";

export type TaskHistorySource =
	| "user_message"
	| "main_agent"
	| "scheduled_research";
export type TaskHistoryStatus = "started" | "success" | "failed" | "blocked" | "cancelled";

export interface TaskHistoryAttachment {
	fileName: string;
	mimeType: string;
	size?: number;
	type?: string;
}

export interface TaskHistoryMessage {
	conversationId: string;
	userMessageId: string;
	role: "user";
	attachments?: TaskHistoryAttachment[];
}

export interface TaskHistoryRoute {
	routerRunId?: string;
	workspaceRunId?: string;
	executionKind?: "research_runtime";
	goalId?: string;
	workspaceId?: string;
	reason?: string;
}

export interface TaskHistoryWorkspace {
	goalDir?: string;
}

export interface TaskHistoryResearchRun {
	workspaceRunId?: string;
	runDir?: string;
	status: TaskHistoryStatus;
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	model?: string;
	workflowId: string;
	workflowVersion: number;
	traceSummaryPath?: string;
	tokenUsage?: Record<string, unknown>;
	nodeExecutions?: number;
	failedNodeId?: string;
	failureClass?: string;
	reports?: string[];
	errorMessage?: string;
}

export interface TaskHistoryRecord {
	version: 1;
	type: "task_history";
	taskId: string;
	source: TaskHistorySource;
	goalId: string;
	createdAt: string;
	updatedAt: string;
	originalQuestion: string;
	canonicalResearchTask?: string;
	normalizedInput: string;
	inputResolution?: {
		requested: Record<string, unknown>;
		normalized: Record<string, unknown>;
		effective: Record<string, unknown>;
		reason: string;
		fieldDifferences: Array<{ path: string; requested: unknown; effective: unknown }>;
	};
	message?: TaskHistoryMessage;
	route?: TaskHistoryRoute;
	workspace?: TaskHistoryWorkspace;
	researchRun?: TaskHistoryResearchRun;
	finalAnswer?: string;
	labels: {
		domain?: string;
		taskType?: string;
		difficulty?: string;
		requiresTool?: boolean;
	};
	artifacts?: {
		runDir?: string;
	};
}

export function userTaskHistoryDir(runtimeDir: string): string {
	return join(runtimeDir, "history");
}

export function userTasksHistoryPath(runtimeDir: string): string {
	return join(userTaskHistoryDir(runtimeDir), USER_TASKS_HISTORY_FILE);
}

export function userTaskEventsPath(runtimeDir: string): string {
	return join(userTaskHistoryDir(runtimeDir), USER_TASK_EVENTS_FILE);
}

export function readUserTaskHistory(runtimeDir: string): TaskHistoryRecord[] {
	const path = userTasksHistoryPath(runtimeDir);
	if (!existsSync(path)) return [];
	const records: TaskHistoryRecord[] = [];
	for (const [index, line] of readFileSync(path, "utf-8").split("\n").entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const parsed = JSON.parse(trimmed) as unknown;
		if (!isTaskHistoryRecord(parsed)) throw new Error(`${USER_TASKS_HISTORY_FILE}:${index + 1} is invalid`);
		records.push(normalizeTaskHistoryRecord(parsed));
	}
	return records;
}

export function upsertUserTaskHistory(runtimeDir: string, record: TaskHistoryRecord): string {
	const path = userTasksHistoryPath(runtimeDir);
	const next = normalizeTaskHistoryRecord(record);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(userTaskEventsPath(runtimeDir), `${JSON.stringify({
		schemaVersion: 1,
		eventType: "task_history_snapshot_recorded",
		recordedAt: new Date().toISOString(),
		record: next,
	})}\n`, { encoding: "utf8", mode: 0o600 });
	const records = readUserTaskHistory(runtimeDir).filter((existing) => existing.taskId !== next.taskId);
	records.push(next);
	records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId));
	writeFileAtomic(path, records.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return path;
}

export function normalizeTaskHistoryRecord(record: TaskHistoryRecord): TaskHistoryRecord {
	const createdAt = isoOrNow(record.createdAt);
	const updatedAt = isoOrNow(record.updatedAt);
	const researchRun = record.researchRun;
	return {
		version: 1,
		type: "task_history",
		taskId: cleanRequired(record.taskId, "task"),
		source: normalizeSource(record.source),
		goalId: cleanRequired(record.goalId, "goal"),
		createdAt,
		updatedAt,
		originalQuestion: limitText(record.originalQuestion, 32_000),
		...(record.canonicalResearchTask
			? { canonicalResearchTask: limitText(record.canonicalResearchTask, 32_000) }
			: {}),
		normalizedInput: limitText(record.normalizedInput || record.originalQuestion, 32_000),
		...(record.inputResolution ? { inputResolution: normalizeInputResolution(record.inputResolution) } : {}),
		...(record.message ? { message: cleanMessage(record.message, record.goalId, record.taskId) } : {}),
		...(record.route ? { route: cleanRoute(record.route, record.goalId, record.taskId) } : {}),
		...(record.workspace ? { workspace: cleanWorkspace(record.workspace) } : {}),
		...(researchRun ? {
			researchRun: cleanResearchRun(researchRun, record.route?.workspaceRunId),
		} : {}),
		...(record.finalAnswer ? { finalAnswer: limitText(record.finalAnswer, 16_000) } : {}),
		labels: cleanLabels(record.labels),
		...(record.artifacts ? { artifacts: cleanArtifacts(record.artifacts) } : {}),
	};
}

function normalizeInputResolution(value: NonNullable<TaskHistoryRecord["inputResolution"]>): NonNullable<TaskHistoryRecord["inputResolution"]> {
	return {
		requested: structuredClone(value.requested),
		normalized: structuredClone(value.normalized),
		effective: structuredClone(value.effective),
		reason: limitText(value.reason, 4_000),
		fieldDifferences: value.fieldDifferences.slice(0, 100).map((difference) => ({
			path: limitText(difference.path, 1_000),
			requested: structuredClone(difference.requested),
			effective: structuredClone(difference.effective),
		})),
	};
}

export function inferTaskHistoryLabels(question: string, reason = ""): TaskHistoryRecord["labels"] {
	const text = `${question}\n${reason}`.toLowerCase();
	const labels: TaskHistoryRecord["labels"] = {};
	if (/(report|research|paper|source|citation|调查|研究|论文|引用)/i.test(text)) labels.taskType = "research_report";
	if (/(code|debug|implement|typescript|python|代码|实现|修复)/i.test(text)) labels.taskType = labels.taskType || "code_task";
	if (/(tool|script|run|execute|工具|脚本|执行)/i.test(text)) labels.requiresTool = true;
	return labels;
}

function cleanMessage(message: TaskHistoryMessage, goalId: string, taskId: string): TaskHistoryMessage {
	return {
		conversationId: cleanRequired(message.conversationId, goalId),
		userMessageId: cleanRequired(message.userMessageId, taskId),
		role: "user",
		...(message.attachments?.length ? { attachments: message.attachments.slice(0, 50).map(cleanAttachment) } : {}),
	};
}

function cleanAttachment(attachment: TaskHistoryAttachment): TaskHistoryAttachment {
	return {
		fileName: limitText(attachment.fileName, 512),
		mimeType: limitText(attachment.mimeType, 256),
		...(numberValue(attachment.size) !== undefined ? { size: numberValue(attachment.size) } : {}),
		...(attachment.type ? { type: limitText(attachment.type, 128) } : {}),
	};
}

function cleanRoute(route: TaskHistoryRoute, goalId: string, taskId: string): TaskHistoryRoute {
	const executionKind = (route as unknown as { executionKind?: string }).executionKind;
	return {
		...(route.routerRunId ? { routerRunId: limitText(route.routerRunId, 512) } : {}),
		...(route.workspaceRunId ? { workspaceRunId: limitText(route.workspaceRunId, 512) } : { workspaceRunId: taskId }),
		...(executionKind === "research_runtime" ? { executionKind } : {}),
		...(route.goalId ? { goalId: limitText(route.goalId, 512) } : { goalId }),
		...(route.workspaceId ? { workspaceId: limitText(route.workspaceId, 512) } : {}),
		...(route.reason ? { reason: limitText(route.reason, 4_000) } : {}),
	};
}

function cleanWorkspace(workspace: TaskHistoryWorkspace): TaskHistoryWorkspace {
	return {
		...(workspace.goalDir ? { goalDir: workspace.goalDir } : {}),
	};
}

function cleanResearchRun(
	run: TaskHistoryResearchRun,
	routeWorkspaceRunId?: string,
): TaskHistoryResearchRun {
	return {
		...(run.workspaceRunId || routeWorkspaceRunId
			? { workspaceRunId: cleanRequired(run.workspaceRunId, routeWorkspaceRunId || "") }
			: {}),
		...(run.runDir ? { runDir: run.runDir } : {}),
		status: normalizeStatus(run.status),
		...(run.startedAt ? { startedAt: isoOrNow(run.startedAt) } : {}),
		...(run.completedAt ? { completedAt: isoOrNow(run.completedAt) } : {}),
		...(numberValue(run.durationMs) !== undefined ? { durationMs: numberValue(run.durationMs) } : {}),
		...(run.model ? { model: limitText(run.model, 512) } : {}),
		workflowId: limitText(run.workflowId, 512),
		workflowVersion: Math.max(0, Math.floor(numberValue(run.workflowVersion) ?? 0)),
		...(run.traceSummaryPath ? { traceSummaryPath: run.traceSummaryPath } : {}),
		...(run.tokenUsage ? { tokenUsage: cleanTokenUsage(run.tokenUsage) } : {}),
		...(numberValue(run.nodeExecutions) !== undefined
			? { nodeExecutions: Math.max(0, Math.floor(numberValue(run.nodeExecutions)!)) }
			: {}),
		...(run.failedNodeId ? { failedNodeId: limitText(run.failedNodeId, 512) } : {}),
		...(run.failureClass ? { failureClass: limitText(run.failureClass, 256) } : {}),
		...(run.reports?.length ? { reports: run.reports.slice(0, 50) } : {}),
		...(run.errorMessage ? { errorMessage: limitText(run.errorMessage, 4_000) } : {}),
	};
}

function cleanTokenUsage(usage: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(usage).slice(0, 32).flatMap(([key, value]) => {
		const number = numberValue(value);
		return number === undefined ? [] : [[limitText(key, 128), number]];
	}));
}

function cleanLabels(labels: TaskHistoryRecord["labels"]): TaskHistoryRecord["labels"] {
	return {
		...(labels.domain ? { domain: limitText(labels.domain, 256) } : {}),
		...(labels.taskType ? { taskType: limitText(labels.taskType, 256) } : {}),
		...(labels.difficulty ? { difficulty: limitText(labels.difficulty, 128) } : {}),
		...(labels.requiresTool !== undefined ? { requiresTool: Boolean(labels.requiresTool) } : {}),
	};
}

function cleanArtifacts(artifacts: NonNullable<TaskHistoryRecord["artifacts"]>): NonNullable<TaskHistoryRecord["artifacts"]> {
	return {
		...(artifacts.runDir ? { runDir: artifacts.runDir } : {}),
	};
}

function isTaskHistoryRecord(value: unknown): value is TaskHistoryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.version === 1
		&& record.type === "task_history"
		&& typeof record.taskId === "string"
		&& typeof record.goalId === "string";
}

function normalizeStatus(value: unknown): TaskHistoryStatus {
	if (value === "started" || value === "success" || value === "failed" || value === "blocked" || value === "cancelled") {
		return value;
	}
	return "failed";
}

function normalizeSource(value: unknown): TaskHistorySource {
	if (
		value === "main_agent"
		|| value === "scheduled_research"
	) return value;
	if (value === "user_message") return value;
	throw new Error("Task history source is invalid");
}

function cleanRequired(value: unknown, label: string): string {
	const clean = typeof value === "string" ? value.trim() : "";
	if (!clean) throw new Error(`Task history ${label} is required`);
	return clean;
}

function limitText(value: unknown, maxChars: number): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated to ${maxChars} chars]`;
}

function isoOrNow(value: unknown): string {
	const raw = typeof value === "string" ? value : "";
	const time = raw ? Date.parse(raw) : Number.NaN;
	return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

function numberValue(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return value;
}
