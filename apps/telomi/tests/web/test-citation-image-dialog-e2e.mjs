import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appUrl = process.env.TELOMI_WEB_URL ?? "http://localhost:5174";
const session = `citation-image-dialog-e2e-${process.pid}-${Date.now()}`;
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const agentBrowser = path.join(appDir, "node_modules", ".bin", "agent-browser");
const screenshotPath = `/tmp/telomi-wiki-citation-preview-${process.pid}.png`;

function run(args, input) {
	const result = spawnSync(agentBrowser, ["--session", session, ...args], {
		cwd: appDir,
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
  const { PiCiteChip } = await import('/src/shared/markdown/PiCiteChip.tsx?image-dialog-e2e=' + Date.now());
  const { Dialog, DialogContent, DialogTitle } = await import('/src/shared/ui/dialog.tsx');
  const originalFetch = window.fetch;
  const originalUrl = location.href;
  let underlyingEscapes = 0;
  const onWindowKey = (event) => {
    if (event.key === 'Escape') underlyingEscapes += 1;
  };
  window.addEventListener('keydown', onWindowKey);
  const page = {
    ref: 'P1',
    path: 'wiki/entities/evidence-image.md',
    title: 'Evidence image Wiki Page',
    type: 'entity',
    content: '## Complete Wiki content\n\nThe full Page remains visible above its Evidence.',
  };
  window.fetch = async (input) => {
    if (String(input).includes('/artifacts/citations/preview')) {
      if (!String(input).includes('number=1')) throw new Error('citation preview request omitted the Runtime citation number');
      return new Response(JSON.stringify({
        title: 'Evidence image',
        url: 'https://example.com/source',
        sourceId: 'source:group',
        clues: [{
          page,
          cue: 'Overview',
          note: 'The first clue establishes context. '.repeat(300),
          excerpts: [],
          assets: [],
        }, {
          page,
          cue: 'Architecture',
          note: 'The source contains an architecture figure.',
          excerpts: [],
          assets: [{ sourceId: 'source:image', path: 'assets/figure.png', alt: 'Architecture figure' }],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input);
  };
  const host = document.createElement('div');
  document.body.innerHTML = '';
  document.body.append(host);
  const root = createRoot(host);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (check, label) => {
    for (let i = 0; i < 40; i++) {
      if (check()) return;
      await wait(50);
    }
    throw new Error('timed out waiting for ' + label);
  };
  const reopen = async (trigger) => {
    trigger.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    await wait(100);
    trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  };
  try {
    // Reports open in a modal Dialog; the citation card portals outside its scroll lock.
    root.render(React.createElement(Dialog, { open: true },
      React.createElement(DialogContent, { showCloseButton: false, 'aria-describedby': undefined },
        React.createElement(DialogTitle, null, 'Report'),
        React.createElement(PiCiteChip, {
          goalId: 'goal-image-dialog-e2e',
          artifactName: 'wiki/runs/test/report/final.md',
          dataList: [{ kind: 'url', target: 'https://example.com/source', index: 1 }],
          indices: [1],
        }))));
    await waitFor(() => document.querySelector('[data-slot="dialog-content"] button'), 'citation trigger');
    const trigger = document.querySelector('[data-slot="dialog-content"] button');
    await reopen(trigger);
    await waitFor(() => document.querySelector('button[aria-label="下一条线索"]'), 'clue pager');
    await waitFor(() => document.querySelector('[data-testid="wiki-citation-page"]'), 'Wiki Page preview');
    const wikiPageText = document.querySelector('[data-testid="wiki-citation-page"]')?.textContent || '';
    if (!wikiPageText.includes('Evidence image Wiki Page') || !wikiPageText.includes('The full Page remains visible')) {
      throw new Error('Wiki Page title or content did not render completely');
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitFor(() => !document.querySelector('.inline-citation-popover'), 'Escape to close citation popover');
    await wait(400);
    if (document.querySelector('.inline-citation-popover')) throw new Error('citation popover reopened after Escape');
    if (underlyingEscapes !== 0) throw new Error('citation popover Escape leaked through to the underlying report dialog');
    await reopen(trigger);
    await waitFor(() => document.querySelector('button[aria-label="下一条线索"]'), 'reopened clue pager');
    const clueScroller = document.querySelector('[data-testid="citation-clue-scroll"]');
    if (!clueScroller) throw new Error('clue scroll container not found');
    clueScroller.scrollTop = 200;
    const wheel = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    clueScroller.dispatchEvent(wheel);
    if (wheel.defaultPrevented) throw new Error('report Dialog scroll lock swallowed wheel scrolling inside the citation preview');
    trigger.focus();
    const nextClue = document.querySelector('button[aria-label="下一条线索"]');
    trigger.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: nextClue }));
    nextClue.focus();
    nextClue.click();
    await wait(250);
    if (document.querySelector('.inline-citation-popover')?.getAttribute('data-state') !== 'open') {
      throw new Error('citation popover disappeared after clue paging moved focus inside it');
    }
    const pagedScroller = document.querySelector('[data-testid="citation-clue-scroll"]');
    if (pagedScroller?.scrollTop !== 0) throw new Error('new clue page preserved the previous clue scroll position');
    await waitFor(() => document.querySelector('[data-testid="citation-image-open"], a[title="打开原图"]'), 'image open control');
    if (document.querySelector('a[title="打开原图"]')) {
      throw new Error('image still opens the raw asset in a new tab');
    }
    document.querySelector('[data-testid="citation-image-open"]').click();
    await waitFor(() => document.querySelector('[data-testid="citation-image-dialog"]'), 'embedded image dialog');
    await wait(250);
    if (!document.querySelector('[data-testid="citation-image-dialog"]')) {
      throw new Error('image dialog disappeared when the citation popover closed');
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitFor(() => !document.querySelector('[data-testid="citation-image-dialog"]'), 'Escape to close image dialog');
    if (underlyingEscapes !== 0) throw new Error('Escape leaked through to the underlying report dialog');
    if (location.href !== originalUrl) throw new Error('image preview navigated away from the report');
    return JSON.stringify({
      cluePagingStable: true,
      wheelScrollsInsideDialog: true,
      wikiPageRendered: true,
      clueScrollReset: true,
      popoverEscapeContained: true,
      openedInApp: true,
      closedInApp: true,
      escapeStayedInImage: true,
      stayedOnReport: true,
    });
  } finally {
    window.removeEventListener('keydown', onWindowKey);
    window.fetch = originalFetch;
  }
})()
`;

const openPreviewForScreenshot = String.raw`
(async () => {
  const trigger = document.querySelector('button');
  if (!trigger) throw new Error('citation trigger is missing before screenshot');
  trigger.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  for (let i = 0; i < 40 && !document.querySelector('[data-testid="wiki-citation-page"]'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!document.querySelector('[data-testid="wiki-citation-page"]')) throw new Error('Wiki Page preview did not reopen for screenshot');
  return true;
})()
`;

try {
	run(["open", appUrl]);
	console.log(run(["eval", "--stdin"], browserCheck));
	run(["eval", "--stdin"], openPreviewForScreenshot);
	run(["screenshot", screenshotPath]);
	console.log(screenshotPath);
} finally {
	spawnSync(agentBrowser, ["--session", session, "close"], { cwd: appDir, encoding: "utf8" });
}
