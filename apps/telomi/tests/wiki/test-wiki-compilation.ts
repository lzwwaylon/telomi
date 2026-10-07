import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { readPreviousWikiEdition, writeWikiEdition } from "../../server/wiki/wiki-edition.js";
import { noteWikiEntries } from "../../server/wiki/note-entries.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { SourceNotesSnapshot } from "../../server/notes/contracts.js";
import type { GoalTopicPlan, WikiCompilationRequest } from "../../server/wiki/contracts.js";
import { modelDefinitionHash, pendingTaskModelSelections } from "../../server/agent-runtime/model-policy.js";
import { hashJson } from "../../server/lib/hash.js";
import { hashWikiDirectory } from "../../server/wiki/files.js";
import { WikiCompiler } from "../../server/wiki/wiki-compiler.js";
import type { WikiStageInput, WikiStageOutcome, WikiStageResult, WikiStageRequest } from "../../server/wiki/wiki-stage-contract.js";
import { wikiPageEntryIds, type WikiPagesResult } from "../../server/wiki/wiki-page-contract.js";

const root = mkdtempSync(join(tmpdir(), "wiki-compilation-"));
const failureUsage = { inputTokens: 7, outputTokens: 3, costUsd: 0.04, calls: 2 };
const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0, calls: 1 };
const env = { TELOMI_WIKI_COMPILATION_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child", TELOMI_WIKI_COMPILATION_THINKING_LEVEL: "low" };
const plan: GoalTopicPlan = { schema_version: 1, goal_id: "goal", revision: "v1", status: "active", topics: ["training", "evaluation"].map(id => ({ id, title: id, intent: `Understand ${id}`, questions: [], include: [], exclude: [] })) };
function evidence(count: number, offset = 0): SourceNotesSnapshot {
 return { schema_version: 1, snapshot_id: "snapshot", run_id: "source-run", pipeline: { id: "note", version: "1", sha256: "a".repeat(64) }, source_bundle_refs: [],
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
 return { goalDir, runId: name, runDirectory: store.root, controlDirectory: join(base, "control"), notesSnapshot: { relative_path: notes.relativePath, sha256: notes.sha256, byte_length: notes.byteLength }, goalContext: { title: "Models", description: "Compare model training and evaluation" }, topicPlan: plan, env, signal: new AbortController().signal };
}
const pendingWiki = () => pendingTaskModelSelections("wikiCompilation", "test/changed", [{ key: "wikiCompilation.maintenance", thinkingLevel: "high" }], modelDefinitionHash("test/changed", env));
const empty = (): WikiPagesResult => ({ pages: [], retained_refs: [], discarded_refs: [], deferred_entries: [], relations: [] });
const read = (path: string) => readFileSync(path, "utf8");
function result(input: WikiStageInput, rename = false): WikiStageResult {
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
   return { kind: "concept-plan", jobs: [{ pageRefs: input.requiredPages, question: "Which training conditions govern comparisons?", scope: "Compare training conditions across all models", targetRef: input.pages.find(p => p.previous && p.page.kind === "concept")?.ref ?? null }], objectOnly: [] };
  case "concepts": {
   const target = input.pages.find(p => p.ref === input.conceptTask?.targetRef);
   const ids = [...new Set(input.pages.filter(p => input.requiredPages.includes(p.ref) || p === target).flatMap(p => wikiPageEntryIds(p.page.body)))];
   value.pages = [{ id: target?.page.id ?? "concept:conditions", kind: "concept", title: "Training conditions", description: "Conditions that govern comparisons", body: `## Comparison\nCompare conditions ${ids.map(id => `[[${id}]]`).join(" ")}.`, member_refs: [] }];
   break;
  }
  case "audit-concepts":
   return { kind: "concept-audit", reviewedPages: consideredPages, conflictGroups: [], discardedRefs: [] };
  case "merge-concepts": {
   const members = input.pages.filter(p => p.role === "member");
   if (members.length) value.pages = [{ ...members[0]!.page, id: "concept:conditions", body: `## Comparison\nCompare all conditions ${[...new Set(members.flatMap(p => wikiPageEntryIds(p.page.body)))].map(id => `[[${id}]]`).join(" ")}.`, member_refs: members.map(p => p.ref) }];
   break;
  }
  case "plan-topics": return { kind: "topic-plan", jobs: input.topics.map(topic => ({ topicId: topic.id, instructions: `Find sections about ${topic.title}` })) };
  case "topic":
   assert.equal(input.topics.length, 1, "each worker receives one Topic");
   return { kind: "topic", topicId: input.topics[0]!.id, matches: input.sections.map(section => ({ sectionRef: section.ref, reason: "Relevant model conditions" })), gaps: [] };
  case "page-topics":
   assert.equal(input.pages.length, 1, "one matching call receives one complete page");
   assert.deepEqual(input.previousRelations, [], "matching needs only the body and Topic definitions");
   assert.ok(input.sections.every(section => section.pageId === input.pages[0]!.page.id));
   assert.deepEqual(new Set(input.entries.map(entry => entry.id)), new Set(wikiPageEntryIds(input.pages[0]!.page.body)));
   return { kind: "page-topics", sections: input.sections.map(section => ({ sectionRef: section.ref,
    matches: input.topics.map(topic => ({ topicId: topic.id, reason: `Relevant ${topic.id} conditions` })) })) };
 }
 return { kind: "pages", value, consideredPages };
}
const outcome = (input: WikiStageInput, rename = false): WikiStageOutcome => ({ result: result(input, rename), usage, sessionPaths: [] });
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

try {
 const firstFour = latch(), fifthStarted = latch(), holdFirst = latch();
 const objectsStarted: string[] = [], stages: string[] = [];
 const initialInputs: WikiStageInput[] = [];
 let active = 0, maximum = 0;
 const compiler = new WikiCompiler({ runStage: async ({ input, env: stageEnv, workRoot, onAttemptStarted }) => {
  assert.equal(stageEnv.TELOMI_WIKI_COMPILATION_MODEL, "test/root", "every compilation stage receives the frozen role model");
  assert.equal(stageEnv.TELOMI_WIKI_COMPILATION_THINKING_LEVEL, "low", "every compilation stage receives the frozen role thinking depth");
  stages.push(input.stage);
  initialInputs.push(input);
  if (input.stage === "objects") {
   objectsStarted.push(input.entries[0]!.sourceId); active++; maximum = Math.max(maximum, active);
   if (objectsStarted.length === 4) firstFour.release();
   if (objectsStarted.length === 5) fifthStarted.release();
   try { if (objectsStarted.length === 1) await holdFirst.promise; else if (objectsStarted.length <= 4) await firstFour.promise; return outcome(input); }
   finally { active--; }
  }
  if (input.stage === "merge-objects") {
   assert.equal(active, 0, "object merging waits for all Note workers");
   const planner = join(workRoot, 'plan/attempt'), writer = join(workRoot, 'write/attempt');
   onAttemptStarted?.(planner); onAttemptStarted?.(writer);
   const trace = JSON.parse(read(join(initialRequest.controlDirectory, `wiki-trace-${hashJson(input.key).slice(0, 16)}.json`)));
   assert.deepEqual(trace.sessions.map((row: { path: string }) => resolve(initialRequest.controlDirectory, row.path)),
    [planner, writer].map(path => join(path, 'runtime/sessions')), 'live merge trace preserves planner and writer sessions');
   return { ...outcome(input), sessionPaths: [join(planner, 'runtime/sessions'), join(writer, 'runtime/sessions')] };
  }
  return outcome(input);
 } });
 const initialRequest = request("initial");
 const progress: Array<{ stageIndex: number; totalStages: number }> = [];
 initialRequest.onStageProgress = event => { progress.push(event); };
 const compiling = compiler.compile(initialRequest);
 // A stuck first task must not prevent slot replenishment when another task finishes.
 let timeout: ReturnType<typeof setTimeout> | undefined;
 let queueError: unknown;
 try { await Promise.race([fifthStarted.promise, compiling.then(() => { throw new Error("Compiler finished before fifth Note started"); }), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Queue did not replenish a free slot")), 3000); })]); assert.equal(pendingWiki(), 1, "Settings reports the active Wiki Update still using its starting selection"); }
 catch (error) { queueError = error; }
 finally { clearTimeout(timeout); holdFirst.release(); }
 const initial = await compiling;
 assert.equal(pendingWiki(), 0, "finished Wiki Updates release pending configuration tracking");
 assert.deepEqual(await readPreviousWikiEdition(join(initialRequest.goalDir, "wiki/knowledge")), { pages: [], entries: [], files: new Map(), relations: [] }, "A newly created Goal has an empty Wiki skeleton, not a corrupt published Edition");
 if (queueError) throw queueError;
 assert.equal(maximum, 4);
 assert.equal(objectsStarted.length, 6);
 assert.equal(stages.filter(stage => stage === "page-topics").length, 7);
 assert.ok(!stages.includes("plan-topics") && !stages.includes("topic") && !stages.includes("relations"), "navigation follows concept integration without a relation Agent or Topic planner");
 assert.equal(initial.pageCount, 7);
 assert.ok(stages.includes("audit-concepts"));
 assert.ok(!stages.includes("merge-concepts"), "an audit with no conflict does not rewrite concepts");
 assert.deepEqual(initial.failedBatches, []);
 assert.equal(initial.publicationReady, true);
 assert.ok(progress.every(event => event.stageIndex < event.totalStages));
 assert.equal(Math.max(...progress.map(event => event.totalStages)), initialInputs.filter(input => input.stage !== 'objects').length,
  'Final progress counts page classification calls, not Topics or a removed planner');
 const navigationInputs = initialInputs.filter(input => input.stage === "page-topics");
 assert.equal(new Set(navigationInputs.map(input => input.pages[0]!.page.id)).size, 7, "each final page is matched exactly once");
 assert.equal(navigationInputs.filter(input => input.pages[0]!.page.kind === "entity").length, 6);
 assert.equal(navigationInputs.filter(input => input.pages[0]!.page.kind === "concept").length, 1);
 for (const input of navigationInputs) assert.deepEqual(input.topics, plan.topics);
 const knowledge = initial.knowledge.absolutePath, originalHash = hashWikiDirectory(knowledge);
 const topicIndex = JSON.parse(read(join(knowledge, ".topic-index.json")));
 assert.equal(topicIndex.topics.length, 2);
 for (const topic of topicIndex.topics) {
  assert.deepEqual(new Set(topic.sections), new Set(topicIndex.sections.map((section: { ref: string }) => section.ref)), "all page results aggregate into each matched Topic");
  assert.deepEqual(topic.gaps, [], "per-page matching does not infer global gaps");
  assert.ok(topic.matches.every((match: { reason: string }) => match.reason === `Relevant ${topic.topicId} conditions`));
 }
 assert.match(read(join(knowledge, "README.md")), /entities\/source-0\.md#training/u);
 const registry = JSON.parse(read(join(knowledge, ".note-registry.json")));
 for (const entry of registry.entries) assert.ok(entry.anchors.length > 0, "every Cue preserves evidence positions");
 for (const section of topicIndex.sections) {
  assert.ok(section.entryIds.length > 0, "Topic sections expose their Cue references");
  for (const id of section.entryIds) assert.ok(registry.entries.some((entry: { id: string; anchors: unknown[] }) => entry.id === id && entry.anchors.length > 0), "section references resolve through Cue to evidence");
 }
 assert.deepEqual(JSON.parse(read(join(knowledge, ".object-first-relations.json"))), [], "new Editions contain no inferred semantic graph");
 const training = topicIndex.sections.find((section: { pageId: string; heading: string }) => section.pageId === "entity:source-0" && section.heading === "Training");
 assert.equal(training.entryIds.length, 1, "section evidence excludes unrelated page sections");
 assert.equal(registry.entries.find((entry: { id: string }) => entry.id === training.entryIds[0]).anchors[0].startLine, 1);
 assert.match(read(join(knowledge, "entities/source-0.md")), /1\.45%/u);
 const beforeReuse = stages.length;
 assert.equal((await compiler.compile(initialRequest)).status, "reused");
 assert.equal(stages.length, beforeReuse);

 const incrementalStages: WikiStageInput[] = [];
 const incrementalCompiler = new WikiCompiler({ runStage: async ({ input }) => { incrementalStages.push(input); return outcome(input, true); } });
 const incremental = await incrementalCompiler.compile(request("incremental", evidence(1, 6), knowledge));
 const planning = incrementalStages.find(input => input.stage === "plan-concepts")!;
 assert.ok(planning.pages.some(p => p.previous && p.page.kind === "concept"), "historical concepts are available to the planner");
 assert.ok(incrementalStages.every(input => input.previousRelations.length === 0), "incremental construction does not inject historical semantic edges");
 assert.equal(JSON.parse(read(join(incremental.knowledge.absolutePath, ".note-registry.json"))).entries.length, 14);
 assert.equal(hashWikiDirectory(knowledge), originalHash, "incremental build leaves its source Edition immutable");

 // A reviewed object-only batch is valid knowledge even without any concept page.
 const objectOnlyStages: string[] = [];
 const objectOnly = await new WikiCompiler({ runStage: async ({ input }) => {
  objectOnlyStages.push(input.stage);
  if (input.stage === "plan-concepts") return { usage, sessionPaths: [], result: {
   kind: "concept-plan", jobs: [], objectOnly: input.requiredPages.map(pageRef => ({ pageRef,
    comparedWith: [], reason: "Source-specific observation after full review, no reusable explanation" })),
  } };
  return outcome(input);
 } }).compile(request("object-only", evidence(1)));
 assert.equal(objectOnly.pageCount, 1);
 assert.equal(objectOnly.publicationReady, true);
 assert.ok(!objectOnlyStages.includes("concepts") && !objectOnlyStages.includes("merge-concepts"));

 // A target writer can decline an update without removing the historical concept.
 const declinedInputs: WikiStageInput[] = [];
 const declined = await new WikiCompiler({ runStage: async ({ input }) => {
  declinedInputs.push(input);
  if (input.stage === "concepts") return { usage, sessionPaths: [], result: {
   kind: "pages", value: empty(), consideredPages: input.requiredPages.map(pageRef => ({ pageRef,
    reason: "Existing explanation already covers the supported mechanism" })),
  } };
  return outcome(input);
 } }).compile(request("declined-target", evidence(1, 6), knowledge));
 const declinedPages = (await readPreviousWikiEdition(declined.knowledge.absolutePath)).pages;
 const originalConcept = (await readPreviousWikiEdition(knowledge)).pages.find(page => page.kind === "concept")!;
 assert.deepEqual(declinedPages.find(page => page.id === originalConcept.id), originalConcept);
 assert.ok(declinedInputs.find(input => input.stage === "concepts")!.conceptTask?.targetRef);
 assert.equal(declined.publicationReady, true);

 // Objects may support different questions; the audit sends only its conflict
 // members into rewriting and preserves unrelated explanations byte for byte.
 const overlapInputs: WikiStageInput[] = [];
 let complementaryBody = "";
 const overlap = await new WikiCompiler({ runStage: async ({ input }) => {
  overlapInputs.push(input);
  if (input.stage === "plan-concepts") return { usage, sessionPaths: [], result: {
   kind: "concept-plan", objectOnly: [], jobs: ["canonical", "complementary"].map(question => ({
    question, scope: `Explain ${question} conditions`, pageRefs: input.requiredPages, targetRef: null,
   })),
  } };
  if (input.stage === "concepts") {
   const value = empty();
   value.pages = [{ id: `concept:${input.conceptTask!.question}`, kind: "concept", title: input.conceptTask!.question,
    description: "Independent explanatory boundary", body: `## Mechanism\n${input.pages.filter(page => input.requiredPages.includes(page.ref)).flatMap(page => wikiPageEntryIds(page.page.body)).map(id => `[[${id}]]`).join(" ")}`, member_refs: [] }];
   if (input.conceptTask!.question === "complementary") complementaryBody = value.pages[0]!.body;
   return { usage, sessionPaths: [], result: { kind: "pages", value,
    consideredPages: input.requiredPages.map(pageRef => ({ pageRef, reason: "Read the assigned support" })) } };
  }
  if (input.stage === "audit-concepts") {
   const concepts = input.pages.filter(page => page.page.kind === "concept");
   return { usage, sessionPaths: ["audit-session"], result: { kind: "concept-audit",
    reviewedPages: concepts.map(page => ({ pageRef: page.ref, reason: "Reviewed scope and mechanism" })),
    conflictGroups: [{ pageRefs: concepts.filter(page => page.page.id !== "concept:complementary").map(page => page.ref),
     reason: "Historical and new canonical explanations overlap" }], discardedRefs: [] } };
  }
  if (input.stage === "merge-concepts") {
   assert.deepEqual(input.pages.filter(page => page.role === "member").map(page => page.page.id).sort(),
    ["concept:canonical", originalConcept.id].sort(), "unrelated concept cannot be consumed by this conflict group");
   assert.ok(!input.pages.some(page => page.page.id === "concept:complementary"));
   return { ...outcome(input), sessionPaths: ["conflict-session"] };
  }
  return outcome(input);
 } }).compile(request("overlapping-support", evidence(1, 6), knowledge));
 assert.equal(overlap.publicationReady, true);
 assert.equal(overlapInputs.filter(input => input.stage === "concepts").length, 2);
 assert.equal(overlapInputs.filter(input => input.stage === "merge-concepts").length, 1);
 const complementary = (await readPreviousWikiEdition(overlap.knowledge.absolutePath)).pages.find(page => page.id === "concept:complementary")!;
 assert.equal(complementary.body, complementaryBody, "unconflicted candidate content is unchanged");
 assert.ok(overlap.sessionPaths.includes("audit-session") && overlap.sessionPaths.includes("conflict-session"));
 assert.equal(overlap.usage.calls, overlapInputs.length, "audit and local conflict calls count exactly once");

 const previousForConflict = await readPreviousWikiEdition(knowledge);
 const historicalConflictSeed = join(root, "historical-conflict-seed");
 const secondaryConcept = { ...originalConcept, id: "concept:secondary", title: "Secondary conditions" };
 writeWikiEdition(historicalConflictSeed, [...previousForConflict.pages, secondaryConcept], previousForConflict.entries,
  { ...empty(), relations: [{ from: "entity:source-0", to: secondaryConcept.id, label: "uses conditions",
   entryIds: wikiPageEntryIds(secondaryConcept.body) }] }, previousForConflict);
 const historicalInputs: WikiStageInput[] = [];
 const historicalSeedHash = hashWikiDirectory(historicalConflictSeed);
 const historicalEntityPath = "entities/source-0.md";
 const oldEntityBytes = read(join(historicalConflictSeed, historicalEntityPath));
 assert.match(oldEntityBytes, /Note Entry `entry:[a-f0-9]{24}`/u, "published citations use the current Note Entry label");
 assert.match(oldEntityBytes, /## Related/u, "legacy Edition has a readable relation");
 const historicalConflict = await new WikiCompiler({ runStage: async ({ input }) => {
  historicalInputs.push(input);
  if (input.stage === "plan-concepts") return { usage, sessionPaths: [], result: { kind: "concept-plan", jobs: [],
   objectOnly: input.requiredPages.map(pageRef => ({ pageRef, comparedWith: [], reason: "Existing explanations suffice" })) } };
  if (input.stage === "audit-concepts") {
   const concepts = input.pages.filter(page => page.page.kind === "concept");
   return { usage, sessionPaths: [], result: { kind: "concept-audit",
    reviewedPages: concepts.map(page => ({ pageRef: page.ref, reason: "Reviewed historical scope" })),
    conflictGroups: [{ pageRefs: concepts.map(page => page.ref), reason: "Historical synonyms for the same explanation" }], discardedRefs: [] } };
  }
  return outcome(input);
 } }).compile(request("historical-local-conflict", evidence(6), historicalConflictSeed));
 assert.equal(historicalConflict.publicationReady, true);
 assert.ok(historicalInputs.every(input => input.previousRelations.length === 0));
 assert.deepEqual((await readPreviousWikiEdition(historicalConflict.knowledge.absolutePath)).relations, []);
 assert.equal(read(join(historicalConflict.knowledge.absolutePath, historicalEntityPath)),
  oldEntityBytes.replace(/\n## Related\s*\n[\s\S]*?(?=\n## |$)/u, ""),
  "unchanged object prose and evidence bytes survive; only derived Related links are removed");
 assert.equal(hashWikiDirectory(historicalConflictSeed), historicalSeedHash, "historical Edition remains immutable");
 assert.equal((await readPreviousWikiEdition(historicalConflictSeed)).relations.length, 1, "legacy relations remain readable in their original Edition");

 for (const failedStage of ["audit-concepts", "merge-concepts"] as const) {
  const failedInputs: WikiStageInput[] = [];
  const failing = new WikiCompiler({ runStage: async ({ input }) => {
   failedInputs.push(input);
   if (input.stage === failedStage) throw Object.assign(new Error(`Injected ${failedStage} failure`),
    { usage: failureUsage, sessionPaths: [`${failedStage}-failed-session`] });
   if (input.stage === "audit-concepts") {
    const concepts = input.pages.filter(page => page.page.kind === "concept");
    return { usage, sessionPaths: [], result: { kind: "concept-audit",
     reviewedPages: concepts.map(page => ({ pageRef: page.ref, reason: "Reviewed complete candidates" })),
     conflictGroups: [{ pageRefs: concepts.map(page => page.ref), reason: "Duplicate conditions" }], discardedRefs: [] } };
   }
   if (input.stage === "plan-concepts") {
    const planned = result(input);
    if (planned.kind !== "concept-plan") throw new Error("wrong plan");
    planned.jobs[0]!.targetRef = null;
    return { usage, sessionPaths: [], result: planned };
   }
   if (input.stage === "concepts") {
    const generated = result(input);
    if (generated.kind === "pages") generated.value.pages[0]!.id = "concept:new-condition";
    return { usage, sessionPaths: [], result: generated };
   }
   return outcome(input);
  } });
  const failedRequest = request(`failed-${failedStage}`, evidence(1, 6), knowledge);
  await assert.rejects(failing.compile(failedRequest), error => {
   assert.match(String(error), new RegExp(`Injected ${failedStage} failure`));
   const details = error as Error & { usage: typeof usage; sessionPaths: string[] };
   assert.ok(details.sessionPaths.includes(`${failedStage}-failed-session`));
   assert.equal(details.usage.calls, failedInputs.length - 1 + failureUsage.calls);
   assert.equal(details.usage.inputTokens, (failedInputs.length - 1) * usage.inputTokens + failureUsage.inputTokens);
   return true;
  });
 }

 // Legacy Editions can contain concept-only Cues and an unresolved Cue pool.
 // The first incremental Base run routes both into object merging without a rebuild.
 const legacySnapshot = evidence(1);
 legacySnapshot.notes[0]!.note.sections.push({ section_title: "Unplaced", summary: "Additional observation", cue_notes: [{ cue: "Unplaced Cue", note: "A note awaiting placement", evidence: [{ source_path: "source-0.md", content_sha256: "b".repeat(64), start_line: 3, end_line: 3 }] }] });
 const legacyEntries = noteWikiEntries(legacySnapshot, plan.revision);
 const [objectCue, conceptOnlyCue, deferredCue] = legacyEntries;
 assert.ok(objectCue && conceptOnlyCue && deferredCue);
 const legacySeed = join(root, "legacy-seed");
 writeWikiEdition(legacySeed, [
  { id: "entity:legacy-method", kind: "entity", title: "Legacy method", description: "Existing method record", body: `## Method\nExisting observation [[${objectCue.id}]]` },
  { id: "concept:conditions", kind: "concept", title: "Training conditions", description: "Existing explanation", body: `## Comparison\nCondition retained only in the legacy concept [[${conceptOnlyCue.id}]]` },
 ], legacyEntries, { ...empty(), deferred_entries: [{ entry_ref: deferredCue.id, reason: "Await placement" }] }, { pages: [], entries: [], files: new Map(), relations: [] });
 rmSync(join(legacySeed, ".object-first-pages.json"));
 rmSync(join(legacySeed, ".object-first-relations.json"));
 const legacyHash = hashWikiDirectory(legacySeed);
 let legacyMergeSeen = false;
 const migrated = await new WikiCompiler({ runStage: async ({ input }) => {
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
   assert.ok(input.pages.some(page => page.page.kind === "entity" && wikiPageEntryIds(page.page.body).includes(conceptOnlyCue.id)));
  }
  return outcome(input);
 } }).compile(request("legacy-migration", legacySnapshot, legacySeed));
 assert.equal(legacyMergeSeen, true);
 assert.equal(migrated.publicationReady, true);
 assert.deepEqual(JSON.parse(read(join(migrated.knowledge.absolutePath, ".discarded-cues.json"))), [{ entry_id: deferredCue.id, reason: "Outside the maintained object scope after review" }]);
 assert.equal(hashWikiDirectory(legacySeed), legacyHash, "Migration preserves its historical Edition");
 const migratedPages = await readPreviousWikiEdition(migrated.knowledge.absolutePath);
 assert.ok(migratedPages.pages.some(page => page.kind === "entity" && wikiPageEntryIds(page.body).includes(conceptOnlyCue.id)));
 assert.ok(migratedPages.pages.some(page => page.id === "concept:conditions" && wikiPageEntryIds(page.body).includes(conceptOnlyCue.id)), "Historical concept evidence survives the object-layer repair");

 const reindexStages: WikiStageInput[] = [];
 const pageFour = latch(), pageFive = latch(), holdPage = latch();
 let activePages = 0, maximumPages = 0;
 const reindexRequest = { knowledgeRoot: knowledge, topicPlan: { ...plan, revision: "v2" }, goalContext: initialRequest.goalContext, workRoot: join(root, "reindex"), env, signal: initialRequest.signal };
 const reindexing = new WikiCompiler({ runStage: async ({ input }) => {
  reindexStages.push(input); activePages++; maximumPages = Math.max(maximumPages, activePages);
  const position = reindexStages.length;
  if (position === 4) pageFour.release();
  if (position === 5) pageFive.release();
  try { if (position === 1) await holdPage.promise; else if (position <= 4) await pageFour.promise; return outcome(input); }
  finally { activePages--; }
 } }).reindex(reindexRequest);
 let pageQueueError: unknown;
 try { await Promise.race([pageFive.promise, reindexing.then(() => { throw new Error("Reindex finished before fifth page started"); }), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Page queue did not replenish a free slot")), 3000); })]); assert.equal(pendingWiki(), 1, "Settings also tracks active Topic reindex configuration"); }
 catch (error) { pageQueueError = error; }
 finally { clearTimeout(timeout); holdPage.release(); }
 const indexed = await reindexing;
 assert.equal(pendingWiki(), 0, "finished reindex releases pending configuration tracking");
 if (pageQueueError) throw pageQueueError;
 assert.equal(maximumPages, 4, "page matching uses the bounded fair queue");
 assert.deepEqual(reindexStages.map(input => input.stage), Array(7).fill("page-topics"));
 for (const file of ["entities/source-0.md", "concepts/conditions.md", ".note-registry.json", ".object-first-relations.json"]) assert.equal(read(join(indexed.knowledgeRoot, file)), read(join(knowledge, file)), "Topic reindex preserves knowledge and evidence bytes");
 assert.equal(hashWikiDirectory(knowledge), originalHash);
 for (const input of reindexStages) assert.deepEqual(input.previousRelations, [], "Topic-only matching does not receive graph metadata");

 const legacyReindexed = await new WikiCompiler({ runStage: async ({ input }) => outcome(input) }).reindex({
  ...reindexRequest, knowledgeRoot: historicalConflictSeed, workRoot: join(root, "legacy-relations-reindex") });
 assert.equal(read(join(legacyReindexed.knowledgeRoot, ".object-first-relations.json")),
  read(join(historicalConflictSeed, ".object-first-relations.json")), "Topic-only reindex retains historical nonempty relation bytes");
 assert.equal(read(join(legacyReindexed.knowledgeRoot, historicalEntityPath)), oldEntityBytes,
  "Topic-only reindex retains historical Related blocks, prose and evidence");
 assert.equal(hashWikiDirectory(historicalConflictSeed), historicalSeedHash);

 const noCalls = new WikiCompiler({ runStage: async () => { throw new Error("Empty navigation must not call a model"); } });
 await assert.rejects(noCalls.reindex({ ...reindexRequest, topicPlan: { ...plan, topics: [] }, workRoot: join(root, "no-topics") }), /Goal Topic Plan is invalid/u,
  "an empty active Topic Plan fails validation before any model call");
 const noPagesRoot = join(root, "no-pages-seed");
 writeWikiEdition(noPagesRoot, [], [], empty(), { pages: [], entries: [], files: new Map(), relations: [] });
 const noPages = await noCalls.reindex({ ...reindexRequest, knowledgeRoot: noPagesRoot, workRoot: join(root, "no-pages") });
 assert.deepEqual(noPages.failedTopics, []);
 assert.equal(noPages.usage.calls, 0);
 const emptyTopics = JSON.parse(read(join(noPages.knowledgeRoot, ".topic-index.json"))).topics;
 assert.equal(emptyTopics.length, 2);
 assert.ok(emptyTopics.every((topic: { status: string; sections: string[]; gaps: string[] }) => topic.status === "succeeded" && !topic.sections.length && !topic.gaps.length));

 let failedWriter = false, successfulWriterStages = 0;
 const writerPartial = await new WikiCompiler({ runStage: async ({ input }) => {
  if (input.stage === 'concepts' && !failedWriter) {
   failedWriter = true;
   throw Object.assign(new Error('Injected concept Writer failure'), { usage: failureUsage, sessionPaths: ['failed-writer-session'] });
  }
  successfulWriterStages++;
  return outcome(input);
 } }).compile(request('partial-concept-writer'));
 assert.equal(writerPartial.failedBatches.length, 1);
 assert.deepEqual(writerPartial.failedBatches[0]!.usage, failureUsage, 'A recoverable Writer failure records only its own stage usage');
 assert.equal(writerPartial.usage.calls, successfulWriterStages + failureUsage.calls, 'Compilation usage includes all successful and failed stages once');
 assert.ok(writerPartial.sessionPaths.includes('failed-writer-session'));

 const failedNotes: string[] = [];
 let failNote = true;
 let successfulRetryStages = 0;
 const retryRequest = request("partial");
 const retryCompiler = new WikiCompiler({ runStage: async ({ input }) => {
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
 await assert.rejects(retryCompiler.compile(request('partial-as-seed', evidence(6), partial.knowledge.absolutePath)), /Incomplete Wiki compilation output/u);
 failNote = false;
 const recovered = await retryCompiler.compile(retryRequest);
 assert.deepEqual(recovered.failedBatches, [], "retry repairs failed work rather than reusing a partial result");
 assert.equal(recovered.pageCount, 7);
 assert.equal(recovered.publicationReady, true);
 assert.notEqual(recovered.knowledge.absolutePath, partial.knowledge.absolutePath, "Recovery publishes a fresh artifact rather than overwriting the partial one");
 assert.equal(hashWikiDirectory(partial.knowledge.absolutePath), partialHash, "recovery preserves the earlier partial artifact");

 const deferredStages: WikiStageInput[] = [];
 const deferredMethod = await new WikiCompiler({ runStage: async ({ input }) => {
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
 const topicRetryInputs: WikiStageInput[] = [];
 const topicRetryCompiler = new WikiCompiler({ runStage: async ({ input }) => {
  topicRetryInputs.push(input);
  if (input.stage === "page-topics" && input.pages[0]!.page.id === "entity:source-0" && failTopic) throw Object.assign(new Error("Injected Topic failure"), { usage: failureUsage, sessionPaths: ["failed-topic-session"] });
  return outcome(input);
 } });
 const topicRetryRequest = { knowledgeRoot: knowledge, topicPlan: plan, goalContext: initialRequest.goalContext, workRoot: join(root, "topic-failure"), env, signal: initialRequest.signal };
 const topicFailure = await topicRetryCompiler.reindex(topicRetryRequest);
 assert.deepEqual(topicFailure.failedTopics.map(topic => topic.topicId).sort(), ["evaluation", "training"], "one page failure leaves every Topic incomplete exactly once");
 assert.equal(topicRetryInputs.length, 7, "a failed page does not stop queued pages");
 assert.equal(topicFailure.usage.calls, 6 + failureUsage.calls, "Reindex counts a failed page once, alongside successful pages");
 assert.equal(topicFailure.usage.costUsd, failureUsage.costUsd);
 assert.ok(topicFailure.sessionPaths.includes("failed-topic-session"));
 const partialIndex = JSON.parse(read(join(topicFailure.knowledgeRoot, ".topic-index.json")));
 for (const topic of partialIndex.topics) {
  assert.equal(topic.status, "failed");
  assert.equal(topic.sections.length, 11, "successful pages remain inspectable for every Topic");
 }
 assert.match(read(join(topicFailure.knowledgeRoot, 'README.md')), /Topic indexing failed:.*Injected Topic failure/u, 'a failed Topic is not rendered as an empty coverage result');
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
 assert.ok(topicRetryInputs.every(input => input.stage === "page-topics"));

 const incompleteNavigation = await new WikiCompiler({ runStage: async ({ input }) => {
  if (input.stage === "page-topics" && input.pages[0]!.page.kind === "entity") throw Object.assign(new Error("Navigation incomplete"), { usage: failureUsage });
  return outcome(input);
 } }).compile(request("incomplete-navigation", evidence(1)));
 assert.equal(incompleteNavigation.publicationReady, false, "Complete pages do not make a candidate publishable when Topic navigation failed");
 assert.equal(incompleteNavigation.failedBatches.length, 2);
 assert.deepEqual(incompleteNavigation.failedBatches.flatMap(failure => failure.sourceIds).sort(), ["evaluation", "training"]);
 assert.equal(JSON.parse(read(join(incompleteNavigation.knowledge.absolutePath, ".note-first-status.json"))).complete, false);

 // Only genuinely empty directory trees can omit the registry. Any file or link
 // may be historical knowledge, including files skipped by Markdown enumeration.
 for (const name of ['README.md', '.object-first-pages.json', 'sources/source.txt', 'concepts/page.md']) {
  const goalDir = join(root, `nonempty-${name.replaceAll('/', '-')}`);
  ensureGoalWorkspace({ goalDir, goalId: 'goal', title: 'Models' });
  const knowledgeRoot = join(goalDir, 'wiki/knowledge'), file = join(knowledgeRoot, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, name.endsWith('.json') ? '[]' : '');
  await assert.rejects(readPreviousWikiEdition(knowledgeRoot), /missing its Note Registry/, `Existing ${name} must never be treated as an empty Wiki`);
 }
 const linkedGoal = join(root, 'linked-empty-goal');
 ensureGoalWorkspace({ goalDir: linkedGoal, goalId: 'goal', title: 'Models' });
 const linkedKnowledge = join(linkedGoal, 'wiki/knowledge');
 symlinkSync(join(linkedKnowledge, 'sources'), join(linkedKnowledge, 'alias'), 'dir');
 await assert.rejects(readPreviousWikiEdition(linkedKnowledge), /missing its Note Registry/, 'A link is not an empty skeleton directory');

 const controller = new AbortController(), cancelledStages: string[] = [];
 await assert.rejects(new WikiCompiler({ runStage: async ({ input, signal }: WikiStageRequest) => {
  cancelledStages.push(input.stage);
  if (input.stage === "objects") { controller.abort(new Error("Injected cancellation")); signal.throwIfAborted(); }
  return outcome(input);
 } }).compile({ ...request("cancelled"), signal: controller.signal }), /Injected cancellation/u);
 assert.ok(cancelledStages.every(stage => stage === "objects"), "cancellation prevents downstream stages");
 console.log("Wiki compilation compiler: complete Notes, dynamic queue, isolated failures, cancellation, incremental identity and Topic-only navigation passed");
} finally { rmSync(root, { recursive: true, force: true }); }
