import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { ActivityLifecycle, ActivityOutcome, ActivityProjectionItem, ActivityStep } from "../../shared/events/activity-projection.js";
import { chrome } from "../../shared/events/activity-text.js";
import type { ProjectionContribution } from "../events/activity-projection.js";
import { activityTiming, stageTitle } from "../events/projection-helpers.js";
import { currentSessionActivity, recordedAgentActivityAt, type ObservabilityActivityProjection } from "../observability/activity-projection.js";
import { readRuntimeRecords, type NodeExecutionRecord } from "../observability/run-records.js";
import { safeSessionPath } from "../observability/session-traces.js";
import { serverRuntimeDirForGoalDir } from "../workspaces/server-runtime-paths.js";
import { listInvestigationExecutions, type InvestigationThreadExecutionRecord } from "./investigation-threads.js";

const ID = /^[a-f0-9]{24}$/u;

/** A read model over retained investigation evidence, including executions predating Activity. */
export class InvestigationActivityProjection {
	constructor(private readonly options: { workspaceDir: string }, private readonly outputs: ObservabilityActivityProjection) {}

	project(goalId: string): ProjectionContribution[] {
		const goalDir = join(this.options.workspaceDir, goalId);
		const root = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations");
		const executions = listInvestigationExecutions(goalDir);
		const items = executions.map(({ execution, active }) => this.fromExecution(goalId, goalDir,
			join(root, execution.execution_id), execution, active));
		const retained = new Set(executions.map(({ execution }) => execution.execution_id));
		// Older investigations have no thread record, but their frozen request and result remain readable.
		for (const id of directories(root).filter(id => ID.test(id) && !retained.has(id))) {
			const requestPath = safeSessionPath(root, `${id}/request.json`);
			if (!requestPath) continue;
			const request = JSON.parse(readFileSync(requestPath, "utf8")) as { id?: string; goalId?: string; question?: string };
			if (request.id !== id || request.goalId !== goalId || typeof request.question !== "string") continue;
			const resultPath = safeSessionPath(root, `${id}/result.json`);
			const startedAt = statSync(requestPath).mtime.toISOString();
			items.push(this.fromExecution(goalId, goalDir, join(root, id), {
				schema_version: 1, thread_id: id, execution_id: id, question: request.question,
				allow_external: false, status: resultPath ? "completed" : "running", owner_pid: 1,
				started_at: startedAt, ...(resultPath ? { finished_at: statSync(resultPath).mtime.toISOString() } : {}),
			}, false));
		}
		return [{ source: "investigation", items }];
	}

	private fromExecution(goalId: string, goalDir: string, runDir: string,
		execution: InvestigationThreadExecutionRecord, active: boolean): ActivityProjectionItem {
		const id = execution.execution_id;
		const lifecycle: ActivityLifecycle = execution.status !== "running" ? "finished" : active ? "running" : "waiting";
		const outcome: ActivityOutcome | undefined = execution.status === "completed" ? "succeeded"
			: execution.status === "cancelled" ? "cancelled" : execution.status === "failed" ? "failed" : undefined;
		const updatedAt = execution.finished_at ?? execution.started_at;
		const readingRoot = join(goalDir, ".pi", "runtime", "note-reading");
		const recordDirectories = [runDir,
			...directories(runDir).filter(name => /^external-search-\d+$/u.test(name)).map(name => join(runDir, name)),
			...directories(readingRoot).filter(name => new RegExp(`^${id}-(?:external-)?\\d+$`, "u").test(name))
				.map(name => join(readingRoot, name)),
		];
		const steps = recordDirectories.flatMap(directory => scopeSteps(
			this.recordSteps(goalId, id, directory, lifecycle, outcome, updatedAt),
			`record:${directory === runDir ? "root" : basename(directory)}`));
		if (!readRuntimeRecords(runDir, "research").some(event => event.stage_id === "prime-investigation" || event.node_id === "prime-investigation")) {
			// Historical Roots never registered a node; their own saved session still shows the work.
			steps.unshift(this.agentStep(goalId, id, runDir, { executionId: id, agent: "prime_search",
				stageId: "prime-investigation", sessionFile: "trace.jsonl", startedAt: execution.started_at,
				lifecycle, outcome, updatedAt, stepId: "investigation-root" }));
		}
		steps.sort((a, b) => a.timing.createdAt.localeCompare(b.timing.createdAt));
		return {
			activityId: `investigation:${id}`, kind: "investigation", scope: { kind: "goal", goalId },
			trigger: { kind: "manual" }, title: execution.question,
			summary: execution.status === "completed" ? execution.progress?.summary ?? chrome("activityChrome.investigation.completed")
				: lifecycle === "waiting" ? chrome("activityChrome.investigation.interrupted")
					: outcome === "failed" ? chrome("activityChrome.research.failedSeeDetail")
						: outcome === "cancelled" ? chrome("goalActivity.statusCancelled") : chrome("activityChrome.investigation.running"),
			lifecycle, ...(outcome ? { outcome } : {}), timing: activityTiming(execution.started_at, updatedAt, execution.finished_at),
			...(lifecycle === "waiting" ? { waiting: { kind: "external" as const,
				reason: chrome("activityChrome.investigation.interrupted"), waitingSince: updatedAt, actions: [] } } : {}),
			resultLinks: execution.status === "completed" && existsSync(join(goalDir, "artifacts", "investigations", id, "result.json")) ? [{
				kind: "artifact", label: chrome("activityChrome.investigation.openAnswer"), available: true, primary: true,
				workspacePath: `artifacts/investigations/${id}/result.json`,
				href: `/api/goals/${encodeURIComponent(goalId)}/artifacts/blob?name=${encodeURIComponent(`artifacts/investigations/${id}/result.json`)}`,
			}] : [], steps, sourceRef: `investigation:${id}`,
		};
	}

	private recordSteps(goalId: string, id: string, directory: string, lifecycle: ActivityLifecycle,
		outcome: ActivityOutcome | undefined, updatedAt: string): ActivityStep[] {
		const events = readRuntimeRecords(directory, "research");
		const nodes = events.filter((event): event is typeof event & NodeExecutionRecord & { event_id: number } =>
			event.type === "node_execution" && typeof event.event_id === "number");
		const steps = this.outputs.fromNodes(goalId, id, directory, nodes);
		const latest = new Map(events.filter(event => event.type === "runtime.agent_bound" || event.type === "node_execution")
			.map(event => [event.execution_id, event] as const));
		for (const event of latest.values()) {
			if (event.type !== "runtime.agent_bound" || typeof event.execution_id !== "string"
				|| typeof event.agent !== "string" || typeof event.stage_id !== "string") continue;
			steps.push(this.agentStep(goalId, id, directory, {
				executionId: event.execution_id, agent: event.agent, stageId: event.stage_id,
				sessionFile: typeof event.session_file === "string" ? event.session_file : undefined,
				startedAt: typeof event.created_at === "string" ? event.created_at : updatedAt, lifecycle,
				outcome: lifecycle === "finished" ? outcome === "succeeded" ? "partial" : outcome : undefined,
				updatedAt, stepId: `active:${event.execution_id}`,
			}));
		}
		const acquisition = /^external-search-(\d+)$/u.exec(basename(directory));
		return acquisition ? steps.map(step => step.agentActivities.some(agent => agent.agentName === "prime_search")
			? { ...step, title: stageTitle(`prime-search-batch-${acquisition[1]}`) } : step) : steps;
	}

	private agentStep(goalId: string, id: string, directory: string, input: {
		executionId: string; agent: string; stageId: string; sessionFile?: string; startedAt: string;
		lifecycle: ActivityLifecycle; outcome?: ActivityOutcome; updatedAt: string; stepId: string;
	}): ActivityStep {
		const batch = /^prime-search-batch-(\d+)$/u.exec(input.stageId);
		const pointer = { kind: "recorded-agent" as const, goalId, runId: id, runDirectory: directory,
			agent: input.agent, executionId: input.executionId, sessionFile: input.sessionFile,
			...(batch ? { stageSequence: Number(batch[1]) } : {}), startedAt: input.startedAt,
			lifecycle: input.lifecycle, outcome: input.outcome,
			...(input.lifecycle === "finished" ? { finishedAt: input.updatedAt } : {}),
		};
		const outputRef = this.outputs.registerOutput(pointer);
		const path = input.sessionFile ? safeSessionPath(directory, basename(input.sessionFile)) : undefined;
		let session: ReturnType<typeof currentSessionActivity> = {};
		try {
			session = this.outputs.currentActivity(goalId, outputRef);
			if (!session.summary && path) session = currentSessionActivity(path);
		} catch { /* The native Session may still be appending. */ }
		const lastActivity = recordedAgentActivityAt(pointer) ?? session.at;
		const at = input.lifecycle === "running" ? lastActivity ?? input.startedAt : input.updatedAt;
		const timing = activityTiming(input.startedAt, at, input.lifecycle === "finished" ? at : undefined);
		const summary = input.lifecycle === "waiting" ? chrome("activityChrome.investigation.stepInterrupted")
			: session.summary ?? chrome(input.lifecycle === "running" ? "activityChrome.agent.runningPlain" : "activityChrome.agent.noCompletionRecord");
		return {
			stepId: input.stepId, title: stageTitle(input.stageId), summary, lifecycle: input.lifecycle,
			...(input.outcome ? { outcome: input.outcome } : {}), timing, dependsOnStepIds: [], parallelSteps: [],
			agentActivities: [{ agentActivityId: `agent:${input.executionId}`, agentName: input.agent, summary,
				lifecycle: input.lifecycle, ...(input.outcome ? { outcome: input.outcome } : {}), timing, outputRef, attempts: [] }],
		};
	}
}

function directories(root: string): string[] {
	return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
}

function scopeSteps(steps: ActivityStep[], prefix: string): ActivityStep[] {
	return steps.map(step => ({ ...step, stepId: `${prefix}:${step.stepId}`,
		dependsOnStepIds: step.dependsOnStepIds.map(id => `${prefix}:${id}`),
		parallelSteps: scopeSteps(step.parallelSteps, prefix),
		agentActivities: step.agentActivities.map(agent => ({ ...agent, agentActivityId: `${prefix}:${agent.agentActivityId}` })),
	}));
}
