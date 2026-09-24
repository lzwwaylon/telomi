import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import { createArtifactsRouter } from "../../server/media/artifacts-api.js";
import type { GoalService } from "../../server/goals/service.js";
import {
	isUserFacingArtifact,
	resolveProductArtifactPath,
	scanGoalProductArtifacts,
	scanGoalProductArtifactsToday,
} from "../../server/media/product-artifacts.js";

const root = mkdtempSync(join(tmpdir(), "telomi-product-artifacts-"));
const goalId = "goal_product_artifacts_test";
const goalDir = join(root, goalId);
const reportDir = join(goalDir, "wiki", "runs", "workspace_1", "report");
const artifactsDir = join(goalDir, "artifacts");
const reportPath = join(reportDir, "final.md");
const scratchPath = join(artifactsDir, "scratchpad.md");
const topicPlanPath = join(artifactsDir, "main", "topic-plan.json");
const privatePath = join(goalDir, "private.md");
let server: Server | undefined;

try {
	mkdirSync(reportDir, { recursive: true });
	mkdirSync(join(artifactsDir, "main"), { recursive: true });
	writeFileSync(reportPath, "# Workspace Report\n\nVisible report body.\n", "utf-8");
	writeFileSync(scratchPath, "# Scratchpad\n\nInternal notes.\n", "utf-8");
	writeFileSync(topicPlanPath, "{\"topics\":[]}\n", "utf-8");
	writeFileSync(privatePath, "# Private\n\nMust not be served as a Product Artifact.\n", "utf-8");
	symlinkSync(goalDir, join(artifactsDir, "main", "escaped"), "dir");
	symlinkSync(privatePath, join(reportDir, "escaped.md"));

	const app = express();
	app.use(createArtifactsRouter(root, {
		listGoals: () => [{ id: goalId, title: "Reports" }, { id: "goal_second", title: "Second Goal" }],
	} as GoalService));
	server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const escapedBlob = await fetch(
		`http://127.0.0.1:${address.port}/api/goals/${goalId}/artifacts/blob?name=${encodeURIComponent("main/escaped/private.md")}`,
	);
	assert.equal(escapedBlob.status, 400, "the Product Artifact file endpoint must reject a symlink escape");
	assert.doesNotMatch(await escapedBlob.text(), /Must not be served/u);

	const all = scanGoalProductArtifacts(root, goalId);
	const report = all.find((entry) => entry.name === "wiki/runs/workspace_1/report/final.md");
	assert.ok(report, "workspace report should be listed as a product artifact");
	assert.equal(report.source, "workspace-report");
	assert.equal(isUserFacingArtifact(report.name, report.source), true);

	const scratch = all.find((entry) => entry.name === "scratchpad.md");
	assert.ok(scratch, "classic artifacts should still be listed");
	assert.equal(isUserFacingArtifact(scratch.name, scratch.source), false);
	const topicPlan = all.find((entry) => entry.name === "main/topic-plan.json");
	assert.ok(topicPlan, "the confirmed Topic Plan should remain readable as an artifact");
	assert.equal(isUserFacingArtifact(topicPlan.name, topicPlan.source), false,
		"the internal Topic Plan document must not appear as a user-facing Product Artifact");

	const resolved = resolveProductArtifactPath(root, goalId, report.name);
	assert.equal(resolved, reportPath);
	assert.equal(existsSync(resolved), true);
	assert.throws(
		() => resolveProductArtifactPath(root, goalId, "main/escaped/private.md"),
		/symbolic link|resolves outside/u,
		"artifacts/main must not serve a regular file reached through a directory symlink outside the artifacts root",
	);
	assert.throws(
		() => resolveProductArtifactPath(root, goalId, "wiki/runs/workspace_1/report/escaped.md"),
		/symbolic link|resolves outside/u,
		"workspace reports must not serve a symlink to another Goal file",
	);

	const today = await scanGoalProductArtifactsToday(root, goalId, 0, Date.now() + 60_000);
	assert.ok(today.some((entry) => entry.name === report.name), "workspace report should be counted for today");

	const oldDate = new Date("2020-01-02T12:00:00Z");
	utimesSync(reportPath, oldDate, oldDate);
	for (let i = 0; i < 4; i++) {
		const path = join(artifactsDir, `report-${i}.md`);
		writeFileSync(path, `# Report ${i}\n\nPublished content.\n`);
		const date = new Date(oldDate.getTime() - (i + 1) * 86_400_000);
		utimesSync(path, date, date);
	}
	const secondDir = join(root, "goal_second", "artifacts");
	mkdirSync(secondDir, { recursive: true });
	writeFileSync(join(secondDir, "report.md"), "# Second Goal report\n");
	utimesSync(join(secondDir, "report.md"), oldDate, oldDate);
	const base = `http://127.0.0.1:${address.port}`;
	const recentResponse = await fetch(`${base}/api/artifacts/recent`);
	assert.equal(recentResponse.status, 200, "home must be able to read reports from previous days");
	const recent = await recentResponse.json();
	assert.deepEqual(recent.items.filter((item: { goalId: string }) => item.goalId === goalId)
		.map((item: { name: string }) => item.name), [report.name, "report-0.md", "report-1.md"],
		"the latest three user-facing artifacts per Goal include workspace reports, regardless of date");
	assert.ok(recent.items.some((item: { goalId: string; title: string }) =>
		item.goalId === "goal_second" && item.title === "Second Goal report"));
	assert.equal(recent.items.length, 4, "internal files must not occupy the per-Goal limit");
	const emptyDay = await (await fetch(`${base}/api/artifacts/today?date=2020-01-04`)).json();
	assert.deepEqual(emptyDay, { date: "2020-01-04", items: [] }, "the daily endpoint retains its date filter");

	console.log("product artifacts test passed");
} finally {
	if (server?.listening) {
		await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
	}
	rmSync(root, { recursive: true, force: true });
}
