export interface StreamingTranscriptionCallbacks {
	onPreparing?: (state: StreamingTranscriptionPreparingState) => void;
	onReady?: (readiness?: StreamingTranscriptionReadiness) => void;
	onPartial?: (text: string) => void;
	onFinal?: (text: string) => void;
	onError?: (error: Error) => void;
}

export interface StreamingTranscriptionPreparingState {
	stage: "model_warmup" | "provider_connection";
	message: string;
}

export interface StreamingTranscriptionReadiness {
	readyBeforeRequest?: boolean;
	warmupDurationMs?: number;
	requestDurationMs?: number;
}

/**
 * Provider seam for one utterance of streaming transcript preview.
 *
 * Runtime code owns the browser protocol and transcript revisions. Provider
 * adapters own only their transport, buffering, and recognition lifecycle.
 */
export interface StreamingTranscriptionAdapter {
	readonly provider: string;
	readonly model: string;
	connect(): Promise<void>;
	sendAudio(bytes: Buffer): boolean;
	finish(): Promise<string>;
	cancel(): void;
	close(): void;
}
