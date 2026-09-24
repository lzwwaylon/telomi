import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { convertMainAgentMessagesToLlm, getVisibleMessages } from "../../server/main-agent/runner.js";

// The Pi session is the only record of a Main Agent conversation. The model gets it as is;
// the chat shows every assistant message in full: thinking, intermediate text, Tool calls and reply.
const previousReply = { role: "assistant", content: [{ type: "text", text: "previous reply" }] };
const user = { role: "user", content: [{ type: "text", text: "follow up" }] };
const thinking = {
	role: "assistant",
	content: [
		{ type: "text", text: "internal plan" },
		{ type: "toolCall", id: "call-1", name: "research", arguments: {} },
	],
};
const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "research", content: [{ type: "text", text: "Report published." }] };
const reply = { role: "assistant", content: [{ type: "text", text: "final answer" }] };
const next = { role: "user", content: [{ type: "text", text: "next question" }] };
const event = { role: "user", content: [{ type: "text", text: "[EVENT:GOAL_CREATED]\nMaintain the Topic Plan" }] };
const silent = { role: "assistant", content: [{ type: "text", text: "[SILENT]" }] };

const turn = [previousReply, user, thinking, toolResult, reply, next];
assert.deepEqual(getVisibleMessages(turn), turn, "chat keeps every assistant message of each turn in full");
assert.deepEqual(getVisibleMessages(turn.slice(0, 5), 2), turn.slice(0, 5),
	"a live turn streams in full so the chat shows what the Agent is doing");
assert.deepEqual(getVisibleMessages([previousReply, event, thinking, toolResult], 1), [
	previousReply,
	{ ...thinking, content: [thinking.content[1]] },
	toolResult,
], "a live turn answering a lifecycle event shows only its Tool calls");
assert.deepEqual(getVisibleMessages([previousReply, event, silent, next]), [previousReply, next],
	"lifecycle events and [SILENT] replies to them never appear in chat");
assert.deepEqual(convertMainAgentMessagesToLlm(turn), turn, "the model receives the session unchanged");
assert.deepEqual(convertMainAgentMessagesToLlm([event]), [event], "the model receives lifecycle events");

// Restart: Pi restores the session and the same projection applies, no extra state needed.
const root = mkdtempSync(join(tmpdir(), "telomi-main-agent-session-projection-"));
try {
	const contextFile = join(root, "context.jsonl");
	const session = SessionManager.open(contextFile, root, root);
	for (const message of [user, thinking, toolResult, reply]) session.appendMessage(message as never);
	const reloaded = SessionManager.open(contextFile, root, root).buildSessionContext().messages;
	assert.deepEqual(getVisibleMessages(reloaded).map((message) => message.content), [
		user.content, thinking.content, toolResult.content, reply.content,
	]);
	assert.equal(convertMainAgentMessagesToLlm(reloaded).length, 4);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("Main Agent session projection tests passed");
