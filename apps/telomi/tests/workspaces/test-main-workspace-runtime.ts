import assert from "node:assert/strict";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import {
	MainWorkspaceRuntime,
	type MainWorkspacePublishResult,
} from "../../server/main-agent/main-workspace-runtime.js";

const root = mkdtempSync(join(tmpdir(), "telomi-main-workspace-"));
const goalId = "main-workspace-test";
const goalDir = join(root, "goal");
const dataDir = join(root, "data");

function assertCleaned(session: { sandboxDir: string }): void {
	assert.equal(existsSync(session.sandboxDir), false, "temporary sandbox must be removed");
}

function requirePublished(result: MainWorkspacePublishResult) {
	assert.equal(result.status, "published");
	return result;
}

try {
	ensureGoalWorkspace({
		goalDir,
		goalId,
		title: "Main Workspace Runtime",
	});
	assert.equal(existsSync(join(goalDir, ".git")), false);

	const runtime = new MainWorkspaceRuntime(goalDir, goalId, dataDir);
	const add = runtime.prepare({ conversationId: "conversation-add" });
	const mainSession = runtime.writeRunMessages(add.id, [
		{ role: "user", content: "Organize this note" },
		{ role: "toolResult", toolName: "write", isError: false },
	]);
	assert.deepEqual(
		readFileSync(mainSession.path, "utf-8").trim().split("\n").map((line) => JSON.parse(line)),
		[
			{ role: "user", content: "Organize this note" },
			{ role: "toolResult", toolName: "write", isError: false },
		],
	);
	writeFileSync(join(add.workDirectory, "notes.md"), "# Durable note\n", "utf-8");
	const addResult = requirePublished(await runtime.publish(add.id));
	assert.equal(readFileSync(join(goalDir, "artifacts", "main", "notes.md"), "utf-8"), "# Durable note\n");
	assert.equal(addResult.changedFiles.length, 1);
	assert.equal(addResult.changedFiles[0]?.operation, "add");
	assert.ok(addResult.changedFiles[0]?.after?.sha256);
	assertCleaned(add);

	rmSync(serverRuntimeDirForGoal(goalId, dataDir), { recursive: true, force: true });
	assert.equal(
		readFileSync(join(goalDir, "artifacts", "main", "notes.md"), "utf-8"),
		"# Durable note\n",
		"durable Main Agent content must survive runtime cache deletion",
	);

	const updateRuntime = new MainWorkspaceRuntime(goalDir, goalId, dataDir);
	const update = updateRuntime.prepare({ conversationId: "conversation-update" });
	writeFileSync(join(update.workDirectory, "notes.md"), "# Durable note\n\nMore detail.\n", "utf-8");
	const updateResult = requirePublished(await updateRuntime.publish(update.id));
	assert.equal(updateResult.changedFiles[0]?.operation, "update");
	assert.notEqual(
		updateResult.changedFiles[0]?.before?.sha256,
		updateResult.changedFiles[0]?.after?.sha256,
	);
	assertCleaned(update);

	const noChange = updateRuntime.prepare({ conversationId: "conversation-no-change" });
	const noChangeResult = await updateRuntime.publish(noChange.id);
	assert.equal(noChangeResult.status, "no_change");
	assertCleaned(noChange);

	const outside = updateRuntime.prepare({ conversationId: "conversation-outside" });
	writeFileSync(join(outside.sandboxDir, "README.md"), "not owned\n", "utf-8");
	await assert.rejects(
		updateRuntime.publish(outside.id),
		/may only modify artifacts\/main/u,
	);
	assertCleaned(outside);

	const symlink = updateRuntime.prepare({ conversationId: "conversation-symlink" });
	symlinkSync(join(symlink.sandboxDir, "README.md"), join(symlink.workDirectory, "escape.md"));
	await assert.rejects(
		updateRuntime.publish(symlink.id),
		/regular files|symlink/u,
	);
	assertCleaned(symlink);

	const hardlink = updateRuntime.prepare({ conversationId: "conversation-hardlink" });
	linkSync(join(hardlink.workDirectory, "notes.md"), join(hardlink.workDirectory, "hardlink.md"));
	await assert.rejects(
		updateRuntime.publish(hardlink.id),
		/regular files/u,
	);
	assertCleaned(hardlink);

	const drift = updateRuntime.prepare({ conversationId: "conversation-drift" });
	writeFileSync(join(drift.workDirectory, "candidate.md"), "candidate\n", "utf-8");
	mkdirSync(join(goalDir, "artifacts", "main"), { recursive: true });
	writeFileSync(join(goalDir, "artifacts", "main", "concurrent.md"), "concurrent\n", "utf-8");
	await assert.rejects(
		updateRuntime.publish(drift.id),
		/main_workspace_base_drift/u,
	);
	assert.equal(existsSync(join(goalDir, "artifacts", "main", "candidate.md")), false);
	assertCleaned(drift);

	const remove = updateRuntime.prepare({ conversationId: "conversation-delete" });
	rmSync(join(remove.workDirectory, "notes.md"));
	const removeResult = requirePublished(await updateRuntime.publish(remove.id));
	assert.equal(removeResult.changedFiles[0]?.operation, "delete");
	assert.ok(removeResult.changedFiles[0]?.before);
	assert.equal(removeResult.changedFiles[0]?.after, undefined);
	assert.equal(existsSync(join(goalDir, "artifacts", "main", "notes.md")), false);
	assertCleaned(remove);

	assert.equal(existsSync(join(goalDir, ".git")), false, "Main Agent publication must not initialize Goal Git");
	console.log("Main Workspace filesystem publication tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
