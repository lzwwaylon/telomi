import { toErrorMessage } from "../lib/values.js";
export type ResearchFailureClass = "cancelled" | "timeout" | "rate_limit" | "provider" | "validation" | "budget" | "permanent";

export class ResearchNodeError extends Error {
	readonly retryAfterMs: number | undefined;
	readonly code: string | undefined;
	readonly details: Record<string, unknown> | undefined;

	constructor(
		message: string,
		readonly failureClass: ResearchFailureClass,
		readonly retryable: boolean,
		options?: ErrorOptions & {
			retryAfterMs?: number;
			code?: string;
			details?: Record<string, unknown>;
		},
	) {
		super(message, options);
		this.name = "ResearchNodeError";
		this.retryAfterMs = options?.retryAfterMs;
		this.code = options?.code;
		this.details = options?.details;
	}
}

export interface ResearchRetryDecision {
	retry: boolean;
	delayMs: number;
	failureClass: ResearchFailureClass;
}

export function classifyResearchError(error: unknown): ResearchFailureClass {
	if (error instanceof ResearchNodeError) return error.failureClass;
	const name = error instanceof Error ? error.name : "";
	const message = toErrorMessage(error);
	if (name === "AbortError" || /\babort(?:ed)?\b/i.test(message)) return "cancelled";
	if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "timeout";
	if (/\b429\b|rate.?limit|too many requests/i.test(message)) return "rate_limit";
	if (/budget exceeded/i.test(message)) return "budget";
	if (/schema|validation|parse|invalid json/i.test(message)) return "validation";
	return "provider";
}

export function retryDecision(error: unknown, attempt: number, maxAttempts: number): ResearchRetryDecision {
	const failureClass = classifyResearchError(error);
	const declaredDelay = error instanceof ResearchNodeError ? error.retryAfterMs : undefined;
	const delayMs = declaredDelay ?? Math.min(5_000, 250 * 2 ** Math.max(0, attempt - 1));
	if (attempt >= maxAttempts || failureClass === "cancelled" || failureClass === "budget" || failureClass === "permanent") {
		return { retry: false, delayMs: failureClass === "rate_limit" ? delayMs : 0, failureClass };
	}
	if (error instanceof ResearchNodeError && !error.retryable) return { retry: false, delayMs: 0, failureClass };
	return { retry: true, delayMs, failureClass };
}

export async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
	if (delayMs <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new ResearchNodeError("research retry aborted", "cancelled", false));
		};
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		setTimeout(() => signal.removeEventListener("abort", onAbort), delayMs + 1);
	});
}
