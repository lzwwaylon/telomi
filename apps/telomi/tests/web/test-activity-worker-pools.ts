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

const noteA = step("note:a", agent("note:a", "note_agent"));
const noteB = step("note:b", agent("note:b", "note_agent"));
const research = groupActivitySteps([
	step("search", agent("search", "prime_search")),
	step("group:1", agent("ignored", "note_agent"), [noteA, noteB]),
	step("group:2", agent("note:c", "note_agent")),
	step("report", agent("report", "report_writer")),
]);

assert.equal(research.length, 1);
assert.deepEqual(research[0]!.entries.map((entry) => entry.kind), ["step", "worker-pool", "step"]);
const notePool = research[0]!.entries[1]!;
assert.equal(notePool.kind, "worker-pool");
assert.equal(activityText(notePool.label), "Note Agent", "the pool label is a message id the UI renders");
assert.deepEqual(notePool.workers.map((worker) => worker.agent.agentActivityId), ["note:a", "note:b", "note:c"]);

const wiki = groupActivitySteps([
	step("wiki-objects:1", agent("wiki:1", "wiki_compilation")),
	step("wiki-objects:2", agent("wiki:2", "wiki_compilation")),
	step("wiki-stage:merge-objects:1", agent("curator", "wiki_compilation")),
	step("wiki-stage:plan-concepts:2", agent("planner", "wiki_compilation")),
	step("wiki-stage:concepts:3", agent("concept", "wiki_compilation")),
	step("wiki-stage:page-topics:4", agent("classifier:1", "wiki_compilation")),
	step("wiki-stage:page-topics:5", agent("classifier:2", "wiki_compilation")),
	step("wiki-stage:publication:6", agent("publisher", "wiki_publication")),
]);

assert.deepEqual(wiki.map((group) => group.id), ["objects", "concepts", "classification", "publication"]);
assert.equal(wiki[0]!.entries.length, 2);
assert.equal(wiki[0]!.entries[0]!.kind, "worker-pool");
assert.equal(wiki[0]!.entries[0]!.kind === "worker-pool" && wiki[0]!.entries[0]!.workers.length, 2);
assert.equal(wiki[0]!.entries[1]!.kind, "step");
assert.equal(wiki[2]!.steps.length, 2);
assert.deepEqual(wiki.flatMap((group) => group.steps.flatMap((item) => item.agentActivities.map((activity) => activity.outputRef))),
	["output:wiki:1", "output:wiki:2", "output:curator", "output:planner", "output:concept", "output:classifier:1", "output:classifier:2", "output:publisher"],
	"phase grouping retains every original replay reference");
assert.equal(groupActivitySteps([step("wiki-stage:curate-evidence:0", agent("selector", "wiki_compilation"))])[0]?.id, "curation");

console.log("Activity worker pool grouping test passed");
