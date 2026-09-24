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
