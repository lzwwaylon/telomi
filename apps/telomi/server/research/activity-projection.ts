import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readRuntimeRecords, runRecordsDir, type NodeExecutionRecord } from "../observability/run-records.js";
import { currentSessionActivity, recordedAgentActivityAt, type ObservabilityActivityProjection } from "../observability/activity-projection.js";
import { ResearchScheduleStore } from "./schedules/store.js";
import type { ResearchScheduleRun } from "./schedules/types.js";
import { canResumeRunState, type RunStateV2 } from "./run-state.js";
import { activityTiming, compareHistory, humanize, stageTitle } from "../events/projection-helpers.js";
import { providerErrorMessage } from "../../shared/provider-error.js";
import { redactResearchSecrets } from "../agent-runtime/models/error-classifier.js";
import * as log from "../lib/log.js";
import type { ActivityLifecycle, ActivityMessage, ActivityMessageKey, ActivityOutcome, ActivityProjectionItem, ActivityStep } from "../../shared/events/activity-projection.js";
import { chrome } from "../../shared/events/activity-text.js";
import type { ProjectionContribution } from "../events/activity-projection.js";
import { toErrorMessage } from "../lib/values.js";
import { readProviderCallRecords } from "../providers/provider-call-record.js";

export class ResearchActivityProjection {
	constructor(private readonly options: { workspaceDir: string }, private readonly outputs: ObservabilityActivityProjection) {}
	project(goalId: string): ProjectionContribution[] {
		const scheduleRuns = this.readScheduleRuns(goalId);
		const research = this.readResearch(goalId, scheduleRuns);
		const scheduleOnly = scheduleRuns
			.filter((run) => !run.researchRunId || !research.some((item) => item.sourceRef === `research:${run.researchRunId}`))
			.map((run) => this.fromScheduleRun(goalId, run));
		return [
			{ source: "research", items: research },
			{ source: "scheduled-research", items: scheduleOnly, revisionData: scheduleRuns },
		];
	}
	private readResearch(goalId: string, scheduleRuns: ResearchScheduleRun[]): ActivityProjectionItem[] {
		const root = runRecordsDir(this.options.workspaceDir, goalId);
		if (!existsSync(root)) return [];
		const scheduleByResearchRun = new Map(
			scheduleRuns
				.filter((run): run is ResearchScheduleRun & { researchRunId: string } => Boolean(run.researchRunId))
				.map((run) => [run.researchRunId, run]),
		);
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => {
				try {
					const state = JSON.parse(readFileSync(join(root, entry.name, "run-state.json"), "utf8")) as RunStateV2;
					return this.fromResearch(state, join(root, entry.name), scheduleByResearchRun.get(state.run_id));
				} catch {
					return null;
				}
			})
			.filter((item): item is ActivityProjectionItem => Boolean(item))
			.sort(compareHistory);
	}

	private fromResearch(
		state: RunStateV2,
		runDir: string,
		scheduleRun?: ResearchScheduleRun,
	): ActivityProjectionItem {
		const runtimeEvents = readRuntimeRecords(runDir, "research");
		const nodes = runtimeEvents
			.filter((event): event is typeof event & NodeExecutionRecord & { event_id: number } =>
				event.type === "node_execution" && typeof event.event_id === "number");
		const completedExecutionIds = new Set(
			nodes.map((node) => node.execution_id).filter((id): id is string => Boolean(id)),
		);
		const reusedCheckpointStages = new Set(runtimeEvents.flatMap((event) =>
			event.type === "runtime.stage_checkpoint_reused" && typeof event.stage_id === "string"
				? [event.stage_id]
				: []));
		const resumedAt: string[] = [];
		const eventRounds = new Map<Record<string, unknown>, number>();
		for (const event of runtimeEvents) {
			if (event.type === "runtime.run_resumed" && typeof event.created_at === "string") resumedAt.push(event.created_at);
			eventRounds.set(event, resumedAt.length + 1);
		}
		const latestResumeAt = resumedAt.at(-1);
		const currentRound = resumedAt.length + 1;
		const lifecycle = researchLifecycle(state.status);
		const outcome = researchOutcome(state.status);
		const boundAgentLifecycle: ActivityLifecycle = lifecycle === "finished"
			? "finished"
			: lifecycle === "waiting" ? "waiting" : "running";
		// Each bound Agent's own last activity, so one Worker that stopped reporting still reads as quiet
		// while its siblings keep working. The Run's last activity covers them all; the Activity
		// Projection lifts it from its Steps.
		const eventActivity = recordedActivityByOwner(runtimeEvents);
		const activeAgentSteps = runtimeEvents.flatMap((event): ActivityStep[] => {
			if (
				event.type !== "runtime.agent_bound"
				|| typeof event.execution_id !== "string"
				|| typeof event.agent !== "string"
				|| typeof event.stage_id !== "string"
				|| completedExecutionIds.has(event.execution_id)
				|| reusedCheckpointStages.has(event.stage_id)
				|| (eventRounds.get(event) ?? 1) < currentRound
			) return [];
			const createdAt = typeof event.created_at === "string" ? event.created_at : state.updated_at;
			const sessionFile = typeof event.session_file === "string" ? event.session_file : undefined;
			const session = sessionFile
				? currentSessionActivity(join(runDir, basename(sessionFile)))
				: undefined;
			const pointer = {
				kind: "recorded-agent" as const,
				goalId: state.goal_id,
				runId: state.run_id,
				runDirectory: runDir,
				agent: event.agent,
				executionId: event.execution_id,
				sessionFile,
				...primeSearchStageSequence(event.stage_id),
				startedAt: createdAt,
				lifecycle: boundAgentLifecycle,
				...(boundAgentLifecycle === "finished" && outcome ? { outcome } : {}),
			};
			const boundAgentUpdatedAt = boundAgentLifecycle !== "running"
				? state.finished_at ?? state.updated_at
				: latestTimestamp([
					createdAt,
					eventActivity.get(`execution:${event.execution_id}`),
					eventActivity.get(`stage:${event.stage_id}`),
					session?.at,
					recordedAgentActivityAt(pointer),
				]) ?? createdAt;
			const outputRef = this.outputs.registerOutput(pointer);
			return [{
				stepId: `active:${event.execution_id}`,
				...(latestResumeAt ? { executionRound: eventRounds.get(event) } : {}),
				title: stageTitle(event.stage_id),
				summary: chrome(
					boundAgentLifecycle === "running"
						? "activityChrome.agent.running"
						: boundAgentLifecycle === "waiting" ? "activityChrome.agent.willRerun" : "activityChrome.agent.endedWithRun",
					{ agent: humanize(event.agent) },
				),
				lifecycle: boundAgentLifecycle,
				...(boundAgentLifecycle === "finished" && outcome ? { outcome } : {}),
				timing: activityTiming(
					createdAt,
					boundAgentUpdatedAt,
					boundAgentLifecycle === "finished" ? boundAgentUpdatedAt : undefined,
				),
				dependsOnStepIds: nodes.length ? [`node:${nodes.at(-1)!.event_id}`] : [],
				parallelSteps: [],
				agentActivities: [{
					agentActivityId: `active-agent:${event.execution_id}`,
					agentName: event.agent,
					summary: boundAgentLifecycle === "running"
						? session?.summary ?? chrome("activityChrome.agent.runningPlain")
						: chrome(boundAgentLifecycle === "waiting"
							? "activityChrome.agent.interruptedHere"
							: "activityChrome.agent.noCompletionRecord"),
					lifecycle: boundAgentLifecycle,
					...(boundAgentLifecycle === "finished" && outcome ? { outcome } : {}),
					timing: activityTiming(
						createdAt,
						boundAgentUpdatedAt,
						boundAgentLifecycle === "finished" ? boundAgentUpdatedAt : undefined,
					),
					outputRef,
					attempts: [],
				}],
			}];
		});
		const providerSteps = providerAccessSteps(runtimeEvents, runDir, lifecycle === "finished", latestResumeAt ? eventRounds : undefined);
		// Keep Agent attempts and parallel worker pools within their Research execution.
		const nodeRounds = Array.from({ length: resumedAt.length + 1 }, (): typeof nodes => []);
		for (const node of nodes) nodeRounds[(eventRounds.get(node) ?? 1) - 1]!.push(node);
		const nodeSteps = nodeRounds.flatMap((roundNodes, index) =>
			this.outputs.fromNodes(state.goal_id, state.run_id, runDir, roundNodes)
				.map((step) => latestResumeAt ? { ...step, executionRound: index + 1 } : step));
		const steps = [...nodeSteps, ...providerSteps, ...activeAgentSteps].map((step): ActivityStep => {
			const round = step.executionRound ?? 1;
			if (!latestResumeAt || round === currentRound || step.lifecycle === "finished") return step;
			const endedAt = resumedAt[round - 1]!;
			return {
				...step, lifecycle: "finished", outcome: "partial",
				timing: activityTiming(step.timing.createdAt, endedAt, endedAt),
				...(step.providerAccess?.kind === "fallback" ? {
					providerAccess: { ...step.providerAccess, fallbackOutcome: "uncovered" },
				} : {}),
			};
		});
		const timing = {
			...activityTiming(state.started_at, state.updated_at, state.finished_at),
			...(state.status === "interrupted" ? { waitingSince: state.updated_at } : {}),
		};
		const hasResumeRequest = existsSync(join(runDir, "resume-request.json"));
		const resumable = canResumeRunState(state);
		const resumeAction = {
			actionId: `resume:${state.run_id}`,
			kind: "continue" as const,
			label: chrome("activityChrome.research.resume"),
			enabled: hasResumeRequest,
			...(hasResumeRequest ? {} : { disabledReason: chrome("activityChrome.research.resumeUnsupported") }),
			requiresConfirmation: false,
			href: `/api/goals/${encodeURIComponent(state.goal_id)}/research-runs/${encodeURIComponent(state.run_id)}/resume`,
		};
		const attentionActions = resumable ? [resumeAction] : [];
		return {
			activityId: `research:${state.run_id}`,
			kind: scheduleRun ? "scheduled-research" : "research",
			scope: { kind: "goal", goalId: state.goal_id },
			trigger: scheduleRun
				? { kind: "schedule", scheduleId: scheduleRun.scheduleId }
				: { kind: "manual" },
			title: state.question,
			summary: researchSummary(state, providerSteps),
			lifecycle,
			...(outcome ? { outcome } : {}),
			timing,
			...(latestResumeAt ? {
				recovery: { reason: chrome("activityChrome.research.resume"), recoveredAt: latestResumeAt, round: resumedAt.length + 1 },
			} : {}),
			...(state.status === "interrupted" ? {
				waiting: {
					kind: "external" as const,
					reason: chrome("activityChrome.research.backendStopped"),
					waitingSince: state.updated_at,
					actions: [resumeAction],
				},
			} : {}),
			...(attentionActions.length > 0 ? {
				attention: {
					kind: "failure" as const,
					summary: resumable
						? chrome(!hasResumeRequest
							? "activityChrome.research.checkpointWithoutManifest"
							: state.status === "interrupted"
								? "activityChrome.research.checkpointFromAgent"
								: "activityChrome.research.checkpointFromStage")
						: [],
					actions: attentionActions,
				},
			} : {}),
			resultLinks: state.canonical_report ? [{
				kind: "report",
				label: chrome("activityChrome.research.openReport"),
				href: `/api/goals/${encodeURIComponent(state.goal_id)}/artifacts/blob?name=${encodeURIComponent(`wiki/runs/${state.run_id}/report/final.md`)}`,
				workspacePath: `wiki/runs/${state.run_id}/report/final.md`,
				available: true,
				primary: true,
			}] : [],
			steps,
			sourceRef: `research:${state.run_id}`,
		};
	}

	private readScheduleRuns(goalId: string): ResearchScheduleRun[] {
		try {
			const store = new ResearchScheduleStore(goalId, this.options.workspaceDir);
			try {
				return store.listRuns();
			} finally {
				store.close();
			}
		} catch (error) {
			log.logWarning(
				`[${goalId}] omitted Research Schedule activity because its store is unavailable`,
				toErrorMessage(error),
			);
			return [];
		}
	}

	private fromScheduleRun(goalId: string, run: ResearchScheduleRun): ActivityProjectionItem {
		const lifecycle: ActivityLifecycle = run.status === "scheduled"
			? "queued"
			: run.status === "running" ? "running" : "finished";
		const outcome: ActivityOutcome | undefined = run.status === "published"
			? "succeeded"
			: run.status.startsWith("skipped_")
				? "no-change"
				: run.status === "failed"
					? "failed"
					: run.status === "cancelled" ? "cancelled" : undefined;
		return {
			activityId: `schedule-run:${run.id}`,
			kind: "scheduled-research",
			scope: { kind: "goal", goalId },
			trigger: { kind: "schedule", scheduleId: run.scheduleId },
			title: chrome("activityChrome.research.scheduleTitle"),
			// run.error 是上游原始错误文本，保持原语言；其余状态是固定 chrome。
			summary: run.error ? [{ text: run.error }] : run.status === "published"
				? [
					...chrome("activityChrome.research.scheduleSources", { count: run.incrementalSources }),
					...chrome("activityChrome.research.scheduleNotes", { count: run.cornellNotes }),
				]
				: chrome(SCHEDULE_RUN_STATUS_KEYS[run.status]),
			lifecycle,
			...(outcome ? { outcome } : {}),
			timing: activityTiming(
				run.createdAt,
				run.finishedAt ?? run.startedAt ?? run.createdAt,
				run.finishedAt,
			),
			resultLinks: run.reportPath ? [{
				kind: "report",
				label: chrome("activityChrome.research.openReport"),
				href: `/api/goals/${encodeURIComponent(goalId)}/artifacts/blob?name=${encodeURIComponent(run.reportPath)}`,
				workspacePath: run.reportPath,
				available: true,
				primary: true,
			}] : [],
			steps: [],
			sourceRef: `schedule-run:${run.id}`,
		};
	}

}
/**
 * The last recorded time per Agent execution and per Stage. A Runtime event names the execution or
 * Stage it belongs to, so it is evidence about that Agent alone; the Run keeps its own `updated_at`.
 */
function recordedActivityByOwner(events: ReturnType<typeof readRuntimeRecords>): Map<string, string> {
	const latest = new Map<string, string>();
	const keep = (key: string, at: string) => {
		const current = latest.get(key);
		if (!current || Date.parse(at) > Date.parse(current)) latest.set(key, at);
	};
	for (const event of events) {
		const at = typeof event.created_at === "string" && Number.isFinite(Date.parse(event.created_at))
			? event.created_at
			: undefined;
		if (!at) continue;
		for (const [prefix, owner] of [
			["execution", event.execution_id],
			["execution", event.sub_execution_id],
			["stage", event.stage_id],
		] as const) {
			if (typeof owner === "string" && owner) keep(`${prefix}:${owner}`, at);
		}
	}
	return latest;
}

function latestTimestamp(values: Array<string | undefined>): string | undefined {
	return values.reduce<string | undefined>((latest, value) => {
		if (!value || !Number.isFinite(Date.parse(value))) return latest;
		return !latest || Date.parse(value) > Date.parse(latest) ? value : latest;
	}, undefined);
}

function researchLifecycle(status: RunStateV2["status"]): ActivityLifecycle {
	if (status === "initialized") return "queued";
	if (status === "interrupted") return "waiting";
	if (status === "published" || status === "skipped" || status === "failed" || status === "cancelled") return "finished";
	return "running";
}

function researchOutcome(status: RunStateV2["status"]): ActivityOutcome | undefined {
	if (status === "published") return "succeeded";
	if (status === "skipped") return "no-change";
	if (status === "failed") return "failed";
	if (status === "cancelled") return "cancelled";
	return undefined;
}

const RESEARCH_STATUS_KEYS = {
	initialized: "activityChrome.research.initialized",
	search_batch_running: "activityChrome.research.searching",
	evidence_materializing: "activityChrome.research.evidence",
	plan_authoring: "activityChrome.research.planAuthoring",
	plan_selected: "activityChrome.research.planSelected",
	chapters_writing: "activityChrome.research.chaptersWriting",
	citation_compiling: "activityChrome.research.citationCompiling",
	markdown_gating: "activityChrome.research.markdownGating",
	interrupted: "activityChrome.research.interrupted",
	published: "activityChrome.research.published",
	skipped: "activityChrome.research.skipped",
	failed: "activityChrome.research.failed",
	cancelled: "activityChrome.research.cancelled",
} satisfies Record<RunStateV2["status"], ActivityMessageKey>;

const SCHEDULE_RUN_STATUS_KEYS = {
	scheduled: "goalActivity.statusQueued",
	running: "goalActivity.stateRunning",
	published: "activityChrome.research.published",
	skipped_no_source_increment: "activityChrome.research.skippedNoIncrement",
	skipped_no_qualifying_evidence: "activityChrome.research.skippedNoEvidence",
	failed: "activityChrome.research.failed",
	cancelled: "activityChrome.research.cancelled",
} satisfies Record<ResearchScheduleRun["status"], ActivityMessageKey>;

function researchSummary(state: RunStateV2, providerSteps: ActivityStep[]): ActivityMessage[] {
	// state.failure.message 是 Runtime 原始错误文本，可能带堆栈和主机路径，只留在失败的 Step、Node Trace 与服务端日志里。
	// 模型服务的 HTTP 错误例外：状态码和服务方自己的说明是用户能据此处理的事实（例如余额不足需要充值或换模型）。
	if (state.failure && state.status === "failed") {
		const provider = providerErrorMessage(redactResearchSecrets(state.failure.message));
		return provider ? [...chrome("activityChrome.research.failed"), ...provider] : chrome("activityChrome.research.failedSeeDetail");
	}
	// 获取部分失败不构成 Attention，因为它没有可执行的下一步，但必须出现在摘要里，
	// 否则一次所有素材获取都失败、只剩元数据的研究会和正常研究长得一模一样。
	const tail: ActivityMessage[] = [
		...providerFallbackParts(providerSteps, state.status),
		...degradedSearchParts(state),
		...(state.cornell_note_failure_count
			? chrome("activityChrome.research.sourceNoteFailures", { count: state.cornell_note_failure_count })
			: []),
	];
	if (state.status === "published") {
		return [
			...chrome("activityChrome.research.published"),
			...chrome("activityChrome.usage.modelCalls", { count: state.usage.model_calls }),
			...tail,
		];
	}
	if (state.status === "skipped") {
		return [
			...chrome(state.skip_reason === "no_source_increment"
				? "activityChrome.research.skippedNoIncrement"
				: "activityChrome.research.skippedNoEvidence"),
			...tail,
		];
	}
	return [...chrome(RESEARCH_STATUS_KEYS[state.status]), ...tail];
}

function degradedSearchParts(state: RunStateV2): ActivityMessage[] {
	const degraded = state.degraded_searches ?? [];
	if (degraded.length === 0) return [];
	const failed = degraded.reduce((total, entry) => total + entry.operations_failed, 0);
	const providers = [...new Set(degraded.map((entry) => entry.provider_id))].join(", ");
	return chrome("activityChrome.research.degradedFetch", { providers, count: failed });
}

function providerAccessSteps(
	events: ReturnType<typeof readRuntimeRecords>,
	runDir: string,
	runFinished: boolean,
	executionRounds?: ReadonlyMap<Record<string, unknown>, number>,
): ActivityStep[] {
	const access = new Map<string, Record<string, unknown>>();
	const fallbacks: Array<Record<string, unknown>> = [];
	for (const event of events) {
		if (event.type === "runtime.provider_access" && typeof event.provider_id === "string"
			&& typeof event.sub_execution_id === "string") {
			access.set(`${event.sub_execution_id}\0${event.provider_id}`, event);
		}
		if (event.type === "runtime.provider_fallback_selected" && typeof event.from_provider_id === "string"
			&& typeof event.to_provider_id === "string") fallbacks.push(event);
	}
	let calls: ReturnType<typeof readProviderCallRecords> = [];
	try {
		calls = readProviderCallRecords(runDir);
	} catch {
		// A partial final JSONL line during a concurrent write must not hide the Activity itself.
	}
	const steps = [...access.values()].flatMap((event): ActivityStep[] => {
		const providerId = String(event.provider_id);
		const execution = executionRounds ? { executionRound: executionRounds.get(event) } : {};
		const createdAt = stringField(event.created_at) ?? new Date().toISOString();
		const waitStartedAt = stringField(event.wait_started_at) ?? createdAt;
		if (event.state === "cooling") return [{
			...execution,
			stepId: `provider-access:${String(event.sub_execution_id)}:${providerId}`,
			title: chrome("activityChrome.provider.coolingTitle", { provider: providerLabel(providerId) }),
			summary: chrome("activityChrome.provider.coolingSummary", { provider: providerLabel(providerId) }),
			lifecycle: runFinished ? "finished" : "running",
			...(runFinished ? { outcome: "partial" as const } : {}),
			timing: activityTiming(waitStartedAt, createdAt, runFinished ? createdAt : undefined),
			dependsOnStepIds: [], parallelSteps: [], agentActivities: [],
			providerAccess: {
				kind: "cooling", providerId,
				failureClass: stringField(event.failure_class),
				waitStartedAt,
				budgetDeadlineAt: stringField(event.budget_deadline_at),
				nextAttemptAt: stringField(event.next_attempt_at),
			},
		}];
		if (event.state === "recovered") {
			const endedAt = stringField(event.ended_at) ?? createdAt;
			return [{
				...execution,
				stepId: `provider-access:${String(event.sub_execution_id)}:${providerId}`,
				title: chrome("activityChrome.provider.recoveredTitle", { provider: providerLabel(providerId) }),
				summary: chrome("goalActivity.providerRecovered", { provider: providerLabel(providerId) }),
				lifecycle: "finished", outcome: "succeeded",
				timing: activityTiming(waitStartedAt, endedAt, endedAt),
				dependsOnStepIds: [], parallelSteps: [], agentActivities: [],
				providerAccess: { kind: "recovered", providerId, waitStartedAt },
			}];
		}
		if (event.state !== "unavailable") return [];
		const endedAt = stringField(event.ended_at) ?? createdAt;
		return [{
			...execution,
			stepId: `provider-access:${String(event.sub_execution_id)}:${providerId}`,
			title: chrome("activityChrome.provider.unavailableTitle", { provider: providerLabel(providerId) }),
			// 具体原因由 providerAccess.reason 带到前端，由 UI locale 决定措辞。
			summary: chrome("activityChrome.provider.unavailableSummary", { provider: providerLabel(providerId) }),
			lifecycle: "finished", outcome: "partial",
			timing: activityTiming(waitStartedAt, endedAt, endedAt),
			dependsOnStepIds: [], parallelSteps: [], agentActivities: [],
			providerAccess: {
				kind: "unavailable", providerId,
				failureClass: stringField(event.failure_class),
				waitStartedAt, reason: stringField(event.reason),
			},
		}];
	});
	for (const [index, event] of fallbacks.entries()) {
		const fromProviderId = String(event.from_provider_id);
		const providerId = String(event.to_provider_id);
		const selectedAt = stringField(event.created_at) ?? new Date().toISOString();
		const succeeded = calls.some((call) => call.provider === providerId && call.at >= selectedAt && call.response.status === "ok")
			|| fallbackSubmitted(runDir, providerId, selectedAt);
		const fallbackOutcome = succeeded ? "succeeded" : runFinished ? "uncovered" : "running";
		steps.push({
			...(executionRounds ? { executionRound: executionRounds.get(event) } : {}),
			stepId: `provider-fallback:${index}:${fromProviderId}:${providerId}`,
			title: chrome("activityChrome.provider.fallbackTitle", { provider: providerLabel(providerId) }),
			summary: chrome(fallbackOutcome === "succeeded"
				? "goalActivity.providerFallback.succeeded"
				: fallbackOutcome === "uncovered"
					? "goalActivity.providerFallback.uncovered"
					: "goalActivity.providerFallback.running",
			{ provider: providerLabel(providerId), from: providerLabel(fromProviderId) }),
			lifecycle: fallbackOutcome === "running" ? "running" : "finished",
			...(fallbackOutcome !== "running" ? { outcome: fallbackOutcome === "succeeded" ? "succeeded" as const : "partial" as const } : {}),
			timing: activityTiming(selectedAt, selectedAt, fallbackOutcome === "running" ? undefined : selectedAt),
			dependsOnStepIds: [], parallelSteps: [], agentActivities: [],
			providerAccess: { kind: "fallback", providerId, fromProviderId, fallbackOutcome },
		});
	}
	return steps;
}

function fallbackSubmitted(runDir: string, providerId: string, selectedAt: string): boolean {
	const workspaces = join(runDir, "workspaces");
	if (!existsSync(workspaces)) return false;
	const selectedAtMs = Date.parse(selectedAt);
	for (const batch of readdirSync(workspaces, { withFileTypes: true })) {
		if (!batch.isDirectory() || !/^search-batch-\d+(?:\.interrupted(?:\.\d+)?)?$/u.test(batch.name)) continue;
		const executions = join(workspaces, batch.name, "agent", "provider-executions");
		if (!existsSync(executions)) continue;
		for (const child of readdirSync(executions, { withFileTypes: true })) {
			if (!child.isDirectory() || !/^sub-[A-Za-z0-9-]+$/u.test(child.name)) continue;
			const marker = join(executions, child.name, "work", ".provider-assignment");
			if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || !lstatSync(marker).isFile()) continue;
			if (statSync(marker).mtimeMs >= selectedAtMs && readFileSync(marker, "utf8").trim() === providerId) return true;
		}
	}
	return false;
}

function providerFallbackParts(steps: ActivityStep[], status: RunStateV2["status"]): ActivityMessage[] {
	const unavailable = steps.find((step) => step.providerAccess?.kind === "unavailable")?.providerAccess;
	if (!unavailable) return [];
	const fallback = steps.find((step) => step.providerAccess?.kind === "fallback")?.providerAccess;
	if (fallback?.fallbackOutcome === "succeeded") {
		return chrome("activityChrome.research.providerReplaced", {
			provider: providerLabel(unavailable.providerId),
			fallback: providerLabel(fallback.providerId),
		});
	}
	return TERMINAL_RUN_SUMMARY_STATUSES.has(status)
		? chrome("activityChrome.research.providerUncovered", { provider: providerLabel(unavailable.providerId) })
		: [];
}

const TERMINAL_RUN_SUMMARY_STATUSES = new Set<RunStateV2["status"]>(["published", "skipped", "failed", "cancelled"]);

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function providerLabel(providerId: string): string {
	if (providerId === "arxiv") return "arXiv";
	if (providerId === "huggingface") return "Hugging Face Papers";
	return humanize(providerId);
}

function primeSearchStageSequence(stageId: string): { stageSequence?: number } {
	const match = /^prime-search-batch-(\d+)$/u.exec(stageId);
	return match ? { stageSequence: Number(match[1]) } : {};
}
