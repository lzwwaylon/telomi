import { voiceApi } from "@/features/voice/api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteTrack, Room } from "livekit-client";
import type { LiveKitVoiceConnection } from "@shared/voice-livekit.js";
import { uiText } from "@/app/ui-text";

export type LiveKitConversationStatus =
	| "idle"
	| "connecting"
	| "listening"
	| "thinking"
	| "speaking"
	| "reconnecting"
	| "error";

export interface LiveKitConversationState {
	status: LiveKitConversationStatus;
	userText: string;
	text: string;
	message: string | null;
}

const IDLE_STATE: LiveKitConversationState = {
	status: "idle",
	userText: "",
	text: "",
	message: null,
};

const LIVEKIT_TRANSCRIPTION_TOPIC = "lk.transcription";

export function hasListeningAgent(
	room: Pick<Room, "remoteParticipants">,
): boolean {
	return Array.from(room.remoteParticipants.values()).some(
		(participant) =>
			participant.isAgent &&
			participant.attributes["lk.agent.state"] === "listening",
	);
}

/** LiveKit needs a microphone and WebRTC; it does not use MediaRecorder or AudioWorklet like dictation. */
export function isLiveKitConversationSupported(): boolean {
	return (
		typeof navigator !== "undefined" &&
		Boolean(navigator.mediaDevices?.getUserMedia) &&
		typeof RTCPeerConnection !== "undefined"
	);
}

export function useLiveKitConversation(
	goalId: string | null,
	acquirePlaybackPause: () => () => void,
) {
	const [state, setState] = useState<LiveKitConversationState>(IDLE_STATE);
	const roomRef = useRef<Room | null>(null);
	const startControllerRef = useRef<AbortController | null>(null);
	const playbackReleaseRef = useRef<(() => void) | null>(null);
	const audioElementsRef = useRef(new Set<HTMLMediaElement>());
	const generationRef = useRef(0);

	const releaseClientResources = useCallback(() => {
		for (const element of audioElementsRef.current) {
			element.pause();
			element.remove();
		}
		audioElementsRef.current.clear();
		playbackReleaseRef.current?.();
		playbackReleaseRef.current = null;
	}, []);

	const stop = useCallback(async () => {
		generationRef.current += 1;
		startControllerRef.current?.abort();
		startControllerRef.current = null;
		const room = roomRef.current;
		roomRef.current = null;
		if (room) {
			room.unregisterTextStreamHandler(LIVEKIT_TRANSCRIPTION_TOPIC);
			await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
			await room.disconnect();
		}
		releaseClientResources();
		setState(IDLE_STATE);
	}, [releaseClientResources]);

	const start = useCallback(async () => {
		if (!goalId) return;
		await stop();
		const generation = generationRef.current;
		const controller = new AbortController();
		startControllerRef.current = controller;
		playbackReleaseRef.current = acquirePlaybackPause();
		setState({
			status: "connecting",
			userText: "",
			text: "",
			message: uiText("voice.uselivekitconversation.connectingLiveVoice"),
		});

		try {
			const [livekit, connection] = await Promise.all([
				import("livekit-client"),
				voiceApi.goal(goalId).livekitToken<Partial<LiveKitVoiceConnection>>({
					signal: controller.signal,
					errorMessage: (status, detail) => uiText("voice.uselivekitconversation.livekitTokenRequestFailedStatusDetail", { status, detail: detail.slice(0, 300) }),
				}),
				voiceApi.goal(goalId).warmup({
					signal: controller.signal,
					errorMessage: (status, detail) => uiText("voice.uselivekitconversation.localAudioProviderFailedToStartStatusDetail", { status, detail: detail.slice(0, 300) }),
				}),
			]);
			if (
				typeof connection.serverUrl !== "string" ||
				typeof connection.participantToken !== "string"
			) {
				throw new Error(uiText("voice.uselivekitconversation.invalidLivekitTokenResponse"));
			}
			if (controller.signal.aborted || generation !== generationRef.current) return;

			const room = new livekit.Room({
				adaptiveStream: true,
				stopLocalTrackOnUnpublish: true,
			});
			roomRef.current = room;

			room.on(livekit.RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
				if (track.kind !== livekit.Track.Kind.Audio) return;
				const element = track.attach();
				element.autoplay = true;
				element.setAttribute("playsinline", "true");
				element.dataset.livekitVoiceAudio = "true";
				document.body.append(element);
				audioElementsRef.current.add(element);
			});
			room.on(livekit.RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
				for (const element of track.detach()) {
					audioElementsRef.current.delete(element);
					element.remove();
				}
			});
			room.on(
				livekit.RoomEvent.ParticipantAttributesChanged,
				(changedAttributes, participant) => {
					if (!participant.isAgent) return;
					const agentState = changedAttributes["lk.agent.state"];
					if (!agentState) return;
					setState((current) => ({
						...current,
						status:
							agentState === "thinking"
								? "thinking"
								: agentState === "speaking"
									? "speaking"
									: "listening",
						message:
							agentState === "thinking"
								? uiText("voice.uselivekitconversation.mainAgentIsWorking")
								: agentState === "speaking"
									? uiText("voice.uselivekitconversation.playingLiveAudio")
									: uiText("voice.uselivekitconversation.listeningSpeakOrInterruptAtAnyTime"),
					}));
				},
			);
			room.registerTextStreamHandler(
				LIVEKIT_TRANSCRIPTION_TOPIC,
				async (reader, participantInfo) => {
					let text = "";
					for await (const chunk of reader) {
						if (
							generation !== generationRef.current ||
							roomRef.current !== room
						) {
							return;
						}
						text += chunk;
						setState((current) => ({
							...current,
							...(participantInfo.identity === room.localParticipant.identity
								? { userText: text }
								: { text }),
						}));
					}
				},
			);
			room.on(livekit.RoomEvent.Reconnecting, () => {
				setState((current) => ({
					...current,
					status: "reconnecting",
					message: uiText("voice.uselivekitconversation.reconnectingLiveVoice"),
				}));
			});
			room.on(livekit.RoomEvent.Reconnected, () => {
				setState((current) => ({
					...current,
					status: "listening",
					message: uiText("voice.uselivekitconversation.listeningSpeakOrInterruptAtAnyTime"),
				}));
			});
			room.on(livekit.RoomEvent.Disconnected, () => {
				if (roomRef.current !== room) return;
				roomRef.current = null;
				releaseClientResources();
				setState({
					status: "error",
					userText: "",
					text: "",
					message: uiText("voice.uselivekitconversation.liveVoiceConnectionWasLost"),
				});
			});

			await room.connect(connection.serverUrl, connection.participantToken);
			if (controller.signal.aborted || generation !== generationRef.current) {
				if (roomRef.current === room) roomRef.current = null;
				await room.disconnect();
				releaseClientResources();
				return;
			}
			if (!hasListeningAgent(room)) {
				await new Promise<void>((resolve, reject) => {
					const check = () => {
						if (!hasListeningAgent(room)) return;
						cleanup();
						resolve();
					};
					const onDisconnected = () => {
						cleanup();
						reject(new Error(uiText("voice.uselivekitconversation.theLiveVoiceAgentDisconnectedDuringSetup")));
					};
					const onAbort = () => {
						cleanup();
						reject(new DOMException(uiText("voice.uselivekitconversation.liveVoiceStartupWasCancelled"), "AbortError"));
					};
					const cleanup = () => {
						room.off(livekit.RoomEvent.ParticipantConnected, check);
						room.off(livekit.RoomEvent.ParticipantAttributesChanged, check);
						room.off(livekit.RoomEvent.Disconnected, onDisconnected);
						controller.signal.removeEventListener("abort", onAbort);
					};
					room.on(livekit.RoomEvent.ParticipantConnected, check);
					room.on(livekit.RoomEvent.ParticipantAttributesChanged, check);
					room.on(livekit.RoomEvent.Disconnected, onDisconnected);
					controller.signal.addEventListener("abort", onAbort, { once: true });
					check();
				});
			}
			await room.startAudio();
			await room.localParticipant.setMicrophoneEnabled(true, {
				autoGainControl: true,
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
			});
			setState({
				status: "listening",
				userText: "",
				text: "",
				message: uiText("voice.uselivekitconversation.listeningSpeakOrInterruptAtAnyTime"),
			});
		} catch (error) {
			if (controller.signal.aborted || generation !== generationRef.current) return;
			await stop();
			setState({
				status: "error",
				userText: "",
				text: "",
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (startControllerRef.current === controller) {
				startControllerRef.current = null;
			}
		}
	}, [acquirePlaybackPause, goalId, releaseClientResources, stop]);

	useEffect(() => () => {
		void stop();
	}, [stop]);

	return {
		supported: isLiveKitConversationSupported(),
		active: state.status !== "idle" && state.status !== "error",
		state,
		start,
		stop,
	};
}
