import assert from "node:assert/strict";

import type { ActivityStep, AgentActivity } from "../../shared/events/activity-projection.js";
import { groupActivitySteps } from "../../web/src/features/goals/activity-step-groups.js";
import { activityText } from "../../web/src/shared/lib/activity-text.js";

const at = "2026-09-03T00:00:00.000Z";

function agent(id: string, name: string): AgentActivity {
	return {
		agentActivityId: id,
		agentName: name,
		summary: id,
		lifecycle: "finished",
		outcome: "succeeded",
		timing: { createdAt: at, updatedAt: at },
		outputRef: `output:${id}`,
		attempts: [],
	};
}

function step(id: string, activity: AgentActivity, parallelSteps: ActivityStep[] = []): ActivityStep {
	return {
		stepId: id,
		title: id,
		summary: id,
		lifecycle: "finished",
		outcome: "succeeded",
		timing: { createdAt: at, updatedAt: at },
		dependsOnStepIds: [],
		parallelSteps,
		agentActivities: [activity],
	};
}

const cornellA = step("note:a", agent("cornell:a", "cornell_note"));
const cornellB = step("note:b", agent("cornell:b", "cornell_note"));
const research = groupActivitySteps([
	step("search", agent("search", "prime_search")),
	step("group:1", agent("ignored", "cornell_note"), [cornellA, cornellB]),
	step("group:2", agent("cornell:c", "cornell_note")),
	step("report", agent("report", "report_writer")),
]);

assert.equal(research.length, 1);
assert.deepEqual(research[0]!.entries.map((entry) => entry.kind), ["step", "worker-pool", "step"]);
const cornellPool = research[0]!.entries[1]!;
assert.equal(cornellPool.kind, "worker-pool");
assert.equal(activityText(cornellPool.label), "Cornell Note", "the pool label is a message id the UI renders");
assert.deepEqual(cornellPool.workers.map((worker) => worker.agent.agentActivityId), ["cornell:a", "cornell:b", "cornell:c"]);

const wiki = groupActivitySteps([
	step("wiki-batch:1", agent("wiki:1", "wiki_maintainer")),
	step("wiki-batch:2", agent("wiki:2", "wiki_maintainer")),
	step("wiki-stage:curation:1", agent("curator", "wiki_curator")),
]);

assert.equal(wiki.length, 2);
assert.equal(wiki[0]!.entries.length, 1);
assert.equal(wiki[0]!.entries[0]!.kind, "worker-pool");
assert.equal(wiki[0]!.entries[0]!.kind === "worker-pool" && wiki[0]!.entries[0]!.workers.length, 2);
assert.equal(wiki[1]!.entries[0]!.kind, "step");

console.log("Activity worker pool grouping test passed");
