import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
	ChatContext,
	ChatMessage,
	asLanguageCode,
	initializeLogger,
	stt,
	VAD,
	VADEventType,
	VADStream,
} from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import express from "express";
import { getAudioLocalRuntimeManager } from "../../server/audio/local-runtime.js";
import { speakPcm16Stream } from "../../server/audio/providers/tts.js";
import type { GoalService } from "../../server/goals/service.js";
import { resolveLiveKitVoiceConfig } from "../../server/voice/livekit-config.js";
import { LiveKitGoalClient } from "../../server/voice/livekit-goal-client.js";
import { TelomiVoiceInputSTT } from "../../server/voice/livekit-voice-input-stt.js";
import { PiGoalLiveKitLLM } from "../../server/voice/livekit-goal-llm.js";
import {
	MultilingualSentenceTokenizer,
	QwenLiveKitTTS,
} from "../../server/voice/livekit-qwen-tts.js";
import { createLiveKitTokenRouter } from "../../server/voice/livekit-token-api.js";
import {
	LiveKitSnapshotSTT,
} from "../../server/voice/livekit-snapshot-stt.js";
import type {
	StreamingTranscriptionAdapter,
	StreamingTranscriptionCallbacks,
} from "../../server/voice/streaming-transcription-adapter.js";

initializeLogger({ pretty: false, level: "fatal" });

test("LiveKit config uses local development defaults but requires production credentials", () => {
	assert.deepEqual(resolveLiveKitVoiceConfig({}), {
		serverUrl: "ws://127.0.0.1:7880",
		publicUrl: "ws://127.0.0.1:7880",
		apiKey: "devkey",
		apiSecret: "secret",
		bridgeSecret: "secret",
		telomiUrl: "http://127.0.0.1:8787",
	});
	assert.throws(
		() => resolveLiveKitVoiceConfig({ NODE_ENV: "production" }),
		/required in production/u,
	);
});

test("LiveKit token API returns a short-lived room token without exposing its secret", async () => {
	const app = express();
	app.use(express.json());
	const goals = {
		getGoal: (goalId: string) => (goalId === "goal-1" ? { id: goalId } : null),
	} as unknown as GoalService;
	app.use(
		createLiveKitTokenRouter(goals, () => ({
			serverUrl: "ws://livekit.internal:7880",
			publicUrl: "wss://voice.example.test",
			apiKey: "testkey",
			apiSecret: "testsecret-that-is-long-enough",
			bridgeSecret: "bridge-secret",
			telomiUrl: "http://127.0.0.1:8787",
		})),
	);
	const server = app.listen(0);
	await once(server, "listening");
	try {
		const address = server.address();
		assert(address && typeof address === "object");
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/goals/goal-1/voice/livekit/token`,
			{ method: "POST" },
		);
		assert.equal(response.status, 200);
		const body = (await response.json()) as Record<string, unknown>;
		assert.equal(body.serverUrl, "wss://voice.example.test");
		assert.match(String(body.roomName), /^telomi-voice-/u);
		assert.equal(String(body.participantToken).split(".").length, 3);
		assert.equal(JSON.stringify(body).includes("testsecret"), false);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

test("Pi Goal bridge client streams text deltas and aborts delivery when consumption stops", async () => {
	let capturedSignal: AbortSignal | undefined;
	const client = new LiveKitGoalClient(
		{
			telomiUrl: "http://telomi.test",
			bridgeSecret: "bridge-secret",
		},
		(async (_url, init) => {
			capturedSignal = init?.signal ?? undefined;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								'{"type":"text.delta","delta":"第一段"}\n{"type":"text.delta","delta":"第二段"}\n',
							),
						);
						controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch,
	);

	const received: string[] = [];
	for await (const delta of client.streamReply("goal-1", "你好")) {
		received.push(delta);
		break;
	}
	assert.deepEqual(received, ["第一段"]);
	assert.equal(capturedSignal?.aborted, true);
});

test("LiveKit final transcription reuses the Telomi voice input pipeline", async () => {
	let requestUrl = "";
	let requestBody = Buffer.alloc(0);
	const client = new LiveKitGoalClient(
		{
			telomiUrl: "http://telomi.test",
			bridgeSecret: "bridge-secret",
		},
		(async (url, init) => {
			requestUrl = String(url);
			requestBody = Buffer.from(await new Response(init?.body).arrayBuffer());
			assert.equal(init?.headers && new Headers(init.headers).get("content-type"), "audio/wav");
			return Response.json({
				text: "MFlow 使用 PostgreSQL。",
				rawText: "M F 使用 Postgre SQL。",
				cleanup: { requested: true, applied: true },
			});
		}) as typeof fetch,
	);
	const finalizer = new TelomiVoiceInputSTT("goal/voice", client, "zh");
	const event = await finalizer.recognize([
		new AudioFrame(new Int16Array([1, 2]), 16_000, 1, 2),
		new AudioFrame(new Int16Array([3, 4]), 16_000, 1, 2),
	]);

	assert.equal(
		requestUrl,
		"http://telomi.test/api/goals/goal%2Fvoice/voice/transcribe",
	);
	assert.equal(requestBody.toString("ascii", 0, 4), "RIFF");
	assert.equal(requestBody.readUInt32LE(40), 8);
	assert.deepEqual(
		Array.from(new Int16Array(requestBody.buffer, requestBody.byteOffset + 44, 4)),
		[1, 2, 3, 4],
	);
	assert.equal(event.alternatives?.[0].text, "MFlow 使用 PostgreSQL。");
});

test("Pi Goal Agent adapter exposes streamed Goal deltas through LiveKit's LLM contract", async () => {
	let receivedGoalId = "";
	let receivedTranscript = "";
	const adapter = new PiGoalLiveKitLLM("goal-voice", {
		async *streamReply(goalId, transcript) {
			receivedGoalId = goalId;
			receivedTranscript = transcript;
			yield "第一";
			yield "段";
		},
	});
	const chatCtx = ChatContext.empty();
	chatCtx.insert(
		ChatMessage.create({
			role: "user",
			content: "上一轮",
		}),
	);
	chatCtx.insert(
		ChatMessage.create({
			role: "assistant",
			content: "上一轮回答",
		}),
	);
	chatCtx.insert(
		ChatMessage.create({
			role: "user",
			content: "当前语音问题",
		}),
	);

	const result = await adapter.chat({ chatCtx }).collect();
	assert.equal(receivedGoalId, "goal-voice");
	assert.equal(receivedTranscript, "当前语音问题");
	assert.equal(result.text, "第一段");
	assert.equal(adapter.provider, "telomi");
	assert.equal(adapter.model, "goal-main-agent");
});

test("LiveKit snapshot STT publishes previews but commits one authoritative final", async () => {
	const finalizer = new AuthoritativeSTT();
	const provider = new LiveKitSnapshotSTT({
		model: "Qwen3-ASR-0.6B-CUDA",
		vad: new ImmediateTurnVAD(),
		finalizer,
		previewFactory: (callbacks) => new ImmediatePreviewAdapter(callbacks),
	});
	const stream = provider.stream();
	const frame = new AudioFrame(new Int16Array(320), 16_000, 1, 320);
	stream.pushFrame(frame);
	const start = await stream.next();
	const partial = await stream.next();
	stream.pushFrame(frame);
	stream.pushFrame(frame);

	const events = [start.value, partial.value];
	for await (const event of stream) {
		events.push(event);
		if (event.type === 2) break;
	}
	stream.close();
	await provider.close();

	assert.deepEqual(
		events.map((event) => event.type),
		[0, 1, 3, 2],
	);
	assert.equal(events[1]?.alternatives?.[0].text, "即时预览");
	assert.equal(events[3]?.alternatives?.[0].text, "权威最终文本");
	assert.equal(finalizer.recognizedFrameCount, 3);
});

test("LiveKit snapshot STT never commits a preview when finalization fails", async () => {
	const provider = new LiveKitSnapshotSTT({
		model: "Qwen3-ASR-0.6B-CUDA",
		vad: new ImmediateTurnVAD(),
		finalizer: new FailingSTT(),
		previewFactory: (callbacks) => new ImmediatePreviewAdapter(callbacks),
	});
	const stream = provider.stream();
	const frame = new AudioFrame(new Int16Array(320), 16_000, 1, 320);
	stream.pushFrame(frame);
	stream.pushFrame(frame);
	stream.pushFrame(frame);

	const events: stt.SpeechEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === stt.SpeechEventType.END_OF_SPEECH) break;
	}
	const nextEvent = await Promise.race([
		stream.next().then((result) => result.value?.type),
		new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), 20),
		),
	]);
	stream.close();
	await provider.close();

	assert.equal(nextEvent, "timeout");
});

test("Qwen LiveKit TTS exposes PCM frames before the provider finishes its stream", async () => {
	let sourceFinished = false;
	const pcm = new Uint8Array(4_000);
	for (let index = 0; index < pcm.length; index += 2) {
		pcm[index] = index % 251;
	}
	const tts = new QwenLiveKitTTS({
		ensureReady: async () => undefined,
		sampleRate: 44_100,
		synthesize: async function* () {
			yield pcm;
			await new Promise((resolve) => setTimeout(resolve, 40));
			sourceFinished = true;
			yield new Uint8Array(960);
		},
	});
	const stream = tts.synthesize("实时输出测试");
	const first = await stream.next();
	assert.equal(first.done, false);
	assert.equal(sourceFinished, false);
	assert.equal(first.value.frame.sampleRate, 44_100);
	assert.equal(first.value.frame.channels, 1);

	const remaining = [];
	for await (const event of stream) remaining.push(event);
	assert.equal(sourceFinished, true);
	assert.equal(remaining.at(-1)?.final, true);
});

test("TTS sends a voice name the listing does not carry unchanged", async () => {
	const originalFetch = globalThis.fetch;
	// The request body is under test, not whether the bundled service is running.
	const runtime = getAudioLocalRuntimeManager();
	const originalPrepare = runtime.prepare;
	runtime.prepare = async () => undefined;
	let requestBody: Record<string, unknown> | undefined;
	globalThis.fetch = (async (_input, init) => {
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(new Uint8Array([1, 2]));
	}) as typeof fetch;
	try {
		for await (const _chunk of speakPcm16Stream({
			text: "测试",
			audio: { connection: "telomi-audio", model: "voice-model", voice: "telomi_test_normalized", rate: 1, baseUrl: "http://127.0.0.1:9595/v1" },
		})) {
			// Drain the mocked response.
		}
		assert.equal(requestBody?.voice, "telomi_test_normalized");
	} finally {
		globalThis.fetch = originalFetch;
		runtime.prepare = originalPrepare;
	}
});

test("LiveKit TTS segments mixed-language text at native sentence boundaries", async () => {
	const tokenizer = new MultilingualSentenceTokenizer();
	assert.deepEqual(
		tokenizer.tokenize("第一句。Second sentence! ¿Tercera frase? 第四句！"),
		["第一句。", "Second sentence!", "¿Tercera frase?", "第四句！"],
	);

	const stream = tokenizer.stream();
	stream.pushText("第一段中文。Second sentence!");
	const first = await Promise.race([
		stream.next(),
		new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), 50),
		),
	]);
	stream.close();
	assert.notEqual(first, "timeout");
	assert.equal(
		typeof first === "string" || first.done ? "" : first.value.token,
		"第一段中文。",
	);
});

class ImmediateTurnVAD extends VAD {
	label = "test.ImmediateTurnVAD";

	constructor() {
		super({ updateInterval: 20 });
	}

	stream(): VADStream {
		return new ImmediateTurnVADStream(this);
	}
}

class AuthoritativeSTT extends stt.STT {
	label = "test.AuthoritativeSTT";
	recognizedFrameCount = 0;

	constructor() {
		super({ streaming: false, interimResults: false });
	}

	protected async _recognize(
		frame: AudioFrame | AudioFrame[],
	): Promise<stt.SpeechEvent> {
		this.recognizedFrameCount = Array.isArray(frame) ? frame.length : 1;
		return {
			type: stt.SpeechEventType.FINAL_TRANSCRIPT,
			alternatives: [
				{
					language: asLanguageCode("zh"),
					text: "权威最终文本",
					startTime: 0,
					endTime: 0,
					confidence: 1,
				},
			],
		};
	}

	stream(): stt.SpeechStream {
		throw new Error("not used");
	}
}

class FailingSTT extends AuthoritativeSTT {
	override label = "test.FailingSTT";

	protected override async _recognize(): Promise<stt.SpeechEvent> {
		throw new Error("authoritative finalizer failed");
	}
}

class ImmediatePreviewAdapter implements StreamingTranscriptionAdapter {
	readonly provider = "test-preview";
	readonly model = "test-preview";
	readonly #callbacks: StreamingTranscriptionCallbacks;
	#sent = false;

	constructor(callbacks: StreamingTranscriptionCallbacks) {
		this.#callbacks = callbacks;
	}

	async connect(): Promise<void> {
		this.#callbacks.onReady?.();
	}

	sendAudio(): boolean {
		if (!this.#sent) {
			this.#sent = true;
			this.#callbacks.onPartial?.("即时预览");
		}
		return true;
	}

	async finish(): Promise<string> {
		return "即时预览";
	}

	cancel(): void {}

	close(): void {}
}

class ImmediateTurnVADStream extends VADStream {
	constructor(vad: VAD) {
		super(vad);
		void this.forward();
	}

	private async forward(): Promise<void> {
		let frameIndex = 0;
		const frames: AudioFrame[] = [];
		while (true) {
			const { done, value } = await this.inputReader.read();
			if (done) break;
			if (!(value instanceof AudioFrame)) continue;
			frames.push(value);
			frameIndex += 1;
			const type =
				frameIndex === 1
					? VADEventType.START_OF_SPEECH
					: frameIndex === 3
						? VADEventType.END_OF_SPEECH
						: VADEventType.INFERENCE_DONE;
			this.sendVADEvent({
				type,
				samplesIndex: frameIndex * value.samplesPerChannel,
				timestamp: Date.now(),
				speechDuration: frameIndex * 20,
				silenceDuration: type === VADEventType.END_OF_SPEECH ? 350 : 0,
				frames:
					type === VADEventType.END_OF_SPEECH ? [...frames] : [value],
				probability: type === VADEventType.END_OF_SPEECH ? 0 : 1,
				inferenceDuration: 0,
				speaking: type !== VADEventType.END_OF_SPEECH,
				rawAccumulatedSilence: 0,
				rawAccumulatedSpeech: 0,
			});
		}
	}
}
