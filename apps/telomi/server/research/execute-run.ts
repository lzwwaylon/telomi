import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import {
	appendResearchRuntimeNode,
	appendRuntimeContext,
	sealInterruptedAgentExecutions,
	validateNodeExecutionTrace,
} from "../observability/run-records.js";
import { inferTaskHistoryLabels, upsertUserTaskHistory, type TaskHistoryStatus } from "../observability/task-history.js";
import {
	runResearchWorkspace,
	type ResearchWorkspaceRunRequest,
	type ResearchWorkspaceRunResult,
} from "./workspace-adapter.js";
import { deterministicInputDifferences } from "../lib/input-differences.js";
import { publish } from "../events/event-bus.js";
import { GoalTopicPlanStore } from "../goals/topic-plan/index.js";
import { createResearchScheduleFromRun } from "./schedules/create-from-run.js";
import type { ResearchSchedule } from "./schedules/types.js";
import { RunStateStore, RUN_WORKFLOW_ID, RUN_WORKFLOW_VERSION } from "./run-state.js";
import { reportPublishedResponse, reportReceiptText, reportTitle, researchSkippedResponse, scheduleCreatedResponse } from "./reports/delivery.js";
import { publishedReportGuestPath } from "../media/report-view.js";
import { inferOutputLanguage, resolveGoalOutputLanguage, resolveOutputLanguage, type OutputLanguage, type ResolvedOutputLanguage } from "../../shared/languages.js";
import { toErrorMessage } from "../lib/values.js";

/** Recurring Schedule published together with the baseline Run. */
export interface ResearchScheduleRequest {
	title: string;
	monitoringScope: string;
	cron: string;
	timeZone: string;
}

export type ResearchRunTaskSource = "main_agent" | "scheduled_research";

export type ResearchRunNodeEvent = Parameters<NonNullable<ResearchWorkspaceRunRequest["onNodeState"]>>[0];
export type ResearchRunAgentActivity = Parameters<NonNullable<ResearchWorkspaceRunRequest["onAgentOutput"]>>[0];

/** One Research Run request, independent of the caller's protocol. */
export interface ResearchRunRequest {
	goalDir: string;
	goalId: string;
	workspaceDir?: string;
	goalTitle?: string;
	goalDescription?: string;
	discoveryEnabled?: boolean;
	outputLanguage?: OutputLanguage;
	/** Original user question, authoritative for output language and history. */
	sourceUserQuestion?: string;
	extraEnv?: Record<string, string>;
	taskSource: ResearchRunTaskSource;
	scheduledResearch?: ResearchWorkspaceRunRequest["scheduledResearch"];
	researchExecutor?: typeof runResearchWorkspace;
	reason: string;
	question: string;
	reportContext: string;
	reportTitle?: string;
	schedule?: ResearchScheduleRequest;
	/** Existing interrupted Run to continue in place. */
	resumeRunId?: string;
	/**
	 * The Run id, as soon as its directories are reserved. A caller that records the Run against
	 * something of its own needs the link while the Run is still going, not when it returns.
	 */
	onRunReserved?: (runId: string) => void;
	/** Main Agent Tool Call that requested this Run, when one exists. */
	routerRunId?: string;
	signal?: AbortSignal;
	onNodeState?: (runId: string, event: ResearchRunNodeEvent) => void;
	onAgentOutput?: (runId: string, activity: ResearchRunAgentActivity) => void;
}

export interface ResearchRunQualityGateResult {
	failed: boolean;
	message?: string;
	failureDomain?: "workspace" | "research_runtime";
}

/** Recorded outcome of a completed Research Run. */
export interface ResearchRunResult {
	runId: string;
	taskId: string;
	runDir: string;
	wikiRunDir: string;
	status: "published" | "skipped";
	skipReason?: string;
	/** The receipt the Main Agent keeps in its session; never shown to the user. */
	receiptText: string;
	/** The reply the user reads in chat, shared by every entry point. */
	userResponse: string;
	reportTitle?: string;
	stableFinalReportPath?: string;
	renderFormats?: ResearchWorkspaceRunResult["renderFormats"];
	traceSummaryPath: string;
	execution: ResearchWorkspaceRunResult["execution"];
	qualityGate: ResearchRunQualityGateResult;
	schedule?: ResearchSchedule;
	outcomeWarning?: string;
}

interface ResearchRunResumeRequest {
	schemaVersion: 1;
	goalId: string;
	goalTitle: string;
	goalDescription: string;
	taskSource: ResearchRunTaskSource;
	reason: string;
	question: string;
	reportContext: string;
	reportTitle?: string;
	schedule?: ResearchScheduleRequest;
	scheduledResearch?: ResearchWorkspaceRunRequest["scheduledResearch"];
	discoveryEnabled: boolean;
	outputLanguage?: ResolvedOutputLanguage;
	goalLanguage?: ResolvedOutputLanguage;
}

const RESUME_REQUEST_FILE = "resume-request.json";

function timestampRunName(date: Date): string {
	return date.toISOString().replaceAll(":", "-");
}

function reserveRunDirectories(runtimeRunsDir: string, wikiRunsDir: string, requestedAt: Date) {
	mkdirSync(runtimeRunsDir, { recursive: true });
	mkdirSync(wikiRunsDir, { recursive: true });
	const base = timestampRunName(requestedAt);
	for (let suffix = 0; suffix < 10_000; suffix++) {
		const runId = suffix === 0 ? base : `${base}-${String(suffix).padStart(2, "0")}`;
		const runDir = join(runtimeRunsDir, runId);
		const wikiRunDir = join(wikiRunsDir, runId);
		try {
			mkdirSync(runDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		try {
			mkdirSync(wikiRunDir);
			return { runId, runDir, wikiRunDir };
		} catch (error) {
			try { rmdirSync(runDir); } catch { /* preserve unexpected contents */ }
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
	}
	throw new Error(`Research Runtime could not reserve a run directory for ${base}`);
}

function writeRunReadme(args: { wikiRunDir: string; runId: string; goalId: string; question: string; reason: string;
}) {
	writeFileSync(join(args.wikiRunDir, "README.md"), [
		`# Run ${args.runId}`,
		"",
		`Goal: ${args.goalId}`,
		`Routing reason: ${args.reason}`,
		"Output contract: canonical Markdown only",
		"",
		"## Question",
		args.question,
		"",
	].join("\n"), "utf-8");
}

function portableValue(value: unknown, root: string): unknown {
	if (typeof value === "string") return value.replaceAll(root, ".");
	if (Array.isArray(value)) return value.map((item) => portableValue(item, root));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, portableValue(item, root)]));
}

function writePortableJson(path: string, value: unknown, root: string) {
	writeFileSync(path, `${JSON.stringify(portableValue(value, root), null, 2)}\n`, "utf-8");
}

/** The language the interrupted Run already resolved, so notices about it match its report. */
export function resumeRunOutputLanguage(runDir: string): ResolvedOutputLanguage | undefined {
	// A notice must never block the resume itself, so an unreadable request only loses the hint.
	try {
		const language = (JSON.parse(readFileSync(join(runDir, RESUME_REQUEST_FILE), "utf-8")) as { outputLanguage?: unknown }).outputLanguage;
		return language === "zh-CN" || language === "en" ? language : undefined;
	} catch {
		return undefined;
	}
}

function readResumeRequest(runDir: string): ResearchRunResumeRequest {
	const path = join(runDir, RESUME_REQUEST_FILE);
	if (!existsSync(path)) throw new Error("Research Run has no resume request");
	const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<ResearchRunResumeRequest>;
	if (
		value.schemaVersion !== 1
		|| typeof value.goalId !== "string"
		|| typeof value.goalTitle !== "string"
		|| typeof value.goalDescription !== "string"
		|| (value.taskSource !== "main_agent" && value.taskSource !== "scheduled_research")
		|| typeof value.reason !== "string"
		|| typeof value.question !== "string"
		|| typeof value.reportContext !== "string"
		|| !value.reportContext.trim()
		|| typeof value.discoveryEnabled !== "boolean"
	) throw new Error("Research Run has an invalid resume request");
	return value as ResearchRunResumeRequest;
}

function persistFinalRuntimeGate(args: {
	runDir: string;
	wikiRunDir: string;
	runId: string;
	taskId: string;
	gate: Record<string, unknown>;
	status: "succeeded" | "failed" | "cancelled";
	failedNodeId?: string;
	errorMessage?: string;
}): string {
	sealInterruptedAgentExecutions(args.runDir, "research");
	const integrity = validateNodeExecutionTrace(args.runDir, "research");
	const status = args.status === "succeeded" && !integrity.ok ? "failed" : args.status;
	const finalGatePath = join(args.wikiRunDir, "artifacts", "final_gate.json");
	writePortableJson(finalGatePath, {
		...args.gate,
		ok: status === "succeeded",
		halt: status !== "succeeded",
		trace_integrity: integrity,
	}, args.wikiRunDir);
	appendRuntimeContext(args.runDir, "research", {
		type: "runtime.final_gate_evaluated",
		task_id: args.taskId,
		status,
		gate_file: relative(args.wikiRunDir, finalGatePath),
		halt: status !== "succeeded",
		...(args.failedNodeId ? { failed_node_id: args.failedNodeId } : {}),
		...(status === "failed" ? { error: integrity.ok ? args.errorMessage ?? "Final Runtime Gate failed" : integrity.issues.join("; ") } : {}),
	});
	appendResearchRuntimeNode(args.runDir, {
		node_id: "final-runtime-gate",
		status,
		input: {
			task_id: args.taskId,
			failed_node_id: args.failedNodeId,
		},
		output: {
			gate_ref: relative(args.wikiRunDir, finalGatePath),
			halt: status !== "succeeded",
			trace_integrity: integrity,
			...(status === "failed"
				? { error: integrity.ok ? args.errorMessage ?? "Final Runtime Gate failed" : integrity.issues.join("; ") }
				: {}),
		},
	});
	return finalGatePath;
}

function recordTaskHistory(args: {
	runtimeDir: string; goalDir: string; request: ResearchRunRequest; taskId: string;
	runId: string; runDir: string;
	reason: string; question: string; requestedInput: Record<string, unknown>; normalizedInput: Record<string, unknown>;
	status: TaskHistoryStatus; createdAt: number; completedAt: number;
	research?: ResearchWorkspaceRunResult; error?: string;
}): { path?: string; warning?: string } {
	try {
		const research = args.research;
		const path = upsertUserTaskHistory(args.runtimeDir, {
			version: 1,
			type: "task_history",
			taskId: args.taskId,
			source: args.request.taskSource,
			goalId: args.request.goalId,
			createdAt: new Date(args.createdAt).toISOString(),
			updatedAt: new Date(args.completedAt).toISOString(),
			originalQuestion: args.request.sourceUserQuestion?.trim() || args.question,
			canonicalResearchTask: args.question,
			normalizedInput: String(args.normalizedInput.search_question ?? args.question),
			inputResolution: {
				requested: args.requestedInput,
				normalized: args.normalizedInput,
				effective: {
					...args.normalizedInput,
					search_question: args.question,
				},
				reason: args.request.taskSource === "main_agent"
					? "The canonical research task was accepted without replacement."
					: args.question === String(args.normalizedInput.search_question ?? "")
						? "Requested research task matched the authoritative source question."
						: "Runtime replaced the requested research task with the authoritative source question.",
				fieldDifferences: deterministicInputDifferences(args.requestedInput, {
					...args.normalizedInput,
					search_question: args.question,
				}),
			},
			route: {
				...(args.request.routerRunId ? { routerRunId: args.request.routerRunId } : {}),
				workspaceRunId: args.runId,
				executionKind: "research_runtime",
				goalId: args.request.goalId,
				workspaceId: args.request.goalId,
				reason: args.reason,
			},
			workspace: {
				goalDir: args.goalDir,
			},
			...(research ? { researchRun: {
				workspaceRunId: args.runId,
				runDir: args.runDir,
				status: args.status,
				startedAt: research.execution.startedAt,
				completedAt: research.execution.finishedAt,
				durationMs: Date.parse(research.execution.finishedAt) - Date.parse(research.execution.startedAt),
				model: research.model,
				workflowId: research.execution.workflowId,
				workflowVersion: research.execution.workflowVersion,
				traceSummaryPath: research.traceSummaryPath,
				tokenUsage: { ...research.execution.usage },
				nodeExecutions: research.traceSummary.nodeAttempts,
				failedNodeId: Object.entries(research.execution.nodeStatuses).find(([, state]) => state !== "succeeded")?.[0],
				failureClass: [...research.traceSummary.nodes].reverse().find((node) => node.failureClass)?.failureClass,
				...(args.error ? { errorMessage: args.error } : {}),
			} } : { researchRun: {
				workspaceRunId: args.runId,
				runDir: args.runDir,
				status: args.status,
				startedAt: new Date(args.createdAt).toISOString(),
				completedAt: new Date(args.completedAt).toISOString(),
				workflowId: RUN_WORKFLOW_ID,
				workflowVersion: RUN_WORKFLOW_VERSION,
				...(args.error ? { errorMessage: args.error } : {}),
			} }),
			...(research?.finalReportContent ? { finalAnswer: research.finalReportContent } : {}),
			labels: inferTaskHistoryLabels(args.question, args.reason),
			artifacts: { runDir: args.runDir },
		});
		return { path };
	} catch (error) {
		return { warning: toErrorMessage(error) };
	}
}

function recordOutcome(args: {
	runtimeDir: string; goalDir: string; request: ResearchRunRequest;
	taskId: string; runId: string; runDir: string; wikiRunDir: string;
	reason: string; question: string; requestedInput: Record<string, unknown>; normalizedInput: Record<string, unknown>;
	status: "success" | "failed" | "cancelled"; qualityGate: ResearchRunQualityGateResult;
	createdAt: number; completedAt: number; research?: ResearchWorkspaceRunResult; error?: string;
}): string | undefined {
	const status: TaskHistoryStatus = args.status;
	const history = recordTaskHistory({ ...args, status });
	appendRuntimeContext(args.runDir, "research", {
		type: "runtime.run_completed",
		status,
		task_id: args.taskId,
		...(args.error ? { error: args.error } : {}),
	});
	appendResearchRuntimeNode(args.runDir, {
		node_id: "workspace-run",
		status: status === "success" ? "succeeded" : status,
		input: {
			task_id: args.taskId,
			question: args.question,
		},
		output: {
			status,
			quality_gate_failed: args.qualityGate.failed,
			...(args.error ? { error: args.error } : {}),
		},
		started_at: new Date(args.createdAt).toISOString(),
		finished_at: new Date(args.completedAt).toISOString(),
	});
	return history.warning;
}

/**
 * Run one canonical research task through the server-owned Telomi Research Runtime,
 * from Run admission to the recorded outcome. Every entry point uses this operation.
 */
export async function executeResearchRun(request: ResearchRunRequest): Promise<ResearchRunResult> {
	const createdAt = Date.now();
	const { goalDir, goalId } = request;
	const goalTitle = request.goalTitle?.trim() || goalId;
	const goalDescription = request.goalDescription?.trim() || "";
	const discoveryEnabled = request.discoveryEnabled ?? true;
	const runSignal = request.signal ?? new AbortController().signal;
	const question = request.question.trim();
	const reportContext = request.reportContext.trim();
	const reason = request.reason.trim();
	const requestedInput = {
		reason: request.reason,
		search_question: request.question,
		report_context: request.reportContext,
		...(request.reportTitle ? { reportTitle: request.reportTitle } : {}),
		...(request.schedule ? { schedule: request.schedule } : {}),
	};
	const normalizedInput = {
		reason,
		search_question: question,
		report_context: reportContext,
		...(request.reportTitle ? { reportTitle: request.reportTitle.trim() } : {}),
		...(request.schedule ? {
			schedule: {
				title: request.schedule.title.trim(),
				monitoringScope: request.schedule.monitoringScope.trim(),
				cron: request.schedule.cron.trim(),
				timeZone: request.schedule.timeZone.trim(),
			},
		} : {}),
	};
	if (!reportContext) throw new Error("Research Runtime requires a non-empty report_context.");
	if (!question) throw new Error("Research Runtime requires a non-empty question.");
	if (!reason) throw new Error("Research Runtime requires a non-empty reason.");
	const outputLanguage = resolveOutputLanguage(
		request.outputLanguage ?? "auto",
		request.sourceUserQuestion?.trim() || reportContext,
	);
	// The Wiki outlives this Run, so its language comes from the Goal itself, not from one request.
	const goalLanguage = resolveGoalOutputLanguage(
		request.outputLanguage ?? "auto",
		{ title: goalTitle, description: goalDescription },
	);
	const workspaceDir = request.workspaceDir ?? join(goalDir, "..");
	const topicPlan = new GoalTopicPlanStore(goalId, workspaceDir).requireResearchReady();

	const runtimeDir = serverRuntimeDirForGoal(goalId, request.workspaceDir);
	const wikiDir = join(goalDir, "wiki");
	const resumed = Boolean(request.resumeRunId);
	const reserved = request.resumeRunId
		? {
			runId: request.resumeRunId,
			runDir: join(runtimeDir, "runs", request.resumeRunId),
			wikiRunDir: join(wikiDir, "runs", request.resumeRunId),
		}
		: reserveRunDirectories(join(runtimeDir, "runs"), join(wikiDir, "runs"), new Date(createdAt));
	const { runId, runDir, wikiRunDir } = reserved;
	if (resumed) {
		const state = new RunStateStore(runDir).load();
		if (!state || state.goal_id !== goalId || state.run_id !== runId) {
			throw new Error("Research Run identity does not match the Goal");
		}
		new RunStateStore(runDir).resume();
	}
	for (const dir of ["raw", "parsed", "artifacts", "report"]) mkdirSync(join(wikiRunDir, dir), { recursive: true });
	if (!resumed) writeRunReadme({ wikiRunDir, runId, goalId, question, reason });
	// Announced once the identity is settled, so a caller never records a Run that was rejected.
	request.onRunReserved?.(runId);
	const env = request.extraEnv ?? {};
	if (!resumed) {
		const resumeRequest: ResearchRunResumeRequest = {
			schemaVersion: 1,
			goalId,
			goalTitle,
			goalDescription,
			taskSource: request.taskSource,
			reason,
			question,
			reportContext,
			...(request.reportTitle ? { reportTitle: request.reportTitle } : {}),
			...(request.schedule ? { schedule: request.schedule } : {}),
			...(request.scheduledResearch ? { scheduledResearch: request.scheduledResearch } : {}),
			discoveryEnabled,
			outputLanguage,
			goalLanguage,
		};
		writeFileSync(join(runDir, RESUME_REQUEST_FILE), `${JSON.stringify(resumeRequest, null, 2)}\n`, "utf-8");
	}
	const taskId = `${runId}_route`;
	appendRuntimeContext(runDir, "research", {
		type: resumed ? "runtime.run_resumed" : "runtime.run_started",
		task_id: taskId,
		...(request.routerRunId ? { tool_call_id: request.routerRunId } : {}),
		question,
	});
	if (runSignal.aborted) throw new Error("Research Runtime was cancelled before Research started");
	appendRuntimeContext(runDir, "research", {
		type: "runtime.input_resolved",
		task_id: taskId,
		harness_source: "builtin",
	});
	appendResearchRuntimeNode(runDir, {
		node_id: "input-resolution",
		status: "succeeded",
		input: {
			task_id: taskId,
			question,
		},
		output: {
			harness_source: "builtin",
		},
	});

	// A resumed Run keeps the language it first resolved, so retries do not drift.
	const runLanguage = resumed ? readResumeRequest(runDir).outputLanguage ?? outputLanguage : outputLanguage;
	let research: ResearchWorkspaceRunResult;
	const researchRequest: ResearchWorkspaceRunRequest = {
		goalDir,
		goalTitle,
		goalDescription,
		workspaceDirectory: wikiRunDir,
		controlDirectory: runDir,
		organizerStorageRoot: join(runtimeDir, "research-sources"),
		runId,
		question,
		reportContext,
		discoveryEnabled,
		outputLanguage: runLanguage,
		goalLanguage: resumed ? readResumeRequest(runDir).goalLanguage ?? goalLanguage : goalLanguage,
		...(!resumed ? { topicPlan } : {}),
		env,
		signal: runSignal,
		...(request.scheduledResearch ? { scheduledResearch: request.scheduledResearch } : {}),
		onNodeState: (event) => {
			publish({ type: "activity-projection:changed", goalId });
			request.onNodeState?.(runId, event);
		},
		onAgentOutput: (activity) => request.onAgentOutput?.(runId, activity),
	};
	try {
		research = await (request.researchExecutor ?? runResearchWorkspace)(researchRequest);
	} catch (error) {
		const cancelled = runSignal.aborted;
		const underlyingMessage = toErrorMessage(error);
		const message = cancelled
			? underlyingMessage || "Research Run cancelled by request"
			: underlyingMessage;
		const status = cancelled ? "cancelled" : "failed";
		const gate: ResearchRunQualityGateResult = { failed: !cancelled, message, failureDomain: "research_runtime" };
		persistFinalRuntimeGate({
			runDir,
			wikiRunDir,
			runId,
			taskId,
			status,
			gate: {
				schema_version: 1,
				ok: false,
				halt: true,
				execution_kind: "research_runtime",
				workflow: null,
				failed_node_id: null,
				node_statuses: {},
				stage_reports: [],
				failure: { domain: "research_runtime", message },
			},
			errorMessage: message,
		});
		recordOutcome({ runtimeDir, goalDir, request, taskId, runId, runDir, wikiRunDir,
			reason, question, requestedInput, normalizedInput, status, qualityGate: gate,
			createdAt, completedAt: Date.now(), error: message });
		throw new Error(message);
	}

	sealInterruptedAgentExecutions(runDir, "research", research.execution.finishedAt);
	const traceIntegrity = validateNodeExecutionTrace(runDir, "research");
	const published = research.execution.status === "succeeded" && Boolean(research.finalReportContent.trim());
	const skipped = research.execution.status === "skipped" && research.state.status === "skipped";
	const success = (published || skipped) && traceIntegrity.ok;
	const cancelled = research.execution.status === "cancelled" || research.state.status === "cancelled";
	const status = success ? "success" : cancelled ? "cancelled" : "failed";
	const failedNodeId = traceIntegrity.ok
		? Object.entries(research.execution.nodeStatuses).find(([, state]) => state !== "succeeded")?.[0]
		: "trace-integrity";
	const gate: ResearchRunQualityGateResult = {
		failed: !success && !cancelled,
		...(success ? {} : { message: traceIntegrity.ok
			? research.execution.error || "Research Run did not publish a non-empty report/final.md"
			: `Research Trace integrity failed: ${traceIntegrity.issues.join("; ")}` }),
		failureDomain: "workspace",
	};
	persistFinalRuntimeGate({
		runDir,
		wikiRunDir,
		runId,
		taskId,
		status: success ? "succeeded" : cancelled ? "cancelled" : "failed",
		gate: {
			schema_version: 1,
			ok: success,
			halt: !success,
			execution_kind: "research_runtime",
			workflow: { id: research.execution.workflowId, version: research.execution.workflowVersion },
			failed_node_id: failedNodeId,
			node_statuses: research.execution.nodeStatuses,
			stage_reports: research.stageReports ?? [],
			trace_integrity: traceIntegrity,
		},
		...(failedNodeId ? { failedNodeId } : {}),
		...(success ? {} : { errorMessage: gate.message ?? "Final Runtime Gate failed" }),
	});
	if (request.schedule && !published) {
		throw new Error("Research Runtime must publish its baseline before creating a Research Schedule");
	}
	const schedule = request.schedule
		? createResearchScheduleFromRun({
			workspaceDir,
			goalId,
			title: request.schedule.title,
			monitoringScope: request.schedule.monitoringScope,
			sourceRunId: runId,
			cron: request.schedule.cron,
			timeZone: request.schedule.timeZone,
		})
		: undefined;
	if (schedule) {
		publish({
			type: "research/schedules:changed",
			goalId,
			scheduleId: schedule.id,
			reason: "created_from_fresh_goal_baseline",
			ts: new Date().toISOString(),
		});
	}
	const outcomeWarning = recordOutcome({ runtimeDir, goalDir, request, taskId, runId, runDir, wikiRunDir,
		reason, question, requestedInput, normalizedInput, status, qualityGate: gate,
		createdAt, completedAt: Date.now(), research, error: gate.message });
	if (!success) {
		throw new Error(`Telomi Research Runtime failed: ${gate.message}\n\nruntime trace: ${research.traceSummaryPath}`);
	}
	const common = {
		runId,
		taskId,
		runDir,
		wikiRunDir,
		traceSummaryPath: research.traceSummaryPath,
		execution: research.execution,
		qualityGate: gate,
		...(outcomeWarning ? { outcomeWarning } : {}),
	};
	if (skipped) {
		return {
			...common,
			status: "skipped",
			skipReason: research.state.skip_reason,
			receiptText: `Scheduled Research skipped: ${research.state.skip_reason}`,
			userResponse: researchSkippedResponse(runLanguage),
		};
	}
	const stableFinalReportPath = `/workspace/wiki/runs/${runId}/report/final.md`;
	const title = reportTitle(research.finalReportContent, request.reportTitle);
	// A Report Context may ask for another language than the Run default, so the reply follows the report the user opens.
	const reportLanguage = inferOutputLanguage(research.finalReportContent);
	return {
		...common,
		status: "published",
		reportTitle: title,
		stableFinalReportPath,
		renderFormats: research.renderFormats,
		receiptText: [
			reportReceiptText(title, publishedReportGuestPath(goalDir, runId), outcomeWarning),
			schedule ? `Schedule: ${schedule.title} (${schedule.id})` : "",
		].filter(Boolean).join("\n"),
		userResponse: [
			reportPublishedResponse(reportLanguage),
			schedule ? scheduleCreatedResponse(reportLanguage, schedule.title) : "",
		].filter(Boolean).join("\n\n"),
		...(schedule ? { schedule } : {}),
	};
}

/** Continue an interrupted Research Run in place, from its persisted resume request. */
export function resumeResearchRun(
	request: Omit<
		ResearchRunRequest,
		"taskSource" | "scheduledResearch" | "resumeRunId" | "reason" | "question" | "reportContext"
		| "reportTitle" | "schedule" | "goalTitle" | "goalDescription" | "discoveryEnabled" | "outputLanguage"
	> & { runId: string },
): Promise<ResearchRunResult> {
	const { runId, ...rest } = request;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)) throw new Error("Invalid Research Run id");
	const runtimeDir = serverRuntimeDirForGoal(request.goalId, request.workspaceDir);
	const runDir = join(runtimeDir, "runs", runId);
	const persisted = readResumeRequest(runDir);
	if (persisted.goalId !== request.goalId) throw new Error("Research Run belongs to another Goal");
	return executeResearchRun({
		...rest,
		goalTitle: persisted.goalTitle,
		goalDescription: persisted.goalDescription,
		outputLanguage: persisted.outputLanguage ?? "auto",
		taskSource: persisted.taskSource,
		...(persisted.scheduledResearch ? { scheduledResearch: persisted.scheduledResearch } : {}),
		discoveryEnabled: persisted.discoveryEnabled,
		resumeRunId: runId,
		reason: persisted.reason,
		question: persisted.question,
		reportContext: persisted.reportContext,
		...(persisted.reportTitle ? { reportTitle: persisted.reportTitle } : {}),
		...(persisted.schedule ? { schedule: persisted.schedule } : {}),
	});
}
