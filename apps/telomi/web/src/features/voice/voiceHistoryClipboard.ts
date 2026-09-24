import { uiText } from "@/app/ui-text";

export interface VoiceHistoryClipboard {
	writeText(text: string): Promise<void>;
}

export async function copyVoiceHistoryText(
	text: string,
	clipboard?: VoiceHistoryClipboard | null,
): Promise<void> {
	if (!text.trim()) {
		throw new Error(uiText("voice.historyclipboard.thereIsNoFinalTranscriptionToCopy"));
	}

	const target =
		clipboard === undefined
			? typeof navigator !== "undefined"
				? navigator.clipboard
				: null
			: clipboard;
	if (!target || typeof target.writeText !== "function") {
		throw new Error(uiText("voice.historyclipboard.thisBrowserDoesNotSupportClipboardWriting"));
	}

	await target.writeText(text);
}
