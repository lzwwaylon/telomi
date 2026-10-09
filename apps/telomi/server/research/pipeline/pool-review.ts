import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { resolveAgentPath } from "../../config/agent-directory.js";
import { isRecord } from "../../lib/values.js";

/**
 * One screen window: a Provider child hands Runtime a page of discovery pool records rendered as text,
 * and a fresh model context answers keep or no for each against the task Root wrote for that child.
 * The screen keeps by default: it removes only what the shown text shows to be off the task's subject
 * or under an exclusion the task states. It does not rank, select or judge standing. Machine exclusions
 * never reach a window.
 */
export const NO_REASONS = ["off_subject", "excluded_by_task"] as const;
export type NoReason = (typeof NO_REASONS)[number];
export const MAX_WINDOW_RECORDS = 20;
export const MAX_RECORD_TEXT_CHARACTERS = 4_000;
/** The task is shown whole up to this size; Root's child tasks are a few thousand characters. */
const MAX_TASK_CHARACTERS = 8_000;

export interface ReviewRecord { id: string; text: string }

export interface WindowVerdict { id: string; verdict: "keep" | "no"; reason?: NoReason }

export function parseReviewRecords(value: unknown): ReviewRecord[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WINDOW_RECORDS) throw new Error(`records must hold 1 to ${MAX_WINDOW_RECORDS} entries`);
	const ids = new Set<string>();
	return value.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.text !== "string" || !entry.text.trim()) throw new Error(`records[${index}] needs id and text`);
		if (entry.text.length > MAX_RECORD_TEXT_CHARACTERS) throw new Error(`records[${index}].text exceeds ${MAX_RECORD_TEXT_CHARACTERS} characters`);
		if (ids.has(entry.id)) throw new Error(`records[${index}].id repeats '${entry.id}'`);
		ids.add(entry.id);
		return { id: entry.id, text: entry.text };
	});
}

export function buildWindowPrompt(task: string, records: readonly ReviewRecord[]): { systemPrompt: string; user: string } {
	const systemPrompt = [
		"You screen discovery records for a research acquisition task. The Provider's own category or search already found them; you only remove the ones that plainly do not belong. A later stage reads what is kept.",
		"Judge each record only from the text shown for it; do not use what you believe you know about a name.",
		"keep is the default: answer keep for every record that is, or may be, about the subject of the task.",
		"no is the exception, with exactly one reason:",
		"- off_subject: the shown text shows the record is not about the subject of the task.",
		"- excluded_by_task: the shown text shows the record falls under an exclusion the task states in its own words.",
		"Do not judge the standing, popularity, size or quality of a publisher, author or project. A short or missing description is not a reason for no. Objects the task lists as leads or examples do not narrow its subject.",
		'Answer with JSON only: {"verdicts":[{"id":"<id>","verdict":"keep"},{"id":"<id>","verdict":"no","reason":"off_subject"}]} with exactly one entry per record.',
	].join("\n");
	const user = [`Task:\n${task.trim().slice(0, MAX_TASK_CHARACTERS)}`, "", "Records:", ...records.map((record, index) =>
		`[${index + 1}] id: ${record.id}\n${record.text.trim()}`)].join("\n\n");
	return { systemPrompt, user };
}

export interface ParsedVerdicts { verdicts: WindowVerdict[]; invalid: Map<string, string> }

/**
 * Validation is per record: a verdict that fails invalidates only its own record, and the valid verdicts
 * of the same answer stand. An entry naming a record that was not shown is ignored.
 */
export function parseWindowVerdicts(records: readonly ReviewRecord[], raw: string): ParsedVerdicts {
	const verdicts: WindowVerdict[] = [];
	const invalid = new Map<string, string>();
	const text = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { parsed = undefined; }
	if (!isRecord(parsed) || !Array.isArray(parsed.verdicts)) {
		for (const record of records) invalid.set(record.id, "the answer was not JSON of the form {\"verdicts\": [...]}");
		return { verdicts, invalid };
	}
	const shown = new Set(records.map((record) => record.id));
	const seen = new Set<string>();
	for (const entry of parsed.verdicts) {
		if (!isRecord(entry) || typeof entry.id !== "string" || !shown.has(entry.id) || seen.has(entry.id)) continue;
		seen.add(entry.id);
		if (entry.verdict === "keep") verdicts.push({ id: entry.id, verdict: "keep" });
		else if (entry.verdict !== "no") invalid.set(entry.id, `unknown verdict '${String(entry.verdict)}'; answer keep or no`);
		else if (!(NO_REASONS as readonly unknown[]).includes(entry.reason)) invalid.set(entry.id, `no needs reason ${NO_REASONS.join(" or ")}`);
		else verdicts.push({ id: entry.id, verdict: "no", reason: entry.reason as NoReason });
	}
	for (const record of records) if (!seen.has(record.id)) invalid.set(record.id, "it has no verdict");
	return { verdicts, invalid };
}

export interface WindowReview {
	verdicts: WindowVerdict[];
	attempts: number;
	raw: string[];
	/** Records whose first verdict failed validation, with the reason. */
	invalid: Record<string, string>;
	/** Records still without a valid verdict after the correction round; they are kept, as the default says. */
	unresolved: string[];
}
/** Tokens and provider-reported cost of the model calls one window took, so the screen's cost is counted rather than estimated. */
export interface ReviewUsage { input: number; output: number; cost: number }
export type WindowReviewer = (input: { task: string; records: ReviewRecord[]; signal?: AbortSignal }) => Promise<WindowReview & { model: string; usage?: ReviewUsage }>;

/** One answer, then one correction round that shows only the records whose verdict was rejected. */
export async function reviewWindowWith(
	complete: (systemPrompt: string, content: string) => Promise<string>,
	input: { task: string; records: readonly ReviewRecord[] },
): Promise<WindowReview> {
	const { systemPrompt, user } = buildWindowPrompt(input.task, input.records);
	const raw = [await complete(systemPrompt, user)];
	const first = parseWindowVerdicts(input.records, raw[0]!);
	const decided = new Map(first.verdicts.map((verdict) => [verdict.id, verdict]));
	let unresolved = [...first.invalid.keys()];
	if (unresolved.length) {
		const retry = input.records.filter((record) => first.invalid.has(record.id));
		const again = buildWindowPrompt(input.task, retry);
		raw.push(await complete(again.systemPrompt, `${again.user}\n\nYour previous verdicts for these records were rejected:\n- ${
			[...first.invalid].map(([id, problem]) => `'${id}': ${problem}`).join("\n- ")}\nAnswer again with JSON only, one verdict per record shown here.`));
		const second = parseWindowVerdicts(retry, raw[1]!);
		for (const verdict of second.verdicts) decided.set(verdict.id, verdict);
		unresolved = [...second.invalid.keys()];
	}
	return {
		verdicts: input.records.map((record) => decided.get(record.id) ?? { id: record.id, verdict: "keep" as const }),
		attempts: raw.length, raw, invalid: Object.fromEntries(first.invalid), unresolved,
	};
}

/** Ask the given `provider/model` for a window's verdicts in a fresh context. */
export function modelWindowReviewer(model: string): WindowReviewer {
	return async ({ task, records, signal }) => {
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) throw new Error("review model must be provider/model");
		const runtime = await ModelRuntime.create({ authPath: resolveAgentPath("auth.json"), modelsPath: resolveAgentPath("models.json") });
		const resolved = runtime.getModel(model.slice(0, slash), model.slice(slash + 1));
		if (!resolved) throw new Error(`unknown review model: ${model}`);
		const usage: ReviewUsage = { input: 0, output: 0, cost: 0 };
		const complete = async (systemPrompt: string, content: string) => {
			const message = await runtime.completeSimple(resolved, { systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] }, { signal });
			usage.input += message.usage?.input ?? 0;
			usage.output += message.usage?.output ?? 0;
			usage.cost += message.usage?.cost?.total ?? 0;
			return contentText(message.content);
		};
		return { ...await reviewWindowWith(complete, { task, records }), model, usage };
	};
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string }>).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}
