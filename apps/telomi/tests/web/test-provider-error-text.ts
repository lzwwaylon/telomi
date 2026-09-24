import assert from "node:assert/strict";

import { setUiLocale } from "../../web/src/app/i18n.js";
import { groupMessagesIntoTurns } from "../../web/src/features/chat/turn-adapter.js";
import { readableErrorText } from "../../web/src/shared/lib/activity-text.js";

// pi-ai records a Provider rejection with its raw JSON body; chat shows the status and the Provider's words.
const body = "{\"message\":\"Insufficient Balance\",\"type\":\"unknown_error\",\"param\":null,\"code\":\"invalid_request_error\"}";
await setUiLocale("zh-CN");
const errorTurn = groupMessagesIntoTurns([
	{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
	{ role: "assistant", content: [], stopReason: "error", errorMessage: `402: ${body}`, timestamp: 2 },
] as never[], { toolResultMap: new Map(), pendingToolCalls: new Set(), isStreaming: false, lastAssistantIndex: 1 })
	.find((turn) => turn.type === "system");

assert.ok(errorTurn?.type === "system");
assert.equal(errorTurn.level, "error");
assert.equal(errorTurn.content, "模型服务返回错误（HTTP 402）：Insufficient Balance");
await setUiLocale("en");
assert.equal(readableErrorText(`402: ${body}`), "The model provider returned an error (HTTP 402): Insufficient Balance");

await setUiLocale("zh-CN");
// The OpenAI SDK folds the body into its own message, and Runtime prefixes what it relays; both read alike.
assert.equal(readableErrorText("Search Root model call failed: 402 Insufficient Balance"), "模型服务返回错误（HTTP 402）：Insufficient Balance");
assert.equal(readableErrorText(`429: {"error":{"message":"Rate limit reached"}}`), "模型服务返回错误（HTTP 429）：Rate limit reached");
// Without an explanation the status still says what failed, and the body itself never shows.
assert.equal(readableErrorText("402 status code (no body)"), "模型服务返回错误（HTTP 402）");
assert.equal(readableErrorText(`500: {"code":"internal"}`), "模型服务返回错误（HTTP 500）");
// Other error text is shown as it is.
for (const text of ["Prime Search exited with code 1: schema mismatch", "fetch failed", "Connection error."]) {
	assert.equal(readableErrorText(text), text);
}

console.log("Provider error text test passed");
