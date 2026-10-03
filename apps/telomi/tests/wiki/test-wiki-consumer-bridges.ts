import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import { readAgentToolBridgeCalls } from "../../server/agent-runtime/agent-tool-bridge.js";
import { readInvestigationHandoff } from "../../server/research/investigation-handoff.js";
import { startPrimeSourceBridge } from "../../server/research/pipeline/prime-search-batch.js";
import { createWikiReferenceAdapterFromRoot } from "../../server/research/pipeline/wiki-report-references.js";
import { startScheduleReviewBridge } from "../../server/research/schedules/reviewer.js";
import { ResearchSourceRegistry } from "../../server/research/sources/registry.js";
import { createGoalLlmWikiTools } from "../../server/wiki/tools.js";

const root = mkdtempSync(join(tmpdir(), "wiki-consumer-bridges-"));
try {
	const knowledgeRoot = join(root, "wiki", "knowledge");
	mkdirSync(knowledgeRoot, { recursive: true });
	writeFileSync(join(knowledgeRoot, ".topic-plan.json"), JSON.stringify({
		schema_version: 1, goal_id: "goal_bridge", revision: "a".repeat(64), status: "active",
		topics: [
			{ id: "topic-speech", title: "Speech", intent: "Track speech.", questions: [], include: [], exclude: [] },
			{ id: "topic-empty", title: "Empty", intent: "No Pages yet.", questions: [], include: [], exclude: [] },
		],
	}));
	writeFileSync(join(knowledgeRoot, "assigned.md"), [
		"---", "title: Assigned", "type: object", "topic_refs: [topic-speech]", "primary_topic_ref: topic-speech", "---",
		"# Assigned", "", "BRIDGEVERIFICATION731", "",
	].join("\n"));
	const adapter = createWikiReferenceAdapterFromRoot(knowledgeRoot, createGoalLlmWikiTools({ goalDir: root }));
	const tools = new Map(adapter.tools.map((tool) => [tool.name, tool]));
	const signal = new AbortController().signal;
	const answer = async (operation: string, args: Record<string, unknown>) => {
		const tool = tools.get(operation);
		assert.ok(tool, `expected current Wiki Tool ${operation}`);
		return (await tool.execute("consumer", args, signal)).details;
	};
	const expectedTopics = { topics: [
		{ topic_ref: "T1", title: "Speech", intent: "Track speech.", questions: [], include: [], exclude: [], page_count: 1 },
		{ topic_ref: "T2", title: "Empty", intent: "No Pages yet.", questions: [], include: [], exclude: [], page_count: 0 },
	] };
	const searchArgs = { query: "BRIDGEVERIFICATION731", top_k: 5, topic_ref: "T1" };
	const wikiCalls: Array<{ operation: string; args: Record<string, unknown> }> = [];
	let knowledgeSearchCalls = 0;
	const investigation = await startPrimeSourceBridge(new ResearchSourceRegistry(), new Set(), {
		workspaceDirectory: root, temporalContext: { schemaVersion: 1, currentDate: "2026-01-01", timeZone: "UTC" }, signal,
	}, root, { runDir: root, nodeId: "prime-investigation", attemptId: "1" }, {
		investigation: {
			knowledgeSearch: async () => { knowledgeSearchCalls++; return { pages: [], cues: [] }; },
			readSources: async () => ({ cues: [] }),
			wikiTool: async (operation, args) => { wikiCalls.push({ operation, args }); return answer(operation, args); },
		},
	});
	const investigateCall = async (payload: Record<string, unknown>, identity = "root", route = "/v1/wiki") => {
		const response = await fetch(`${investigation.baseUrl}${route}`, {
			method: "POST", headers: { "content-type": "application/json",
				authorization: `Bearer ${primeExecutionToken(investigation.token, identity)}` },
			body: JSON.stringify({ agent_session_id: identity, ...payload }),
		});
		return { status: response.status, body: await response.json() };
	};
	try {
		const listed = await investigateCall({ operation: "wiki_list_topics" });
		assert.equal(listed.status, 200);
		assert.deepEqual(readInvestigationHandoff(root, listed.body, "wiki_list_topics"), expectedTopics);
		assert.equal(knowledgeSearchCalls, 0, "Topic discovery does not consume legacy knowledge_search");
		const searched = await investigateCall({ operation: "wiki_search", ...searchArgs });
		assert.equal(searched.status, 200);
		const searchResult = readInvestigationHandoff(root, searched.body, "wiki_search") as {
			results: Array<{ page_ref: string; path?: string }>;
		};
		assert.equal(searchResult.results[0]?.page_ref, "P1");
		assert.equal(searchResult.results[0]?.path, undefined);
		const read = await investigateCall({ operation: "wiki_read_page", path: "P1" });
		assert.equal(read.status, 200);
		assert.match((readInvestigationHandoff(root, read.body, "wiki_read_page") as { content: string }).content,
			/BRIDGEVERIFICATION731/u);
		assert.deepEqual(wikiCalls, [
			{ operation: "wiki_list_topics", args: {} },
			{ operation: "wiki_search", args: searchArgs },
			{ operation: "wiki_read_page", args: { path: "P1" } },
		]);
		for (const operation of ["wiki_list_topics", "wiki_search", "wiki_read_page"]) {
			assert.equal((await investigateCall({ operation, ...searchArgs, path: "P1" }, "sub-123")).status, 422,
				"Investigation children cannot discover or retrieve Wiki knowledge directly");
		}
		assert.equal((await investigateCall({ operation: "wiki_search", ...searchArgs, topic_ref: "topic-speech" })).status, 422);
		assert.equal((await investigateCall({ operation: "wiki_graph_search", query: "speech" })).status, 422);
		assert.equal(wikiCalls.length, 3, "rejected calls never reach the Wiki Tool executor");
		assert.equal((await investigateCall({ query: "speech", limit: 5 }, "root", "/v1/knowledge-search")).status, 200);
		assert.equal(knowledgeSearchCalls, 1, "legacy knowledge_search remains independently available");
	} finally {
		await investigation.close();
	}

	const logPath = join(root, "schedule-tools.jsonl");
	const schedule = await startScheduleReviewBridge({ goalId: "goal_bridge", goalDir: root, logPath, signal,
		answerTool: answer });
	const scheduleCall = async (payload: Record<string, unknown>) => {
		const response = await fetch(`${schedule.baseUrl}/v1/schedule-review`, {
			method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${schedule.token}` },
			body: JSON.stringify(payload),
		});
		return { status: response.status, body: await response.json() };
	};
	try {
		assert.deepEqual(await scheduleCall({ operation: "wiki_list_topics" }), { status: 200, body: expectedTopics });
		const searched = await scheduleCall({ operation: "wiki_search", ...searchArgs });
		assert.equal(searched.status, 200);
		assert.equal(searched.body.results[0]?.page_ref, "P1");
		assert.equal((await scheduleCall({ operation: "wiki_read_page", path: "P1" })).status, 200);
		assert.equal((await scheduleCall({ operation: "wiki_search", ...searchArgs, topic_ref: "N1" })).status, 422);
		assert.equal((await scheduleCall({ operation: "wiki_graph_search", query: "speech" })).status, 422);
		const recorded = readAgentToolBridgeCalls(logPath);
		assert.deepEqual(recorded.map(({ operation, args }) => ({ operation, args })), [
			{ operation: "wiki_list_topics", args: {} },
			{ operation: "wiki_search", args: searchArgs },
			{ operation: "wiki_read_page", args: { path: "P1" } },
		]);
		assert.deepEqual(recorded[0]?.value, expectedTopics, "Capture records the exact Topic catalog returned to Reviewer");
	} finally {
		await schedule.close();
	}
	const legacy = await startScheduleReviewBridge({ goalId: "goal_bridge", goalDir: root,
		logPath: join(root, "historical-tools.jsonl"), signal, legacyGraphSearch: true,
		answerTool: async (operation, args) => ({ operation, args, historical: true }) });
	try {
		const response = await fetch(`${legacy.baseUrl}/v1/schedule-review`, {
			method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${legacy.token}` },
			body: JSON.stringify({ operation: "wiki_graph_search", query: "speech", top_k: 5 }),
		});
		assert.equal(response.status, 200, "only an explicit historical bridge admits graph search");
		assert.deepEqual(await response.json(), { operation: "wiki_graph_search", args: { query: "speech", top_k: 5 }, historical: true });
	} finally {
		await legacy.close();
	}
	const historicalGoalDir = join(root, "goal_legacy");
	const historicalKnowledge = join(historicalGoalDir, "wiki", "knowledge");
	mkdirSync(historicalKnowledge, { recursive: true });
	writeFileSync(join(historicalKnowledge, "legacy.md"), "---\ntitle: Historical page\ntype: object\n---\n# Historical page\nLEGACYBRIDGE913\n");
	const live = await startScheduleReviewBridge({ goalId: "goal_legacy", goalDir: historicalGoalDir,
		logPath: join(root, "live-review", "tools.jsonl"), signal });
	try {
		const call = async (payload: Record<string, unknown>) => {
			const response = await fetch(`${live.baseUrl}/v1/schedule-review`, {
				method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${live.token}` },
				body: JSON.stringify(payload),
			});
			assert.equal(response.status, 200);
			return await response.json();
		};
		assert.deepEqual(await call({ operation: "wiki_list_topics" }), { topics: [] });
		const searched = await call({ operation: "wiki_search", query: "LEGACYBRIDGE913", top_k: 5 });
		assert.equal(searched.results[0]?.page_ref, "P1", "published pages remain searchable without a Topic Plan");
		writeFileSync(join(historicalKnowledge, "legacy.md"), "# Changed after snapshot\n");
		const page = await call({ operation: "wiki_read_page", path: "P1" });
		assert.match(page.content, /LEGACYBRIDGE913/u, "the Reviewer keeps its pinned Wiki after publication changes");
	} finally {
		await live.close();
	}
	console.log("Wiki consumers discover Topics and retrieve Pages through authenticated Runtime bridges");
} finally {
	rmSync(root, { recursive: true, force: true });
}
