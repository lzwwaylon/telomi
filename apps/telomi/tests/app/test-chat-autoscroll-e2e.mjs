import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appUrl = process.env.TELOMI_WEB_URL ?? "http://localhost:5174";
const session = `chat-autoscroll-e2e-${process.pid}-${Date.now()}`;
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBrowser = path.join(appDir, "node_modules", ".bin", "agent-browser");

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
  const { MessageList } = await import('/src/components/MessageList.tsx?autoscroll-e2e=' + Date.now());
  const scroller = document.createElement('div');
  Object.assign(scroller.style, {
    position: 'fixed',
    inset: '0 auto auto 0',
    width: '520px',
    height: '240px',
    overflowY: 'auto',
    zIndex: '2147483647',
    background: 'white',
  });
  const mount = document.createElement('div');
  scroller.append(mount);
  document.body.append(scroller);
  const root = createRoot(mount);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, description) => {
    for (let i = 0; i < 40; i++) {
      if (check()) {
        await wait(50);
        return;
      }
      await wait(50);
    }
    throw new Error('timed out waiting for ' + description);
  };
  const waitForText = (text) => waitFor(
    () => scroller.innerText.includes(text),
    'rendered text: ' + text,
  );
  const user = (i) => ({
    role: 'user',
    content: [{ type: 'text', text: ('历史消息 ' + i + ' ').repeat(8) }],
    timestamp: i,
  });
  const assistant = (lines) => ({
    role: 'assistant',
    content: [{
      type: 'text',
      text: Array.from({ length: lines }, (_, i) => '输出第 ' + (i + 1) + ' 行').join('\n'),
    }],
    timestamp: 25,
  });
  const base = Array.from({ length: 24 }, (_, i) => user(i));
  const render = (messages) => root.render(React.createElement(MessageList, {
    messages,
    pendingToolCalls: [],
    isStreaming: true,
    goalId: 'chat-autoscroll-e2e',
  }));

  try {
    render(base);
    await wait(300);
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await wait(50);

    const withNewUser = [...base, user(24)];
    render(withNewUser);
    await wait(300);
    const gapAfterNewMessage = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

    const heightBeforeStreaming = scroller.scrollHeight;
    render([...withNewUser, assistant(40)]);
    await waitForText('输出第 40 行');
    await waitFor(
      () => scroller.scrollHeight > heightBeforeStreaming,
      'the streaming layout',
    );
    await waitFor(
      () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 20,
      'the streaming automatic scroll',
    );
    const gapDuringStreaming = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

    scroller.scrollTop -= 10;
    scroller.dispatchEvent(new Event('scroll'));
    await wait(50);
    const manualTop = scroller.scrollTop;
    const heightBeforeUpwardUpdate = scroller.scrollHeight;
    render([...withNewUser, assistant(60)]);
    await waitForText('输出第 60 行');
    await waitFor(
      () => scroller.scrollHeight > heightBeforeUpwardUpdate,
      'the streaming layout after upward scroll',
    );
    const topAfterUpwardUpdate = scroller.scrollTop;

    const result = {
      gapAfterNewMessage,
      gapDuringStreaming,
      preservedAfterUpwardScroll: Math.abs(topAfterUpwardUpdate - manualTop) < 1,
    };
    if (
      result.gapAfterNewMessage >= 20
      || result.gapDuringStreaming >= 20
      || !result.preservedAfterUpwardScroll
    ) {
      throw new Error('autoscroll regression: ' + JSON.stringify(result));
    }
    return JSON.stringify(result);
  } finally {
    root.unmount();
    scroller.remove();
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
