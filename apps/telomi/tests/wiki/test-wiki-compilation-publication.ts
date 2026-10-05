import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { hashWikiDirectory } from "../../server/wiki/files.js";
import { executeWikiUpdate, resumeWikiUpdate, wikiUpdateArtifactDir, wikiUpdateRecordDir } from "../../server/wiki/update-runner.js";
import { canResumeWikiUpdateJob, WikiUpdateJobStore } from "../../server/wiki/wiki-update-job.js";
import { listWikiEditions } from "../../server/wiki/editions.js";
import type { GoalTopicPlan, WikiCompilationResult } from "../../server/wiki/contracts.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "wiki-compilation-publication-")));
const goalId = "goal", runId = "wiki-test", goalDir = join(root, goalId);
const runDirectory = wikiUpdateArtifactDir(goalDir, runId);
const controlDirectory = wikiUpdateRecordDir(root, goalId, runId);
const target = join(goalDir, "wiki/knowledge");
const plan: GoalTopicPlan = { schema_version: 1, goal_id: goalId, revision: "v2", status: "active",
 topics: [{ id: "topic", title: "Topic", intent: "Study", questions: [], include: [], exclude: [] }] };
const usage = { inputTokens: 10, outputTokens: 2, costUsd: 0.1, calls: 1 };
try {
 mkdirSync(target, { recursive: true });
 writeFileSync(join(target, "README.md"), "Existing Wiki\n");
 const before = hashWikiDirectory(target);
 const store = new RunArtifactStore(runDirectory);
 const notes = store.publishText("{}", "input/notes.json");
 const candidate = join(root, "candidate");
 mkdirSync(candidate);
 writeFileSync(join(candidate, "README.md"), "Complete Wiki\n");
 writeFileSync(join(candidate, ".topic-plan.json"), JSON.stringify(plan));
 const knowledge = store.publishDirectory(candidate, "artifacts/wiki-compilations/wiki-compilation-test/knowledge-content");
 const complete: WikiCompilationResult = { status: "compiled", publicationReady: true,
  compilationId: "wiki-compilation-test", baseKnowledgeSha256: before, knowledge, pageCount: 7,
  usage, agentStages: 2, sessionPaths: [], failedBatches: [] };
 const jobs = new WikiUpdateJobStore(controlDirectory);
 await assert.rejects(executeWikiUpdate({ goalId, runId, wikiUpdateId: runId, goalDir, workspaceDir: root,
  goal: "Study", goalContext: { title: "Study", description: "" }, topicPlan: plan, runDirectory, controlDirectory,
  sourceNotes: { relative_path: notes.relativePath, sha256: notes.sha256, byte_length: notes.byteLength },
  env: {}, signal: new AbortController().signal, dependencies: {
   compile: async () => ({ ...complete, publicationReady: false,
    failedBatches: [{ batchIndex: 0, sourceIds: ["source:a"], message: "retry me", usage }] }),
   publish: async () => { throw new Error("Partial output must not reach publication"); },
  } }), /成功步骤已保留/u);
 assert.equal(hashWikiDirectory(target), before);
 assert.equal(jobs.load()!.compiler, "wiki-compilation");
 assert.equal(canResumeWikiUpdateJob(jobs.load()!), true);
 const firstResult = readFileSync(join(runDirectory, "artifacts/wiki-update/result.json"), "utf8");
 const resumed = await resumeWikiUpdate({ workspaceDir: root, goalId, goalDir, runId, env: {},
  dependencies: { compile: async request => {
   request.onStarted?.(1);
   request.onBatchProgress?.({ batchIndex: 0, totalBatches: 1, status: "succeeded", pageCount: 1, usage, reused: false });
   request.onStageProgress?.({ kind: "merge-objects", stageIndex: 0, totalStages: 1, status: "succeeded", pageCount: 7, usage });
   return complete;
  } } });
 assert.equal(resumed.status, "succeeded");
 assert.equal(readFileSync(join(target, "README.md"), "utf8"), "Complete Wiki\n");
 assert.equal(jobs.load()!.attempts, 2);
 assert.equal(jobs.load()!.progress!.page_count, 7, "Final progress shows the published page count, not the last Note's count");
 assert.equal(readFileSync(join(runDirectory, "artifacts/wiki-update/result.json"), "utf8"), firstResult,
  "The first failed attempt remains immutable");
 const final = JSON.parse(readFileSync(join(runDirectory, "artifacts/wiki-update/attempt-2/result.json"), "utf8"));
 assert.equal(final.status, "succeeded");
 assert.equal(final.knowledge_ref, knowledge.relativePath);
 writeFileSync(join(target, ".topic-plan.json"), JSON.stringify({ ...plan, revision: "v3" }));
 const historical = listWikiEditions(root, goalId).find(row => row.revision === "v2");
 assert.equal(historical?.root, knowledge.absolutePath, "Historical editions discover content-addressed outputs after recovery");
 console.log("Wiki compilation publication: incomplete work stays unpublished, failed update resumes, immutable attempts remain discoverable");
} finally { rmSync(root, { recursive: true, force: true }); }
