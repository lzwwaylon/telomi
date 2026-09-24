import assert from "node:assert/strict";
import test from "node:test";
import {
	buildVoiceMicrophoneRequestHeaders,
	VOICE_MICROPHONE_DEVICE_ID_HEADER,
	VOICE_MICROPHONE_DEVICE_LABEL_HEADER,
} from "../../shared/voice-microphone.js";
import { parseVoiceMicrophoneRequestHeaders } from "../../server/voice/microphone-evidence.js";
import {
	isBuiltInVoiceMicrophone,
	isStaleVoiceMicrophoneDeviceError,
	normalizeVoiceMicrophonePreference,
	resolveVoiceMicrophoneSelection,
	VoiceMicrophoneManager,
	VoiceMicrophoneUnavailableError,
	type VoiceMicrophonePreference,
	type VoiceMicrophonePreferenceStore,
	waitForVoiceMicrophoneTrack,
} from "../../web/src/features/voice/VoiceMicrophoneManager.js";

const mic = (deviceId: string, label: string) =>
	({ kind: "audioinput", deviceId, label }) as MediaDeviceInfo;

const overconstrainedError = (constraint?: string) => {
	const error = new DOMException("constraint failed", "OverconstrainedError") as DOMException & {
		constraint?: string;
	};
	if (constraint !== undefined) error.constraint = constraint;
	return error;
};

test("fresh microphone preferences follow OpenWhispr's built-in-first default", () => {
	assert.deepEqual(normalizeVoiceMicrophonePreference(undefined), {
		kind: "built-in",
	});
	assert.deepEqual(normalizeVoiceMicrophonePreference({ kind: "unknown" }), {
		kind: "built-in",
	});
	assert.deepEqual(normalizeVoiceMicrophonePreference({ kind: "default" }), {
		kind: "default",
	});
});

test("stale microphone detection retains the pinned OpenWhispr boundary", () => {
	assert.equal(isStaleVoiceMicrophoneDeviceError(overconstrainedError("deviceId")), true);
	assert.equal(isStaleVoiceMicrophoneDeviceError(overconstrainedError("")), true);
	assert.equal(isStaleVoiceMicrophoneDeviceError(overconstrainedError()), true);
	assert.equal(isStaleVoiceMicrophoneDeviceError(overconstrainedError("channelCount")), false);
	assert.equal(
		isStaleVoiceMicrophoneDeviceError({
			name: "OverconstrainedError",
			get constraint() {
				return "deviceId";
			},
		}),
		true,
	);
	for (const value of [
		{ name: "NotFoundError" },
		{ name: "NotAllowedError" },
		{ name: "NotReadableError" },
		new Error("boom"),
		{ constraint: "deviceId" },
		null,
		undefined,
	]) {
		assert.equal(isStaleVoiceMicrophoneDeviceError(value), false);
	}
});

test("microphone request evidence hashes the device ID and round-trips Unicode labels", () => {
	const headers = buildVoiceMicrophoneRequestHeaders({
		deviceId: "origin-scoped-device-123",
		deviceLabel: "“iPhone ”的麦克风",
		selectionStatus: "exact",
		usedFallback: false,
	});
	assert.equal(
		headers[VOICE_MICROPHONE_DEVICE_LABEL_HEADER],
		encodeURIComponent("“iPhone ”的麦克风"),
	);
	assert.deepEqual(
		parseVoiceMicrophoneRequestHeaders(headers),
		{
			deviceLabel: "“iPhone ”的麦克风",
			deviceFingerprint:
				"03726da7b71d9ff9625322948fcfddeaac17a12983254aa624922310cd392ff8",
			selectionStatus: "exact",
			usedFallback: false,
		},
	);
	assert.equal(
		JSON.stringify(parseVoiceMicrophoneRequestHeaders(headers)).includes(
			"origin-scoped-device-123",
		),
		false,
	);
});

test("microphone request evidence rejects malformed or oversized metadata", () => {
	assert.equal(
		parseVoiceMicrophoneRequestHeaders({
			...buildVoiceMicrophoneRequestHeaders({
				deviceId: "device-id",
				deviceLabel: "Studio Mic",
				selectionStatus: "exact",
				usedFallback: true,
			}),
			"x-telomi-voice-microphone-selection": "forged",
		}),
		null,
	);
	assert.equal(
		parseVoiceMicrophoneRequestHeaders({
			[VOICE_MICROPHONE_DEVICE_ID_HEADER]: "device-id",
			[VOICE_MICROPHONE_DEVICE_LABEL_HEADER]: "%E0%A4%A",
			"x-telomi-voice-microphone-selection": "default",
			"x-telomi-voice-microphone-fallback": "0",
		}),
		null,
	);
	assert.equal(
		parseVoiceMicrophoneRequestHeaders(
			buildVoiceMicrophoneRequestHeaders({
				deviceId: "device-id",
				deviceLabel: "x".repeat(201),
				selectionStatus: "default",
				usedFallback: false,
			}),
		),
		null,
	);
});

test("microphone selection retains the OpenWhispr reconciliation contract", () => {
	const saved = mic("saved-id", "Studio Mic");
	assert.deepEqual(
		resolveVoiceMicrophoneSelection([saved], "saved-id", "Studio Mic"),
		{ device: saved, status: "exact" },
	);

	const rotated = mic("new-id", "Studio Mic");
	assert.deepEqual(
		resolveVoiceMicrophoneSelection([rotated], "old-id", "Studio Mic"),
		{ device: rotated, status: "remapped" },
	);
	assert.deepEqual(
		resolveVoiceMicrophoneSelection(
			[mic("first", "USB Audio"), mic("second", "USB Audio")],
			"old-id",
			"USB Audio",
		),
		{ device: null, status: "ambiguous" },
	);
	assert.deepEqual(
		resolveVoiceMicrophoneSelection([], "old-id", "Studio Mic"),
		{ device: null, status: "missing" },
	);
	assert.deepEqual(
		resolveVoiceMicrophoneSelection([rotated], "old-id", ""),
		{ device: null, status: "missing" },
	);
	assert.deepEqual(
		resolveVoiceMicrophoneSelection(
			[
				{
					kind: "audiooutput",
					deviceId: "speaker",
					label: "Studio Mic",
				} as MediaDeviceInfo,
			],
			"old-id",
			"Studio Mic",
		),
		{ device: null, status: "missing" },
	);
	assert.deepEqual(
		resolveVoiceMicrophoneSelection([saved], "", ""),
		{ device: null, status: "default" },
	);
});

test("built-in microphone detection matches OpenWhispr device heuristics", () => {
	assert.equal(isBuiltInVoiceMicrophone("MacBook Microphone"), true);
	assert.equal(isBuiltInVoiceMicrophone("Internal Microphone"), true);
	assert.equal(isBuiltInVoiceMicrophone("USB Microphone"), false);
	assert.equal(isBuiltInVoiceMicrophone("AirPods Microphone"), false);
	assert.equal(isBuiltInVoiceMicrophone("Studio Input"), false);
});

test("track readiness handles live, ended, unmute and timeout without listener leaks", async () => {
	const live = new FakeTrack();
	assert.equal(await waitForVoiceMicrophoneTrack(live.asTrack()), true);
	assert.equal(live.listenerCount, 0);

	const ended = new FakeTrack({ readyState: "ended" });
	assert.equal(await waitForVoiceMicrophoneTrack(ended.asTrack()), false);
	assert.equal(ended.listenerCount, 0);
	assert.equal(await waitForVoiceMicrophoneTrack(null), false);

	const waking = new FakeTrack({ muted: true });
	const pending = waitForVoiceMicrophoneTrack(waking.asTrack(), 50);
	waking.muted = false;
	waking.fire("unmute");
	assert.equal(await pending, true);
	assert.equal(waking.listenerCount, 0);

	const silent = new FakeTrack({ muted: true });
	assert.equal(await waitForVoiceMicrophoneTrack(silent.asTrack(), 1), false);
	assert.equal(silent.listenerCount, 0);
});

test("manager requests OpenWhispr raw constraints from the default microphone", async () => {
	const store = new MemoryPreferenceStore({ kind: "default" });
	const media = new FakeMediaDevices([], [new FakeStream()]);
	const manager = new VoiceMicrophoneManager(media, store);

	const capture = await manager.acquire();
	assert.equal(capture.usedFallback, false);
	assert.equal(capture.selectionStatus, "default");
	assert.deepEqual(media.constraints, [
		{
			audio: {
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false,
				channelCount: 2,
			},
		},
	]);
	stopCapture(capture.stream);
	manager.dispose();
});

test("full-duplex microphone capture enables native echo processing", async () => {
	const media = new FakeMediaDevices([], [new FakeStream()]);
	const manager = new VoiceMicrophoneManager(
		media,
		new MemoryPreferenceStore({ kind: "default" }),
	);

	const capture = await manager.acquire({ fullDuplex: true });
	assert.deepEqual(media.constraints, [
		{
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				channelCount: 1,
			},
		},
	]);
	stopCapture(capture.stream);
	manager.dispose();
});

test("manager pins an exact selected device and persists a rotated ID by label", async () => {
	const store = new MemoryPreferenceStore({
		kind: "device",
		deviceId: "old-id",
		deviceLabel: "Studio Mic",
	});
	const media = new FakeMediaDevices(
		[mic("new-id", "Studio Mic")],
		[new FakeStream(new FakeTrack({ label: "Studio Mic", deviceId: "new-id" }))],
	);
	const manager = new VoiceMicrophoneManager(media, store);

	const capture = await manager.acquire();
	assert.equal(capture.selectionStatus, "remapped");
	assert.deepEqual(
		(media.constraints[0]?.audio as MediaTrackConstraints).deviceId,
		{ exact: "new-id" },
	);
	assert.deepEqual(store.read(), {
		kind: "device",
		deviceId: "new-id",
		deviceLabel: "Studio Mic",
	});
	stopCapture(capture.stream);
	manager.dispose();
});

test("manager prefers a built-in input and falls back when no built-in mic exists", async () => {
	const builtInStore = new MemoryPreferenceStore({ kind: "built-in" });
	const builtInMedia = new FakeMediaDevices(
		[mic("usb", "USB Microphone"), mic("internal", "MacBook Microphone")],
		[new FakeStream(new FakeTrack({ deviceId: "internal", label: "MacBook Microphone" }))],
	);
	const builtInManager = new VoiceMicrophoneManager(builtInMedia, builtInStore);
	const builtIn = await builtInManager.acquire();
	assert.equal(builtIn.selectionStatus, "built-in");
	assert.deepEqual(
		(builtInMedia.constraints[0]?.audio as MediaTrackConstraints).deviceId,
		{ exact: "internal" },
	);
	stopCapture(builtIn.stream);
	builtInManager.dispose();

	const missingMedia = new FakeMediaDevices(
		[mic("usb", "USB Microphone")],
		[new FakeStream()],
	);
	const missingManager = new VoiceMicrophoneManager(
		missingMedia,
		new MemoryPreferenceStore({ kind: "built-in" }),
	);
	const fallback = await missingManager.acquire();
	assert.equal(fallback.selectionStatus, "missing");
	assert.equal(
		(missingMedia.constraints[0]?.audio as MediaTrackConstraints).deviceId,
		undefined,
	);
	stopCapture(fallback.stream);
	missingManager.dispose();
});

test("manager retries a dead selected device, then falls back to the default mic", async () => {
	const first = new FakeStream(new FakeTrack({ readyState: "ended" }));
	const retry = new FakeStream(new FakeTrack({ readyState: "ended" }));
	const fallback = new FakeStream(
		new FakeTrack({ deviceId: "default-id", label: "Default Mic" }),
	);
	const media = new FakeMediaDevices(
		[mic("bad-id", "Silent Mic")],
		[first, retry, fallback],
	);
	const manager = new VoiceMicrophoneManager(
		media,
		new MemoryPreferenceStore({
			kind: "device",
			deviceId: "bad-id",
			deviceLabel: "Silent Mic",
		}),
	);

	const capture = await manager.acquire();
	assert.equal(capture.usedFallback, true);
	assert.equal(capture.deviceLabel, "Default Mic");
	assert.equal(first.track.stopCount, 1);
	assert.equal(retry.track.stopCount, 1);
	assert.equal(media.constraints.length, 3);
	assert.deepEqual(
		(media.constraints[0]?.audio as MediaTrackConstraints).deviceId,
		{ exact: "bad-id" },
	);
	assert.deepEqual(
		(media.constraints[1]?.audio as MediaTrackConstraints).deviceId,
		{ exact: "bad-id" },
	);
	assert.equal(
		(media.constraints[2]?.audio as MediaTrackConstraints).deviceId,
		undefined,
	);
	stopCapture(capture.stream);
	manager.dispose();
});

test("manager falls back only when the pinned deviceId is stale", async () => {
	const store = new MemoryPreferenceStore({
		kind: "device",
		deviceId: "stale-id",
		deviceLabel: "Studio Mic",
	});
	const media = new FakeMediaDevices(
		[mic("stale-id", "Studio Mic")],
		[
			overconstrainedError("deviceId"),
			new FakeStream(new FakeTrack({ deviceId: "default-id", label: "Default Mic" })),
		],
	);
	const manager = new VoiceMicrophoneManager(media, store);

	const capture = await manager.acquire();
	assert.equal(capture.usedFallback, true);
	assert.equal(capture.deviceLabel, "Default Mic");
	assert.equal(media.constraints.length, 2);
	assert.deepEqual(
		(media.constraints[0]?.audio as MediaTrackConstraints).deviceId,
		{ exact: "stale-id" },
	);
	assert.equal(
		(media.constraints[1]?.audio as MediaTrackConstraints).deviceId,
		undefined,
	);
	stopCapture(capture.stream);
	manager.dispose();
});

test("manager does not hide a permission denial behind a default-device retry", async () => {
	const media = new FakeMediaDevices(
		[mic("selected", "Studio Mic")],
		[
			new DOMException("permission denied", "NotAllowedError"),
			new FakeStream(new FakeTrack({ deviceId: "default-id", label: "Default Mic" })),
		],
	);
	const manager = new VoiceMicrophoneManager(
		media,
		new MemoryPreferenceStore({
			kind: "device",
			deviceId: "selected",
			deviceLabel: "Studio Mic",
		}),
	);

	await assert.rejects(
		() => manager.acquire(),
		(error: unknown) =>
			error instanceof VoiceMicrophoneUnavailableError &&
			error.message.includes("权限被拒绝"),
	);
	assert.equal(media.constraints.length, 1);
	manager.dispose();
});

test("manager does not reject a valid device for a non-device constraint failure", async () => {
	const media = new FakeMediaDevices(
		[mic("selected", "Studio Mic")],
		[
			overconstrainedError("channelCount"),
			new FakeStream(new FakeTrack({ deviceId: "default-id", label: "Default Mic" })),
		],
	);
	const manager = new VoiceMicrophoneManager(
		media,
		new MemoryPreferenceStore({
			kind: "device",
			deviceId: "selected",
			deviceLabel: "Studio Mic",
		}),
	);

	await assert.rejects(() => manager.acquire(), VoiceMicrophoneUnavailableError);
	assert.equal(media.constraints.length, 1);
	manager.dispose();
});

test("devicechange clears a rejected device and invalidates warmup", async () => {
	const store = new MemoryPreferenceStore({
		kind: "device",
		deviceId: "selected",
		deviceLabel: "Studio Mic",
	});
	const media = new FakeMediaDevices(
		[mic("selected", "Studio Mic")],
		[
			new FakeStream(new FakeTrack({ readyState: "ended" })),
			new FakeStream(new FakeTrack({ readyState: "ended" })),
			new FakeStream(new FakeTrack({ label: "Default Mic" })),
			new FakeStream(new FakeTrack({ label: "Default Mic" })),
			new FakeStream(
				new FakeTrack({
					deviceId: "selected",
					label: "Studio Mic",
				}),
			),
		],
	);
	const manager = new VoiceMicrophoneManager(media, store);

	const fallback = await manager.acquire();
	assert.equal(fallback.usedFallback, true);
	stopCapture(fallback.stream);
	const warm = await manager.warmup();
	assert.equal(warm.warmed, true);
	assert.equal(
		(media.constraints[3]?.audio as MediaTrackConstraints).deviceId,
		undefined,
		"rejected device must be skipped for this browser session",
	);

	media.fireDeviceChange();
	const afterChange = await manager.warmup();
	assert.equal(afterChange.alreadyWarm, false);
	assert.deepEqual(
		(media.constraints[4]?.audio as MediaTrackConstraints).deviceId,
		{ exact: "selected" },
	);
	manager.dispose();
});

test("manager throws a clear error when default and fallback streams are unusable", async () => {
	const media = new FakeMediaDevices(
		[],
		[
			new FakeStream(new FakeTrack({ readyState: "ended" })),
			new FakeStream(new FakeTrack({ readyState: "ended" })),
		],
	);
	const manager = new VoiceMicrophoneManager(
		media,
		new MemoryPreferenceStore({ kind: "default" }),
	);

	await assert.rejects(
		() => manager.acquire(),
		(error: unknown) =>
			error instanceof VoiceMicrophoneUnavailableError &&
			error.message.includes("没有传递可用音频"),
	);
	manager.dispose();
});

class MemoryPreferenceStore implements VoiceMicrophonePreferenceStore {
	constructor(private value: VoiceMicrophonePreference) {}

	read(): VoiceMicrophonePreference {
		return this.value;
	}

	write(preference: VoiceMicrophonePreference): void {
		this.value = preference;
	}
}

class FakeTrack extends EventTarget {
	muted: boolean;
	readyState: MediaStreamTrackState;
	label: string;
	deviceId: string;
	listenerCount = 0;
	stopCount = 0;

	constructor({
		muted = false,
		readyState = "live",
		label = "",
		deviceId = "",
	}: {
		muted?: boolean;
		readyState?: MediaStreamTrackState;
		label?: string;
		deviceId?: string;
	} = {}) {
		super();
		this.muted = muted;
		this.readyState = readyState;
		this.label = label;
		this.deviceId = deviceId;
	}

	override addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		this.listenerCount += 1;
		super.addEventListener(type, callback, options);
	}

	override removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		this.listenerCount -= 1;
		super.removeEventListener(type, callback, options);
	}

	stop(): void {
		this.stopCount += 1;
		this.readyState = "ended";
	}

	getSettings(): MediaTrackSettings {
		return { deviceId: this.deviceId };
	}

	fire(type: "unmute" | "ended"): void {
		this.dispatchEvent(new Event(type));
	}

	asTrack(): MediaStreamTrack {
		return this as unknown as MediaStreamTrack;
	}
}

class FakeStream {
	readonly track: FakeTrack;

	constructor(track = new FakeTrack()) {
		this.track = track;
	}

	getAudioTracks(): MediaStreamTrack[] {
		return [this.track.asTrack()];
	}

	getTracks(): MediaStreamTrack[] {
		return [this.track.asTrack()];
	}

	asStream(): MediaStream {
		return this as unknown as MediaStream;
	}
}

class FakeMediaDevices extends EventTarget {
	readonly constraints: MediaStreamConstraints[] = [];
	private readonly results: Array<FakeStream | Error>;

	constructor(
		private readonly devices: MediaDeviceInfo[],
		results: Array<FakeStream | Error>,
	) {
		super();
		this.results = [...results];
	}

	async enumerateDevices(): Promise<MediaDeviceInfo[]> {
		return this.devices;
	}

	async getUserMedia(
		constraints: MediaStreamConstraints,
	): Promise<MediaStream> {
		this.constraints.push(constraints);
		const result = this.results.shift();
		if (!result) throw new Error("No fake stream queued");
		if (result instanceof Error) throw result;
		return result.asStream();
	}

	fireDeviceChange(): void {
		this.dispatchEvent(new Event("devicechange"));
	}
}

function stopCapture(stream: MediaStream): void {
	stream.getTracks().forEach((track) => track.stop());
}
