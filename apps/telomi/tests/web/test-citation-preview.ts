import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCitationSourcePreview, resolveReportCoverAsset } from "../../server/citations/preview.js";
import { jpegSize } from "../../server/workspaces/source-view.js";

const root = mkdtempSync(join(tmpdir(), "citation-preview-"));
try {
	const reportRoot = join(root, "report");
	const sourceRoot = join(root, "artifacts", "find-out-sources", "sequence-1", "sources", "source-group");
	const memberRoot = join(sourceRoot, "members", "arxiv", "paper");
	const findOutRoot = join(root, "artifacts", "report-flow", "findout-snapshot");
	mkdirSync(join(memberRoot, "assets"), { recursive: true });
	mkdirSync(join(root, "artifacts", "cornell-notes", "sequence-1"), { recursive: true });
	mkdirSync(join(findOutRoot, "notes"), { recursive: true });
	mkdirSync(reportRoot, { recursive: true });
	writeFileSync(join(reportRoot, "final.md"), "# Report\n");
	writeFileSync(join(reportRoot, "final.json"), JSON.stringify({
		citations: [{ number: 1, title: "Paper", url: "https://example.com/paper", evidenceId: "source:group", ref: "N1" }],
	}));
	writeFileSync(join(root, "artifacts", "find-out-sources", "sequence-1", "manifest.json"), JSON.stringify({
		sources: [{
			source_id: "source:group",
			title: "Grouped source",
			path: "sources/source-group",
			members: [{
				source_id: "source:paper",
				title: "Paper",
				canonical_locator: "https://example.com/paper",
				path: "members/arxiv/paper",
				summary: "A compact source summary.",
			}],
		}],
	}));
	const longEvidence = "Evidence paragraph. ".repeat(100).trim();
	writeFileSync(join(memberRoot, "paper.md"), `${longEvidence}\n<!-- image -->\nUnrelated.\n<!-- image -->\n`);
	writeFileSync(join(memberRoot, "assets", "one.png"), pngHeader(400, 240));
	writeFileSync(join(memberRoot, "assets", "two.png"), pngHeader(400, 240));
	writeFileSync(join(memberRoot, "record.json"), JSON.stringify({
		metadata: { parser_manifest: { assets: [
			{ figure_index: 0, markdown_path: "assets/one.png", media_type: "image/png" },
			{ figure_index: 1, markdown_path: "assets/two.png", media_type: "image/png" },
		] } },
	}));
	const cornellNote = {
		schema_version: 1,
		source_id: "source:group",
		sections: [{
			section_title: "Evidence",
			summary: "Note summary.",
			cue_notes: [{
				cue: "Architecture",
				note: "The evidence has a figure.",
				evidence: [{ source_path: "members/arxiv/paper/paper.md", start_line: 1, end_line: 2 }],
			}, {
				cue: "Uncited limitation",
				note: "This Note was not cited by N1.",
				evidence: [{ source_path: "members/arxiv/paper/paper.md", start_line: 3, end_line: 4 }],
			}],
		}],
	};
	writeFileSync(join(root, "artifacts", "cornell-notes", "sequence-1", "source-group-123456789abc.json"), JSON.stringify(cornellNote));
	writeFileSync(join(findOutRoot, "notes", "0001.json"), JSON.stringify(cornellNote));
	writeFileSync(join(findOutRoot, "index.json"), JSON.stringify({
		schema_version: 1,
		notes: [{
			handle: "@1",
			source_id: "source:group",
			title: "Paper",
			metadata_path: "notes/0001.json",
			source_urls: ["https://example.com/paper"],
		}],
	}));

	const preview = resolveCitationSourcePreview(join(reportRoot, "final.md"), "https://example.com/paper#section");
	assert.equal(preview?.clues[0]?.cue, "Architecture");
	assert.equal(preview?.clues[0]?.note, "The evidence has a figure.");
	assert.equal(preview?.clues[0]?.excerpts[0]?.text, longEvidence);
	assert.deepEqual(preview?.clues[0]?.assets, [{ sourceId: "source:paper", path: "assets/one.png", alt: "Architecture", width: 400, height: 240 }]);
	assert.deepEqual(resolveReportCoverAsset(join(reportRoot, "final.md")), { sourceId: "source:paper", path: "assets/one.png" });
	writeFileSync(join(memberRoot, "assets", "one.png"), pngHeader(1200, 300));
	assert.equal(resolveReportCoverAsset(join(reportRoot, "final.md")), null, "a 4:1 banner must not become a square cover");
	writeFileSync(join(memberRoot, "assets", "one.png"), pngHeader(400, 240));
	writeFileSync(join(reportRoot, "final.json"), JSON.stringify({
		citations: [{ number: 1, title: "Paper", url: "https://example.com/paper", evidenceId: "source:group", refs: ["N1", "N2"] }],
	}));
	assert.deepEqual(resolveCitationSourcePreview(join(reportRoot, "final.md"), "https://example.com/paper", 1)?.clues.map((clue) => clue.cue),
		["Architecture", "Uncited limitation"], "one Source number previews every Note cited under it");
	writeFileSync(join(reportRoot, "final.json"), JSON.stringify({
		citations: [{ number: 1, title: "Paper", url: "https://example.com/paper", evidenceId: "source:group", refs: ["N1", "N9"] }],
	}));
	assert.equal(resolveCitationSourcePreview(join(reportRoot, "final.md"), "https://example.com/paper", 1), null,
		"an unknown cited Note ref must not fall back to unrelated Notes");
	// Sources whose figures never reached the Agent view (no parser manifest) resolve through the Run's Source Bundle.
	writeFileSync(join(reportRoot, "final.json"), JSON.stringify({
		citations: [
			{ number: 1, title: "Paper", url: "https://example.com/paper", evidenceId: "source:group", ref: "N1" },
			{ number: 2, title: "Bundle", url: "https://example.com/bundle", evidenceId: "source:bundle", ref: "N3" },
		],
	}));
	const bundleMember = join(root, "artifacts", "find-out-sources", "sequence-1", "sources", "source-bundle", "members", "arxiv", "b");
	mkdirSync(bundleMember, { recursive: true });
	writeFileSync(join(bundleMember, "paper.md"), "Intro.\n<!-- image -->\nBody.\n<!-- image -->\n");
	const bundleDir = join(root, "artifacts", "source-bundles", "job-1", "attempt-1");
	mkdirSync(join(bundleDir, "sources", "0001", "assets"), { recursive: true });
	writeFileSync(join(bundleDir, "source-index.json"), JSON.stringify({ sources: [{ source_id: "source:b", path: "sources/0001" }] }));
	writeFileSync(join(bundleDir, "sources", "0001", "paper.md"), "Intro.\n<!-- image -->\nBody.\n<!-- image -->\n");
	writeFileSync(join(bundleDir, "sources", "0001", "record.json"), JSON.stringify({ metadata: {} }));
	writeFileSync(join(bundleDir, "sources", "0001", "assets", "figure-p0001-0001.png"), pngHeader(300, 300));
	writeFileSync(join(bundleDir, "sources", "0001", "assets", "figure-p0002-0002.png"), pngHeader(300, 300));
	const manifest = JSON.parse(readFileSync(join(root, "artifacts", "find-out-sources", "sequence-1", "manifest.json"), "utf8"));
	manifest.sources.push({
		source_id: "source:bundle",
		title: "Bundle",
		path: "sources/source-bundle",
		members: [{ source_id: "source:b", title: "Bundle", canonical_locator: "https://example.com/bundle", path: "members/arxiv/b" }],
	});
	writeFileSync(join(root, "artifacts", "find-out-sources", "sequence-1", "manifest.json"), JSON.stringify(manifest));
	const bundleNote = {
		schema_version: 1,
		source_id: "source:bundle",
		sections: [{ section_title: "E", summary: "s", cue_notes: [{
			cue: "Figure two",
			note: "Only the second marker is in range.",
			evidence: [{ source_path: "members/arxiv/b/paper.md", start_line: 3, end_line: 4 }],
		}] }],
	};
	writeFileSync(join(findOutRoot, "notes", "0002.json"), JSON.stringify(bundleNote));
	writeFileSync(join(findOutRoot, "index.json"), JSON.stringify({
		schema_version: 1,
		notes: [
			{ handle: "@1", source_id: "source:group", title: "Paper", metadata_path: "notes/0001.json", source_urls: ["https://example.com/paper"] },
			{ handle: "@2", source_id: "source:bundle", title: "Bundle", metadata_path: "notes/0002.json", source_urls: ["https://example.com/bundle"] },
		],
	}));
	const bundlePreview = resolveCitationSourcePreview(join(reportRoot, "final.md"), "https://example.com/bundle");
	assert.deepEqual(bundlePreview?.clues[0]?.assets, [{ sourceId: "source:b", path: "assets/figure-p0002-0002.png", alt: "Figure two", width: 300, height: 300 }]);
	writeFileSync(join(memberRoot, "assets", "one.png"), pngHeader(1200, 300));
	assert.deepEqual(resolveReportCoverAsset(join(reportRoot, "final.md")), { sourceId: "source:b", path: "assets/figure-p0002-0002.png" }, "cover falls through to the next citation");
	writeFileSync(join(memberRoot, "assets", "one.png"), pngHeader(400, 240));
	assert.deepEqual(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0x2c, 0x02, 0x58, 3, 0, 0, 0])), { width: 600, height: 300 });
	assert.equal(jpegSize(pngHeader(1, 1)), null);
	assert.equal(preview?.clues.length, 1, "an N ref must preview only its exact Note");
	assert.equal(resolveCitationSourcePreview(join(reportRoot, "final.md"), "https://example.com/other"), null);
	writeFileSync(join(reportRoot, "final.json"), JSON.stringify({
		citations: [{
			number: 2,
			title: "Wiki paper",
			url: "https://example.com/wiki-paper",
			ref: "C7",
			wiki: {
				ref: "C7",
				page: { ref: "P3", path: "wiki/entities/paper.md", title: "Paper page", type: "entity", content: "## Findings\n\nComplete Wiki Page content." },
				entry: {
					id: "entry:paper", index: 1, section: "Evidence", cue: "Wiki architecture", note: "Wiki Note content.",
					source: { id: "source:paper", title: "Wiki paper", url: "https://example.com/wiki-paper" },
					anchors: [{
						path: "paper.md", startLine: 4, endLine: 6, format: "markdown", content: "Frozen source excerpt.",
						assets: [{ sourceId: "source:paper", path: "assets/wiki.png" }],
					}],
				},
				evidence: [{
					id: "entry:paper", index: 1, section: "Evidence", cue: "Wiki architecture", note: "Wiki Note content.",
					source: { id: "source:paper", title: "Wiki paper", url: "https://example.com/wiki-paper" },
					anchors: [{ path: "paper.md", startLine: 4, endLine: 6, format: "markdown", content: "Frozen source excerpt.", assets: [{ sourceId: "source:paper", path: "assets/wiki.png" }] }],
				}, {
					id: "entry:limits", index: 2, section: "Limits", cue: "Wiki limitation", note: "Second Note content.",
					source: { id: "source:limits", title: "Limits paper", url: "https://example.com/limits" },
					anchors: [{ path: "limits.md", startLine: 8, endLine: 9, format: "markdown", content: "Second source excerpt.", assets: [] }],
				}],
			},
		}],
	}));
	// Reports published before Source-level numbering hold one `ref` and one `wiki` object per number.
	const wikiPreview = resolveCitationSourcePreview(join(reportRoot, "final.md"), "https://example.com/wiki-paper", 2);
	assert.deepEqual(wikiPreview?.clues, [{
		page: { ref: "P3", path: "wiki/entities/paper.md", title: "Paper page", type: "entity", content: "## Findings\n\nComplete Wiki Page content." },
		cue: "Wiki architecture",
		note: "Wiki Note content.",
		excerpts: [{ path: "paper.md", startLine: 4, endLine: 6, text: "Frozen source excerpt." }],
		assets: [{ sourceId: "source:paper", path: "assets/wiki.png", alt: "Wiki architecture" }],
	}]);
	writeFileSync(join(reportRoot, "final.json"), JSON.stringify({
		citations: [{ number: 1, title: "Paper", url: "https://example.com/paper", provenance: "provider:test:source:group" }],
	}));
	assert.equal(resolveCitationSourcePreview(join(reportRoot, "final.md"), "https://example.com/paper"), null);
	console.log("Citation preview test passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

function pngHeader(width: number, height: number): Buffer {
	const value = Buffer.alloc(24);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value);
	value.writeUInt32BE(width, 16);
	value.writeUInt32BE(height, 20);
	return value;
}
