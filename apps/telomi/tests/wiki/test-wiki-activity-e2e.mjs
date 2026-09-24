import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appUrl = process.env.TELOMI_WEB_URL ?? "http://localhost:5174";
const session = `wiki-activity-e2e-${process.pid}-${Date.now()}`;
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const agentBrowser = path.join(appDir, "node_modules", ".bin", "agent-browser");
const browserCwd = process.env.TMPDIR ?? "/tmp";

function run(args, input) {
	const result = spawnSync(agentBrowser, ["--session", session, ...args], {
		cwd: browserCwd,
		encoding: "utf8",
		input,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `agent-browser exited ${result.status}`);
	return result.stdout.trim();
}

const browserCheck = String.raw`
(async () => {
  const React = (await import('/@id/react')).default;
  const { createRoot } = (await import('/@id/react-dom/client')).default;
  const { GoalActivityPanel } = await import('/src/features/goals/GoalActivityPanel.tsx?wiki-e2e=' + Date.now());
  const originalFetch = globalThis.fetch;
  const OriginalEventSource = globalThis.EventSource;
  const now = new Date().toISOString();
  const outputRef = 'wiki-output-fixture';
  const projection = {
    schemaVersion: 1,
    revision: 'wiki-fixture',
    generatedAt: now,
    scope: { kind: 'goal', goalId: 'wiki-e2e' },
    freshness: [],
    summary: { attention: 0, running: 1, queued: 0, waiting: 0 },
    liveActivities: [{
      activityId: 'wiki-update:wiki-1',
      kind: 'wiki-update',
      scope: { kind: 'goal', goalId: 'wiki-e2e' },
      trigger: { kind: 'system' },
      parentActivityId: 'research:run-1',
      title: '更新 Goal Wiki',
      summary: '正在创建 Goal Wiki · 1/2 批 · 3 个页面 · $0.0100',
      lifecycle: 'running',
      progress: { completed: 1, total: 2, label: 'Wiki 批次' },
      timing: { createdAt: now, startedAt: now, updatedAt: now },
      resultLinks: [],
      steps: [{
        stepId: 'wiki-batch:2',
        title: 'Wiki 批次 2',
        summary: 'Wiki Maintainer 正在整理知识页',
        lifecycle: 'running',
        timing: { createdAt: now, startedAt: now, updatedAt: now },
        dependsOnStepIds: ['wiki-batch:1'],
        parallelSteps: [],
        agentActivities: [{
          agentActivityId: 'wiki-maintainer:wiki-1:1',
          agentName: 'wiki_maintainer',
          summary: '正在创建和更新 Wiki 页面',
          lifecycle: 'running',
          timing: { createdAt: now, startedAt: now, updatedAt: now },
          outputRef,
          attempts: [],
        }],
      }, {
        stepId: 'wiki-stage:curation:0',
        title: 'Wiki Curator 1/1',
        summary: '等待整理完整 Wiki',
        lifecycle: 'queued',
        timing: { createdAt: now, queuedAt: now, updatedAt: now },
        dependsOnStepIds: ['wiki-batch:2'],
        parallelSteps: [],
        agentActivities: [],
      }],
      sourceRef: 'wiki-update:wiki-1',
    }],
    history: { items: [] },
  };
  class FakeEventSource { static CLOSED = 2; readyState = 1; close() {} }
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/events/activity-projection')) {
      return new Response(JSON.stringify(projection), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/events/activity-projection/output/')) {
      return new Response(JSON.stringify({
        outputRef,
        lifecycle: 'running',
        lines: [{
          sequence: 1,
          kind: 'tool',
          text: '工具 · Wiki Commit',
          toolCallId: 'wiki-commit-1',
          toolName: 'Wiki Commit',
          toolInput: { path: 'wiki/entities/example.md' },
          toolOutput: 'Wiki page written',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input);
  };
  globalThis.EventSource = FakeEventSource;
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', inset: '0', width: '520px', background: 'white', zIndex: '2147483647' });
  document.body.append(host);
  const root = createRoot(host);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, description) => {
    for (let index = 0; index < 80; index++) { if (check()) return; await wait(50); }
    throw new Error('timed out waiting for ' + description);
  };
  try {
    root.render(React.createElement(GoalActivityPanel, { goalId: 'wiki-e2e' }));
    await waitFor(() => host.innerText.includes('正在创建 Goal Wiki'), 'Wiki Activity');
    const replay = host.querySelector('button[aria-label="查看 Wiki 批次 2 · Wiki Maintainer 1 回放"]');
    if (!replay) throw new Error('Wiki replay action is missing');
    replay.click();
    await waitFor(() => host.innerText.includes('Wiki Commit'), 'Wiki Agent replay');
    const stage = replay.closest('.goal-activity-step');
    if (!stage?.querySelector('.goal-activity-replay')) throw new Error('Trace must expand inside its own stage');
    if (!host.innerText.includes('SHARD 整理') || !host.innerText.includes('WIKI CURATOR')) {
      throw new Error('Wiki stages must be grouped as a progressive timeline');
    }
    if (replay.textContent.includes('查看回放')) throw new Error('Replay must not use the old prominent button label');
    if (host.innerText.includes('Wiki page written')) throw new Error('Trace detail must remain collapsed');
    return JSON.stringify({ running: host.innerText.includes('1 运行中'), replay: true, inline: true, progress: host.innerText.includes('Wiki 批次 2') });
  } finally {
    root.unmount();
    host.remove();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = OriginalEventSource;
  }
})()
`;

try {
	run(["open", appUrl]);
	console.log(run(["eval", "--stdin"], browserCheck));
} finally {
	spawnSync(agentBrowser, ["--session", session, "close"], { cwd: browserCwd, encoding: "utf8" });
}
