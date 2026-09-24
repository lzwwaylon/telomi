import { voiceApi } from "@/features/voice/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { uiText } from "@/app/ui-text";
import type { VoiceContextSnapshotDescriptor } from "@shared/voice-context.js";
import {
	BrowserVoiceCapture,
	type BrowserVoiceCaptureResult,
} from "@/features/voice/BrowserVoiceCapture";
import { buildVoiceMicrophoneRequestHeaders } from "@shared/voice-microphone.js";
import {
	normalizeVoiceCleanupOutcome,
	type VoiceCleanupOutcome,
} from "@shared/voice-cleanup.js";
import { voiceRecordingCuePlayer } from "@/features/voice/voiceRecordingCues";
import { isVoiceCancelKeyboardEvent } from "@/features/voice/voiceKeyboard";
import {
	isVoiceInputCancellable,
	shouldPreserveCancelledVoiceRecording,
} from "@/features/voice/voiceInputControl";
import { readSavedVoiceHistoryId } from "@/features/voice/voiceUserEdit";
import {
	openVoiceSession,
	type VoiceSessionEvent,
	type VoiceSessionInput,
	type VoiceSessionRuntimeContext,
	type VoiceSessionRuntimeEventPayload,
	type VoiceSessionHandle,
} from "@/features/voice/VoiceSession";

export type VoiceInputStatus = "idle" | "starting" | "recording" | "finalizing" | "error";

export interface VoiceInputState {
	status: VoiceInputStatus;
	error: string | null;
}

export interface VoiceInputFinalResult {
	sessionId: string;
	utteranceId: string;
	text: string;
	rawText: string;
	canonicalText: string;
	durationMs: number;
	historyId?: string;
	cleanup: VoiceCleanupOutcome;
	skipped: false;
}

export interface VoiceInputSkippedResult {
	skipped: true;
	reason: "empty_recording" | "silence" | "insufficient_speech";
}

export type VoiceInputResult = VoiceInputFinalResult | VoiceInputSkippedResult;

export interface VoiceInputSessionOptions {
	onResult?: (result: VoiceInputResult) => void;
	acquirePlaybackPause?: () => () => void;
	onCancel?: (status: VoiceInputStatus) => void;
}

export interface VoiceInputSession {
	state: VoiceInputState;
	supported: boolean;
	clearError: () => void;
	input: (event: VoiceSessionInput) => Promise<void>;
}

const INITIAL_STATE: VoiceInputState = {
	status: "idle",
	error: null,
};

export function useVoiceInputSession(
	goalId: string | null,
	options: VoiceInputSessionOptions = {},
): VoiceInputSession {
	const [state, setState] = useState<VoiceInputState>(INITIAL_STATE);
	const statusRef = useRef<VoiceInputStatus>(state.status);
	const optionsRef = useRef(options);
	const captureRef = useRef<BrowserVoiceCapture | null>(null);
	const sessionIdRef = useRef(newVoiceSessionId());
	const voiceSessionRef = useRef<VoiceSessionHandle | null>(null);
	const activeRuntimeContextRef =
		useRef<VoiceSessionRuntimeContext | null>(null);
	const runtimeCommandRef = useRef<
		(
			event: VoiceSessionInput,
			context: VoiceSessionRuntimeContext,
		) => Promise<void>
	>(async () => undefined);
	const activeUtteranceRef = useRef<string | null>(null);
	const activeContextSnapshotIdRef = useRef<string | null>(null);
	const recordingCuesEnabledRef = useRef(true);
	const playbackPauseReleaseRef = useRef<(() => void) | null>(null);
	const discardedRecoveryPolicyRef = useRef<Promise<boolean> | null>(null);
	const batchAbortRef = useRef<AbortController | null>(null);
	const finalizingRef = useRef<Promise<VoiceInputResult | null> | null>(null);
	const supported = BrowserVoiceCapture.isSupported();
	optionsRef.current = options;
	statusRef.current = state.status;
	const input = useCallback((event: VoiceSessionInput): Promise<void> => {
		return voiceSessionRef.current?.input(event) ?? Promise.resolve();
	}, []);
	const emitRuntimeEvent = useCallback(
		(utteranceId: string, payload: VoiceSessionRuntimeEventPayload) => {
			const context = activeRuntimeContextRef.current;
			if (context?.utteranceId !== utteranceId) return;
			context.emit(payload);
		},
		[],
	);

	const releasePlaybackPause = useCallback(() => {
		const release = playbackPauseReleaseRef.current;
		playbackPauseReleaseRef.current = null;
		if (!release) return;
		try {
			release();
		} catch (error) {
			console.debug(
				`[voice] playback resume unavailable: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}, []);
	const reset = useCallback((preserveDiscarded: boolean) => {
		const capture = captureRef.current;
		const discardedRecoveryPolicy =
			discardedRecoveryPolicyRef.current ?? Promise.resolve(false);
		const contextSnapshotId = activeContextSnapshotIdRef.current;
		const utteranceId = activeUtteranceRef.current;
		const sessionId = sessionIdRef.current;
		const discardedRecording = capture?.cancel(preserveDiscarded);
		releasePlaybackPause();
		batchAbortRef.current?.abort();
		captureRef.current = null;
		discardedRecoveryPolicyRef.current = null;
		batchAbortRef.current = null;
		finalizingRef.current = null;
		activeUtteranceRef.current = null;
		activeContextSnapshotIdRef.current = null;
		activeRuntimeContextRef.current = null;
		recordingCuesEnabledRef.current = true;
		setState(INITIAL_STATE);
		if (preserveDiscarded && discardedRecording && goalId) {
			void Promise.all([discardedRecording, discardedRecoveryPolicy])
				.then(([recording, enabled]) => {
					if (!recording || !enabled || !utteranceId) return;
					return uploadDiscardedRecording(
						goalId,
						recording,
						sessionId,
						utteranceId,
						contextSnapshotId,
					);
				})
				.catch((error) => {
					console.warn(
						`[voice] failed to preserve cancelled recording: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				});
		} else if (discardedRecording) {
			void discardedRecording.catch(() => undefined);
		}
	}, [
		goalId,
		releasePlaybackPause,
	]);

	const cancel = useCallback(() => {
		const cancelledStatus = statusRef.current;
		reset(shouldPreserveCancelledVoiceRecording(cancelledStatus));
		optionsRef.current.onCancel?.(cancelledStatus);
	}, [reset]);

	useEffect(() => {
		if (!isVoiceInputCancellable(state.status)) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!isVoiceCancelKeyboardEvent(event)) return;
			event.preventDefault();
			void input({ type: "utterance.cancel" });
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [input, state.status]);

	const finalize = useCallback((): Promise<VoiceInputResult | null> => {
		const existing = finalizingRef.current;
		if (existing) {
			return existing;
		}
		const capture = captureRef.current;
		const utteranceId = activeUtteranceRef.current;
		const contextSnapshotId = activeContextSnapshotIdRef.current;
		if (!goalId || !capture || !utteranceId || !contextSnapshotId) {
			return Promise.resolve(null);
		}
		setState((current) => ({ ...current, status: "finalizing" }));

		const promise = (async (): Promise<VoiceInputResult | null> => {
			let batchAbort: AbortController | null = null;
			try {
				let recording: BrowserVoiceCaptureResult | null;
				try {
					recording = await capture.stop();
				} finally {
					releasePlaybackPause();
				}
				if (activeUtteranceRef.current !== utteranceId) return null;
				captureRef.current = null;
				if (!recording) {
					discardedRecoveryPolicyRef.current = null;
					emitRuntimeEvent(utteranceId, {
						type: "utterance.discarded",
						utteranceId,
						reason: "empty_recording",
					});
					activeUtteranceRef.current = null;
					activeContextSnapshotIdRef.current = null;
					setState(INITIAL_STATE);
					return null;
				}
				void voiceRecordingCuePlayer.play("stop", recordingCuesEnabledRef.current);
				const skipReason = getSkipReason(recording);
				if (skipReason) {
					discardedRecoveryPolicyRef.current = null;
					emitRuntimeEvent(utteranceId, {
						type: "utterance.discarded",
						utteranceId,
						reason: skipReason,
					});
					activeUtteranceRef.current = null;
					activeContextSnapshotIdRef.current = null;
					setState(INITIAL_STATE);
					return { skipped: true, reason: skipReason };
				}

				batchAbort = new AbortController();
				batchAbortRef.current = batchAbort;
				const batchQuery = new URLSearchParams({
					contextSnapshotId,
					sessionId: sessionIdRef.current,
					utteranceId,
					// Lets the server keep a cancel during transcription as a discarded recording.
					durationMs: String(Math.round(recording.durationMs)),
				});
				// Retain audio headers and the transcription-specific response diagnostics.
				const batchResponse = await voiceApi.goal(goalId).transcribe(
					batchQuery,
					{
						method: "POST",
						headers: {
							"Content-Type": recording.mime || "audio/webm",
							...buildVoiceMicrophoneRequestHeaders(recording.microphone),
						},
						body: recording.blob,
						signal: batchAbort.signal,
					},
				);
				if (activeUtteranceRef.current !== utteranceId) return null;
				if (!batchResponse.ok) {
					const body = await batchResponse.text().catch(() => "");
					throw new Error(uiText("voice.usevoiceinputsession.transcriptionFailedHttpStatusDetail", { status: batchResponse.status, detail: body.slice(0, 200) }));
				}
				const data = await batchResponse.json() as {
					text?: string;
					rawText?: string;
					canonicalText?: string;
					cleanup?: { applied: boolean; modelId?: string; reason?: string; durationMs?: number };
					history?: unknown;
				};
				if (data.cleanup && !data.cleanup.applied && data.cleanup.reason) {
					console.warn(
						`[voice] cleanup skipped (${data.cleanup.modelId ?? "?"}): ${data.cleanup.reason}`,
					);
				}
				const text = (data.text ?? "").trim();
				const result: VoiceInputFinalResult = {
					sessionId: sessionIdRef.current,
					utteranceId,
					text,
					rawText: data.rawText ?? text,
					canonicalText: data.canonicalText ?? data.rawText ?? text,
					durationMs: recording.durationMs,
					historyId: readSavedVoiceHistoryId(data.history),
					cleanup: normalizeVoiceCleanupOutcome(data.cleanup),
					skipped: false,
				};
				emitRuntimeEvent(utteranceId, {
					type: "utterance.final",
					utteranceId,
					text: result.text,
					rawText: result.rawText,
					canonicalText: result.canonicalText,
					durationMs: result.durationMs,
					...(result.historyId ? { historyId: result.historyId } : {}),
					cleanup: result.cleanup,
				});
				discardedRecoveryPolicyRef.current = null;
				activeUtteranceRef.current = null;
				activeContextSnapshotIdRef.current = null;
				setState(INITIAL_STATE);
				return result;
			} catch (error) {
				if (activeUtteranceRef.current !== utteranceId) return null;
				discardedRecoveryPolicyRef.current = null;
				activeUtteranceRef.current = null;
				activeContextSnapshotIdRef.current = null;
				emitRuntimeEvent(utteranceId, {
					type: "utterance.failed",
					utteranceId,
					code: "voice_finalization_failed",
					message: error instanceof Error ? error.message : String(error),
				});
				setState((current) => ({
					...current,
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				}));
				return null;
			} finally {
				if (batchAbortRef.current === batchAbort) batchAbortRef.current = null;
			}
		})();

		finalizingRef.current = promise;
		void promise.then(() => {
			if (finalizingRef.current === promise) finalizingRef.current = null;
		});
		return promise;
	}, [
		emitRuntimeEvent,
		goalId,
		releasePlaybackPause,
	]);

	const start = useCallback(async (
		utteranceId: string,
		runtimeContext: VoiceSessionRuntimeContext,
	) => {
		if (!goalId || !supported || captureRef.current || finalizingRef.current) return;
		void voiceRecordingCuePlayer.prepare();
		activeRuntimeContextRef.current = runtimeContext;
		activeUtteranceRef.current = utteranceId;
		activeContextSnapshotIdRef.current = null;
		discardedRecoveryPolicyRef.current = loadDiscardedRecoveryPolicy();
		const contextSnapshotPromise = captureVoiceContextSnapshot(goalId);
		setState({ ...INITIAL_STATE, status: "starting" });
		void requestVoiceSttWarmup(goalId);

		// Dictation ends only on an explicit finish or cancel command.
		const capture = new BrowserVoiceCapture();
		captureRef.current = capture;

		try {
			const [, contextSnapshot] = await Promise.all([
				capture.start(),
				contextSnapshotPromise,
			]);
			const recordingPreferences = contextSnapshot.recording;
			if (activeUtteranceRef.current !== utteranceId) {
				void capture.cancel();
				return;
			}
			recordingCuesEnabledRef.current = recordingPreferences.audioCuesEnabled;
			activeContextSnapshotIdRef.current = contextSnapshot.contextSnapshotId;

			// The microphone would otherwise pick up the player; only audio paused here is resumed afterwards.
			try {
				playbackPauseReleaseRef.current =
					optionsRef.current.acquirePlaybackPause?.() ?? null;
			} catch (error) {
				console.debug(
					`[voice] playback pause unavailable: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			setState((current) => ({ ...current, status: "recording" }));
			emitRuntimeEvent(utteranceId, {
				type: "utterance.started",
				utteranceId,
			});
			void voiceRecordingCuePlayer.play("start", recordingPreferences.audioCuesEnabled);

		} catch (error) {
			void capture.cancel();
			if (activeUtteranceRef.current !== utteranceId) return;
			releasePlaybackPause();
			captureRef.current = null;
			discardedRecoveryPolicyRef.current = null;
			activeUtteranceRef.current = null;
			activeContextSnapshotIdRef.current = null;
			emitRuntimeEvent(utteranceId, {
				type: "utterance.failed",
				utteranceId,
				code: "voice_capture_start_failed",
				message: error instanceof Error ? error.message : String(error),
			});
			setState({
				...INITIAL_STATE,
				status: "error",
				error: uiText("voice.usevoiceinputsession.voiceInputFailedToStartError", { error: error instanceof Error ? error.message : String(error) }),
			});
		}
	}, [
		emitRuntimeEvent,
		goalId,
		releasePlaybackPause,
		supported,
	]);

	const handleVoiceSessionEvent = useCallback((event: VoiceSessionEvent) => {
		if (event.type === "utterance.final") {
			const text = event.text.trim();
			optionsRef.current.onResult?.(
				{
					sessionId: event.sessionId,
					utteranceId: event.utteranceId,
					text,
					rawText: event.rawText ?? text,
					canonicalText: event.canonicalText ?? event.rawText ?? text,
					durationMs: event.durationMs ?? 0,
					...(event.historyId ? { historyId: event.historyId } : {}),
					cleanup:
						event.cleanup ?? normalizeVoiceCleanupOutcome(undefined),
					skipped: false,
				},
			);
			return;
		}
		if (
			event.type === "utterance.discarded" &&
			(event.reason === "empty_recording" ||
				event.reason === "silence" ||
				event.reason === "insufficient_speech")
		) {
			optionsRef.current.onResult?.(
				{ skipped: true, reason: event.reason },
			);
			return;
		}
		if (event.type === "utterance.failed") {
			setState((current) =>
				current.status === "error"
					? current
					: {
							...current,
							status: "error",
							error: event.message,
						},
			);
		}
	}, []);

	runtimeCommandRef.current = async (event, context) => {
		const utteranceId = context.utteranceId;
		if (!utteranceId) return;
		activeRuntimeContextRef.current = context;
		if (event.type === "utterance.start") {
			await start(utteranceId, context);
			return;
		}
		if (event.type === "utterance.finish") {
			await finalize();
			return;
		}
		context.emit({
			type: "utterance.discarded",
			utteranceId,
			reason: "cancelled",
		});
		cancel();
	};

	useEffect(() => {
		if (!goalId) {
			voiceSessionRef.current = null;
			return;
		}
		const sessionId = newVoiceSessionId();
		sessionIdRef.current = sessionId;
		const session = openVoiceSession({
			goalId,
			sessionId,
			supported,
			runtime: {
				input: (event, context) =>
					runtimeCommandRef.current(event, context),
				async close(context) {
					if (context.utteranceId) {
						context.emit({
							type: "utterance.discarded",
							utteranceId: context.utteranceId,
							reason: "session_closed",
						});
					}
					reset(false);
				},
			},
		});
		voiceSessionRef.current = session;
		let disposed = false;
		void (async () => {
			for await (const event of session.events()) {
				if (disposed) return;
				handleVoiceSessionEvent(event);
			}
		})();
		return () => {
			disposed = true;
			if (voiceSessionRef.current === session) {
				voiceSessionRef.current = null;
			}
			void session.close();
		};
	}, [goalId, handleVoiceSessionEvent, reset, supported]);

	const clearError = useCallback(() => {
		setState((current) => current.status === "error" ? INITIAL_STATE : current);
	}, []);
	return { state, supported, input, clearError };
}

function getSkipReason(
	recording: BrowserVoiceCaptureResult,
): VoiceInputSkippedResult["reason"] | null {
	if (!recording.recordingValidation.usable) return "empty_recording";
	if (recording.speechGate.skip && recording.speechGate.reason === "silence") return "silence";
	if (recording.speechGate.skip && recording.speechGate.reason === "insufficient_speech") {
		return "insufficient_speech";
	}
	return null;
}

function newVoiceSessionId(): string {
	return `voice_${crypto.randomUUID?.().replace(/-/g, "") ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

async function loadDiscardedRecoveryPolicy(): Promise<boolean> {
	try {
		const settings = await voiceApi.history.loadSettings();
		return (
			settings.dataRetentionEnabled === true &&
			settings.saveDiscardedTranscriptions === true &&
			(settings.audioRetentionDays ?? 0) > 0
		);
	} catch {
		return false;
	}
}

async function captureVoiceContextSnapshot(
	goalId: string,
): Promise<VoiceContextSnapshotDescriptor> {
	const data = await voiceApi.goal(goalId).captureContextSnapshot(
		{ fallbackMessage: (status) => `voice context snapshot failed: HTTP ${status}` },
	);
	if (typeof data?.contextSnapshotId !== "string" || !data.recording) {
		throw new Error(data?.error || "voice context snapshot failed: HTTP 200");
	}
	return data as VoiceContextSnapshotDescriptor;
}

async function requestVoiceSttWarmup(goalId: string): Promise<void> {
	try {
		await voiceApi.goal(goalId).warmup();
	} catch {
		// Final transcription reports readiness failures. Warmup only overlaps
		// model loading with microphone startup.
	}
}

async function uploadDiscardedRecording(
	goalId: string,
	recording: BrowserVoiceCaptureResult,
	sessionId: string,
	utteranceId: string,
	contextSnapshotId: string | null,
): Promise<void> {
	if (
		recording.durationMs < 1_000 ||
		!recording.recordingValidation.usable
	) {
		return;
	}
	const query = new URLSearchParams({
		durationMs: String(Math.round(recording.durationMs)),
		sessionId,
		utteranceId,
		...(contextSnapshotId ? { contextSnapshotId } : {}),
	});
	const response = await voiceApi.goal(goalId).discarded(
		query,
		{
			method: "POST",
			headers: {
				"Content-Type": recording.mime || "audio/webm",
				...buildVoiceMicrophoneRequestHeaders(recording.microphone),
			},
			body: recording.blob,
		},
	);
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
	}
}
