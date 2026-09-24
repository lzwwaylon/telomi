import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { groupMessagesIntoTurns } from "../../web/src/features/chat/turn-adapter.ts";
import { resolveWikiSource } from "../../server/wiki/source.ts";

test("keeps one Activity for a persisted Wiki Tool call", () => {
	const details = {
		query: "Whisper",
		mode: "keyword_graph",
		results: [{ page_ref: "P1", title: "Whisper" }],
	};
	const messages = [
		{ role: "user", content: "查找 Whisper", timestamp: 1 },
		{
			role: "assistant",
			content: [{
				type: "toolCall",
				id: "wiki-search-1",
				name: "wiki_search",
				arguments: { query: "Whisper" },
			}],
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "wiki-search-1",
			toolName: "wiki_search",
			content: [{ type: "text", text: JSON.stringify(details) }],
			details,
			isError: false,
			timestamp: 3,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "Whisper 是语音识别模型。" }],
			timestamp: 4,
			citationMessageId: "wiki_0123456789abcdef0123",
		},
	] as any[];
	const turns = groupMessagesIntoTurns(messages, {
		toolResultMap: new Map([["wiki-search-1", messages[2]]]),
		pendingToolCalls: new Set(),
		isStreaming: false,
		lastAssistantIndex: 3,
	});

	assert.equal(turns.length, 2);
	assert.equal(turns[1]?.type, "assistant");
	if (turns[1]?.type !== "assistant") return;
	assert.equal(turns[1].activities.length, 1);
	assert.equal(turns[1].activities[0]?.toolName, "wiki_search");
	assert.equal(turns[1].response?.messageId, "wiki_0123456789abcdef0123");
});

test("Wiki read summaries use the page title and never the internal page ref", () => {
	for (const scenario of [
		{ details: { title: "Qwen3-TTS 本地部署", page_ref: "P66" }, streaming: false, expected: "读取 Wiki 页面 · Qwen3-TTS 本地部署" },
		{ details: {}, streaming: false, expected: "读取 Wiki 页面" },
		{ details: { title: 66 }, streaming: false, expected: "读取 Wiki 页面" },
		{ details: undefined, streaming: true, expected: "读取 Wiki 页面" },
	]) {
		const messages = [{
			role: "assistant", timestamp: 1,
			content: [{ type: "toolCall", id: "read-page", name: "wiki_read_page", arguments: { path: "P66" } }],
		}] as any[];
		const result = { role: "toolResult", toolCallId: "read-page", toolName: "wiki_read_page", content: [], details: scenario.details, isError: false, timestamp: 2 } as any;
		const turns = groupMessagesIntoTurns(messages, {
			toolResultMap: scenario.streaming ? new Map() : new Map([["read-page", result]]),
			pendingToolCalls: new Set(scenario.streaming ? ["read-page"] : []),
			isStreaming: scenario.streaming,
			lastAssistantIndex: 0,
		});
		assert.equal(turns[0]?.type, "assistant");
		if (turns[0]?.type !== "assistant") return;
		assert.equal(turns[0].intent, scenario.expected);
		assert.equal(turns[0].activities[0]?.toolInput?.path, "P66", "inspection retains the actual Tool input");
	}
});

test("resolves a Wiki Logical Source from its Find Out snapshot", async () => {
	const goalDir = await mkdtemp(join(tmpdir(), "pi-wiki-logical-source-"));
	try {
		const runId = "2026-08-15T00-00-00.000Z";
		const logicalRoot = join(goalDir, "wiki", "runs", runId, "artifacts", "find-out-sources", "sequence-1");
		const sourceRoot = join(logicalRoot, "sources", "logical", "members", "arxiv", "paper");
		await mkdir(sourceRoot, { recursive: true });
		await writeFile(join(sourceRoot, "paper.md"), "# Logical evidence\n\nExact source body.\n", "utf8");
		const sourceId = "source:logical-evidence";
		await writeFile(join(logicalRoot, "manifest.json"), JSON.stringify({
			schema_version: 2,
			sequence: 1,
			sources: [{
				source_id: sourceId,
				title: "Logical evidence",
				path: "sources/logical",
				organization_kind: "ungrouped",
				organization_reason: "single source",
				revision_sha256: "a".repeat(64),
				members: [{
					candidate_id: "candidate:paper",
					source_id: "source:raw-paper",
					provider_id: "arxiv",
					title: "Logical evidence",
					canonical_locator: "https://example.test/paper",
					path: "members/arxiv/paper",
					summary: "Paper",
				}],
			}],
		}));
		const source = await resolveWikiSource(goalDir, sourceId, runId);
		assert.equal(source.title, "Logical evidence");
		assert.equal(source.runId, runId);
		assert.match(source.content, /Exact source body/u);
		await assert.rejects(() => resolveWikiSource(goalDir, "../secret/document.md", runId), /Invalid Wiki Source ID/u);
	} finally {
		await rm(goalDir, { recursive: true, force: true });
	}
});
