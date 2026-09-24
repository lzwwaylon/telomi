import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { audioEnv } from "./environment.js";
import { isManagedAudioConnection } from "../../shared/connections.js";
import { loadCustomProviders } from "../providers/custom-models.js";
import { toErrorMessage } from "../lib/values.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:9595/v1";
const DEFAULT_STARTUP_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
/** How long a running owned service may leave health unanswered before it is replaced; a busy one answers again, a wedged one does not. */
const OWNED_HEALTH_GRACE_MS = 60_000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const DEFAULT_SERVICE_ROOT = fileURLToPath(
	new URL("../../../telomi-audio-local", import.meta.url),
);

export type LocalAudioRuntimeStage =
	| "stopped"
	| "checking"
	| "installing"
	| "starting"
	| "ready"
	| "failed";

/** What the service's health document says about its local VAD model; only telomi-audio reports one. */
export interface LocalAudioVadStatus {
	provider: string;
	version: string;
	defaultEnabled: boolean;
	modelExists: boolean;
	modelLoaded: boolean;
	expectedSha256: string;
}

export interface LocalAudioRuntimeStatus {
	schemaVersion: 1;
	stage: LocalAudioRuntimeStage;
	baseUrl: string;
	managed: boolean;
	owned: boolean;
	detail: string;
	installStage: string | null;
	completedFiles: number;
	totalFiles: number;
	pid: number | null;
	error: string | null;
	updatedAt: string;
	/** From the last answered health probe; null until the service answers or when it reports none. */
	vad: LocalAudioVadStatus | null;
}

function parseVadStatus(value: unknown): LocalAudioVadStatus | null {
	if (!value || typeof value !== "object") return null;
	const vad = value as Record<string, unknown>;
	if (typeof vad.provider !== "string" || typeof vad.version !== "string") return null;
	return {
		provider: vad.provider,
		version: vad.version,
		defaultEnabled: vad.default_enabled === true,
		modelExists: vad.model_exists === true,
		modelLoaded: vad.model_loaded === true,
		expectedSha256: typeof vad.expected_sha256 === "string" ? vad.expected_sha256 : "",
	};
}

export interface ManagedAudioChildProcess extends EventEmitter {
	pid?: number;
	exitCode: number | null;
	stdout: Readable | null;
	stderr: Readable | null;
	kill(signal?: NodeJS.Signals | number): boolean;
}

type SpawnProcess = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ManagedAudioChildProcess;

export interface AudioLocalRuntimeManagerOptions {
	env?: NodeJS.ProcessEnv;
	fetcher?: typeof fetch;
	serviceRoot?: string;
	spawnProcess?: SpawnProcess;
	sleep?: (durationMs: number) => Promise<void>;
	startupTimeoutMs?: number;
	now?: () => number;
}

interface PersistedInstallStatus {
	stage: string;
	detail: string;
	completedFiles: number;
	totalFiles: number;
}

export class AudioLocalRuntimeManager {
	private readonly env: NodeJS.ProcessEnv;
	private readonly fetcher: typeof fetch;
	private readonly serviceRoot: string;
	private readonly spawnProcess: SpawnProcess;
	private readonly hasCustomSpawner: boolean;
	private readonly sleep: (durationMs: number) => Promise<void>;
	private readonly startupTimeoutMs: number;
	private readonly now: () => number;
	private current: LocalAudioRuntimeStatus;
	private vad: LocalAudioVadStatus | null = null;
	private child: ManagedAudioChildProcess | undefined;
	private startPromise: Promise<LocalAudioRuntimeStatus> | undefined;
	private stopping = false;
	private readonly expectedExits = new WeakSet<ManagedAudioChildProcess>();
	private diagnostics: Buffer[] = [];
	private diagnosticBytes = 0;
	/** When the current startup spawned run.sh; install status files written before it belong to an earlier startup. */
	private spawnedAt: number | undefined;
	private readonly readyListeners = new Set<(baseUrl: string) => Promise<void>>();

	constructor(options: AudioLocalRuntimeManagerOptions = {}) {
		this.env = options.env ?? process.env;
		this.fetcher = options.fetcher ?? fetch;
		this.serviceRoot = resolve(options.serviceRoot ?? DEFAULT_SERVICE_ROOT);
		this.hasCustomSpawner = options.spawnProcess !== undefined;
		this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
			spawn(command, [...args], spawnOptions) as ManagedAudioChildProcess);
		this.sleep = options.sleep ?? ((durationMs) =>
			new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs)));
		this.startupTimeoutMs = positiveNumber(
			options.startupTimeoutMs,
			DEFAULT_STARTUP_TIMEOUT_MS,
		);
		this.now = options.now ?? Date.now;
		this.current = this.makeStatus("stopped", "local audio runtime is stopped");
	}

	status(): LocalAudioRuntimeStatus {
		if (["checking", "installing", "starting"].includes(this.current.stage)) {
			this.refreshInstallProgress();
		}
		return { ...this.current, vad: this.vad };
	}

	ensureReady(signal?: AbortSignal): Promise<LocalAudioRuntimeStatus> {
		this.startPromise ??= this.start().finally(() => {
			this.startPromise = undefined;
		});
		return signal ? raceWithAbort(this.startPromise, signal) : this.startPromise;
	}

	/** Start the bundled service and wait for its health when the connection is the managed one at this runtime's address; otherwise do nothing. */
	async prepare(connection: string, signal?: AbortSignal): Promise<void> {
		if (!isManagedAudioConnection(connection)) return;
		const declared = loadCustomProviders().providers?.[connection]?.baseUrl;
		if (declared && !sameEndpoint(declared, this.baseUrl())) return;
		await this.ensureReady(signal);
	}

	/** Called when the service turns healthy, including a healthy service it did not start; the status is reported once it settles. */
	onReady(listener: (baseUrl: string) => Promise<void>): () => void {
		this.readyListeners.add(listener);
		return () => { this.readyListeners.delete(listener); };
	}

	private async markReady(detail: string, owned: boolean): Promise<void> {
		const turnedReady = this.current.stage !== "ready";
		this.current = this.makeStatus("ready", detail, owned);
		if (turnedReady) await Promise.all([...this.readyListeners].map((listener) => listener(this.baseUrl()).catch(() => undefined)));
	}

	startExplicitly(signal?: AbortSignal): Promise<LocalAudioRuntimeStatus> {
		return this.ensureReady(signal);
	}

	async refresh(): Promise<LocalAudioRuntimeStatus> {
		if (await this.probe()) {
			await this.markReady("local audio runtime is ready", this.child?.exitCode === null);
			return this.status();
		}
		if (this.current.stage === "ready") {
			this.current = this.makeStatus(
				"failed",
				"local audio runtime is unavailable",
				this.child?.exitCode === null,
				"health check failed",
			);
		}
		return this.status();
	}

	async close(): Promise<void> {
		this.stopping = true;
		const child = this.child;
		this.child = undefined;
		this.startPromise = undefined;
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await waitForChildExit(child, 5_000);
			if (child.exitCode === null) child.kill("SIGKILL");
		}
		this.current = this.makeStatus("stopped", "local audio runtime is stopped");
		this.stopping = false;
	}

	private async start(): Promise<LocalAudioRuntimeStatus> {
		this.spawnedAt = undefined;
		this.current = this.makeStatus("checking", "checking local audio runtime");
		if (await this.probe()) {
			await this.markReady("reusing healthy local audio runtime", this.child?.exitCode === null);
			return this.status();
		}
		const graceDeadline = this.now() + OWNED_HEALTH_GRACE_MS;
		while (this.child?.exitCode === null && this.now() < graceDeadline) {
			await this.sleep(DEFAULT_POLL_INTERVAL_MS);
			if (await this.probe()) {
				await this.markReady("local audio runtime recovered after a transient health failure", true);
				return this.status();
			}
		}
		if (!this.canManage()) {
			const error = "configured Telomi Audio endpoint is unavailable and cannot be managed locally";
			this.current = this.makeStatus("failed", error, false, error);
			throw new Error(error);
		}

		const runScript = join(this.serviceRoot, "run.sh");
		if (!existsSync(runScript) && !this.hasCustomSpawner) {
			const error = `local audio startup script is missing: ${runScript}`;
			this.current = this.makeStatus("failed", error, false, error);
			throw new Error(error);
		}
		await this.terminateOwnedChild();
		this.diagnostics = [];
		this.diagnosticBytes = 0;
		const port = new URL(this.serverRoot()).port || "80";
		let child: ManagedAudioChildProcess;
		this.spawnedAt = this.now();
		try {
			child = this.spawnProcess(runScript, [], {
				cwd: this.serviceRoot,
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
				env: {
					...this.env,
					TELOMI_AUDIO_HOST: "127.0.0.1",
					TELOMI_AUDIO_PORT: port,
					// run.sh execs the service, so it stops on its own when this process dies without closing it.
					TELOMI_AUDIO_PARENT_PID: String(process.pid),
				},
			});
		} catch (cause) {
			const error = this.diagnostic(
				toErrorMessage(cause),
			);
			this.current = this.makeStatus(
				"failed",
				"local audio runtime failed to start",
				false,
				error,
			);
			throw new Error(error, { cause });
		}
		this.child = child;
		this.captureDiagnostics(child.stdout);
		this.captureDiagnostics(child.stderr);
		child.once("exit", (code, signal) => {
			if (this.child === child) this.child = undefined;
			if (this.stopping || this.expectedExits.delete(child)) return;
			const reason = `local audio runtime exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`;
			this.current = this.makeStatus("failed", reason, false, this.diagnostic(reason));
		});
		child.once("error", (error) => {
			if (this.child === child) this.child = undefined;
			if (this.stopping || this.expectedExits.has(child)) return;
			this.current = this.makeStatus(
				"failed",
				"local audio runtime failed to start",
				false,
				this.diagnostic(error.message),
			);
		});
		this.current = this.makeStatus("starting", "starting local audio runtime", true);
		this.refreshInstallProgress();

		const deadline = this.now() + this.startupTimeoutMs;
		while (this.now() < deadline) {
			if (child.exitCode !== null || this.child !== child) {
				const error = this.current.error || this.diagnostic("local audio runtime exited during startup");
				throw new Error(error);
			}
			if (await this.probe()) {
				await this.markReady("local audio runtime is ready", true);
				return this.status();
			}
			this.refreshInstallProgress();
			await this.sleep(DEFAULT_POLL_INTERVAL_MS);
		}
		const error = this.diagnostic("local audio runtime startup timed out");
		this.current = this.makeStatus("failed", "local audio runtime startup timed out", true, error);
		if (child.exitCode === null) child.kill("SIGTERM");
		throw new Error(error);
	}

	private async terminateOwnedChild(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null) {
			this.child = undefined;
			return;
		}
		this.expectedExits.add(child);
		this.child = undefined;
		child.kill("SIGTERM");
		await waitForChildExit(child, 5_000);
		if (child.exitCode === null) child.kill("SIGKILL");
	}

	private async probe(): Promise<boolean> {
		try {
			const response = await this.fetcher(`${this.serverRoot()}/health`, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(1_000),
			});
			if (!response.ok) return false;
			const data = await response.json().catch(() => undefined) as { ok?: unknown; vad?: unknown } | undefined;
			this.vad = parseVadStatus(data?.vad);
			if (!this.canManage()) return true;
			return data?.ok === true;
		} catch {
			this.vad = null;
			return false;
		}
	}

	private refreshInstallProgress(): void {
		// run.sh installs the ASR model, then the TTS model; show whichever is in progress, else a failure.
		const installs = this.readInstallStatuses();
		const install = installs.find((item) => item.stage === "downloading" || item.stage === "validating")
			?? installs.find((item) => item.stage === "failed" || item.stage === "invalid")
			?? installs.at(-1);
		if (!install) return;
		const stage = install.stage === "downloading" || install.stage === "validating"
			? "installing"
			: install.stage === "failed" || install.stage === "invalid"
				? "failed"
				: "starting";
		this.current = {
			...this.current,
			stage,
			detail: install.detail,
			installStage: install.stage,
			completedFiles: install.completedFiles,
			totalFiles: install.totalFiles,
			updatedAt: new Date(this.now()).toISOString(),
		};
	}

	private readInstallStatuses(): PersistedInstallStatus[] {
		const spawnedAt = this.spawnedAt;
		if (spawnedAt === undefined) return [];
		const statuses: PersistedInstallStatus[] = [];
		for (const path of this.installStatusPaths()) {
			try {
				const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
				if (
					raw.schema_version !== 1 ||
					typeof raw.stage !== "string" ||
					typeof raw.detail !== "string" ||
					finiteNonNegativeInteger(raw.updated_at_unix_ms) < spawnedAt
				) continue;
				statuses.push({
					stage: raw.stage,
					detail: raw.detail.slice(0, 500),
					completedFiles: finiteNonNegativeInteger(raw.completed_files),
					totalFiles: finiteNonNegativeInteger(raw.total_files),
				});
			} catch {
				continue;
			}
		}
		return statuses;
	}

	private installStatusPaths(): string[] {
		const state = join(this.env.HOME || homedir(), ".cache", "telomi-audio", "state");
		return [
			resolve(audioEnv("ASR_INSTALL_STATUS", this.env) || join(state, "asr-install.json")),
			resolve(audioEnv("TTS_INSTALL_STATUS", this.env) || join(state, "tts-install.json")),
		];
	}

	/** Configured endpoint of the local runtime, read live (the status snapshot may lag an environment change). */
	baseUrl(): string {
		return (audioEnv("STT_BASE_URL", this.env) || DEFAULT_BASE_URL).replace(/\/+$/, "");
	}

	private serverRoot(): string {
		return this.baseUrl().replace(/\/v1$/, "");
	}

	private canManage(): boolean {
		try {
			const hostname = new URL(this.serverRoot()).hostname.toLowerCase();
			return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
		} catch {
			return false;
		}
	}

	private captureDiagnostics(stream: Readable | null): void {
		stream?.on("data", (chunk: Buffer | string) => {
			if (this.diagnosticBytes >= MAX_DIAGNOSTIC_BYTES) return;
			const bytes = Buffer.from(chunk);
			const remaining = MAX_DIAGNOSTIC_BYTES - this.diagnosticBytes;
			const bounded = bytes.subarray(0, remaining);
			this.diagnostics.push(bounded);
			this.diagnosticBytes += bounded.length;
		});
	}

	private diagnostic(message: string): string {
		const output = Buffer.concat(this.diagnostics).toString("utf8").trim().slice(-4_000);
		return output ? `${message}: ${output}` : message;
	}

	private makeStatus(
		stage: LocalAudioRuntimeStage,
		detail: string,
		owned = false,
		error: string | null = null,
	): LocalAudioRuntimeStatus {
		return {
			schemaVersion: 1,
			stage,
			baseUrl: this.baseUrl(),
			managed: this.canManage(),
			owned,
			detail,
			installStage: null,
			completedFiles: 0,
			totalFiles: 0,
			pid: owned ? this.child?.pid ?? null : null,
			error,
			vad: this.vad,
			updatedAt: new Date(this.now()).toISOString(),
		};
	}
}

/** Endpoints compare as URLs, so scheme or host case and a trailing slash do not count; an unparsable one matches nothing. */
export function sameEndpoint(a: string, b: string): boolean {
	try {
		return new URL(a).href.replace(/\/+$/, "") === new URL(b).href.replace(/\/+$/, "");
	} catch {
		return false;
	}
}

function positiveNumber(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function finiteNonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: 0;
}

async function waitForChildExit(
	child: ManagedAudioChildProcess,
	timeoutMs: number,
): Promise<void> {
	if (child.exitCode !== null) return;
	await new Promise<void>((resolveExit) => {
		const timer = setTimeout(resolveExit, timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolveExit();
		});
	});
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const abort = () => rejectPromise(abortError(signal));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolvePromise, rejectPromise).finally(() => {
			signal.removeEventListener("abort", abort);
		});
	});
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(typeof signal.reason === "string" ? signal.reason : "operation aborted");
}

let defaultManager: AudioLocalRuntimeManager | undefined;

export function getAudioLocalRuntimeManager(): AudioLocalRuntimeManager {
	defaultManager ??= new AudioLocalRuntimeManager();
	return defaultManager;
}
