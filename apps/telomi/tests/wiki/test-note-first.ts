import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { readObjectFirstPrevious, writeObjectFirstEdition } from "../../server/wiki/object-first-edition.js";
import { noteWikiEntries } from "../../server/wiki/note-wiki-maintainer.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { CornellNotesSnapshot } from "../../server/cornell/contracts.js";
import type { GoalTopicPlan, WikiCompilationRequest } from "../../server/wiki/contracts.js";
import { hashWikiDirectory } from "../../server/wiki/files.js";
import { NoteFirstWikiCompiler } from "../../server/wiki/note-first-compiler.js";
import type { NoteFirstInput, NoteFirstOutcome, NoteFirstResult, NoteFirstStageRequest } from "../../server/wiki/note-first-contract.js";
import { objectFirstEntries, type ObjectFirstPagesResult } from "../../server/wiki/object-first-contract.js";

const root = mkdtempSync(join(tmpdir(), "note-first-"));
const failureUsage = { inputTokens: 7, outputTokens: 3, costUsd: 0.04, calls: 2 };
const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0, calls: 1 };
const env = { TELOMI_WIKI_MAINTAINER_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child", TELOMI_WIKI_MAINTAINER_THINKING_LEVEL: "low" };
const plan: GoalTopicPlan = { schema_version: 1, goal_id: "goal", revision: "v1", status: "active", topics: ["training", "evaluation"].map(id => ({ id, title: id, intent: `Understand ${id}`, questions: [], include: [], exclude: [] })) };
function evidence(count: number, offset = 0): CornellNotesSnapshot {
 return { schema_version: 1, snapshot_id: "snapshot", run_id: "source-run", pipeline: { id: "cornell", version: "1", sha256: "a".repeat(64) }, source_bundle_refs: [],
  notes: Array.from({ length: count }, (_, index) => {
   const n = index + offset;
   return { note: { schema_version: 1, source_id: `source:${n}`, sections: ["Training", "Evaluation"].map((section, i) => ({ section_title: section, summary: `${section} conditions`, cue_notes: [{ cue: `${section} cue`, note: `Object ${n}: ${section} exact value 1.45%, condition ${i}.`, topic_refs: [], evidence: [{ source_path: `source-${n}.md`, content_sha256: "b".repeat(64), start_line: i + 1, end_line: i + 1 }] }] })) }, title: `Object ${n}`, canonical_locator: `https://example.test/${n}`, provider_id: "test", provenance_ref: "provider:test", source_revision_sha256: "c".repeat(64), members: [] };
  }) };
}
function request(name: string, snapshot = evidence(6), previous?: string): WikiCompilationRequest {
 const base = join(root, name), goalDir = join(base, "goal");
 ensureGoalWorkspace({ goalDir, goalId: "goal", title: "Models" });
 if (previous) cpSync(previous, join(goalDir, "wiki", "knowledge"), { recursive: true });
 const store = new RunArtifactStore(join(base, "run"));
 const notes = store.publishText(JSON.stringify(snapshot), "input/notes.json");
 return { goalDir, runId: name, runDirectory: store.root, controlDirectory: join(base, "control"), cornellNotesSnapshot: { relative_path: notes.relativePath, sha256: notes.sha256, byte_length: notes.byteLength }, goalContext: { title: "Models", description: "Compare model training and evaluation" }, topicPlan: plan, env, signal: new AbortController().signal };
}
const empty = (): ObjectFirstPagesResult => ({ pages: [], retained_refs: [], discarded_refs: [], deferred_entries: [], relations: [] });
const read = (path: string) => readFileSync(path, "utf8");
function result(input: NoteFirstInput, rename = false): NoteFirstResult {
 const consideredPages = input.requiredPages.map(pageRef => ({ pageRef, reason: "Read the object and compare its conditions" }));
 const value = empty();
 switch (input.stage) {
  case "objects": {
   assert.equal(new Set(input.entries.map(entry => entry.sourceId)).size, 1, "one Agent consumes exactly one complete Note");
   assert.equal(input.entries.length, 2, "both sections and their Cues must reach the same Agent");
   assert.deepEqual(input.requiredEntries, input.entries.map(entry => entry.id));
   const entry = input.entries[0]!;
   value.pages = [{ id: `entity:${entry.sourceId.replace(":", "-")}`, kind: "entity", title: entry.sourceTitle, description: "A model with measured conditions", body: input.entries.map(e => `## ${e.section}\n${e.detail} [[${e.id}]].`).join("\n\n"), member_refs: [] }];
   break;
  }
  case "merge-objects":
   value.pages = input.pages.filter(p => p.role === "member").map(p => ({ ...p.page, id: rename && p.page.id === "entity:source-0" ? "entity:renamed" : p.page.id, member_refs: [p.ref] }));
   break;
  case "plan-concepts":
   assert.deepEqual(input.requiredEntries, [], "concept planning receives no residual Cue worklist");
   assert.ok(input.pages.filter(p => p.page.kind === "entity").every(p => input.requiredPages.includes(p.ref)), "planning accounts for all objects");
   return { kind: "concept-plan", jobs: [{ pageRefs: input.requiredPages, entryIds: input.requiredEntries, instructions: "Compare training conditions across all models" }] };
  case "concepts": {
   const ids = [...new Set([...input.requiredEntries, ...input.pages.filter(p => input.requiredPages.includes(p.ref)).flatMap(p => objectFirstEntries(p.page.body))])];
   value.pages = [{ id: `concept:proposal-${input.entries.length}`, kind: "concept", title: "Training conditions", description: "Conditions that govern comparisons", body: `## Comparison\nCompare conditions ${ids.map(id => `[[${id}]]`).join(" ")}.`, member_refs: [] }];
   break;
  }
  case "merge-concepts": {
   const members = input.pages.filter(p => p.role === "member");
   if (members.length) value.pages = [{ ...members[0]!.page, id: "concept:conditions", body: `## Comparison\nCompare all conditions ${[...new Set(members.flatMap(p => objectFirstEntries(p.page.body)))].map(id => `[[${id}]]`).join(" ")}.`, member_refs: members.map(p => p.ref) }];
   break;
  }
  case "relations": {
   const entity = input.pages.find(p => p.page.kind === "entity")?.page;
   const concept = input.pages.find(p => p.page.kind === "concept")?.page;
   if (!entity || !concept) return { kind: "relations", relations: [], reviewedPages: consideredPages };
   return { kind: "relations", relations: input.previousRelations.length ? input.previousRelations : [{ from: entity.id, to: concept.id, label: "uses these conditions", entryIds: objectFirstEntries(entity.body) }], reviewedPages: consideredPages };
  }
  case "plan-topics": return { kind: "topic-plan", jobs: input.topics.map(topic => ({ topicId: topic.id, instructions: `Find sections about ${topic.title}` })) };
  case "topic":
   assert.equal(input.topics.length, 1, "each worker receives one Topic");
   return { kind: "topic", topicId: input.topics[0]!.id, matches: input.sections.map(section => ({ sectionRef: section.ref, reason: "Relevant model conditions" })), gaps: [] };
 }
 return { kind: "pages", value, consideredPages };
}
const outcome = (input: NoteFirstInput, rename = false): NoteFirstOutcome => ({ result: result(input, rename), usage, sessionPaths: [] });
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

try {
 const firstFour = latch(), fifthStarted = latch(), holdFirst = latch();
 const objectsStarted: string[] = [], stages: string[] = [];
 const initialInputs: NoteFirstInput[] = [];
 let active = 0, maximum = 0;
 const compiler = new NoteFirstWikiCompiler({ runStage: async ({ input }) => {
  stages.push(input.stage);
  initialInputs.push(input);
  if (input.stage === "objects") {
   objectsStarted.push(input.entries[0]!.sourceId); active++; maximum = Math.max(maximum, active);
   if (objectsStarted.length === 4) firstFour.release();
   if (objectsStarted.length === 5) fifthStarted.release();
   try { if (objectsStarted.length === 1) await holdFirst.promise; else if (objectsStarted.length <= 4) await firstFour.promise; return outcome(input); }
   finally { active--; }
  }
  if (input.stage === "merge-objects") assert.equal(active, 0, "object merging waits for all Note workers");
  return outcome(input);
 } });
 const initialRequest = request("initial");
 const compiling = compiler.compile(initialRequest);
 // A stuck first task must not prevent slot replenishment when another task finishes.
 let timeout: ReturnType<typeof setTimeout> | undefined;
 let queueError: unknown;
 try { await Promise.race([fifthStarted.promise, compiling.then(() => { throw new Error("Compiler finished before fifth Note started"); }), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Queue did not replenish a free slot")), 3000); })]); }
 catch (error) { queueError = error; }
 finally { clearTimeout(timeout); holdFirst.release(); }
 const initial = await compiling;
 assert.deepEqual(await readObjectFirstPrevious(join(initialRequest.goalDir, "wiki/knowledge")), { pages: [], entries: [], files: new Map(), relations: [] }, "A newly created Goal has an empty Wiki skeleton, not a corrupt published Edition");
 if (queueError) throw queueError;
 assert.equal(maximum, 4);
 assert.equal(objectsStarted.length, 6);
 assert.equal(stages.filter(stage => stage === "topic").length, 2);
 assert.equal(initial.pageCount, 7);
 assert.deepEqual(initial.failedBatches, []);
 assert.equal(initial.publicationReady, true);
 const finalRelations = result(initialInputs.find(input => input.stage === "relations")!);
 assert.equal(finalRelations.kind, "relations");
 if (finalRelations.kind !== "relations") throw new Error("Wrong relation output");
 for (const input of initialInputs.filter(input => input.stage === "plan-topics" || input.stage === "topic")) {
  assert.deepEqual(input.previousRelations, finalRelations.relations, "Both Topic planning and linking receive the finalized relationship graph");
  assert.equal(input.pages.filter(page => page.page.kind === "entity").length, 6);
  assert.equal(input.pages.filter(page => page.page.kind === "concept").length, 1);
 }
 const knowledge = initial.knowledge.absolutePath, originalHash = hashWikiDirectory(knowledge);
 const topicIndex = JSON.parse(read(join(knowledge, ".topic-index.json")));
 assert.equal(topicIndex.topics.length, 2);
 assert.match(read(join(knowledge, "README.md")), /entities\/source-0\.md#training/u);
 const registry = JSON.parse(read(join(knowledge, ".note-registry.json")));
 for (const entry of registry.entries) assert.ok(entry.anchors.length > 0, "every Cue preserves evidence positions");
 for (const section of topicIndex.sections) {
  assert.ok(section.entryIds.length > 0, "Topic sections expose their Cue references");
  for (const id of section.entryIds) assert.ok(registry.entries.some((entry: { id: string; anchors: unknown[] }) => entry.id === id && entry.anchors.length > 0), "section references resolve through Cue to evidence");
 }
 const training = topicIndex.sections.find((section: { pageId: string; heading: string }) => section.pageId === "entity:source-0" && section.heading === "Training");
 assert.equal(training.entryIds.length, 1, "section evidence excludes unrelated page sections");
 assert.equal(registry.entries.find((entry: { id: string }) => entry.id === training.entryIds[0]).anchors[0].startLine, 1);
 assert.match(read(join(knowledge, "entities/source-0.md")), /1\.45%/u);
 const beforeReuse = stages.length;
 assert.equal((await compiler.compile(initialRequest)).status, "reused");
 assert.equal(stages.length, beforeReuse);

 const incrementalStages: NoteFirstInput[] = [];
 const incrementalCompiler = new NoteFirstWikiCompiler({ runStage: async ({ input }) => { incrementalStages.push(input); return outcome(input, true); } });
 const incremental = await incrementalCompiler.compile(request("incremental", evidence(1, 6), knowledge));
 const planning = incrementalStages.find(input => input.stage === "plan-concepts")!;
 assert.ok(planning.pages.some(p => p.previous && p.page.kind === "concept"), "historical concepts are available to the planner");
 const relations = incrementalStages.find(input => input.stage === "relations")!;
 assert.ok(relations.previousRelations.some(edge => edge.from === "entity:renamed"), "old relation endpoints follow merged object identities");
 assert.ok(!relations.previousRelations.some(edge => edge.from === "entity:source-0"));
 assert.equal(JSON.parse(read(join(incremental.knowledge.absolutePath, ".note-registry.json"))).entries.length, 14);
 assert.equal(hashWikiDirectory(knowledge), originalHash, "incremental build leaves its source Edition immutable");

 // Legacy Editions can contain concept-only Cues and an unresolved Cue pool.
 // The first incremental Base run routes both into object merging without a rebuild.
 const legacySnapshot = evidence(1);
 legacySnapshot.notes[0]!.note.sections.push({ section_title: "Unplaced", summary: "Additional observation", cue_notes: [{ cue: "Unplaced Cue", note: "A note awaiting placement", evidence: [{ source_path: "source-0.md", content_sha256: "b".repeat(64), start_line: 3, end_line: 3 }] }] });
 const legacyEntries = noteWikiEntries(legacySnapshot, plan.revision);
 const [objectCue, conceptOnlyCue, deferredCue] = legacyEntries;
 assert.ok(objectCue && conceptOnlyCue && deferredCue);
 const legacySeed = join(root, "legacy-seed");
 writeObjectFirstEdition(legacySeed, [
  { id: "entity:legacy-method", kind: "entity", title: "Legacy method", description: "Existing method record", body: `## Method\nExisting observation [[${objectCue.id}]]` },
  { id: "concept:conditions", kind: "concept", title: "Training conditions", description: "Existing explanation", body: `## Comparison\nCondition retained only in the legacy concept [[${conceptOnlyCue.id}]]` },
 ], legacyEntries, { ...empty(), deferred_entries: [{ entry_ref: deferredCue.id, reason: "Await placement" }] }, { pages: [], entries: [], files: new Map(), relations: [] });
 rmSync(join(legacySeed, ".object-first-pages.json"));
 rmSync(join(legacySeed, ".object-first-relations.json"));
 const legacyHash = hashWikiDirectory(legacySeed);
 let legacyMergeSeen = false;
 const migrated = await new NoteFirstWikiCompiler({ runStage: async ({ input }) => {
  assert.notEqual(input.stage, "objects", "Previously accounted Notes are not unnecessarily regenerated");
  if (input.stage === "merge-objects") {
   legacyMergeSeen = true;
   assert.deepEqual(new Set(input.unplacedEntries?.map(row => row.entryId)), new Set([conceptOnlyCue.id, deferredCue.id]));
   assert.ok(input.pages.some(page => page.previous && page.role === "context" && page.page.kind === "concept"));
   const value = empty();
   value.pages = input.pages.filter(page => page.role === "member").map(page => ({ ...page.page,
    body: page.page.body + `\n\n## Additional condition\nExisting concept condition [[${conceptOnlyCue.id}]]`, member_refs: [page.ref] }));
   value.deferred_entries = [{ entry_ref: deferredCue.id, reason: "Outside the maintained object scope after review" }];
   return { result: { kind: "pages", value, consideredPages: [] }, usage, sessionPaths: [] };
  }
  if (input.stage === "plan-concepts") {
   assert.deepEqual(input.requiredEntries, []);
   assert.ok(input.pages.some(page => page.page.kind === "entity" && objectFirstEntries(page.page.body).includes(conceptOnlyCue.id)));
  }
  return outcome(input);
 } }).compile(request("legacy-migration", legacySnapshot, legacySeed));
 assert.equal(legacyMergeSeen, true);
 assert.equal(migrated.publicationReady, true);
 assert.deepEqual(JSON.parse(read(join(migrated.knowledge.absolutePath, ".discarded-cues.json"))), [{ entry_id: deferredCue.id, reason: "Outside the maintained object scope after review" }]);
 assert.equal(hashWikiDirectory(legacySeed), legacyHash, "Migration preserves its historical Edition");
 const migratedPages = await readObjectFirstPrevious(migrated.knowledge.absolutePath);
 assert.ok(migratedPages.pages.some(page => page.kind === "entity" && objectFirstEntries(page.body).includes(conceptOnlyCue.id)));
 assert.ok(migratedPages.pages.some(page => page.id === "concept:conditions" && objectFirstEntries(page.body).includes(conceptOnlyCue.id)), "Historical concept evidence survives the object-layer repair");

 const reindexStages: NoteFirstInput[] = [];
 const indexed = await new NoteFirstWikiCompiler({ runStage: async ({ input }) => { reindexStages.push(input); return outcome(input); } }).reindex({ knowledgeRoot: knowledge, topicPlan: { ...plan, revision: "v2" }, goalContext: initialRequest.goalContext, workRoot: join(root, "reindex"), env, signal: initialRequest.signal });
 assert.deepEqual(reindexStages.map(input => input.stage).sort(), ["plan-topics", "topic", "topic"]);
 for (const file of ["entities/source-0.md", "concepts/conditions.md", ".note-registry.json", ".object-first-relations.json"]) assert.equal(read(join(indexed.knowledgeRoot, file)), read(join(knowledge, file)), "Topic reindex preserves knowledge and evidence bytes");
 assert.equal(hashWikiDirectory(knowledge), originalHash);
 const savedRelations = JSON.parse(read(join(knowledge, ".object-first-relations.json")));
 for (const input of reindexStages) assert.deepEqual(input.previousRelations, savedRelations, "Topic-only reindex restores the same graph for planning and workers");

 const failedNotes: string[] = [];
 let failNote = true;
 let successfulRetryStages = 0;
 const retryRequest = request("partial");
 const retryCompiler = new NoteFirstWikiCompiler({ runStage: async ({ input }) => {
  if (input.stage === "objects") { failedNotes.push(input.entries[0]!.sourceId); if (failNote && input.entries[0]!.sourceId === "source:0") throw Object.assign(new Error("Injected single Note failure"), { usage: failureUsage, sessionPaths: ["failed-note-session"] }); }
  successfulRetryStages++;
  return outcome(input);
 } });
 const partial = await retryCompiler.compile(retryRequest);
 assert.equal(failedNotes.length, 6, "one failed Note must not stop queued Notes");
 assert.equal(partial.failedBatches.length, 1);
 assert.equal(partial.publicationReady, false, "A partial candidate is inspectable but cannot replace the published Edition");
 assert.deepEqual(partial.failedBatches[0]!.usage, failureUsage);
 assert.equal(partial.usage.calls, successfulRetryStages + failureUsage.calls, "Failed model attempts count toward compilation usage");
 assert.equal(partial.usage.inputTokens, successfulRetryStages * usage.inputTokens + failureUsage.inputTokens);
 assert.equal(partial.usage.costUsd, failureUsage.costUsd);
 assert.ok(partial.sessionPaths.includes("failed-note-session"));
 assert.match(partial.failedBatches[0]!.message, /Injected single Note failure/u);
 const partialHash = hashWikiDirectory(partial.knowledge.absolutePath);
 await assert.rejects(retryCompiler.compile(request('partial-as-seed', evidence(6), partial.knowledge.absolutePath)), /Incomplete Note-first output/u);
 failNote = false;
 const recovered = await retryCompiler.compile(retryRequest);
 assert.deepEqual(recovered.failedBatches, [], "retry repairs failed work rather than reusing a partial result");
 assert.equal(recovered.pageCount, 7);
 assert.equal(recovered.publicationReady, true);
 assert.notEqual(recovered.knowledge.absolutePath, partial.knowledge.absolutePath, "Recovery publishes a fresh artifact rather than overwriting the partial one");
 assert.equal(hashWikiDirectory(partial.knowledge.absolutePath), partialHash, "recovery preserves the earlier partial artifact");

 const deferredStages: NoteFirstInput[] = [];
 const deferredMethod = await new NoteFirstWikiCompiler({ runStage: async ({ input }) => {
  deferredStages.push(input);
  if (input.stage === "objects") return { result: { kind: "pages", value: { ...empty(), deferred_entries: input.requiredEntries.map(entry_ref => ({ entry_ref, reason: "Needs global object placement review" })) }, consideredPages: [] }, usage, sessionPaths: [] };
  if (input.stage === "merge-objects") {
   assert.equal(input.pages.length, 0);
   assert.equal(input.unplacedEntries?.length, 2, "Object merging receives all unplaced Cues and the upstream reasons");
   assert.equal(input.requiredEntries.length, 2);
   const value = empty();
   value.pages = [{ id: "entity:method", kind: "entity", title: "Recorded method", description: "Source-supported method and conditions", body: input.entries.map(entry => `## ${entry.section}\n${entry.detail} [[${entry.id}]]`).join("\n\n"), member_refs: [] }];
   return { result: { kind: "pages", value, consideredPages: [] }, usage, sessionPaths: [] };
  }
  if (input.stage === "plan-concepts" || input.stage === "concepts") {
   assert.deepEqual(input.requiredEntries, []);
   assert.ok(!input.unplacedEntries?.length);
   assert.ok(input.pages.some(page => page.page.id === "entity:method"), "Concepts derive from the object disposition rather than remaining Cue text");
  }
  return outcome(input);
 } }).compile(request("deferred-method", evidence(1)));
 assert.equal(deferredMethod.pageCount, 2, "Object merging first places the material, then concept extraction can explain it");
 assert.equal(deferredMethod.publicationReady, true);
 assert.deepEqual(JSON.parse(read(join(deferredMethod.knowledge.absolutePath, ".discarded-cues.json"))), []);
 assert.deepEqual(JSON.parse(read(join(deferredMethod.knowledge.absolutePath, ".deferred-notes.json"))), []);
 assert.ok(deferredStages.findIndex(input => input.stage === "merge-objects") < deferredStages.findIndex(input => input.stage === "concepts"));

 let failTopic = true;
 const topicRetryInputs: NoteFirstInput[] = [];
 const topicRetryCompiler = new NoteFirstWikiCompiler({ runStage: async ({ input }) => {
  topicRetryInputs.push(input);
  if (input.stage === "topic" && input.topics[0]!.id === "training" && failTopic) throw Object.assign(new Error("Injected Topic failure"), { usage: failureUsage, sessionPaths: ["failed-topic-session"] });
  return outcome(input);
 } });
 const topicRetryRequest = { knowledgeRoot: knowledge, topicPlan: plan, goalContext: initialRequest.goalContext, workRoot: join(root, "topic-failure"), env, signal: initialRequest.signal };
 const topicFailure = await topicRetryCompiler.reindex(topicRetryRequest);
 assert.equal(topicFailure.failedTopics.length, 1);
 assert.equal(topicFailure.usage.calls, 2 + failureUsage.calls, "Reindex counts failed Topic usage as well as successful planning/linking");
 assert.equal(topicFailure.usage.costUsd, failureUsage.costUsd);
 assert.ok(topicFailure.sessionPaths.includes("failed-topic-session"));
 const partialIndex = JSON.parse(read(join(topicFailure.knowledgeRoot, ".topic-index.json")));
 assert.equal(partialIndex.topics.find((topic: { topicId: string }) => topic.topicId === "training").status, "failed");
 assert.match(read(join(topicFailure.knowledgeRoot, 'README.md')), /Topic indexing failed: Injected Topic failure/u, 'a failed Topic is not rendered as an empty coverage result');
 assert.ok(partialIndex.topics.find((topic: { topicId: string }) => topic.topicId === "evaluation").sections.length > 0, "one Topic failure does not suppress successful Topic navigation");
 const partialTopicHash = hashWikiDirectory(topicFailure.knowledgeRoot);
 failTopic = false;
 const topicRecovered = await topicRetryCompiler.reindex(topicRetryRequest);
 assert.deepEqual(topicRecovered.failedTopics, []);
 assert.notEqual(topicRecovered.knowledgeRoot, topicFailure.knowledgeRoot);
 assert.equal(hashWikiDirectory(topicFailure.knowledgeRoot), partialTopicHash, "Topic retry preserves the earlier inspectable artifact");
 assert.equal(hashWikiDirectory(knowledge), originalHash, "Neither failed nor recovered navigation mutates its source Edition");
 for (const file of ["entities/source-0.md", "concepts/conditions.md", ".note-registry.json", ".object-first-relations.json", ".object-first-pages.json"]) {
  assert.equal(read(join(topicRecovered.knowledgeRoot, file)), read(join(knowledge, file)), "Retry only rebuilds Topic navigation; page bodies and graph stay byte-identical");
 }
 assert.ok(topicRetryInputs.every(input => input.stage === "plan-topics" || input.stage === "topic"));

 const incompleteNavigation = await new NoteFirstWikiCompiler({ runStage: async ({ input }) => {
  if (input.stage === "topic" && input.topics[0]!.id === "training") throw Object.assign(new Error("Navigation incomplete"), { usage: failureUsage });
  return outcome(input);
 } }).compile(request("incomplete-navigation", evidence(1)));
 assert.equal(incompleteNavigation.publicationReady, false, "Complete pages do not make a candidate publishable when Topic navigation failed");
 assert.equal(incompleteNavigation.failedBatches.length, 1);
 assert.deepEqual(incompleteNavigation.failedBatches[0]!.sourceIds, ["training"]);
 assert.equal(JSON.parse(read(join(incompleteNavigation.knowledge.absolutePath, ".note-first-status.json"))).complete, false);

 // Only genuinely empty directory trees can omit the registry. Any file or link
 // may be historical knowledge, including files skipped by Markdown enumeration.
 for (const name of ['README.md', '.object-first-pages.json', 'sources/source.txt', 'concepts/page.md']) {
  const goalDir = join(root, `nonempty-${name.replaceAll('/', '-')}`);
  ensureGoalWorkspace({ goalDir, goalId: 'goal', title: 'Models' });
  const knowledgeRoot = join(goalDir, 'wiki/knowledge'), file = join(knowledgeRoot, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, name.endsWith('.json') ? '[]' : '');
  await assert.rejects(readObjectFirstPrevious(knowledgeRoot), /missing its Note Registry/, `Existing ${name} must never be treated as an empty Wiki`);
 }
 const linkedGoal = join(root, 'linked-empty-goal');
 ensureGoalWorkspace({ goalDir: linkedGoal, goalId: 'goal', title: 'Models' });
 const linkedKnowledge = join(linkedGoal, 'wiki/knowledge');
 symlinkSync(join(linkedKnowledge, 'sources'), join(linkedKnowledge, 'alias'), 'dir');
 await assert.rejects(readObjectFirstPrevious(linkedKnowledge), /missing its Note Registry/, 'A link is not an empty skeleton directory');

 const controller = new AbortController(), cancelledStages: string[] = [];
 await assert.rejects(new NoteFirstWikiCompiler({ runStage: async ({ input, signal }: NoteFirstStageRequest) => {
  cancelledStages.push(input.stage);
  if (input.stage === "objects") { controller.abort(new Error("Injected cancellation")); signal.throwIfAborted(); }
  return outcome(input);
 } }).compile({ ...request("cancelled"), signal: controller.signal }), /Injected cancellation/u);
 assert.ok(cancelledStages.every(stage => stage === "objects"), "cancellation prevents downstream stages");
 console.log("Note-first compiler: complete Notes, dynamic queue, isolated failures, cancellation, incremental identity and Topic-only navigation passed");
} finally { rmSync(root, { recursive: true, force: true }); }
