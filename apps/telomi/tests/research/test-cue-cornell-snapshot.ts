import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";

import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { validateCornellNoteArtifact, validateCornellNotesSnapshot } from "../../server/cornell/contracts.js";
import { sha256 } from "../../server/lib/hash.js";
import { createCueCornellSnapshot, createGoalCornellSnapshot } from "../../server/research/cue-cornell-snapshot.js";
import { listSavedNoteCues, resolveSavedNoteCue } from "../../server/research/note-retrieval.js";
import { noteWikiEntries } from "../../server/wiki/note-wiki-maintainer.js";
import { NoteFirstWikiCompiler } from "../../server/wiki/note-first-compiler.js";
import type { NoteFirstInput, NoteFirstOutcome, NoteFirstResult } from "../../server/wiki/note-first-contract.js";
import { readWikiPageEvidence } from "../../server/wiki/evidence.js";
import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { createWikiRouter } from "../../server/wiki/api.js";
import type { GoalService } from "../../server/goals/service.js";
import { createGoalLlmWikiTools } from "../../server/wiki/tools.js";
import { createWikiReferenceAdapterFromRoot } from "../../server/research/pipeline/wiki-report-references.js";
import { resolveCitationSourcePreview } from "../../server/citations/preview.js";

const root = mkdtempSync(join(tmpdir(), "cue-cornell-snapshot-"));
try {
	const goalDir = join(root, "goal");
	ensureGoalWorkspace({ goalDir, goalId: "goal", title: "Reference protocols" });
	const anchors = ["run-a", "run-b"].map((runId, index) => {
		const sequence = join(goalDir, "wiki", "runs", runId, "artifacts", "find-out-sources", "sequence-1");
		const sourceRoot = join(sequence, "sources", "shared");
		mkdirSync(join(sourceRoot, "members", "article"), { recursive: true });
		mkdirSync(join(sourceRoot, "members", "a-decoy"), { recursive: true });
		writeFileSync(join(sourceRoot, "members", "a-decoy", "document.md"), "A different member document, not the cited evidence.\n");
		const text = index === 0 ? "Protocol A requires consent.\n" : "Protocol B requires consent and attribution.\n";
		writeFileSync(join(sourceRoot, "members", "article", "document.md"), text);
		const revision = sha256(`revision-${runId}`);
		writeFileSync(join(sequence, "manifest.json"), JSON.stringify({ sources: [{ source_id: "source:shared",
			revision_sha256: revision, title: `Protocol ${runId}`, path: "sources/shared", members: [{
				source_id: `source:member-${runId}`, provider_id: "browser", title: `Original ${runId}`,
				canonical_locator: `https://example.test/${runId}`, path: "members/article",
			}] }] }));
		const bundle = join(goalDir, "wiki", "runs", runId, "artifacts", "source-bundles", "browser", "attempt-1");
		mkdirSync(join(bundle, "sources", "0001", "assets"), { recursive: true });
		writeFileSync(join(bundle, "source-index.json"), JSON.stringify({ sources: [{ source_id: `source:member-${runId}`, path: "sources/0001" }] }));
		writeFileSync(join(bundle, "sources", "0001", "assets", "figure.png"), Buffer.from([137, 80, 78, index]));
		return { source_run_id: runId, source_id: "source:shared", source_revision_sha256: revision,
			source_path: "members/article/document.md", start_line: 1, end_line: 1, content_sha256: sha256(text), excerpt: text.trim() };
	});
	const original = { schema_version: 1, question: "Compare reference protocols", status: "partial",
		summary: "Both require consent; attribution differs.", gaps: ["No licensing conclusion."], cues: [{
			ref: "deep-search:read-one:cue-1", section_title: "Comparison", cue: "Reference consent and attribution",
			note: "Both require consent; only B requires attribution.", evidence: anchors,
		}, { ref: "deep-search:read-one:cue-2", section_title: "Protocol B", cue: "B attribution",
			note: "B requires attribution.", evidence: [anchors[1]] }] };
	const artifactPath = "artifacts/deep-search/read-one.json";
	mkdirSync(join(goalDir, "artifacts", "deep-search"), { recursive: true });
	const bytes = `${JSON.stringify(original)}\n`;
	writeFileSync(join(goalDir, artifactPath), bytes);
	const artifact = { path: artifactPath, sha256: sha256(bytes) };
	const snapshot = createCueCornellSnapshot({ goalDir, artifactRefs: [artifact, artifact], snapshotId: "cue-batch-one" });
	assert.equal(snapshot.notes.length, 2, "equal Source IDs in distinct original Runs remain separate Notes");
	assert.equal(snapshot.notes[0]?.source_run_id, "run-a");
	assert.equal(snapshot.notes[1]?.source_run_id, "run-b");
	assert.equal(snapshot.notes[0]?.note.sections[0]?.cue_notes[0]?.evidence.length, 2, "cross-Source reasoning stays one complete Cue");
	const entries = noteWikiEntries(snapshot);
	assert.deepEqual(entries.map(entry => entry.originCueRef), original.cues.map(cue => cue.ref));
	assert.deepEqual(entries[0]?.anchors.map(anchor => anchor.sourceRunId), ["run-a", "run-b"]);
	assert.deepEqual(noteWikiEntries(createCueCornellSnapshot({ goalDir, artifactRefs: [artifact], snapshotId: "different-batch" })), entries,
		"batch identity and repeated registration cannot change Cue Entry identities or revisions");
	assert.throws(() => createCueCornellSnapshot({ goalDir, artifactRefs: [{ ...artifact, sha256: "0".repeat(64) }], snapshotId: "bad" }), /input changed/u);
	assert.throws(() => createCueCornellSnapshot({ goalDir, artifactRefs: [{ ...artifact, path: "../read-one.json" }], snapshotId: "bad" }), /artifact ref/u);
	const broken = structuredClone(snapshot);
	delete broken.notes[0]!.note.sections[0]!.cue_notes[0]!.evidence[0]!.source_id;
	assert.throws(() => validateCornellNotesSnapshot(broken), /Source identity/u);
	assert.throws(() => validateCornellNoteArtifact(snapshot.notes[0]!.note), /Runtime-owned/u,
		"Reader artifacts cannot forge Runtime-only original Cue identities");

	const seenObjects: NoteFirstInput[] = [];
	const compiler = new NoteFirstWikiCompiler({ runStage: async ({ input }): Promise<NoteFirstOutcome> => {
		let result: NoteFirstResult;
		const pages = { pages: [], retained_refs: [], discarded_refs: [], deferred_entries: [], relations: [] };
		if (input.stage === "objects") {
			seenObjects.push(input);
			assert.equal(input.entries.length, 1, "a worker must not mix the same Source ID from different Runs");
			const entry = input.entries[0]!;
			result = { kind: "pages", consideredPages: [], value: { ...pages, pages: [{ id: `entity:${entry.sourceRunId}`,
				kind: "entity", title: entry.sourceTitle, description: "Verified reference requirements",
				body: `## Requirements\n${entry.detail} [[${entry.id}]]`, member_refs: [] }] } };
		} else if (input.stage === "merge-objects") {
			result = { kind: "pages", consideredPages: [], value: { ...pages,
				pages: input.pages.filter(page => page.role === "member").map(page => ({ ...page.page, member_refs: [page.ref] })) } };
		} else if (input.stage === "plan-concepts") {
			result = { kind: "concept-plan", jobs: [], objectOnly: input.requiredPages.map(pageRef => ({ pageRef,
				comparedWith: [], reason: "Protocol-specific statements remain in objects." })) };
		} else if (input.stage === "page-topics") {
			result = { kind: "page-topics", sections: input.sections.map(section => ({ sectionRef: section.ref,
				matches: [{ topicId: "references", reason: "Reference protocol requirements." }] })) };
		} else throw new Error(`Unexpected stage ${input.stage}`);
		return { result, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, sessionPaths: [] };
	} });
	const batchRoot = join(goalDir, "wiki", "cue-batches", snapshot.snapshot_id);
	const store = new RunArtifactStore(batchRoot), frozen = store.publishText(JSON.stringify(snapshot), "artifacts/input/cornell-notes.json");
	const compiled = await compiler.compile({ goalDir, runId: snapshot.snapshot_id, runDirectory: batchRoot,
		controlDirectory: join(root, "control"), cornellNotesSnapshot: { relative_path: frozen.relativePath, sha256: frozen.sha256, byte_length: frozen.byteLength },
		goalContext: { title: "Reference protocols", description: "Compare reference protocol requirements" },
		topicPlan: { schema_version: 1, goal_id: "goal", revision: "topics-v1", status: "active", topics: [{ id: "references",
			title: "References", intent: "Reference protocol requirements", questions: [], include: [], exclude: [] }] },
		env: { TELOMI_WIKI_MAINTAINER_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child", TELOMI_WIKI_MAINTAINER_THINKING_LEVEL: "low" },
		signal: new AbortController().signal });
	assert.equal(compiled.publicationReady, true);
	assert.equal(seenObjects.length, 2);
	assert.equal(new Set(seenObjects.map(input => input.key)).size, 2, "per-Run Note workers have separate durable task keys");
	const knowledge = compiled.knowledge.absolutePath;
	const evidence = readWikiPageEvidence(knowledge, { entry_ids: [entries[0]!.id] }, goalDir);
	assert.deepEqual(evidence[0]?.anchors.map(anchor => anchor.content), anchors.map(anchor => anchor.excerpt));
	assert.deepEqual(evidence[0]?.anchors.map(anchor => anchor.source?.runId), ["run-a", "run-b"]);
	assert.deepEqual(evidence[0]?.anchors.map(anchor => anchor.source?.revisionSha256), anchors.map(anchor => anchor.source_revision_sha256));
	const saved = listSavedNoteCues(knowledge);
	assert.deepEqual(saved.map(cue => cue.ref), original.cues.map(cue => cue.ref));
	assert.equal(saved[0]?.wiki_entry_id, entries[0]!.id);
	const adapter = createWikiReferenceAdapterFromRoot(knowledge, createGoalLlmWikiTools({ goalDir, knowledgeRoot: knowledge }));
	const pageTool = adapter.tools.find(tool => tool.name === "wiki_read_page")!;
	await pageTool.execute("read-cross-source-wiki", { path: adapter.pageRefs[0]! });
	const frozenWiki = adapter.resolveCitationRef("C1");
	assert.deepEqual(frozenWiki.entry.anchors.map(anchor => anchor.source?.runId), ["run-a", "run-b"],
		"Wiki Tool and short citation refs retain all per-anchor Source identity");
	const report = join(root, "frozen-report");
	mkdirSync(report, { recursive: true });
	writeFileSync(join(report, "final.md"), "# Frozen Wiki answer\n");
	writeFileSync(join(report, "final.json"), JSON.stringify({ citations: [{ number: 1, url: frozenWiki.entry.source.url,
		title: frozenWiki.entry.source.title, refs: ["C1"], wiki: [frozenWiki] }] }));
	const preview = resolveCitationSourcePreview(join(report, "final.md"), frozenWiki.entry.source.url, 1);
	assert.deepEqual(preview?.clues[0]?.excerpts.map(excerpt => excerpt.sourceRunId), ["run-a", "run-b"]);
	assert.deepEqual(preview?.clues[0]?.excerpts.map(excerpt => excerpt.sourceRevisionSha256), anchors.map(anchor => anchor.source_revision_sha256));
	assert.deepEqual(preview?.clues[0]?.excerpts.map(excerpt => excerpt.contentSha256), anchors.map(anchor => anchor.content_sha256));
	assert.deepEqual(resolveSavedNoteCue(goalDir, saved[0]!.ref)?.evidence.map(anchor => anchor.source_run_id), ["run-a", "run-b"]);
	assert.equal(readFileSync(join(goalDir, artifactPath), "utf8"), bytes, "Wiki import never rewrites the original Cue artifact");
	const legacyRecord = structuredClone(snapshot.notes[0]!);
	delete legacyRecord.source_run_id;
	legacyRecord.note.sections = [{ section_title: "Legacy protocol", summary: "Saved before the investigation.", cue_notes: [{
		cue: "A consent", note: "A requires consent.", evidence: [{ source_path: anchors[0]!.source_path,
			start_line: 1, end_line: 1, content_sha256: anchors[0]!.content_sha256 }],
	}] }];
	const legacy = { ...snapshot, snapshot_id: "legacy-snapshot", run_id: "run-a", notes: [legacyRecord] };
	const notesRoot = join(goalDir, "wiki", "runs", "run-a", "artifacts", "cornell-notes");
	mkdirSync(notesRoot, { recursive: true });
	writeFileSync(join(notesRoot, "snapshot-1.json"), JSON.stringify({ ...legacy, notes: [] }));
	writeFileSync(join(notesRoot, "snapshot-2.json"), JSON.stringify(legacy));
	const corpus = createGoalCornellSnapshot({ goalDir, snapshotId: "rebuild-corpus" });
	assert.equal(corpus.notes.length, 2);
	assert.equal(noteWikiEntries(corpus).length, 3, "rebuild includes old Cornell Cues and all saved Deep Search Cues");
	assert.deepEqual(noteWikiEntries(corpus)[0], noteWikiEntries(legacy)[0], "adding per-record Run identity and new sections preserves legacy Entry identity and revision");
	assert.deepEqual(noteWikiEntries(corpus).slice(1).map(entry => entry.originCueRef), original.cues.map(cue => cue.ref));
	assert.match(readFileSync(join(knowledge, "entities", "run-a.md"), "utf8"), /https:\/\/example.test\/run-b/u,
		"the cross-Source Cue footnote includes the secondary original Source locator");
	cpSync(knowledge, join(goalDir, "wiki", "knowledge"), { recursive: true });
	const app = express();
	app.use(createWikiRouter(root, { getGoal: (id: string) => id === "goal" ? { id } : undefined } as unknown as GoalService));
	const server = app.listen(0);
	await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
	const api = (path: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/goals/goal/wiki/${path}`);
	try {
		assert.equal((await api("source?path=source%3Ashared")).status, 409, "ambiguous Source revisions cannot silently pick the first Run");
		for (const [index, runId] of ["run-a", "run-b"].entries()) {
			const response = await api(`source?path=source%3Ashared&run=${runId}&document=members%2Farticle%2Fdocument.md`);
			assert.equal(response.status, 200);
			const source = await response.json() as { runId: string; content: string };
			assert.equal(source.runId, runId);
			assert.equal(source.content.trim(), anchors[index]!.excerpt);
		}
		assert.equal((await api("source?path=source%3Ashared&run=not-in-edition")).status, 400);
		assert.equal((await api("source?path=source%3Ashared&run=run-a&document=members%2Fa-decoy%2Fdocument.md")).status, 400,
			"the exact Source document must be bound to an evidence anchor in this Edition");
		assert.equal((await api("source?path=source%3Ashared&run=run-a&document=..%2Fsecret.md")).status, 400);
		assert.equal((await api("source?path=source%3Ashared&run=..%2Frun-b")).status, 400);
		const asset = await api("source-asset?source=source%3Amember-run-b&path=assets%2Ffigure.png&run=run-b");
		assert.equal(asset.status, 200, "secondary Source assets resolve through per-anchor original Run membership");
		assert.deepEqual([...new Uint8Array(await asset.arrayBuffer())], [137, 80, 78, 1]);
		assert.equal((await api("source-asset?source=source%3Amember-run-b&path=assets%2Ffigure.png&run=run-a")).status, 400);
		assert.equal((await api("source-asset?source=source%3Ashared&path=assets%2Ffigure.png")).status, 409,
			"asset lookup cannot swallow an ambiguous Wiki provenance error and search a different Run");
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
	writeFileSync(join(goalDir, "wiki", "runs", "run-b", "artifacts", "find-out-sources", "sequence-1", "sources", "shared", "members", "article", "document.md"), "Changed evidence.\n");
	assert.throws(() => readWikiPageEvidence(knowledge, { entry_ids: [entries[0]!.id] }, goalDir), /range changed/u);
	assert.throws(() => createCueCornellSnapshot({ goalDir, artifactRefs: [artifact], snapshotId: "changed" }), /evidence changed/u);
} finally {
	rmSync(root, { recursive: true, force: true });
}
