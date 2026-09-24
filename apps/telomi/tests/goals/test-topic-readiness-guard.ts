import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GoalTopicPlanStore } from "../../server/goals/topic-plan/index.js";
import {
	buildDiscoveryDiscussionContext,
	buildTopicPlanConfirmedEvent,
	registerTopicReadinessGuard,
} from "../../server/main-agent/topic-readiness-guard.js";
import { convertMainAgentMessagesToLlm, getVisibleMessages } from "../../server/main-agent/runner.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "pi-topic-readiness-guard-"));
const goalId = "goal_topic_readiness_guard";
const handlers = new Map<string, (...args: never[]) => unknown>();

try {
	registerTopicReadinessGuard({
		on: (name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler),
	} as never, workspaceDir, goalId);
	const beforeAgentStart = handlers.get("before_agent_start");
	assert.ok(beforeAgentStart, "Topic readiness guard must register before_agent_start");

	const unconfirmed = await beforeAgentStart({ systemPrompt: "BASE" } as never) as { systemPrompt: string };
	assert.match(unconfirmed.systemPrompt, /No Topic Plan has been confirmed/u);
	assert.match(unconfirmed.systemPrompt, /Do not answer the substantive request/u);
	assert.match(unconfirmed.systemPrompt, /Never infer confirmation from user message text/u);

	const store = new GoalTopicPlanStore(goalId, workspaceDir);
	const initial = store.proposePatch({ source: "main_agent", patch: {
		schema_version: 1,
		base_revision: null,
		summary: "Create initial Topic Plan",
		operations: [{ op: "add", topic: {
			id: "tts",
			title: "TTS",
			intent: "Study text-to-speech systems.",
			questions: [], include: [], exclude: [],
		} }],
	} });
	const active = store.activate(initial.proposal_id);
	const topicId = active.topics[0]!.id;
	const confirmed = await beforeAgentStart({ systemPrompt: "BASE" } as never) as { systemPrompt: string };
	assert.match(confirmed.systemPrompt, new RegExp(`Topic Plan revision ${active.revision} is confirmed`, "u"));
	assert.match(confirmed.systemPrompt, /Never ask the user to confirm this revision again/u);

	store.proposePatch({
		source: "main_agent",
		patch: {
			schema_version: 1,
			base_revision: active.revision,
			summary: "Focus on bilingual TTS",
			operations: [{ op: "update", topic_id: topicId, set: { include: ["Chinese and English"] } }],
		},
	});
	const pending = await beforeAgentStart({ systemPrompt: "BASE" } as never) as { systemPrompt: string };
	assert.match(pending.systemPrompt, /Topic Plan changes await confirmation/u);
	assert.match(pending.systemPrompt, /Do not start new Research/u);
	const discovery = store.submitDiscovery({
		schema_version: 1,
		id: "discovery_new_vocoder",
		goal_id: goalId,
		topic_plan_revision: active.revision,
		finding: "A new vocoder family may deserve sustained attention.",
		run_id: "run-vocoder",
		source_id: "source-vocoder",
		section_index: 0,
		cue_index: 0,
		cue: "New vocoder family",
		note: "The Source introduces a materially different vocoder family.",
		evidence: [{ source_path: "document.md", start_line: 1, end_line: 2, content_sha256: "a".repeat(64) }],
		status: "open",
		created_at: new Date().toISOString(),
	});
	const discoveryContext = buildDiscoveryDiscussionContext(discovery, [{
		path: "document.md", startLine: 1, endLine: 2, format: "markdown",
		content: "Exact evidence excerpt.", assets: [],
	}]);
	assert.match(discoveryContext, /Active Discovery discussion/u);
	assert.match(discoveryContext, new RegExp(discovery.id, "u"));
	assert.match(discoveryContext, /does not itself request a Topic Plan change/u);
	assert.match(discoveryContext, /Exact evidence excerpt/u);
	let activeDiscoveryId: string | undefined = discovery.id;
	registerTopicReadinessGuard({
		on: (name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler),
	} as never, workspaceDir, goalId, () => activeDiscoveryId, () => topicId);
	const withDiscovery = await handlers.get("before_agent_start")!({ systemPrompt: "BASE" } as never) as { systemPrompt: string };
	assert.match(withDiscovery.systemPrompt, new RegExp(discovery.id, "u"));
	assert.match(withDiscovery.systemPrompt, /Current Topic focus/u);
	assert.match(withDiscovery.systemPrompt, new RegExp(topicId, "u"));
	activeDiscoveryId = undefined;

	const event = buildTopicPlanConfirmedEvent(active.revision, initial.proposal_id);
	assert.match(event, /^\[EVENT:TOPIC_PLAN_CONFIRMED\]/u);
	assert.match(event, new RegExp(active.revision, "u"));
	assert.match(event, /The user confirmed this Topic Plan through the confirmation action/u);
	const eventMessage = { role: "user", content: [{ type: "text", text: event }] };
	assert.deepEqual(getVisibleMessages([eventMessage]), [], "lifecycle events never appear in chat");
	assert.deepEqual(convertMainAgentMessagesToLlm([eventMessage]), [eventMessage], "the Main Agent receives lifecycle events");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}

console.log("Topic readiness guard tests passed");
