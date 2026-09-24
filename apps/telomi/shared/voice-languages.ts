export interface VoiceLanguageOption {
	code: string;
	label: string;
	flag: string;
}

export type VoiceLanguagePreference = string;

export const DEFAULT_VOICE_LANGUAGE_PREFERENCE = "auto";

/**
 * OpenWhispr-compatible transcription language registry.
 *
 * The persisted preference keeps the regional variant for display, while the
 * STT Provider receives the base ISO language code. "auto" is represented by
 * omitting the Provider language hint.
 */
export const VOICE_LANGUAGE_OPTIONS: readonly VoiceLanguageOption[] = [
	{ code: "auto", label: "Auto-detect", flag: "🌐" },
	{ code: "af", label: "Afrikaans", flag: "🇿🇦" },
	{ code: "ar", label: "Arabic", flag: "🇸🇦" },
	{ code: "hy", label: "Armenian", flag: "🇦🇲" },
	{ code: "az", label: "Azerbaijani", flag: "🇦🇿" },
	{ code: "be", label: "Belarusian", flag: "🇧🇾" },
	{ code: "bs", label: "Bosnian", flag: "🇧🇦" },
	{ code: "bg", label: "Bulgarian", flag: "🇧🇬" },
	{ code: "ca", label: "Catalan", flag: "🇪🇸" },
	{ code: "zh-CN", label: "Chinese (Simplified)", flag: "🇨🇳" },
	{ code: "zh-TW", label: "Chinese (Traditional)", flag: "🇹🇼" },
	{ code: "hr", label: "Croatian", flag: "🇭🇷" },
	{ code: "cs", label: "Czech", flag: "🇨🇿" },
	{ code: "da", label: "Danish", flag: "🇩🇰" },
	{ code: "nl", label: "Dutch", flag: "🇳🇱" },
	{ code: "en-US", label: "English (US)", flag: "🇺🇸" },
	{ code: "en-GB", label: "English (UK)", flag: "🇬🇧" },
	{ code: "et", label: "Estonian", flag: "🇪🇪" },
	{ code: "fi", label: "Finnish", flag: "🇫🇮" },
	{ code: "fr", label: "French", flag: "🇫🇷" },
	{ code: "gl", label: "Galician", flag: "🇪🇸" },
	{ code: "de", label: "German", flag: "🇩🇪" },
	{ code: "el", label: "Greek", flag: "🇬🇷" },
	{ code: "he", label: "Hebrew", flag: "🇮🇱" },
	{ code: "hi", label: "Hindi", flag: "🇮🇳" },
	{ code: "hu", label: "Hungarian", flag: "🇭🇺" },
	{ code: "is", label: "Icelandic", flag: "🇮🇸" },
	{ code: "id", label: "Indonesian", flag: "🇮🇩" },
	{ code: "it", label: "Italian", flag: "🇮🇹" },
	{ code: "ja", label: "Japanese", flag: "🇯🇵" },
	{ code: "kn", label: "Kannada", flag: "🇮🇳" },
	{ code: "kk", label: "Kazakh", flag: "🇰🇿" },
	{ code: "ko", label: "Korean", flag: "🇰🇷" },
	{ code: "lv", label: "Latvian", flag: "🇱🇻" },
	{ code: "lt", label: "Lithuanian", flag: "🇱🇹" },
	{ code: "mk", label: "Macedonian", flag: "🇲🇰" },
	{ code: "ms", label: "Malay", flag: "🇲🇾" },
	{ code: "mt", label: "Maltese", flag: "🇲🇹" },
	{ code: "mr", label: "Marathi", flag: "🇮🇳" },
	{ code: "mi", label: "Maori", flag: "🇳🇿" },
	{ code: "ne", label: "Nepali", flag: "🇳🇵" },
	{ code: "no", label: "Norwegian", flag: "🇳🇴" },
	{ code: "fa", label: "Persian", flag: "🇮🇷" },
	{ code: "pl", label: "Polish", flag: "🇵🇱" },
	{ code: "pt", label: "Portuguese", flag: "🇵🇹" },
	{ code: "ro", label: "Romanian", flag: "🇷🇴" },
	{ code: "ru", label: "Russian", flag: "🇷🇺" },
	{ code: "sr", label: "Serbian", flag: "🇷🇸" },
	{ code: "sk", label: "Slovak", flag: "🇸🇰" },
	{ code: "sl", label: "Slovenian", flag: "🇸🇮" },
	{ code: "es", label: "Spanish", flag: "🇪🇸" },
	{ code: "sw", label: "Swahili", flag: "🇰🇪" },
	{ code: "sv", label: "Swedish", flag: "🇸🇪" },
	{ code: "tl", label: "Tagalog", flag: "🇵🇭" },
	{ code: "ta", label: "Tamil", flag: "🇮🇳" },
	{ code: "th", label: "Thai", flag: "🇹🇭" },
	{ code: "tr", label: "Turkish", flag: "🇹🇷" },
	{ code: "uk", label: "Ukrainian", flag: "🇺🇦" },
	{ code: "ur", label: "Urdu", flag: "🇵🇰" },
	{ code: "vi", label: "Vietnamese", flag: "🇻🇳" },
	{ code: "cy", label: "Welsh", flag: "🏴󠁧󠁢󠁷󠁬󠁳󠁿" },
];

const VOICE_LANGUAGE_CODES = new Set(
	VOICE_LANGUAGE_OPTIONS.map((option) => option.code),
);

export function isVoiceLanguagePreference(value: unknown): value is string {
	return typeof value === "string" && VOICE_LANGUAGE_CODES.has(value);
}

export function normalizeVoiceLanguagePreference(value: unknown): string {
	return isVoiceLanguagePreference(value)
		? value
		: DEFAULT_VOICE_LANGUAGE_PREFERENCE;
}

export function voiceLanguageHint(
	preference: string | null | undefined,
): string | undefined {
	const normalized = normalizeVoiceLanguagePreference(preference);
	if (normalized === DEFAULT_VOICE_LANGUAGE_PREFERENCE) return undefined;
	return normalized.split("-")[0];
}
