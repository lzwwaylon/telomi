// Global Preferences reach Main Agent on every turn instead of waiting for it to search: the user
// made them global on purpose, and an Agent that must think of searching often does not. Goal
// memory stays behind search_user_memory.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GLOBAL_MEMORY_TAG, type HindsightClient } from "pi-user-memory";

import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { splitFact } from "../goals/memory/memory-api.js";

/** Keeps the system Prompt bounded; the rest stay reachable through search_user_memory. */
const MAX_PREFERENCE_CHARS = 4_000;

/**
 * Renders the Memory Facts of every global Episode, newest first. Read fresh each turn, so what the
 * user curates on the Memory page applies from the next turn, with no copy to go stale.
 */
export async function renderGlobalPreferences(client: Pick<HindsightClient, "listMemoryUnits">): Promise<string | undefined> {
	let units;
	try {
		units = await client.listMemoryUnits([GLOBAL_MEMORY_TAG], "valid");
	} catch (error) {
		console.warn(`[memory] Global Preferences not loaded: ${error instanceof Error ? error.message : String(error)}`);
		return renderAgentPrompt("main", "router", "system-append", { unavailable: true }, "global-preferences").content;
	}
	const facts = units
		// Observations are Hindsight's consolidation and stay in the Goal they came from.
		.filter((unit) => unit.fact_type !== "observation")
		.map((unit) => ({ date: unit.mentioned_at?.slice(0, 10) ?? "", text: splitFact(unit.text).statement }))
		.sort((left, right) => right.date.localeCompare(left.date));
	if (facts.length === 0) return undefined;
	const preferences: typeof facts = [];
	let length = 0;
	for (const fact of facts) {
		length += fact.text.length;
		if (preferences.length > 0 && length > MAX_PREFERENCE_CHARS) break;
		preferences.push(fact);
	}
	return renderAgentPrompt("main", "router", "system-append", {
		preferences,
		omitted: facts.length - preferences.length,
	}, "global-preferences").content;
}

export function registerGlobalPreferences(pi: ExtensionAPI, client: Pick<HindsightClient, "listMemoryUnits">): void {
	pi.on("before_agent_start", async (event) => {
		const preferences = await renderGlobalPreferences(client);
		return preferences ? { systemPrompt: `${event.systemPrompt}\n\n${preferences}` } : undefined;
	});
}
