import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveMessageCitationSourcePreview } from "../../server/citations/preview.js";
import { MainWikiCitationSession } from "../../server/main-agent/wiki-citations.js";
import { compileStandaloneCitationMarkdown } from "../../server/research/pipeline/citation-compiler.js";
import { sha256 } from "../../server/lib/hash.js";
import { createInvestigationCitationScope } from "../../server/research/investigation-citations.js";
import { writeWikiMessageCitations } from "../../server/citations/wiki-message-store.js";

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

const distinctCues = compileStandaloneCitationMarkdown({
	markdown: "First. <cite>deep-search:run1:cue-1</cite> Second. <cite>deep-search:run1:cue-2</cite>",
	citationRegistry: {
		schemaVersion: 1,
		knowledgeSha256: "",
		entries: [1, 2].map((index) => ({
			ref: `deep-search:run1:cue-${index}`,
			numberKey: `deep-search:run1:cue-${index}`,
			url: "",
			title: `Cue ${index}`,
			provenance: "source:paper",
			fileRefs: ["paper.md"],
		})),
	},
});
assert.deepEqual(distinctCues.citations.map((item) => [item.number, item.refs, item.url]), [
	[1, ["deep-search:run1:cue-1"], undefined],
	[2, ["deep-search:run1:cue-2"], undefined],
], "distinct Cue refs must keep distinct preview numbers even when the Source is shared");
assert.match(distinctCues.markdown, /First\. \[\[1\]\] Second\. \[\[2\]\]/u);

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
			revision_sha256: "d".repeat(64),
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

	const multiRefMessage = { role: "assistant", timestamp: 1_788_000_000_011,
		content: [{ type: "text", text: "Both findings. <cite> C1, C2, C1 </cite>" }] };
	assert.equal(await session.compileMessage(multiRefMessage), true);
	assert.match(multiRefMessage.content[0]!.text, /^Both findings\. \[\[1\]\]\(https:\/\/example\.test\/paper\)\n/u);
	const groupedPreview = resolveMessageCitationSourcePreview(goalDir, multiRefMessage.citationMessageId, "https://example.test/paper", 1);
	assert.deepEqual(groupedPreview?.clues.map(clue => clue.cue), ["Finding", "Limitation"], "grouped chat cites hydrate and retain both Wiki Evidence anchors");
	await assert.rejects(session.compileMessage({ role: "assistant", content: "Bad. <cite>C1,C99</cite>" }), /C99/u);
	for (const malformed of ["<cite C1>C1</cite>", "</cite>", "<cite>C1"]) {
		await assert.rejects(session.compileMessage({ role: "assistant", content: malformed }), /malformed.*citation/iu);
	}

	const deepSearchDir = join(goalDir, "artifacts", "deep-search");
	mkdirSync(deepSearchDir, { recursive: true });
	const deepRef = "deep-search:run1:cue-1";
	writeFileSync(join(deepSearchDir, "run1.json"), JSON.stringify({
		schema_version: 1,
		question: "What does the paper say?",
		status: "found",
		summary: "Exact evidence.",
		gaps: [],
		cues: [{
			ref: deepRef,
			section_title: "Evidence",
			cue: "Exact finding",
			note: "The paper has exact evidence.",
			evidence: [{
				source_run_id: "run-001",
				source_id: "source:paper",
				source_revision_sha256: "d".repeat(64),
				source_path: "members/web/paper.md",
				start_line: 1,
				end_line: 1,
				content_sha256: sha256("Exact evidence.\n"),
			}],
		}],
	}));
	const shortCitations = createInvestigationCitationScope();
	assert.equal(shortCitations.projectCues([{
		ref: deepRef, section_title: "Evidence", cue: "Exact finding", note: "The paper has exact evidence.",
		evidence: [{ source_path: "members/web/paper.md", start_line: 1, end_line: 1 }],
	}])[0]?.ref, "N1");
	shortCitations.allowWikiRef("C1");
	const deepMessage = {
		role: "assistant",
		timestamp: 1_788_000_000_002,
		content: [{ type: "text", text: shortCitations.restore({
			answer: "The paper has exact evidence. <cite>N1</cite>", citation_refs: ["N1"],
		}).answer }],
	};
	assert.equal(await session.compileMessage(deepMessage), true);
	assert.match(deepMessage.content[0]!.text, /\[\[1\]\]/u);
	assert.match(deepMessage.content[0]!.text, /\[\[1\]\]\(https:\/\/example\.test\/paper\)/u);
	const deepPreview = resolveMessageCitationSourcePreview(goalDir, deepMessage.citationMessageId, "https://example.test/paper", 1);
	assert.equal(deepPreview?.clues[0]?.cue, "Exact finding");
	assert.deepEqual(deepPreview?.clues[0]?.excerpts, [{
		path: "members/web/paper.md",
		startLine: 1,
		endLine: 1,
		text: "Exact evidence.",
		sourceId: "source:paper",
		sourceRevisionSha256: "d".repeat(64),
		sourceRunId: "run-001",
		contentSha256: sha256("Exact evidence.\n"),
	}]);
	assert.equal(resolveMessageCitationSourcePreview(goalDir, deepMessage.citationMessageId, "", 2), null);
	writeWikiMessageCitations(goalDir, { schemaVersion: 1, goalId, messageId: "legacy-cue-message",
		wikiRevision: "", knowledgeSha256: "", citations: [{ number: 1, title: "Exact finding", refs: [deepRef] }] });
	assert.equal(resolveMessageCitationSourcePreview(goalDir, "legacy-cue-message", "", 1)?.clues[0]?.cue,
		"Exact finding", "old number-only chat citations still resolve their exact Cue");
	const mixedMessage = {
		role: "assistant",
		timestamp: 1_788_000_000_003,
		content: [{ type: "text", text: shortCitations.restore({
			answer: "Wiki context <cite>C1</cite>; original detail <cite>N1</cite>.", citation_refs: ["C1", "N1"],
		}).answer }],
	};
	assert.equal(await session.compileMessage(mixedMessage), true);
	assert.match(mixedMessage.content[0]!.text, /Wiki context \[\[1\]\]\(https:\/\/example\.test\/paper\); original detail \[\[1\]\]/u);
	assert.deepEqual(resolveMessageCitationSourcePreview(goalDir, mixedMessage.citationMessageId,
		"https://example.test/paper", 1)?.clues.map((clue) => clue.cue), ["Finding", "Exact finding"],
		"Wiki and original Cue evidence under one Source number both remain in the preview");
	const sourceManifestPath = join(sourceSequence, "manifest.json");
	const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf-8"));
	sourceManifest.sources[0].members.push({ source_id: "source:other", title: "Other source",
		canonical_locator: "https://example.test/other#section", path: "members/other" });
	writeFileSync(sourceManifestPath, JSON.stringify(sourceManifest));
	mkdirSync(join(sourceSequence, "sources/paper/members/other"), { recursive: true });
	writeFileSync(join(sourceSequence, "sources/paper/members/other/paper.md"), "Other evidence.\n");
	const saved = JSON.parse(readFileSync(join(deepSearchDir, "run1.json"), "utf-8"));
	const firstCue = saved.cues[0];
	saved.cues.push({ ...firstCue, ref: "deep-search:run1:cue-2", cue: "Second exact finding" },
		{ ...firstCue, ref: "deep-search:run1:cue-3", cue: "Cross-source finding", evidence: [...firstCue.evidence,
			{ ...firstCue.evidence[0], source_path: "members/other/paper.md", content_sha256: sha256("Other evidence.\n") }] },
		{ ...firstCue, ref: "deep-search:run1:cue-4", cue: "Uncited finding" });
	writeFileSync(join(deepSearchDir, "run1.json"), JSON.stringify(saved));
	const groupedMessage = { role: "assistant", timestamp: 1_788_000_000_004,
		content: [{ type: "text", text: saved.cues.slice(0, 3).map((cue: { ref: string }) => `Finding <cite>${cue.ref}</cite>.`).join(" ") }] };
	await session.compileMessage(groupedMessage);
	assert.deepEqual([...groupedMessage.content[0]!.text.matchAll(/^\d+\. \[([^\]]+)\]\(([^)]+)\)$/gmu)].map(match => [match[1], match[2]]),
		[["Paper source", "https://example.test/paper"], ["Other source", "https://example.test/other"]],
		"three Cues over two Source URLs create two source-titled References, including both Sources of one Cue");
	assert.deepEqual(resolveMessageCitationSourcePreview(goalDir, groupedMessage.citationMessageId,
		"https://example.test/paper", 1)?.clues.map(clue => clue.cue),
		["Exact finding", "Second exact finding", "Cross-source finding"]);
	assert.equal(resolveMessageCitationSourcePreview(goalDir, groupedMessage.citationMessageId,
		"https://example.test/other", 2)?.clues[0]?.cue, "Cross-source finding");
	sourceManifest.sources[0].members[0].canonical_locator = "";
	writeFileSync(sourceManifestPath, JSON.stringify(sourceManifest));
	const localMessage = { role: "assistant", timestamp: 1_788_000_000_005,
		content: [{ type: "text", text: `<cite>${deepRef}</cite> and <cite>deep-search:run1:cue-2</cite>` }] };
	await session.compileMessage(localMessage);
	assert.match(localMessage.content[0]!.text, /\[\[1\]\] and \[\[2\]\]/u,
		"Cues without Source URLs retain separate exact citation numbers");
	assert.equal(resolveMessageCitationSourcePreview(goalDir, localMessage.citationMessageId, "", 2)?.clues[0]?.cue,
		"Second exact finding");
	sourceManifest.sources[0].members[0].canonical_locator = "https://example.test/paper";
	writeFileSync(sourceManifestPath, JSON.stringify(sourceManifest));
	writeFileSync(join(sourceSequence, "sources", "paper", "members", "web", "paper.md"), "Changed evidence.\n");
	assert.throws(() => resolveMessageCitationSourcePreview(goalDir, deepMessage.citationMessageId, "https://example.test/paper", 1),
		/Note Reading evidence changed/u);
	const localRegistryPath = join(knowledgeRoot, ".note-registry.json");
	const localRegistry = JSON.parse(readFileSync(localRegistryPath, "utf-8"));
	localRegistry.entries.forEach((entry: { sourceId: string; canonicalLocator: string }, index: number) => {
		entry.sourceId = `source:local-${index}`;
		entry.canonicalLocator = `file:///saved/local-${index}.md`;
	});
	writeFileSync(localRegistryPath, JSON.stringify(localRegistry));
	session.beginTurn();
	const localWikiMessage = { role: "assistant", timestamp: 1_788_000_000_006,
		content: [{ type: "text", text: "First local Source <cite>C1</cite>. Second local Source <cite>C2</cite>." }] };
	await session.compileMessage(localWikiMessage);
	assert.match(localWikiMessage.content[0]!.text, /First local Source \[\[1\]\]\. Second local Source \[\[2\]\]/u,
		"different local Wiki Sources retain separate numbers without becoming file links");
	assert.equal(localWikiMessage.content[0]!.text.includes("file:///"), false);
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
