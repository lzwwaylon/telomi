import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GoalWorkspacePublicationLock } from "../../server/workspaces/publication-lock.js";

const dataDir = mkdtempSync(join(tmpdir(), "pi-workspace-publication-lock-"));
const goalId = "goal_workspace_publication_lock";
const lock = new GoalWorkspacePublicationLock(goalId, dataDir);
const secondLock = new GoalWorkspacePublicationLock(goalId, dataDir);
assert.equal(secondLock.root, lock.root);

const order: string[] = [];
await Promise.all([
	lock.withLock("knowledge-publication", async () => {
		order.push("knowledge:start");
		await new Promise((resolve) => setTimeout(resolve, 20));
		order.push("knowledge:end");
	}),
	secondLock.withLock("wiki/publication", () => {
		order.push("wiki:start");
		order.push("wiki:end");
	}),
	lock.withLock("main-workspace", () => {
		order.push("main:start");
		order.push("main:end");
	}),
]);
assert.deepEqual(order, [
	"knowledge:start",
	"knowledge:end",
	"wiki:start",
	"wiki:end",
	"main:start",
	"main:end",
]);
assert.equal(existsSync(lock.lockPath), false);

writeFileSync(lock.lockPath, `${JSON.stringify({
	schemaVersion: 1,
	goalId,
	owner: "dead-test-owner",
	operationId: "dead-test-operation",
	ownerPid: 999_999_999,
	createdAt: new Date().toISOString(),
}, null, 2)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });

let recovered = false;
await lock.withLock("knowledge-publication", () => {
	recovered = true;
});
assert.equal(recovered, true);
assert.equal(existsSync(lock.lockPath), false);

const recoveryEvents = readFileSync(join(lock.root, "recovery-events.jsonl"), "utf-8")
	.trim()
	.split(/\r?\n/u)
	.map((line) => JSON.parse(line) as {
		previousOwner?: string;
		previousOwnerPid?: number;
		recoveredLockPath?: string;
	});
assert.equal(recoveryEvents.length, 1);
assert.equal(recoveryEvents[0]?.previousOwner, "dead-test-owner");
assert.equal(recoveryEvents[0]?.previousOwnerPid, 999_999_999);
assert.ok(recoveryEvents[0]?.recoveredLockPath);
assert.equal(existsSync(recoveryEvents[0]!.recoveredLockPath!), true);

writeFileSync(lock.lockPath, `${JSON.stringify({
	schemaVersion: 1,
	goalId,
	owner: "live-test-owner",
	operationId: "live-test-operation",
	ownerPid: process.pid,
	createdAt: new Date().toISOString(),
}, null, 2)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
await assert.rejects(lock.withLock("contender", () => undefined), /held by process/u);
assert.equal(existsSync(lock.lockPath), true);
unlinkSync(lock.lockPath);
assert.equal(existsSync(lock.lockPath), false);

console.log("Goal Workspace publication lock tests passed");
