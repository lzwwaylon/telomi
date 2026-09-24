import assert from "node:assert/strict";
import test from "node:test";
import { openVoiceSession } from "../../web/src/features/voice/VoiceSession.js";

test("voice session exposes one ordered open and close lifecycle", async () => {
	const session = openVoiceSession({
		goalId: "goal_voice",
		sessionId: "voice_session_test",
	});
	const events = session.events()[Symbol.asyncIterator]();

	const opened = await events.next();
	assert.equal(opened.done, false);
	assert.equal(opened.value?.type, "session.opened");
	assert.equal(opened.value?.sessionId, "voice_session_test");
	assert.equal(opened.value?.sequence, 1);
	assert.equal(opened.value?.causationId, "voice_session_test");
	assert.equal(opened.value?.goalId, "goal_voice");
	assert.equal(opened.value?.supported, false);
	assert.equal(Number.isNaN(Date.parse(opened.value?.occurredAt ?? "")), false);

	await session.close();
	const closed = await events.next();
	assert.equal(closed.done, false);
	assert.equal(closed.value?.type, "session.closed");
	assert.equal(closed.value?.sessionId, "voice_session_test");
	assert.equal(closed.value?.sequence, 2);
	assert.equal(closed.value?.causationId, "voice_session_test");
	assert.equal(Number.isNaN(Date.parse(closed.value?.occurredAt ?? "")), false);
	assert.deepEqual(await events.next(), { done: true, value: undefined });
});

test("voice session rejects microphone input through its event interface when unsupported", async () => {
	const session = openVoiceSession({
		goalId: "goal_voice",
		sessionId: "voice_session_unsupported",
	});
	const events = session.events()[Symbol.asyncIterator]();
	await events.next();

	await session.input({ type: "utterance.start" });
	const failed = await events.next();
	assert.equal(failed.value?.type, "utterance.failed");
	if (failed.value?.type !== "utterance.failed") assert.fail("missing failure");
	assert.equal(failed.value.sessionId, "voice_session_unsupported");
	assert.equal(failed.value.sequence, 2);
	assert.equal(failed.value.code, "voice_capture_unsupported");
	assert.match(failed.value.message, /不支持/);
	assert.equal(failed.value.causationId, failed.value.utteranceId);

	await session.close();
});

test("voice session routes input through one runtime and owns event ordering", async () => {
	const session = openVoiceSession({
		goalId: "goal_voice",
		sessionId: "voice_session_runtime",
		supported: true,
		runtime: {
			async input(event, context) {
				assert.deepEqual(event, { type: "utterance.start" });
				assert.match(context.utteranceId ?? "", /^utt_/);
				context.emit({
					type: "utterance.started",
					utteranceId: context.utteranceId ?? "",
				});
			},
			async close() {},
		},
	});
	const events = session.events()[Symbol.asyncIterator]();
	await events.next();

	await session.input({ type: "utterance.start" });
	const started = await events.next();
	assert.equal(started.value?.type, "utterance.started");
	if (started.value?.type !== "utterance.started") assert.fail("missing start");
	assert.equal(started.value.sessionId, "voice_session_runtime");
	assert.equal(started.value.sequence, 2);
	assert.match(started.value.utteranceId, /^utt_/);
	assert.equal(started.value.causationId, started.value.utteranceId);

	await session.close();
});

test("one voice session orders multiple utterances and rejects late terminal events", async () => {
	const utteranceIds: string[] = [];
	let firstContext:
		| Parameters<
				NonNullable<
					Parameters<typeof openVoiceSession>[0]["runtime"]
				>["input"]
		  >[1]
		| undefined;
	const session = openVoiceSession({
		goalId: "goal_voice",
		sessionId: "voice_session_continuous",
		supported: true,
		runtime: {
			async input(event, context) {
				const utteranceId = context.utteranceId;
				assert.ok(utteranceId);
				if (event.type === "utterance.start") {
					utteranceIds.push(utteranceId);
					firstContext ??= context;
					context.emit({ type: "utterance.started", utteranceId });
					return;
				}
				if (event.type === "utterance.finish") {
					context.emit({
						type: "utterance.final",
						utteranceId,
						text: `final ${utteranceIds.length}`,
					});
				}
			},
			async close() {},
		},
	});
	const events = session.events()[Symbol.asyncIterator]();
	await events.next();

	await session.input({ type: "utterance.start" });
	const firstStarted = await events.next();
	await session.input({ type: "utterance.finish" });
	const firstFinal = await events.next();
	firstContext?.emit({
		type: "utterance.final",
		utteranceId: utteranceIds[0] ?? "",
		text: "late final",
	});

	await session.input({ type: "utterance.start" });
	const secondStarted = await events.next();
	await session.input({ type: "utterance.finish" });
	const secondFinal = await events.next();

	assert.equal(firstStarted.value?.sequence, 2);
	assert.equal(firstFinal.value?.sequence, 3);
	assert.equal(secondStarted.value?.sequence, 4);
	assert.equal(secondFinal.value?.sequence, 5);
	assert.equal(firstStarted.value?.sessionId, "voice_session_continuous");
	assert.equal(secondStarted.value?.sessionId, "voice_session_continuous");
	assert.equal(new Set(utteranceIds).size, 2);
	assert.notEqual(utteranceIds[0], utteranceIds[1]);
	assert.equal(secondFinal.value?.type, "utterance.final");
	if (secondFinal.value?.type !== "utterance.final") {
		assert.fail("missing second final");
	}
	assert.equal(secondFinal.value.text, "final 2");

	await session.close();
	const closed = await events.next();
	assert.equal(closed.value?.type, "session.closed");
	assert.equal(closed.value?.sequence, 6);
});
