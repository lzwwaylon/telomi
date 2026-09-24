import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalService } from "../../server/goals/service.js";
import { unusedGoalExecution } from "./unused-execution.js";

const directory = mkdtempSync(join(tmpdir(), "goal-runner-initialization-"));
try {
	const service = new GoalService(directory, unusedGoalExecution);
	const goal = service.ensureImportedGoal("goal_runner_race", "Runner initialization");
	let calls = 0;
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	const failure = new Error("stop before constructing a model-backed Runner");
	service.setBeforeRunnerCreateHook(async () => {
		calls += 1;
		await barrier;
		throw failure;
	});
	const first = service.getRunner(goal);
	const second = service.getRunner(goal);
	const completed = Promise.allSettled([first, second]);
	const activeDuringInitialization = service.isGoalActive(goal.id);
	release();
	const results = await completed;
	assert.equal(calls, 1, "Goal creation and frontend requests must share one Runner initialization");
	assert.ok(activeDuringInitialization, "A Goal cannot be deleted while its Runner initializes");
	for (const result of results) {
		assert.equal(result.status, "rejected");
		if (result.status === "rejected") assert.equal(result.reason, failure);
	}
	assert.equal(service.isGoalActive(goal.id), false);
	await assert.rejects(service.getRunner(goal), (error) => error === failure);
	assert.equal(calls, 2, "A failed initialization can be retried");
	console.log("Goal Runner initialization is shared, blocks deletion and can retry after failure");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
