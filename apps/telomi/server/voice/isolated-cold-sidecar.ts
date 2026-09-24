import { createServer } from "node:net";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
	AudioLocalRuntimeManager,
	type LocalAudioRuntimeStage,
} from "../audio/local-runtime.js";

export interface IsolatedColdSidecarStatus {
	stage: LocalAudioRuntimeStage;
	baseUrl: string;
	owned: boolean;
	pid: number | null;
}

export interface IsolatedColdSidecarManager {
	ensureReady(): Promise<IsolatedColdSidecarStatus>;
	close(): Promise<void>;
}

export interface VoiceColdStartEvidence {
	baseUrl: string;
	sidecarPid: number;
	sidecarStartupMs: number;
	asrLoadedBeforeRequest: false;
	asrModelId: string;
	asrModelPath: string;
}

export interface IsolatedColdSidecarOutcome<T> {
	value: T;
	evidence: VoiceColdStartEvidence;
}

interface IsolatedColdSidecarOptions {
	env?: NodeJS.ProcessEnv;
	reservePort?: () => Promise<number>;
	managerFactory?: (env: NodeJS.ProcessEnv) => IsolatedColdSidecarManager;
	fetcher?: typeof fetch;
	now?: () => number;
	modelPathIsDirectory?: (path: string) => boolean;
}

/**
 * Run exactly one benchmark observation against a new local sidecar whose ASR
 * model is proven unloaded immediately before the observation starts.
 *
 * The caller's Provider environment is scoped to the callback and restored in
 * every exit path. The owned child is also stopped after every observation, so
 * repeated samples cannot silently share model or process state.
 */
export async function withIsolatedColdSidecar<T>(
	task: (evidence: VoiceColdStartEvidence) => Promise<T>,
	options: IsolatedColdSidecarOptions = {},
): Promise<IsolatedColdSidecarOutcome<T>> {
	const env = options.env ?? process.env;
	const reservePort = options.reservePort ?? reserveLoopbackPort;
	const managerFactory = options.managerFactory ?? ((managerEnvironment) =>
		new AudioLocalRuntimeManager({ env: managerEnvironment }));
	const fetcher = options.fetcher ?? fetch;
	const now = options.now ?? Date.now;
	const modelPathIsDirectory = options.modelPathIsDirectory ?? ((path) => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	});
	const previousBaseUrl = env.TELOMI_AUDIO_STT_BASE_URL;
	const hadBaseUrl = Object.hasOwn(env, "TELOMI_AUDIO_STT_BASE_URL");
	const port = await reservePort();
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`isolated cold sidecar reserved an invalid port: ${port}`);
	}
	const baseUrl = `http://127.0.0.1:${port}/v1`;
	env.TELOMI_AUDIO_STT_BASE_URL = baseUrl;
	const previousBenchmarkEnvironment = setBenchmarkEnvironment(env);
	let manager: IsolatedColdSidecarManager | undefined;

	try {
		manager = managerFactory(env);
		const startedAt = now();
		const status = await manager.ensureReady();
		if (!status.owned || !Number.isInteger(status.pid) || status.pid! <= 0) {
			throw new Error(
				"isolated cold evaluation did not own its sidecar process",
			);
		}
		if (status.stage !== "ready" || status.baseUrl !== baseUrl) {
			throw new Error(
				`isolated cold sidecar readiness mismatch: expected ${baseUrl}, received ${status.baseUrl}`,
			);
		}

		const health = await readColdHealth(fetcher, baseUrl);
		if (health.asr.loaded !== false) {
			throw new Error(
				"isolated cold sidecar ASR was already loaded before the sample",
			);
		}
		if (
			!isAbsolute(health.asr.modelPath) ||
			!modelPathIsDirectory(health.asr.modelPath)
		) {
			throw new Error(
				`isolated cold sidecar ASR model path is not a local directory: ${health.asr.modelPath}`,
			);
		}
		const evidence: VoiceColdStartEvidence = {
			baseUrl,
			sidecarPid: status.pid!,
			sidecarStartupMs: roundMilliseconds(now() - startedAt),
			asrLoadedBeforeRequest: false,
			asrModelId: health.asr.modelId,
			asrModelPath: health.asr.modelPath,
		};
		return {
			value: await task(evidence),
			evidence,
		};
	} finally {
		try {
			await manager?.close();
		} finally {
			if (hadBaseUrl) env.TELOMI_AUDIO_STT_BASE_URL = previousBaseUrl;
			else delete env.TELOMI_AUDIO_STT_BASE_URL;
			restoreEnvironment(env, previousBenchmarkEnvironment);
		}
	}
}

const BENCHMARK_ENVIRONMENT = {
	TELOMI_AUDIO_SKIP_DEPENDENCY_INSTALL: "true",
	TELOMI_AUDIO_ASR_AUTO_DOWNLOAD: "false",
	TELOMI_AUDIO_TTS_AUTO_DOWNLOAD: "false",
	TELOMI_AUDIO_VAD_AUTO_DOWNLOAD: "false",
} as const;

function setBenchmarkEnvironment(
	env: NodeJS.ProcessEnv,
): Map<string, { present: boolean; value: string | undefined }> {
	const previous = new Map<string, { present: boolean; value: string | undefined }>();
	for (const [key, value] of Object.entries(BENCHMARK_ENVIRONMENT)) {
		previous.set(key, { present: Object.hasOwn(env, key), value: env[key] });
		env[key] = value;
	}
	return previous;
}

function restoreEnvironment(
	env: NodeJS.ProcessEnv,
	previous: Map<string, { present: boolean; value: string | undefined }>,
): void {
	for (const [key, state] of previous) {
		if (state.present) env[key] = state.value;
		else delete env[key];
	}
}

async function readColdHealth(
	fetcher: typeof fetch,
	baseUrl: string,
): Promise<{
	asr: { loaded: boolean; modelId: string; modelPath: string };
}> {
	const response = await fetcher(`${baseUrl.replace(/\/v1$/, "")}/health`, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(2_000),
	});
	if (!response.ok) {
		throw new Error(
			`isolated cold sidecar health check failed with HTTP ${response.status}`,
		);
	}
	const body = await response.json() as {
		ok?: unknown;
		asr?: { loaded?: unknown; model_id?: unknown; model_path?: unknown };
	};
	if (
		body.ok !== true ||
		typeof body.asr?.loaded !== "boolean" ||
		typeof body.asr.model_id !== "string" ||
		!body.asr.model_id.trim() ||
		typeof body.asr.model_path !== "string" ||
		!body.asr.model_path.trim()
	) {
		throw new Error("isolated cold sidecar returned an invalid health contract");
	}
	return {
		asr: {
			loaded: body.asr.loaded,
			modelId: body.asr.model_id,
			modelPath: body.asr.model_path,
		},
	};
}

export async function reserveLoopbackPort(): Promise<number> {
	const server = createServer();
	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(0, "127.0.0.1", () => resolveListen());
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("failed to reserve a loopback TCP port");
		}
		return address.port;
	} finally {
		if (server.listening) {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
	}
}

function roundMilliseconds(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}
