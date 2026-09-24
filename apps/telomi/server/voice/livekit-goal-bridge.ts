import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type {
	LiveKitGoalReplyEvent,
	LiveKitGoalReplyRequest,
} from "../../shared/voice-livekit.js";
import type { GoalService } from "../goals/service.js";
import {
	createGoalAgentVoiceHost,
	streamGoalAgentReply,
} from "./goal-agent-voice-adapter.js";
import {
	resolveLiveKitVoiceConfig,
	type LiveKitVoiceConfig,
} from "./livekit-config.js";
import { toErrorMessage } from "../lib/values.js";

const MAX_TRANSCRIPT_CODE_POINTS = 12_000;

export function createLiveKitGoalBridgeRouter(
	goals: GoalService,
	resolveConfig: () => LiveKitVoiceConfig = resolveLiveKitVoiceConfig,
): Router {
	const router = Router();
	const host = createGoalAgentVoiceHost(goals);

	router.post("/api/internal/livekit/goals/:goalId/reply", async (req, res) => {
		let config: LiveKitVoiceConfig;
		try {
			config = resolveConfig();
			assertBearerToken(req.get("authorization"), config.bridgeSecret);
		} catch (error) {
			res.status(401).json({
				error: toErrorMessage(error),
			});
			return;
		}

		const goalId = req.params.goalId;
		if (!goalId || !goals.getGoal(goalId)) {
			res.status(404).json({ error: "Goal not found" });
			return;
		}
		const body =
			req.body && typeof req.body === "object" && !Array.isArray(req.body)
				? (req.body as Partial<LiveKitGoalReplyRequest>)
				: {};
		const transcript =
			typeof body.transcript === "string" ? body.transcript.trim() : "";
		if (!transcript) {
			res.status(400).json({ error: "Transcript is required" });
			return;
		}
		if (Array.from(transcript).length > MAX_TRANSCRIPT_CODE_POINTS) {
			res.status(400).json({
				error: `Transcript must contain at most ${MAX_TRANSCRIPT_CODE_POINTS} Unicode code points`,
			});
			return;
		}

		const controller = new AbortController();
		const abort = () => controller.abort();
		req.once("aborted", abort);
		res.once("close", abort);
		try {
			res.status(200);
			res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("X-Accel-Buffering", "no");
			res.flushHeaders();
			for await (const delta of streamGoalAgentReply(host, {
				goalId,
				transcript,
				signal: controller.signal,
			})) {
				if (controller.signal.aborted || res.destroyed) return;
				const event: LiveKitGoalReplyEvent = { type: "text.delta", delta };
				res.write(`${JSON.stringify(event)}\n`);
			}
			const completed: LiveKitGoalReplyEvent = { type: "text.completed" };
			res.write(`${JSON.stringify(completed)}\n`);
			res.end();
		} catch (error) {
			if (res.headersSent) {
				console.warn(
					`[voice/livekit-bridge] ${toErrorMessage(error)}`,
				);
				res.end();
			} else {
				res.status(502).json({
					error: toErrorMessage(error),
				});
			}
		} finally {
			req.off("aborted", abort);
			res.off("close", abort);
		}
	});

	return router;
}

function assertBearerToken(header: string | undefined, expected: string): void {
	const supplied = header?.match(/^Bearer\s+(.+)$/iu)?.[1];
	if (!supplied) throw new Error("LiveKit Agent bridge authorization is required");
	const left = Buffer.from(supplied);
	const right = Buffer.from(expected);
	if (left.length !== right.length || !timingSafeEqual(left, right)) {
		throw new Error("LiveKit Agent bridge authorization is invalid");
	}
}
