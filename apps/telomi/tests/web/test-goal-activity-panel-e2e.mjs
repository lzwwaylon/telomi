import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appUrl = process.env.TELOMI_WEB_URL ?? "http://localhost:5174";
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const agentBrowser = path.join(appDir, "node_modules", ".bin", "agent-browser");
const session = `goal-activity-panel-e2e-${process.pid}-${Date.now()}`;
const screenshots = [];
const initScriptPath = `/tmp/telomi-goal-activity-panel-e2e-${process.pid}.js`;

function run(args, input) {
	const result = spawnSync(agentBrowser, ["--session", session, ...args], {
		cwd: appDir,
		encoding: "utf8",
		input,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `agent-browser exited ${result.status}`);
	return result.stdout.trim();
}

function evaluate(script) {
	const value = JSON.parse(run(["eval", "--stdin"], script));
	return typeof value === "string" ? JSON.parse(value) : value;
}

const goalsResponse = await fetch(new URL("/api/goals", appUrl));
if (!goalsResponse.ok) throw new Error(`failed to load goals: HTTP ${goalsResponse.status}`);
const goalId = process.env.TELOMI_WEB_GOAL_ID ?? (await goalsResponse.json()).goals?.[0]?.id;
if (!goalId) throw new Error("no goal available for Activity panel E2E");

const fixtureTitle = "Fixture research: compare streaming TTS vocoders across latency, quality and licensing for the Chinese voice pipeline";
const fixtureId = "e2e_activity_fixture";

// Existing Goal copies carry Activities without execution records, and the Activities that would record one
// (research, Wiki Update, file ingestion) all run Agents against a model. So the page's fetch is wrapped before
// the app loads: the real projection and global summary gain one running Activity with Activity Steps, a worker
// pool and execution records, so the top bar jumps to this Goal's panel when it is the only active Goal.
const fixtureInitScript = String.raw`
(() => {
  const goalId = ${JSON.stringify(goalId)};
  const title = ${JSON.stringify(fixtureTitle)};
  const activityId = ${JSON.stringify(fixtureId)};
  const now = new Date().toISOString();
  const timing = { createdAt: now, updatedAt: now };
  const agent = (id, agentName, lifecycle) => ({
    agentActivityId: 'agent_' + id,
    agentName,
    summary: 'Working on ' + id,
    lifecycle,
    outcome: lifecycle === 'finished' ? 'succeeded' : undefined,
    timing,
    outputRef: 'output_' + id,
    attempts: [],
  });
  const step = (id, stepTitle, lifecycle, agentActivities, parallelSteps = []) => ({
    stepId: 'step_' + id,
    title: stepTitle,
    summary: '',
    lifecycle,
    outcome: lifecycle === 'finished' ? 'succeeded' : undefined,
    timing,
    dependsOnStepIds: [],
    parallelSteps,
    agentActivities,
  });
  const notes = ['finished', 'finished', 'finished', 'running', 'running'].map((lifecycle, index) =>
    step('note_' + index, 'Note ' + (index + 1), lifecycle, [agent('note_' + index, 'cornell_note', lifecycle)]));
  const fixture = {
    activityId,
    kind: 'research',
    scope: { kind: 'goal', goalId },
    trigger: { kind: 'manual' },
    title,
    summary: 'Fixture summary that belongs in the detail pane only.',
    lifecycle: 'running',
    timing,
    progress: { completed: 1, total: 2 },
    resultLinks: [],
    steps: [
      step('plan', 'Plan the search', 'finished', [agent('plan', 'prime_search', 'finished')]),
      step('notes', 'Write notes', 'running', [], notes),
    ],
    sourceRef: 'research:e2e_fixture',
  };
  const output = (outputRef) => ({
    outputRef,
    lifecycle: 'finished',
    outcome: 'succeeded',
    lines: [
      { sequence: 1, kind: 'status', text: 'Started search' },
      { sequence: 2, kind: 'tool', text: '', toolCallId: 'call_1', toolName: 'web_search', toolInput: { query: 'streaming vocoder latency' }, toolOutput: '12 results' },
      { sequence: 3, kind: 'text', text: 'Intermediate finding\nThree vocoders trade latency for quality.' },
    ],
  });
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    const projectionPath = '/api/goals/' + encodeURIComponent(goalId) + '/events/activity-projection';
    if (url.pathname.startsWith(projectionPath + '/output/')) {
      return json(output(decodeURIComponent(url.pathname.slice(projectionPath.length + '/output/'.length))));
    }
    if (url.pathname === projectionPath && !url.searchParams.has('cursor')) {
      const body = await (await realFetch(input, init)).json();
      body.liveActivities = [fixture, ...body.liveActivities.filter((item) => item.activityId !== activityId)];
      body.summary = { ...body.summary, running: body.summary.running + 1 };
      return json(body);
    }
    if (url.pathname === '/api/events/activity-projection/summary') {
      const body = await (await realFetch(input, init)).json();
      const goal = body.goals.find((candidate) => candidate.goalId === goalId);
      const summary = { attention: 0, running: 0, queued: 0, waiting: 0, ...goal?.summary };
      body.summary = { ...body.summary, running: body.summary.running + 1 };
      body.goals = [...body.goals.filter((candidate) => candidate !== goal), { ...goal, goalId, summary: { ...summary, running: summary.running + 1 } }];
      return json(body);
    }
    return realFetch(input, init);
  };
})();
`;

// Shared in-page helpers; every check below runs inside one panel root.
const helpers = String.raw`
  const panel = document.querySelector('[data-testid="goal-activity-panel"]');
  if (!panel) throw new Error('Activity panel missing');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, label) => {
    for (let i = 0; i < 60; i++) {
      const value = check();
      if (value) return value;
      await wait(50);
    }
    throw new Error('timed out waiting for ' + label);
  };
  const scrollHost = () => {
    for (let element = panel.parentElement; element; element = element.parentElement) {
      const overflow = getComputedStyle(element).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && element.scrollHeight > element.clientHeight) return element;
    }
    return document.scrollingElement;
  };
  const tag = (element, name) => {
    document.querySelectorAll('[data-e2e="' + name + '"]').forEach((node) => node.removeAttribute('data-e2e'));
    if (!element) throw new Error('missing element for ' + name);
    element.setAttribute('data-e2e', name);
  };
  const rows = () => [...panel.querySelectorAll('[data-testid="activity-row"]')];
  const fixtureRow = () => rows().find((row) => row.querySelector('[title=' + JSON.stringify(${JSON.stringify(fixtureTitle)}) + ']'));
  const active = () => document.activeElement;
`;

const inPanel = (body) => evaluate(`(async () => {${helpers}${body}})()`);

function assertList() {
	return inPanel(String.raw`
    await waitFor(() => fixtureRow(), 'fixture row');
    const list = panel.querySelector('.goal-activity-view.is-list');
    if (panel.getAttribute('aria-labelledby') !== 'goal-activity-title') throw new Error('panel is not labelled by its heading');
    const text = list.textContent;
    for (const removed of ['实时 Activity', '历史 Activity', '活动概览', 'Fixture summary that belongs']) {
      if (text.includes(removed)) throw new Error('list still shows ' + removed);
    }
    if (!/1 运行中/u.test(panel.querySelector('.goal-activity-counts')?.textContent || '')) throw new Error('running count missing from header');
    const heights = rows().map((row) => Math.round(row.getBoundingClientRect().height));
    if (heights.some((height) => height !== 36 && height !== 28)) throw new Error('row is not a single line: ' + heights);
    const title = fixtureRow().querySelector('.goal-activity-row-title');
    if (title.scrollWidth <= title.clientWidth) throw new Error('long title is not truncated');
    if (fixtureRow().querySelector('.goal-activity-annotation')?.textContent !== '1/2') throw new Error('running row lacks its Activity Step fraction');
    // Rows below an earlier day's divider show only the clock time; the divider already names the day.
    let dayLabel = null;
    const duplicated = [];
    for (const node of panel.querySelectorAll('.goal-activity-timeline > *')) {
      if (node.matches('[data-testid="activity-timeline-divider"]')) dayLabel = node.textContent;
      else if (dayLabel && dayLabel !== '今天' && !/^\d{2}:\d{2}$/u.test(node.querySelector('time')?.textContent || '')) duplicated.push(node.querySelector('time')?.textContent);
    }
    if (duplicated.length) throw new Error('row times repeat the divider date: ' + duplicated);
    const glyph = fixtureRow().querySelector('.activity-glyph');
    const glyphRect = glyph.getBoundingClientRect();
    const rail = getComputedStyle(panel.querySelector('.goal-activity-timeline'), '::before');
    const railCenter = panel.querySelector('.goal-activity-timeline').getBoundingClientRect().left + parseFloat(rail.left) + 0.5;
    if (Math.abs(glyphRect.left + glyphRect.width / 2 - railCenter) > 1) throw new Error('state glyph is off the rail');
    if (Math.round(glyphRect.width) !== 9 || !glyph.getAttribute('aria-label')) throw new Error('state glyph size or label is wrong');
    return { rows: heights.length, dividers: panel.querySelectorAll('[data-testid="activity-timeline-divider"]').length };
  `);
}

// Keyboard opens a history row lower in the list; Escape returns to the same scroll position and row.
function openRowByKeyboard() {
	const before = inPanel(String.raw`
    const target = rows()[Math.min(12, rows().length - 1)];
    tag(target, 'history-row');
    const host = scrollHost();
    host.scrollTop += target.getBoundingClientRect().top - host.getBoundingClientRect().top - 120;
    await wait(100);
    target.focus();
    return { scrollTop: host.scrollTop };
  `);
	if (before.scrollTop <= 0) throw new Error("list host did not scroll before opening a row");
	run(["press", "Enter"]);
	inPanel(String.raw`
    const detail = await waitFor(() => panel.querySelector('[data-testid="activity-detail"]'), 'detail pane');
    if (active()?.dataset.testid !== 'activity-detail-back') throw new Error('Back does not take focus in the detail pane');
    if (panel.querySelector('.goal-activity-view.is-list').getAttribute('aria-hidden') !== 'true') throw new Error('pushed list is not hidden from assistive tech');
    const heading = detail.querySelector('.goal-activity-detail-head h3');
    if (!heading?.title) throw new Error('detail heading has no title hint');
    return true;
  `);
	run(["press", "Escape"]);
	const after = inPanel(String.raw`
    await waitFor(() => !panel.querySelector('[data-testid="activity-detail"]'), 'list after Escape');
    return { scrollTop: scrollHost().scrollTop, focused: active()?.dataset.e2e };
  `);
	if (Math.abs(after.scrollTop - before.scrollTop) > 1) throw new Error(`scroll moved from ${before.scrollTop} to ${after.scrollTop}`);
	if (after.focused !== "history-row") throw new Error("focus did not return to the opened row");
	return before.scrollTop;
}

function openFixtureDetail() {
	// Bring the row into view first; agent-browser would otherwise scroll it there during the click.
	const before = inPanel(String.raw`
    tag(fixtureRow(), 'fixture-row');
    fixtureRow().scrollIntoView({ block: 'center' });
    await wait(100);
    return scrollHost().scrollTop;
  `);
	run(["click", '[data-e2e="fixture-row"]']);
	inPanel(String.raw`
    const detail = await waitFor(() => panel.querySelector('[data-testid="activity-detail"]'), 'fixture detail');
    await waitFor(() => detail.querySelector('.goal-activity-step'), 'Activity Steps');
    const heading = detail.querySelector('.goal-activity-detail-head h3');
    if (heading.title !== ${JSON.stringify(fixtureTitle)} || heading.scrollWidth <= heading.clientWidth) throw new Error('detail heading is not truncated with a title hint');
    if (!detail.textContent.includes('Fixture summary that belongs in the detail pane only.')) throw new Error('detail summary missing');
    if (!detail.querySelector('[role="progressbar"][aria-valuenow="1"][aria-valuemax="2"]')) throw new Error('progress bar missing');
    const pool = detail.querySelector('[data-testid="activity-worker-pool"]');
    if (!pool?.getAttribute('aria-label')) throw new Error('worker pool is not labelled');
    const workers = [...pool.querySelectorAll('button[data-testid="activity-worker-row"]')];
    if (workers.length !== 4 || workers.some((worker) => !/^查看 Note \d · Cornell Note 的执行记录$/u.test(worker.getAttribute('aria-label') || ''))) {
      throw new Error('worker cards lack execution record labels: ' + workers.map((worker) => worker.getAttribute('aria-label')));
    }
    const toggle = pool.querySelector('[aria-expanded]');
    if (toggle?.getAttribute('aria-expanded') !== 'false') throw new Error('worker pool toggle is missing aria-expanded');
    toggle.click();
    await waitFor(() => pool.querySelectorAll('[data-testid="activity-worker-row"]').length === 5 && toggle.getAttribute('aria-expanded') === 'true', 'all workers');
    toggle.click();
    await waitFor(() => toggle.getAttribute('aria-expanded') === 'false', 'collapsed workers');
    return true;
  `);
	return before;
}

function assertReplayFlow() {
	// Keyboard opens the Step's execution record.
	inPanel(String.raw`
    const step = panel.querySelector('button.goal-activity-step');
    if (step.getAttribute('aria-haspopup') !== 'dialog' || !/执行记录/u.test(step.getAttribute('aria-label') || '')) throw new Error('Step trigger lacks dialog aria');
    tag(step, 'step');
    step.focus();
    return true;
  `);
	run(["press", "Enter"]);
	evaluate(String.raw`(async () => {
    ${helpers}
    const overlay = await waitFor(() => document.querySelector('[data-testid="activity-replay-overlay"]'), 'execution record overlay');
    await waitFor(() => overlay.textContent.includes('web_search'), 'execution record rows');
    if (overlay.getAttribute('role') !== 'dialog') throw new Error('overlay is not a dialog');
    const titleId = overlay.getAttribute('aria-labelledby');
    if (document.getElementById(titleId)?.textContent !== '执行记录') throw new Error('overlay is not labelled by its title');
    if (!overlay.querySelector('[aria-live="polite"]')) throw new Error('overlay body is not live');
    if (!overlay.textContent.includes('Plan the search · Prime Search · 3 条')) throw new Error('overlay subtitle missing');
    // Layout width, so the open zoom animation does not skew it.
    const width = overlay.offsetWidth;
    if (width !== 420) throw new Error('overlay width ' + width + ' differs from the 420px prototype');
    if (!overlay.contains(active())) throw new Error('focus is not inside the overlay');
    const tool = [...overlay.querySelectorAll('[role="button"]')].find((row) => row.textContent.includes('web_search'));
    tag(tool, 'tool-row');
    return true;
  })()`);
	// Mouse opens the tool call on top; Escape closes one level and returns focus to the tool row.
	run(["click", '[data-e2e="tool-row"]']);
	evaluate(String.raw`(async () => {
    ${helpers}
    await waitFor(() => document.querySelectorAll('[role="dialog"]').length === 2, 'tool call overlay');
    return true;
  })()`);
	run(["press", "Escape"]);
	evaluate(String.raw`(async () => {
    ${helpers}
    await waitFor(() => document.querySelectorAll('[role="dialog"]').length === 1, 'tool overlay to close');
    await waitFor(() => active()?.dataset.e2e === 'tool-row', 'focus back on the tool row');
    return true;
  })()`);
	run(["press", "Escape"]);
	inPanel(String.raw`
    await waitFor(() => !document.querySelector('[data-testid="activity-replay-overlay"]'), 'overlay to close');
    await waitFor(() => active()?.dataset.e2e === 'step', 'focus back on the Step');
    if (!panel.querySelector('[data-testid="activity-detail"]')) throw new Error('Escape in the overlay also closed the detail pane');
    tag(panel.querySelector('button[data-testid="activity-worker-row"]'), 'worker');
    return true;
  `);
	// A worker opens its own record; the close button returns focus to the worker card.
	run(["click", '[data-e2e="worker"]']);
	evaluate(String.raw`(async () => {
    ${helpers}
    const overlay = await waitFor(() => document.querySelector('[data-testid="activity-replay-overlay"]'), 'worker overlay');
    // A pool worker's record names its own parallel Activity Step.
    const worker = document.querySelector('[data-e2e="worker"]').getAttribute('aria-label').replace(/^查看 (.+) 的执行记录$/u, '$1');
    await waitFor(() => overlay.textContent.includes(worker), 'worker overlay subtitle');
    tag(overlay.querySelector('.goal-activity-replay-head button'), 'overlay-close');
    return true;
  })()`);
	run(["click", '[data-e2e="overlay-close"]']);
	inPanel(String.raw`
    await waitFor(() => !document.querySelector('[data-testid="activity-replay-overlay"]'), 'worker overlay to close');
    await waitFor(() => active()?.dataset.e2e === 'worker', 'focus back on the worker');
    tag(panel.querySelector('[data-testid="activity-detail-back"]'), 'back');
    return true;
  `);
}

function backToList(scrollTop) {
	run(["click", '[data-e2e="back"]']);
	const after = inPanel(String.raw`
    await waitFor(() => !panel.querySelector('[data-testid="activity-detail"]'), 'list after Back');
    return { scrollTop: scrollHost().scrollTop, focused: active()?.dataset.e2e };
  `);
	if (Math.abs(after.scrollTop - scrollTop) > 1) throw new Error(`Back moved the list from ${scrollTop} to ${after.scrollTop}`);
	if (after.focused !== "fixture-row") throw new Error("Back did not return focus to the fixture row");
}

function assertFilters() {
	inPanel(String.raw`
    const group = panel.querySelector('.goal-activity-filters');
    if (group.getAttribute('role') !== 'group' || !group.getAttribute('aria-label')) throw new Error('filters are not a labelled group');
    const filter = (label) => [...group.querySelectorAll('button')].find((button) => button.textContent === label);
    tag(filter('调研'), 'filter-research');
    return true;
  `);
	run(["click", '[data-e2e="filter-research"]']);
	inPanel(String.raw`
    // Research keeps the fixture and hides the Goal's file ingestion rows.
    await waitFor(() => fixtureRow() && !rows().some((row) => row.textContent.includes('文件摄取')), 'research filter');
    if (panel.querySelector('[data-e2e="filter-research"]').getAttribute('aria-pressed') !== 'true') throw new Error('active filter is not pressed');
    const all = [...panel.querySelectorAll('.goal-activity-filters button')].find((button) => button.textContent === '全部');
    tag(all, 'filter-all');
    all.focus();
    return true;
  `);
	run(["press", "Enter"]);
	inPanel(String.raw`
    await waitFor(() => rows().length > 1, 'all filter');
    if (panel.querySelector('[data-e2e="filter-all"]').getAttribute('aria-pressed') !== 'true') throw new Error('keyboard did not select the filter');
    return true;
  `);
}

function assertNoConsoleErrors(label) {
	// agent-browser prints a bare "✗" when there are no page errors.
	const errors = run(["errors"]).replace(/^✗\s*/u, "");
	const consoleErrors = run(["console"]).split("\n").filter((line) => line.startsWith("[error]"));
	if (errors || consoleErrors.length) {
		throw new Error(`${label} logged errors:\n${errors}\n${consoleErrors.join("\n")}`);
	}
}

function screenshot(label) {
	const file = `/tmp/telomi-goal-activity-panel-${label}-${process.pid}.png`;
	run(["screenshot", file]);
	screenshots.push(file);
}

function runPanelFlow(label) {
	const list = assertList();
	screenshot(`${label}-list`);
	openRowByKeyboard();
	const scrollTop = openFixtureDetail();
	screenshot(`${label}-detail`);
	assertReplayFlow();
	backToList(scrollTop);
	assertFilters();
	assertNoConsoleErrors(label);
	return list;
}

try {
	writeFileSync(initScriptPath, fixtureInitScript);
	run(["--init-script", initScriptPath, "open", `${appUrl}/goal/${encodeURIComponent(goalId)}`]);
	run(["set", "viewport", "1440", "900"]);
	run(["reload"]);
	run(["errors", "--clear"]);
	run(["console", "--clear"]);
	run(["wait", '[data-testid="goal-activity-panel"] [data-testid="activity-row"]']);
	// The top bar jumps to the panel when this Goal is the only one with Activity.
	const jump = inPanel(String.raw`
    const host = scrollHost();
    host.scrollTop = host.scrollHeight;
    await wait(100);
    return { before: panel.getBoundingClientRect().top };
  `);
	run(["click", '[data-testid="pulse-band-activity"]']);
	const landed = inPanel(String.raw`
    const topBar = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
    return await waitFor(() => {
      const top = panel.getBoundingClientRect().top;
      return top >= 0 && top <= topBar + 40 ? { top } : null;
    }, 'top bar jump to Activity');
  `);
	const workspace = runPanelFlow("workspace");

	run(["open", `${appUrl}/chat/${encodeURIComponent(goalId)}`]);
	run(["errors", "--clear"]);
	run(["console", "--clear"]);
	run(["wait", '[data-testid="chat-dock-overview-tab"]']);
	run(["click", '[data-testid="chat-dock-overview-tab"]']);
	run(["wait", '.chat-goal-side-stack [data-testid="goal-activity-panel"] [data-testid="activity-row"]']);
	const dock = runPanelFlow("dock");
	// Push navigation stays inside the panel, so the Dock keeps its overview tab throughout.
	if (run(["get", "attr", '[data-testid="chat-dock-overview-tab"]', "aria-pressed"]) !== "true") {
		throw new Error("Activity navigation changed the Chat Dock view");
	}

	console.log(JSON.stringify({ goalId, topBarJump: { from: jump.before, to: landed.top }, workspace, dock }));
	console.log(screenshots.join("\n"));
} finally {
	spawnSync(agentBrowser, ["--session", session, "close"], { cwd: appDir, encoding: "utf8" });
	rmSync(initScriptPath, { force: true });
}
