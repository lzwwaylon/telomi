import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../web/src/app/i18n.js";
import { LiveKitConversationResponse } from "../../web/src/features/chat/ChatComposer.js";
import { hasListeningAgent } from "../../web/src/features/voice/useLiveKitConversation.js";

test("LiveKit only opens the microphone after an Agent starts listening", () => {
	const remoteParticipants = new Map([
		["initializing", {
			isAgent: true,
			attributes: { "lk.agent.state": "initializing" },
		}],
	]);
	assert.equal(hasListeningAgent({ remoteParticipants } as never), false);
	remoteParticipants.set("listening", {
		isAgent: true,
		attributes: { "lk.agent.state": "listening" },
	});
	assert.equal(hasListeningAgent({ remoteParticipants } as never), true);
});

test("a spoken response keeps both its text and listening status visible", () => {
	const html = renderToStaticMarkup(
		<LiveKitConversationResponse
			state={{
				status: "listening",
				userText: "我们现在可以实时说话了吗？",
				text: "可以，我们现在开始全双工对话。",
				message: "正在聆听，可随时说话或打断",
			}}
		/>,
	);

	assert.match(html, /我们现在可以实时说话了吗？/);
	assert.match(html, /可以，我们现在开始全双工对话。/);
	assert.match(html, /正在聆听，可随时说话或打断/);
	assert.match(html, /role="status"/);
});
