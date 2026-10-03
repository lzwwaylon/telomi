import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "../../web/src/app/i18n.js";
import { DiscoveryInboxList } from "../../web/src/features/goals/GoalDiscoveryInbox.js";
import type { DiscoveryInboxItem } from "../../web/src/features/goals/data/useDiscoveryInbox.js";

const item: DiscoveryInboxItem = {
	id: "discovery-1", goal_id: "goal-1", finding: "A finding", run_id: "run-1", source_id: "source:1",
	section_index: 0, cue_index: 0, cue: "A question", note: "A note", status: "open",
	created_at: "2026-09-01T00:00:00Z",
	evidence: [{ source_path: "document.md", start_line: 1, end_line: 2, content_sha256: "a".repeat(64) }],
	sources: [{ id: "source:1", title: "Original paper", url: "https://arxiv.org/abs/2601.00001" }],
};
const render = (items: DiscoveryInboxItem[], decidingId: string | null = null) => renderToStaticMarkup(
	<DiscoveryInboxList goalId="goal-1" items={items} decidingId={decidingId} onIgnore={() => {}} />,
);

const many = Array.from({ length: 8 }, (_, index) => ({ ...item, id: `discovery-${index}`, finding: `Finding ${index}` }));
const collapsed = render(many);
assert.equal((collapsed.match(/class="goal-discovery-item"/gu) ?? []).length, 5, "The Inbox defaults to five visible candidates");
assert.match(collapsed, /展开其余 3 条/u);
assert.match(collapsed, /aria-expanded="false" aria-controls="[^"]+"/u);
assert.ok(!collapsed.includes("Finding 5"), "Hidden candidates are not rendered in the collapsed list");
assert.ok(!render(many.slice(0, 5)).includes("goal-discovery-toggle"), "Exactly five candidates need no toggle");
assert.ok(!render([]).includes("goal-discovery-toggle"));

const source = render([item]);
assert.match(source, /href="https:\/\/arxiv.org\/abs\/2601.00001"/u);
assert.match(source, /target="_blank" rel="noopener noreferrer"/u);
assert.match(source, /Original paper/u);
assert.match(source, /arxiv.org/u);
assert.ok(source.indexOf("Original paper") < source.indexOf("</summary>"), "Provenance remains visible with the finding collapsed");
assert.match(source, /href="\/chat\/goal-1#discovery-discovery-1"/u, "Discussion retains the original candidate identity");
assert.match(render([item], item.id), /disabled=""/u, "Dismissal cannot be repeated during a pending decision");

const local = render([{ ...item, sources: [{ id: "local", title: "Uploaded document" }] }]);
assert.match(local, /Uploaded document/u);
assert.match(local, /本地素材/u);
assert.ok(!local.includes("target="));
assert.match(render([{ ...item, sources: [] }]), /原始素材暂不可用/u);
assert.match(render([{ ...item, sources: undefined }]), /原始素材暂不可用/u, "Older API responses remain readable");
const unsafe = render([{ ...item, sources: [{ id: "unsafe", title: "Untrusted source", url: "javascript:alert(1)" }] }]);
assert.ok(!unsafe.includes("javascript:"), "Untrusted URLs never become navigable links");

await i18n.changeLanguage("en");
assert.match(render(many), /Show 3 more/u);
await i18n.changeLanguage("zh-CN");
console.log("Discovery Inbox default limit, source links, safe fallbacks and localization passed");
