import {
	isVoiceSessionId,
	type VoiceSessionEventEnvelope,
} from "@shared/voice-stt.js";
import type { VoiceCleanupOutcome } from "@shared/voice-cleanup.js";
import { uiText } from "@/app/ui-text";
import { BrowserVoiceCapture } from "@/features/voice/BrowserVoiceCapture";

export interface OpenVoiceSessionConfig {
	goalId: string;
	sessionId?: string;
	supported?: boolean;
	runtime?: VoiceSessionRuntime;
}

export type VoiceSessionEventPayload =
	| {
			type: "session.opened";
			goalId: string;
			supported: boolean;
	  }
	| { type: "session.closed" }
	| {
			type: "utterance.started";
			utteranceId: string;
	  }
	| {
			type: "utterance.final";
			utteranceId: string;
			text: string;
			rawText?: string;
			canonicalText?: string;
			durationMs?: number;
			historyId?: string;
			cleanup?: VoiceCleanupOutcome;
	  }
	| {
			type: "utterance.discarded";
			utteranceId: string;
			reason: string;
	  }
	| {
			type: "utterance.failed";
			utteranceId: string;
			code: string;
			message: string;
	  };

export type VoiceSessionEvent =
	VoiceSessionEventEnvelope & VoiceSessionEventPayload;

export type VoiceSessionRuntimeEventPayload = Exclude<
	VoiceSessionEventPayload,
	{ type: "session.opened" | "session.closed" }
>;

export type VoiceSessionInput =
	| { type: "utterance.start" }
	| { type: "utterance.finish" }
	| { type: "utterance.cancel" };

export interface VoiceSessionRuntimeContext {
	readonly sessionId: string;
	readonly utteranceId: string | null;
	emit(payload: VoiceSessionRuntimeEventPayload): void;
}

export interface VoiceSessionRuntime {
	input(
		event: VoiceSessionInput,
		context: VoiceSessionRuntimeContext,
	): Promise<void>;
	close(context: VoiceSessionRuntimeContext): Promise<void>;
}

export interface VoiceSessionHandle {
	readonly sessionId: string;
	input(event: VoiceSessionInput): Promise<void>;
	events(): AsyncIterable<VoiceSessionEvent>;
	close(): Promise<void>;
}

export function openVoiceSession(
	config: OpenVoiceSessionConfig,
): VoiceSessionHandle {
	if (!config.goalId) throw new Error(uiText("voice.session.voiceSessionRequiresAGoalId"));
	const sessionId = config.sessionId ?? newVoiceSessionId();
	if (!isVoiceSessionId(sessionId)) {
		throw new Error(uiText("voice.session.voiceSessionIdIsInvalid"));
	}
	return new BrowserVoiceSession(
		config.goalId,
		sessionId,
		config.supported ?? BrowserVoiceCapture.isSupported(),
		config.runtime,
	);
}

class BrowserVoiceSession implements VoiceSessionHandle {
	readonly sessionId: string;
	private readonly eventQueue = new VoiceSessionEventQueue();
	private readonly runtime?: VoiceSessionRuntime;
	private readonly supported: boolean;
	private activeUtteranceId: string | null = null;
	private sequence = 0;
	private closed = false;

	constructor(
		goalId: string,
		sessionId: string,
		supported: boolean,
		runtime?: VoiceSessionRuntime,
	) {
		this.sessionId = sessionId;
		this.supported = supported;
		this.runtime = runtime;
		this.emit({
			type: "session.opened",
			goalId,
			supported: this.supported,
		});
	}

	async input(event: VoiceSessionInput): Promise<void> {
		if (this.closed) throw new Error(uiText("voice.session.voiceSessionIsClosed"));
		if (event.type === "utterance.start") {
			if (this.activeUtteranceId) {
				throw new Error(uiText("voice.session.voiceSessionAlreadyHasAnActiveUtterance"));
			}
			this.activeUtteranceId = newUtteranceId();
		} else if (!this.activeUtteranceId) {
			throw new Error(uiText("voice.session.voiceSessionHasNoActiveUtterance"));
		}
		const utteranceId = this.activeUtteranceId;
		if (!utteranceId) throw new Error(uiText("voice.session.voiceUtteranceIdentityIsUnavailable"));
		if (!this.supported) {
			this.emit({
				type: "utterance.failed",
				utteranceId,
				code: "voice_capture_unsupported",
				message: uiText("voice.session.thisBrowserDoesNotSupportVoiceInput"),
			});
			this.activeUtteranceId = null;
			return;
		}
		if (!this.runtime) {
			this.activeUtteranceId = null;
			throw new Error(uiText("voice.session.voiceSessionCaptureIsNotConnected"));
		}
		try {
			await this.runtime.input(
				event,
				this.createRuntimeContext(utteranceId),
			);
		} catch (error) {
			if (this.activeUtteranceId === utteranceId) {
				this.emit({
					type: "utterance.failed",
					utteranceId,
					code: "voice_runtime_failed",
					message: error instanceof Error ? error.message : String(error),
				});
				this.activeUtteranceId = null;
			}
		}
	}

	events(): AsyncIterable<VoiceSessionEvent> {
		return this.eventQueue;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		const utteranceId = this.activeUtteranceId;
		try {
			await this.runtime?.close(this.createRuntimeContext(utteranceId));
		} finally {
			this.activeUtteranceId = null;
			this.closed = true;
			this.emit({ type: "session.closed" });
			this.eventQueue.close();
		}
	}

	private emit(payload: VoiceSessionEventPayload): void {
		this.eventQueue.push({
			...payload,
			sessionId: this.sessionId,
			sequence: ++this.sequence,
			occurredAt: new Date().toISOString(),
			causationId:
				"utteranceId" in payload
					? payload.utteranceId
					: this.sessionId,
		});
	}

	private createRuntimeContext(
		utteranceId: string | null,
	): VoiceSessionRuntimeContext {
		return {
			sessionId: this.sessionId,
			utteranceId,
			emit: (payload) => {
				if (payload.utteranceId !== utteranceId) {
					throw new Error(uiText("voice.session.voiceRuntimeEmittedAnEventForAnotherUtterance"));
				}
				if (this.closed || this.activeUtteranceId !== utteranceId) return;
				this.emit(payload);
				if (
					payload.type === "utterance.final" ||
					payload.type === "utterance.discarded" ||
					payload.type === "utterance.failed"
				) {
					this.activeUtteranceId = null;
				}
			},
		};
	}
}

class VoiceSessionEventQueue implements AsyncIterable<VoiceSessionEvent> {
	private readonly queued: VoiceSessionEvent[] = [];
	private readonly waiting: Array<
		(result: IteratorResult<VoiceSessionEvent>) => void
	> = [];
	private closed = false;

	push(event: VoiceSessionEvent): void {
		if (this.closed) return;
		const resolve = this.waiting.shift();
		if (resolve) resolve({ done: false, value: event });
		else this.queued.push(event);
	}

	close(): void {
		this.closed = true;
		if (this.queued.length > 0) return;
		for (const resolve of this.waiting.splice(0)) {
			resolve({ done: true, value: undefined });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<VoiceSessionEvent> {
		return {
			next: () => {
				const event = this.queued.shift();
				if (event) return Promise.resolve({ done: false, value: event });
				if (this.closed) {
					return Promise.resolve({ done: true, value: undefined });
				}
				return new Promise((resolve) => this.waiting.push(resolve));
			},
		};
	}
}

function newVoiceSessionId(): string {
	return `voice_${crypto.randomUUID?.().replace(/-/g, "") ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function newUtteranceId(): string {
	return `utt_${crypto.randomUUID?.().replace(/-/g, "") ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}
