import type { ActivityStep, ActivityText, AgentActivity } from "@shared/events/activity-projection";
import { chrome } from "@shared/events/activity-text";

export interface ActivityWorker {
	stepId: string;
	title: ActivityText;
	summary: ActivityText;
	agent: AgentActivity;
}

export type ActivityStepEntry =
	| { kind: "step"; step: ActivityStep }
	| { kind: "worker-pool"; id: string; label: ActivityText; workers: ActivityWorker[] };

/** Groups carry message ids, so a `uiLocale` change cannot leave a grouped label behind. */
export interface ActivityStepGroup {
	id: string;
	label: ActivityText;
	steps: ActivityStep[];
	entries: ActivityStepEntry[];
}

export function groupActivitySteps(steps: ActivityStep[], currentRound?: number): ActivityStepGroup[] {
	const groups: ActivityStepGroup[] = [];
	for (const step of [...steps].sort((a, b) => (b.executionRound ?? 0) - (a.executionRound ?? 0))) {
		const phase = step.executionRound ? {
			id: `execution-${step.executionRound}`,
			label: chrome(
				step.executionRound === currentRound ? "goalActivity.currentExecution" : "goalActivity.previousExecution",
				{ round: step.executionRound },
			),
		} : activityPhase(step);
		const current = groups.at(-1);
		const group = current?.id === phase.id
			? current
			: { ...phase, steps: [], entries: [] };
		if (group !== current) groups.push(group);
		group.steps.push(step);

		const pool = workerPool(step);
		if (!pool) {
			group.entries.push({ kind: "step", step });
			continue;
		}
		const existing = group.entries.find((entry) => entry.kind === "worker-pool" && entry.id === pool.id);
		if (existing?.kind === "worker-pool") existing.workers.push(...pool.workers);
		else group.entries.push({ kind: "worker-pool", ...pool });
	}
	if (currentRound && !groups.some((group) => group.id === `execution-${currentRound}`)) {
		groups.unshift({
			id: `execution-${currentRound}`,
			label: chrome("goalActivity.currentExecution", { round: currentRound }),
			steps: [],
			entries: [],
		});
	}
	return groups;
}

function activityPhase(step: ActivityStep): { id: string; label: ActivityText } {
	if (step.stepId.startsWith("wiki-batch:")) return { id: "shards", label: chrome("goals.activityStepGroups.shardOrganization") };
	if (step.stepId.startsWith("wiki-stage:curation:")) return { id: "curation", label: chrome("goals.activityStepGroups.wikiCurator") };
	if (step.stepId.startsWith("wiki-stage:publication:")) return { id: "publication", label: chrome("goals.activityStepGroups.publication") };
	return { id: "execution", label: chrome("goals.activityStepGroups.executionPhase") };
}

function workerPool(step: ActivityStep): { id: string; label: ActivityText; workers: ActivityWorker[] } | null {
	const workers = activityWorkers(step);
	if (step.stepId.startsWith("wiki-batch:") && workers.length > 0) {
		return { id: "wiki-maintainers", label: chrome("goals.activityStepGroups.wikiWorkers"), workers };
	}
	if (workers.length > 0 && workers.every((worker) => worker.agent.agentName === "cornell_note")) {
		return { id: "cornell-notes", label: chrome("goals.activityStepGroups.cornellNotes"), workers };
	}
	return null;
}

function activityWorkers(step: ActivityStep): ActivityWorker[] {
	const steps = step.parallelSteps.length > 0 ? step.parallelSteps : [step];
	return steps.flatMap((workerStep) => workerStep.agentActivities.map((agent) => ({
		stepId: workerStep.stepId,
		title: workerStep.title,
		summary: workerStep.summary,
		agent,
	})));
}
