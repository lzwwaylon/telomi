import type { GoalEventEnvelope } from "../../shared/types.js";
import type { GoalService } from "../goals/service.js";

export interface GoalAgentVoiceRequest {
	goalId: string;
	transcript: string;
	signal?: AbortSignal;
}

interface GoalVoiceConnection {
	submit(transcript: string): Promise<void>;
	subscribe(listener: (event: GoalEventEnvelope) => void): () => void;
}

export interface GoalAgentVoiceHost {
	open(goalId: string): Promise<GoalVoiceConnection>;
}

export function createGoalAgentVoiceHost(goals: GoalService): GoalAgentVoiceHost {
	return {
		async open(goalId) {
			const goal = goals.getGoal(goalId);
			if (!goal) throw new Error(`Unknown goal: ${goalId}`);
			const runner = await goals.getRunner(goal);
			return {
				submit: async (transcript) => {
					await goals.startInteractiveRun(goalId, transcript, "voice");
				},
				subscribe: (listener) => runner.subscribe(listener),
			};
		},
	};
}

export async function* streamGoalAgentReply(
	host: GoalAgentVoiceHost,
	request: GoalAgentVoiceRequest,
): AsyncIterable<string> {
	const connection = await host.open(request.goalId);
	const events: GoalEventEnvelope[] = [];
	let wake: (() => void) | undefined;
	const unsubscribe = connection.subscribe((event) => {
		events.push(event);
		wake?.();
		wake = undefined;
	});

	try {
		await connection.submit(request.transcript);
		let accepted = false;
		let assistantText = "";
		let hasAssistantText = false;
		let visibleMessageCountBeforeReply = 0;

		while (!request.signal?.aborted) {
			const envelope = events.shift();
			if (!envelope) {
				await waitForEvent(request.signal, (resolve) => {
					wake = resolve;
				});
				continue;
			}

			const event = envelope.event as {
				type?: string;
				message?: unknown;
			} | undefined;
			if (accepted) {
				const visibleText = latestAssistantText(
					envelope.state.messages.slice(visibleMessageCountBeforeReply),
				);
				const visibleDelta = textDelta(assistantText, visibleText);
				if (visibleDelta) {
					assistantText = visibleText;
					hasAssistantText = true;
					yield visibleDelta;
				}
				if (!envelope.state.isStreaming) return;
			}
			if (!event?.type) {
				if (
					accepted &&
					!envelope.state.isStreaming &&
					envelope.state.errorMessage
				) {
					throw new Error(envelope.state.errorMessage);
				}
				continue;
			}

			if (
				(event.type === "message_start" || event.type === "message_end") &&
				messageRole(event.message) === "user" &&
				messageText(event.message).trim() === request.transcript
			) {
				accepted = true;
				visibleMessageCountBeforeReply = envelope.state.messages.length;
				continue;
			}
			if (!accepted) continue;

			if (event.type === "message_start" && messageRole(event.message) === "assistant") {
				assistantText = "";
				continue;
			}
			if (
				(event.type === "message_update" || event.type === "message_end") &&
				messageRole(event.message) === "assistant"
			) {
				const nextText = messageText(event.message);
				const delta = textDelta(assistantText, nextText);
				const prefix = !assistantText && hasAssistantText && delta ? "\n\n" : "";
				assistantText = nextText;
				if (delta) {
					hasAssistantText = true;
					yield prefix + delta;
				}
				continue;
			}
			if (event.type === "agent_end" && !envelope.state.isStreaming) return;
		}
	} finally {
		unsubscribe();
	}
}

function messageRole(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const role = (message as { role?: unknown }).role;
	return typeof role === "string" ? role : "";
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function latestAssistantText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (messageRole(message) !== "assistant") continue;
		const text = messageText(message).trim();
		if (text) return text;
	}
	return "";
}

function textDelta(previous: string, next: string): string {
	if (!next) return "";
	return next.startsWith(previous) ? next.slice(previous.length) : next;
}

async function waitForEvent(
	signal: AbortSignal | undefined,
	setWake: (resolve: () => void) => void,
): Promise<void> {
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const done = () => {
			signal?.removeEventListener("abort", done);
			resolve();
		};
		setWake(done);
		signal?.addEventListener("abort", done, { once: true });
	});
}
