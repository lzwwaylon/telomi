import type { SendMessageResult } from "@shared/types";
import { uiText } from "@/app/ui-text";

export function resolveComposerSendControls(
	isStreaming: boolean,
	canSend: boolean,
): { showAbort: boolean; showSend: boolean } {
	return {
		showAbort: isStreaming,
		showSend: !isStreaming || canSend,
	};
}

export function resolveVoiceQueueNotice(
	result: SendMessageResult,
	containsVoiceInput: boolean,
): string | null {
	if (!containsVoiceInput || !result.queued) return null;
	const ahead = Math.max(0, result.queuePosition - 1);
	return ahead > 0
		? uiText("voice.queuefeedback.theCurrentTaskIsStillRunningThisVoiceInput", { count: ahead })
		: uiText("voice.queuefeedback.theCurrentTaskIsStillRunningThisVoiceInput.8356fb3");
}
