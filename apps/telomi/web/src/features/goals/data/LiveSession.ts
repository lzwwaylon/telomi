import { apiClient } from "@/shared/lib/api-client";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { subscribeGoalSessionEvents } from "@/shared/lib/goalsEventsStream";
import type { GoalSnapshot, SendMessageRequest, SendMessageResult } from "@shared/types";
import type { ConnectionState } from "@/features/goals/data/types";

type SnapshotListener = (snapshot: GoalSnapshot) => void;
type ConnectionListener = (state: ConnectionState) => void;

/**
 * React-side live session for a single goal. Owns one EventSource and exposes
 * the latest GoalSnapshot to subscribers. Does NOT implement the pi-agent-core
 * Agent interface — ChatPanel compatibility is not a goal here.
 *
 * Design notes (see memory: project_pi_web_ui_streaming_contract):
 * - The server always ships the full GoalSnapshot in each envelope, so we don't
 *   reduce partial/final events ourselves.
 * - The raw `event` field in the envelope is ignored for now; Phase 2+ can peek
 *   at it if a visual (thinking-block flicker, tool-start flash) needs it.
 */

export class LiveSession {
	private unsubscribeEvents?: () => void;
	private pollTimer?: ReturnType<typeof setInterval>;
	private refreshInFlight = false;
	private streamOpen = false;
	private closed = false;
	private snapshotListeners = new Set<SnapshotListener>();
	private connectionListeners = new Set<ConnectionListener>();
	private _snapshot?: GoalSnapshot;
	private _connection: ConnectionState = { kind: "idle" };
	// Set right after an optimistic apply; armed for ~1s so the agent_start
	// envelope (which still carries the *pre-push* messages array — pi-agent-core
	// emits agent_start before mutating state.messages) can't temporarily roll
	// the UI back to length-1. Cleared once a server envelope catches up.
	private _optimisticUntil = 0;

	constructor(public readonly goalId: string) {}

	get snapshot(): GoalSnapshot | undefined {
		return this._snapshot;
	}

	get connection(): ConnectionState {
		return this._connection;
	}

	onSnapshot(listener: SnapshotListener): () => void {
		this.snapshotListeners.add(listener);
		return () => this.snapshotListeners.delete(listener);
	}

	onConnection(listener: ConnectionListener): () => void {
		this.connectionListeners.add(listener);
		return () => this.connectionListeners.delete(listener);
	}

	async init(): Promise<void> {
		this.setConnection({ kind: "loading" });
		try {
			await this.refreshSnapshot();
			this.setConnection({ kind: "open" });
			this.connect();
			this.startPolling();
		} catch (err) {
			this.setConnection({
				kind: "error",
				message: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	}

	async sendMessage(body: SendMessageRequest): Promise<SendMessageResult> {
		const content = body.content?.trim() ?? "";
		const attachments = body.attachments ?? [];
		const current = this._snapshot;
		if (current && (content || attachments.length > 0)) {
			const optimistic: AgentMessage =
				attachments.length > 0
					? ({
							role: "user-with-attachments",
							content,
							attachments,
							timestamp: Date.now(),
						} as unknown as AgentMessage)
					: ({
							role: "user",
							content,
							timestamp: Date.now(),
						} as AgentMessage);
			// The Runner only emits once the Agent starts, which can take seconds of workspace
			// preparation; mark the turn live now so the chat shows "thinking" immediately.
			this.applySnapshot({
				...current,
				messages: [...current.messages, optimistic],
				isStreaming: true,
			});
			this._optimisticUntil = Date.now() + 1000;
		}
		const result = await apiClient.post<Partial<SendMessageResult>>(`/api/goals/${this.goalId}/messages`, body);
		return {
			queued: result.queued === true,
			queuePosition:
				typeof result.queuePosition === "number" &&
				Number.isSafeInteger(result.queuePosition) &&
				result.queuePosition > 0
					? result.queuePosition
					: 0,
		};
	}

	async abort(): Promise<void> {
		const data = await apiClient.post<{ state?: GoalSnapshot }>(`/api/goals/${this.goalId}/abort`);
		if (data?.state) this.applySnapshot(data.state);
	}

	async setModel(modelId: string): Promise<void> {
		await this.patchConfig({ modelId });
	}

	async setThinkingLevel(thinkingLevel: ThinkingLevel): Promise<void> {
		await this.patchConfig({ thinkingLevel });
	}

	private async patchConfig(body: { modelId?: string; thinkingLevel?: ThinkingLevel }): Promise<void> {
		const data = await apiClient.patch<{ state?: GoalSnapshot }>(`/api/goals/${this.goalId}/config`, body);
		if (data?.state) this.applySnapshot(data.state);
	}

	disconnect(): void {
		this.closed = true;
		this.stopPolling();
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = undefined;
		this.setConnection({ kind: "closed" });
	}

	private connect(): void {
		if (this.closed) return;
		this.unsubscribeEvents?.();
		this.unsubscribeEvents = subscribeGoalSessionEvents(
			this.goalId,
			(state) => {
				if (this.closed) return;
				this.streamOpen = true;
				this.stopPolling();
				if (this._connection.kind !== "open") this.setConnection({ kind: "open" });
				this.applySnapshot(state);
			},
			(connected) => {
				if (connected) {
					if (this.closed) return;
					this.streamOpen = true;
					this.stopPolling();
					this.setConnection({ kind: "open" });
					void this.refreshSnapshot().catch((error) => {
						if (!this.closed) console.warn("[LiveSession] refresh after connect failed", error);
					});
				} else {
					if (this.closed) return;
					this.streamOpen = false;
					this.startPolling();
					this.setConnection({ kind: "loading" });
				}
			},
		);
	}

	private startPolling(): void {
		if (this.closed || this.streamOpen || this.pollTimer) return;
		this.pollTimer = setInterval(() => {
			void this.refreshSnapshot().then(() => {
				if (!this.closed) this.setConnection({ kind: "open" });
			}).catch((error) => {
				if (!this.closed) this.setConnection({
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			});
		}, 1_000);
	}

	private stopPolling(): void {
		if (!this.pollTimer) return;
		clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	private async refreshSnapshot(): Promise<void> {
		if (this.refreshInFlight) return;
		this.refreshInFlight = true;
		try {
			const data = await apiClient.get<{ state: GoalSnapshot }>(`/api/goals/${this.goalId}/state`, {
				fallbackMessage: (status) => `Failed to load goal ${this.goalId}: HTTP ${status}`,
			});
			if (!this.closed) this.applySnapshot(data.state);
		} finally {
			this.refreshInFlight = false;
		}
	}

	private applySnapshot(snapshot: GoalSnapshot): void {
		if (
			this._snapshot &&
			Date.now() < this._optimisticUntil &&
			snapshot.messages.length < this._snapshot.messages.length
		) {
			return;
		}
		if (
			this._snapshot &&
			snapshot.messages.length >= this._snapshot.messages.length
		) {
			this._optimisticUntil = 0;
		}
		this._snapshot = snapshot;
		for (const l of this.snapshotListeners) l(snapshot);
	}

	private setConnection(state: ConnectionState): void {
		this._connection = state;
		for (const l of this.connectionListeners) l(state);
	}
}
