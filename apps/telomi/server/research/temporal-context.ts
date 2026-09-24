import type { ResearchTemporalContext } from "./research-types.js";
import type { ScheduledResearchContext } from "./scheduled-research-context.js";

const YEAR_TO_DATE_PATTERNS = [
	/(?:从|自)?(?:今年|本年)?年初(?:起)?(?:至|到)(?:现在|今天|今日|目前|今)/u,
	/(?:今年|本年)(?:从)?(?:一月一日|1月1日|年初)(?:起)?(?:至|到)(?:现在|今天|今日|目前|今)/u,
	/\b(?:year[- ]to[- ]date|ytd)\b/iu,
	/\b(?:since|from) (?:the )?(?:start|beginning) of (?:the )?(?:current )?year(?: (?:to|through|until) (?:now|today|the present|present))?\b/iu,
];

/**
 * Resolve only unambiguous relative time expressions. The Runtime owns this
 * normalization so every Agent and Provider receives the same immutable
 * calendar boundary instead of independently guessing what "this year" means.
 */
export function resolveResearchTemporalContext(
	question: string,
	now = new Date(),
	timeZone = resolvedTimeZone(),
): ResearchTemporalContext {
	const currentDate = dateInTimeZone(now, timeZone);
	const currentYear = currentDate.slice(0, 4);
	const matchedPattern = YEAR_TO_DATE_PATTERNS.find((pattern) => pattern.test(question));
	return {
		schemaVersion: 1,
		currentDate,
		timeZone,
		...(matchedPattern ? {
			resolvedRange: {
				kind: "year_to_date" as const,
				startDate: `${currentYear}-01-01`,
				endDate: currentDate,
				inclusive: true,
				sourceText: matchedText(question, matchedPattern),
			},
		} : {}),
	};
}

export function resolveScheduledResearchTemporalContext(
	context: ScheduledResearchContext,
): ResearchTemporalContext {
	const start = requireInstant(context.window.startAt, "Scheduled Research window start");
	const end = requireInstant(context.window.endAt, "Scheduled Research window end");
	if (end.getTime() <= start.getTime()) {
		throw new Error("Scheduled Research window end must be after its start");
	}
	const timeZone = context.window.timeZone.trim();
	if (!timeZone) throw new Error("Scheduled Research requires a time zone");
	return {
		schemaVersion: 1,
		currentDate: dateInTimeZone(end, timeZone),
		timeZone,
		resolvedRange: {
			kind: "scheduled_interval",
			startDate: dateInTimeZone(start, timeZone),
			endDate: dateInTimeZone(end, timeZone),
			inclusive: true,
			sourceText: `Scheduled interval ${context.window.startAt} to ${context.window.endAt}`,
			startAt: start.toISOString(),
			endAt: end.toISOString(),
		},
	};
}

function dateInTimeZone(date: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const values = new Map(parts.map((part) => [part.type, part.value]));
	const year = values.get("year");
	const month = values.get("month");
	const day = values.get("day");
	if (!year || !month || !day) throw new Error(`Unable to resolve current date in timezone '${timeZone}'`);
	return `${year}-${month}-${day}`;
}

function resolvedTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function matchedText(question: string, pattern: RegExp): string {
	return question.match(pattern)?.[0]?.trim() || "year-to-date";
}

function requireInstant(value: string, label: string): Date {
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
	return parsed;
}
