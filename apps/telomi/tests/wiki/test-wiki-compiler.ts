import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sha256 } from "../../server/lib/hash.js";
import { loadAgentPromptConfig, renderAgentPrompt } from "../../server/agent-runtime/prompt-registry.js";
import { batchEvidenceBySourceLimit, LlmWikiCompiler } from "../../server/wiki/compiler.js";
import { requireWikiGoalContext, type GoalTopicPlan } from "../../server/wiki/contracts.js";
import {
	createWikiShardTaskTools,
	noteWikiEntries,
	renderWikiShardInputs,
	runPrimeNoteWikiMaintainer,
	validateWikiShardTaskResult,
} from "../../server/wiki/note-wiki-maintainer.js";
import { hooks as primeLifecycleHooks } from "./fixtures/prime-sdk-lifecycle.js";
import { localizeShardPage, materializeCuratorEdition, prepareCuratorInput, validateCuratorWorksets } from "../../server/wiki/wiki-shard-merge.js";
import {
	createCuratorWorksetTools,
	curatorRelationsMissing,
	missingCuratorWorkspaceResults,
	prepareCuratorRelationWorkspace,
	prepareCuratorWorkspace,
	stageCuratorRelations,
	stageCuratorWorkspaceResults,
} from "../../server/wiki/wiki-curator-workspace.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { CornellNotesSnapshot } from "../../server/cornell/contracts.js";

const topicPlan: GoalTopicPlan = {
	schema_version: 1,
	goal_id: "test-goal",
	revision: "test-v1",
	status: "active",
	topics: [
		{ id: "model-architecture", title: "Model Architecture", intent: "Durable model architecture knowledge.", questions: [], include: [], exclude: [] },
		{ id: "production-deployment", title: "Production Deployment", intent: "Deployment and application knowledge.", questions: [], include: [], exclude: [] },
	],
};

const root = mkdtempSync(join(tmpdir(), "pi-note-wiki-compiler-"));
// Lifecycle tests use native credential/model infrastructure and a deterministic session adapter.
const fakeAgentDir = join(root, "source-agent-dir");
mkdirSync(fakeAgentDir);
writeFileSync(join(fakeAgentDir, "auth.json"), "{}\n");
writeJson(join(fakeAgentDir, "models.json"), { providers: { test: {
	baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "lifecycle-test",
	models: ["root", "child"].map((id) => ({ id, contextWindow: 272000 })),
} } });
try {
	const shardBuilderSource = readFileSync(join(import.meta.dirname, "../../server/wiki/note-wiki-maintainer.ts"), "utf-8");
	const skillSource = readFileSync(join(import.meta.dirname, "../../agents/wiki/wiki-shard-builder/skills/wiki-shard-builder/SKILL.md"), "utf-8");
	const mergeWorkerSource = readFileSync(join(import.meta.dirname, "../../server/wiki/prime-wiki-merge-worker.ts"), "utf-8");
	const mergeSkillSource = readFileSync(join(import.meta.dirname, "../../agents/wiki/wiki-curator/skills/wiki-curator/SKILL.md"), "utf-8");
	const curatorWorkspaceSource = readFileSync(join(import.meta.dirname, "../../server/wiki/wiki-curator-workspace.ts"), "utf-8");
	const promptInput = {
		goal: "RESEARCH_QUESTION_MUST_NOT_BE_INJECTED",
		goal_title: "Build durable knowledge",
		goal_description: "Long-term knowledge scope",
		topics: "Model architecture",
		reading_material: "Original Cornell evidence",
		batch_number: 1,
		batch_total: 2,
		batch_id: "batch-test",
		source_count: 2,
		child_model: "provider/child",
		language: "zh-CN",
	};
	const entityPrompt = renderAgentPrompt("wiki", "wiki-shard-builder", "user", promptInput, "entity").content;
	const conceptPrompt = renderAgentPrompt("wiki", "wiki-shard-builder", "user", promptInput, "concept").content;
	// The Wiki language is a structured input, never inferred from the language of the evidence.
	for (const prompt of [entityPrompt, conceptPrompt]) {
		assert.match(prompt, /in zh-CN, the language this user reads/u);
		assert.doesNotMatch(prompt, /predominant language/u);
	}
	assert.deepEqual(Object.keys(loadAgentPromptConfig("wiki", "wiki-shard-builder").prompts.user ?? {}).sort(), ["concept", "entity"]);
	assert.equal([...shardBuilderSource.matchAll(/session\.prompt\(userPrompt\)/gu)].length, 1,
		"each mapped task must receive one initial User Prompt");
	assert.match(shardBuilderSource, /Promise\.allSettled\(TASKS\.map/u);
	assert.match(shardBuilderSource, /customTools:\s*createWikiShardTaskTools/u);
	for (const prompt of [entityPrompt, conceptPrompt]) {
		assert.match(prompt, /Build durable knowledge/u);
		assert.match(prompt, /Long-term knowledge scope/u);
		assert.doesNotMatch(prompt, /RESEARCH_QUESTION_MUST_NOT_BE_INJECTED/u);
		assert.doesNotMatch(prompt, /batch-test|batch 1 of 2|same language as the Goal/u);
		assert.doesNotMatch(prompt, /input\/(?:goal\.md|topic-plan\.json|source-roster\.json|notes\.json)/u);
		assert.match(prompt, /exact child model `provider\/child`/u);
		assert.doesNotMatch(prompt, /\bRoot\b|must delegate/iu);
	}
	assert.match(entityPrompt, /actual canonical subjects[\s\S]+submit_wiki_entity_result/u);
	assert.match(conceptPrompt, /original Cornell prose[\s\S]+one Note or Source[\s\S]+submit_wiki_concept_result/u);
	assert.match(shardBuilderSource, /tools:\s*\["ipython", submitTool\]/u);
	assert.doesNotMatch(shardBuilderSource, /additionalSkillPaths|snapshotSkills|bundledAgentSkillPaths/u);
	assert.equal(loadAgentPromptConfig("wiki", "wiki-shard-builder").skills, undefined);
	assert.match(shardBuilderSource, /rlmMaxDepth:\s*1/u);
	assert.match(shardBuilderSource, /await session\.disposeAsync\(\)/u, "await final kernel snapshots before immutable Case capture");
	assert.doesNotMatch(shardBuilderSource, /session\.dispose\(\)/u);
	assert.doesNotMatch(shardBuilderSource, /SessionManager\.open|work\/plan|work\/assignments/u);
	assert.match(shardBuilderSource, /setSessionName\(task\.name\)/u);
	assert.match(shardBuilderSource, /canonical_locator/u);
	assert.doesNotMatch(shardBuilderSource, /startNoteWikiBridge|PRIME_NOTE_WIKI_URL|note_wiki/u);
	assert.match(skillSource, /Wiki Shard Builder/u);
	assert.match(skillSource, /input\/topic-plan\.json/u);
	assert.doesNotMatch(skillSource, /note_wiki|submit_plan|Linker/u);
	assert.match(mergeWorkerSource, /session\.waitForRlmQuiescence/u);
	assert.doesNotMatch(mergeWorkerSource, /session\.hasRunningRlmChildren|session\.waitForIdle/u);
	assert.match(shardBuilderSource, /session\.waitForRlmQuiescence/u);
	assert.doesNotMatch(shardBuilderSource, /session\.hasRunningRlmChildren|session\.waitForIdle/u);
	const taskEntries = [{ ref: "N1" }, { ref: "N2" }];
	validateWikiShardTaskResult("entity", { task: "entity", pages: [{ local_ref: "entity:subject", kind: "entity",
		title: "Subject", description: "Grounded subject.", body: "## Body\nEvidence [[N1]]." }], deferred_entries: [] }, taskEntries);
	assert.throws(() => validateWikiShardTaskResult("concept", { task: "concept", pages: [{ local_ref: "concept:bad", kind: "entity",
		title: "Wrong", description: "Wrong type.", body: "## Body\nEvidence [[N1]]." }], deferred_entries: [] }, taskEntries), /must equal 'concept'/u);
	assert.throws(() => validateWikiShardTaskResult("concept", { task: "concept", pages: [{ local_ref: "concept:bad", kind: "concept",
		title: "Wrong", description: "Unknown ref.", body: "## Body\nEvidence [[N9]]." }], deferred_entries: [] }, taskEntries), /unknown Note 'N9'/u);
	validateWikiShardTaskResult("concept", { task: "concept", pages: [], deferred_entries: [{ note_ref: "N2", reason: "No reusable abstraction." }],
		empty_reason: "No reusable concept is supported." }, taskEntries);
	await testWikiShardTaskTools(join(root, "shard-contract-tools"));
	assert.match(mergeWorkerSource, /prepareCuratorWorkspace/u);
	assert.match(mergeWorkerSource, /stageCuratorWorkspaceResults/u);
	assert.match(mergeWorkerSource, /prepareCuratorRelationWorkspace/u);
	assert.match(mergeWorkerSource, /stageCuratorRelations/u);
	assert.match(mergeWorkerSource, /SessionManager\.create/u);
	assert.doesNotMatch(mergeWorkerSource, /SessionManager\.open|session-path\.txt/u);
	assert.doesNotMatch(mergeWorkerSource, /wait_for_subagents|rlm\.list_subagents/u);
	assert.match(mergeSkillSource, /references\/plan-and-delegate\.md/u);
	assert.match(mergeSkillSource, /references\/resume-and-repair\.md/u);
	assert.match(mergeSkillSource, /references\/relation-pass\.md/u);
	assert.match(mergeSkillSource, /shared Workspace files/u);
	assert.match(mergeSkillSource, /initialize|update|reframe/u);
	assert.doesNotMatch(mergeSkillSource, /wiki_merge\.|submit_group|submit_plan\(/u);
	assert.match(curatorWorkspaceSource, /must assign every incoming Page/u);
	testShardMergeMaterialization(join(root, "shard-merge"));
	testConceptCoordination(join(root, "concept-coordination"));
	testDiscardedMainPageRescue(join(root, "main-rescue"));
	await testCuratorWorksetSubmitTool(join(root, "workset-submit"));
	await testRetainedMainPage(join(root, "retained-main"));
	testShardRelationLabels();
	testCuratorIndex(join(root, "curator-index"));
	await testCuratorWorkspace(join(root, "curator-workspace"));
	const goalDir = join(root, "goal");
	const runDirectory = join(root, "run");
	const controlDirectory = join(root, "control");
	mkdirSync(join(goalDir, "wiki", "knowledge"), { recursive: true });
	const evidence: CornellNotesSnapshot = {
		schema_version: 1,
		snapshot_id: "snapshot:test",
		run_id: "run-test",
		pipeline: { id: "pipeline:test", version: "1", sha256: "a".repeat(64) },
		source_bundle_refs: [],
		notes: [{
			note: { schema_version: 1, source_id: "source:test", sections: [{
				section_title: "Architecture",
				summary: "A grounded summary.",
				cue_notes: [{
					cue: "Architecture",
					note: "The model uses a deterministic test architecture.",
					topic_refs: ["model-architecture"],
					discovery: { finding: "A Goal-relevant finding that must stay outside Wiki Curator input." },
					evidence: [{ source_path: "document.md", content_sha256: "b".repeat(64), start_line: 1, end_line: 2 }],
				}],
			}] },
			title: "Test Source",
			canonical_locator: "https://example.test/source",
			provider_id: "test",
			provenance_ref: "provider:test",
			source_revision_sha256: "c".repeat(64),
			members: [],
		}],
	};
	assert.deepEqual(noteWikiEntries(evidence, topicPlan.revision)[0]?.topicRefs, ["model-architecture"]);
	await testShardRecoveryLifecycle(join(root, "recovery-lifecycle"), evidence);
	await testCurationFailureDegrades(join(root, "curation-failure"), evidence);
	assert.equal(noteWikiEntries(evidence, topicPlan.revision)[0]?.topicPlanRevision, topicPlan.revision);
	const revisedEvidence = structuredClone(evidence);
	revisedEvidence.notes[0]!.note.sections[0]!.cue_notes[0]!.evidence[0]!.content_sha256 = "d".repeat(64);
	const firstEntry = noteWikiEntries(evidence, topicPlan.revision)[0]!;
	const readingEntries = [
		{ ...firstEntry, ref: "N1", sourceRef: "S1", sectionSummary: "Shared summary with a fact absent from the Notes.", detail: "First complete Note." },
		{ ...firstEntry, ref: "N2", sourceRef: "S1", sectionSummary: "Shared summary with a fact absent from the Notes.", detail: "Second Note with {{ literal_template_text }} and <markup>." },
		{ ...firstEntry, ref: "N3", sourceRef: "S1", sectionSummary: "Distinct summary under the same heading.", detail: "Third Note." },
		{ ...firstEntry, ref: "N4", sourceRef: "S2", sectionSummary: "Another Source must remain separate.", detail: "Fourth Note." },
	];
	const reading = renderWikiShardInputs(readingEntries, topicPlan);
	const bodies = reading.material;
	assert.equal(bodies.split(readingEntries[0]!.sectionSummary).length - 1, 1, "deduplicate identical section summaries only");
	for (const entry of readingEntries) {
		assert.ok(bodies.includes(entry.sectionSummary));
		assert.ok(bodies.includes(entry.detail));
		assert.equal(bodies.split(`##### ${entry.ref}\n`).length - 1, 1, "every stable Note body must survive exactly once");
		assert.ok(bodies.includes(entry.cue));
	}
	assert.ok(bodies.includes(firstEntry.canonicalLocator));
	assert.ok(reading.topics.includes(topicPlan.topics[1]!.intent));
	assert.doesNotMatch(reading.topics + bodies, /Topic refs:|model-architecture|production-deployment/u);
	for (const topic of topicPlan.topics) assert.ok(reading.topics.includes(`### ${topic.title}\n`));
	const duplicateSource = { source_id: firstEntry.sourceId, provider_id: "test", title: firstEntry.sourceTitle,
		canonical_locator: firstEntry.canonicalLocator };
	const sourceIndex = renderWikiShardInputs([{ ...readingEntries[0]!, members: [duplicateSource,
		{ ...duplicateSource, title: "Alternative title" }, { ...duplicateSource, canonical_locator: "https://example.test/other" }] }], topicPlan).material;
	assert.equal(sourceIndex.split(`Title: ${firstEntry.sourceTitle}\nLocator: ${firstEntry.canonicalLocator}\n`).length - 1, 1);
	assert.ok(sourceIndex.includes("Alternative title"));
	assert.ok(sourceIndex.includes("https://example.test/other"));
	for (const task of ["entity", "concept"] as const) {
		const prompt = renderAgentPrompt("wiki", "wiki-shard-builder", "user", {
			...promptInput, topics: reading.topics, reading_material: reading.material,
		}, task).content;
		assert.equal(prompt.split(reading.material.trimEnd()).length - 1, 1);
		assert.equal(prompt.split(reading.topics.trimEnd()).length - 1, 1);
		assert.match(prompt, /First complete Note|Second Note with/u);
		assert.doesNotMatch(prompt, /RESEARCH_QUESTION_MUST_NOT_BE_INJECTED|notes\/|input\/(?:reading-material\.md|topic-plan\.json|source-roster\.json|notes\.json)/u);
	}
	assert.deepEqual(requireWikiGoalContext({ title: "Goal title", description: "" }), { title: "Goal title", description: "" });
	for (const invalid of [undefined, "Title plus research question", { title: "Title" }, { title: " ", description: "" },
		{ title: "Title", description: "", question: "Research question" }]) assert.throws(() => requireWikiGoalContext(invalid), /structured Goal/u);
	const revisedEntry = noteWikiEntries(revisedEvidence, topicPlan.revision)[0]!;
	assert.equal(firstEntry.id, revisedEntry.id, "the Cornell Entry identity must remain stable across evidence refreshes");
	assert.notEqual((firstEntry as typeof firstEntry & { revisionSha256?: string }).revisionSha256,
		(revisedEntry as typeof revisedEntry & { revisionSha256?: string }).revisionSha256,
		"the Cornell Entry revision must include its evidence anchors and provenance");
	const store = new RunArtifactStore(runDirectory);
	const sourceRecords = Array.from({ length: 23 }, (_, index) => {
		const record = structuredClone(evidence.notes[0]!);
		record.note.source_id = `source:test-${index}`;
		record.title = `Test Source ${index}`;
		return record;
	});
	const repeatedSource = structuredClone(sourceRecords[0]!);
	repeatedSource.note.sections[0]!.cue_notes[0]!.cue = "Second cue from the same Source";
	const sourceBatches = batchEvidenceBySourceLimit({
		...evidence,
		notes: [...sourceRecords, repeatedSource],
	});
	assert.deepEqual(sourceBatches.map((batch) => new Set(batch.notes.map((record) => record.note.source_id)).size), [10, 10, 3]);
	assert.equal(sourceBatches[0]!.notes.filter((record) => record.note.source_id === "source:test-0").length, 2,
		"records from one Source must remain in the same batch");
	const batchedEvidence = { ...evidence, notes: sourceRecords };
	const cornellNotesArtifact = store.publishText(`${JSON.stringify(batchedEvidence, null, 2)}\n`, "artifacts/evidence.json");
	let calls = 0;
	let curatorCalls = 0;
	const sessionRoots = new Set<string>();
	const curatorSessionRoots = new Set<string>();
	const curatorOperations: string[] = [];
	const observedBatches: Array<{ index: number; total: number; sourceCount: number }> = [];
	const compiler = new LlmWikiCompiler({
		maintain: async ({ goal, evidence: received, workRoot, sessionRoot, batch, topicPlan: receivedTopicPlan }) => {
			calls += 1;
			assert.equal(goal, "Research multilingual speech generation");
			assert.equal(receivedTopicPlan?.revision, topicPlan.revision);
			assert.equal(received.notes[0]?.note.sections[0]?.cue_notes[0]?.cue, "Architecture");
			assert.equal("discovery" in received.notes[0]!.note.sections[0]!.cue_notes[0]!, false);
			sessionRoots.add(sessionRoot);
			observedBatches.push({ index: batch.index, total: batch.total, sourceCount: batch.sourceIds.length });
			const knowledgeRoot = join(workRoot, "knowledge");
			mkdirSync(join(knowledgeRoot, "concepts"), { recursive: true });
			mkdirSync(join(knowledgeRoot, "entities"), { recursive: true });
			// The middle Shard finds nothing durable: a legitimate empty result that must not reach the Curator.
			if (batch.index === 1) {
				return { knowledgeRoot, pageCount: 0, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, calls: 1 }, sessionPaths: [] };
			}
			writeFileSync(join(knowledgeRoot, "concepts", "architecture.md"), "# Architecture\n\nGrounded content.\n");
			return {
				knowledgeRoot,
				pageCount: 1,
				usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, calls: 1 },
				sessionPaths: [],
			};
		},
		curate: async ({ operation, previousEditionRoot, draftRoots, workRoot, sessionRoot, topicPlan: receivedTopicPlan }) => {
			curatorCalls += 1;
			curatorOperations.push(operation);
			assert.equal(operation, curatorCalls === 1 ? "initialize" : "update");
			assert.equal(Boolean(previousEditionRoot), curatorCalls > 1);
			assert.equal(receivedTopicPlan.revision, topicPlan.revision);
			assert.equal(draftRoots.length, 1, "each Curator stage must receive exactly one completed draft Shard");
			curatorSessionRoots.add(sessionRoot);
			const knowledgeRoot = join(workRoot, "merged-knowledge");
			mkdirSync(join(knowledgeRoot, "concepts"), { recursive: true });
			mkdirSync(join(knowledgeRoot, "entities"), { recursive: true });
			if (previousEditionRoot) {
				for (const file of readdirSync(join(previousEditionRoot, "concepts"))) {
					writeFileSync(join(knowledgeRoot, "concepts", file), readFileSync(join(previousEditionRoot, "concepts", file)));
				}
			}
			writeFileSync(join(knowledgeRoot, "concepts", `architecture-${curatorCalls}.md`),
				readFileSync(join(draftRoots[0]!, "concepts", "architecture.md")));
			return {
				knowledgeRoot,
				pageCount: readdirSync(join(knowledgeRoot, "concepts")).length,
				usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.002, calls: 1 },
				sessionPaths: [],
			};
		},
	});
	const request = {
		env: { PRIME_AGENT_CODING_AGENT_DIR: fakeAgentDir, TELOMI_WIKI_MAINTAINER_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child" },
		goalDir,
		goal: "Research multilingual speech generation",
		goalContext: { title: "Speech generation", description: "Understand architectures" },
		runId: "run-test",
		runDirectory,
		controlDirectory,
		cornellNotesSnapshot: artifactRef(cornellNotesArtifact),
		topicPlan,
		signal: new AbortController().signal,
	};
	const compiled = await compiler.compile(request);
	assert.equal(compiled.status, "compiled");
	assert.equal(compiled.pageCount, 2);
	assert.equal(compiled.usage.calls, 5);
	assert.equal(calls, 3);
	assert.equal(curatorCalls, 2, "each non-empty draft Shard passes through its own rolling Curator stage; an empty Shard is skipped");
	assert.deepEqual(curatorOperations, ["initialize", "update"]);
	assert.equal(compiled.agentStages, 5);
	assert.equal(sessionRoots.size, 3, "independent Batch Wiki Shards must use independent Agent Sessions");
	assert.equal(curatorSessionRoots.size, 2, "each rolling Curator stage must use an independent Agent Session");
	assert.deepEqual(observedBatches.sort((left, right) => left.index - right.index), [
		{ index: 0, total: 3, sourceCount: 10 },
		{ index: 1, total: 3, sourceCount: 10 },
		{ index: 2, total: 3, sourceCount: 3 },
	]);
	assert.ok(existsSync(join(compiled.knowledge.absolutePath, "concepts", "architecture-2.md")));
	assert.match(readFileSync(join(runDirectory, "artifacts", "wiki-compilations", compiled.compilationId, "compilation.json"), "utf-8"), /"schema_version": 5/u);
	assert.equal((await compiler.compile(request)).status, "reused");
	assert.equal(calls, 3);
	assert.equal(curatorCalls, 2);
	const publishedKnowledge = join(goalDir, "wiki", "knowledge");
	rmSync(publishedKnowledge, { recursive: true, force: true });
	cpSync(compiled.knowledge.absolutePath, publishedKnowledge, { recursive: true });
	writeJson(join(publishedKnowledge, ".note-registry.json"), {
		schema_version: 2,
		contract_version: 25,
		entries: noteWikiEntries(batchedEvidence),
	});
	writeJson(join(publishedKnowledge, ".topic-plan.json"), topicPlan);
	const identicalReplay = await compiler.compile({ ...request, runId: "run-test-identical-replay" });
	assert.equal(identicalReplay.usage.calls, 0, "identical Notes and Topic Plan must skip every semantic Agent");
	assert.equal(curatorCalls, 2, "matching Wiki Edition must be reused");
	const refreshedEvidence = structuredClone(batchedEvidence);
	refreshedEvidence.notes[0]!.note.sections[0]!.cue_notes[0]!.evidence[0]!.content_sha256 = "d".repeat(64);
	const refreshedArtifact = store.publishText(`${JSON.stringify(refreshedEvidence, null, 2)}\n`, "artifacts/evidence-refreshed.json");
	await compiler.compile({
		...request,
		runId: "run-test-evidence-refresh",
		cornellNotesSnapshot: artifactRef(refreshedArtifact),
	});
	assert.ok(curatorCalls > 2, "changed Evidence anchors must refresh the Wiki even when the Note text is unchanged");
	const callsBeforeGoalChange = calls;
	const publishedContext = readFileSync(join(publishedKnowledge, ".goal-context.sha256"), "utf-8");
	const changedGoal = await compiler.compile({ ...request, runId: "run-test-goal-change",
		goalContext: { title: "Speech deployment", description: "" } });
	assert.equal(calls, callsBeforeGoalChange + 3, "changed Goal must rebuild Shards even with identical Notes and Topics");
	assert.notEqual(readFileSync(join(changedGoal.knowledge.absolutePath, ".goal-context.sha256"), "utf-8"), publishedContext);
	assert.equal(readFileSync(join(publishedKnowledge, ".goal-context.sha256"), "utf-8"), publishedContext,
		"compilation must not mutate the currently published Goal Wiki");
	assert.equal(sha256(readFileSync(join(compiled.knowledge.absolutePath, "concepts", "architecture-2.md"))),
		sha256("# Architecture\n\nGrounded content.\n"));
	console.log("Cornell Notes to Wiki Maintainer compiler Interface passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

/** A rejected Curation must cost one Source batch, never the whole Edition. */
async function testCurationFailureDegrades(testRoot: string, source: CornellNotesSnapshot): Promise<void> {
	const failure = "Wiki Curator exited with code 1: [wiki-curator:worksets] file 'state/groups/ws-1.json'";
	const compiler = (): LlmWikiCompiler => new LlmWikiCompiler({
		maintain: async ({ workRoot }) => {
			const knowledgeRoot = join(workRoot, "knowledge");
			mkdirSync(join(knowledgeRoot, "concepts"), { recursive: true });
			mkdirSync(join(knowledgeRoot, "entities"), { recursive: true });
			writeFileSync(join(knowledgeRoot, "concepts", "architecture.md"), "# Architecture\n\nGrounded content.\n");
			return { knowledgeRoot, pageCount: 1, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, calls: 1 }, sessionPaths: [] };
		},
		curate: async () => { throw new Error(failure); },
	});
	const buildRequest = (name: string) => {
		const goalDir = join(testRoot, name, "goal");
		const runDirectory = join(testRoot, name, "run");
		mkdirSync(join(goalDir, "wiki", "knowledge"), { recursive: true });
		const store = new RunArtifactStore(runDirectory);
		return {
			env: { PRIME_AGENT_CODING_AGENT_DIR: fakeAgentDir, TELOMI_WIKI_MAINTAINER_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child" },
			goalDir,
			goal: "Research multilingual speech generation",
			goalContext: { title: "Speech generation", description: "Understand architectures" },
			runId: `run-${name}`,
			runDirectory,
			controlDirectory: join(testRoot, name, "control"),
			cornellNotesSnapshot: artifactRef(store.publishText(`${JSON.stringify(source, null, 2)}\n`, "artifacts/evidence.json")),
			topicPlan,
			signal: new AbortController().signal,
		};
	};
	const rolling = buildRequest("rolling");
	const previousEdition = join(rolling.goalDir, "wiki", "knowledge");
	mkdirSync(join(previousEdition, "concepts"), { recursive: true });
	writeJson(join(previousEdition, ".note-registry.json"), { schema_version: 2, contract_version: 25, entries: [] });
	writeJson(join(previousEdition, ".deferred-notes.json"), []);
	writeFileSync(join(previousEdition, "concepts", "previous.md"), "# Previous\n\nPrevious Edition page.\n");
	const partial = await compiler().compile(rolling);
	assert.equal(partial.status, "compiled");
	assert.deepEqual(partial.failedBatches.map((batch) => batch.batchIndex), [0]);
	assert.match(partial.failedBatches[0]!.message, /wiki-curator:worksets/u);
	assert.ok(existsSync(join(partial.knowledge.absolutePath, "concepts", "previous.md")),
		"a rejected Curation must keep the previous Edition instead of discarding it");
	assert.equal(partial.pageCount, 1, "a partial compilation must report the Edition it actually published");
	await assert.rejects(compiler().compile(buildRequest("first")), new RegExp(failure.replace(/[[\]]/gu, "\\$&"), "u"),
		"a first Edition must fail rather than publish an empty Wiki");
}

function artifactRef(value: { relativePath: string; sha256: string; byteLength: number }) {
	return { relative_path: value.relativePath, sha256: value.sha256, byte_length: value.byteLength };
}

async function testShardRecoveryLifecycle(testRoot: string, source: CornellNotesSnapshot): Promise<void> {
	const evidence = structuredClone(source);
	evidence.notes[0]!.note.sections[0]!.cue_notes.push({
		...evidence.notes[0]!.note.sections[0]!.cue_notes[0]!, cue: "Second cue", note: "Second deterministic detail.",
	});
	for (const first of ["entity", "concept"] as const) for (const outcome of ["repair", "fail", "cancel"] as const) {
		const workRoot = join(testRoot, `${first}-${outcome}`);
		const controller = new AbortController();
		const events: string[] = [];
		let disposed!: () => void;
		const firstDisposed = new Promise<void>((resolve) => { disposed = resolve; });
		const roleOf = (name: string) => name.includes("entity") ? "entity" : "concept";
		writeJson(join(workRoot, "knowledge", "previous.json"), { keep: true });
		writeJson(join(workRoot, "maintainer", "input", "notes.json"), { obsolete: true });
		primeLifecycleHooks.dispose = (options) => {
			const role = roleOf(options.customTools[0]!.name);
			events.push(`disposed:${role}`);
			if (role === first) disposed();
		};
		primeLifecycleHooks.prompt = async (options, prompt) => {
			const tool = options.customTools[0]!;
			const role = roleOf(tool.name);
			events.push(`prompt:${role}`);
			assert.match(prompt, /Cornell Notes/u);
			assert.match(prompt, /Lifecycle goal title[\s\S]+Lifecycle goal description/u);
			assert.doesNotMatch(prompt, /RESEARCH_QUESTION_MUST_NOT_BE_INJECTED/u);
			assert.equal(options.cwd, join(workRoot, "maintainer", "workspace"));
			assert.deepEqual(readdirSync(options.cwd).sort(), ["work"]);
			assert.equal(existsSync(join(workRoot, "maintainer", "input")), false, "old duplicated input files must not survive preparation");
			assert.match(prompt, /Second deterministic detail/u, "original Note prose is directly injected");
			if (role !== first) await firstDisposed;
			const result = { task: role, pages: [{ local_ref: `${role}:test`, kind: role, title: role,
				description: "Deterministic test", body: "## Detail\nFirst evidence [[N1]]." }], deferred_entries: [] };
			const path = join(options.cwd, "work", role, "result.json");
			writeJson(path, result);
			const submit = () => tool.execute("test", {}, controller.signal, undefined, {} as never);
			try { await submit(); }
			catch (error) {
				assert.notEqual(role, first);
				assert.match(String(error), /missing N2/u);
				events.push(`rejected:${role}`);
				assert.equal(existsSync(join(workRoot, "maintainer", "work", role, "accepted.json")), false);
				assert.ok(existsSync(join(workRoot, "knowledge", "previous.json")), "a rejected tool must leave the previous output alone");
				if (outcome === "fail") throw error;
				result.pages[0]!.body += " Second evidence [[N2]].";
				writeJson(path, result);
				await submit();
				events.push(`repaired:${role}`);
			}
			assert.equal(existsSync(join(options.cwd, "work", role, "accepted.json")), false, "acceptance state stays outside Agent cwd");
			assert.equal(existsSync(join(options.cwd, "validation-knowledge")), false, "validation staging stays outside Agent cwd");
			if (role !== first && outcome === "cancel") controller.abort(new Error("test cancellation"));
		};
		const run = runPrimeNoteWikiMaintainer({ goal: "RESEARCH_QUESTION_MUST_NOT_BE_INJECTED", evidence, topicPlan, workRoot,
			goalContext: { title: "Lifecycle goal title", description: "Lifecycle goal description" },
			sessionRoot: join(workRoot, "sessions"), batch: { id: "test", index: 0, total: 1, sourceIds: ["source:test"] },
			signal: controller.signal, env: { PRIME_AGENT_MODULE: new URL("./fixtures/prime-sdk-lifecycle.ts", import.meta.url).href,
				PRIME_AGENT_CODING_AGENT_DIR: fakeAgentDir,
				TELOMI_WIKI_MAINTAINER_MODEL: "test/root", TELOMI_PRIME_AGENT_ROOT_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child" } });
		const last = first === "entity" ? "concept" : "entity";
		if (outcome === "repair") {
			const result = await run;
			assert.equal(result.pageCount, 2);
			assert.ok(existsSync(join(result.knowledgeRoot, "README.md")));
			assert.equal(existsSync(join(result.knowledgeRoot, "previous.json")), false);
			assert.ok(events.includes(`repaired:${last}`));
		} else {
			await assert.rejects(run, outcome === "fail" ? /missing N2/u : /test cancellation/u);
			assert.ok(existsSync(join(workRoot, "knowledge", "previous.json")));
			assert.equal(existsSync(join(workRoot, "maintainer", "work", "commit.json")), false);
		}
		assert.ok(events.indexOf(`disposed:${first}`) < events.indexOf(`rejected:${last}`), "the first Session may already have ended");
		assert.equal(events.filter((event) => event.startsWith("prompt:")).length, 2, "no injected repair User Prompt or replacement Session");
		assert.equal(events.filter((event) => event.startsWith("disposed:")).length, 2);
	}
}

async function testWikiShardTaskTools(contractRoot: string): Promise<void> {
	const stageRoot = join(contractRoot, "maintainer");
	const entries = [{
		id: `entry:${"1".repeat(24)}`,
		revisionSha256: "1".repeat(64),
		sourceRunId: "run-test",
		sourceId: "source:test",
		sourceTitle: "Test Source",
		canonicalLocator: "https://example.test/source",
		members: [],
		section: "Architecture",
		cue: "Architecture",
		detail: "A grounded detail.",
		topicRefs: ["model-architecture"],
		anchors: [{ path: "document.md", startLine: 1, endLine: 1, sha256: "2".repeat(64) }],
		ref: "N1",
		sourceRef: "S1",
	}];
	const entityTool = createWikiShardTaskTools(stageRoot, entries, "entity")[0]!;
	const conceptTool = createWikiShardTaskTools(stageRoot, entries, "concept")[0]!;
	const context = { sessionManager: { getSessionDir: () => join(contractRoot, "sessions", "root") } } as never;
	const execute = (tool: typeof entityTool) => tool.execute("test", {}, undefined, undefined, context);

	writeJson(join(stageRoot, "workspace", "work", "entity", "result.json"), {
		task: "entity",
		pages: [{ local_ref: "concept:subject", kind: "concept", title: "Subject", description: "Description", body: "## Detail\nGrounded [[N1]]." }],
		deferred_entries: [],
	});
	await assert.rejects(execute(entityTool), /must equal 'entity'/u);
	assert.equal(existsSync(join(stageRoot, "work", "entity", "accepted.json")), false);

	writeJson(join(stageRoot, "workspace", "work", "entity", "result.json"), {
		task: "entity",
		pages: [{ local_ref: "entity:subject", kind: "entity", title: "Subject", description: "Description", body: "## Detail\nGrounded [[N1]]." }],
		deferred_entries: [],
	});
	await execute(entityTool);
	assert.deepEqual(JSON.parse(readFileSync(join(stageRoot, "work", "entity", "accepted.json"), "utf-8")), { accepted: true });
	writeJson(join(stageRoot, "workspace", "work", "concept", "result.json"), {
		task: "concept", pages: [{ local_ref: "concept:method", kind: "concept", title: "Method", description: "Description",
			body: "## Detail\nThe same evidence is reusable [[N1]]." }], deferred_entries: [],
	});
	await execute(conceptTool);
	assert.equal(existsSync(join(stageRoot, "work", "concept", "accepted.json")), true,
		"the same Note may be accepted independently by both tasks");
	for (const first of ["entity", "concept"] as const) for (const concurrent of [false, true]) {
		const second = first === "entity" ? "concept" : "entity";
		const recoveryRoot = join(contractRoot, `recovery-${first}-${concurrent}`);
		const recoveryEntries = [...entries, { ...entries[0]!, id: `entry:${"3".repeat(24)}`, ref: "N2" }];
		const tools = { entity: createWikiShardTaskTools(recoveryRoot, recoveryEntries, "entity")[0]!,
			concept: createWikiShardTaskTools(recoveryRoot, recoveryEntries, "concept")[0]! };
		for (const task of [first, second]) writeJson(join(recoveryRoot, "workspace", "work", task, "result.json"), {
			task, pages: [{ local_ref: `${task}:page`, kind: task, title: task, description: "Description",
				body: "## Detail\\nShared evidence [[N1]]." }], deferred_entries: [],
		});
		if (concurrent) {
			const [a, b] = await Promise.allSettled([execute(tools[first]), execute(tools[second])]);
			assert.equal(a.status, "fulfilled");
			assert.equal(b.status, "rejected", "parallel submissions must not both skip combined validation");
			if (b.status === "rejected") assert.match(String(b.reason), /missing N2/u);
		} else {
			await execute(tools[first]);
			await assert.rejects(execute(tools[second]), /missing N2/u,
				"the last submission must reject incomplete combined coverage while its Session can still repair");
		}
		assert.equal(existsSync(join(recoveryRoot, "work", second, "accepted.json")), false);
		assert.equal(existsSync(join(recoveryRoot, "validation-knowledge")), false);
		assert.equal(existsSync(join(recoveryRoot, "knowledge")), false);
		const path = join(recoveryRoot, "workspace", "work", second, "result.json");
		const corrected = JSON.parse(readFileSync(path, "utf-8"));
		corrected.pages[0].body += " Another fact [[N2]].";
		writeJson(path, corrected);
		await execute(tools[second]);
		assert.equal(existsSync(join(recoveryRoot, "work", second, "accepted.json")), true);
		assert.equal(existsSync(join(recoveryRoot, "validation-knowledge", "README.md")), true);
		assert.equal(existsSync(join(recoveryRoot, "knowledge")), false, "tool acceptance must not publish the Shard");
		const cancelled = AbortSignal.abort(new Error("cancelled submit"));
		await assert.rejects(tools[second].execute("test", {}, cancelled, undefined, context), /cancelled submit/u);
		assert.equal(existsSync(join(recoveryRoot, "work", second, "accepted.json")), true, "cancelled calls must have no side effects");
		corrected.pages[0].body = "## Detail\nIncomplete again [[N1]].";
		writeJson(path, corrected);
		await assert.rejects(execute(tools[second]), /missing N2/u);
		assert.equal(existsSync(join(recoveryRoot, "work", second, "accepted.json")), false, "failed resubmission must invalidate stale acceptance");
		corrected.pages[0].body += " Repaired again [[N2]].";
		writeJson(path, corrected);
		await execute(tools[second]);
	}
}

function testShardMergeMaterialization(mergeRoot: string): void {
	const input = join(mergeRoot, "input");
	const state = join(mergeRoot, "state");
	const knowledge = join(mergeRoot, "knowledge");
	mkdirSync(join(state, "groups"), { recursive: true });
	const qwen1 = "S001:entity:qwen-a";
	const qwen2 = "S002:entity:qwen-b";
	const flow = "S001:concept:flow";
	const entries = ["1", "2", "3"].map((suffix) => ({
		id: `entry:${suffix.repeat(24)}`,
		revisionSha256: suffix.repeat(64),
		sourceRunId: "run-test",
		sourceId: `source:${suffix}`,
		sourceTitle: `Source ${suffix}`,
		canonicalLocator: `https://example.test/${suffix}`,
		members: [],
		section: "Architecture",
		cue: "Cue",
		detail: "Detail",
		anchors: [{ path: "document.md", startLine: 1, endLine: 1, sha256: suffix.repeat(64) }],
	}));
	const rows = [
		{ ref: qwen1, shard_id: "S001", kind: "entity", title: "Qwen TTS", description: "First source view", path: "entities/a.md" },
		{ ref: qwen2, shard_id: "S002", kind: "entity", title: "Qwen TTS", description: "Second source view", path: "entities/b.md" },
		{ ref: flow, shard_id: "S001", kind: "concept", title: "Flow Matching", description: "Generative method",
			primary_topic_ref: "T1", topic_refs: ["T1"], path: "concepts/c.md" },
	];
	writeJson(join(input, "index.json"), { pages: rows, suggested_groups: [{ group_id: "identity-1", members: [qwen1, qwen2] }] });
	writeJson(join(input, "pages.json"), {
		[qwen1]: { ...rows[0], body: `## Overview\n\nFirst fact [[${entries[0]!.id}]].\n` },
		[qwen2]: { ...rows[1], body: `## Overview\n\nSecond fact [[${entries[1]!.id}]].\n` },
		[flow]: { ...rows[2], body: `## Overview\n\nFlow fact [[${entries[2]!.id}]].\n` },
	});
	writeJson(join(input, "entries.json"), entries);
	writeJson(join(input, "deferred.json"), []);
	writeJson(join(input, "topic-plan.json"), topicPlan);
	writeJson(join(input, "relations.json"), [
		{ from_ref: qwen1, to_ref: flow, label: "uses" },
		{ from_ref: qwen2, to_ref: flow, label: "uses" },
	]);
	writeJson(join(state, "plan.json"), { groups: [{ group_id: "qwen", members: [qwen1, qwen2] }] });
	writeJson(join(state, "groups", "qwen.json"), {
		group_id: "qwen",
		pages: [{
			member_refs: [qwen1],
			kind: "entity",
			title: "Qwen TTS",
			description: "Merged identity",
			primary_topic_ref: "T1",
			topic_refs: ["T1"],
			body: `## Overview\n\nFirst fact [[${entries[0]!.id}]].\n`,
		}],
		discarded_member_refs: [qwen2],
		deferred_entries: [],
	});
	assert.throws(() => materializeCuratorEdition(mergeRoot, knowledge), /must explicitly disposition Cornell Entries/u);
	writeJson(join(state, "groups", "qwen.json"), {
		group_id: "qwen",
		pages: [{
			member_refs: [qwen1], kind: "entity", title: "Qwen TTS", description: "Merged identity",
			primary_topic_ref: "T1", topic_refs: ["T1"],
			body: `## Overview\n\nFirst fact [[${entries[0]!.id}]].\n`,
		}],
		discarded_member_refs: [qwen2],
		deferred_entries: [{ entry_ref: entries[1]!.id, reason: "Omitted during Wiki Curation" }],
	});
	assert.throws(() => materializeCuratorEdition(mergeRoot, knowledge),
		/\[wiki-curator:worksets\] file 'state\/groups\/qwen\.json', field 'deferred_entries\[0\]': must contain an assigned entry_ref and a concrete non-default reason/u);
	writeJson(join(state, "groups", "qwen.json"), {
		group_id: "qwen",
		pages: [{
			member_refs: [qwen1],
			kind: "entity",
			title: "Qwen TTS",
			description: "Merged identity",
			primary_topic_ref: "T1",
			topic_refs: ["T1"],
			body: `## Overview\n\nFirst fact [[${entries[0]!.id}]].\n`,
		}],
		discarded_member_refs: [qwen2],
		deferred_entries: [{ entry_ref: entries[1]!.id, reason: "Duplicate claim already represented by the canonical identity" }],
	});
	materializeCuratorEdition(mergeRoot, knowledge);
	assert.deepEqual(JSON.parse(readFileSync(join(knowledge, ".deferred-notes.json"), "utf-8")), [{
		entry_id: entries[1]!.id,
		reason: "Duplicate claim already represented by the canonical identity",
	}]);
	writeJson(join(state, "groups", "qwen.json"), {
		group_id: "qwen",
		pages: [
			{
				member_refs: [qwen1, qwen2],
				kind: "entity",
				title: "Qwen TTS",
				description: "Merged identity",
				primary_topic_ref: "T1",
				topic_refs: ["T1"],
				body: `## Overview\n\nFirst fact [[${entries[0]!.id}]].\n`,
			},
			{
				member_refs: [],
				kind: "concept",
				title: "Qwen deployment",
				description: `Derived deployment concept [[${entries[1]!.id}]]`,
				primary_topic_ref: "T2",
				topic_refs: ["T2", "T1"],
				body: `## Overview\n\nSecond fact [[${entries[1]!.id}]].\n`,
			},
		],
		discarded_member_refs: [],
		deferred_entries: [],
	});
	writeJson(join(state, "relations.json"), {
		concept_merges: [],
		owned_refs: [qwen1, "DERIVED:qwen:2"],
		relations: [
			{ from_ref: qwen1, to_ref: flow, label: "uses architecture" },
			{ from_ref: "DERIVED:qwen:2", to_ref: qwen1, label: "applies to deployment" },
		],
	});
	materializeCuratorEdition(mergeRoot, knowledge);
	const entity = readFileSync(join(knowledge, "entities", readdirSync(join(knowledge, "entities"))[0]!), "utf-8");
	const concepts = readdirSync(join(knowledge, "concepts")).map((file) => readFileSync(join(knowledge, "concepts", file), "utf-8")).join("\n");
	assert.match(entity, /First fact \[\^1\]/u);
	assert.match(concepts, /Second fact \[\^1\]/u);
	assert.equal((entity.match(/Flow Matching/gmu) ?? []).length, 1, "duplicate Shard relationships must collapse");
	assert.match(entity, /uses architecture/u);
	assert.match(concepts, /applies to deployment/u);
	assert.equal(readdirSync(join(knowledge, "concepts")).length, 2);
	assert.equal((JSON.parse(readFileSync(join(knowledge, ".note-registry.json"), "utf-8")) as { entries: unknown[] }).entries.length, 3);
	assert.deepEqual(JSON.parse(readFileSync(join(knowledge, ".deferred-notes.json"), "utf-8")), []);
	assert.doesNotMatch(readFileSync(join(knowledge, "README.md"), "utf-8"), /\[\[entry:/u);
	assert.match(readFileSync(join(knowledge, "README.md"), "utf-8"), /## Model Architecture/u);
	assert.match(entity, /primary_topic_ref: "model-architecture"/u);
	assert.doesNotMatch(concepts, /primary_topic:|\ntopics:/u);
	assert.match(readFileSync(join(knowledge, "README.md"), "utf-8"), /## Production Deployment/u);
	assert.equal((JSON.parse(readFileSync(join(knowledge, ".topic-plan.json"), "utf-8")) as GoalTopicPlan).revision, "test-v1");
	// A rejected Topic ref must name the allowed refs, and every rejected Workset must surface at once.
	writeJson(join(state, "plan.json"), { groups: [
		{ group_id: "qwen", members: [qwen1, qwen2] },
		{ group_id: "flow", members: [flow] },
	] });
	writeJson(join(state, "groups", "qwen.json"), {
		group_id: "qwen",
		pages: [{
			member_refs: [qwen1, qwen2], kind: "entity", title: "Qwen TTS", description: "Merged identity",
			primary_topic_ref: "T1", topic_refs: ["T1", "T1x"],
			body: `## Overview\n\nFirst fact [[${entries[0]!.id}]]. Second fact [[${entries[1]!.id}]].\n`,
		}],
		discarded_member_refs: [],
		deferred_entries: [],
	});
	writeJson(join(state, "groups", "flow.json"), {
		group_id: "flow",
		pages: [{
			member_refs: [flow], kind: "concept", title: "Flow Matching", description: "Generative method",
			primary_topic_ref: "T9", topic_refs: ["T9"],
			body: `## Overview\n\nFlow fact [[${entries[2]!.id}]].\n`,
		}],
		discarded_member_refs: [],
		deferred_entries: [],
	});
	assert.throws(() => materializeCuratorEdition(mergeRoot, knowledge), (error: unknown) => {
		const message = String(error);
		assert.match(message, /file 'state\/groups\/qwen\.json', field 'pages\[0\]\.topic_refs': contains unknown Goal Topic ref 'T1x'; allowed refs: T1 \(Model Architecture\), T2 \(Production Deployment\)/u);
		assert.match(message, /file 'state\/groups\/flow\.json', field 'pages\[0\]\.topic_refs': contains unknown Goal Topic ref 'T9'/u);
		return true;
	}, "one repair round must see every rejected Workset and the legal Topic refs");
	rmSync(join(state, "relations.json"), { force: true });
	const qwenResult = (page: Record<string, unknown>) => ({
		group_id: "qwen",
		pages: [{
			member_refs: [qwen1, qwen2], kind: "entity", title: "Qwen TTS", description: "Merged identity",
			body: `## Overview\n\nFirst fact [[${entries[0]!.id}]]. Second fact [[${entries[1]!.id}]].\n`,
			...page,
		}],
		discarded_member_refs: [],
		deferred_entries: [],
	});
	writeJson(join(state, "groups", "flow.json"), {
		group_id: "flow",
		pages: [{
			member_refs: [flow], kind: "concept", title: "Flow Matching", description: "Generative method",
			primary_topic_ref: "T1", topic_refs: ["T1"],
			body: `## Overview\n\nFlow fact [[${entries[2]!.id}]].\n`,
		}],
		discarded_member_refs: [],
		deferred_entries: [],
	});
	// A falsy ref is still an unknown ref: accepting it would publish a Page whose Topic ref is null.
	writeJson(join(state, "groups", "qwen.json"), qwenResult({ primary_topic_ref: "T1", topic_refs: ["T1", ""] }));
	assert.throws(() => materializeCuratorEdition(mergeRoot, knowledge),
		/field 'pages\[0\]\.topic_refs': contains unknown Goal Topic ref ''; allowed refs: T1 \(Model Architecture\)/u,
		"a falsy Topic ref must be rejected instead of publishing an unmapped ref");
	writeJson(join(state, "groups", "qwen.json"), qwenResult({ primary_topic_ref: "  ", topic_refs: ["T1"] }));
	assert.throws(() => materializeCuratorEdition(mergeRoot, knowledge),
		/field 'pages\[0\]\.primary_topic_ref': .*allowed refs: T1 \(Model Architecture\)/u,
		"every rejected primary_topic_ref must name the allowed refs");
	writeJson(join(state, "groups", "qwen.json"), qwenResult({ primary_topic_ref: "T1", topic_refs: ["T2"] }));
	assert.throws(() => materializeCuratorEdition(mergeRoot, knowledge),
		/field 'pages\[0\]\.primary_topic_ref': must also appear in topic_refs.*allowed refs: T1 \(Model Architecture\)/u,
		"every rejected primary_topic_ref must name the allowed refs");
	// An unreadable Workset result must not hide the other rejected Worksets from the same repair round.
	writeJson(join(state, "groups", "qwen.json"), qwenResult({ primary_topic_ref: "T1", topic_refs: ["T1", "T1x"] }));
	rmSync(join(state, "groups", "flow.json"), { force: true });
	assert.throws(() => materializeCuratorEdition(mergeRoot, knowledge), (error: unknown) => {
		const message = String(error);
		assert.match(message, /file 'state\/groups\/flow\.json', field '\$': required file is missing/u);
		assert.match(message, /file 'state\/groups\/qwen\.json', field 'pages\[0\]\.topic_refs': contains unknown Goal Topic ref 'T1x'/u);
		return true;
	}, "an unreadable Workset result must not hide the remaining rejected Worksets");
}

async function testCuratorWorksetSubmitTool(root: string): Promise<void> {
	const main = "MAIN:concept:published";
	const candidate = "S001:concept:incoming";
	const entries = ["6", "7"].map((suffix) => ({
		id: `entry:${suffix.repeat(24)}`,
		revisionSha256: suffix.repeat(64),
		sourceRunId: "run-test",
		sourceId: `source:${suffix}`,
		sourceTitle: `Source ${suffix}`,
		canonicalLocator: `https://example.test/${suffix}`,
		members: [],
		section: "Architecture",
		cue: "Cue",
		detail: "Detail",
		anchors: [{ path: "document.md", startLine: 1, endLine: 1, sha256: suffix.repeat(64) }],
	}));
	writeJson(join(root, "input", "pages.json"), {
		[main]: {
			ref: main, shard_id: "MAIN", kind: "concept", title: "Published latency",
			description: "Published knowledge", primary_topic_ref: "T1", topic_refs: ["T1"],
			path: "concepts/published.md", body: `## Overview\n\nPublished fact [[${entries[0]!.id}]].\n`,
		},
		[candidate]: {
			ref: candidate, shard_id: "S001", kind: "concept", title: "Incoming latency",
			description: "Incoming view", primary_topic_ref: "T1", topic_refs: ["T1"],
			path: "concepts/incoming.md", body: `## Overview\n\nIncoming fact [[${entries[1]!.id}]].\n`,
		},
	});
	writeJson(join(root, "input", "entries.json"), entries);
	writeJson(join(root, "input", "notes.json"), entries);
	writeJson(join(root, "input", "topic-plan.json"), topicPlan);
	writeJson(join(root, "work", "plan.json"), { groups: [{ group_id: "latency", members: [main, candidate] }] });
	const [tool] = createCuratorWorksetTools(root);
	const submit = () => tool!.execute("test", { group_id: "latency" }, undefined as never, undefined as never, undefined as never);
	const accepted = join(root, "work", "groups", "latency", ".accepted");
	const result = (page: Record<string, unknown>, discarded: string[], deferred: Array<Record<string, unknown>>) => ({
		group_id: "latency",
		pages: [{ kind: "concept", description: "Merged view", primary_topic_ref: "T1", topic_refs: ["T1"], ...page }],
		discarded_member_refs: discarded,
		deferred_entries: deferred,
	});
	// The child hears about a discarded MAIN Page while it still holds the context that discarded it,
	// and the rejection names every offender plus what may legally be discarded instead.
	writeJson(join(root, "work", "groups", "latency", "result.json"), result(
		{ member_refs: [candidate], title: "Incoming latency", body: `## Overview\n\nIncoming fact [[${entries[1]!.id}]].\n` },
		[main],
		[{ entry_ref: entries[0]!.id, reason: "Superseded by the incoming view" }],
	));
	await assert.rejects(submit(), (error: unknown) => {
		const message = String(error);
		assert.match(message, /file 'work\/groups\/latency\/result\.json', field 'discarded_member_refs'/u);
		assert.match(message, /already published MAIN Pages 'MAIN:concept:published' \(Published latency\)/u);
		assert.match(message, /discardable candidates in this Workset: S001:concept:incoming/u);
		return true;
	}, "a submitted Workset must be rejected in the child's own Tool loop");
	assert.equal(existsSync(accepted), false, "a rejected Workset is not delivered");
	assert.deepEqual(missingCuratorWorkspaceResults(root), ["latency"], "writing the file is not submitting it");
	// Repaired the way the rejection asked: the MAIN Page is retained rather than dropped.
	writeJson(join(root, "work", "groups", "latency", "result.json"), result(
		{ member_refs: [main, candidate], title: "Published latency",
			body: `## Overview\n\nPublished fact [[${entries[0]!.id}]]. Incoming fact [[${entries[1]!.id}]].\n` },
		[], [],
	));
	await submit();
	assert.equal(existsSync(accepted), true);
	assert.deepEqual(missingCuratorWorkspaceResults(root), [], "an accepted Workset counts as delivered");
	// A later bad resubmission must not leave the earlier acceptance standing.
	writeJson(join(root, "work", "groups", "latency", "result.json"), result(
		{ member_refs: [candidate], title: "Incoming latency", body: `## Overview\n\nIncoming fact [[${entries[1]!.id}]].\n` },
		[main], [{ entry_ref: entries[0]!.id, reason: "Superseded by the incoming view" }],
	));
	await assert.rejects(submit(), /discarded_member_refs/u);
	assert.equal(existsSync(accepted), false, "a failed resubmission invalidates stale acceptance");
	// A repair round rewrites result.json in place. Acceptance is pinned to the validated bytes, so
	// the rewrite stops counting as delivered until the child submits it again; otherwise content
	// nobody checked would reach the Edition, and the MAIN rule lives only in this Tool.
	const good = result(
		{ member_refs: [main, candidate], title: "Published latency",
			body: `## Overview\n\nPublished fact [[${entries[0]!.id}]]. Incoming fact [[${entries[1]!.id}]].\n` },
		[], [],
	);
	writeJson(join(root, "work", "groups", "latency", "result.json"), good);
	await submit();
	assert.deepEqual(missingCuratorWorkspaceResults(root), []);
	writeJson(join(root, "work", "groups", "latency", "result.json"), { ...good, pages: [{ ...good.pages[0]!, description: "Edited after submission" }] });
	assert.deepEqual(missingCuratorWorkspaceResults(root), ["latency"],
		"a result edited after submission is no longer delivered");
	await assert.rejects(
		tool!.execute("test", { group_id: "unknown-workset" }, undefined as never, undefined as never, undefined as never),
		/Unknown Workset 'unknown-workset'; assigned Worksets: latency/u,
	);
}

async function testRetainedMainPage(root: string): Promise<void> {
	const main = "MAIN:concept:cloning";
	const candidate = "S001:entity:xvoice";
	const entries = ["8", "9"].map((suffix) => ({
		id: `entry:${suffix.repeat(24)}`,
		revisionSha256: suffix.repeat(64),
		sourceRunId: "run-test",
		sourceId: `source:${suffix}`,
		sourceTitle: `Source ${suffix}`,
		canonicalLocator: `https://example.test/${suffix}`,
		members: [],
		section: "Architecture",
		cue: "Cue",
		detail: "Detail",
		anchors: [{ path: "document.md", startLine: 1, endLine: 1, sha256: suffix.repeat(64) }],
	}));
	const mainBody = `## Overview\n\nPublished fact with 24 layers [[${entries[0]!.id}]].\n`;
	writeJson(join(root, "input", "pages.json"), {
		[main]: {
			ref: main, shard_id: "MAIN", kind: "concept", title: "Cross-lingual cloning",
			description: "Published concept", primary_topic_ref: "T1", topic_refs: ["T1"],
			path: "concepts/cloning.md", body: mainBody,
		},
		[candidate]: {
			ref: candidate, shard_id: "S001", kind: "entity", title: "X-Voice",
			description: "Incoming entity", primary_topic_ref: "T1", topic_refs: ["T1"],
			path: "entities/xvoice.md", body: `## Overview\n\nIncoming fact [[${entries[1]!.id}]].\n`,
		},
	});
	writeJson(join(root, "input", "entries.json"), entries);
	writeJson(join(root, "input", "notes.json"), entries);
	writeJson(join(root, "input", "topic-plan.json"), topicPlan);
	writeJson(join(root, "input", "deferred.json"), []);
	writeJson(join(root, "input", "relations.json"), []);
	writeJson(join(root, "input", "index.json"), { incoming_pages: [], suggested_groups: [], topic_plan: {}, language: "en" });
	const plan = { groups: [{ group_id: "xvoice", members: [main, candidate] }] };
	writeJson(join(root, "work", "plan.json"), plan);
	writeJson(join(root, "state", "plan.json"), plan);
	const [tool] = createCuratorWorksetTools(root);
	const submit = () => tool!.execute("test", { group_id: "xvoice" }, undefined as never, undefined as never, undefined as never);
	const resultPath = join(root, "work", "groups", "xvoice", "result.json");
	const xvoicePage = {
		member_refs: [candidate], kind: "entity", title: "X-Voice", description: "Incoming entity",
		primary_topic_ref: "T1", topic_refs: ["T1"], body: `## Overview\n\nIncoming fact [[${entries[1]!.id}]].\n`,
	};
	// Only a published Page has a version worth keeping.
	writeJson(resultPath, { group_id: "xvoice", pages: [], retained_member_refs: [main, candidate], discarded_member_refs: [], deferred_entries: [] });
	await assert.rejects(submit(), /field 'retained_member_refs': may keep only already published MAIN Pages unchanged.*'S001:entity:xvoice'/u);
	// Keeping the old version and rewriting it under the same identity are contradictory.
	writeJson(resultPath, {
		group_id: "xvoice",
		pages: [{ ...xvoicePage, member_refs: [], kind: "concept", title: "Cross-lingual cloning", description: "Rewritten" }],
		retained_member_refs: [main], discarded_member_refs: [candidate], deferred_entries: [],
	});
	await assert.rejects(submit(), /'MAIN:concept:cloning' \(Cross-lingual cloning\) is retained unchanged but pages\[0\] rewrites that same identity/u);
	// The inspected MAIN Page needs no disposition of its own Entries: it keeps citing them itself.
	writeJson(resultPath, { group_id: "xvoice", pages: [xvoicePage], retained_member_refs: [main], discarded_member_refs: [], deferred_entries: [] });
	await submit();
	assert.deepEqual(missingCuratorWorkspaceResults(root), []);
	// Aggregation carries it through byte for byte, and the relation pass sees it as a link target only.
	writeJson(join(root, "state", "groups", "xvoice.json"), JSON.parse(readFileSync(resultPath, "utf-8")));
	const knowledge = join(root, "knowledge");
	materializeCuratorEdition(root, knowledge);
	const concepts = readdirSync(join(knowledge, "concepts")).map((file) => readFileSync(join(knowledge, "concepts", file), "utf-8"));
	assert.equal(concepts.length, 1);
	assert.match(concepts[0]!, /Published fact with 24 layers/u, "a retained MAIN Page keeps its body");
	assert.equal(readdirSync(join(knowledge, "entities")).length, 1);
	assert.deepEqual(JSON.parse(readFileSync(join(knowledge, ".deferred-notes.json"), "utf-8")), []);
	assert.equal(prepareCuratorRelationWorkspace(root, "relation contract"), 1, "only the rewritten Page is a modified Page");
	const assignment = JSON.parse(readFileSync(join(root, "work", "relation-assignment.json"), "utf-8")) as { owned_pages: Array<{ ref: string }>; catalog: Array<{ ref: string }> };
	assert.deepEqual(assignment.owned_pages.map((page) => page.ref), [candidate]);
	assert.deepEqual(assignment.catalog.map((page) => page.ref).sort(), [main, candidate].sort(), "a retained MAIN Page stays a link target");
}

function testDiscardedMainPageRescue(mergeRoot: string): void {
	const input = join(mergeRoot, "input");
	const state = join(mergeRoot, "state");
	const knowledge = join(mergeRoot, "knowledge");
	mkdirSync(join(state, "groups"), { recursive: true });
	const main = "MAIN:concept:latency";
	const candidate = "S001:concept:budget";
	const entries = ["4", "5"].map((suffix) => ({
		id: `entry:${suffix.repeat(24)}`,
		revisionSha256: suffix.repeat(64),
		sourceRunId: "run-test",
		sourceId: `source:${suffix}`,
		sourceTitle: `Source ${suffix}`,
		canonicalLocator: `https://example.test/${suffix}`,
		members: [],
		section: "Architecture",
		cue: "Cue",
		detail: "Detail",
		anchors: [{ path: "document.md", startLine: 1, endLine: 1, sha256: suffix.repeat(64) }],
	}));
	writeJson(join(input, "pages.json"), {
		[main]: {
			ref: main, shard_id: "MAIN", kind: "concept", title: "Streaming latency",
			description: "Published latency knowledge", primary_topic_ref: "T1", topic_refs: ["T1"],
			path: "concepts/latency.md", body: `## Overview\n\nPublished fact [[${entries[0]!.id}]].\n`,
		},
		[candidate]: {
			ref: candidate, shard_id: "S001", kind: "concept", title: "Latency budget",
			description: "Incoming budget view", primary_topic_ref: "T1", topic_refs: ["T1"],
			path: "concepts/budget.md", body: `## Overview\n\nIncoming fact [[${entries[1]!.id}]].\n`,
		},
	});
	writeJson(join(input, "entries.json"), entries);
	writeJson(join(input, "deferred.json"), []);
	writeJson(join(input, "topic-plan.json"), topicPlan);
	writeJson(join(input, "relations.json"), []);
	writeJson(join(state, "plan.json"), { groups: [{ group_id: "latency", members: [main, candidate] }] });
	// Dropping a published MAIN Page is never the Curator's call, but rejecting the Workset for it
	// spends the repair budget on a judgement the rejection cannot express and loses the batch.
	writeJson(join(state, "groups", "latency.json"), {
		group_id: "latency",
		pages: [{
			member_refs: [candidate], kind: "concept", title: "Latency budget", description: "Incoming budget view",
			primary_topic_ref: "T1", topic_refs: ["T1"],
			body: `## Overview\n\nIncoming fact [[${entries[1]!.id}]].\n`,
		}],
		discarded_member_refs: [main],
		deferred_entries: [{ entry_ref: entries[0]!.id, reason: "Superseded by the incoming budget view" }],
	});
	materializeCuratorEdition(mergeRoot, knowledge);
	const rescued = readdirSync(join(knowledge, "concepts"))
		.map((file) => readFileSync(join(knowledge, "concepts", file), "utf-8"));
	assert.equal(rescued.length, 2, "a discarded MAIN Page must survive instead of failing its Workset");
	assert.equal(rescued.some((body) => body.includes("Published fact")), true, "the rescued MAIN Page keeps its body");
	assert.equal(rescued.some((body) => body.includes("Incoming fact")), true);
	assert.deepEqual(JSON.parse(readFileSync(join(knowledge, ".deferred-notes.json"), "utf-8")), [],
		"the rescued Page cites its Entry, so the deferral no longer applies");
	// When an output Page already carries that identity the knowledge survives there, so rescuing
	// the stale MAIN Page would only duplicate it.
	writeJson(join(state, "groups", "latency.json"), {
		group_id: "latency",
		pages: [{
			member_refs: [candidate], kind: "concept", title: "Streaming latency",
			description: "Rewritten latency knowledge", primary_topic_ref: "T1", topic_refs: ["T1"],
			body: `## Overview\n\nPublished fact [[${entries[0]!.id}]]. Incoming fact [[${entries[1]!.id}]].\n`,
		}],
		discarded_member_refs: [main],
		deferred_entries: [],
	});
	materializeCuratorEdition(mergeRoot, knowledge);
	assert.equal(readdirSync(join(knowledge, "concepts")).length, 1,
		"an output Page claiming the identity keeps it, without a duplicate rescue");
}

function testShardRelationLabels(): void {
	const source = "S001:entity:source";
	const target = "S001:entity:target";
	const page = {
		ref: source,
		shard_id: "S001",
		kind: "entity",
		title: "Source",
		description: "Source page",
		path: "entities/source.md",
		body: [
			"---",
			'title: "Source"',
			"---",
			"# Source",
			"",
			"## Overview",
			"",
			"Grounded prose.",
			"",
			"## Related",
			"",
			"- [Target](target.md) - optimizes its cascade pipeline",
			"",
			"## Evidence",
			"",
		].join("\n"),
	} as const;
	const localized = localizeShardPage(page, new Map([["entities/target.md", target]]));
	assert.deepEqual(localized.relations, [{
		from_ref: source,
		to_ref: target,
		label: "optimizes its cascade pipeline",
	}]);
	assert.throws(() => localizeShardPage(page, new Map()), /links to unknown Page/u);
	assert.throws(() => localizeShardPage({ ...page, body: page.body.replace("Grounded prose.", "Grounded prose.[^1]") },
		new Map([["entities/target.md", target]])), /cites unknown footnote/u);
}

function testCuratorIndex(testRoot: string): void {
	const main = join(testRoot, "main");
	const next = join(testRoot, "next");
	const registryEntry = {
		id: "entry:aaaaaaaaaaaaaaaaaaaaaaaa", revisionSha256: "a".repeat(64), sourceRunId: "run-test",
		sourceId: "source:a", sourceTitle: "Source A", canonicalLocator: "https://example.test/a", members: [],
		section: "Architecture", cue: "Cue", detail: "Detail",
		topicRefs: ["model-architecture", "retired-topic"], topicPlanRevision: "test-v1",
		anchors: [{ path: "document.md", startLine: 1, endLine: 1, sha256: "a".repeat(64) }],
	};
	for (const [knowledgeRoot, pageId, title] of [[main, "main-page", "Existing model"], [next, "next-page", "Incoming model"]]) {
		mkdirSync(join(knowledgeRoot, "entities"), { recursive: true });
		writeJson(join(knowledgeRoot, ".note-registry.json"), { schema_version: 2, contract_version: 15, entries: [registryEntry] });
		writeJson(join(knowledgeRoot, ".deferred-notes.json"), []);
		writeFileSync(join(knowledgeRoot, "entities", `${pageId}.md`), [
			"---",
			`page_id: ${JSON.stringify(`entity:${pageId}`)}`,
			"type: entity",
			`title: ${JSON.stringify(title)}`,
			`description: ${JSON.stringify(`${title} description`)}`,
			'primary_topic_ref: "model-architecture"',
			'topic_refs: ["model-architecture"]',
			"entry_ids: []",
			"sources: []",
			"---",
			`# ${title}`,
			"",
			"## Overview",
			"",
			`${title} grounded body.`,
			"",
			"## Evidence",
			"",
		].join("\n"));
	}
	const mergeRoot = join(testRoot, "merge");
	prepareCuratorInput(mergeRoot, [
		{ id: "MAIN", knowledgeRoot: main },
		{ id: "DRAFT001", knowledgeRoot: next },
	], topicPlan, "update", "zh-CN");
	assert.equal((JSON.parse(readFileSync(join(mergeRoot, "input", "index.json"), "utf-8")) as { language: string }).language, "zh-CN",
		"Curator children read the Wiki language from Runtime-written input");
	const index = JSON.parse(readFileSync(join(mergeRoot, "input", "index.json"), "utf-8")) as {
		main_page_count: number;
		incoming_pages: Array<{ ref: string; topic_refs?: string[] }>;
		topic_plan: { revision: string; topics: Array<{ ref?: string; id?: string }> };
		pages?: unknown;
	};
	assert.equal(index.main_page_count, 1);
	assert.deepEqual(index.incoming_pages.map((page) => page.ref), ["DRAFT001:entity:next-page"]);
	assert.equal(index.topic_plan.revision, "test-v1");
	assert.deepEqual(index.topic_plan.topics.map((topic) => [topic.ref, topic.id]), [["T1", undefined], ["T2", undefined]],
		"Curator input must expose short Topic refs instead of canonical Topic IDs");
	assert.deepEqual(index.incoming_pages[0]?.topic_refs, ["T1"]);
	const notes = JSON.parse(readFileSync(join(mergeRoot, "input", "notes.json"), "utf-8")) as Array<{ topicRefs: string[] }>;
	assert.deepEqual(notes.map((note) => note.topicRefs), [["T1"]],
		"Cornell Entry suggestions reach the Agent as short refs, and refs outside the active Plan are dropped");
	assert.deepEqual((JSON.parse(readFileSync(join(mergeRoot, "input", "entries.json"), "utf-8")) as Array<{ topicRefs: string[] }>)
		.map((entry) => entry.topicRefs), [["model-architecture", "retired-topic"]],
		"the durable Note Registry keeps canonical Topic refs, including retired ones");
	for (const file of ["index.json", "main-index.json", "pages.json", "notes.json"]) {
		assert.doesNotMatch(readFileSync(join(mergeRoot, "input", file), "utf-8"), /model-architecture|production-deployment/u,
			`${file} must not carry a canonical Topic ID the Agent could transcribe`);
	}
	assert.equal(index.pages, undefined, "Root index must not expose the accumulated MAIN page catalog");
	assert.equal((JSON.parse(readFileSync(join(mergeRoot, "input", "main-index.json"), "utf-8")) as unknown[]).length, 1);
	const nextPage = join(next, "entities", "next-page.md");
	writeFileSync(nextPage, readFileSync(nextPage, "utf-8").replace("Incoming model description", "Updated incoming description"));
	prepareCuratorInput(mergeRoot, [
		{ id: "MAIN", knowledgeRoot: main },
		{ id: "DRAFT001", knowledgeRoot: next },
	], topicPlan, "update", "zh-CN");
	const refreshed = JSON.parse(readFileSync(join(mergeRoot, "input", "index.json"), "utf-8")) as {
		incoming_pages: Array<{ description: string }>;
	};
	assert.equal(refreshed.incoming_pages[0]?.description, "Updated incoming description",
		"changed draft input must invalidate persisted Curator state");
}

async function testCuratorWorkspace(testRoot: string): Promise<void> {
	mkdirSync(join(testRoot, "input"), { recursive: true });
	writeJson(join(testRoot, "input", "index.json"), {
		incoming_pages: [{ ref: "NEXT:entity:new", shard_id: "NEXT", kind: "entity", title: "New", description: "New entity" }],
		suggested_groups: [],
		topic_plan: topicPlan,
		language: "zh-CN",
	});
	writeJson(join(testRoot, "input", "main-index.json"), [
		{ ref: "MAIN:entity:old", shard_id: "MAIN", kind: "entity", title: "Old", description: "Old entity" },
	]);
	writeJson(join(testRoot, "input", "pages.json"), {
		"MAIN:entity:old": { ref: "MAIN:entity:old", shard_id: "MAIN", kind: "entity", title: "Old", description: "Old entity",
			primary_topic_ref: "T1", topic_refs: ["T1"], body: `## Old\n\nOld fact [[entry:${"a".repeat(24)}]].\n` },
		"NEXT:entity:new": { ref: "NEXT:entity:new", shard_id: "NEXT", kind: "entity", title: "New", description: "New entity",
			primary_topic_ref: "T1", topic_refs: ["T1"], body: `## New\n\nNew fact [[entry:${"b".repeat(24)}]].\n` },
	});
	writeJson(join(testRoot, "input", "entries.json"), ["a", "b"].map((suffix) => ({
		id: `entry:${suffix.repeat(24)}`, revisionSha256: suffix.repeat(64), sourceRunId: "run-test",
		sourceId: `source:${suffix}`, sourceTitle: `Source ${suffix}`, canonicalLocator: `https://example.test/${suffix}`,
		members: [], section: "Architecture", cue: "Cue", detail: "Detail",
		anchors: [{ path: "document.md", startLine: 1, endLine: 1, sha256: suffix.repeat(64) }],
	})));
	writeJson(join(testRoot, "input", "notes.json"), JSON.parse(readFileSync(join(testRoot, "input", "entries.json"), "utf-8")));
	writeJson(join(testRoot, "input", "deferred.json"), []);
	writeJson(join(testRoot, "input", "relations.json"), []);
	writeJson(join(testRoot, "input", "topic-plan.json"), topicPlan);
	writeJson(join(testRoot, "work", "plan.json"), { groups: [] });
	assert.throws(() => prepareCuratorWorkspace(testRoot, "contract"),
		/\[wiki-curator:plan\] file 'work\/plan\.json', field 'groups': must contain at least one Workset/u);
	// A split identity group is reported as facts the Curator can act on: where each member sits.
	writeJson(join(testRoot, "input", "index.json"), {
		incoming_pages: [{ ref: "NEXT:entity:new", shard_id: "NEXT", kind: "entity", title: "New", description: "New entity" }],
		suggested_groups: [{ group_id: "identity-1", identity: "entity:old", members: ["MAIN:entity:old", "NEXT:entity:new"] }],
		topic_plan: topicPlan,
		language: "zh-CN",
	});
	writeJson(join(testRoot, "work", "plan.json"), { groups: [{ group_id: "alone", members: ["NEXT:entity:new"] }] });
	assert.throws(() => prepareCuratorWorkspace(testRoot, "contract"),
		/suggested identity group 'identity-1' is split: MAIN:entity:old in no group, NEXT:entity:new in group 'alone'/u);
	writeJson(join(testRoot, "work", "plan.json"), {
		groups: [{ group_id: "identity", members: ["MAIN:entity:old", "NEXT:entity:new"] }],
	});
	prepareCuratorWorkspace(testRoot, "child contract");
	assert.deepEqual(missingCuratorWorkspaceResults(testRoot), ["identity"]);
	assert.match(readFileSync(join(testRoot, "work", "child-contract.md"), "utf-8"), /child contract/u);
	assert.deepEqual(JSON.parse(readFileSync(join(testRoot, "work", "assignments", "identity.json"), "utf-8")) as { pages_path: string; entries_path: string },
		{ group: { group_id: "identity", members: ["MAIN:entity:old", "NEXT:entity:new"] },
			rows: [
				{ ref: "MAIN:entity:old", shard_id: "MAIN", kind: "entity", title: "Old", description: "Old entity" },
				{ ref: "NEXT:entity:new", shard_id: "NEXT", kind: "entity", title: "New", description: "New entity" },
			],
			topic_plan: topicPlan,
			language: "zh-CN",
			pages_path: "input/pages.json",
			entries_path: "input/notes.json",
			output_path: "work/groups/identity/result.json" });
	writeJson(join(testRoot, "work", "groups", "identity", "result.json"), {
		group_id: "identity",
		pages: [{
			member_refs: ["MAIN:entity:old", "NEXT:entity:new"], kind: "entity", title: "New", description: "Merged entity",
			primary_topic_ref: "T1", topic_refs: ["T1"],
			body: `## Overview\n\nOld fact [[entry:${"a".repeat(24)}]]. New fact [[entry:${"b".repeat(24)}]].\n`,
		}],
		discarded_member_refs: [],
		deferred_entries: [],
	});
	// Staging is the last gate before the Edition and does not re-run the group-local rules, so it
	// only accepts a result the child actually submitted.
	assert.throws(() => stageCuratorWorkspaceResults(testRoot), /was never submitted with submit_workset/u);
	await createCuratorWorksetTools(testRoot)[0]!
		.execute("test", { group_id: "identity" }, undefined as never, undefined as never, undefined as never);
	stageCuratorWorkspaceResults(testRoot);
	assert.ok(existsSync(join(testRoot, "state", "groups", "identity.json")));
	assert.equal(prepareCuratorRelationWorkspace(testRoot, "relation contract"), 1);
	assert.equal(curatorRelationsMissing(testRoot), true);
	writeJson(join(testRoot, "work", "relations", "result.json"), {
		concept_merges: [],
		owned_refs: ["MAIN:entity:old"],
		relations: [{ from_ref: "MAIN:entity:old", to_ref: "unknown", label: "uses" }],
	});
	assert.throws(() => stageCuratorRelations(testRoot),
		/\[wiki-curator:relations\] file 'work\/relations\/result\.json', field 'relations\[0\]\.to_ref': must reference a known final catalog Page/u);
	writeJson(join(testRoot, "work", "relations", "result.json"), { concept_merges: [], owned_refs: ["MAIN:entity:old"], relations: [] });
	stageCuratorRelations(testRoot);
	assert.ok(existsSync(join(testRoot, "state", "relations.json")));
	// Staging reports every unusable Workset result at once: stopping at the first one spends the
	// whole repair budget one Workset at a time.
	writeJson(join(testRoot, "input", "index.json"), {
		incoming_pages: [
			{ ref: "NEXT:entity:new", shard_id: "NEXT", kind: "entity", title: "New", description: "New entity" },
			{ ref: "NEXT:entity:other", shard_id: "NEXT", kind: "entity", title: "Other", description: "Other entity" },
		],
		suggested_groups: [],
		topic_plan: topicPlan,
		language: "zh-CN",
	});
	writeJson(join(testRoot, "work", "plan.json"), { groups: [
		{ group_id: "identity", members: ["MAIN:entity:old", "NEXT:entity:new"] },
		{ group_id: "other", members: ["NEXT:entity:other"] },
	] });
	prepareCuratorWorkspace(testRoot, "child contract");
	writeFileSync(join(testRoot, "work", "groups", "identity", "result.json"), "{ truncated");
	assert.throws(() => stageCuratorWorkspaceResults(testRoot), (error: unknown) => {
		const message = String(error);
		assert.match(message, /file 'work\/groups\/identity\/result\.json', field '\$': must be valid JSON/u);
		assert.match(message, /file 'work\/groups\/other\/result\.json', field '\$': required file is missing/u);
		return true;
	}, "one repair round must see every unusable Workset result");
}

function testConceptCoordination(testRoot: string): void {
	for (const mode of ["derived", "same-title", "published"] as const) {
		const root = join(testRoot, mode);
		const knowledge = join(root, "knowledge");
		const entries = ["a", "b"].map((suffix) => ({
			id: `entry:${suffix.repeat(24)}`, revisionSha256: suffix.repeat(64), sourceRunId: "run-test",
			sourceId: `source:${suffix}`, sourceTitle: `Source ${suffix}`, canonicalLocator: `https://example.test/${suffix}`,
			members: [], section: "Architecture", cue: "Tradeoff", detail: `Evidence ${suffix}`,
			anchors: [{ path: "document.md", startLine: 1, endLine: 1, sha256: suffix.repeat(64) }],
		}));
		const entityRefs = ["NEXT:entity:first", "NEXT:entity:second"];
		const conceptRefs = mode === "published" ? ["MAIN:concept:first", "MAIN:concept:second"] : ["DERIVED:first:2", "DERIVED:second:2"];
		const concepts = conceptRefs.map((ref, index) => ({
			ref, shard_id: "MAIN", kind: "concept", title: index === 0 || mode === "same-title" ? "Latency quality tradeoff" : "Streaming fidelity budget",
			description: "The balance between streaming delay and output quality.", primary_topic_ref: "T1", topic_refs: ["T1"],
			body: `## Tradeoff\n\nEvidence ${index + 1} [[${entries[index]!.id}]].\n`,
		}));
		const entities = entityRefs.map((ref, index) => ({
			ref, shard_id: "NEXT", kind: "entity", title: `Model ${index + 1}`, description: "A concrete model.",
			primary_topic_ref: "T1", topic_refs: ["T1"], body: `## Model\n\nModel fact [[${entries[index]!.id}]].\n`,
		}));
		const untouched = { ...entities[0]!, ref: "MAIN:entity:untouched", shard_id: "MAIN", title: "Unchanged model" };
		writeJson(join(root, "input", "pages.json"), Object.fromEntries([
			...entities, untouched, ...(mode === "published" ? concepts : []),
		].map((page) => [page.ref, page])));
		writeJson(join(root, "input", "entries.json"), entries);
		writeJson(join(root, "input", "notes.json"), entries);
		writeJson(join(root, "input", "deferred.json"), []);
		writeJson(join(root, "input", "topic-plan.json"), topicPlan);
		writeJson(join(root, "input", "index.json"), { language: "en", topic_plan: topicPlan });
		writeJson(join(root, "input", "relations.json"), mode === "published" ? [
			{ from_ref: untouched.ref, to_ref: conceptRefs[1], label: "uses the tradeoff" },
			{ from_ref: conceptRefs[1], to_ref: conceptRefs[0], label: "related perspective" },
		] : []);
		writeJson(join(root, "state", "plan.json"), { groups: entities.map((page, index) => ({
			group_id: index === 0 ? "first" : "second", members: [page.ref],
		})) });
		for (const [index, entity] of entities.entries()) {
			const group = index === 0 ? "first" : "second";
			writeJson(join(root, "state", "groups", `${group}.json`), {
				group_id: group, pages: [{ ...entity, member_refs: [entity.ref] },
					...(mode === "published" ? [] : [{ ...concepts[index], member_refs: [] }])],
				discarded_member_refs: [], deferred_entries: [],
			});
		}
		mkdirSync(join(root, "work"), { recursive: true });
		if (mode === "same-title") {
			assert.throws(() => validateCuratorWorksets(root), /duplicate Page identity.*first.*second/u,
				"same-title Concepts must return to Workset repair, where independent concepts can be renamed");
			assert.throws(() => materializeCuratorEdition(root, knowledge), /duplicate Page identity/u);
			const repairPath = join(root, "state", "groups", "second.json");
			const repaired = JSON.parse(readFileSync(repairPath, "utf-8"));
			repaired.pages[1].title = "Latency measurement conditions";
			writeJson(repairPath, repaired);
		}
		assert.doesNotThrow(() => validateCuratorWorksets(root), "distinct titles can proceed without forcing a semantic merge");
		assert.equal(existsSync(knowledge), false, "precheck never publishes a partial Edition");
		prepareCuratorRelationWorkspace(root, "coordination contract");
		const assignment = JSON.parse(readFileSync(join(root, "work", "relation-assignment.json"), "utf-8"));
		assert.equal(assignment.concepts_path, "work/relation-concepts.json");
		assert.equal(assignment.entries_path, "input/notes.json");
		assert.deepEqual(assignment.topic_plan.topics.map((topic: { ref: string }) => topic.ref), ["T1", "T2"]);
		const availableConcepts = JSON.parse(readFileSync(join(root, assignment.concepts_path), "utf-8")) as Array<{ ref: string; body: string; topic_refs: string[] }>;
		assert.deepEqual(availableConcepts.map((page) => page.ref).sort(), [...conceptRefs].sort());
		for (const [index, ref] of conceptRefs.entries()) {
			const page = availableConcepts.find((page) => page.ref === ref)!;
			assert.ok(page.body.includes(entries[index]!.id), "coordination reads complete evidence from both Worksets or untouched MAIN Pages");
			assert.deepEqual(page.topic_refs, ["T1"]);
		}
		const resultPath = join(root, "work", "relations", "result.json");
		const originalOwned = assignment.owned_pages.map((page: { ref: string }) => page.ref);
		writeJson(resultPath, { concept_merges: [], owned_refs: originalOwned, relations: [] });
		{
			materializeCuratorEdition(root, knowledge);
			const originalBodies = readdirSync(join(knowledge, "concepts")).map((file) => readFileSync(join(knowledge, "concepts", file), "utf-8"));
			stageCuratorRelations(root);
			materializeCuratorEdition(root, knowledge);
			assert.equal(readdirSync(join(knowledge, "concepts")).length, 2, "no-op coordination preserves independent Concepts");
			assert.deepEqual(readdirSync(join(knowledge, "concepts")).map((file) => readFileSync(join(knowledge, "concepts", file), "utf-8")), originalBodies,
				"no-op coordination preserves Concept bodies and their existing relations byte for byte");
			if (mode === "published") {
				const entityBody = readFileSync(join(knowledge, "entities", `${sha256(`entity:${untouched.title}`).slice(0, 16)}.md`), "utf-8");
				assert.match(entityBody, /uses the tradeoff/u, "no-op coordination preserves untouched relations");
			}
		}
		const merge = {
			member_refs: conceptRefs, keep_ref: conceptRefs[0], title: "Streaming latency and quality",
			description: "Delay and fidelity tradeoffs across models.", primary_topic_ref: "T1", topic_refs: ["T1"],
			body: `## Tradeoff\n\nEvidence 1 [[${entries[0]!.id}]]. Evidence 2 [[${entries[1]!.id}]].\n`,
		};
		const result = {
			concept_merges: [merge], owned_refs: [...entityRefs, conceptRefs[0]],
			relations: [{ from_ref: entityRefs[0], to_ref: conceptRefs[0], label: "uses coordinated concept" }],
		};
		for (const [label, invalid] of [
			["Entity merge", { ...merge, member_refs: [entityRefs[0], conceptRefs[0]] }],
			["unknown member", { ...merge, member_refs: [conceptRefs[0], "MAIN:concept:unknown"] }],
			["lost evidence", { ...merge, body: `## Tradeoff\nOnly one fact [[${entries[0]!.id}]].` }],
			["unknown evidence", { ...merge, body: `${merge.body}\nUnsupported [[entry:${"c".repeat(24)}]].` }],
			["unknown survivor", { ...merge, keep_ref: "MAIN:concept:unknown" }],
			["unknown Topic", { ...merge, primary_topic_ref: "T99", topic_refs: ["T99"] }],
		] as const) {
			writeJson(resultPath, { ...result, concept_merges: [invalid] });
			assert.throws(() => stageCuratorRelations(root), /concept_merges/u, label);
		}
		writeJson(resultPath, { owned_refs: result.owned_refs, relations: [] });
		assert.throws(() => stageCuratorRelations(root), /concept_merges/u, "coordination must explicitly record even an empty merge decision");
		writeJson(resultPath, { ...result, owned_refs: entityRefs });
		assert.throws(() => stageCuratorRelations(root), /owned_refs/u, "the coordinator owns the survivor even when merging only old Pages");
		writeJson(resultPath, { ...result, concept_merges: [merge, merge] });
		assert.throws(() => stageCuratorRelations(root), /concept_merges/u, "a Concept cannot belong to overlapping merges");
		writeJson(resultPath, { ...result, relations: [{ from_ref: entityRefs[0], to_ref: conceptRefs[1], label: "stale target" }] });
		assert.throws(() => stageCuratorRelations(root), /to_ref/u, "new relations must point to surviving refs");
		writeJson(resultPath, result);
		stageCuratorRelations(root);
		materializeCuratorEdition(root, knowledge);
		const files = readdirSync(join(knowledge, "concepts"));
		assert.equal(files.length, 1, "cross-Workset and old-old duplicates become one Concept");
		const body = readFileSync(join(knowledge, "concepts", files[0]!), "utf-8");
		for (const entry of entries) assert.ok(body.includes(entry.id), "the merged Concept preserves the union of member evidence");
		assert.match(body, /Evidence 1/u);
		assert.match(body, /Evidence 2/u);
		assert.doesNotMatch(body, /related perspective/u, "merging must not leave a self-link");
		for (const [ref, label] of [[entityRefs[0], "uses coordinated concept"], ...(mode === "published" ? [[untouched.ref, "uses the tradeoff"]] : [])]) {
			const title = ref === untouched.ref ? untouched.title : entities[0]!.title;
			const entityBody = readFileSync(join(knowledge, "entities", `${sha256(`entity:${title}`).slice(0, 16)}.md`), "utf-8");
			assert.ok(entityBody.includes(`../concepts/${files[0]}`), "incoming links resolve to the merged Concept");
			assert.ok(entityBody.includes(label!));
		}
		assert.deepEqual(JSON.parse(readFileSync(join(knowledge, ".deferred-notes.json"), "utf-8")), []);
		writeJson(join(root, "state", "commit.json"), { accepted: true });
		for (const invalid of [
			{ ...merge, member_refs: [entityRefs[0], conceptRefs[0]] },
			{ ...merge, body: `## Tradeoff\nOnly one fact [[${entries[0]!.id}]].` },
		]) {
			writeJson(join(root, "state", "relations.json"), { ...result, concept_merges: [invalid] });
			assert.throws(() => materializeCuratorEdition(root, knowledge), /concept_merges/u,
				"committed state must not bypass merge or evidence validation during direct materialization");
			assert.equal(readFileSync(join(knowledge, "concepts", files[0]!), "utf-8"), body,
				"invalid restored state must leave the last valid Edition intact");
		}
		writeJson(join(root, "state", "relations.json"), result);
		if (mode === "published") {
			const acceptedResult = readFileSync(resultPath, "utf-8");
			prepareCuratorRelationWorkspace(root, "coordination contract");
			assert.equal(readFileSync(resultPath, "utf-8"), acceptedResult, "unchanged coordination input preserves the result");
			const inputPath = join(root, "input", "pages.json");
			const pages = JSON.parse(readFileSync(inputPath, "utf-8"));
			pages[conceptRefs[0]!].body += "\nA clarified explanation of the same evidence.\n";
			writeJson(inputPath, pages);
			prepareCuratorRelationWorkspace(root, "coordination contract");
			assert.equal(existsSync(resultPath), false, "changed Concept body invalidates the result even when refs and catalog metadata are unchanged");
			writeJson(resultPath, result);
			prepareCuratorRelationWorkspace(root, "revised coordination contract");
			assert.equal(existsSync(resultPath), false, "changed coordination contract invalidates the previous result");
			writeJson(resultPath, result);
			prepareCuratorRelationWorkspace(root, "revised coordination contract");
			assert.equal(readFileSync(resultPath, "utf-8"), acceptedResult, "stable revised inputs preserve the result");
		}
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
