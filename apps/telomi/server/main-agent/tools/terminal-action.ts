import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export const MAIN_TERMINAL_ACTIONS = [
	"research",
	"generate_report",
	"generate_podcast",
] as const;

export type MainTerminalAction = (typeof MAIN_TERMINAL_ACTIONS)[number];
export type MainCoarseAction = MainTerminalAction | "assistant_reply";

export interface MainTerminalDetails {
	terminal: true;
	action: MainCoarseAction;
	userResponse: string;
	trace: {
		coarseAction: MainCoarseAction;
		selectedRunId?: string;
		reasonCode: string;
	};
	[key: string]: unknown;
}

export function createAssistantReplyDetails(message: string): MainTerminalDetails {
	const userResponse = message.trim();
	if (!userResponse) throw new Error("Main Agent completed without a reply");
	return {
		terminal: true,
		action: "assistant_reply",
		userResponse,
		trace: {
			coarseAction: "assistant_reply",
			reasonCode: "assistant_reply",
		},
	};
}

export function asTerminalTool(
	tool: AgentTool<any>,
	action: MainTerminalAction,
	reasonCode: string,
): AgentTool<any> {
	return {
		...tool,
		execute: async (...args): Promise<AgentToolResult<MainTerminalDetails>> => {
			const result = await tool.execute(...args);
			const details = result.details && typeof result.details === "object"
				? result.details as Record<string, unknown>
				: {};
			const explicitResponse = typeof details.userResponse === "string" ? details.userResponse.trim() : "";
			const userResponse = explicitResponse || result.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("\n")
				.trim();
			if (!userResponse) throw new Error(`${action} completed without a user-facing result`);
			const selectedRunId = typeof details.runId === "string"
					? details.runId
					: typeof details.run_id === "string"
						? details.run_id
						: undefined;
			return {
				...result,
				details: {
					...details,
					terminal: true,
					action,
					userResponse,
					trace: {
						coarseAction: action,
						...(selectedRunId ? { selectedRunId } : {}),
						reasonCode,
					},
				},
				terminate: true,
			};
		},
	};
}

export function parseMainTerminalDetails(value: unknown): MainTerminalDetails | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const details = value as Record<string, unknown>;
	if (
		details.terminal !== true
		|| !MAIN_TERMINAL_ACTIONS.includes(details.action as MainTerminalAction)
	) {
		return undefined;
	}
	if (typeof details.userResponse !== "string" || !details.userResponse.trim()) return undefined;
	if (!details.trace || typeof details.trace !== "object" || Array.isArray(details.trace)) return undefined;
	const trace = details.trace as Record<string, unknown>;
	if (
		trace.coarseAction !== details.action
		|| typeof trace.reasonCode !== "string"
		|| !trace.reasonCode.trim()
	) {
		return undefined;
	}
	if (trace.selectedRunId !== undefined && typeof trace.selectedRunId !== "string") return undefined;
	return details as unknown as MainTerminalDetails;
}
