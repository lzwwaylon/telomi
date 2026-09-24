import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { searchContent } from "../../server/search/content-search.js";
import { upsertUserTaskHistory } from "../../server/observability/task-history.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-content-search-"));
const goals = [{ id: "goal-a", title: "TTS 学习" }, { id: "goal-b", title: "视觉学习" }];

try {
	write(join(workspaceDir, "goal-a", "artifacts", "notes.md"), "# TTS 训练笔记\n\n整理声学模型训练过程。\n");
	write(join(workspaceDir, "goal-a", "wiki", "runs", "run-a", "report", "final.md"), "# TTS 架构报告\n\n比较离散与连续语音表示。\n");
	write(join(workspaceDir, "goal-b", "artifacts", "vision.md"), "# 视觉模型\n\n视觉模型记录。\n");
	write(join(workspaceDir, "goal-a", ".media-products", "notes", "podcast-ai.meta.json"), `${JSON.stringify({
		generatedAt: "2026-09-01T08:00:00.000Z", extra: { title: "TTS 专家播客", slug: "tts-expert" },
	})}\n`);
	write(join(workspaceDir, "goal-a", "podcasts", "tts-expert", "episode.mp3"), "audio");
	write(join(workspaceDir, "goal-b", ".media-products", "broken", "podcast-ai.meta.json"), "not json");
	upsertUserTaskHistory(serverRuntimeDirForGoal("goal-a", workspaceDir), {
		version: 1,
		type: "task_history",
		taskId: "user-question",
		source: "user_message",
		goalId: "goal-a",
		createdAt: "2026-09-01T09:00:00.000Z",
		updatedAt: "2026-09-01T09:00:00.000Z",
		originalQuestion: "TTS 声码器如何训练？",
		normalizedInput: "TTS 声码器如何训练？",
		message: { conversationId: "goal-a", userMessageId: "user-question", role: "user" },
		labels: {},
	});

	const all = searchContent(workspaceDir, goals, "TTS");
	assert.deepEqual(new Set(all.map((result) => result.kind)), new Set(["report", "podcast", "file", "question"]));
	assert.ok(all.every((result) => result.goalId === "goal-a"));
	assert.equal(searchContent(workspaceDir, [goals[1]!], "TTS").length, 0, "Goal scope must be enforced by the caller's goal list");
	assert.equal(searchContent(workspaceDir, goals, "TTS 架构")[0]?.kind, "report");
	console.log("Goal content search passed");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
