import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GoalWikiSearch, scheduleWikiIndexRefresh, wikiIndexPath } from "../../server/wiki/local-search.js";
import { createGoalLlmWikiTools, normalizeWikiPagePath } from "../../server/wiki/tools.js";

const root = mkdtempSync(join(tmpdir(), "telomi-wiki-tools-"));
try {
	const snippetsRoot = join(root, "snippets");
	mkdirSync(snippetsRoot);
	writeFileSync(join(snippetsRoot, "distillation.md"), [
		"---", "title: Distillation", "description: A readable page description.", "---", "",
		"# Distillation", "", "## Approach", "",
		`**蒸馏** uses [teacher_model](../concepts/${"long-path-".repeat(200)}.md) and [E1](#evidence-1).`, "",
		"## Related", "", ...Array.from({ length: 30 }, (_, index) => `- [Relation ${index}](../concepts/related-${index}.md) - implements`),
		"- [METADATAONLY](../concepts/other.md) - implements", "",
		"## Evidence", "", "Private evidence dossier metadata.",
	].join("\n"));
	const boundaryText = `BOUNDARY ${"x".repeat(301)}`;
	writeFileSync(join(snippetsRoot, "boundary.md"), `# Boundary\n\n${boundaryText} [E2](#evidence-2).\n`);
	const snippets = new GoalWikiSearch(snippetsRoot, { embedding: async () => undefined });
	const excerpt = (await snippets.search("蒸馏", 1)).results[0]?.snippet;
	assert.equal(excerpt, "蒸馏 uses teacher_model and [E1](#evidence-1).", "clean complete Markdown before truncating while preserving evidence buttons");
	const metadataExcerpt = (await snippets.search("METADATAONLY", 1)).results[0]?.snippet;
	assert.equal(metadataExcerpt, "A readable page description.", "a chunk inside generated metadata falls back to the description");
	assert.doesNotMatch(excerpt ?? "", /Related|implements|concepts\//u);
	assert.equal((await snippets.search("BOUNDARY", 1)).results[0]?.snippet, `${boundaryText} [E2](#evidence-2).`, "truncation never leaves half an evidence link, and keeps the sentence's own full stop");

	const goalA = goal(root, "goal-a", "fireredasr2s", "FireRedASR2S");
	const goalB = goal(root, "goal-b", "voxtral", "Voxtral");
	const toolsA = createGoalLlmWikiTools({ goalDir: goalA });
	const toolsB = createGoalLlmWikiTools({ goalDir: goalB });
	assert.deepEqual(toolsA.map((tool) => tool.name), ["wiki_list_topics", "wiki_search", "wiki_read_page"]);
	const listA = toolsA.find((tool) => tool.name === "wiki_list_topics")!;
	const listB = toolsB.find((tool) => tool.name === "wiki_list_topics")!;
	const searchA = toolsA.find((tool) => tool.name === "wiki_search")!;
	const searchB = toolsB.find((tool) => tool.name === "wiki_search")!;
	const readA = toolsA.find((tool) => tool.name === "wiki_read_page")!;
	const graphA = createGoalLlmWikiTools({ goalDir: goalA, legacyGraphSearch: true })
		.find((tool) => tool.name === "wiki_graph_search")!;
	const listedA = (await listA.execute("topics-a", {})).details;
	assert.deepEqual(listedA, { topics: [
		{ topic_ref: "T1", title: "FireRedASR2S speech", intent: "Track speech recognition.",
			questions: ["Which languages are supported?"], include: ["ASR"], exclude: ["Marketing"], page_count: 2 },
		{ topic_ref: "T2", title: "Other speech", intent: "Other speech material.",
			questions: [], include: [], exclude: [], page_count: 1 },
		{ topic_ref: "T3", title: "Empty topic", intent: "No published pages yet.",
			questions: [], include: [], exclude: [], page_count: 0 },
	] }, "Topic refs follow Edition plan order and count matching pages, including empty Topics");
	assert.doesNotMatch(text(await listB.execute("topics-b", {})), /FireRedASR2S/u);
	assert.match(text(await listB.execute("topics-b-again", {})), /Voxtral speech/u);
	assert.deepEqual((await listA.execute("topics-a-again", {})).details, listedA,
		"repeated discovery retains the same refs");
	for (const topic_ref of ["T0", "T99", "N1", "topic-asr"]) {
		await assert.rejects(searchA.execute("bad-topic", { query: "FireRedASR2S", topic_ref }), /topic/iu);
	}
	assert.deepEqual(((await searchA.execute("empty-topic", { query: "FireRedASR2S", topic_ref: "T3" })).details as {
		results: unknown[];
	}).results, [], "a known Topic without pages does not fall back to global search");

	const scopedGoal = goal(root, "goal-scoped", "scoped-model", "Scoped model");
	const scopedRoot = join(scopedGoal, "wiki", "knowledge");
	const scopedPage = join(scopedRoot, "models", "scoped-model.md");
	writeFileSync(scopedPage, `${readFileSync(scopedPage, "utf-8")}\n## Additional finding\n\nSCOPEDBODY731 is outside a Topic-matched heading.\n`);
	writeFileSync(join(scopedRoot, "unassigned.md"), "# Unassigned\n\nUNASSIGNEDMARKER912\n");
	const scopedTools = createGoalLlmWikiTools({ goalDir: scopedGoal });
	const scopedSearch = scopedTools.find((tool) => tool.name === "wiki_search")!;
	assert.match(text(await scopedSearch.execute("whole-body", { query: "SCOPEDBODY731", topic_ref: "T1" })),
		/wiki\/models\/scoped-model\.md/u, "filtering a Topic searches the whole matching Page body");
	assert.match(text(await scopedSearch.execute("unassigned-global", { query: "UNASSIGNEDMARKER912" })),
		/wiki\/unassigned\.md/u, "unassigned Pages remain searchable without a Topic filter");
	assert.deepEqual(((await scopedSearch.execute("unassigned-scoped", {
		query: "UNASSIGNEDMARKER912", topic_ref: "T1",
	})).details as { results: unknown[] }).results, [], "a Topic filter excludes unassigned Pages");
	const frozenRoot = join(root, "frozen-topic-edition");
	cpSync(scopedRoot, frozenRoot, { recursive: true });
	const frozenList = createGoalLlmWikiTools({ goalDir: scopedGoal, knowledgeRoot: frozenRoot })
		.find((tool) => tool.name === "wiki_list_topics")!;
	const frozenCatalog = (await frozenList.execute("frozen-topics", {})).details;
	const revisedPlan = JSON.parse(readFileSync(join(scopedRoot, ".topic-plan.json"), "utf-8"));
	revisedPlan.topics.reverse();
	writeFileSync(join(scopedRoot, ".topic-plan.json"), JSON.stringify(revisedPlan));
	assert.deepEqual((await frozenList.execute("frozen-after-publication", {})).details, frozenCatalog,
		"a frozen Edition keeps its own Topic catalog after the published plan changes");
	const emptyGoal = join(root, "goal-empty");
	const emptyTools = createGoalLlmWikiTools({ goalDir: emptyGoal });
	assert.deepEqual((await emptyTools.find((tool) => tool.name === "wiki_list_topics")!
		.execute("empty-topics", {})).details, { topics: [] });

	assert.match(text(await searchA.execute("1", { query: "FireRedASR2S" })), /wiki\/models\/fireredasr2s\.md/u);
	assert.doesNotMatch(text(await searchA.execute("2", { query: "Voxtral" })), /Voxtral/u);
	assert.match(text(await searchB.execute("3", { query: "Voxtral" })), /wiki\/models\/voxtral\.md/u);
	assert.match(text(await readA.execute("4", { path: "models/fireredasr2s.md" })), /Linked to/u);
	assert.match(text(await graphA.execute("5", { query: "FireRedASR2S" })), /Automatic Speech Recognition/u);
	assert.match(text(await searchA.execute("5a", { query: "语音识别技术" })), /wiki\/topics\/语音识别\.md/u, "full-text terms match with OR, so an extra term does not hide a page");
	assert.match(text(await readA.execute("5b", { path: "topics/语音识别.md" })), /models\/fireredasr2s/u);
	assert.match(text(await graphA.execute("5c", { query: "语音识别" })), /FireRedASR2S/u);
	await assert.rejects(readA.execute("6", { path: "models/voxtral.md" }), /does not exist|ENOENT/u);
	for (const unusual of ['C++ "unbalanced: (quote', "AND OR NOT", "*"]) {
		await searchA.execute("6a", { query: unusual });
	}

	assert.equal(normalizeWikiPagePath("index.md"), "wiki/index.md");
	for (const unsafe of ["../secret.md", "wiki/../secret.md", "/etc/passwd", "C:\\secret.md", "%2e%2e/secret.md", "wiki/page.txt"]) {
		assert.throws(() => normalizeWikiPagePath(unsafe));
	}
	const aborted = new AbortController();
	aborted.abort();
	for (const tool of [listA, searchA, readA, graphA]) {
		await assert.rejects(tool.execute("aborted", tool.name === "wiki_read_page"
			? { path: "models/fireredasr2s.md" }
			: tool.name === "wiki_list_topics" ? {} : { query: "FireRedASR2S" }, aborted.signal), /abort/iu);
	}

	let embeddingCalls = 0;
	let failDocuments = false;
	let documentGate: Promise<void> | undefined;
	const documentInputs: string[] = [];
	const requestedDimensions: unknown[] = [];
	const knowledgeA = join(goalA, "wiki", "knowledge");
	const longTail = (finding: string) => ["# Long Tail Retrieval", "", "padding ".repeat(3_500), "## Final finding", finding].join("\n");
	writeFileSync(join(knowledgeA, "topics", "long-tail.md"), longTail("DISTINCTIVE-TAIL-731 appears only in the final chunk."));
	const fetchImpl: typeof fetch = async (_url, init) => {
		embeddingCalls += 1;
		const body = JSON.parse(String(init?.body)) as { input: string[]; input_type: string; dimensions?: unknown };
		requestedDimensions.push(body.dimensions);
		if (body.input_type === "search_document") {
			if (failDocuments) return new Response("down", { status: 500 });
			documentInputs.push(...body.input);
			await documentGate;
		}
		return new Response(JSON.stringify({ data: body.input.map((value, index) => ({
			index,
			embedding: /distinctive-tail-731/iu.test(value) ? [0, 1] : [1, 0],
		})) }), { status: 200 });
	};
	const embedding = async () => ({ identity: "test/embedding@2", model: "test/embedding", dimensions: 2, baseUrl: "http://embeddings.invalid/v1", apiKey: "test", fetchImpl });
	// A Wiki runtime reads one graph snapshot, so each read after a publication uses a new search, as requests do.
	const published = () => new GoalWikiSearch(knowledgeA, { goalDir: goalA, embedding });

	// Search never embeds pages: before the index exists it ranks with LanceDB full-text search and asks for a background refresh.
	const beforeIndex = await published().search("FireRedASR2S", 2);
	assert.equal(beforeIndex.mode, "keyword_graph");
	assert.equal(beforeIndex.index.status, "pending");
	assert.equal(beforeIndex.results[0]?.path, "wiki/models/fireredasr2s.md");
	assert.deepEqual(beforeIndex.results[0]?.sources, ["keyword"]);
	await scheduleWikiIndexRefresh(goalA, { embedding });
	assert.ok(requestedDimensions.every((value) => value === 2));
	assert.ok(embeddingCalls >= 2, "long pages must be embedded as multiple chunk batches");
	const callsAfterIndex = embeddingCalls;
	const documentsAfterIndex = documentInputs.length;
	const semantic = published();
	const ready = await semantic.search("FireRedASR2S", 2);
	assert.equal(ready.mode, "hybrid");
	assert.deepEqual(ready.index, { status: "ready", indexedPages: 4, totalPages: 4, refreshing: false });
	assert.equal(embeddingCalls, callsAfterIndex + 1, "a ready index embeds only the query");
	for (const result of ready.results) {
		assert.deepEqual(Object.keys(result).filter((key) => /score|rank/iu.test(key)), [], "search exposes order and signals, never scores");
	}
	const inTopic = await semantic.search("FireRedASR2S", 20, undefined, "topic-other");
	assert.deepEqual([...new Set(inTopic.results.map((result) => result.path))], ["wiki/topics/语音识别.md"], "a Topic filter applies to both LanceDB signals");
	const tail = await semantic.search("DISTINCTIVE-TAIL-731", 3);
	assert.equal(tail.results[0]?.path, "wiki/topics/long-tail.md");
	assert.deepEqual(tail.results[0]?.sources, ["keyword", "embedding"]);
	assert.equal((await semantic.search("zzqx-absent", 5)).tokenHits, 0, "full-text search only reports pages that contain a query term");
	assert.equal(documentInputs.length, documentsAfterIndex, "topic filters and repeated searches never re-embed pages");
	assert.ok(existsSync(wikiIndexPath(goalA)), "chunk embeddings are stored in the Goal's single LanceDB index");
	assert.equal(existsSync(join(goalA, ".wiki")), false, "the index stays outside the Goal workspace");

	// A published change leaves the page out of vector retrieval until its refresh lands, while a snapshot taken
	// before the change still matches the previous vectors. A second change supersedes the running refresh.
	const snapshot = join(root, "snapshot", "knowledge");
	cpSync(knowledgeA, snapshot, { recursive: true });
	const snapshotSearch = new GoalWikiSearch(snapshot, { goalDir: goalA, embedding });
	await assert.rejects(snapshotSearch.refreshEmbeddings(), /Only the published Goal Wiki/u);
	let releaseDocuments!: () => void;
	documentGate = new Promise((resolve) => { releaseDocuments = resolve; });
	documentInputs.length = 0;
	writeFileSync(join(knowledgeA, "topics", "long-tail.md"), longTail("DISTINCTIVE-TAIL-731 now closes a rewritten page."));
	const partial = await published().search("DISTINCTIVE-TAIL-731", 3);
	assert.equal(partial.index.status, "partial");
	assert.equal(partial.index.indexedPages, 3);
	assert.equal(partial.index.refreshing, true);
	const changedHit = partial.results.find((result) => result.path === "wiki/topics/long-tail.md");
	assert.ok(changedHit, "the changed page stays findable by full-text search");
	assert.deepEqual(changedHit.sources, ["keyword"], "a changed page never serves its stale vectors");
	const fromSnapshot = await snapshotSearch.search("DISTINCTIVE-TAIL-731", 3);
	assert.equal(fromSnapshot.index.status, "ready");
	assert.equal(fromSnapshot.results[0]?.path, "wiki/topics/long-tail.md");
	assert.deepEqual(fromSnapshot.results[0]?.sources, ["keyword", "embedding"]);
	writeFileSync(join(knowledgeA, "topics", "asr.md"), "---\nprimary_topic_ref: topic-asr\ntopic_refs: [topic-asr]\n---\n\n# Automatic Speech Recognition\n\nRevised.\n");
	const refreshing = scheduleWikiIndexRefresh(goalA, { embedding, immediate: true });
	releaseDocuments();
	documentGate = undefined;
	await refreshing;
	const refreshed = await published().search("DISTINCTIVE-TAIL-731", 3);
	assert.equal(refreshed.index.status, "ready");
	assert.equal(refreshed.results[0]?.path, "wiki/topics/long-tail.md");
	assert.deepEqual(refreshed.results[0]?.sources, ["keyword", "embedding"]);
	assert.ok(documentInputs.some((value) => value.includes("Revised.")), "the superseding change joins the same refresh");
	assert.equal(documentInputs.some((value) => value.startsWith("FireRedASR2S\n")), false, "unchanged pages are not re-embedded");

	// Embedding failures keep full-text search available and back off; a new publication retries at once.
	const semanticB = () => new GoalWikiSearch(join(goalB, "wiki", "knowledge"), { goalDir: goalB, embedding });
	failDocuments = true;
	await scheduleWikiIndexRefresh(goalB, { embedding, immediate: true });
	const degraded = await semanticB().search("Voxtral", 3);
	assert.equal(degraded.mode, "keyword_graph");
	assert.equal(degraded.index.status, "pending");
	assert.match(degraded.index.error ?? "", /HTTP 500/u);
	assert.equal(degraded.results[0]?.path, "wiki/models/voxtral.md");
	const callsDuringBackoff = embeddingCalls;
	await scheduleWikiIndexRefresh(goalB, { embedding });
	assert.equal(embeddingCalls, callsDuringBackoff, "a failed refresh waits for its backoff");
	failDocuments = false;
	await scheduleWikiIndexRefresh(goalB, { embedding, immediate: true });
	assert.deepEqual((await semanticB().search("Voxtral", 3)).index, { status: "ready", indexedPages: 3, totalPages: 3, refreshing: false });

	writeFileSync(join(goalA, "wiki", "knowledge", "topics", "too-large.md"), "x".repeat(2 * 1024 * 1024 + 1));
	await assert.rejects(readA.execute("too-large", { path: "topics/too-large.md" }), /too large/u);
	console.log("Goal-scoped LLM Wiki tools tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => item.text ?? "").join("\n");
}

function goal(root: string, name: string, slug: string, model: string): string {
	const directory = join(root, name);
	mkdirSync(join(directory, "wiki", "knowledge", "models"), { recursive: true });
	mkdirSync(join(directory, "wiki", "knowledge", "topics"), { recursive: true });
	writeFileSync(join(directory, "wiki", "knowledge", "models", `${slug}.md`), [
		"---", `title: ${model}`, "type: Model", "tags: [asr]", "primary_topic_ref: topic-asr", "topic_refs: [topic-asr]", "---", "", `# ${model}`, "",
		"Linked to [Automatic Speech Recognition](../topics/asr.md). See [语音识别](../topics/语音识别.md).",
	].join("\n"));
	writeFileSync(join(directory, "wiki", "knowledge", "topics", "asr.md"), "---\nprimary_topic_ref: topic-asr\ntopic_refs: [topic-asr]\n---\n\n# Automatic Speech Recognition\n");
	writeFileSync(join(directory, "wiki", "knowledge", "topics", "语音识别.md"), "---\nprimary_topic_ref: topic-other\ntopic_refs: [topic-other]\n---\n\n# 语音识别\n\n语音识别系统将语音转换为文本。\n");
	writeFileSync(join(directory, "wiki", "knowledge", ".topic-plan.json"), JSON.stringify({
		schema_version: 1, goal_id: name, revision: "a".repeat(64), status: "active",
		topics: [
			{ id: "topic-asr", title: `${model} speech`, intent: "Track speech recognition.",
				questions: ["Which languages are supported?"], include: ["ASR"], exclude: ["Marketing"] },
			{ id: "topic-other", title: "Other speech", intent: "Other speech material.", questions: [], include: [], exclude: [] },
			{ id: "topic-empty", title: "Empty topic", intent: "No published pages yet.", questions: [], include: [], exclude: [] },
		],
	}));
	return directory;
}
