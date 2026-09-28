import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWikiUpdateTool } from '../../server/main-agent/tools/wiki-update.js';
import { RunArtifactStore } from '../../server/agent-runtime/artifact-store.js';
import { GoalTopicPlanStore } from '../../server/goals/topic-plan/index.js';
import { serverRuntimeDirForGoal } from '../../server/workspaces/server-runtime-paths.js';
import { startWikiUpdateActivity, wikiUpdateRecordDir } from '../../server/wiki/update-runner.js';
import { WikiUpdateJobStore } from '../../server/wiki/wiki-update-job.js';

if (process.argv.includes('--probe')) await probe();
else {
 const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), '--probe'], { encoding: 'utf8' });
 assert.equal(child.status, 0, child.stderr);
 assert.equal(child.stdout.split('"activityStatus":"failed"').length - 1, 2);
 console.log('Wiki Tool observes background rejection while Runtime retains failed Activities');
}

async function probe(): Promise<void> {
const root = mkdtempSync(join(tmpdir(), 'wiki-tool-background-'));
try {
 for (const mode of ['failure', 'partial']) {
  const workspaceDir = join(root, mode), goalId = `goal-${mode}`, runId = 'source-run';
  const goalDir = join(workspaceDir, goalId);
  const sourceRunDirectory = join(goalDir, 'wiki/runs', runId);
  const note = new RunArtifactStore(sourceRunDirectory).publishText('{}', 'notes.json');
  const cornellNotes = { relative_path: note.relativePath, sha256: note.sha256, byte_length: note.byteLength };
  const sourceControl = join(serverRuntimeDirForGoal(goalId, workspaceDir), 'runs', runId);
  mkdirSync(sourceControl, { recursive: true });
  writeFileSync(join(sourceControl, 'run-state.json'), JSON.stringify({ goal_id: goalId, run_id: runId, question: 'Conditions', cornell_note_snapshots: [cornellNotes] }));
  const store = new GoalTopicPlanStore(goalId, workspaceDir);
  const proposal = store.proposePatch({ source: 'main_agent', patch: { schema_version: 1, base_revision: null, summary: 'Test', operations: [{ op: 'add', topic: { id: 'methods', title: 'Methods', intent: 'Understand conditions', questions: [], include: [], exclude: [] } }] } });
  store.activate(proposal.proposal_id);
  let started!: ReturnType<typeof startWikiUpdateActivity>;
  const tool = createWikiUpdateTool({ goalId, goalDir, workspaceDir, goalTitle: 'Methods', getEnv: () => ({}) }, input => {
   started = startWikiUpdateActivity({ ...input, dependencies: {
    compile: async () => {
     await nextTurn();
     if (mode === 'failure') throw new Error('Injected asynchronous Wiki failure');
     return { status: 'compiled', publicationReady: false, compilationId: 'partial', baseKnowledgeSha256: 'a'.repeat(64),
      knowledge: { relativePath: 'candidate', absolutePath: join(root, 'candidate'), sha256: 'b'.repeat(64), byteLength: 0, files: [] },
      pageCount: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, agentStages: 1, sessionPaths: [],
      failedBatches: [{ batchIndex: 0, sourceIds: ['source'], message: 'Topic failed', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 } }] };
    },
    publish: async () => assert.fail('Failed candidate must never publish'),
   } });
   return started;
  });
  const receipt = await tool.execute('tool-call', { source_run_id: runId, reason: 'Refresh Wiki', rebuild: false });
  assert.deepEqual(receipt.details, { wikiUpdateId: started.wikiUpdateId, sourceRunId: runId, action: 'started' });
  assert.match(JSON.stringify(receipt.content), /Activity started/);
  assert.doesNotMatch(JSON.stringify(receipt.content), /succeeded|published/);
  // Deliberately do not await started.execution: the real Tool returns immediately.
  await nextTurn(); await nextTurn(); await nextTurn();
  const job = new WikiUpdateJobStore(wikiUpdateRecordDir(workspaceDir, goalId, started.wikiUpdateId)).load();
  assert.ok(job);
  assert.equal(job.status, 'failed');
  assert.ok(job.message);
  assert.equal(job.publication_status, undefined);
  console.log(JSON.stringify({ mode, returned: 'started', activityStatus: job.status, processSurvived: true }));
 }
} finally { rmSync(root, { recursive: true, force: true }); }

}
