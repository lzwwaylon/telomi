import { hashJson } from "../lib/hash.js";
import type {
	ActivityProjectionItem,
	ActivityStep,
	ActivityText,
	ActivityTiming,
	AgentActivity,
} from "../../shared/events/activity-projection.js";
import { chrome } from "../../shared/events/activity-text.js";

/**
 * Timing from the recorded facts alone: `durationMs` is the span those facts cover, so it stays
 * stable between updates and keeps the projection revision tied to what actually changed. A running
 * item's elapsed time is not a recorded fact, so `withLiveElapsed` measures it against the clock.
 */
export function activityTiming(createdAt: string, updatedAt: string, finishedAt?: string) {
	const start = Date.parse(createdAt);
	const end = Date.parse(finishedAt ?? updatedAt);
	return {
		createdAt,
		startedAt: createdAt,
		updatedAt,
		...(finishedAt ? { finishedAt } : {}),
		...(Number.isFinite(start) && Number.isFinite(end) ? { durationMs: Math.max(0, end - start) } : {}),
	};
}

/**
 * A running Activity was last active whenever anything recorded inside it was: its own record may
 * only change between Stages, while a Stage's Agents keep recording progress for tens of minutes.
 * Each Step keeps its own last activity, so a quiet Worker still reads as quiet beside busy siblings.
 */
export function withRecordedActivity(item: ActivityProjectionItem): ActivityProjectionItem {
	if (item.lifecycle !== "running") return item;
	let latest = item.timing.updatedAt;
	const visit = (timing: ActivityTiming) => {
		if (Date.parse(timing.updatedAt) > Date.parse(latest)) latest = timing.updatedAt;
	};
	const visitStep = (step: ActivityStep): void => {
		visit(step.timing);
		step.parallelSteps.forEach(visitStep);
		for (const agent of step.agentActivities) {
			visit(agent.timing);
			agent.attempts.forEach((attempt) => visit(attempt.timing));
		}
	};
	item.steps.forEach(visitStep);
	return latest === item.timing.updatedAt ? item : { ...item, timing: { ...item.timing, updatedAt: latest } };
}

/**
 * Elapsed time of everything still running, measured against `now` instead of the last recorded
 * update: a Stage that stopped reporting keeps counting, which is exactly when the number matters.
 * A queued or waiting item is not spending time on work, so its recorded span stays as projected,
 * and `updatedAt` keeps meaning the last activity at every level. Nothing under a finished Activity
 * is still running, whatever its last recorded Step status says, so its whole tree stays fixed.
 */
export function withLiveElapsed(item: ActivityProjectionItem, now: number): ActivityProjectionItem {
	if (item.lifecycle === "finished") return item;
	return {
		...item,
		timing: liveTiming(item.timing, item.lifecycle, now),
		steps: item.steps.map((step) => liveStep(step, now)),
	};
}

function liveStep(step: ActivityStep, now: number): ActivityStep {
	return {
		...step,
		timing: liveTiming(step.timing, step.lifecycle, now),
		parallelSteps: step.parallelSteps.map((nested) => liveStep(nested, now)),
		agentActivities: step.agentActivities.map((agent) => liveAgentActivity(agent, now)),
	};
}

function liveAgentActivity(agent: AgentActivity, now: number): AgentActivity {
	return {
		...agent,
		timing: liveTiming(agent.timing, agent.lifecycle, now),
		attempts: agent.attempts.map((attempt) => ({
			...attempt,
			timing: liveTiming(attempt.timing, attempt.lifecycle, now),
		})),
	};
}

function liveTiming(timing: ActivityTiming, lifecycle: ActivityProjectionItem["lifecycle"], now: number): ActivityTiming {
	if (lifecycle !== "running") return timing;
	const startedAt = Date.parse(timing.startedAt ?? timing.createdAt);
	// An unreadable start keeps the recorded span; a start in the future reads as zero elapsed time
	// rather than as negative work.
	if (!Number.isFinite(startedAt)) return timing;
	return { ...timing, durationMs: Math.max(0, now - startedAt) };
}

export function compareHistory(left: ActivityProjectionItem, right: ActivityProjectionItem): number {
	return right.timing.updatedAt.localeCompare(left.timing.updatedAt)
		|| right.activityId.localeCompare(left.activityId);
}

export function revisionFor(value: unknown): string {
	return hashJson(value).slice(0, 20);
}

export function humanize(value: unknown): string {
	return String(value ?? "")
		.replace(/[_:-]+/gu, " ")
		.replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

/**
 * The user-facing name of a Runtime Stage: what the Stage achieves, not the internal graph node it
 * came from. Product and Agent names stay as their domain names. An unrecognized Stage id resolves to
 * a generic localized Step label instead of showing a machine-generated name; the id itself stays in
 * the Node Execution Record and the Stage traces.
 */
export function stageTitle(stageId: string): ActivityText {
	const batch = /^(?:prime-)?search-batch-(\d+)$/u.exec(stageId);
	if (batch) return chrome("activityChrome.stage.primeSearchBatch", { sequence: Number(batch[1]) });
	const note = /^cornell-note-(\d+)-(.+)$/u.exec(stageId);
	if (note) return chrome("activityChrome.stage.cornellNote", { sequence: note[1]!, source: note[2]! });
	switch (stageId) {
		case "input-resolution": return chrome("activityChrome.stage.inputResolution");
		case "research-pipeline-start": return chrome("activityChrome.stage.pipelineStart");
		case "research-pipeline-finish": return chrome("activityChrome.stage.pipelineFinish");
		case "final-runtime-gate": return chrome("activityChrome.stage.runtimeGate");
		case "workspace-run": return chrome("activityChrome.stage.workspaceRun");
		case "writer-report":
		case "writer_report":
		case "report-writer":
		case "report_writer": return chrome("activityChrome.stage.reportWriter");
		case "prime-search":
		case "prime_search": return chrome("activityChrome.stage.primeSearch");
		case "cornell-note":
		case "cornell_note": return chrome("activityChrome.stage.cornellNoteGeneric");
		default: return chrome("activityChrome.stage.internal");
	}
}
