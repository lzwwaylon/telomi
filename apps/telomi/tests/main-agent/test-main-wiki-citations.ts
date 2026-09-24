import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveMessageCitationSourcePreview } from "../../server/citations/preview.js";
import { MainWikiCitationSession } from "../../server/main-agent/wiki-citations.js";
import { compileStandaloneCitationMarkdown } from "../../server/research/pipeline/citation-compiler.js";

const wiki = {
	ref: "C1",
	page: {
		ref: "P1",
		path: "wiki/entities/paper.md",
		title: "Paper",
		type: "entity",
		content: "Grounded Wiki Page.",
	},
	entry: {
		id: "entry:paper",
		index: 1,
		section: "Evidence",
		cue: "Finding",
		note: "The finding is grounded.",
		source: { id: "source:paper", title: "Paper source", url: "https://example.test/paper" },
		anchors: [{
			path: "paper.md", startLine: 2, endLine: 3, format: "markdown" as const,
			content: "Exact evidence.", assets: [],
		}],
	},
	evidence: [],
};

const compiled = compileStandaloneCitationMarkdown({
	markdown: "The finding is grounded. <cite>C1</cite> It is repeated. <cite>C1</cite>",
	citationRegistry: {
		schemaVersion: 1,
		knowledgeSha256: "a".repeat(64),
		entries: [{
			ref: "C1",
			url: "https://example.test/paper",
			title: "Paper source",
			provenance: "source:paper",
			fileRefs: ["wiki/entities/paper.md"],
			evidenceId: "source:paper",
			wiki,
		}],
	},
});

assert.equal(compiled.citationCount, 2);
assert.equal(compiled.citations.length, 1);
assert.deepEqual(compiled.citations[0]?.refs, ["C1"]);
assert.deepEqual(compiled.citations[0]?.wiki, [wiki]);
assert.equal(compiled.markdown, [
	"The finding is grounded. [[1]](https://example.test/paper) It is repeated. [[1]](https://example.test/paper)",
	"",
	"## References",
	"",
	"1. [Paper source](https://example.test/paper)",
	"",
].join("\n"));

assert.throws(() => compileStandaloneCitationMarkdown({
	markdown: "Unsupported. <cite>C2</cite>",
	citationRegistry: compiledRegistry(),
}), /not present in the frozen Knowledge Snapshot/u);

const workspace = mkdtempSync(join(tmpdir(), "telomi-main-wiki-citations-"));
try {
	const goalId = "goal-main-wiki";
	const goalDir = join(workspace, goalId);
	const knowledgeRoot = join(goalDir, "wiki", "knowledge");
	const sourceSequence = join(goalDir, "wiki", "runs", "run-001", "artifacts", "find-out-sources", "sequence-001");
	mkdirSync(join(knowledgeRoot, "entities"), { recursive: true });
	mkdirSync(join(sourceSequence, "sources", "paper", "members", "web"), { recursive: true });
	writeFileSync(join(sourceSequence, "manifest.json"), JSON.stringify({
		sources: [{
			source_id: "source:paper",
			title: "Paper source",
			path: "sources/paper",
			members: [{
				source_id: "source:paper-member",
				title: "Paper source",
				canonical_locator: "https://example.test/paper",
				path: "members/web",
			}],
		}],
	}));
	writeFileSync(join(sourceSequence, "sources", "paper", "members", "web", "paper.md"), "Exact evidence.\n");
	writeFileSync(join(knowledgeRoot, ".topic-plan.json"), JSON.stringify({ revision: "topic:test" }));
	writeFileSync(join(knowledgeRoot, ".note-registry.json"), JSON.stringify({
		entries: [{
			id: "entry:paper",
			revisionSha256: "b".repeat(64),
			sourceRunId: "run-001",
			sourceId: "source:paper",
			sourceTitle: "Paper source",
			canonicalLocator: "https://example.test/paper",
			members: [{ source_id: "source:paper", provider_id: "web", title: "Paper source", canonical_locator: "https://example.test/paper" }],
			section: "Evidence",
			cue: "Finding",
			detail: "The finding is grounded.",
			anchors: [],
		}, {
			id: "entry:paper-limit",
			revisionSha256: "c".repeat(64),
			sourceRunId: "run-001",
			sourceId: "source:paper",
			sourceTitle: "Paper source",
			canonicalLocator: "https://example.test/paper",
			members: [{ source_id: "source:paper", provider_id: "web", title: "Paper source", canonical_locator: "https://example.test/paper" }],
			section: "Limits",
			cue: "Limitation",
			detail: "The second Evidence remains pageable.",
			anchors: [],
		}],
	}));
	writeFileSync(join(knowledgeRoot, "entities", "paper.md"), [
		"---",
		"type: entity",
		"title: Paper",
		"description: Grounded paper finding",
		"entry_ids:",
		"  - entry:paper",
		"  - entry:paper-limit",
		"---",
		"",
		"# Paper",
		"",
		"The finding is grounded.",
	].join("\n"));

	const session = new MainWikiCitationSession({
		goalDir,
		goalId,
		workspaceDir: workspace,
		getEnv: () => ({ TELOMI_WIKI_EMBEDDING_ENABLED: "false" }),
	});
	session.beginTurn();
	const search = session.tools.find((tool) => tool.name === "wiki_search")!;
	const searchResult = await search.execute("search", { query: "grounded paper" });
	assert.match(JSON.stringify(searchResult.details), /"page_ref":"P1"/u);
	assert.doesNotMatch(JSON.stringify(searchResult.details), /wiki\/entities\/paper/u);
	const read = session.tools.find((tool) => tool.name === "wiki_read_page")!;
	const readResult = await read.execute("read", { path: "P1" });
	assert.match(JSON.stringify(readResult.details), /"cite_ref":"C1"/u);

	const message = {
		role: "assistant",
		timestamp: 1_788_000_000_000,
		content: [{ type: "text", text: "The finding is grounded. <cite>C1</cite>" }],
	};
	assert.equal(await session.compileMessage(message), true);
	assert.match(message.content[0]!.text, /\[\[1\]\]\(https:\/\/example\.test\/paper\)/u);
	assert.match(message.content[0]!.text, /## References/u);
	assert.match(message.citationMessageId, /^wiki_[a-f0-9]{20}$/u);
	const preview = resolveMessageCitationSourcePreview(
		goalDir,
		message.citationMessageId,
		"https://example.test/paper",
		1,
	);
	assert.equal(preview?.clues[0]?.page?.ref, "P1");
	assert.equal(preview?.clues[0]?.note, "The finding is grounded.");
	assert.equal(preview?.clues.length, 1, "a C ref must preview only its exact Wiki Evidence");

	const sameSource = {
		role: "assistant",
		timestamp: 1_788_000_000_001,
		content: [{ type: "text", text: "The finding is grounded. <cite>C1</cite> A limit remains. <cite>C2</cite>" }],
	};
	assert.equal(await session.compileMessage(sameSource), true);
	assert.equal(sameSource.content[0]!.text, [
		"The finding is grounded. [[1]](https://example.test/paper) A limit remains. [[1]](https://example.test/paper)",
		"",
		"## References",
		"",
		"1. [Paper source](https://example.test/paper)",
		"",
	].join("\n"), "two Wiki Evidence refs from one Source share one number and one References entry");
	const merged = resolveMessageCitationSourcePreview(goalDir, sameSource.citationMessageId, "https://example.test/paper", 1);
	assert.deepEqual(merged?.clues.map((clue) => clue.cue), ["Finding", "Limitation"],
		"the shared number previews every cited Evidence of that Source");
} finally {
	rmSync(workspace, { recursive: true, force: true });
}

console.log("Main Wiki citation compiler passed");

function compiledRegistry() {
	return {
		schemaVersion: 1 as const,
		knowledgeSha256: "a".repeat(64),
		entries: [],
	};
}
