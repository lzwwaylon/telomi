import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appUrl = process.env.TELOMI_WEB_URL ?? "http://localhost:5174";
const session = `media-generate-status-e2e-${process.pid}-${Date.now()}`;
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The workspace hoists agent-browser to the repository root; resolve it the way Node would.
const agentBrowser = createRequire(import.meta.url).resolve("agent-browser/bin/agent-browser.js");

function run(args, input) {
	const result = spawnSync(agentBrowser, ["--session", session, ...args], {
		cwd: appDir,
		encoding: "utf8",
		input,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `agent-browser exited ${result.status}`);
	}
	return result.stdout.trim();
}

const browserCheck = String.raw`
(async () => {
  const React = (await import('/@id/react')).default;
  const { createRoot } = (await import('/@id/react-dom/client')).default;
  const { useMediaProductStatus } = await import(
    '/src/features/goals/data/useMediaProductStatus.ts?generate-status-e2e=' + Date.now()
  );
  const originalFetch = window.fetch;
  const goalId = 'goal_media_generate_status_e2e';
  const cardId = 'report';
  let generatePosts = 0;
  window.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/media-products/report/status')) {
      return new Response(JSON.stringify({
        cardId,
        sourceMtimeMs: 0,
		podcast: { status: 'idle', implemented: true },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'POST' && url.includes('/media-products/report/generate')) {
      generatePosts += 1;
      return new Response(JSON.stringify({ jobId: 'job_e2e', status: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  };

  const mount = document.createElement('div');
  document.body.append(mount);
  const root = createRoot(mount);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, description) => {
    for (let i = 0; i < 40; i++) {
      if (check()) return;
      await wait(50);
    }
    throw new Error('timed out waiting for ' + description + ': ' + mount.textContent);
  };
  function Harness() {
		const { state, triggerGenerate } = useMediaProductStatus(goalId, cardId);
    return React.createElement(
      'button',
      {
        disabled: state.status === 'running',
			onClick: () => void triggerGenerate(),
      },
      state.status,
    );
  }

  try {
    root.render(React.createElement(Harness));
    await waitFor(() => mount.textContent === 'idle', 'initial idle state');
    mount.querySelector('button').click();
    await waitFor(() => mount.textContent === 'running', 'POST response to update running state');
    if (generatePosts !== 1 || !mount.querySelector('button').disabled) {
      throw new Error('media generate state regression: ' + JSON.stringify({
        generatePosts,
        text: mount.textContent,
        disabled: mount.querySelector('button').disabled,
      }));
    }
    return JSON.stringify({ generatePosts, status: mount.textContent, disabled: true });
  } finally {
    window.fetch = originalFetch;
    root.unmount();
    mount.remove();
  }
})()
`;

try {
	run(["open", appUrl]);
	console.log(run(["eval", "--stdin"], browserCheck));
} finally {
	spawnSync(agentBrowser, ["--session", session, "close"], {
		cwd: appDir,
		encoding: "utf8",
	});
}
