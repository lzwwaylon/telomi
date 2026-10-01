import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView } from "../../web/src/shared/markdown/MarkdownView.js";

const text = String.raw`有效长度为 \(l_b=\mathrm{audio\_mask}[b,:].\mathrm{sum()}\)。

\[
x\in\mathbb{R}^{B\times N\times m}
\]

公共长度 \(N=\max_b l_b\)，金额 $100 保持原样。`;
for (const mode of ["chat", "document"] as const) {
	const rendered = renderToStaticMarkup(<MarkdownView text={text} mode={mode} />);
	assert.equal((rendered.match(/class="katex"/gu) ?? []).length, 3,
		"inline and display TeX delimiters render in the shared chat and report renderer");
	assert.match(rendered, /class="katex-display"/u);
	assert.doesNotMatch(rendered, /katex-error/u);
	assert.match(rendered, /金额 \$100 保持原样/u, "currency is not inline math");
	for (const [source, container] of [
		[String.raw`> \[x+y\]`, "blockquote"],
		[String.raw`- Formula: \[x+y\] remains in this item.`, "li"],
		["> \\[\n> x+y\n> \\]", "blockquote"],
		["- \\[\n  x+y\n  \\]", "li"],
	] as const) {
		const nested = renderToStaticMarkup(<MarkdownView text={source} mode={mode} />);
		const contents = nested.match(new RegExp(`<${container}(?: [^>]*)?>([\\s\\S]*?)</${container}>`, "u"))?.[1];
		assert.match(contents ?? "", /class="katex"/u, "display math remains inside its Markdown container");
		assert.doesNotMatch(nested, /katex-error/u);
		if (container === "li" && source.includes("remains")) assert.match(contents ?? "", /remains in this item/u);
	}
	for (const code of [
		"`\\(x\\)`", "``literal ` \\(x\\)``", "```text\n\\[x\\]\n```",
		"~~~text\n\\(x\\)\n~~~",
	]) {
		const literal = renderToStaticMarkup(<MarkdownView text={code} mode={mode} />);
		assert.doesNotMatch(literal, /class="katex"/u, "code containing TeX delimiters stays literal");
		assert.match(literal, /\\[([]x\\[)\]]/u);
	}
}
console.log("Shared Markdown renders TeX delimiters without changing code or currency");
