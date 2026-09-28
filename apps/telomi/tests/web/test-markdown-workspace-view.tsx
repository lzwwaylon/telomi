import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkClickContext, MarkdownView } from "../../web/src/shared/markdown/MarkdownView.js";

function render(text: string) {
	return renderToStaticMarkup(
		<LinkClickContext.Provider value={{
			onFileClick: () => undefined,
			resolveFileUrl: (path: string) => `/workspace-image?path=${encodeURIComponent(path)}`,
		}}>
			<MarkdownView text={text} />
		</LinkClickContext.Provider>,
	);
}

const inline = render("查看 `/work/notes.md`。");
assert.match(inline, /<a[^>]+href="\/work\/notes\.md"[^>]*><code/u);
const labeled = render("[`notes.md`](/work/notes.md)");
assert.equal((labeled.match(/<a\s/gu) ?? []).length, 1, "code labels do not produce nested links");
assert.match(render("![chart](./chart.png)"), /src="\/workspace-image\?path=\.%2Fchart\.png"/u);
assert.match(render("![web](https://example.com/chart.png)"), /src="https:\/\/example\.com\/chart\.png"/u);
assert.doesNotMatch(render("[章节](#intro)"), /target="_blank"/u);
console.log("Workspace Markdown links, images, and local anchors passed");

const footnoteText = `Claim[^1], repeated[^1].

[^1]: Evidence [source](https://example.com/#source).

<a id="constructor" onclick="alert(1)">Safe anchor</a>
[Local](#constructor)
<a href="javascript:alert(1)">Unsafe link</a>
<script>alert(1)</script>
<img src="x" onerror="alert(1)">
`;
const footnotes = renderToStaticMarkup(<><MarkdownView text={footnoteText} /><MarkdownView text={footnoteText} /></>);
const ids = [...footnotes.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "independent documents have distinct footnote IDs");
assert.ok(ids.every((id) => id.startsWith("user-content-")), "IDs retain sanitizer clobber protection");
const panes = footnotes.split('data-markdown-view=""').slice(1);
assert.equal(panes.length, 2);
for (const pane of panes) {
	const localIds = new Set([...pane.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]));
	const fragments = [...pane.matchAll(/href="#([^"]+)"/gu)].map((match) => match[1]);
	assert.equal(fragments.length, 5, "two footnote references, two backlinks and one HTML anchor");
	for (const fragment of fragments) assert.ok(localIds.has(fragment), `local target exists: ${fragment}`);
	for (const [, references] of pane.matchAll(/aria-describedby="([^"]+)"/gu)) {
		for (const id of references.split(/\s+/u)) assert.ok(localIds.has(id), `accessible label exists: ${id}`);
	}
	assert.match(pane, /aria-describedby="[^"]+"/u);
	assert.match(pane, /href="https:\/\/example.com\/#source"/u, "external fragments stay untouched");
}
assert.doesNotMatch(footnotes, /<script|onclick=|onerror=|javascript:| node=/iu);
console.log("Sanitized footnote references, backlinks, labels and document isolation passed");
