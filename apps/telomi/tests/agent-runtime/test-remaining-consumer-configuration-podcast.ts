/** Configuration API to the Podcast writer through native Prime transport, using only local HTTP. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { startConsumerConfiguration } from "./fixtures/consumer-configuration.js";

const harness = await startConsumerConfiguration();
const { root, env, seen, control, upstreamUrl, signal, apply, configure, stopped, selected } = harness;
const { writePrimePodcast } = await import("../../server/media/podcast/writer.js");
const podcast = (name: string, executionEnv: NodeJS.ProcessEnv = env) => writePrimePodcast({ sourceText: "Canonical report.",
	sessionDir: join(root, name), title: "Title", language: "en", audience: "Reader",
	generationBrief: { durablePreference: null, generationInstruction: null },
	emitProgress: () => {}, observe: () => {}, signal, env: executionEnv });
try {
	await apply("first", "low");
	await configure({ taskModels: { primeChild: "consumer-test/child" } });
	control.duringRequest = async () => {
		control.duringRequest = undefined;
		await apply("second", "high");
		assert.equal(await harness.primeRootStatus(), "pending");
	};
	await stopped(() => podcast("podcast-first"), "first", "low");
	assert.deepEqual(selected("podcast-first/media/podcast/writer/agent-workspace").scoped, [{ model: "first", thinking: "low" }, { model: "child", thinking: "low" }]);
	await stopped(() => podcast("podcast-next"), "second", "high");
	// Same selector and thinking, different connection: an active operation is still pending.
	control.duringRequest = async () => {
		control.duringRequest = undefined;
		await harness.replaceConnection({ baseUrl: `${upstreamUrl}/new` });
		assert.equal(await harness.primeRootStatus(), "pending");
	};
	await stopped(() => podcast("podcast-connection-change"), "second", "high", /Provider connection 'consumer-test' changed/);
	assert.equal(seen.at(-1)?.path, "/v1/chat/completions");
	await stopped(() => podcast("podcast-new-connection"), "second", "high");
	assert.equal(seen.at(-1)?.path, "/v1/new/chat/completions");
	const rotateKey = (key: string) => harness.replaceConnection({ baseUrl: `${upstreamUrl}/new`, apiKey: key });
	await rotateKey("local-first");
	const beforeRotation = seen.length;
	control.replyOnce = true;
	control.duringRequest = async () => { control.duringRequest = undefined; await rotateKey("local-second"); };
	await stopped(() => podcast("podcast-credential-rotation"), "second", "high");
	const rotatedRequests = seen.slice(beforeRotation);
	assert.equal(rotatedRequests[0]?.key, "Bearer local-first");
	assert.ok(rotatedRequests.length > 1, "the same operation must send a subsequent request");
	assert.ok(rotatedRequests.slice(1).every((request) => request.key === "Bearer local-second"),
		"every subsequent request, including native repairs, uses the activated credential");
	await stopped(() => podcast("podcast-replay", { ...env,
		TELOMI_PRIME_AGENT_ROOT_MODEL: "consumer-test/first", TELOMI_PODCAST_WRITER_THINKING_LEVEL: "low" }), "first", "low");
	console.log("Podcast writer adopts API configuration, credential rotation and replay pins, and reaches native local transport");
} finally {
	await harness.close();
}
