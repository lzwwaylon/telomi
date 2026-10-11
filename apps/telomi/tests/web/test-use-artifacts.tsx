import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useArtifacts } from "../../web/src/features/goals/data/useArtifacts.js";

function call(args: JsonObject, timestamp: number): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id: `artifact-${timestamp}`, name: "artifacts", arguments: args }],
		api: "openai-completions", provider: "fixture", model: "fixture", timestamp, stopReason: "toolUse",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function replay(messages: AgentMessage[]) {
	const result: { value?: ReturnType<typeof useArtifacts> } = {};
	function Probe() { result.value = useArtifacts(messages); return null; }
	renderToStaticMarkup(<Probe />);
	assert.ok(result.value);
	return result.value;
}

test("native JSON Tool payloads preserve artifact creation and ordered edits", () => {
	const artifacts = replay([
		call({ command: "create", filename: "report.html", content: "first body" }, 1),
		call({ command: "update", filename: "report.html", old_str: "first", new_str: "second" }, 2),
		call({ command: "rewrite", filename: "report.html", content: "complete body" }, 3),
	]);
	assert.deepEqual([...artifacts.values()], [{ filename: "report.html", content: "complete body", encoding: "utf-8", createdAt: 1, updatedAt: 3 }]);
	assert.equal(replay([call({ command: "create", filename: "gone.html", content: "body" }, 1),
		call({ command: "delete", filename: "gone.html" }, 2)]).size, 0);
});

test("malformed JSON fields cannot create invalid artifact keys or alter accepted content", () => {
	const invalidFilenames = [null, 42, false, {}, [], ""];
	const artifacts = replay([
		call({ command: "create", filename: "report.html", content: "accepted body" }, 1),
		...invalidFilenames.map((filename, index) => call({ command: "create", filename, content: "invalid" }, index + 2)),
		call({ command: "rewrite", filename: "report.html", content: { text: "invalid body" } }, 8),
		call({ command: "update", filename: "report.html", old_str: 1, new_str: "invalid" }, 9),
		call({ command: "update", filename: "report.html", old_str: "accepted", new_str: null }, 10),
	]);
	assert.deepEqual([...artifacts.keys()], ["report.html"]);
	assert.equal(artifacts.get("report.html")?.content, "accepted body");
	assert.equal(artifacts.get("report.html")?.updatedAt, 1);
});

test("base64 artifact bodies reject text replacement updates", () => {
	const artifacts = replay([
		call({ command: "create", filename: "image.png", content: "base64-body", encoding: "base64" }, 1),
		call({ command: "update", filename: "image.png", old_str: "base64", new_str: "corrupted" }, 2),
	]);
	assert.equal(artifacts.get("image.png")?.content, "base64-body");
	assert.equal(artifacts.get("image.png")?.updatedAt, 1);
});
