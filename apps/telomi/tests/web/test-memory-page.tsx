import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemoryEpisodeView, MemoryObservationView } from "../../shared/user-memory.js";
import i18n from "../../web/src/app/i18n.js";
import { MemoryObservations, MemorySection } from "../../web/src/features/memory/MemoryPage.js";

const episode: MemoryEpisodeView = {
	documentId: "episode-1", source: "message", text: "原始对话，包含很长的任务要求。",
	occurredAt: "2026-09-01T00:00:00Z", goalId: "goal-1", global: false, status: "retained",
	facts: [
		{ id: "fact-1", text: "用户偏好中文解释。", invalidated: false },
		{ id: "fact-2", text: "用户熟悉 Python。", invalidated: false },
		{ id: "fact-3", text: "已过时的偏好。", invalidated: true },
	],
};
const emptyEpisode = { ...episode, documentId: "episode-empty", text: "谢谢，已经足够了。", facts: [] };
const actions = {
	saveFact: async () => true, setInvalidated: async () => true, setGlobal: async () => true, requestDelete: () => {},
};
const render = (episodes: MemoryEpisodeView[], view: "active" | "invalidated" | "unextracted" = "active", query = "") => renderToStaticMarkup(
	<MemorySection title="Goal memory" hint="Scope" episodes={episodes} query={query} empty="No memory" goalId="goal-1" view={view} actions={actions} />,
);

const active = render([episode, emptyEpisode]);
assert.doesNotMatch(active, /谢谢，已经足够了/u, "An Episode without Facts must not appear as active memory");
assert.match(active, /<h2>Goal memory<\/h2><span>2<\/span>/u, "The section counts Facts, just like the active tab");
assert.match(active, /用户偏好中文解释/u);
assert.doesNotMatch(active, /已过时的偏好/u);
assert.ok(active.indexOf("用户偏好中文解释") < active.indexOf("原始对话"), "Extracted memory precedes its original source");
assert.match(active, /<details[^>]*><summary/u, "The original source is collapsed by default");
assert.doesNotMatch(active, /<details[^>]* open/u);
assert.match(render([emptyEpisode]), /No memory/u);
assert.doesNotMatch(render([emptyEpisode]), /都已作废/u, "No extraction is different from invalidation");
assert.match(render([{ ...episode, facts: episode.facts.filter((fact) => fact.invalidated) }]), /都已作废/u);

const sources = render([
	episode, emptyEpisode,
	{ ...emptyEpisode, documentId: "waiting", status: "waiting" },
	{ ...emptyEpisode, documentId: "failed", status: "failed" },
], "unextracted");
assert.match(sources, /<h2>Goal memory<\/h2><span>3<\/span>/u);
assert.match(sources, /谢谢，已经足够了/u);
assert.match(sources, /等待写入/u);
assert.match(sources, /写入失败/u);
assert.doesNotMatch(sources, /用户偏好中文解释|memory-toggle-global/u);
assert.match(render([episode], "unextracted"), /没有未形成记忆的原始记录/u);
assert.match(render([{ ...emptyEpisode, global: true }], "unextracted"), /memory-toggle-global/u,
	"Previously global empty sources can still return to their Goal without deletion");
assert.doesNotMatch(render([{ ...emptyEpisode, global: true, goalId: undefined }], "unextracted"), /memory-toggle-global/u,
	"A global source whose Goal was deleted cannot return to that Goal");

const invalidated = render([episode], "invalidated");
assert.match(invalidated, /<h2>Goal memory<\/h2><span>1<\/span>/u);
assert.match(invalidated, /已过时的偏好/u);
assert.doesNotMatch(invalidated, /用户偏好中文解释/u);
assert.match(invalidated, /memory-restore-fact/u);
assert.doesNotMatch(invalidated, /memory-toggle-global/u);

assert.match(render([episode], "active", "Python"), /用户熟悉 Python/u);
assert.match(render([episode], "active", "原始对话"), /用户偏好中文解释/u, "Search still finds memories by their source");
assert.doesNotMatch(render([episode], "active", "absent"), /memory-episode"/u);

const proposal = render([{ ...episode, source: "schedule_proposal", text: "INTERNAL EXTRACTION INPUT", scheduleProposal: {
	scheduleTitle: "Weekly research", summary: "Expand to another topic", reason: "Keep the original scope",
} }]);
assert.match(proposal, /Weekly research/u);
assert.match(proposal, /Keep the original scope/u);
assert.doesNotMatch(proposal, /INTERNAL EXTRACTION INPUT/u);

const observations: MemoryObservationView[] = [
	{ id: "observation-1", text: "用户偏好中文解释，尤其关注 Python 实现。\n关联多个来源 | 保留完整归纳", goalId: "goal-1" },
	{ id: "observation-2", text: "<script>untrusted text</script>", goalId: "goal-2", goalTitle: "Other Goal" },
];
const renderObservations = (items: MemoryObservationView[], query = "") => renderToStaticMarkup(
	<MemoryObservations title="Observations" observations={items} query={query} goalId="goal-1" />,
);
const consolidated = renderObservations(observations);
assert.match(consolidated, /<h2>Observations<\/h2><span>2<\/span>/u);
assert.match(consolidated, /关联多个来源 \| 保留完整归纳/u);
assert.match(consolidated, /来自 Other Goal/u);
assert.match(consolidated, /&lt;script&gt;untrusted text&lt;\/script&gt;/u);
assert.doesNotMatch(consolidated, /<button|<textarea|memory-toggle-global|memory-fact/u, "Observations have no curation controls");
assert.match(renderObservations(observations, " python "), /<span>1<\/span>/u);
assert.doesNotMatch(renderObservations(observations, "python"), /untrusted text/u);
assert.match(renderObservations(observations, "absent"), /没有匹配的记忆/u);
assert.match(renderObservations([]), /还没有归纳记忆/u);

await i18n.changeLanguage("en");
assert.match(render([episode]), /View source/u);
assert.match(renderObservations([]), /No observations yet/u);
await i18n.changeLanguage("zh-CN");
console.log("Memory page prioritizes extracted facts, separates empty sources and keeps source search");
