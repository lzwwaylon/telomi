import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalService } from "../../server/goals/service.js";
import { subscribe } from "../../server/events/event-bus.js";
import { unusedGoalExecution } from "./unused-execution.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "goal-wiki-resume-"));
const statuses: string[] = [];
const unsubscribe = subscribe((event) => {
	if (event.type === "research-run:changed" && event.goalId === "goal_resume") statuses.push(event.status);
});
try {
	let calls = 0;
	let complete!: () => void;
	const goals = new GoalService(workspaceDir, {
		...unusedGoalExecution,
		resumeWikiUpdate: async (input) => {
			calls += 1;
			assert.deepEqual(input, {
				workspaceDir, goalId: "goal_resume", goalDir: join(workspaceDir, "goal_resume"),
				runId: "wiki_run", env: goals.getGoalEnvSnapshot("goal_resume"),
			});
			assert.equal(input.env.RESUME_CREDENTIAL, "restored");
			await new Promise<void>((resolve) => { complete = resolve; });
			if (calls === 1) throw new Error("injected Wiki resume failure");
			return { pageCount: 2 };
		},
	});
	goals.ensureImportedGoal("goal_resume", "Resume Wiki");
	goals.setGoalEnvVar("goal_resume", "RESUME_CREDENTIAL", "restored");
	assert.throws(() => goals.startWikiUpdateResume("missing", "wiki_run"), /Unknown goal/);
	assert.throws(() => goals.startWikiUpdateResume("goal_resume", "../escape"), /Invalid Research Run id/);
	assert.equal(calls, 0);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		goals.startWikiUpdateResume("goal_resume", "wiki_run");
		assert.equal(calls, attempt + 1);
		assert.throws(() => goals.startWikiUpdateResume("goal_resume", "wiki_run"), /already running/);
		complete();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(statuses, Array.from({ length: attempt + 1 }, () => ["resuming", "settled"]).flat());
	}
	console.log("Goal Wiki resume uses injected execution and settles after failure and success");
} finally {
	unsubscribe();
	rmSync(workspaceDir, { recursive: true, force: true });
}
