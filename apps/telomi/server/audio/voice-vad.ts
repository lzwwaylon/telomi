/**
 * Provider-neutral local VAD contract.
 *
 * Defaults and bounds are pinned to OpenWhispr's whisperVad contract. The
 * Provider adapter owns snake_case transport mapping; Runtime and settings
 * code use this stable camelCase shape.
 */
export interface VoiceVadParameters {
	threshold: number;
	minSpeechDurationMs: number;
	minSilenceDurationMs: number;
	maxSpeechDurationS: number;
	speechPadMs: number;
	samplesOverlap: number;
}

export interface VoiceVadConfig extends VoiceVadParameters {
	enabled: boolean;
}

export interface VoiceVadMetadata {
	provider: string;
	version: string;
	enabled: boolean;
	applied: boolean;
	failOpen: boolean;
	reason: string | null;
	speechDetected: boolean | null;
	speechRatio: number | null;
	originalDurationSec: number | null;
	processedDurationSec: number | null;
	segmentCount: number;
	config: VoiceVadParameters;
}

export const DEFAULT_VOICE_VAD_CONFIG: Readonly<VoiceVadConfig> = Object.freeze({
	enabled: false,
	threshold: 0.5,
	minSpeechDurationMs: 250,
	minSilenceDurationMs: 200,
	maxSpeechDurationS: 30,
	speechPadMs: 100,
	samplesOverlap: 0.5,
});

const LIMITS = {
	threshold: [0.1, 0.95, false],
	minSpeechDurationMs: [50, 2_000, true],
	minSilenceDurationMs: [50, 2_000, true],
	maxSpeechDurationS: [5, 120, true],
	speechPadMs: [0, 1_000, true],
	samplesOverlap: [0, 0.95, false],
} as const satisfies Record<keyof VoiceVadParameters, readonly [number, number, boolean]>;

export function normalizeVoiceVadConfig(value: unknown): VoiceVadConfig {
	const record = asRecord(value);
	return {
		enabled: typeof record.enabled === "boolean"
			? record.enabled
			: DEFAULT_VOICE_VAD_CONFIG.enabled,
		...normalizeVoiceVadParameters(record),
	};
}

export function normalizeVoiceVadParameters(value: unknown): VoiceVadParameters {
	const record = asRecord(value);
	return {
		threshold: boundedNumber(record.threshold, "threshold"),
		minSpeechDurationMs: boundedNumber(record.minSpeechDurationMs, "minSpeechDurationMs"),
		minSilenceDurationMs: boundedNumber(record.minSilenceDurationMs, "minSilenceDurationMs"),
		maxSpeechDurationS: boundedNumber(record.maxSpeechDurationS, "maxSpeechDurationS"),
		speechPadMs: boundedNumber(record.speechPadMs, "speechPadMs"),
		samplesOverlap: boundedNumber(record.samplesOverlap, "samplesOverlap"),
	};
}

export function isNormalizedVoiceVadConfig(value: unknown): value is VoiceVadConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const normalized = normalizeVoiceVadConfig(value);
	const record = value as Record<string, unknown>;
	const normalizedKeys = Object.keys(normalized) as Array<keyof VoiceVadConfig>;
	return Object.keys(record).length === normalizedKeys.length && normalizedKeys.every(
		(key) => record[key] === normalized[key],
	);
}

export function normalizeVoiceVadMetadata(value: unknown): VoiceVadMetadata | undefined {
	const record = asRecord(value);
	if (!cleanString(record.provider) || !cleanString(record.version)) return undefined;
	const rawConfig = asRecord(record.config);
	const config = normalizeVoiceVadParameters({
		threshold: rawConfig.threshold,
		minSpeechDurationMs: rawConfig.min_speech_duration_ms,
		minSilenceDurationMs: rawConfig.min_silence_duration_ms,
		maxSpeechDurationS: rawConfig.max_speech_duration_s,
		speechPadMs: rawConfig.speech_pad_ms,
		samplesOverlap: rawConfig.samples_overlap,
	});
	return {
		provider: cleanString(record.provider)!,
		version: cleanString(record.version)!,
		enabled: record.enabled === true,
		applied: record.applied === true,
		failOpen: record.fail_open === true,
		reason: cleanString(record.reason) ?? null,
		speechDetected: typeof record.speech_detected === "boolean"
			? record.speech_detected
			: null,
		speechRatio: optionalFiniteNumber(record.speech_ratio),
		originalDurationSec: optionalFiniteNumber(record.original_duration_sec),
		processedDurationSec: optionalFiniteNumber(record.processed_duration_sec),
		segmentCount: Math.max(0, Math.round(optionalFiniteNumber(record.segment_count) ?? 0)),
		config,
	};
}

function boundedNumber(
	value: unknown,
	key: keyof VoiceVadParameters,
): number {
	const fallback = DEFAULT_VOICE_VAD_CONFIG[key];
	const numeric = value === null || value === undefined || value === ""
		? fallback
		: Number(value);
	const finite = Number.isFinite(numeric) ? numeric : fallback;
	const [minimum, maximum, shouldRound] = LIMITS[key];
	const clamped = Math.min(maximum, Math.max(minimum, finite));
	return shouldRound ? Math.round(clamped) : clamped;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
