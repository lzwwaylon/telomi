import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The preview surfaces assert their own Chinese copy, so the locale is pinned
// here instead of inherited from whatever locale the machine reports.
import "./setup-ui-locale.js";
import i18n from "../../web/src/app/i18n.js";
import {
	artifactKindLabel,
	getFileType,
	isBinaryArtifact,
	languageForArtifact,
} from "../../web/src/shared/artifact-preview/artifact-type.js";
import {
	currentArtifactContent,
	loadArtifactContent,
	readArtifactText,
	type ArtifactContentState,
} from "../../web/src/shared/artifact-preview/artifact-content.js";

// The JSON viewer publishes ESM .js files without declaring type: module.
// Load its browser entry as ESM, as Vite does, instead of tsx's CJS fallback.
const jsonModuleHook = registerHooks({
	load(url, context, nextLoad) {
		return nextLoad(url, url.includes("/@uiw/react-json-view/esm/") ? { ...context, format: "module" } : context);
	},
});
const { ArtifactPreview } = await import("../../web/src/shared/artifact-preview/ArtifactPreview.js");
jsonModuleHook.deregister();

const markdown = (content: string) => <div data-testid="markdown-surface">{content}</div>;

function preview(props: Partial<React.ComponentProps<typeof ArtifactPreview>> & { filename: string }): string {
	return renderToStaticMarkup(
		<ArtifactPreview url={null} content={null} error={null} renderMarkdown={markdown} renderAudio={(url, filename) => <button data-testid="audio-delegate" data-url={url}>{filename}</button>} {...props} />,
	);
}

test("artifact classification recognizes the formats every preview surface receives", () => {
	assert.equal(getFileType("report.md"), "markdown");
	assert.equal(getFileType("rows.csv"), "csv");
	assert.equal(getFileType("rows.tsv"), "tsv");
	assert.equal(getFileType("sales.datatable.json"), "datatable");
	assert.equal(getFileType("sales.spreadsheet.json"), "spreadsheet");
	assert.equal(getFileType("config.json"), "json");
	assert.equal(getFileType("chart.svg"), "svg");
	assert.equal(getFileType("page.html"), "html");
	assert.equal(getFileType("notes.mystery"), "text");
	assert.equal(getFileType("clip.m4a"), "audio");
	assert.equal(getFileType("photo.PNG"), "image");
	assert.equal(languageForArtifact("worker.ts"), "typescript");
	assert.equal(languageForArtifact("notes.mystery"), "text");
	for (const binary of ["photo.png", "paper.pdf", "book.xlsx", "clip.mp3"]) {
		assert.equal(isBinaryArtifact(binary), true, binary);
	}
	for (const text of ["rows.csv", "report.md", "notes.mystery"]) {
		assert.equal(isBinaryArtifact(text), false, text);
	}
});

test("one artifact carries one type label on every surface", async () => {
	// The home feed, the Goal column and the chat report card all read this label,
	// so a Markdown report reads as a document everywhere and an attached podcast
	// changes nothing about the report's own type.
	assert.equal(artifactKindLabel("report.md"), "文档");
	assert.equal(artifactKindLabel("report.markdown"), "文档");
	assert.equal(artifactKindLabel("deep/dive/report.MD"), "文档");
	assert.equal(artifactKindLabel("paper.pdf"), "PDF");
	assert.equal(artifactKindLabel("cover.png"), "图片");
	assert.equal(artifactKindLabel("chart.svg"), "图片");
	assert.equal(artifactKindLabel("page.html"), "可视化报告");
	assert.equal(artifactKindLabel("page.htm"), "可视化报告");
	assert.equal(artifactKindLabel("notes.mystery"), "产物");
	await i18n.changeLanguage("en");
	assert.deepEqual(
		["report.md", "page.htm", "cover.png", "notes.mystery"].map((name) => artifactKindLabel(name)),
		["Document", "Visual report", "Image", "Artifact"],
		"the English UI never falls back to Chinese chrome",
	);
	await i18n.changeLanguage("zh-CN");
});

test("structured data renders through the shared renderers on every surface", () => {
	const csv = preview({ filename: "rows.csv", content: "name,value\nAlpha,1" });
	assert.match(csv, /<table/);
	assert.match(csv, /Alpha/);
	const tsv = preview({ filename: "rows.tsv", content: "name\tvalue\nBeta\t2" });
	assert.match(tsv, /<table/);
	assert.match(tsv, /Beta/);
	const datatable = preview({
		filename: "sales.datatable.json",
		content: JSON.stringify({ columns: [{ key: "name", label: "Name" }], rows: [{ name: "Gamma" }] }),
	});
	assert.match(datatable, /<table/);
	assert.match(datatable, /Gamma/);
	const spreadsheet = preview({
		filename: "sales.spreadsheet.json",
		content: JSON.stringify({ columns: [{ key: "name", label: "Name" }], rows: [{ name: "Delta" }] }),
	});
	assert.match(spreadsheet, /<table/);
	assert.match(spreadsheet, /Delta/);
});

test("JSON files show nested content and long strings without manual expansion", () => {
	const intent = "A complete topic description that stays readable beyond thirty characters.";
	const html = preview({
		filename: "topic-plan.json",
		content: JSON.stringify({ topics: [{ title: "Speech synthesis", intent, include: ["Prosody"] }] }),
	});
	for (const text of ["Speech synthesis", intent, "Prosody"]) assert.ok(html.includes(text), `Hidden JSON content: ${text}`);
});

test("text, code and markdown keep their own surfaces", () => {
	assert.match(preview({ filename: "notes.mystery", content: "plain body" }), /<pre[^>]*>plain body<\/pre>/);
	assert.match(preview({ filename: "chart.svg", content: "<svg><title>Ring</title></svg>" }), /<svg><title>Ring<\/title><\/svg>/);
	assert.match(preview({ filename: "page.html", content: "<p>hi</p>" }), /height:480px/);
	assert.match(preview({ filename: "page.html", content: "<p>hi</p>", htmlHeight: 720 }), /height:720px/);
	assert.match(preview({ filename: "report.md", content: "# Heading" }), /data-testid="markdown-surface"># Heading</);
});

test("binary artifacts preview from the blob URL and fall back when it is missing", () => {
	const image = preview({ filename: "photo.png", url: "/api/blob?name=photo.png" });
	assert.match(image, /<img[^>]+src="\/api\/blob\?name=photo\.png"/);
	const audio = preview({ filename: "clip.mp3", url: "/api/blob?name=clip.mp3" });
	assert.match(audio, /data-testid="audio-delegate" data-url="\/api\/blob\?name=clip\.mp3"/);
	assert.doesNotMatch(audio, /<audio/);
	const unavailable = preview({ filename: "book.xlsx", url: null });
	assert.match(unavailable, /无法预览/);
	assert.doesNotMatch(unavailable, /<a /);
});

test("missing content reports loading while a URL is pending and failure when it is not", () => {
	assert.match(preview({ filename: "rows.csv", url: "/api/blob?name=rows.csv" }), /加载/);
	assert.match(preview({ filename: "rows.csv", url: null, error: "HTTP 404" }), /HTTP 404/);
});

test("artifact reads surface HTTP failures as errors", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 404 }));
	await assert.rejects(readArtifactText("/api/blob?name=gone.csv"), /HTTP 404/);
	t.mock.restoreAll();
	t.mock.method(globalThis, "fetch", async () => new Response("a,b"));
	assert.equal(await readArtifactText("/api/blob?name=rows.csv"), "a,b");
});

test("switching artifacts drops results from the superseded request", async () => {
	const applied: ArtifactContentState[] = [];
	let resolveStale: ((text: string) => void) | undefined;
	const cancel = loadArtifactContent(
		{ filename: "stale.csv", url: "/api/blob?name=stale.csv" },
		(state) => applied.push(state),
		() => new Promise<string>((resolve) => { resolveStale = resolve; }),
	);
	assert.deepEqual(applied, [{ content: null, error: null }]);
	cancel();
	resolveStale?.("stale body");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(applied, [{ content: null, error: null }]);

	const fresh: ArtifactContentState[] = [];
	loadArtifactContent(
		{ filename: "fresh.csv", url: "/api/blob?name=fresh.csv" },
		(state) => fresh.push(state),
		async () => "fresh body",
	);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(fresh, [
		{ content: null, error: null },
		{ content: "fresh body", error: null },
	]);
});

test("already known content is applied without reading the blob", () => {
	const applied: ArtifactContentState[] = [];
	loadArtifactContent(
		{ filename: "rows.csv", url: "/api/blob?name=rows.csv", content: "name,value" },
		(state) => applied.push(state),
		() => assert.fail("cached artifacts must not be re-read"),
	);
	assert.deepEqual(applied, [{ content: "name,value", error: null }]);
});

test("read failures reach the surface as an error state", async () => {
	const applied: ArtifactContentState[] = [];
	loadArtifactContent(
		{ filename: "rows.csv", url: "/api/blob?name=rows.csv" },
		(state) => applied.push(state),
		async () => { throw new Error("HTTP 500"); },
	);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(applied.at(-1), { content: null, error: "HTTP 500" });
});

test("a loaded body is never shown for another artifact", () => {
	const rows = { filename: "rows.csv", url: "/api/blob?name=rows.csv" };
	const loaded = { ...rows, content: "name,value", error: null, source: rows };
	assert.deepEqual(currentArtifactContent(rows, loaded), { content: "name,value", error: null });
	// Selecting another file reports nothing until its own read lands, both when
	// only the name differs and when only the surface's blob URL differs.
	const renamed = { filename: "other.csv", url: rows.url };
	assert.deepEqual(currentArtifactContent(renamed, loaded), { content: null, error: null });
	const relocated = { filename: rows.filename, url: "/api/blob?name=copy.csv" };
	assert.deepEqual(currentArtifactContent(relocated, loaded), { content: null, error: null });
	assert.deepEqual(currentArtifactContent(rows, null), { content: null, error: null });
	// A failure belongs to its source too, and known content needs no read at all.
	const failed = { content: null, error: "HTTP 404", source: rows };
	assert.deepEqual(currentArtifactContent(rows, failed), { content: null, error: "HTTP 404" });
	assert.deepEqual(currentArtifactContent(renamed, failed), { content: null, error: null });
	assert.deepEqual(
		currentArtifactContent({ ...renamed, content: "cached" }, loaded),
		{ content: "cached", error: null },
	);
});

test("both entry points wire their own blob endpoint into the shared preview", () => {
	const entries = {
		"../../web/src/features/chat/WorkspaceFileOverlay.tsx": "/workspace/blob?path=",
		"../../web/src/features/goals/ArtifactsOverlay.tsx": "/artifacts/blob?name=",
	};
	for (const [path, endpoint] of Object.entries(entries)) {
		const source = readFileSync(new URL(path, import.meta.url), "utf8");
		assert.match(source, /<ArtifactPreview/, path);
		assert.ok(source.includes(endpoint), `${path} must address artifacts through ${endpoint}`);
		assert.doesNotMatch(source, /artifact-renderers/, `${path} must not dispatch renderers itself`);
	}
});
