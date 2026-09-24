export const VOICE_CLOUD_STT_PROVIDERS = [
	"openai-whisper",
	"openrouter-stt",
] as const;

export type VoiceCloudSttProvider =
	(typeof VOICE_CLOUD_STT_PROVIDERS)[number];

export interface VoiceSttAttempt {
	provider: string;
	model?: string;
	ok: boolean;
	durationMs: number;
	reason?: string;
}

export type VoiceSttFallbackSkipReason =
	| "disabled"
	| "not-local-primary"
	| "no-audio"
	| "cancelled";

export interface VoiceSttRoutingMeta {
	primaryProvider: string;
	fallback: {
		enabled: boolean;
		eligible: boolean;
		used: boolean;
		provider?: VoiceCloudSttProvider;
		model?: string;
		skipReason?: VoiceSttFallbackSkipReason;
	};
	attempts: VoiceSttAttempt[];
}

export function isVoiceCloudSttProvider(
	value: unknown,
): value is VoiceCloudSttProvider {
	return (
		typeof value === "string" &&
		(VOICE_CLOUD_STT_PROVIDERS as readonly string[]).includes(value)
	);
}
