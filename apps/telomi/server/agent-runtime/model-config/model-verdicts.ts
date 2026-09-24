import { existsSync, readFileSync } from "node:fs";

import { resolveAgentPath } from "../../config/agent-directory.js";
import { writeJsonAtomic } from "../../lib/fs.js";
import { classifyResearchModelFailure, scrubResearchModelError } from "../models/error-classifier.js";

/**
 * The last thing a Provider said about each `connection/model` Telomi used: the rejection from a
 * connection test, a turn, a Worker or an audio, embedding or Memory call, cleared by the next
 * test or call that succeeds on it. The settings entry point reads it so a selected model the
 * Provider refuses is never reported as active, and the inbox reads it to say which capability
 * needs the user. It survives a restart: a model out of credit stays so until someone uses it.
 */
export const MODEL_VERDICTS_FILE = "model-verdicts.json";

export interface ModelRejection {
	error: string;
	at: string;
}

const ERROR_LIMIT = 500;

let cache: { path: string; failures: Map<string, ModelRejection> } | undefined;
let listener: (() => void) | undefined;

function failures(): Map<string, ModelRejection> {
	const path = resolveAgentPath(MODEL_VERDICTS_FILE);
	if (cache?.path !== path) cache = { path, failures: new Map(Object.entries(readVerdicts(path))) };
	return cache.failures;
}

function readVerdicts(path: string): Record<string, ModelRejection> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ModelRejection] =>
			typeof entry[1]?.error === "string" && typeof entry[1]?.at === "string"));
	} catch {
		// A damaged file only forgets rejections; the next call on each model records it again.
		return {};
	}
}

/** Told whenever a model's verdict changes, so the inbox can refresh. */
export function setModelVerdictListener(next: (() => void) | undefined): void {
	listener = next;
}

export function recordModelVerdict(model: string, error: string | undefined): void {
	const map = failures();
	const text = error?.trim() ? scrubResearchModelError(error.trim()).slice(0, ERROR_LIMIT) : undefined;
	if (text === map.get(model)?.error) return;
	if (text) map.set(model, { error: text, at: new Date().toISOString() });
	else if (!map.delete(model)) return;
	writeJsonAtomic(cache!.path, Object.fromEntries(map));
	listener?.();
}

export function modelFailure(model: string): string | undefined {
	return failures().get(model)?.error;
}

export function modelRejection(model: string): ModelRejection | undefined {
	return failures().get(model);
}

/**
 * Whether a rejection needs the user rather than another attempt: the credential, the balance or
 * the model itself was refused. Rate limits, timeouts and outages pass on their own.
 */
export function needsUserAction(error: string): boolean {
	return classifyResearchModelFailure(error) === "permanent"
		|| /\b404\b|model.{0,60}(?:not found|does not exist|not exist|not available|unavailable|not supported)/iu.test(error);
}

/**
 * What a call observed on its own: success clears the model, a rejection that needs the user
 * records it, and a transient failure leaves the earlier verdict alone.
 */
export function observeModelOutcome(model: string, error?: string): void {
	if (error === undefined) recordModelVerdict(model, undefined);
	else if (needsUserAction(error)) recordModelVerdict(model, error);
}

/**
 * The failure text a Worker or Runtime stage reports names its model as `model '<ref>' failed:`
 * (see `assertPrimeModelAnswered`); each one found there is observed as that model's rejection.
 */
export function observeModelFailureText(text: string): void {
	for (const match of text.matchAll(/model '([^'\s]+\/[^'\s]+)' failed: (.+?)(?=\s*model '[^'\s]+' failed: |$)/gsu)) {
		observeModelOutcome(match[1]!, match[2]!);
	}
}
