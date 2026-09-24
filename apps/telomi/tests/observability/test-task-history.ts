import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	readUserTaskHistory,
	upsertUserTaskHistory,
	userTasksHistoryPath,
	type TaskHistoryRecord,
} from "../../server/observability/task-history.js";

const root = mkdtempSync(join(tmpdir(), "telomi-task-history-"));
const runtimeDir = join(root, ".pi", "runtime", "harness", "goal_task_history_test");
const createdAt = "2026-07-08T01:02:03.000Z";

function record(overrides: Partial<TaskHistoryRecord> = {}): TaskHistoryRecord {
	return {
		version: 1,
		type: "task_history",
		taskId: "task-1",
		source: "main_agent",
		goalId: "goal_task_history_test",
		createdAt,
		updatedAt: createdAt,
		originalQuestion: "Find the latest papers and write a report.",
		canonicalResearchTask: "Research recent primary papers and publish an evidence-backed report.",
		normalizedInput: "Find the latest papers and write a report.",
		route: {
			routerRunId: "tool-call-1",
			workspaceRunId: "workspace_1",
			executionKind: "research_runtime",
			goalId: "goal_task_history_test",
			workspaceId: "goal_task_history_test",
			reason: "research runtime selected",
		},
		workspace: {
			goalDir: join(root, "goal_task_history_test"),
		},
		researchRun: {
			workflowId: "telomi-research",
			workflowVersion: 1,
			workspaceRunId: "workspace_1",
			runDir: join(runtimeDir, "runs", "workspace_1"),
			status: "started",
		},
		labels: {},
		...overrides,
	};
}

function userMessageRecord(overrides: Partial<TaskHistoryRecord> = {}): TaskHistoryRecord {
	return {
		version: 1,
		type: "task_history",
		taskId: "user-1",
		source: "user_message",
		goalId: "goal_task_history_test",
		createdAt: "2026-07-08T01:00:03.000Z",
		updatedAt: "2026-07-08T01:00:03.000Z",
		originalQuestion: "Please debug this script.",
		normalizedInput: "Please debug this script.\n\nAttachments:\n- input.py (text/x-python)",
		message: {
			conversationId: "goal_task_history_test",
			userMessageId: "user-1",
			role: "user",
			attachments: [
				{
					fileName: "input.py",
					mimeType: "text/x-python",
					size: 128,
					type: "document",
				},
			],
		},
		workspace: {
			goalDir: join(root, "goal_task_history_test"),
		},
		labels: { taskType: "code_task", requiresTool: true },
		...overrides,
	};
}

try {
	const path = upsertUserTaskHistory(runtimeDir, record());
	assert.equal(path, userTasksHistoryPath(runtimeDir));
	assert.ok(existsSync(path));
	assert.equal(readUserTaskHistory(runtimeDir).length, 1);

	upsertUserTaskHistory(runtimeDir, record({
		updatedAt: "2026-07-08T01:03:03.000Z",
		researchRun: {
			workflowId: "telomi-research",
			workflowVersion: 1,
			workspaceRunId: "workspace_1",
			runDir: join(runtimeDir, "runs", "workspace_1"),
			status: "success",
			durationMs: 1234,
			tokenUsage: { input: 10, output: 20 },
			reports: [join(runtimeDir, "reports", "paper.md")],
		},
		finalAnswer: "Report written.",
		labels: { taskType: "research_report", requiresTool: true },
	}));

	const updated = readUserTaskHistory(runtimeDir);
	assert.equal(updated.length, 1);
	assert.equal(updated[0]?.taskId, "task-1");
	const researchRun = updated[0]?.researchRun;
	assert.ok(researchRun);
	assert.equal(researchRun.status, "success");
	assert.equal(researchRun.durationMs, 1234);
	assert.equal(updated[0]?.finalAnswer, "Report written.");
	assert.equal(updated[0]?.canonicalResearchTask, "Research recent primary papers and publish an evidence-backed report.");
	assert.deepEqual(updated[0]?.labels, { taskType: "research_report", requiresTool: true });

	upsertUserTaskHistory(runtimeDir, record({
		taskId: "task-2",
		createdAt: "2026-07-08T01:04:03.000Z",
		updatedAt: "2026-07-08T01:04:03.000Z",
		originalQuestion: "Debug the failing script.",
		normalizedInput: "Debug the failing script.",
		route: {
			routerRunId: "tool-call-2",
			workspaceRunId: "workspace_2",
			executionKind: "research_runtime",
			goalId: "goal_task_history_test",
			workspaceId: "goal_task_history_test",
			reason: "main agent selected",
		},
		researchRun: {
			workflowId: "telomi-research",
			workflowVersion: 1,
			workspaceRunId: "workspace_2",
			runDir: join(runtimeDir, "runs", "workspace_2"),
			status: "failed",
			errorMessage: "tool failed",
		},
	}));

	upsertUserTaskHistory(runtimeDir, userMessageRecord());

	const all = readUserTaskHistory(runtimeDir);
	assert.equal(all.length, 3);
	assert.deepEqual(all.map((entry) => entry.taskId), ["user-1", "task-1", "task-2"]);
	const userTask = all[0];
	assert.equal(userTask?.source, "user_message");
	assert.equal(userTask?.researchRun, undefined);
	assert.equal(all[2]?.researchRun?.status, "failed");
	assert.equal(all[2]?.researchRun?.errorMessage, "tool failed");
	assert.equal(userTask?.message?.conversationId, "goal_task_history_test");
	assert.equal(userTask?.message?.attachments?.[0]?.fileName, "input.py");

	const raw = readFileSync(path, "utf-8").trim().split("\n");
	assert.equal(raw.length, 3);
	assert.ok(raw.every((line) => JSON.parse(line).type === "task_history"));

	console.log("task history test passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
