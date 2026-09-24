/**
 * Microphone selection and track-readiness behavior is adapted from OpenWhispr:
 * https://github.com/OpenWhispr/openwhispr/tree/e1cb8301d898881e28372e61ba15a8fd57f4f25b
 * OpenWhispr is MIT licensed. See THIRD_PARTY_NOTICES.md.
 */

import type {
	VoiceMicrophoneCaptureMetadata,
	VoiceMicrophoneSelectionStatus,
} from "@shared/voice-microphone.js";
import { uiText } from "@/app/ui-text";
export type { VoiceMicrophoneSelectionStatus } from "@shared/voice-microphone.js";

const TRACK_READY_TIMEOUT_MS = 600;
const MICROPHONE_REQUEST_TIMEOUT_MS = 20_000;
const PREFERENCE_STORAGE_KEY = "telomi.voice.microphone.v1";

export type VoiceMicrophonePreference =
	| { kind: "default" }
	| { kind: "built-in" }
	| { kind: "device"; deviceId: string; deviceLabel: string };

export interface VoiceMicrophoneDevice {
	deviceId: string;
	label: string;
	isBuiltIn: boolean;
}

export interface VoiceMicrophoneSnapshot {
	devices: VoiceMicrophoneDevice[];
	preference: VoiceMicrophonePreference;
	selectionStatus: VoiceMicrophoneSelectionStatus;
	resolvedDeviceId: string | null;
	labelsAvailable: boolean;
}

export interface VoiceMicrophoneCapture extends VoiceMicrophoneCaptureMetadata {
	stream: MediaStream;
}

export interface VoiceMicrophoneWarmupResult {
	warmed: boolean;
	alreadyWarm: boolean;
	skippedActiveCapture: boolean;
	deviceLabel: string;
	usedFallback: boolean;
}

export interface VoiceMicrophoneAcquirer {
	acquire(options?: VoiceMicrophoneAcquireOptions): Promise<VoiceMicrophoneCapture>;
}

export interface VoiceMicrophoneAcquireOptions {
	fullDuplex?: boolean;
}

export interface VoiceMicrophonePreferenceStore {
	read(): VoiceMicrophonePreference;
	write(preference: VoiceMicrophonePreference): void;
}

interface VoiceMediaDevices {
	enumerateDevices(): Promise<MediaDeviceInfo[]>;
	getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
	addEventListener?(type: "devicechange", listener: EventListener): void;
	removeEventListener?(type: "devicechange", listener: EventListener): void;
}

interface ResolvedSelection {
	device: Pick<MediaDeviceInfo, "deviceId" | "kind" | "label"> | null;
	status: VoiceMicrophoneSelectionStatus;
}

interface AcquisitionPlan {
	constraints: MediaStreamConstraints;
	deviceId: string | null;
	deviceLabel: string;
	status: VoiceMicrophoneSelectionStatus;
}

const RAW_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
	echoCancellation: false,
	noiseSuppression: false,
	autoGainControl: false,
	channelCount: 2,
};
const FULL_DUPLEX_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
	channelCount: 1,
};

/**
 * Reconciles a persisted device ID against the current browser device list.
 * A label is only used when it identifies exactly one current input.
 */
export function resolveVoiceMicrophoneSelection(
	devices: Array<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>,
	selectedDeviceId: string,
	selectedDeviceLabel: string,
): ResolvedSelection {
	if (!selectedDeviceId) return { device: null, status: "default" };

	const audioInputs = devices.filter(
		(device) => device.kind === undefined || device.kind === "audioinput",
	);
	const exactMatch = audioInputs.find(
		(device) => device.deviceId === selectedDeviceId,
	);
	if (exactMatch) return { device: exactMatch, status: "exact" };
	if (!selectedDeviceLabel) return { device: null, status: "missing" };

	const labelMatches = audioInputs.filter(
		(device) =>
			device.deviceId !== "default" && device.label === selectedDeviceLabel,
	);
	if (labelMatches.length === 1) {
		return { device: labelMatches[0], status: "remapped" };
	}
	return {
		device: null,
		status: labelMatches.length > 1 ? "ambiguous" : "missing",
	};
}

/**
 * Waits for a live track that is actually capable of delivering audio.
 */
export function waitForVoiceMicrophoneTrack(
	track: MediaStreamTrack | null | undefined,
	timeoutMs = TRACK_READY_TIMEOUT_MS,
): Promise<boolean> {
	return new Promise((resolve) => {
		if (!track || track.readyState === "ended") {
			resolve(false);
			return;
		}
		if (!track.muted) {
			resolve(true);
			return;
		}

		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const cleanup = () => {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			track.removeEventListener("unmute", onUnmute);
			track.removeEventListener("ended", onEnded);
		};
		const settle = (value: boolean) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		function onUnmute() {
			settle(true);
		}
		function onEnded() {
			settle(false);
		}

		track.addEventListener("unmute", onUnmute);
		track.addEventListener("ended", onEnded);
		timer = setTimeout(() => {
			settle(!track.muted && track.readyState !== "ended");
		}, timeoutMs);
	});
}

export function isBuiltInVoiceMicrophone(label: string): boolean {
	const normalized = label.toLowerCase();
	if (
		normalized.includes("built-in") ||
		normalized.includes("internal") ||
		normalized.includes("macbook") ||
		normalized.includes("integrated")
	) {
		return true;
	}
	if (!normalized.includes("microphone")) return false;
	const externalIndicators = [
		"bluetooth",
		"airpods",
		"wireless",
		"usb",
		"external",
		"headset",
		"webcam",
		"iphone",
		"ipad",
	];
	return !externalIndicators.some((indicator) => normalized.includes(indicator));
}

/**
 * Detect an exact deviceId constraint that went stale after Chromium rotated
 * origin-scoped IDs or the selected device disappeared.
 *
 * Close TypeScript port of OpenWhispr's staleMicDevice helper.
 */
export function isStaleVoiceMicrophoneDeviceError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { name?: unknown; constraint?: unknown };
	if (candidate.name !== "OverconstrainedError") return false;
	const constraint = candidate.constraint;
	return !constraint || constraint === "deviceId";
}

/**
 * Deep microphone Module.
 *
 * Interface: snapshot, setPreference, warmup, acquire, subscribe.
 * Adapter seam: VoiceMediaDevices and VoiceMicrophonePreferenceStore.
 * Device reconciliation, raw constraints, retries and fallback stay internal.
 */
export class VoiceMicrophoneManager implements VoiceMicrophoneAcquirer {
	private readonly mediaDevices: VoiceMediaDevices;
	private readonly preferenceStore: VoiceMicrophonePreferenceStore;
	private readonly listeners = new Set<() => void>();
	private readonly activeStreams = new Set<MediaStream>();
	private rejectedDeviceId: string | null = null;
	private warmedPreferenceKey: string | null = null;
	private disposed = false;
	private readonly onDeviceChange = () => {
		this.rejectedDeviceId = null;
		this.warmedPreferenceKey = null;
		this.emitChange();
	};

	constructor(
		mediaDevices: VoiceMediaDevices,
		preferenceStore: VoiceMicrophonePreferenceStore,
	) {
		this.mediaDevices = mediaDevices;
		this.preferenceStore = preferenceStore;
		this.mediaDevices.addEventListener?.("devicechange", this.onDeviceChange);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getPreference(): VoiceMicrophonePreference {
		return this.preferenceStore.read();
	}

	setPreference(preference: VoiceMicrophonePreference): void {
		this.preferenceStore.write(normalizeVoiceMicrophonePreference(preference));
		this.rejectedDeviceId = null;
		this.warmedPreferenceKey = null;
		this.emitChange();
	}

	async snapshot(): Promise<VoiceMicrophoneSnapshot> {
		const preference = this.getPreference();
		const rawDevices = await this.mediaDevices.enumerateDevices();
		const inputs = rawDevices.filter(
			(device) => device.kind === "audioinput" && device.deviceId !== "default",
		);
		const devices = inputs.map((device) => ({
			deviceId: device.deviceId,
			label: device.label,
			isBuiltIn: isBuiltInVoiceMicrophone(device.label),
		}));
		const labelsAvailable = inputs.some((device) => Boolean(device.label));
		const resolved = this.resolvePreference(rawDevices, preference);
		return {
			devices,
			preference,
			selectionStatus: resolved.status,
			resolvedDeviceId: resolved.device?.deviceId ?? null,
			labelsAvailable,
		};
	}

	async warmup(): Promise<VoiceMicrophoneWarmupResult> {
		const preferenceKey = JSON.stringify(this.getPreference());
		if (this.warmedPreferenceKey === preferenceKey) {
			return {
				warmed: true,
				alreadyWarm: true,
				skippedActiveCapture: false,
				deviceLabel: "",
				usedFallback: false,
			};
		}
		if (this.hasActiveCapture()) {
			return {
				warmed: false,
				alreadyWarm: false,
				skippedActiveCapture: true,
				deviceLabel: "",
				usedFallback: false,
			};
		}

		const capture = await this.acquire();
		stopStream(capture.stream);
		this.activeStreams.delete(capture.stream);
		this.warmedPreferenceKey = preferenceKey;
		return {
			warmed: true,
			alreadyWarm: false,
			skippedActiveCapture: false,
			deviceLabel: capture.deviceLabel,
			usedFallback: capture.usedFallback,
		};
	}

	async acquire(
		options: VoiceMicrophoneAcquireOptions = {},
	): Promise<VoiceMicrophoneCapture> {
		if (this.disposed) throw new Error("microphone manager is disposed");
		const preference = this.getPreference();
		const plan = await this.createPlan(preference, options.fullDuplex === true);

		try {
			const stream = await this.openHealthy(plan.constraints);
			const capture = this.describeCapture(stream, plan, false);
			this.persistRecoveredSelection(preference, capture, plan.status);
			this.activeStreams.add(stream);
			return capture;
		} catch (error) {
			if (!plan.deviceId) throw normalizeMicrophoneError(error);
			if (
				!isStaleVoiceMicrophoneDeviceError(error) &&
				!(error instanceof VoiceMicrophoneTrackUnavailableError)
			) {
				throw normalizeMicrophoneError(error);
			}
			this.rejectedDeviceId = plan.deviceId;
			const fallbackPlan = createDefaultPlan(options.fullDuplex === true);
			try {
				const stream = await this.openHealthy(fallbackPlan.constraints);
				this.activeStreams.add(stream);
				return this.describeCapture(stream, fallbackPlan, true);
			} catch (fallbackError) {
				throw normalizeMicrophoneError(fallbackError);
			}
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.mediaDevices.removeEventListener?.("devicechange", this.onDeviceChange);
		this.listeners.clear();
		this.activeStreams.clear();
	}

	private async createPlan(
		preference: VoiceMicrophonePreference,
		fullDuplex: boolean,
	): Promise<AcquisitionPlan> {
		if (preference.kind === "default") return createDefaultPlan(fullDuplex);

		let devices: MediaDeviceInfo[] = [];
		try {
			devices = await this.mediaDevices.enumerateDevices();
		} catch {
			if (
				preference.kind === "device" &&
				preference.deviceId !== this.rejectedDeviceId
			) {
				return createPinnedPlan(
					preference.deviceId,
					preference.deviceLabel,
					"exact",
					fullDuplex,
				);
			}
			return createDefaultPlan(fullDuplex);
		}

		const resolved = this.resolvePreference(devices, preference);
		if (
			resolved.device &&
			resolved.device.deviceId !== this.rejectedDeviceId
		) {
			return createPinnedPlan(
				resolved.device.deviceId,
				resolved.device.label,
				resolved.status,
				fullDuplex,
			);
		}

		if (
			preference.kind === "device" &&
			!devices.some(
				(device) => device.kind === "audioinput" && Boolean(device.label),
			) &&
			preference.deviceId !== this.rejectedDeviceId
		) {
			return createPinnedPlan(
				preference.deviceId,
				preference.deviceLabel,
				"exact",
				fullDuplex,
			);
		}
		return {
			...createDefaultPlan(fullDuplex),
			status: resolved.status,
		};
	}

	private resolvePreference(
		devices: Array<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>,
		preference: VoiceMicrophonePreference,
	): ResolvedSelection {
		if (preference.kind === "default") {
			return { device: null, status: "default" };
		}
		if (preference.kind === "built-in") {
			const builtIn = devices.find(
				(device) =>
					device.kind === "audioinput" &&
					device.deviceId !== "default" &&
					isBuiltInVoiceMicrophone(device.label),
			);
			return builtIn
				? { device: builtIn, status: "built-in" }
				: { device: null, status: "missing" };
		}
		return resolveVoiceMicrophoneSelection(
			devices,
			preference.deviceId,
			preference.deviceLabel,
		);
	}

	private async openHealthy(
		constraints: MediaStreamConstraints,
	): Promise<MediaStream> {
		let first: MediaStream | null = null;
		try {
			first = await this.requestMicrophone(constraints);
			if (
				await waitForVoiceMicrophoneTrack(first.getAudioTracks()[0])
			) {
				return first;
			}
		} catch (error) {
			if (first) stopStream(first);
			throw error;
		}

		let retry: MediaStream | null = null;
		let keepRetry = false;
		try {
			retry = await this.requestMicrophone(constraints);
			if (
				await waitForVoiceMicrophoneTrack(retry.getAudioTracks()[0])
			) {
				keepRetry = true;
				return retry;
			}
			throw new VoiceMicrophoneTrackUnavailableError(
				uiText("voice.microphonemanager.theMicrophoneConnectedButDidNotProvideUsableAudio"),
			);
		} catch (error) {
			if (error instanceof VoiceMicrophoneTrackUnavailableError) throw error;
			throw new VoiceMicrophoneTrackUnavailableError(
				uiText("voice.microphonemanager.microphoneRetryFailedUsableAudioInputCouldNotBe"),
			);
		} finally {
			if (retry && !keepRetry) stopStream(retry);
			if (first) stopStream(first);
		}
	}

	private requestMicrophone(
		constraints: MediaStreamConstraints,
	): Promise<MediaStream> {
		const pending = this.mediaDevices.getUserMedia(constraints);
		return new Promise((resolve, reject) => {
			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(
					new VoiceMicrophoneUnavailableError(
						uiText("voice.microphonemanager.timedOutWaitingForMicrophoneAccessCheckBrowserAnd"),
					),
				);
			}, MICROPHONE_REQUEST_TIMEOUT_MS);

			pending.then(
				(stream) => {
					if (settled) {
						stopStream(stream);
						return;
					}
					settled = true;
					clearTimeout(timeout);
					resolve(stream);
				},
				(error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					reject(error);
				},
			);
		});
	}

	private describeCapture(
		stream: MediaStream,
		plan: AcquisitionPlan,
		usedFallback: boolean,
	): VoiceMicrophoneCapture {
		const track = stream.getAudioTracks()[0];
		const settings = track?.getSettings?.();
		return {
			stream,
			deviceId: settings?.deviceId ?? plan.deviceId,
			deviceLabel: track?.label || plan.deviceLabel,
			selectionStatus: plan.status,
			usedFallback,
		};
	}

	private persistRecoveredSelection(
		preference: VoiceMicrophonePreference,
		capture: VoiceMicrophoneCapture,
		status: VoiceMicrophoneSelectionStatus,
	): void {
		if (
			preference.kind !== "device" ||
			!capture.deviceId ||
			(status !== "remapped" && Boolean(preference.deviceLabel))
		) {
			return;
		}
		this.preferenceStore.write({
			kind: "device",
			deviceId: capture.deviceId,
			deviceLabel: capture.deviceLabel || preference.deviceLabel,
		});
		this.emitChange();
	}

	private hasActiveCapture(): boolean {
		for (const stream of this.activeStreams) {
			const live = stream
				.getAudioTracks()
				.some((track) => track.readyState === "live");
			if (live) return true;
			this.activeStreams.delete(stream);
		}
		return false;
	}

	private emitChange(): void {
		for (const listener of this.listeners) listener();
	}
}

export class VoiceMicrophoneUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VoiceMicrophoneUnavailableError";
	}
}

class VoiceMicrophoneTrackUnavailableError extends VoiceMicrophoneUnavailableError {}

class BrowserVoiceMicrophonePreferenceStore
	implements VoiceMicrophonePreferenceStore
{
	read(): VoiceMicrophonePreference {
		if (typeof window === "undefined") return { kind: "built-in" };
		try {
			const raw = window.localStorage.getItem(PREFERENCE_STORAGE_KEY);
			if (!raw) return { kind: "built-in" };
			return normalizeVoiceMicrophonePreference(JSON.parse(raw));
		} catch {
			return { kind: "built-in" };
		}
	}

	write(preference: VoiceMicrophonePreference): void {
		if (typeof window === "undefined") return;
		try {
			window.localStorage.setItem(
				PREFERENCE_STORAGE_KEY,
				JSON.stringify(normalizeVoiceMicrophonePreference(preference)),
			);
		} catch {
			// Browser privacy settings can disable localStorage.
		}
	}
}

let browserManager: VoiceMicrophoneManager | null = null;

export function getVoiceMicrophoneManager(): VoiceMicrophoneManager {
	if (browserManager) return browserManager;
	if (typeof navigator === "undefined" || !navigator.mediaDevices) {
		throw new VoiceMicrophoneUnavailableError(uiText("voice.microphonemanager.microphoneDeviceManagementIsNotSupportedInThisEnvironment"));
	}
	browserManager = new VoiceMicrophoneManager(
		navigator.mediaDevices,
		new BrowserVoiceMicrophonePreferenceStore(),
	);
	return browserManager;
}

function audioConstraints(fullDuplex: boolean): MediaTrackConstraints {
	return fullDuplex
		? { ...FULL_DUPLEX_AUDIO_CONSTRAINTS }
		: { ...RAW_AUDIO_CONSTRAINTS };
}

function createDefaultPlan(fullDuplex = false): AcquisitionPlan {
	return {
		constraints: { audio: audioConstraints(fullDuplex) },
		deviceId: null,
		deviceLabel: "",
		status: "default",
	};
}

function createPinnedPlan(
	deviceId: string,
	deviceLabel: string,
	status: VoiceMicrophoneSelectionStatus,
	fullDuplex = false,
): AcquisitionPlan {
	return {
		constraints: {
			audio: {
				deviceId: { exact: deviceId },
				...audioConstraints(fullDuplex),
			},
		},
		deviceId,
		deviceLabel,
		status,
	};
}

export function normalizeVoiceMicrophonePreference(
	value: unknown,
): VoiceMicrophonePreference {
	if (!value || typeof value !== "object") return { kind: "built-in" };
	const record = value as Record<string, unknown>;
	if (record.kind === "built-in") return { kind: "built-in" };
	if (record.kind === "device" && typeof record.deviceId === "string") {
		return {
			kind: "device",
			deviceId: record.deviceId,
			deviceLabel:
				typeof record.deviceLabel === "string" ? record.deviceLabel : "",
		};
	}
	if (record.kind === "default") return { kind: "default" };
	return { kind: "built-in" };
}

function normalizeMicrophoneError(error: unknown): Error {
	if (error instanceof VoiceMicrophoneUnavailableError) return error;
	if (error instanceof DOMException) {
		if (error.name === "NotAllowedError") {
			return new VoiceMicrophoneUnavailableError(
				uiText("voice.microphonemanager.microphoneAccessWasDeniedAllowRecordingInBrowserAnd"),
			);
		}
		if (error.name === "NotFoundError") {
			return new VoiceMicrophoneUnavailableError(
				uiText("voice.microphonemanager.noAvailableMicrophoneWasFoundCheckTheDeviceConnection"),
			);
		}
		if (error.name === "OverconstrainedError") {
			return new VoiceMicrophoneUnavailableError(
				isStaleVoiceMicrophoneDeviceError(error)
					? uiText("voice.microphonemanager.theSelectedMicrophoneWasNotFoundItMayBe")
					: uiText("voice.microphonemanager.theMicrophoneDoesNotSupportTheRequestedRecordingSettings"),
			);
		}
		if (error.name === "NotReadableError") {
			return new VoiceMicrophoneUnavailableError(
				uiText("voice.microphonemanager.theMicrophoneIsBusyOrUnreadableCloseOtherRecording"),
			);
		}
	}
	return error instanceof Error
		? error
		: new VoiceMicrophoneUnavailableError(String(error));
}

function stopStream(stream: MediaStream | null): void {
	stream?.getTracks().forEach((track) => track.stop());
}
