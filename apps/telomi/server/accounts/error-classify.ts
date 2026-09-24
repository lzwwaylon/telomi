import type { ProviderErrorClass } from "./types.js";

/**
 * Request cancellation is a caller/runtime lifecycle outcome, not evidence
 * that a credential is unhealthy.
 */
export function isRequestCancellation(input: unknown): boolean {
	const message = extractMessage(input).toLowerCase();
	if (!message) return false;
	return (
		message.includes("request was aborted") ||
		message.includes("operation was aborted") ||
		message.includes("aborterror") ||
		message.includes("aborted by the caller") ||
		message.includes("aborted by caller") ||
		message.includes("aborted by the user") ||
		message.includes("cancelled by the caller") ||
		message.includes("cancelled by caller") ||
		message.includes("canceled by the caller") ||
		message.includes("canceled by caller") ||
		message.includes("cancelled by the user") ||
		message.includes("canceled by the user")
	);
}

/**
 * Classify a provider error message string into a fallback policy bucket.
 *
 * pi-ai surfaces errors as plain strings (errorMessage on AssistantMessage)
 * with no structured status code, so we keyword-match. Order matters: auth
 * checks come before quota because some 429 messages also mention "rate".
 */
export function classifyProviderError(input: unknown): ProviderErrorClass {
	const msg = extractMessage(input).toLowerCase();
	if (!msg) return "permanent";

	if (
		msg.includes("401") ||
		msg.includes("unauthor") ||
		msg.includes("invalid api key") ||
		msg.includes("invalid_api_key") ||
		msg.includes("invalid token") ||
		msg.includes("expired token") ||
		msg.includes("expired_token") ||
		msg.includes("token has expired") ||
		msg.includes("invalid_grant") ||
		msg.includes("authentication") ||
		msg.includes("not authenticated") ||
		msg.includes("no api key") ||
		msg.includes("api key not found")
	) {
		return "auth";
	}

	if (msg.includes("403") || msg.includes("forbidden") || msg.includes("permission denied")) {
		return "auth";
	}

	if (
		msg.includes("429") ||
		msg.includes("quota") ||
		msg.includes("rate limit") ||
		msg.includes("rate_limit") ||
		msg.includes("rate-limit") ||
		msg.includes("too many requests") ||
		msg.includes("usage limit") ||
		msg.includes("insufficient_quota") ||
		msg.includes("billing")
	) {
		return "quota";
	}

	if (
		msg.includes("500") ||
		msg.includes("502") ||
		msg.includes("503") ||
		msg.includes("504") ||
		msg.includes("internal server error") ||
		msg.includes("bad gateway") ||
		msg.includes("service unavailable") ||
		msg.includes("gateway timeout") ||
		msg.includes("etimedout") ||
		msg.includes("econnreset") ||
		msg.includes("econnrefused") ||
		msg.includes("enotfound") ||
		msg.includes("websocket") ||
		msg.includes("network") ||
		msg.includes("socket hang up") ||
		msg.includes("fetch failed")
	) {
		return "transient";
	}

	return "permanent";
}

function extractMessage(input: unknown): string {
	if (!input) return "";
	if (typeof input === "string") return input;
	if (input instanceof Error) return `${input.name}: ${input.message}`;
	if (typeof input === "object") {
		const obj = input as Record<string, unknown>;
		if (typeof obj.errorMessage === "string") return obj.errorMessage;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		if (obj.error && typeof obj.error === "object") return extractMessage(obj.error);
	}
	return String(input);
}

/** Cooldown window for accounts that returned a quota error. */
export const QUOTA_COOLDOWN_MS = 5 * 60 * 1000;
