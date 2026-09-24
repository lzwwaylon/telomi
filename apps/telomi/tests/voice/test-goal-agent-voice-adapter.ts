import assert from "node:assert/strict";
import test from "node:test";
import type { GoalEventEnvelope, GoalSnapshot } from "../../shared/types.js";
import {
	createGoalAgentVoiceHost,
	type GoalAgentVoiceHost,
	streamGoalAgentReply,
} from "../../server/voice/goal-agent-voice-adapter.js";
import type { GoalService } from "../../server/goals/service.js";

test("voice submissions request a transient voice run from the Goal service", async () => {
	let profile: "voice" | undefined;
	const goals = {
		getGoal: () => ({ id: "goal_voice" }),
		getRunner: async () => ({ subscribe: () => () => undefined }),
		startInteractiveRun: async (
			_goalId: string,
			_transcript: string,
			nextProfile?: "voice",
		) => {
			profile = nextProfile;
			return { queued: false, queuePosition: 0 };
		},
	} as unknown as GoalService;

	const connection = await createGoalAgentVoiceHost(goals).open("goal_voice");
	await connection.submit("现在回答");
	assert.equal(profile, "voice");
});

test("voice turns stream only user-visible text from the current Goal agent", async () => {
	const host = fakeHost((emit) => {
		emit(agentEvent("message_start", userMessage("上一轮")));
		emit(agentEvent("message_start", userMessage("现在回答")));
		emit(agentEvent("message_end", userMessage("现在回答")));
		emit(agentEvent("message_start", assistantMessage([])));
		emit(agentEvent("message_update", assistantMessage([
			{ type: "thinking", thinking: "不能朗读的推理" },
			{ type: "text", text: "我来检查" },
			{ type: "toolCall", name: "research" },
		])));
		emit(agentEvent("message_update", assistantMessage([
			{ type: "thinking", thinking: "仍然不能朗读" },
			{ type: "text", text: "我来检查。" },
		])));
		emit(agentEvent("message_end", assistantMessage([
			{ type: "text", text: "我来检查。" },
			{ type: "toolCall", name: "research" },
		])));
		emit(agentEvent("tool_execution_start"));
		emit(agentEvent("message_start", assistantMessage([])));
		emit(agentEvent("message_update", assistantMessage([
			{ type: "text", text: "已经完成" },
		])));
		emit(agentEvent("message_end", assistantMessage([
			{ type: "text", text: "已经完成。" },
		])));
		emit(agentEvent("agent_end"));
	});

	const deltas = await Array.fromAsync(streamGoalAgentReply(host, {
		goalId: "goal_voice",
		sessionId: "voice_session",
		utteranceId: "utt_voice",
		turnId: "turn_voice",
		transcript: "现在回答",
	}));

	assert.deepEqual(deltas, [
		"我来检查",
		"。",
		"\n\n已经完成",
		"。",
	]);
});

test("voice turns fall back to the final visible Main Agent snapshot", async () => {
	const host = fakeHost((emit) => {
		emit(agentEvent("message_start", userMessage("运行任务")));
		emit({
			type: "agent-event",
			state: { ...snapshot(), isStreaming: true },
			event: { type: "agent_end" },
		});
		emit({
			type: "snapshot",
			state: {
				...snapshot(),
				messages: [assistantMessage([{ type: "text", text: "任务已经完成。" }])],
			},
		});
	});

	const deltas = await Array.fromAsync(streamGoalAgentReply(host, {
		goalId: "goal_voice",
		transcript: "运行任务",
	}));

	assert.deepEqual(deltas, ["任务已经完成。"]);
});

test("playback interruption detaches the voice stream without cancelling the Goal agent", async () => {
	const controller = new AbortController();
	let unsubscribed = false;
	const host = fakeHost(
		(emit) => {
			emit(agentEvent("message_start", userMessage("开始")));
			emit(agentEvent("message_start", assistantMessage([])));
			emit(agentEvent("message_update", assistantMessage([
				{ type: "text", text: "仍在运行" },
			])));
		},
		() => {
			unsubscribed = true;
		},
	);
	const stream = streamGoalAgentReply(host, {
		goalId: "goal_voice",
		sessionId: "voice_session",
		utteranceId: "utt_voice",
		turnId: "turn_voice",
		transcript: "开始",
		signal: controller.signal,
	})[Symbol.asyncIterator]();

	assert.equal((await stream.next()).value, "仍在运行");
	controller.abort();
	assert.equal((await stream.next()).done, true);
	assert.equal(unsubscribed, true);
});

function fakeHost(
	onSubmit: (emit: (event: GoalEventEnvelope) => void) => void,
	onUnsubscribe?: () => void,
): GoalAgentVoiceHost {
	let listener: ((event: GoalEventEnvelope) => void) | undefined;
	return {
		async open() {
			return {
				subscribe(next) {
					listener = next;
					next({ type: "snapshot", state: snapshot() });
					return () => {
						listener = undefined;
						onUnsubscribe?.();
					};
				},
				async submit() {
					onSubmit((event) => listener?.(event));
				},
			};
		},
	};
}

function agentEvent(type: string, message?: unknown): GoalEventEnvelope {
	return {
		type: "agent-event",
		state: { ...snapshot(), isStreaming: type !== "agent_end" },
		event: { type, ...(message ? { message } : {}) },
	};
}

function userMessage(text: string): unknown {
	return {
		role: "user",
		content: [{ type: "text", text }],
	};
}

function assistantMessage(content: unknown[]): unknown {
	return { role: "assistant", content };
}

function snapshot(): GoalSnapshot {
	return {
		goalId: "goal_voice",
		title: "Voice",
		description: "",
		messages: [],
		isStreaming: false,
		pendingToolCalls: [],
		stopState: "idle",
	};
}
