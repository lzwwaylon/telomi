import { chrome, type ActivityMessage } from "./events/activity-text.js";

/** A model Provider's HTTP error, as far as its error text states it. */
export interface ProviderHttpError {
	status: number;
	/** The Provider's own explanation; absent when the response carried none. */
	message?: string;
}

const MESSAGE_LIMIT = 300;

/**
 * Read a Provider HTTP error out of the error text pi-ai records on a failed model call, whether
 * shown alone or quoted after a Runtime prefix such as `Search Root model call failed: `. pi-ai
 * writes `402: {"message":"Insufficient Balance",...}` when it has the response body and
 * `402 Insufficient Balance` when the SDK already folded the body into its message. Other text
 * returns undefined, so callers keep showing it as it is.
 */
export function parseProviderHttpError(text: string): ProviderHttpError | undefined {
	const match = /(?:^|:\s)([45]\d{2})(?::\s|\s)(.*)$/su.exec(text.trim());
	if (!match) return undefined;
	const status = Number(match[1]);
	const rest = match[2]!.trim();
	const message = rest.startsWith("{") ? bodyMessage(rest) : rest === "status code (no body)" ? undefined : rest;
	const clipped = message?.trim().replace(/\s+/gu, " ");
	return {
		status,
		...(clipped ? { message: clipped.length > MESSAGE_LIMIT ? `${clipped.slice(0, MESSAGE_LIMIT)}…` : clipped } : {}),
	};
}

/**
 * A model Provider's HTTP error as fixed chrome: its status and the Provider's own explanation,
 * never the raw response body. Undefined for any other text. Activity projections and chat both
 * render it, so one error reads the same on every surface.
 */
export function providerErrorMessage(text: string): ActivityMessage[] | undefined {
	const error = parseProviderHttpError(text);
	if (!error) return undefined;
	return error.message
		? chrome("activityChrome.providerError.withMessage", { status: error.status, message: error.message })
		: chrome("activityChrome.providerError.statusOnly", { status: error.status });
}

/** The explanation inside a JSON error body; the body itself is never shown. */
function bodyMessage(body: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.split("\n")[0]!);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const record = parsed as Record<string, unknown>;
	const nested = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>).message : undefined;
	for (const value of [nested, record.message, record.error, record.detail]) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}
