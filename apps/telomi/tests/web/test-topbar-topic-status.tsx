import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoalSnapshot, GoalSummary } from "../../shared/types.js";
import { TopBar, type TopBarProps } from "../../web/src/app/TopBar.js";
import type { TopicPlan, TopicPlanProposal } from "../../web/src/features/goals/data/useTopicPlan.js";
import i18n from "../../web/src/app/i18n.js";

await i18n.changeLanguage("zh-CN");
const timestamp = "2026-10-11T00:00:00.000Z";
const goal: GoalSummary = {
	id: "goal-topic-status", title: "Research", description: "", preview: "",
	createdAt: timestamp, updatedAt: timestamp, lastActivityAt: timestamp,
	messageCount: 1, fresh: true, isStreaming: false, pulseLine: null,
	avatar: { head: "tufts", eye: "round", color: "sky" }, discoveryEnabled: false, outputLanguage: "en",
};
const snapshot: GoalSnapshot = {
	goalId: goal.id, title: goal.title, description: "", messages: [],
	isStreaming: false, pendingToolCalls: [], stopState: "idle",
};
const noop = () => undefined;
function topicButton(overrides: Partial<TopBarProps> = {}): string {
	const html = renderToStaticMarkup(<TopBar route="goal" goals={[goal]} selectedGoal={goal} snapshot={snapshot}
		backendConnection="connected" topicPlan={null} topicProposal={null} topicOpen={false}
		onGoHome={noop} onOpenPalette={noop} onOpenSettings={noop} onTopicOpenChange={noop} onSelectGoal={noop}
		{...overrides} />);
	const button = html.match(/<button\b[^>]*data-testid="topbar-topic"[^>]*>[\s\S]*?<\/button>/u)?.[0];
	assert.ok(button);
	return button;
}
function assertIdle(button: string, label: string): void {
	assert.ok(button.includes(`aria-label="${label}"`), button);
	assert.doesNotMatch(button, /aria-busy="true"|topic-plan-generating-ring/u);
}

assertIdle(topicButton(), i18n.t("topbar.topicMissing"));
assertIdle(topicButton({ selectedGoal: { ...goal, fresh: false }, snapshot: null }), i18n.t("topbar.topicMissing"));
assertIdle(topicButton({ selectedGoal: { ...goal, fresh: false },
	snapshot: { ...snapshot, goalId: "another-goal", isStreaming: true } }), i18n.t("topbar.topicMissing"));

for (const overrides of [
	{ selectedGoal: { ...goal, fresh: false, isStreaming: true }, snapshot: null },
	{ snapshot: { ...snapshot, isStreaming: true } },
]) {
	const button = topicButton(overrides);
	assert.ok(button.includes(`aria-label="${i18n.t("topbar.topicGenerating")}"`));
	assert.match(button, /aria-busy="true"/u);
	assert.match(button, /topic-plan-generating-ring/u);
}

const plan: TopicPlan = { revision: "revision-one", topics: [] };
const confirmed = topicButton({ topicPlan: plan, snapshot: { ...snapshot, isStreaming: true } });
assertIdle(confirmed, "Topic Plan");
assert.doesNotMatch(confirmed, /disabled=/u);
const proposal: TopicPlanProposal = { proposal_id: "proposal-one", status: "proposed", created_at: timestamp,
	source: "main_agent", patch: { summary: "Proposed interests" }, candidate_plan: plan, diff: [] };
assertIdle(topicButton({ topicPlan: plan, topicProposal: proposal, snapshot: { ...snapshot, isStreaming: true } }),
	i18n.t("topbar.topicPending"));
console.log("TopBar Topic Plan: recent activity stays idle; streaming, confirmed and pending states remain distinct");
