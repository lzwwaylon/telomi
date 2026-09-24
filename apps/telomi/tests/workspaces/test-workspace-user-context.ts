import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { buildMainAgentPrompt } from "../../server/main-agent/system-prompts.js";

const dataDir = mkdtempSync(join(tmpdir(), "telomi-no-legacy-user-context-"));

try {
	const goalDir = join(dataDir, "goal_new");
	ensureGoalWorkspace({ goalDir, goalId: "goal_new", title: "New Goal" });

	assert.equal(existsSync(join(dataDir, "profile")), false);
	assert.equal(existsSync(join(goalDir, "wiki", "user")), false);
	assert.equal(existsSync(join(goalDir, "wiki", "pages")), false);

	const mainAgentPrompt = buildMainAgentPrompt(
		dataDir,
		"goal_new",
		"New Goal",
		"",
	);
	assert.doesNotMatch(mainAgentPrompt, /User Context|PREFERENCES\.md|wiki\/user/u);

	console.log("Legacy workspace user context is absent");
} finally {
	rmSync(dataDir, { recursive: true, force: true });
}
