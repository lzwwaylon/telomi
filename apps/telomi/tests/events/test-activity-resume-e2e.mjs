import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appUrl = process.env.TELOMI_WEB_URL ?? "http://localhost:5174";
const session = `activity-resume-e2e-${process.pid}-${Date.now()}`;
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The workspace hoists agent-browser to the repository root; resolve it the way Node would.
const agentBrowser = createRequire(import.meta.url).resolve("agent-browser/bin/agent-browser.js");
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
  const { GoalActivityPanel } = await import(
    '/src/features/goals/GoalActivityPanel.tsx?resume-e2e=' + Date.now()
  );
  const { ArtifactsContext } = await import('/src/stream/ArtifactsContext.tsx');
  const originalFetch = globalThis.fetch;
  const OriginalEventSource = globalThis.EventSource;
  const now = new Date().toISOString();
  const resumeHref = '/api/goals/resume-e2e/research-runs/run-interrupted/resume';
  let posted;
  let openedArtifact;
  const projection = {
    schemaVersion: 1,
    revision: 'resume-fixture',
    generatedAt: now,
    scope: { kind: 'goal', goalId: 'resume-e2e' },
    freshness: [],
    summary: { attention: 1, running: 0, queued: 0, waiting: 1 },
    liveActivities: [{
      activityId: 'research:run-interrupted',
      kind: 'research',
      scope: { kind: 'goal', goalId: 'resume-e2e' },
      trigger: { kind: 'manual' },
      title: '断点续跑验证',
      summary: '研究已中断，可以继续运行',
      lifecycle: 'waiting',
      timing: { createdAt: now, startedAt: now, updatedAt: now, waitingSince: now },
      waiting: { kind: 'external', reason: '后端进程停止', waitingSince: now, actions: [] },
      attention: {
        kind: 'failure',
        summary: '本次研究已保存检点，可以从中断的 Agent 继续运行。',
        actions: [{
          actionId: 'resume:run-interrupted',
          kind: 'continue',
          label: '继续运行',
          enabled: true,
          requiresConfirmation: false,
          href: resumeHref,
        }],
      },
      resultLinks: [{
        kind: 'report',
        label: '打开研究报告',
        href: '/api/goals/resume-e2e/artifacts/blob?name=report.md',
        workspacePath: 'wiki/runs/run-interrupted/report/final.md',
        available: true,
        primary: true,
      }],
      steps: [],
      sourceRef: 'research:run-interrupted',
    }],
    history: { items: [] },
  };
  class FakeEventSource { static CLOSED = 2; readyState = 1; close() {} }
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/api/goals/resume-e2e/events/activity-projection')) {
      return new Response(JSON.stringify(projection), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === resumeHref && init?.method === 'POST') {
      posted = { url, method: init.method };
      return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
  globalThis.EventSource = FakeEventSource;
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', inset: '0', width: '440px', background: 'white', zIndex: '2147483647' });
  document.body.append(host);
  const root = createRoot(host);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, description) => {
    for (let index = 0; index < 80; index++) { if (check()) return; await wait(50); }
    throw new Error('timed out waiting for ' + description);
  };
  try {
    root.render(React.createElement(
      ArtifactsContext.Provider,
      { value: { openArtifact: (path) => { openedArtifact = path; }, openArtifactPage: () => {} } },
      React.createElement(GoalActivityPanel, { goalId: 'resume-e2e' }),
    ));
    await waitFor(() => host.innerText.includes('断点续跑验证'), 'interrupted activity');
    host.querySelector('.goal-activity-row-trigger').click();
    await waitFor(() => host.innerText.includes('继续运行'), 'resume action');
    const action = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '继续运行');
    if (!action || action.disabled) throw new Error('resume action is missing or disabled');
    const report = Array.from(host.querySelectorAll('button')).find((button) => button.textContent.includes('打开研究报告'));
    if (!report) throw new Error('report result must use the in-app artifact button');
    report.click();
    await waitFor(() => openedArtifact, 'rendered report artifact');
    action.click();
    await waitFor(() => posted, 'resume POST request');
    return JSON.stringify({ posted, openedArtifact, lifecycle: 'waiting', actionLabel: action.textContent });
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
