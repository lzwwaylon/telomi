import { randomUUID } from "node:crypto";
import {
	type APIConnectOptions,
	type ChatContext,
	DEFAULT_API_CONNECT_OPTIONS,
	llm,
	type ToolChoice,
	type ToolContextLike,
} from "@livekit/agents";

interface GoalReplyStream {
	streamReply(
		goalId: string,
		transcript: string,
		signal?: AbortSignal,
	): AsyncIterable<string>;
}

export class PiGoalLiveKitLLM extends llm.LLM {
	constructor(
		private readonly goalId: string,
		private readonly goalClient: GoalReplyStream,
	) {
		super();
	}

	label(): string {
		return "pi-goal-agent";
	}

	override get model(): string {
		return "goal-main-agent";
	}

	override get provider(): string {
		return "telomi";
	}

	chat({
		chatCtx,
		toolCtx,
		connOptions = DEFAULT_API_CONNECT_OPTIONS,
	}: {
		chatCtx: ChatContext;
		toolCtx?: ToolContextLike;
		connOptions?: APIConnectOptions;
		parallelToolCalls?: boolean;
		toolChoice?: ToolChoice;
		extraKwargs?: Record<string, unknown>;
	}): llm.LLMStream {
		return new PiGoalLiveKitLLMStream(this, this.goalId, this.goalClient, {
			chatCtx,
			toolCtx,
			connOptions,
		});
	}
}

class PiGoalLiveKitLLMStream extends llm.LLMStream {
	private readonly responseId = `pi-goal-${randomUUID()}`;

	constructor(
		adapter: PiGoalLiveKitLLM,
		private readonly goalId: string,
		private readonly goalClient: GoalReplyStream,
		options: {
			chatCtx: ChatContext;
			toolCtx?: ToolContextLike;
			connOptions: APIConnectOptions;
		},
	) {
		super(adapter, options);
	}

	protected async run(): Promise<void> {
		const transcript = latestUserText(this.chatCtx);
		if (!transcript) {
			throw new Error("Pi Goal Agent received no user transcript");
		}

		try {
			for await (const delta of this.goalClient.streamReply(
				this.goalId,
				transcript,
				this.abortController.signal,
			)) {
				if (this.abortController.signal.aborted) return;
				this.queue.put({
					id: this.responseId,
					delta: {
						role: "assistant",
						content: delta,
					},
				});
			}
		} catch (error) {
			if (
				this.abortController.signal.aborted ||
				(error instanceof Error && error.name === "AbortError")
			) {
				return;
			}
			throw error;
		}
	}
}

function latestUserText(chatCtx: ChatContext): string {
	for (let index = chatCtx.items.length - 1; index >= 0; index -= 1) {
		const item = chatCtx.items[index];
		if (item?.type === "message" && item.role === "user") {
			return item.textContent?.trim() || "";
		}
	}
	return "";
}
