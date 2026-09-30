import assert from "node:assert/strict";
import { isExplicitWorkspaceFileTarget, isFilePathTarget, preprocessLinks } from "../../web/src/shared/markdown/markdown-linkify.js";
import { resolveMarkdownLinkTarget, resolveWorkspaceFileTarget } from "../../web/src/shared/markdown/markdown-link-target.js";

for (const target of ["/work/foo.md", "foo.md", "./notes.md", "../note.md", "/reports/run-1/final.md", "目录/研究 笔记.md#结论", "./%E7%AC%94%E8%AE%B0%20one.md#L12", "./main.ts:12:3"]) {
	assert.equal(isFilePathTarget(target), true, target);
	assert.deepEqual(resolveMarkdownLinkTarget(target), { kind: "file", path: target });
}
for (const target of ["https://example.com/report.md", "//example.com/report.md", "/api/goals/demo/report.md", "api/report.md", "#heading", "javascript:report.md", "mailto:report.md", "report.md?download=1"]) {
	assert.equal(isFilePathTarget(target), false, target);
	assert.deepEqual(resolveMarkdownLinkTarget(target), { kind: "url", url: target });
}
assert.deepEqual(resolveMarkdownLinkTarget("file:///tmp/my%20notes.md"), { kind: "file", path: "/tmp/my notes.md" });

for (const [target, currentFile, expected] of [
	["foo.md", undefined, "/work/foo.md"],
	["./notes.md", "/work/readme.md", "/work/notes.md"],
	["../note.md", "/work/guides/readme.md", "/work/note.md"],
	["/reports/run-1/final.md", "/work/readme.md", "/reports/run-1/final.md"],
	["./研究%20笔记.md#结论", "/work/guides/readme.md", "/work/guides/研究 笔记.md"],
	["./file%23name.md#L12", undefined, "/work/file#name.md"],
	["./100%25.md", undefined, "/work/100%.md"],
	["./literal%2520.md", undefined, "/work/literal%20.md"],
	["./100%.md", undefined, "/work/100%.md"],
	["./main.ts:12:3", undefined, "/work/main.ts"],
	["./main.ts#L12-L15", undefined, "/work/main.ts"],
	["file:///work/my%20notes.md", undefined, "/work/my notes.md"],
	["artifacts/main/notes.md", undefined, "/work/artifacts/main/notes.md"],
	["wiki/runs/run-1/report/final.md", undefined, "/work/wiki/runs/run-1/report/final.md"],
	["#heading", "/work/readme.md", null],
	["https://example.com/notes.md", undefined, null],
	["/api/goals/demo/report.md", undefined, null],
] as const) assert.equal(resolveWorkspaceFileTarget(target, currentFile)?.path ?? null, expected, target);

assert.equal(resolveWorkspaceFileTarget("artifacts/audio.mp3")?.path, "/work/artifacts/audio.mp3");
assert.equal(resolveWorkspaceFileTarget("attachments/book.pdf")?.path, "/work/attachments/book.pdf");
assert.equal(resolveWorkspaceFileTarget("artifacts/main/notes.md", "/work/index.md")?.path, "/work/artifacts/main/notes.md");

assert.deepEqual(resolveWorkspaceFileTarget("../notes.md#%E7%BB%93%E8%AE%BA", "/work/guides/index.md"), { path: "/work/notes.md", anchor: "结论" });
assert.deepEqual(resolveWorkspaceFileTarget("notes.md#L12-L15"), { path: "/work/notes.md", line: 12 });
assert.deepEqual(resolveWorkspaceFileTarget("main.ts:12:3"), { path: "/work/main.ts", line: 12 });
assert.equal(resolveWorkspaceFileTarget("/artifacts/main/notes.md")?.path, "/artifacts/main/notes.md");

assert.deepEqual(resolveWorkspaceFileTarget("file:///work/main.ts:12"), { path: "/work/main.ts", line: 12 });

for (const target of ["/work/notes.md", "/reports/run-1/report.md", "/attachments/book.pdf", "/documents/one/document.md",
	"/artifacts/summary.json", "/work/guides/../notes.md#L12", "/work/%E7%AC%94%E8%AE%B0.md:12"]) {
	assert.equal(isExplicitWorkspaceFileTarget(target), true, target);
}
for (const target of ["src/model/loss.py", "./src/model/loss.py", "note.md", "../notes.md", "attachments/book.pdf",
	"/Users/example/src/model/loss.py", "/work/../../src/model/loss.py", "/work/../../work/../../secret.md",
	"/api/goals/demo/report.md", "https://example.com/report.md", "value = loss.py"]) {
	assert.equal(isExplicitWorkspaceFileTarget(target), false, target);
}

// `py`, `rs`, `sh` and `md` are country-code TLDs, so a bare filename reads as a domain to
// linkify-it's fuzzy matcher. A reply naming one must not become a link to a foreign host.
for (const [text, expected] of [
	["见 note.md 了解详情", "见 note.md 了解详情"],
	["运行 build.sh 即可", "运行 build.sh 即可"],
	["改 main.rs 这一行", "改 main.rs 这一行"],
	["跑 train.py 试试", "跑 train.py 试试"],
	["实现见 src/model/loss.py。", "实现见 src/model/loss.py。"],
	["记录见 /work/notes.md 。", "记录见 [/work/notes.md](/work/notes.md) 。"],
	["附件见 /attachments/book.pdf 。", "附件见 [/attachments/book.pdf](/attachments/book.pdf) 。"],
	["[报告](/reports/run-1/report.md) 和 [附件](/attachments/book.pdf)", "[报告](/reports/run-1/report.md) 和 [附件](/attachments/book.pdf)"],
	// A host keeps its link: an explicit scheme, or a path after the dotted name.
	["访问 example.com/page", "访问 [example.com/page](http://example.com/page)"],
	["见 example.com/a/report.md", "见 [example.com/a/report.md](http://example.com/a/report.md)"],
	["报告见 https://example.com/report.md", "报告见 [https://example.com/report.md](https://example.com/report.md)"],
	["写信到 a@b.com", "写信到 [a@b.com](mailto:a@b.com)"],
	["仓库 https://github.com/FunAudioLLM/CosyVoice.git，且将版本单列。", "仓库 [https://github.com/FunAudioLLM/CosyVoice.git](https://github.com/FunAudioLLM/CosyVoice.git)，且将版本单列。"],
	["见 https://example.com/研究；然后继续", "见 [https://example.com/研究](https://example.com/研究)；然后继续"],
	["**https://example.com/page**，说明", "**[https://example.com/page](https://example.com/page)**，说明"],
	["[原文](https://example.com/研究，资料)", "[原文](https://example.com/研究，资料)"],
] as const) assert.equal(preprocessLinks(text), expected, text);

console.log("Markdown file links preserve Workspace paths, anchors and line numbers");
