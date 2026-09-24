import { fileURLToPath } from "node:url";
import {
	cli,
	defineAgent,
	type JobProcess,
	ServerOptions,
	tts,
	voice,
} from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { resolveSpeechConfiguration } from "./configuration.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { LiveKitGoalClient } from "./livekit-goal-client.js";
import { PiGoalLiveKitLLM } from "./livekit-goal-llm.js";
import {
	LIVEKIT_VOICE_AGENT_NAME,
	resolveLiveKitVoiceConfig,
} from "./livekit-config.js";
import {
	MultilingualSentenceTokenizer,
	QwenLiveKitTTS,
} from "./livekit-qwen-tts.js";
import { LiveKitSnapshotSTT } from "./livekit-snapshot-stt.js";
import { TelomiVoiceInputSTT } from "./livekit-voice-input-stt.js";

interface ProcessData {
	vad?: Awaited<ReturnType<typeof silero.VAD.load>>;
}

interface VoiceSessionData {
	goalId: string;
	language: string;
}

export default defineAgent<ProcessData>({
	prewarm: async (proc: JobProcess<ProcessData>) => {
		proc.userData.vad = await silero.VAD.load({
			minSilenceDuration: 350,
		});
	},
	entry: async (ctx) => {
		const { goalId, language } = readMetadata(ctx.job.metadata);
		await ctx.connect();
		const config = resolveLiveKitVoiceConfig();
		const vad = ctx.proc.userData.vad;
		if (!vad) throw new Error("LiveKit worker VAD was not prewarmed");
		const goalClient = new LiveKitGoalClient(config);
		const speech = resolveSpeechConfiguration();
		const session = new voice.AgentSession<VoiceSessionData>({
			userData: {
				goalId,
				language,
			},
			vad,
			stt: new LiveKitSnapshotSTT({
				vad,
				finalizer: new TelomiVoiceInputSTT(goalId, goalClient, language),
				model: speech.local?.model ?? "",
				...(language === "auto" ? {} : { language }),
			}),
			llm: new PiGoalLiveKitLLM(goalId, goalClient),
			tts: new tts.StreamAdapter(
				new QwenLiveKitTTS(),
				new MultilingualSentenceTokenizer(),
			),
			turnHandling: {
				turnDetection: "vad",
				endpointing: {
					minDelay: 350,
				},
				preemptiveGeneration: {
					preemptiveTts: true,
				},
			},
		});
		const agent = voice.Agent.create<VoiceSessionData>({
			instructions: renderAgentPrompt("main", "voice-livekit", "instructions").content,
		});

		await session.start({
			agent,
			room: ctx.room,
			record: false,
		});
	},
});

function readMetadata(metadata: string | undefined): VoiceSessionData {
	if (!metadata) throw new Error("Voice participant metadata is missing");
	const parsed = JSON.parse(metadata) as { goalId?: unknown; language?: unknown };
	if (typeof parsed.goalId !== "string" || !parsed.goalId.trim()) {
		throw new Error("Voice participant goalId is missing");
	}
	return {
		goalId: parsed.goalId,
		language: typeof parsed.language === "string" && parsed.language.trim() ? parsed.language : "auto",
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const config = resolveLiveKitVoiceConfig();
	cli.runApp(
		new ServerOptions({
			agent: import.meta.filename,
			wsURL: config.serverUrl,
			apiKey: config.apiKey,
			apiSecret: config.apiSecret,
			agentName: LIVEKIT_VOICE_AGENT_NAME,
			loadFunc:
				process.env.NODE_ENV === "production"
					? undefined
					: async () => 0,
			loadThreshold:
				process.env.NODE_ENV === "production"
					? undefined
					: Number.POSITIVE_INFINITY,
		}),
	);
}
