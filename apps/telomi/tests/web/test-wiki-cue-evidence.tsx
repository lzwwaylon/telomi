import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WikiEvidenceDossier } from "../../web/src/features/wiki/WikiEvidenceDossier.js";
import { normalizeWikiEvidence } from "../../web/src/features/wiki/wiki-model.js";
import { sourceAssetHttpUrl } from "../../web/src/shared/markdown/source-asset.js";

const raw = [{ id: "entry:comparison", index: 1, section: "Protocols", cue: "Compare requirements", note: "Consent is required by both protocols.",
	sectionSummary: "Consent is required by both protocols.",
	source: { id: "source:shared", title: "Protocol A", url: "https://example.test/a" },
	anchors: ["run-a", "run-b"].map((runId, index) => ({ path: "members/article/document.md", startLine: 1, endLine: 1,
		format: "text", content: index ? "B requires attribution." : "A requires consent.",
		source: { id: "source:shared", title: index ? "Original Protocol B" : "Original Protocol A",
			url: `https://example.test/${index ? "b" : "a"}`, runId, revisionSha256: String(index).repeat(64) },
		assets: [{ sourceId: `source:member-${runId}`, path: "assets/figure.png" }],
	})) }];
const evidence = normalizeWikiEvidence(raw);
assert.equal(evidence[0]?.anchors[1]?.source?.runId, "run-b");
assert.equal(evidence[0]?.anchors[1]?.source?.revisionSha256, "1".repeat(64));
assert.equal(normalizeWikiEvidence([{ ...raw[0], anchors: [{ ...raw[0]!.anchors[0], source: undefined }] }])[0]?.anchors[0]?.source, undefined,
	"older single-Source Wiki evidence remains readable without per-anchor metadata");
const html = renderToStaticMarkup(<WikiEvidenceDossier goalId="goal" evidence={evidence} revision="topics-v1" onOpenSource={() => undefined} />);
const sameRun = normalizeWikiEvidence([
	{ ...raw[0], id: "legacy", source: { ...raw[0]!.source, runId: "run-a" }, anchors: [{ ...raw[0]!.anchors[0], source: undefined }] },
	{ ...raw[0], id: "imported", anchors: [raw[0]!.anchors[0]] },
]);
const mixed = renderToStaticMarkup(<WikiEvidenceDossier goalId="goal" evidence={sameRun} onOpenSource={() => undefined} />);
assert.match(mixed, /2 条线索 · 1 个来源/u, "legacy and imported Cues from the same recorded Source Run count once");
assert.match(html, /Original Protocol A/u);
assert.match(html, /Original Protocol B/u);
assert.equal((html.match(/Consent is required by both protocols\./gu) ?? []).length, 1, "imported section summaries must not duplicate the full Cue note");
assert.match(html, /href="https:\/\/example.test\/b"/u);
assert.match(html, /source=source%3Amember-run-a[^"\s]+run=run-a/u);
assert.match(html, /source=source%3Amember-run-b[^"\s]+run=run-b/u);
assert.equal(sourceAssetHttpUrl("source-asset:source:member-run-b/assets/figure.png", "goal", "topics-v1", "run-b"),
	"/api/goals/goal/wiki/source-asset?source=source%3Amember-run-b&path=assets%2Ffigure.png&revision=topics-v1&run=run-b");
