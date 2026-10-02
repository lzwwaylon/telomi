import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/store.js";
import { createWikiUpdateTool } from "../../server/main-agent/tools/wiki-update.js";
import { createMainAgentTools } from "../../server/main-agent/tools/index.js";
import { sha256 } from "../../server/lib/hash.js";
import { registerSavedInvestigationCues, startGoalCueWikiUpdates } from "../../server/research/cue-wiki-trigger.js";
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
 registerSavedInvestigationCues(target);
 assert.equal(getCueWikiQueueStatus(target).pendingCount, 1, "startup reconciles a committed Cue without repeating registration");
 const queue = JSON.parse(readFileSync(join(runtime, "cue-wiki-queue.json"), "utf8"));
 assert.equal(queue.entries[0].origin.thread_id, threadId);
 assert.equal(queue.entries[0].origin.artifact_ref.sha256, artifact.sha256);
 const goalContext = { title: "Speech", description: "" };
 assert.equal((await startGoalCueWikiUpdates({ ...target, goalContext, env: {} }).execution).status, "pending", "Topic confirmation is required before model work");
 const replayTool = createMainAgentTools(goalDir, { goalId, workspaceDir, deferCueWikiUpdates: true })
  .find(tool => tool.name === "wiki_update")!;
 for (const input of [
  { reason: "Organize saved evidence", rebuild: false },
  { reason: "Rebuild Wiki", rebuild: true },
  { reason: "Refresh historical evidence", rebuild: false, source_run_id: "original" },
 ]) {
  const deferred = await replayTool.execute("replay-wiki", input);
  assert.equal(deferred.details?.action, "deferred", "Main Replay must not start independently owned Wiki workers");
 }
 let calls = 0;
 const tool = createWikiUpdateTool({ ...target, goalTitle: "Speech", getEnv: () => ({}) }, input => {
  calls++;
  const snapshot = JSON.parse(readFileSync(new RunArtifactStore(input.sourceRunDirectory).openFile(input.cornellNotes).absolutePath, "utf8"));
  assert.equal(input.sourceRunId, undefined, "whole-corpus rebuild never invents a Research Run");
  assert.equal(input.rebuild, true);
  assert.equal(snapshot.notes[0].source_run_id, "original");
  assert.equal(snapshot.notes[0].note.sections[0].cue_notes[0].origin_ref, notes.cues[0].ref);
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
 await tool.execute("rebuild", { reason: "User requested rebuild", rebuild: true });
 await tool.execute("rebuild-again", { reason: "User requested rebuild", rebuild: true });
 assert.equal(calls, 2, "the immutable corpus snapshot is reusable by explicit rebuilds");
 const candidate = new RunArtifactStore(join(goalDir, "wiki/test-candidate"));
 candidate.publishText("# Candidate\n", "knowledge/README.md");
 const output = candidate.describeDirectory("knowledge");
 const compilation = { status: "compiled" as const, compilationId: "candidate", baseKnowledgeSha256: hashWikiDirectory(join(goalDir, "wiki/knowledge")),
  knowledge: output, pageCount: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, agentStages: 0, sessionPaths: [], failedBatches: [] };
 await assert.rejects(publishCompilation({ ...target, compilation, topicPlanRevision: "superseded" }), /topic_drift/u);
 await publishCompilation({ ...target, compilation, topicPlanRevision: topics.readActive()!.revision });
 assert.equal(readFileSync(join(goalDir, "wiki/knowledge/README.md"), "utf8"), "# Candidate\n");
 console.log("Cue commit/startup registration, manual maintenance, whole-corpus rebuild and Topic publication guard passed");
} finally { rmSync(workspaceDir, { recursive: true, force: true }); }
