import assert from "node:assert/strict";

import { attachmentKind } from "../../server/ingestion/attachment-kind.js";

const cases: Array<[string, string | undefined, "parse" | "text" | "binary"]> = [
	["paper.pdf", "application/pdf", "parse"],
	["slides.PPTX", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "parse"],
	["page.html", "text/html", "parse"],
	["talk.mp3", "audio/mpeg", "parse"],
	["notes.md", "text/markdown", "text"],
	["runtime.py", "", "text"],
	["config.yaml", undefined, "text"],
	["data.json", "application/json", "text"],
	["README", "text/plain", "text"],
	["manifest.custom", "application/ld+json", "text"],
	["firmware.bin", "application/octet-stream", "binary"],
	["archive.zip", "application/zip", "binary"],
	["unknown", "", "binary"],
	["photo.HEIC", "image/heic", "binary"],
];
for (const [fileName, mimeType, expected] of cases) {
	assert.equal(attachmentKind(fileName, mimeType), expected, `${fileName} (${mimeType ?? "no mime"})`);
}

console.log("attachment kind classification passed");
