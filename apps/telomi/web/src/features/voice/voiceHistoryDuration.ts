import { formatClockDuration } from "@/shared/lib/format";

export function formatVoiceHistoryDuration(durationSec: number | undefined): string | null {
	return formatClockDuration(durationSec, { padMinutes: true, fallback: "" }) || null;
}
