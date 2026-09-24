import { currentUiLocale } from "@/app/i18n";
import { uiText } from "@/app/ui-text";

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "-";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDate(value: string | number | Date, options: Intl.DateTimeFormatOptions = {}, locale: string = currentUiLocale(), fallback = String(value)): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? fallback : new Intl.DateTimeFormat(locale, options).format(date);
}

export function formatRelativeTime(value: string | number, locale?: string, now = Date.now(), dateAfterDay = false): string {
	const timestamp = typeof value === "number" ? value : Date.parse(value);
	if (!Number.isFinite(timestamp)) return "";
	const delta = Math.max(0, now - timestamp);
	const unit = delta < 60_000 ? "second" : delta < 3_600_000 ? "minute" : delta < 86_400_000 ? "hour" : "day";
	const count = unit === "second" ? 0 : Math.floor(delta / ({ minute: 60_000, hour: 3_600_000, day: 86_400_000 }[unit]));
	if (dateAfterDay && unit === "day") return formatDate(timestamp, { month: "2-digit", day: "2-digit" });
	if (locale) return formatRelativeUnit(count === 0 ? 0 : -count, unit, locale);
	if (unit === "second") return uiText("common.justNow");
	return uiText(unit === "minute" ? "common.countMinAgo" : unit === "hour" ? "common.countHrAgo" : "common.countDaysAgo", { count });
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "--";
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes >= 2) return `${minutes}m+`;
	return `${minutes}m ${Math.round(seconds % 60)}s`;
}

/**
 * A span of work as elapsed time: seconds while it is still short, then whole minutes and hours.
 * An unusable span reads as empty so a caller can drop the label instead of showing a wrong number.
 */
export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return uiText("goalActivity.seconds", { count: seconds });
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return uiText("goalActivity.minutes", { count: minutes });
	const hours = Math.floor(minutes / 60);
	return minutes % 60 === 0
		? uiText("goalActivity.hours", { count: hours })
		: uiText("goalActivity.hoursMinutes", { hours, minutes: minutes % 60 });
}

export function formatClockDuration(seconds: number | undefined, options: { hours?: boolean; padMinutes?: boolean; fallback?: string } = {}): string {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return options.fallback ?? "0:00";
	const total = Math.round(seconds);
	const hours = options.hours ? Math.floor(total / 3600) : 0;
	const minutes = Math.floor((hours ? total % 3600 : total) / 60);
	return `${hours ? `${hours}:` : ""}${String(minutes).padStart(hours || options.padMinutes ? 2 : 1, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function formatElapsedSeconds(ms: number): string {
	return uiText("settings.voicehistorysettings.secondsSec", { seconds: (ms / 1000).toFixed(2) });
}

export function formatWindowDuration(minutes: number): string {
	if (minutes % 10_080 === 0) return uiText("settings.codexaccountsinline.countWeeks", { count: minutes / 10_080 });
	if (minutes % 1_440 === 0) return uiText("common.countDays", { count: minutes / 1_440 });
	if (minutes % 60 === 0) return uiText("settings.codexaccountsinline.countHours", { count: minutes / 60 });
	return uiText("settings.codexaccountsinline.countMinutes", { count: minutes });
}

export function formatRelativeUnit(value: number, unit: Intl.RelativeTimeFormatUnit, locale: string = currentUiLocale()): string {
	return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}
