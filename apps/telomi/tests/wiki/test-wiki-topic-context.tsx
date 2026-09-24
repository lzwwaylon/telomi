import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "../web/setup-ui-locale.js";

import { TopBar } from "../../web/src/app/TopBar.js";
import { TopicPlanReadyNotice } from "../../web/src/features/chat/ChatPage.js";
import { TopicInspector } from "../../web/src/features/goals/TopicInspector.js";
import { wikiPageBelongsToTopic } from "../../web/src/features/wiki/wiki-model.js";
import type { GoalSnapshot, GoalSummary } from "../../shared/types.js";

const topics = [
	{ id: "topic-architecture", title: "架构范式", intent: "关注模型架构。", questions: ["范式如何变化？"], include: ["模型架构"], exclude: ["产品营销"] },
	{ id: "topic-license", title: "开放权重与许可", intent: "关注权重和许可证。", questions: [], include: ["开放权重"], exclude: ["闭源 API"] },
];
const plan = { revision: "b".repeat(64), topics };
const activePlan = { ...plan, revision: "a".repeat(64) };
const proposal = {
	proposal_id: "topic_proposal_pending",
	status: "proposed" as const,
	created_at: "2026-09-03T00:00:00.000Z",
	source: "main_agent" as const,
	patch: { summary: "拆分长期关注方向" },
	diff: ["新增 Topic：架构范式", "新增 Topic：开放权重与许可"],
	candidate_plan: plan,
};

const markup = renderToStaticMarkup(<TopicInspector
	open
	plan={plan}
	proposal={null}
	activating={false}
	error={null}
	versions={[
		{ revision: activePlan.revision, confirmedAt: "2026-09-01T09:00:00.000Z", active: true, wikiAvailable: true, plan: activePlan },
		{ revision: plan.revision, confirmedAt: "2026-09-01T08:00:00.000Z", active: false, wikiAvailable: true, plan },
	]}
	activeRevision={activePlan.revision}
	selectedTopicId="topic-license"
	onSelectTopic={() => undefined}
	onSelectRevision={() => undefined}
	onConfirm={() => undefined}
	onDiscuss={() => undefined}
	onResize={() => undefined}
	discoveryEnabled
	onDiscoveryEnabledChange={async () => undefined}
	onClose={() => undefined}
/>);
assert.match(markup, /开放权重与许可/u);
assert.match(markup, /开放权重/u);
assert.match(markup, /闭源 API/u);
assert.match(markup, /历史查看/u);
assert.match(markup, /当前 · Wiki/u);
assert.doesNotMatch(markup.replace(/<[^>]*>/gu, ""), /aaaaaaaa|bbbbbbbb/u);
assert.match(markup, /relative h-7 w-12/u);
assert.match(markup, /absolute left-1 top-1 h-5 w-5/u);
assert.match(markup, /translate-x-5/u);
assert.doesNotMatch(markup, /translate-x-6/u);
assert.doesNotMatch(markup, /打开 Topic Wiki/u);

const renderPending = (overrides: Partial<React.ComponentProps<typeof TopicInspector>> = {}) => renderToStaticMarkup(<TopicInspector
	open
	plan={proposal.candidate_plan}
	proposal={proposal}
	activating={false}
	error={null}
	versions={[]}
	activeRevision={null}
	selectedTopicId={null}
	onSelectTopic={() => undefined}
	onSelectRevision={() => undefined}
	onConfirm={() => undefined}
	onDiscuss={() => undefined}
	onResize={() => undefined}
	discoveryEnabled
	onDiscoveryEnabledChange={async () => undefined}
	onClose={() => undefined}
	{...overrides}
/>);
const pendingMarkup = renderPending();
assert.match(pendingMarkup, /待确认草案/u);
assert.doesNotMatch(pendingMarkup, /拆分长期关注方向|语义变更|未设置长期问题|font-serif/u);
assert.match(pendingMarkup, /包含 2 个长期关注方向/u);
assert.match(pendingMarkup, /架构范式/u);
assert.match(pendingMarkup, /开放权重与许可/u);
assert.match(pendingMarkup, /确认并启用/u);
assert.match(pendingMarkup, /和 Main Agent 讨论修改/u);
assert.match(pendingMarkup, /调整 Topic Plan 侧栏宽度/u);
assert.match(pendingMarkup, /aria-modal="false"/u);
assert.doesNotMatch(pendingMarkup, /关闭 Topic Plan" class="fixed inset-0/u);
assert.doesNotMatch(pendingMarkup, /历史查看/u);

const previousTopics = [topics[0]!, { ...topics[1]!, id: "removed", title: "旧关注方向" }];
const updatedPlan = { ...plan, topics: [{ ...topics[0]!, title: "架构与部署" }, topics[1]!] };
const changesMarkup = renderPending({
	plan: updatedPlan,
	proposal: { ...proposal, candidate_plan: updatedPlan },
	activeRevision: activePlan.revision,
	versions: [{ revision: activePlan.revision, confirmedAt: "2026-09-01T09:00:00.000Z", active: true, wikiAvailable: true, plan: { ...activePlan, topics: previousTopics } }],
});
assert.match(changesMarkup, /新增 1 个方向<\/strong><span[^>]*>开放权重与许可/u);
assert.match(changesMarkup, /修改 1 个方向<\/strong><span[^>]*>架构与部署/u);
assert.match(changesMarkup, /移除 1 个方向<\/strong><span[^>]*>旧关注方向/u);
assert.doesNotMatch(changesMarkup, /拆分长期关注方向|语义变更/u);

const readyMarkup = renderToStaticMarkup(<TopicPlanReadyNotice proposal={proposal} onOpen={() => undefined} />);
assert.match(readyMarkup, /Topic Plan 草案已准备好/u);
assert.match(readyMarkup, /包含 2 个长期关注方向/u);
assert.match(readyMarkup, /查看草案/u);
assert.doesNotMatch(readyMarkup, /拆分长期关注方向/u);

const themeCss = readFileSync(new URL("../../web/src/theme.css", import.meta.url), "utf8");
assert.match(themeCss, /body\[data-route="goal"\] \.app-shell\[data-topic-inspector="open"\][\s\S]*?grid-template-columns: var\(--rail-w\) minmax\(0, 1fr\)/u);
assert.match(themeCss, /@container goal-workspace \(max-width: 1100px\)/u);

const generatingGoal: GoalSummary = {
	id: "goal-generating",
	title: "Generating topics",
	description: "",
	createdAt: "2026-09-03T00:00:00.000Z",
	updatedAt: "2026-09-03T00:00:00.000Z",
	preview: "",
	messageCount: 0,
	isStreaming: true,
	lastActivityAt: "2026-09-03T00:00:00.000Z",
	fresh: true,
	pulseLine: null,
	avatar: { head: "tufts", eye: "round", color: "sky" },
	discoveryEnabled: true,
};
const generatingSnapshot: GoalSnapshot = {
	goalId: generatingGoal.id,
	title: generatingGoal.title,
	description: "",
	messages: [],
	isStreaming: true,
	pendingToolCalls: [],
	stopState: "idle",
};
const generatingTopBar = renderToStaticMarkup(<TopBar
	route="goal"
	goals={[generatingGoal]}
	selectedGoal={generatingGoal}
	snapshot={generatingSnapshot}
	backendConnection="connected"
	topicPlan={null}
	topicProposal={null}
	topicOpen={false}
	onGoHome={() => undefined}
	onOpenPalette={() => undefined}
	onOpenSettings={() => undefined}
	onOpenWiki={() => undefined}
	onTopicOpenChange={() => undefined}
	onSelectGoal={() => undefined}
/>);
assert.match(generatingTopBar, /Topic Plan 正在生成/u);
assert.match(generatingTopBar, /aria-busy="true"/u);
assert.match(generatingTopBar, /topic-plan-generating-ring/u);

assert.equal(wikiPageBelongsToTopic({
	primaryTopicRef: "topic-license",
	topicRefs: ["topic-license"],
}, topics[1]!), true);
assert.equal(wikiPageBelongsToTopic({ topicRefs: ["topic-license"] }, topics[0]!), false);

console.log("Wiki Topic inspector and filtering passed");
