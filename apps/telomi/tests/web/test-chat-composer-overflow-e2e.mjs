import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appUrl = process.env.TELOMI_WEB_URL ?? "http://localhost:5174";
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The workspace hoists agent-browser to the repository root; resolve it the way Node would.
const agentBrowser = createRequire(import.meta.url).resolve("agent-browser/bin/agent-browser.js");
const session = `chat-composer-overflow-${process.pid}-${Date.now()}`;

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

function readEvalJson(output) {
	const value = JSON.parse(output);
	return typeof value === "string" ? JSON.parse(value) : value;
}

const goalsResponse = await fetch(new URL("/api/goals", appUrl));
if (!goalsResponse.ok) throw new Error(`failed to load goals: HTTP ${goalsResponse.status}`);
const goals = (await goalsResponse.json()).goals;
const goalId = process.env.TELOMI_WEB_GOAL_ID ?? goals?.[0]?.id;
if (!goalId) throw new Error("no goal available for composer overflow E2E");

const addAccountBadge = String.raw`
(() => {
  const attach = document.querySelector('[data-testid="attach-menu"]');
  if (!attach) throw new Error('attach control missing');
  const controls = attach.parentElement.querySelector(':scope > div');
  const badgeSlot = controls?.children[1];
  if (!badgeSlot) throw new Error('Codex badge slot missing');
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.dataset.testid = 'codex-account-badge-repro';
  badge.className = 'inline-flex items-center gap-1 h-7 px-2 rounded-[6px] border border-transparent text-[12px] leading-[1.1]';
  const icon = document.createElement('span');
  icon.className = 'h-[0.85rem] w-[0.85rem] flex-none';
  icon.textContent = '⚿';
  const label = document.createElement('span');
  label.className = 'max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap';
  label.textContent = '已导入';
  const count = document.createElement('span');
  count.className = 'text-[10px] whitespace-nowrap';
  count.textContent = '1/2';
  badge.append(icon, label, count);
  badgeSlot.replaceChildren(badge);
  const resizeHandle = Array.from(document.querySelectorAll('*'))
    .find((element) => getComputedStyle(element).cursor === 'col-resize');
  if (!resizeHandle) throw new Error('dock resize handle missing');
  const rect = resizeHandle.getBoundingClientRect();
  return JSON.stringify({
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2,
  });
})()
`;

const assertComposerFits = String.raw`
(() => {
  const attach = document.querySelector('[data-testid="attach-menu"]');
  const composer = attach?.closest('form')?.querySelector('.shadow-middle');
  const row = attach?.parentElement;
  if (!composer || !row) throw new Error('composer controls missing');
  const composerRect = composer.getBoundingClientRect();
  const controls = Array.from(row.querySelectorAll('button, label, select')).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const overflow = controls.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      label: element.getAttribute('aria-label') || element.textContent.trim(),
      left: rect.left,
      right: rect.right,
    };
  }).filter(({ left, right }) => left < composerRect.left || right > composerRect.right);
  const result = {
    composerWidth: composerRect.width,
    clientWidth: composer.clientWidth,
    scrollWidth: composer.scrollWidth,
    overflow,
  };
  if (overflow.length || composer.scrollWidth > composer.clientWidth) {
    throw new Error('composer controls overflow: ' + JSON.stringify(result));
  }
  return JSON.stringify(result);
})()
`;

try {
	run(["open", appUrl]);
	run(["set", "viewport", "1067", "1316"]);
	run(["open", `${appUrl}/chat/${encodeURIComponent(goalId)}`]);
	run(["wait", "textarea"]);
	const handle = readEvalJson(run(["eval", "--stdin"], addAccountBadge));
	run(["mouse", "move", String(handle.x), String(handle.y)]);
	run(["mouse", "down"]);
	run(["mouse", "move", "565", String(handle.y)]);
	run(["mouse", "up"]);
	run(["wait", "250"]);
	console.log(run(["eval", "--stdin"], assertComposerFits));
} finally {
	spawnSync(agentBrowser, ["--session", session, "close"], {
		cwd: appDir,
		encoding: "utf8",
	});
}
