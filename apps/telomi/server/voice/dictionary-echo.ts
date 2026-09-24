import type {
	ProviderResult,
	TranscriptResult,
} from "../audio/types.js";

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Detects the Whisper failure mode where an initial prompt is emitted as if
 * it were spoken audio. The thresholds match OpenWhispr's MIT-licensed
 * dictionaryEchoFilter:
 * https://github.com/OpenWhispr/openwhispr/blob/e1cb8301d898881e28372e61ba15a8fd57f4f25b/src/utils/dictionaryEchoFilter.js
 */
export function matchesDictionaryPrompt(
	text: string | null | undefined,
	dictionaryPrompt: string | null | undefined,
): boolean {
	if (!text || !dictionaryPrompt) return false;

	const normalizedText = normalize(text);
	const normalizedPrompt = normalize(dictionaryPrompt);
	if (normalizedText === normalizedPrompt) return true;

	const dictionaryWords = new Set(normalizedPrompt.split(" "));
	const uniqueTextWords = new Set(normalizedText.split(" "));
	let matchCount = 0;
	for (const word of uniqueTextWords) {
		if (dictionaryWords.has(word)) matchCount += 1;
	}

	const textComposition = matchCount / uniqueTextWords.size;
	const dictionaryUsage = matchCount / dictionaryWords.size;
	return textComposition >= 0.9 && dictionaryUsage >= 0.7;
}

export function rejectDictionaryEcho(
	result: ProviderResult<TranscriptResult>,
	dictionaryPrompt: string | undefined,
): ProviderResult<TranscriptResult> {
	if (
		!result.ok ||
		!matchesDictionaryPrompt(result.text, dictionaryPrompt)
	) {
		return result;
	}
	return {
		ok: false,
		provider: result.provider,
		reason: "No audio detected",
	};
}
