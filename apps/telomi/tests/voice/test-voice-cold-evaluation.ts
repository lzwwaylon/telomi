import assert from "node:assert/strict";
import test from "node:test";
import {
	withIsolatedColdSidecar,
	type IsolatedColdSidecarManager,
} from "../../server/voice/isolated-cold-sidecar.js";

test("an isolated cold sample owns an unloaded sidecar and restores the caller environment", async () => {
	const env: NodeJS.ProcessEnv = {
		TELOMI_AUDIO_STT_BASE_URL: "http://127.0.0.1:9595/v1",
		TELOMI_AUDIO_STT_API_KEY: "existing-key",
	};
	let closed = 0;
	let now = 100;
	let managerEnvironment: NodeJS.ProcessEnv | undefined;
	const manager: IsolatedColdSidecarManager = {
		async ensureReady() {
			now = 350;
			return {
				stage: "ready",
				baseUrl: "http://127.0.0.1:4567/v1",
				owned: true,
				pid: 4321,
			};
		},
		async close() {
			closed += 1;
		},
	};

	const outcome = await withIsolatedColdSidecar(
		async (evidence) => {
			assert.equal(env.TELOMI_AUDIO_STT_BASE_URL, "http://127.0.0.1:4567/v1");
			assert.equal(evidence.asrLoadedBeforeRequest, false);
			assert.equal(evidence.asrModelId, "Qwen3-ASR-test");
			assert.equal(evidence.asrModelPath, "/models/qwen-test");
			return "transcribed";
		},
		{
			env,
			reservePort: async () => 4567,
			managerFactory: (scopedEnvironment) => {
				managerEnvironment = scopedEnvironment;
				assert.equal(scopedEnvironment.TELOMI_AUDIO_SKIP_DEPENDENCY_INSTALL, "true");
				assert.equal(scopedEnvironment.TELOMI_AUDIO_ASR_AUTO_DOWNLOAD, "false");
				assert.equal(scopedEnvironment.TELOMI_AUDIO_VAD_AUTO_DOWNLOAD, "false");
				return manager;
			},
			fetcher: async (input) => {
				assert.equal(String(input), "http://127.0.0.1:4567/health");
				return new Response(JSON.stringify({
					ok: true,
					asr: {
						loaded: false,
						model_id: "Qwen3-ASR-test",
						model_path: "/models/qwen-test",
					},
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
			now: () => now,
			modelPathIsDirectory: (path) => path === "/models/qwen-test",
		},
	);

	assert.equal(outcome.value, "transcribed");
	assert.deepEqual(outcome.evidence, {
		baseUrl: "http://127.0.0.1:4567/v1",
		sidecarPid: 4321,
		sidecarStartupMs: 250,
		asrLoadedBeforeRequest: false,
		asrModelId: "Qwen3-ASR-test",
		asrModelPath: "/models/qwen-test",
	});
	assert.equal(managerEnvironment, env);
	assert.equal(closed, 1);
	assert.equal(env.TELOMI_AUDIO_STT_BASE_URL, "http://127.0.0.1:9595/v1");
	assert.equal(env.TELOMI_AUDIO_STT_API_KEY, "existing-key");
	assert.equal(env.TELOMI_AUDIO_SKIP_DEPENDENCY_INSTALL, undefined);
	assert.equal(env.TELOMI_AUDIO_ASR_AUTO_DOWNLOAD, undefined);
	assert.equal(env.TELOMI_AUDIO_VAD_AUTO_DOWNLOAD, undefined);
});

test("a preloaded, reused or model-less sidecar cannot become an isolated cold sample", async () => {
	for (const failure of ["preloaded", "reused", "missing-model"] as const) {
		const env: NodeJS.ProcessEnv = {};
		let closed = 0;
		let taskCalls = 0;
		const manager: IsolatedColdSidecarManager = {
			async ensureReady() {
				return {
					stage: "ready",
					baseUrl: "http://127.0.0.1:4568/v1",
					owned: failure !== "reused",
					pid: failure === "reused" ? null : 8765,
				};
			},
			async close() {
				closed += 1;
			},
		};

		await assert.rejects(
			withIsolatedColdSidecar(
				async () => {
					taskCalls += 1;
				},
				{
					env,
					reservePort: async () => 4568,
					managerFactory: () => manager,
					fetcher: async () => new Response(JSON.stringify({
						ok: true,
						asr: {
							loaded: failure === "preloaded",
							model_id: "Qwen3-ASR-test",
							model_path: "/models/qwen-test",
						},
					}), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
					modelPathIsDirectory: () => failure !== "missing-model",
				},
			),
			failure === "preloaded"
				? /ASR was already loaded/
				: failure === "reused"
					? /did not own its sidecar/
					: /ASR model path is not a local directory/,
		);

		assert.equal(taskCalls, 0);
		assert.equal(closed, 1);
		assert.equal(env.TELOMI_AUDIO_STT_BASE_URL, undefined);
	}
});

test("the isolated sidecar is stopped and environment restored when transcription fails", async () => {
	const env: NodeJS.ProcessEnv = {
		TELOMI_AUDIO_STT_BASE_URL: "http://127.0.0.1:9595/v1",
	};
	let closed = 0;
	const manager: IsolatedColdSidecarManager = {
		async ensureReady() {
			return {
				stage: "ready",
				baseUrl: "http://127.0.0.1:4569/v1",
				owned: true,
				pid: 9876,
			};
		},
		async close() {
			closed += 1;
		},
	};

	await assert.rejects(
		withIsolatedColdSidecar(
			async () => {
				throw new Error("provider failed");
			},
			{
				env,
				reservePort: async () => 4569,
				managerFactory: () => manager,
				fetcher: async () => new Response(JSON.stringify({
					ok: true,
					asr: {
						loaded: false,
						model_id: "Qwen3-ASR-test",
						model_path: "/models/qwen-test",
					},
				}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
				modelPathIsDirectory: () => true,
			},
		),
		/provider failed/,
	);

	assert.equal(closed, 1);
	assert.equal(env.TELOMI_AUDIO_STT_BASE_URL, "http://127.0.0.1:9595/v1");
});

test("the environment is restored when sidecar manager construction fails", async () => {
	const env: NodeJS.ProcessEnv = {
		TELOMI_AUDIO_STT_BASE_URL: "http://127.0.0.1:9595/v1",
		TELOMI_AUDIO_ASR_AUTO_DOWNLOAD: "existing-value",
	};

	await assert.rejects(
		withIsolatedColdSidecar(
			async () => "unreachable",
			{
				env,
				reservePort: async () => 4570,
				managerFactory: () => {
					throw new Error("manager construction failed");
				},
			},
		),
		/manager construction failed/,
	);

	assert.equal(env.TELOMI_AUDIO_STT_BASE_URL, "http://127.0.0.1:9595/v1");
	assert.equal(env.TELOMI_AUDIO_ASR_AUTO_DOWNLOAD, "existing-value");
	assert.equal(env.TELOMI_AUDIO_SKIP_DEPENDENCY_INSTALL, undefined);
	assert.equal(env.TELOMI_AUDIO_VAD_AUTO_DOWNLOAD, undefined);
});
