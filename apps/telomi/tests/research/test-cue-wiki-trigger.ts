import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/store.js";
import { createWikiUpdateTool } from "../../server/main-agent/tools/wiki-update.js";
import { createMainAgentTools } from "../../server/main-agent/tools/index.js";
import { sha256 } from "../../server/lib/hash.js";
import { registerSavedInvestigationCues, startGoalCueWikiUpdates, setGoalCueWikiForeground,
 listDeliveredInvestigationReviews, recordDeliveredInvestigationReview } from "../../server/research/cue-wiki-trigger.js";
import { getCueWikiQueueStatus } from "../../server/research/cue-wiki-queue.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { publishCompilation } from "../../server/wiki/publication.js";
import { hashWikiDirectory } from "../../server/wiki/files.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "cue-wiki-trigger-"));
const goalId = "goal-cues", goalDir = join(workspaceDir, goalId), id = "a".repeat(24), threadId = "b".repeat(24);
const target = { workspaceDir, goalId, goalDir };
try {
 const sequence = join(goalDir, "wiki/runs/original/artifacts/find-out-sources/sequence-1");
 const member = "members/github/member", source = join(sequence, "sources/one");
 mkdirSync(join(source, member), { recursive: true });
 writeFileSync(join(source, member, "model.py"), "sampling_rate = 24000\n");
 writeFileSync(join(sequence, "manifest.json"), JSON.stringify({ schema_version: 3, sequence: 1, sources: [{
  source_id: "source:one", title: "Original implementation", path: "sources/one", organization_kind: "ungrouped",
  organization_reason: "one Source", revision_sha256: sha256("revision"),
  members: [{ candidate_id: "candidate:one", source_id: "source:member", provider_id: "github", title: "Original implementation",
   canonical_locator: "https://example.test/model", path: member, summary: "implementation" }],
 }] }));
 const notes = { schema_version: 1, question: "Sampling rate?", status: "found", summary: "Explicit constant", gaps: [], cues: [{
  ref: `deep-search:${id}-1:cue-1`, section_title: "Sampling", cue: "Sampling rate", note: "The code uses 24000.", evidence: [{
   source_run_id: "original", source_id: "source:one", source_revision_sha256: sha256("revision"), source_path: `${member}/model.py`,
   start_line: 1, end_line: 1, content_sha256: sha256("sampling_rate = 24000\n"),
  }],
 }] };
 const artifact = new RunArtifactStore(goalDir).publishText(JSON.stringify(notes), `artifacts/deep-search/${id}-1.json`);
 const runtime = serverRuntimeDirForGoal(goalId, workspaceDir);
 const binding = join(runtime, "research/investigations", id);
 mkdirSync(binding, { recursive: true });
 writeFileSync(join(binding, "thread-binding.json"), JSON.stringify({ schema_version: 1, thread_id: threadId }));
 registerSavedInvestigationCues(target);
 assert.equal(getCueWikiQueueStatus(target).pendingCount, 0, "saved Reader evidence alone never admits Wiki work");
 const result = { id, question: "Sampling rate?", answer: "The code uses 24000.", citation_refs: [], gaps: [], wiki_sha256: "c".repeat(64) };
 new RunArtifactStore(goalDir).publishText(JSON.stringify(result), `artifacts/investigations/${id}/result.json`);
 const terminal = { role: "toolResult", toolName: "deliver_investigation", details: { terminal: true,
  action: "deliver_investigation", investigation_id: id, wiki_review: {
   useful_findings: ["The implementation's sampling constant supports the Speech Goal."], excluded_findings: [],
  } } };
 const contextPath = join(goalDir, "context.jsonl");
 writeFileSync(contextPath, `${JSON.stringify({ type: "message", message: terminal })}\n`);
 registerSavedInvestigationCues(target);
 assert.equal(getCueWikiQueueStatus(target).pendingCount, 0, "a successful delivery Tool receipt is not a committed user reply");
 writeFileSync(contextPath, `${JSON.stringify({ type: "message", message: terminal })}\n${JSON.stringify({ type: "message", message: {
  role: "assistant", content: [{ type: "text", text: result.answer }], mainRoute: { trace: { coarseAction: "deliver_investigation" } },
 } })}\n`);
 registerSavedInvestigationCues(target);
 registerSavedInvestigationCues(target);
 assert.equal(getCueWikiQueueStatus(target).pendingCount, 1, "startup reconciles a committed Cue without repeating registration");
 const queue = JSON.parse(readFileSync(join(runtime, "cue-wiki-queue.json"), "utf8"));
 assert.equal(queue.entries[0].origin.thread_id, threadId);
 assert.equal(queue.entries[0].origin.artifact_ref.sha256, artifact.sha256);
 assert.equal(queue.entries[0].curation_review.investigationId, id);
 assert.deepEqual(queue.entries[0].curation_review.usefulFindings, terminal.details.wiki_review.useful_findings);
 assert.ok(Date.parse(queue.entries[0].ready_at) > Date.now(), "the quiet window is durable across startup observation");
 const goalContext = { title: "Speech", description: "" };
 assert.equal((await startGoalCueWikiUpdates({ ...target, goalContext, env: {} }).execution).status, "pending", "Topic confirmation is required before model work");
 const replayTool = createMainAgentTools(goalDir, { goalId, workspaceDir, deferCueWikiUpdates: true })
  .find(tool => tool.name === "wiki_update")!;
 for (const input of [
  { reason: "Organize saved evidence", rebuild: false },
  { reason: "Rebuild Wiki", rebuild: true },
  { reason: "Refresh historical evidence", rebuild: false, source_run_id: "original" },
  { reason: "Correct unrelated Wiki content", rebuild: false, reconsider: true },
 ]) {
  const deferred = await replayTool.execute("replay-wiki", input);
  assert.equal(deferred.details?.action, "deferred", "Main Replay must not start independently owned Wiki workers");
 }
 let calls = 0;
 const tool = createWikiUpdateTool({ ...target, goalTitle: "Speech", getEnv: () => ({}) }, input => {
  calls++;
  const snapshot = JSON.parse(readFileSync(new RunArtifactStore(input.sourceRunDirectory).openFile(input.sourceNotes).absolutePath, "utf8"));
  assert.equal(input.sourceRunId, undefined, "whole-corpus rebuild never invents a Research Run");
  assert.equal(input.rebuild, true);
  assert.equal(snapshot.notes[0].source_run_id, "original");
  assert.equal(snapshot.notes[0].note.sections[0].cue_notes[0].origin_ref, notes.cues[0].ref);
  assert.equal(input.curationReviews?.[0]?.investigationId, id, "explicit rebuild retains delivered review context");
  assert.ok(input.reason, "the user's maintenance reason reaches the Wiki execution");
  return { wikiUpdateId: "rebuild", reused: true, status: "succeeded" };
 });
 const pending = await tool.execute("refresh", { reason: "Organize saved evidence", rebuild: false });
 assert.equal(pending.details?.status, "pending");
 assert.equal(calls, 0, "pending investigation evidence works without a legacy Research checkpoint");
 const topics = new GoalTopicPlanStore(goalId, workspaceDir);
 const proposal = topics.proposePatch({ source: "main_agent", patch: { schema_version: 1, base_revision: null, summary: "Topics", operations: [{ op: "add", topic: {
  id: "speech", title: "Speech", intent: "Understand speech", questions: [], include: [], exclude: [],
 } }] } });
 topics.activate(proposal.proposal_id);
 setGoalCueWikiForeground(goalDir, true);
 assert.equal((await startGoalCueWikiUpdates({ ...target, goalContext, env: {} }).execution).status, "pending",
  "foreground follow-up work holds automatic admission before any model work");
 setGoalCueWikiForeground(goalDir, false);
 await tool.execute("rebuild", { reason: "User requested rebuild", rebuild: true });
 await tool.execute("rebuild-again", { reason: "User requested rebuild", rebuild: true });
 assert.equal(calls, 2, "the immutable corpus snapshot is reusable by explicit rebuilds");
 await tool.execute("reconsider", { reason: "Review current Wiki and remove unrelated deployment details", rebuild: false, reconsider: true });
 assert.equal(calls, 3, "explicit reconsideration runs the complete corpus compiler even when rebuild is false");
 await assert.rejects(tool.execute("bad-reconsider", { reason: "Review the entire Wiki", rebuild: false, reconsider: true,
  source_run_id: "original" }), /omit source_run_id/u);
 const candidate = new RunArtifactStore(join(goalDir, "wiki/test-candidate"));
 candidate.publishText("# Candidate\n", "knowledge/README.md");
 const output = candidate.describeDirectory("knowledge");
 const compilation = { status: "compiled" as const, compilationId: "candidate", baseKnowledgeSha256: hashWikiDirectory(join(goalDir, "wiki/knowledge")),
  knowledge: output, pageCount: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, agentStages: 0, sessionPaths: [], failedBatches: [] };
 await assert.rejects(publishCompilation({ ...target, compilation, topicPlanRevision: "superseded" }), /topic_drift/u);
 await publishCompilation({ ...target, compilation, topicPlanRevision: topics.readActive()!.revision });
 assert.equal(readFileSync(join(goalDir, "wiki/knowledge/README.md"), "utf8"), "# Candidate\n");
 const revisedReview = { useful_findings: [], excluded_findings: [{ finding: "The sampling constant", reason: "The Goal now concerns training, not deployment" }] };
 appendFileSync(contextPath, `${JSON.stringify({ type: "message", message: { ...terminal, details: {
  ...terminal.details, wiki_review: revisedReview,
 } } })}\n${JSON.stringify({ type: "message", message: {
  role: "assistant", content: [{ type: "text", text: result.answer }], mainRoute: { trace: { coarseAction: "deliver_investigation" } },
 } })}\n`);
 registerSavedInvestigationCues(target);
 registerSavedInvestigationCues(target);
 assert.equal(readFileSync(join(binding, "wiki-reviews.jsonl"), "utf8").trim().split("\n").length, 2,
  "different delivered reviews append versions while duplicate recovery is idempotent");
 assert.deepEqual(listDeliveredInvestigationReviews(target)[0]?.excludedFindings, revisedReview.excluded_findings);
 await tool.execute("reconsider-review", { reason: "Reassess existing Wiki using the revised findings", rebuild: false, reconsider: true });
 assert.equal(calls, 4, "explicit existing-content correction never becomes a no-pending reused receipt");
 const revisedQueue = JSON.parse(readFileSync(join(runtime, "cue-wiki-queue.json"), "utf8"));
 assert.equal(revisedQueue.entries.length, 2, "a new editorial review has a new queue identity without changing the earlier version");
 const producer = "d".repeat(24), reviewer = "e".repeat(24), originalThread = "f".repeat(24);
 const reused = { ...notes, cues: [{ ...notes.cues[0], ref: `deep-search:${producer}-1:cue-1` }] };
 new RunArtifactStore(goalDir).publishText(JSON.stringify(reused), `artifacts/deep-search/${producer}-1.json`);
 new RunArtifactStore(goalDir).publishText(JSON.stringify({ ...reused, cues: [{ ...reused.cues[0], ref: `deep-search:${producer}-2:cue-1` }] }),
  `artifacts/deep-search/${producer}-2.json`);
 const producerRoot = join(runtime, "research/investigations", producer);
 mkdirSync(producerRoot, { recursive: true });
 writeFileSync(join(producerRoot, "thread-binding.json"), JSON.stringify({ thread_id: originalThread }));
 const saveCitedAnswer = (reviewerId: string, cue: typeof notes.cues[number]) => {
  const result = { id: reviewerId, question: "Can saved evidence answer the question?", answer: `An answer <cite>${cue.ref}</cite>`,
   citation_refs: [cue.ref], gaps: [], wiki_sha256: "c".repeat(64) };
  const store = new RunArtifactStore(goalDir);
  store.publishText(JSON.stringify(result), `artifacts/investigations/${reviewerId}/result.json`);
  store.publishText(JSON.stringify({ schema_version: 1, citations: [{ ref: cue.ref, cue }] }),
   `artifacts/investigations/${reviewerId}/citations.json`);
 };
 saveCitedAnswer(reviewer, reused.cues[0]);
 recordDeliveredInvestigationReview(target, reviewer, { useful_findings: ["The referenced old evidence contributes to the current Goal"], excluded_findings: [] });
 registerSavedInvestigationCues(target, { investigationId: reviewer });
 const reuseQueue = JSON.parse(readFileSync(join(runtime, "cue-wiki-queue.json"), "utf8"));
 const imported = reuseQueue.entries.find((entry: any) => entry.curation_review?.investigationId === reviewer);
 assert.equal(imported.origin.investigation_id, producer, "reused Cue origin remains its original producer");
 assert.equal(imported.origin.thread_id, originalThread);
 assert.equal(imported.origin.artifact_ref.relative_path, `artifacts/deep-search/${producer}-1.json`);
 assert.equal(reuseQueue.entries.some((entry: any) => entry.origin.artifact_ref.relative_path === `artifacts/deep-search/${producer}-2.json`), false,
  "reusing one old Cue never scans unrelated artifacts from its unreviewed investigation");
 const unreviewed = "1".repeat(24);
 saveCitedAnswer(unreviewed, reused.cues[0]);
 registerSavedInvestigationCues(target, { investigationId: unreviewed });
 assert.equal(getCueWikiQueueStatus(target).pendingCount, 3, "a saved cited answer without a delivered review cannot admit reused evidence");
 const foreignId = "f".repeat(24), unsafeReviewer = "0".repeat(24);
 const foreign = { ...notes, cues: [{ ...notes.cues[0], ref: `deep-search:${foreignId}-1:cue-1` }] };
 const foreignGoal = join(workspaceDir, "another-goal");
 const foreignArtifact = new RunArtifactStore(foreignGoal).publishText(JSON.stringify(foreign), `artifacts/deep-search/${foreignId}-1.json`);
 symlinkSync(foreignArtifact.absolutePath, join(goalDir, "artifacts/deep-search", `${foreignId}-1.json`));
 saveCitedAnswer(unsafeReviewer, foreign.cues[0]);
 recordDeliveredInvestigationReview(target, unsafeReviewer, { useful_findings: [], excluded_findings: [] });
 registerSavedInvestigationCues(target, { investigationId: unsafeReviewer });
 assert.equal(getCueWikiQueueStatus(target).pendingCount, 3, "frozen citations cannot admit an artifact linked from another Goal");
 console.log("Cue commit/startup registration, manual maintenance, whole-corpus rebuild and Topic publication guard passed");
} finally { rmSync(workspaceDir, { recursive: true, force: true }); }
