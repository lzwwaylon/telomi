import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { GlobalActivityProjectionSummary } from "../../shared/events/activity-projection.js";
import { ActivityWall } from "../../web/src/features/home/ActivityWall.js";
import { HomeVolume } from "../../web/src/features/home/HomeVolume.js";
import { PulseBand } from "../../web/src/features/home/PulseBand.js";
import type { GoalSummary } from "../../shared/types.js";
import i18n from "../../web/src/app/i18n.js";

await i18n.changeLanguage("zh-CN");

const now = "2026-08-06T05:09:50.000Z";
const goal: GoalSummary = {
	id: "goal_disconnected",
	title: "成为语音识别专家",
	description: "",
	createdAt: now,
	updatedAt: now,
	preview: "",
	messageCount: 1,
	isStreaming: true,
	lastActivityAt: now,
	fresh: true,
	pulseLine: "正在规划检索",
};
const activity = {
	activityId: "research:goal_disconnected",
	kind: "research" as const,
	scope: { kind: "goal" as const, goalId: goal.id },
	trigger: { kind: "manual" as const },
	title: goal.title,
	summary: "正在规划检索",
	lifecycle: "running" as const,
	timing: { createdAt: now, startedAt: now, updatedAt: now },
	resultLinks: [],
	steps: [],
	sourceRef: "run-state.json",
};
const summary: GlobalActivityProjectionSummary = {
	schemaVersion: 1,
	revision: "stale-revision",
	generatedAt: now,
	summary: { attention: 0, running: 1, queued: 0, waiting: 0 },
	activities: [activity],
	goals: [{
		goalId: goal.id,
		summary: { attention: 0, running: 1, queued: 0, waiting: 0 },
	}],
	system: { attention: 0, running: 0, queued: 0, waiting: 0 },
};

const pulse = renderToStaticMarkup(
	<PulseBand
		route="home"
		goals={[goal]}
		selectedGoal={null}
		snapshot={null}
		activitySummary={summary}
		backendConnection="disconnected"
	/>,
);
assert.match(pulse, /后端连接已断开/u);
assert.doesNotMatch(pulse, /Activity 正在进行/u);
assert.doesNotMatch(pulse, />1<\/b>\s*运行中/u);

const wall = renderToStaticMarkup(
	<ActivityWall
		goals={[goal]}
		activities={[activity]}
		backendConnection="disconnected"
		onSelectGoal={() => undefined}
	/>,
);
assert.match(wall, /后端连接已断开/u);
assert.doesNotMatch(wall, /在跑/u);
assert.doesNotMatch(wall, /正在规划检索/u);

const home = renderToStaticMarkup(<HomeVolume onOpenArtifact={() => undefined} />);
assert.match(home, /aria-busy="true"/u);
assert.match(home, /正在读取最新产物/u);
assert.doesNotMatch(home, /还没有产物|各 Agent 还在整理/u,
	"pending reads must not claim that there are no artifacts or that Agents are working");

console.log("backend disconnect UI test passed");
