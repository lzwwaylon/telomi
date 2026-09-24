export type AudioFormat = "mp3" | "wav" | "m4a" | "webm" | "ogg" | "flac";

export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
}

export interface TranscriptResult {
	text: string;
	language?: string;
	durationSec?: number;
	provider: string;
	model?: string;
	segments: TranscriptSegment[];
	vad?: import("./voice-vad.js").VoiceVadMetadata;
}

export interface SpliceClip {
	src: string;
	startSec?: number;
	endSec?: number;
	fadeInMs?: number;
	fadeOutMs?: number;
}

export interface SpeakOptions {
	format?: AudioFormat;
	outPath?: string;
	signal?: AbortSignal;
}

export interface SpeakResult {
	provider: string;
	model?: string;
	/** Absent when the server's own default voice spoke. */
	voice?: string;
	format: AudioFormat;
	outPath: string;
	durationSec?: number;
	bytes: number;
}

export interface ProviderError {
	ok: false;
	provider: string;
	reason: string;
}

export type ProviderOk<T> = { ok: true } & T;
export type ProviderResult<T> = ProviderOk<T> | ProviderError;
