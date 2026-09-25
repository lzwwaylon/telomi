import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { GLOBAL_MEMORY_TAG, HindsightClient, renderRecall, renderReflect } from "./src/client.js";

interface PendingTurn {
	eventId: string;
	prompt: string;
	occurredAt: string;
}

export const MEMORY_UNAVAILABLE_TEXT =
	"User memory is temporarily unavailable: the memory service is applying a new configuration and restarting. Answer from the current conversation without remembered context, and note to the user that memory was skipped this turn if it would have mattered.";

/**
 * A 503 from the service, or no service at the address, while it is being replaced; or a running
 * service whose database refuses connections, which Hindsight reports as a 500 quoting the errno.
 */
export function isMemoryUnavailable(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /HTTP 503\b/u.test(message) || /ECONNREFUSED|fetch failed/u.test(message)
		|| /HTTP 500\b.*Connection refused/u.test(message);
}

const memoryToolParameters = {
	type: "object",
	properties: {
		mode: { anyOf: [{ const: "recall" }, { const: "reflect" }] },
		intent: {
			anyOf: [{ const: "preference" }, { const: "goal_understanding" }, { const: "related_history" }],
			description: "The single kind of user history needed for this lookup",
		},
		query: { type: "string", description: "A focused question about relevant user history or the user's current preference" },
	},
	required: ["mode", "intent", "query"],
	additionalProperties: false,
} as const;

export interface PiUserMemoryConfig {
	baseUrl?: string;
	bankId?: string;
	goalId?: string;
	retainTurns?: boolean;
}

export interface ResolvedPiUserMemoryConfig {
	baseUrl: string;
	bankId: string;
	goalId?: string;
}

export function resolvePiUserMemoryConfig(config: PiUserMemoryConfig = {}): ResolvedPiUserMemoryConfig {
	const goalId = config.goalId?.trim() || process.env.PI_USER_MEMORY_GOAL_ID?.trim();
	return {
		baseUrl: config.baseUrl?.trim() || process.env.HINDSIGHT_URL?.trim() || "http://127.0.0.1:18888/v1/default",
		bankId: config.bankId?.trim() || process.env.HINDSIGHT_BANK_ID?.trim() || `pi-user-${userInfo().username.replace(/[^a-zA-Z0-9_-]/gu, "-")}`,
		...(goalId ? { goalId } : {}),
	};
}

export function registerPiUserMemory(pi: ExtensionAPI, config: PiUserMemoryConfig = {}): void {
	const { baseUrl, bankId, goalId } = resolvePiUserMemoryConfig(config);
	const client = bankId ? new HindsightClient(baseUrl, bankId) : undefined;
	const retainTurns = config.retainTurns ?? true;
	let pending: PendingTurn[] = [];

	pi.on("before_agent_start", async (event) => {
		if (!client) return undefined;
		if (retainTurns) pending.push({ eventId: randomUUID(), prompt: event.prompt, occurredAt: new Date().toISOString() });
		return undefined;
	});

	pi.registerTool<typeof memoryToolParameters, unknown>({
		name: "search_user_memory",
		label: "Search User Memory",
		description: "Search long-term user memory. Use recall for raw source evidence. Use reflect to resolve changing or conflicting memories into a current conclusion. Current user text always overrides history.",
		parameters: memoryToolParameters,
		async execute(_toolCallId, params) {
			if (!client) throw new Error("HINDSIGHT_BANK_ID is required");
			process.stderr.write(`HINDSIGHT_TOOL_QUERY\t${params.mode}\t${params.intent}\t${params.query}\n`);
			try {
				if (params.mode === "reflect") {
					const result = await client.reflect(params.query, { goalId });
					return { content: [{ type: "text", text: renderReflect(result) }], details: { mode: "reflect", intent: params.intent, result } };
				}
				const result = await client.recall(params.query, { goalId });
				return { content: [{ type: "text", text: renderRecall(result) }], details: { mode: "recall", intent: params.intent, result } };
			} catch (error) {
				// The service refuses requests while a new configuration is applied and it restarts.
				// That is a known, short outage: the turn continues without memory instead of failing.
				if (!isMemoryUnavailable(error)) throw error;
				return { content: [{ type: "text", text: MEMORY_UNAVAILABLE_TEXT }], details: { mode: params.mode, intent: params.intent, unavailable: true } };
			}
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!client || pending.length === 0) return;
		const failed: PendingTurn[] = [];
		for (const turn of pending) {
			try {
				// A Goal's messages are recalled in that Goal only; the user makes an Episode global
				// explicitly. Without a Goal, every Pi session shares the memory.
				const goalTag = goalId ? `goal:${goalId}` : undefined;
				const tags = goalTag ? [goalTag] : [GLOBAL_MEMORY_TAG];
				await client.retain({
					documentId: `pi-turn-${turn.eventId}`,
					occurredAt: turn.occurredAt,
					content: turn.prompt,
					context: goalId
						? `Direct user message in Pi. Goal scope: ${goalId}`
						: "Direct user message in Pi.",
					tags,
					metadata: { source: "pi_turn", durability: "episode", ...(goalId ? { goal_id: goalId } : {}) },
					...(goalTag ? { observationScopes: [[goalTag]] } : {}),
				});
				process.stderr.write(`HINDSIGHT_MEMORY_RETAINED\t${turn.eventId}\n`);
			} catch (error) {
				failed.push(turn);
				process.stderr.write(`HINDSIGHT_MEMORY_RETAIN_FAILED\t${turn.eventId}\t${error instanceof Error ? error.message : String(error)}\n`);
			}
		}
		pending = failed;
		ctx.ui.setStatus("pi-user-memory", failed.length ? `memory retry pending: ${failed.length}` : "memory retained");
	});

	pi.registerCommand("memory-status", {
		description: "Show recent Hindsight memory operations",
		handler: async (_args, ctx) => {
			if (!client) return ctx.ui.notify("HINDSIGHT_BANK_ID is not configured", "error");
			try {
				ctx.ui.notify(JSON.stringify(await client.status(), null, 2), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("memory-forget", {
		description: "Delete the configured Hindsight memory bank",
		handler: async (_args, ctx) => {
			if (!client || !bankId) return ctx.ui.notify("HINDSIGHT_BANK_ID is not configured", "error");
			if (!ctx.hasUI || !await ctx.ui.confirm("Delete user memory", `Delete the entire Hindsight bank ${bankId}?`)) return;
			await client.deleteBank();
			ctx.ui.notify("Hindsight memory bank deleted", "info");
		},
	});
}

export default function piUserMemory(pi: ExtensionAPI): void {
	registerPiUserMemory(pi);
}

export { GLOBAL_MEMORY_TAG, HindsightClient } from "./src/client.js";
export type { HindsightDocument, HindsightDocumentDetail, HindsightMemoryUnit, MemoryUnitUpdate, RetainInput } from "./src/client.js";
