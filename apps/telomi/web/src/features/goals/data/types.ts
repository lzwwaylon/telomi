import type { ToolDisplayMeta } from "@/shared/lib/tool-icons";

/**
 * React-only helper types for goal presentation. Server-facing contracts are
 * imported from their owner in `@shared/types`.
 */

export type ConnectionState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "open" }
	| { kind: "error"; message: string }
	| { kind: "closed" };

export type BackendConnectionStatus = "connecting" | "connected" | "disconnected";

export type ActivityStatus = "pending" | "running" | "completed" | "recovered" | "error" | "backgrounded";
export type ActivityType = "tool" | "thinking" | "intermediate" | "status";
export type TodoStatus = "pending" | "in_progress" | "completed" | "interrupted";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	activeForm?: string;
}

export interface ActivityItem {
	id: string;
	type: ActivityType;
	status: ActivityStatus;
	toolName?: string;
	toolUseId?: string;
	operationId?: string;
	toolInput?: Record<string, unknown>;
	content?: string;
	intent?: string;
	messageId?: string;
	displayName?: string;
	toolDisplayMeta?: ToolDisplayMeta;
	toolResult?: unknown;
	timestamp: number;
	error?: string;
	parentId?: string;
	depth?: number;
	statusType?: string;
	taskId?: string;
	shellId?: string;
	elapsedSeconds?: number;
	isBackground?: boolean;
}

export interface ResponseContent {
	text: string;
	isStreaming: boolean;
	streamStartTime?: number;
	messageId?: string;
}
