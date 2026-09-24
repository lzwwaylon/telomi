/**
 * One switch the stream layer made on a caller's behalf. `account` keeps the same model and moves
 * to another signed-in account of the same Provider; `model` moves to the next explicitly
 * configured fallback model. The reason never carries a credential.
 */
export interface ModelSwitch {
	kind: "account" | "model";
	from: string;
	to: string;
	reason: string;
}

/**
 * The `provider/model` that produced the last assistant message. Every request restarts at the
 * primary model, so the last message, not the last switch, names the model that actually served.
 */
export function lastAssistantModel(messages: ReadonlyArray<{ role?: string; provider?: string; model?: string }>, initial: string): string {
	const last = [...messages].reverse().find((message) => message.role === "assistant" && message.provider && message.model);
	return last ? `${last.provider}/${last.model}` : initial;
}
