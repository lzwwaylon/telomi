import { randomUUID } from "node:crypto";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";
import { Router } from "express";
import { AccessToken } from "livekit-server-sdk";
import type { LiveKitVoiceConnection } from "../../shared/voice-livekit.js";
import type { GoalService } from "../goals/service.js";
import {
	LIVEKIT_VOICE_AGENT_NAME,
	resolveLiveKitVoiceConfig,
	type LiveKitVoiceConfig,
} from "./livekit-config.js";
import { loadAudioSettings } from "../audio/providers/settings.js";
import { voiceLanguageHint } from "../../shared/voice-languages.js";
import { toErrorMessage } from "../lib/values.js";

export function createLiveKitTokenRouter(
	goals: GoalService,
	resolveConfig: () => LiveKitVoiceConfig = resolveLiveKitVoiceConfig,
): Router {
	const router = Router();

	router.post("/api/goals/:goalId/voice/livekit/token", async (req, res) => {
		const goalId = req.params.goalId;
		if (!goalId || !goals.getGoal(goalId)) {
			res.status(404).json({ error: "Goal not found" });
			return;
		}

		try {
			const config = resolveConfig();
			const language = voiceLanguageHint(loadAudioSettings().sttLanguage) ?? "auto";
			const metadata = JSON.stringify({ goalId, language });
			const roomName = `telomi-voice-${randomUUID()}`;
			const token = new AccessToken(config.apiKey, config.apiSecret, {
				identity: `telomi-web-${randomUUID()}`,
				name: "Telomi voice user",
				metadata,
				ttl: "10m",
			});
			token.addGrant({
				room: roomName,
				roomJoin: true,
				canPublish: true,
				canSubscribe: true,
				canPublishData: true,
			});
			token.roomConfig = new RoomConfiguration({
				agents: [
					new RoomAgentDispatch({
						agentName: LIVEKIT_VOICE_AGENT_NAME,
						metadata,
					}),
				],
			});

			const body: LiveKitVoiceConnection = {
				serverUrl: config.publicUrl,
				participantToken: await token.toJwt(),
				roomName,
			};
			res.setHeader("Cache-Control", "no-store");
			res.json(body);
		} catch (error) {
			res.status(503).json({
				error: toErrorMessage(error),
			});
		}
	});

	return router;
}
