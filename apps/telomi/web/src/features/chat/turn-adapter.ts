import { uiText } from "@/app/ui-text";
import { readableErrorText } from "@/shared/lib/activity-text";

// Adapter: pi-coding-agent AgentMessage[] to Telomi chat turns.
//
// Two layers:
// 1. assistantMessageToTurn(msg)  — single assistant message → AssistantTurn
//    (preserves the 1:1 mapping the existing MessageCard relied on)
// 2. groupMessagesIntoTurns(msgs) — full message list → Turn[]
//    (new: drives the email-like turn-card list
//     ChatDisplay.groupMessagesByTurn)
//
// Grouping follows Telomi's Pi message model:
//   - user / user-with-attachments  →  UserTurn
//   - consecutive assistant messages →  one AssistantTurn (activities concat,
//     last response wins)
//   - toolResult is consumed via toolResultMap, not its own turn

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ActivityItem,
	ActivityStatus,
	ResponseContent,
	TodoItem,
} from "@/features/goals/data/types";
import type { AssistantTurn, PublishedReport } from "@/features/chat/turn-utils";
import type { AttachmentPayload } from "@shared/types";
import { resolveToolDisplayMeta } from "@/shared/lib/tool-icons";

type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantBlock = AssistantMessage["content"][number];

interface UserWithAttachmentsRuntime {
	role: "user-with-attachments";
	content: string;
	attachments?: AttachmentPayload[];
	timestamp?: number;
}

export interface UserTurn {
	type: "user";
	turnId: string;
	text: string;
	hasImages: boolean;
	attachments?: AttachmentPayload[];
	timestamp: number;
}

export interface SystemTurn {
	type: "system";
	turnId: string;
	level: "error" | "info";
	content: string;
	timestamp: number;
}

export type Turn = UserTurn | AssistantTurn | SystemTurn;

export interface AdapterOpts {
	turnId: string;
	isStreaming: boolean;
	toolResultMap: Map<string, ToolResult>;
	pendingToolCalls: Set<string>;
	/** Only the turn's last message carries the reply; earlier text is intermediate activity. */
	isLastMessage?: boolean;
}

function deriveToolStatus(
	toolUseId: string,
	toolResultMap: Map<string, ToolResult>,
	pendingToolCalls: Set<string>,
	isStreaming: boolean,
): ActivityStatus {
	const result = toolResultMap.get(toolUseId);
	if (pendingToolCalls.has(toolUseId)) return "running";
	if (result) return result.isError ? "error" : "completed";
	if (isStreaming) return "running";
	return "error";
}

function extractTodos(block: Extract<AssistantBlock, { type: "toolCall" }>): TodoItem[] | undefined {
	if (block.name !== "TodoWrite" && block.name !== "todos") return undefined;
	const args = block.arguments as { todos?: unknown } | undefined;
	const raw = args?.todos;
	if (!Array.isArray(raw)) return undefined;
	const out: TodoItem[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const obj = item as { content?: unknown; status?: unknown; activeForm?: unknown };
		if (typeof obj.content !== "string") continue;
		const status =
			obj.status === "in_progress" || obj.status === "completed" || obj.status === "interrupted"
				? obj.status
				: "pending";
		out.push({
			content: obj.content,
			status,
			activeForm: typeof obj.activeForm === "string" ? obj.activeForm : undefined,
		});
	}
	return out.length ? out : undefined;
}

function lastNonEmptyLine(text: string): string {
	const lines = text.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const trimmed = lines[i].trim();
		if (trimmed) return trimmed;
	}
	return text.trim();
}

function summarizeRunningTool(
	name: string,
	input: Record<string, unknown>,
	result?: ToolResult,
): string | undefined {
	if (name === "wiki_read_page") {
		const details = result?.details;
		const title = details && typeof details === "object" && "title" in details && typeof details.title === "string"
			? details.title.trim() : "";
		const label = resolveToolDisplayMeta(name)?.displayName ?? name;
		return title ? `${label} · ${title}` : label;
	}
	const pick = (k: string): string => {
		const v = input[k];
		return typeof v === "string" ? v.trim() : "";
	};
	const tasks = input.tasks;
	if (Array.isArray(tasks) && tasks.length > 0) {
		const first = tasks[0] as Record<string, unknown> | undefined;
		if (first && typeof first === "object") {
			const agent = typeof first.agent === "string" ? first.agent : "";
			const task = typeof first.task === "string" ? first.task.trim() : "";
			if (task) {
				const more = tasks.length > 1 ? ` (+${tasks.length - 1})` : "";
				const head = agent ? `${name} · ${agent}` : name;
				return `${head} · ${task.slice(0, 120)}${more}`;
			}
		}
	}
	const desc = pick("description");
	if (desc) return `${name} · ${desc.slice(0, 120)}`;
	const cmd = pick("command");
	if (cmd) return `${name} · ${cmd.split("\n")[0].slice(0, 120)}`;
	const fp = pick("file_path") || pick("path");
	if (fp) return `${name} · ${fp.split("/").pop() ?? fp}`;
	const q = pick("query") || pick("prompt");
	if (q) return `${name} · ${q.slice(0, 120)}`;
	return undefined;
}

function toolErrorMessage(result: ToolResult | undefined): string | undefined {
	if (!result || !result.isError) return undefined;
	const text = result.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("\n")
		.trim();
	return text || uiText("chat.turnAdapter.toolError");
}

function missingToolResultMessage(status: ActivityStatus, result: ToolResult | undefined): string | undefined {
	if (result || status !== "error") return undefined;
	return uiText("chat.turnAdapter.toolCallEndedWithoutAResultTheRunLikely");
}

function publishedReport(message: AssistantMessage): PublishedReport | undefined {
	const route = (message as AssistantMessage & { mainRoute?: { report?: unknown } }).mainRoute;
	const report = route?.report;
	if (!report || typeof report !== "object") return undefined;
	const { runId, title } = report as { runId?: unknown; title?: unknown };
	if (typeof runId !== "string" || !runId.trim()) return undefined;
	return { runId: runId.trim(), title: typeof title === "string" ? title.trim() : "" };
}

export function assistantMessageToTurn(
	message: AssistantMessage,
	opts: AdapterOpts,
): AssistantTurn {
	const { turnId, isStreaming, toolResultMap, pendingToolCalls, isLastMessage = true } = opts;
	const blocks = message.content;
	const baseTs = message.timestamp ?? Date.now();

	let lastTextIdx = -1;
	for (let i = isLastMessage ? blocks.length - 1 : -1; i >= 0; i--) {
		if (blocks[i].type === "text") {
			lastTextIdx = i;
			break;
		}
	}

	const activities: ActivityItem[] = [];
	let todos: TodoItem[] | undefined;

	blocks.forEach((block, i) => {
		const ts = baseTs + i;
		if (block.type === "thinking") {
			activities.push({
				id: `${turnId}:think:${i}`,
				type: "thinking",
				status: "completed",
				content: block.thinking,
				timestamp: ts,
			});
			return;
		}
		if (block.type === "toolCall") {
			const status = deriveToolStatus(block.id, toolResultMap, pendingToolCalls, isStreaming);
			const result = toolResultMap.get(block.id);
			const todosFromBlock = extractTodos(block);
			if (todosFromBlock) todos = todosFromBlock;
			const toolInput = (block.arguments ?? {}) as Record<string, unknown>;
			const toolDisplayMeta: ActivityItem["toolDisplayMeta"] = resolveToolDisplayMeta(
				block.name,
				toolInput,
			);
			activities.push({
				id: block.id,
				type: "tool",
				status,
				toolName: block.name,
				toolUseId: block.id,
				toolInput,
				toolDisplayMeta,
				toolResult: result,
				timestamp: ts,
				error: toolErrorMessage(result) ?? missingToolResultMessage(status, result),
			});
			return;
		}
		if (block.type === "text" && i !== lastTextIdx) {
			const isLatestBlock = i === blocks.length - 1;
			activities.push({
				id: `${turnId}:text:${i}`,
				type: "intermediate",
				status: isStreaming && isLatestBlock ? "running" : "completed",
				content: block.text,
				timestamp: ts,
			});
		}
	});

	let response: ResponseContent | undefined;
	if (lastTextIdx >= 0) {
		const lastText = blocks[lastTextIdx] as Extract<AssistantBlock, { type: "text" }>;
		response = {
			text: lastText.text,
			isStreaming: isStreaming && !!lastText.text,
			streamStartTime: baseTs,
			messageId: (message as AssistantMessage & { citationMessageId?: string }).citationMessageId ?? turnId,
		};
	}

	const allToolsResolved = activities
		.filter((a) => a.type === "tool")
		.every((a) => a.status === "completed" || a.status === "error");
	const isComplete = !isStreaming && allToolsResolved;

	// Compute a collapsed-header hint without mutating activities.
	// Streaming → tail of streaming text/thinking; otherwise undefined and
	// the parent (groupMessagesIntoTurns) handles the completed-turn fallback.
	let intent: string | undefined;
	if (isStreaming && blocks.length > 0) {
		const last = blocks[blocks.length - 1];
		if (last.type === "text" && last.text) {
			intent = lastNonEmptyLine(last.text).slice(0, 200) || undefined;
		} else if (last.type === "thinking" && last.thinking) {
			intent = lastNonEmptyLine(last.thinking).slice(0, 200) || undefined;
		}
	}

	return {
		type: "assistant",
		turnId,
		activities,
		response,
		intent,
		isStreaming,
		isComplete,
		timestamp: baseTs,
		todos,
		report: publishedReport(message),
	};
}

function userMessageText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("\n");
}

function userMessageHasImages(content: UserMessage["content"]): boolean {
	if (typeof content === "string") return false;
	return content.some((c) => c.type === "image");
}

function isUserWithAttachments(msg: AgentMessage): boolean {
	return (msg as unknown as { role?: string }).role === "user-with-attachments";
}

/**
 * Group a flat AgentMessage[] into Turn[] for email-like rendering.
 *
 * - Each user / user-with-attachments message → UserTurn
 * - Consecutive assistant messages → one AssistantTurn (activities concatenated,
 *   final response = the last assistant block's response)
 * - toolResult messages are NOT turned into turns; they are pre-indexed into
 *   toolResultMap and consumed by the assistant block they reference.
 */
export function groupMessagesIntoTurns(
	messages: AgentMessage[],
	opts: {
		toolResultMap: Map<string, ToolResult>;
		pendingToolCalls: Set<string>;
		isStreaming: boolean;
		lastAssistantIndex: number;
	},
): Turn[] {
	const { toolResultMap, pendingToolCalls, isStreaming, lastAssistantIndex } = opts;
	const turns: Turn[] = [];
	let pendingAssistant: Array<{ msg: AssistantMessage; absIndex: number }> = [];

	const flushAssistant = () => {
		if (pendingAssistant.length === 0) return;
		const merged: ActivityItem[] = [];
		let mergedTodos: TodoItem[] | undefined;
		let lastResponse: ResponseContent | undefined;
		let report: PublishedReport | undefined;
		let lastTimestamp = pendingAssistant[0].msg.timestamp ?? Date.now();
		let anyStreaming = false;
		let lastErrorMessage: string | undefined;
		let liveIntent: string | undefined;

		pendingAssistant.forEach(({ msg, absIndex }, position) => {
			const turnId = msgTurnId(msg, absIndex);
			const isThisStreaming = isStreaming && absIndex === lastAssistantIndex;
			if (isThisStreaming) anyStreaming = true;
			const sub = assistantMessageToTurn(msg, {
				turnId,
				isStreaming: isThisStreaming,
				toolResultMap,
				pendingToolCalls,
				isLastMessage: position === pendingAssistant.length - 1,
			});
			if (isThisStreaming) liveIntent = sub.intent;
			merged.push(...sub.activities);
			if (sub.todos) mergedTodos = sub.todos;
			if (sub.response) lastResponse = sub.response;
			if (sub.report) report = sub.report;
			lastTimestamp = sub.timestamp;
			// stopReason === "aborted" is user-initiated, not a real error —
			// runner emits a "Stopped" status instead. Skip the noisy
			// "AbortError: ..." text that pi-agent-core mirrors into
			// errorMessage, otherwise we show a redundant red banner.
			if (
				msg.errorMessage &&
				!msg.errorMessage.startsWith("__") &&
				msg.stopReason !== "aborted"
			) {
				lastErrorMessage = msg.errorMessage;
			}
		});

		merged.sort((a, b) => a.timestamp - b.timestamp);

		const allToolsResolved = merged
			.filter((a) => a.type === "tool")
			.every((a) => a.status === "completed" || a.status === "recovered" || a.status === "error");
		const isComplete = !anyStreaming && allToolsResolved;

		// Compute a turn-level `intent` for the collapsed header, never mutating
		// activities (TurnCard's ActivityRow renders activity.intent next to the
		// tool name, so stamping it there double-prints the summary).
		// Priority:
		//   1. running tool → summarize its input
		//   2. streaming thinking → its latest line, so the header tracks the Agent live
		//   3. completed turn → latest tool with a summarizable input
		let turnIntent: string | undefined;
		if (!turnIntent) {
			const runningTool = merged.find(
				(a) => a.type === "tool" && a.status === "running" && a.toolName,
			);
			if (runningTool && runningTool.toolName) {
				turnIntent = summarizeRunningTool(
					runningTool.toolName,
					(runningTool.toolInput ?? {}) as Record<string, unknown>,
					toolResultMap.get(runningTool.id),
				);
			}
		}
		if (!turnIntent && anyStreaming && !lastResponse?.isStreaming) turnIntent = liveIntent;
		if (!turnIntent && !anyStreaming) {
			for (let index = merged.length - 1; index >= 0; index -= 1) {
				const a = merged[index];
				if (a.type !== "tool" || !a.toolName) continue;
				const summary = summarizeRunningTool(
					a.toolName,
					(a.toolInput ?? {}) as Record<string, unknown>,
					toolResultMap.get(a.id),
				);
				if (summary) {
					turnIntent = summary;
					break;
				}
			}
		}

		if (!lastResponse && isComplete && merged.length > 0) {
			for (let i = merged.length - 1; i >= 0; i--) {
				const a = merged[i];
				if (a.type === "intermediate" && a.content) {
					lastResponse = {
						text: a.content,
						isStreaming: false,
						messageId: a.id,
						streamStartTime: a.timestamp,
					};
					break;
				}
			}
		}

		const turnId = msgTurnId(pendingAssistant[0].msg, pendingAssistant[0].absIndex);
		turns.push({
			type: "assistant",
			turnId,
			activities: merged,
			response: lastResponse,
			intent: turnIntent,
			isStreaming: anyStreaming,
			isComplete,
			timestamp: lastTimestamp,
			todos: mergedTodos,
			report,
		});
		if (lastErrorMessage) {
			turns.push({
				type: "system",
				turnId: `${turnId}:err`,
				level: "error",
				content: readableErrorText(lastErrorMessage),
				timestamp: lastTimestamp + 1,
			});
		}

		pendingAssistant = [];
	};

	messages.forEach((msg, i) => {
		if (msg.role === "toolResult") return;

		if (msg.role === "user") {
			flushAssistant();
			turns.push({
				type: "user",
				turnId: `user:${i}`,
				text: userMessageText(msg.content),
				hasImages: userMessageHasImages(msg.content),
				timestamp: msg.timestamp ?? Date.now(),
			});
			return;
		}

		if (isUserWithAttachments(msg)) {
			flushAssistant();
			const uwa = msg as unknown as UserWithAttachmentsRuntime;
			turns.push({
				type: "user",
				turnId: `user:${i}`,
				text: uwa.content ?? "",
				hasImages: false,
				attachments: uwa.attachments,
				timestamp: uwa.timestamp ?? Date.now(),
			});
			return;
		}

		if (msg.role === "assistant") {
			pendingAssistant.push({ msg, absIndex: i });
		}
	});

	flushAssistant();
	return turns;
}

function msgTurnId(msg: AssistantMessage, index: number): string {
	const firstToolCall = msg.content.find((b) => b.type === "toolCall") as
		| { id: string }
		| undefined;
	if (firstToolCall?.id) return firstToolCall.id;
	return `assistant:${msg.timestamp ?? 0}:${index}`;
}
