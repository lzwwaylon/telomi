import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkClickContext, MarkdownView } from "../../web/src/shared/markdown/MarkdownView.js";

function render(text: string, mode: "document" | "chat" = "document") {
	return renderToStaticMarkup(
		<LinkClickContext.Provider value={{
			onFileClick: () => undefined,
			resolveFileUrl: (path: string) => `/workspace-image?path=${encodeURIComponent(path)}`,
		}}>
			<MarkdownView text={text} mode={mode} />
		</LinkClickContext.Provider>,
	);
}

const inline = render("查看 `/work/notes.md`。");
assert.match(inline, /<a[^>]+href="\/work\/notes\.md"[^>]*><code/u);
const labeled = render("[`notes.md`](/work/notes.md)");
assert.equal((labeled.match(/<a\s/gu) ?? []).length, 1, "code labels do not produce nested links");
for (const mode of ["document", "chat"] as const) {
	const chineseUrl = render("仓库 https://github.com/FunAudioLLM/CosyVoice.git，且将版本单列。", mode);
	assert.match(chineseUrl, /href="https:\/\/github.com\/FunAudioLLM\/CosyVoice.git"/u);
	assert.match(chineseUrl, /<\/a>，且将版本单列。/u);
	assert.match(render('<a href="https://example.com/研究，资料">原文</a>', mode),
		/href="https:\/\/example.com\/%E7%A0%94%E7%A9%B6%EF%BC%8C%E8%B5%84%E6%96%99"|href="https:\/\/example.com\/研究，资料"/u);
	for (const path of ["src/model/loss.py", "./src/model/loss.py", "loss.py", "/work/../../src/model/loss.py"]) {
		assert.doesNotMatch(render(`Implementation: \`${path}\`.`, mode), /<a\s/u,
			"a repository code path is not a Goal file reference, even with the Chat file handler inherited");
		assert.doesNotMatch(render(`Implementation: ${path} .`, mode), /<a\s/u);
	}
	for (const path of ["/work/notes.md", "/attachments/book.pdf", "/reports/run-1/report.md"]) {
		assert.match(render(`See \`${path}\`.`, mode), /<a[^>]+href=/u);
		assert.match(render(`[Saved file](${path})`, mode), /<a[^>]+href=/u);
	}
	assert.match(render("[Sibling](./notes.md)", mode), /href="\.\/notes.md"/u,
		"explicit relative Workspace-reader links retain their original resolver");
}
assert.doesNotMatch(render("See /work/notes.md ."), /<a\s/u, "document mode does not auto-link bare Goal files");
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
