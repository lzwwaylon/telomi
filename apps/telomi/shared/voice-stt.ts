import { isVoiceContextSnapshotId } from "./voice-context.js";

export const VOICE_STREAM_PROTOCOL_VERSION = 2;
export const VOICE_STREAM_TARGET_SAMPLE_RATE = 24_000;
export const VOICE_STREAM_MAX_GLOSSARY_ENTRIES = 2_000;
export const VOICE_STREAM_MAX_TERM_LENGTH = 120;

export type VoiceTranscriptSource = "streaming_preview" | "batch_final";
export type VoiceTranscriptKind = "partial" | "provider_final" | "canonical_final";

export interface VoiceTranscriptRevision {
	utteranceId: string;
	revision: number;
	kind: VoiceTranscriptKind;
	source: VoiceTranscriptSource;
	text: string;
	provider: string;
	model?: string;
	receivedAt: string;
}

export interface VoiceGlossaryEntry {
	id: string;
	canonical: string;
	language?: string;
	enabled: boolean;
	source?: "manual" | "learned" | "imported";
}

export interface VoiceGlossarySnapshot {
	revision: string;
	updatedAt: string | null;
	entries: VoiceGlossaryEntry[];
}

export type VoiceStreamClientMessage =
	| {
			type: "start";
			protocolVersion: typeof VOICE_STREAM_PROTOCOL_VERSION;
			sessionId: string;
			utteranceId: string;
			sampleRate: number;
			contextSnapshotId?: string;
			language?: string;
			delay?: "minimal" | "low" | "medium" | "high" | "xhigh";
	  }
	| { type: "finish"; sessionId: string; utteranceId: string }
	| { type: "cancel"; sessionId: string; utteranceId: string };

export interface VoiceSessionEventEnvelope {
	sessionId: string;
	sequence: number;
	occurredAt: string;
	causationId: string;
}

export type VoiceStreamServerPayload =
	| {
			type: "preparing";
			utteranceId: string;
			provider: string;
			model: string;
			stage: "model_warmup" | "provider_connection";
			message: string;
	  }
	| {
			type: "ready";
			utteranceId: string;
			provider: string;
			model: string;
			targetSampleRate: number;
			contextSnapshotId: string;
			readiness?: {
				readyBeforeRequest?: boolean;
				warmupDurationMs?: number;
				requestDurationMs?: number;
			};
	  }
	| {
			type: "partial";
			utteranceId: string;
			revision: number;
			text: string;
			provider: string;
			model: string;
	  }
	| {
			type: "provider_final";
			utteranceId: string;
			revision: number;
			text: string;
			provider: string;
			model: string;
	  }
	| {
			type: "finished";
			utteranceId: string;
			text: string;
			provider: string;
			model: string;
	  }
	| {
			type: "unavailable";
			utteranceId?: string;
			code: string;
			message: string;
			recoverable: true;
	  }
	| {
			type: "error";
			utteranceId?: string;
			code: string;
			message: string;
			recoverable: boolean;
	  };

export type VoiceStreamServerMessage =
	VoiceSessionEventEnvelope & VoiceStreamServerPayload;

export function parseVoiceStreamClientMessage(value: unknown): VoiceStreamClientMessage | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const message = value as Record<string, unknown>;
	if (message.type === "start") {
		if (
			message.protocolVersion !== VOICE_STREAM_PROTOCOL_VERSION ||
			typeof message.sessionId !== "string" ||
			!isValidVoiceEntityId(message.sessionId) ||
			typeof message.utteranceId !== "string" ||
			!isValidVoiceEntityId(message.utteranceId) ||
			typeof message.sampleRate !== "number" ||
			!Number.isInteger(message.sampleRate) ||
			message.sampleRate < 8_000 ||
			message.sampleRate > 96_000
		) {
			return null;
		}
		if (message.language !== undefined && !isLanguageHint(message.language)) return null;
		if (
			message.contextSnapshotId !== undefined &&
			!isVoiceContextSnapshotId(message.contextSnapshotId)
		) {
			return null;
		}
		if (
			message.delay !== undefined &&
			!["minimal", "low", "medium", "high", "xhigh"].includes(String(message.delay))
		) {
			return null;
		}
		return {
			type: "start",
			protocolVersion: VOICE_STREAM_PROTOCOL_VERSION,
			sessionId: message.sessionId,
			utteranceId: message.utteranceId,
			sampleRate: message.sampleRate,
			...(typeof message.contextSnapshotId === "string"
				? { contextSnapshotId: message.contextSnapshotId }
				: {}),
			...(typeof message.language === "string" ? { language: message.language } : {}),
			...(typeof message.delay === "string"
				? { delay: message.delay as "minimal" | "low" | "medium" | "high" | "xhigh" }
				: {}),
		};
	}
	if (message.type === "finish" || message.type === "cancel") {
		if (
			typeof message.sessionId !== "string" ||
			!isValidVoiceEntityId(message.sessionId) ||
			typeof message.utteranceId !== "string" ||
			!isValidVoiceEntityId(message.utteranceId)
		) return null;
		return {
			type: message.type,
			sessionId: message.sessionId,
			utteranceId: message.utteranceId,
		};
	}
	return null;
}

export function parseVoiceStreamServerMessage(
	value: unknown,
): VoiceStreamServerMessage | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const message = value as Record<string, unknown>;
	if (
		typeof message.sessionId !== "string" ||
		!isValidVoiceEntityId(message.sessionId) ||
		!Number.isSafeInteger(message.sequence) ||
		Number(message.sequence) < 1 ||
		typeof message.occurredAt !== "string" ||
		!isCanonicalIsoDate(message.occurredAt) ||
		typeof message.causationId !== "string" ||
		!isValidVoiceEntityId(message.causationId)
	) {
		return null;
	}
	if (
		message.utteranceId !== undefined &&
		(typeof message.utteranceId !== "string" ||
			!isValidVoiceEntityId(message.utteranceId))
	) {
		return null;
	}

	switch (message.type) {
		case "preparing":
			if (
				!hasUtteranceId(message) ||
				!isBoundedString(message.provider, 256) ||
				!isBoundedString(message.model, 256) ||
				!["model_warmup", "provider_connection"].includes(
					String(message.stage),
				) ||
				!isBoundedString(message.message, 4_096)
			) return null;
			break;
		case "ready":
			if (
				!hasUtteranceId(message) ||
				!isBoundedString(message.provider, 256) ||
				!isBoundedString(message.model, 256) ||
				!Number.isInteger(message.targetSampleRate) ||
				Number(message.targetSampleRate) < 8_000 ||
				Number(message.targetSampleRate) > 96_000 ||
				typeof message.contextSnapshotId !== "string" ||
				!isVoiceContextSnapshotId(message.contextSnapshotId) ||
				!isReadiness(message.readiness)
			) return null;
			break;
		case "partial":
		case "provider_final":
			if (
				!hasUtteranceId(message) ||
				!Number.isSafeInteger(message.revision) ||
				Number(message.revision) < 1 ||
				!isBoundedString(message.text, 1_000_000, true) ||
				!isBoundedString(message.provider, 256) ||
				!isBoundedString(message.model, 256)
			) return null;
			break;
		case "finished":
			if (
				!hasUtteranceId(message) ||
				!isBoundedString(message.text, 1_000_000, true) ||
				!isBoundedString(message.provider, 256) ||
				!isBoundedString(message.model, 256)
			) return null;
			break;
		case "unavailable":
			if (
				!isBoundedString(message.code, 256) ||
				!isBoundedString(message.message, 4_096) ||
				message.recoverable !== true
			) return null;
			break;
		case "error":
			if (
				!isBoundedString(message.code, 256) ||
				!isBoundedString(message.message, 4_096) ||
				typeof message.recoverable !== "boolean"
			) return null;
			break;
		default:
			return null;
	}
	return message as unknown as VoiceStreamServerMessage;
}

function isValidVoiceEntityId(value: string): boolean {
	return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function isVoiceSessionId(value: unknown): value is string {
	return typeof value === "string" && isValidVoiceEntityId(value);
}

export function isVoiceUtteranceId(value: unknown): value is string {
	return typeof value === "string" && isValidVoiceEntityId(value);
}

function isLanguageHint(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value);
}

function hasUtteranceId(
	message: Record<string, unknown>,
): message is Record<string, unknown> & { utteranceId: string } {
	return (
		typeof message.utteranceId === "string" &&
		isValidVoiceEntityId(message.utteranceId)
	);
}

function isBoundedString(
	value: unknown,
	maxLength: number,
	allowEmpty = false,
): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.length > 0) &&
		value.length <= maxLength
	);
}

function isCanonicalIsoDate(value: string): boolean {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isReadiness(value: unknown): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const readiness = value as Record<string, unknown>;
	if (
		readiness.readyBeforeRequest !== undefined &&
		typeof readiness.readyBeforeRequest !== "boolean"
	) return false;
	for (const key of ["warmupDurationMs", "requestDurationMs"]) {
		const field = readiness[key];
		if (
			field !== undefined &&
			(typeof field !== "number" || !Number.isFinite(field) || field < 0)
		) return false;
	}
	return true;
}
