import assert from "node:assert/strict";
import { test } from "node:test";

import type { HindsightMemoryUnit } from "pi-user-memory";

import { registerGlobalPreferences } from "../../server/main-agent/global-preferences.js";

type BeforeAgentStart = (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>;

function unit(text: string, mentionedAt: string, factType = "world"): HindsightMemoryUnit {
	return { id: text, text, fact_type: factType, state: "valid", tags: ["goal:goal_a", "scope:global"], mentioned_at: mentionedAt };
}

function beforeAgentStart(listMemoryUnits: (tags: string[], state: "valid" | "invalidated") => Promise<HindsightMemoryUnit[]>): BeforeAgentStart {
	let handler: BeforeAgentStart | undefined;
	registerGlobalPreferences({ on: (_name: string, registered: BeforeAgentStart) => { handler = registered; } } as never, { listMemoryUnits });
	assert.ok(handler);
	return handler;
}

test("every turn lists the valid global Memory Facts, newest first, without Hindsight's detail", async () => {
	const requests: unknown[] = [];
	const handler = beforeAgentStart(async (tags, state) => {
		requests.push({ tags, state });
		return [
			unit("Explain algorithms from the PyTorch data flow | Involving: user | stated twice", "2026-09-20T08:00:00Z"),
			unit("Keep reports short", "2026-09-25T08:00:00Z"),
			unit("Consolidated view of the user", "2026-09-26T08:00:00Z", "observation"),
		];
	});

	const { systemPrompt } = (await handler({ systemPrompt: "BASE" }))!;
	assert.deepEqual(requests, [{ tags: ["scope:global"], state: "valid" }]);
	assert.ok(systemPrompt.startsWith("BASE\n\n## Global Preferences"));
	assert.match(systemPrompt, /- \[2026-09-25\] Keep reports short\n- \[2026-09-20\] Explain algorithms from the PyTorch data flow$/u);
	assert.doesNotMatch(systemPrompt, /Involving|Consolidated view/u);
	assert.doesNotMatch(systemPrompt, /not shown/u);
});

test("a turn without global memory leaves the system prompt alone", async () => {
	assert.equal(await beforeAgentStart(async () => [])({ systemPrompt: "BASE" }), undefined);
});

test("the list stays bounded and says how many older ones search_user_memory still recalls", async () => {
	const long = "x".repeat(1_500);
	const handler = beforeAgentStart(async () => Array.from({ length: 5 }, (_, day) => unit(`${day} ${long}`, `2026-09-0${day + 1}T00:00:00Z`)));
	const { systemPrompt } = (await handler({ systemPrompt: "BASE" }))!;
	assert.match(systemPrompt, /\[2026-09-05\] 4 x/u);
	assert.match(systemPrompt, /\[2026-09-04\] 3 x/u);
	assert.doesNotMatch(systemPrompt, /\[2026-09-03\]/u);
	assert.match(systemPrompt, /3 older Global Preferences are not shown; search_user_memory recalls them\./u);
});

test("unavailable memory tells the Agent instead of failing the turn", async () => {
	const handler = beforeAgentStart(async () => {
		throw new Error("Hindsight /banks/b/memories/list failed: HTTP 503 draining");
	});
	const { systemPrompt } = (await handler({ systemPrompt: "BASE" }))!;
	assert.match(systemPrompt, /User Memory is unavailable this turn, so the user's Global Preferences could not be loaded\./u);
});
