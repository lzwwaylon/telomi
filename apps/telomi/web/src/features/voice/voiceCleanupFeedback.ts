import type { VoiceCleanupOutcome } from "@shared/voice-cleanup.js";
import { uiText } from "@/app/ui-text";

export const VOICE_CLEANUP_FAILURE_NOTICE =
	"common.aiTextCleanupFailedTheUneditedTranscriptionWasKept";
export const VOICE_CLEANUP_EMPTIED_NOTICE =
	"common.aiTextCleanupRemovedEverythingOnlyFillersWereSpoken";

/** What the user should know about cleanup once the final text is decided; null when nothing needs saying. */
export function voiceCleanupNotice(
	cleanup: VoiceCleanupOutcome,
	text: string,
): string | null {
	if (!cleanup.requested) return null;
	if (!cleanup.applied) return uiText(VOICE_CLEANUP_FAILURE_NOTICE);
	return text.trim() ? null : uiText(VOICE_CLEANUP_EMPTIED_NOTICE);
}
