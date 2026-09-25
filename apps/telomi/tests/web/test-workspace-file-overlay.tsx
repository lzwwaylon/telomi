import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mergeArtifacts } from "../../web/src/features/chat/ChatRightDock.js";
import { WorkspaceFileBody, workspaceArtifactName, workspaceFileNaming } from "../../web/src/features/chat/WorkspaceFileOverlay.js";

// Only the server knows which run a report directory names, so citations resolve `/reports` there.
assert.equal(workspaceArtifactName("/reports/2026-09-25 语音报告/report.md"), "/reports/2026-09-25 语音报告/report.md");
assert.equal(workspaceArtifactName("/work/notes/topic.md"), "main/notes/topic.md");
assert.equal(workspaceArtifactName("/artifacts/summary.md"), "summary.md");
assert.equal(workspaceArtifactName("wiki/runs/run_1/report/final.md"), "wiki/runs/run_1/report/final.md");

const files = mergeArtifacts(new Map([["not-listed.md", {
	filename: "not-listed.md", content: "old cached content", encoding: "utf-8", createdAt: 0, updatedAt: 0,
}]]), [{
	path: "/workspace/notes.md", size: 10, modifiedAt: "2026-09-15T00:00:00Z", mtimeMs: 0,
}]);
assert.deepEqual([...files.keys()], ["/workspace/notes.md"]);
const markdown = renderToStaticMarkup(<WorkspaceFileBody
	goalId="goal_test" path="/workspace/notes.md" url="/blob"
	content={"# Introduction\n\nStart here.\n\n## Details\n\nMore information."} error={null}
/>);
assert.ok(markdown.includes('data-testid="markdown-pane-toc"'), "Workspace Markdown uses the report table of contents");
assert.ok(markdown.includes("Start here."));
const image = renderToStaticMarkup(<WorkspaceFileBody
	goalId="goal_test" path="/workspace/chart.png" url="/blob" content={null} error={null}
/>);
assert.ok(image.includes('src="/blob"'), "Non-Markdown previews retain their binary renderer");

// The preview names the file the way the list does, and still saves the file that was fetched.
// The overlay header itself renders into a portal, so its naming is pinned here as a function.
const stored = workspaceFileNaming("/attachments/0ea556f4-c463-4036-811e-b2d70204ac8e__145.md", "/attachments/中文文件 145.md");
assert.deepEqual(stored, { title: "中文文件 145.md", saveAs: "中文文件 145.md" });
const parsed = workspaceFileNaming(`/documents/${"d".repeat(64)}/document.md`, "/documents/parse-test.pdf/document.md");
assert.ok(parsed.title.includes("parse-test.pdf"), "a parse output preview identifies the document it came from");
assert.equal(parsed.saveAs, "document.md", "the saved parse output keeps its Markdown name");
// Citations and Markdown links open by path alone and are named exactly as before.
assert.deepEqual(workspaceFileNaming("/reports/run_1/final.md"), { title: "final.md", saveAs: "final.md" });

console.log("Workspace file preview passed");
