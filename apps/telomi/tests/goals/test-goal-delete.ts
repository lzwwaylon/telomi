import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GoalService, type GoalLifecycleFs } from "../../server/goals/service.js";
import { unusedGoalExecution } from "./unused-execution.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const dataDir = mkdtempSync(join(tmpdir(), "telomi-goal-delete-"));
const cleanupError = new Error("simulated cleanup failure");
const lifecycleFs: GoalLifecycleFs = {
	rename,
	remove: async () => {
		throw cleanupError;
	},
};
const goals = new GoalService(dataDir, unusedGoalExecution, lifecycleFs);
const goal = seedGoal(dataDir, "goal_delete_transaction");
assert.equal(goals.getGoal(goal.id)?.discoveryEnabled, true);
assert.equal(goals.getGoal(goal.id)?.outputLanguage, "auto", "Goal records persist an explicit automatic language");
assert.equal(goals.updateGoalDiscovery(goal.id, false).discoveryEnabled, false);
assert.equal(goals.updateGoalOutputLanguage(goal.id, "en").outputLanguage, "en");
assert.equal(new GoalService(dataDir, unusedGoalExecution).getGoal(goal.id)?.discoveryEnabled, false, "Discovery setting must persist");
assert.equal(new GoalService(dataDir, unusedGoalExecution).getGoal(goal.id)?.outputLanguage, "en", "Goal output language must persist");

await assert.rejects(goals.deleteGoal(goal.id), cleanupError);
assert.equal(goals.getGoal(goal.id), undefined);
assert.equal(existsSync(join(dataDir, goal.id)), false, "the deleted Goal path must disappear atomically");
assert.equal(
	existsSync(serverRuntimeDirForGoal(goal.id, dataDir)),
	false,
	"the deleted Harness path must disappear atomically",
);

const invalidDataDir = mkdtempSync(join(tmpdir(), "telomi-goal-invalid-"));
writeFileSync(join(invalidDataDir, "goals.json"), "{\"invalid\":true}\n");
assert.throws(() => new GoalService(invalidDataDir, unusedGoalExecution), /goals.json must contain an array/u);

const oldGoalDataDir = mkdtempSync(join(tmpdir(), "telomi-goal-old-schema-"));
writeFileSync(join(oldGoalDataDir, "goals.json"), `${JSON.stringify([{
	id: "goal_old_schema",
	title: "Old schema",
	description: "Missing current required fields",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	preview: "",
	messageCount: 0,
}], null, 2)}\n`);
assert.throws(() => new GoalService(oldGoalDataDir, unusedGoalExecution), /discoveryEnabled must be a boolean/u);

const missingLanguageDir = mkdtempSync(join(tmpdir(), "telomi-goal-missing-language-"));
seedGoal(missingLanguageDir, "goal_missing_language");
const missingLanguageRecords = JSON.parse(readFileSync(join(missingLanguageDir, "goals.json"), "utf-8"));
delete missingLanguageRecords[0].outputLanguage;
writeFileSync(join(missingLanguageDir, "goals.json"), JSON.stringify(missingLanguageRecords));
assert.throws(() => new GoalService(missingLanguageDir, unusedGoalExecution), /outputLanguage is invalid/u);

const rollbackDir = mkdtempSync(join(tmpdir(), "telomi-goal-delete-rollback-"));
let renameCount = 0;
const stagingError = new Error("simulated staging failure");
const rollbackFs: GoalLifecycleFs = {
	rename: async (source, destination) => {
		renameCount += 1;
		if (renameCount === 2) throw stagingError;
		await rename(source, destination);
	},
	remove: async () => undefined,
};
const rollbackGoals = new GoalService(rollbackDir, unusedGoalExecution, rollbackFs);
const rollbackGoal = seedGoal(rollbackDir, "goal_delete_rollback");
mkdirSync(serverRuntimeDirForGoal(rollbackGoal.id, rollbackDir), { recursive: true });

await assert.rejects(rollbackGoals.deleteGoal(rollbackGoal.id), stagingError);
assert.ok(rollbackGoals.getGoal(rollbackGoal.id), "a failed staging transaction must preserve the Goal record");
assert.equal(existsSync(join(rollbackDir, rollbackGoal.id)), true, "a staged Goal path must roll back");
assert.equal(
	existsSync(serverRuntimeDirForGoal(rollbackGoal.id, rollbackDir)),
	true,
	"an unstaged Harness path must remain available",
);

const processDataDir = mkdtempSync(join(tmpdir(), "telomi-goal-delete-process-"));
const processGoals = new GoalService(processDataDir, unusedGoalExecution);
const processGoal = seedGoal(processDataDir, "goal_delete_processes");
const processHarness = serverRuntimeDirForGoal(processGoal.id, processDataDir);
mkdirSync(processHarness, { recursive: true });
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
	cwd: processHarness,
	stdio: "ignore",
});
await once(child, "spawn");
try {
	await processGoals.deleteGoal(processGoal.id);
	await Promise.race([
		once(child, "exit"),
		new Promise((resolve) => setTimeout(resolve, 500)),
	]);
	assert.ok(child.exitCode !== null || child.signalCode !== null,
		"deleting a Goal must terminate processes running inside its workspace or Harness");
} finally {
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const memoryDataDir = mkdtempSync(join(tmpdir(), "telomi-goal-delete-memory-"));
const memoryRequests: string[] = [];
let failNextMemoryDeletion = false;
const hindsight = createServer((request, response) => {
	memoryRequests.push(`${request.method} ${request.url}`);
	if (request.method === "DELETE" && failNextMemoryDeletion) {
		failNextMemoryDeletion = false;
		response.writeHead(500, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: "injected deletion failure" }));
		return;
	}
	response.writeHead(200, { "content-type": "application/json" });
	if (request.method === "GET") {
		const goalTag = new URL(request.url ?? "/", "http://hindsight").searchParams.get("tags") ?? "";
		response.end(JSON.stringify({
			items: [
				{ id: "goal-memory-document", created_at: "2026-09-01T00:00:00Z", tags: [goalTag] },
				{ id: "global-memory-document", created_at: "2026-09-01T00:00:00Z", tags: [goalTag, "scope:global"] },
			],
			total: 2,
			limit: 100,
			offset: 0,
		}));
		return;
	}
	response.end(JSON.stringify({ success: true }));
});
await new Promise<void>((resolve) => hindsight.listen(0, "127.0.0.1", resolve));
const hindsightAddress = hindsight.address();
assert(hindsightAddress && typeof hindsightAddress === "object");
const originalHindsightUrl = process.env.HINDSIGHT_URL;
const originalHindsightBank = process.env.HINDSIGHT_BANK_ID;
process.env.HINDSIGHT_URL = `http://127.0.0.1:${hindsightAddress.port}/v1/default`;
process.env.HINDSIGHT_BANK_ID = "goal-delete-test";
try {
	const memoryGoals = new GoalService(memoryDataDir, unusedGoalExecution);
	const memoryGoal = seedGoal(memoryDataDir, "goal_delete_memory");
	await memoryGoals.deleteGoal(memoryGoal.id);
	assert.ok(
		memoryRequests.some((request) => request.startsWith("GET /v1/default/banks/goal-delete-test/documents?")),
		"deleting a Goal must locate its Hindsight documents",
	);
	assert.ok(
		memoryRequests.includes("DELETE /v1/default/banks/goal-delete-test/documents/goal-memory-document"),
		"deleting a Goal must cascade to its Hindsight documents",
	);
	assert.ok(
		!memoryRequests.includes("DELETE /v1/default/banks/goal-delete-test/documents/global-memory-document")
			&& memoryRequests.includes("PATCH /v1/default/banks/goal-delete-test/documents/global-memory-document"),
		"an Episode the user made global outlives its Goal and only loses the Goal tag",
	);

	const retryGoal = seedGoal(memoryDataDir, "goal_delete_memory_retry");
	failNextMemoryDeletion = true;
	await memoryGoals.deleteGoal(retryGoal.id);
	const queuePath = join(memoryDataDir, ".pi", "runtime", "user-memory-deletions.json");
	assert.match(readFileSync(queuePath, "utf-8"), new RegExp(retryGoal.id, "u"));
	new GoalService(memoryDataDir, unusedGoalExecution);
	for (let attempt = 0; attempt < 20 && readFileSync(queuePath, "utf-8").includes(retryGoal.id); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.doesNotMatch(readFileSync(queuePath, "utf-8"), new RegExp(retryGoal.id, "u"),
		"a later GoalService startup must retry deferred Hindsight deletion");
} finally {
	if (originalHindsightUrl === undefined) delete process.env.HINDSIGHT_URL;
	else process.env.HINDSIGHT_URL = originalHindsightUrl;
	if (originalHindsightBank === undefined) delete process.env.HINDSIGHT_BANK_ID;
	else process.env.HINDSIGHT_BANK_ID = originalHindsightBank;
	await new Promise<void>((resolve, reject) => hindsight.close((error) => error ? reject(error) : resolve()));
}

console.log("Goal deletion transaction test passed");

function seedGoal(workspaceDir: string, id: string): { id: string } {
	const now = new Date().toISOString();
	writeFileSync(join(workspaceDir, "goals.json"), `${JSON.stringify([{
		id,
		title: "Delete fixture",
		description: "regression fixture",
		createdAt: now,
		updatedAt: now,
		preview: "",
		messageCount: 0,
		avatar: { head: "tufts", eye: "round", color: "sky" },
		discoveryEnabled: true,
		outputLanguage: "auto",
	}], null, 2)}\n`);
	mkdirSync(join(workspaceDir, id), { recursive: true });
	return { id };
}
