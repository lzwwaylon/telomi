import { formatRelativeUnit, formatDate } from "@/shared/lib/format";
import i18n, { currentUiLocale } from "@/app/i18n";

export interface VoiceHistoryDateGroupOptions {
	now?: Date;
	locale?: string;
}

export interface VoiceHistoryDatedEntry {
	createdAt: string;
}

export interface VoiceHistoryDateGroup<T extends VoiceHistoryDatedEntry> {
	key: string;
	label: string;
	entries: T[];
}

function localCalendarKey(date: Date): string {
	return [
		String(date.getFullYear()).padStart(4, "0"),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

function resolveDateGroup(
	value: string,
	options: VoiceHistoryDateGroupOptions,
): { key: string; label: string } {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return { key: "unknown", label: i18n.t("common.unknownDate", { lng: options.locale ?? currentUiLocale() }) };
	}

	const now = options.now ?? new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);
	const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

	if (target.getTime() === today.getTime()) {
		return { key: localCalendarKey(target), label: formatRelativeUnit(0, "day", options.locale ?? currentUiLocale()) };
	}
	if (target.getTime() === yesterday.getTime()) {
		return { key: localCalendarKey(target), label: formatRelativeUnit(-1, "day", options.locale ?? currentUiLocale()) };
	}
	return {
		key: localCalendarKey(target),
		label: formatDate(date, {
			year: "numeric",
			month: "long",
			day: "numeric",
		}, options.locale ?? currentUiLocale()),
	};
}

export function groupVoiceHistoryEntries<T extends VoiceHistoryDatedEntry>(
	entries: readonly T[],
	options: VoiceHistoryDateGroupOptions = {},
): Array<VoiceHistoryDateGroup<T>> {
	const now = options.now ?? new Date();
	const groups: Array<VoiceHistoryDateGroup<T>> = [];

	for (const entry of entries) {
		const group = resolveDateGroup(entry.createdAt, { ...options, now });
		const previous = groups.at(-1);
		if (previous?.key === group.key) {
			previous.entries.push(entry);
		} else {
			groups.push({ ...group, entries: [entry] });
		}
	}

	return groups;
}
