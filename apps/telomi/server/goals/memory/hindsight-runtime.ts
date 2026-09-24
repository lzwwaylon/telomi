import { spawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";

import { isDeepStrictEqual } from "node:util";
import { DEFAULT_MEMORY_MODELS, resolveMemoryModels, validateMemoryModels, type ResolvedMemoryModels } from "./model-settings.js";
import { MemoryModelTransport } from "./model-transport.js";
import { resolveDataDir } from "../../config/data-dir.js";
import { loadSettings, type PiSettings } from "../../config/settings.js";
import { HINDSIGHT_LOCAL_CONNECTION, type EmbeddingProgress } from "../../../shared/embedding-configuration.js";
import { embeddingApiKey, resolveEmbedding, type EmbeddingExecution } from "../../embedding/configuration.js";
import { memoryEmbeddingEnv } from "../../embedding/memory-env.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:18888/v1/default";
/** Multilingual cross-encoder, same size class as Hindsight's English default. */
export const DEFAULT_MEMORY_RERANKER_MODEL = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1";
/**
 * Without an explicit `HINDSIGHT_API_DATABASE_URL`, each installation gets its own pg0 instance
 * named after its data directory. Two checkouts on one machine must never share memory storage:
 * an embedding migration in one would silently rewrite the other's vectors.
 */
export function memoryDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.HINDSIGHT_API_DATABASE_URL?.trim();
	if (configured) return configured;
	return `pg0://telomi-${createHash("sha256").update(resolveDataDir(env)).digest("hex").slice(0, 12)}`;
}
/** How long a replacement waits for in-flight Memory operations before giving up. */
const DRAIN_TIMEOUT_MS = 60_000;
const MEMORY_EMBEDDING_UNSET = "Choose an embedding model for User Memory";

/** The last Python error line of a native process. Driver errors can quote the connection URL; nothing needs it. */
function nativeErrorLine(stderr: string): string | undefined {
	return stderr.trim().split("\n").filter((line) => /^[A-Za-z]+Error: |^Exception: /u.test(line)).at(-1)
		?.replace(/[a-z0-9+]+:\/\/[^\s'"]*@[^\s'"]*/giu, "<database>").slice(0, 500);
}
const DEFAULT_SERVICE_ROOT = fileURLToPath(new URL("../../../services/hindsight", import.meta.url));

export interface HindsightRuntime {
	baseUrl: string;
	owned: boolean;
}

export interface ManagedHindsightChildProcess extends EventEmitter {
	pid?: number;
	exitCode: number | null;
	signalCode?: NodeJS.Signals | null;
	stdout: Readable | null;
	stderr: Readable | null;
	kill(signal?: NodeJS.Signals | number): boolean;
}

type SpawnProcess = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ManagedHindsightChildProcess;

export interface HindsightRuntimeManagerOptions {
	env?: NodeJS.ProcessEnv;
	fetcher?: typeof fetch;
	serviceRoot?: string;
	spawnProcess?: SpawnProcess;
	wait?: (durationMs: number) => Promise<void>;
}

export class HindsightRuntimeManager {
	private readonly env: NodeJS.ProcessEnv;
	private readonly transport = new MemoryModelTransport();
	private serving: { id: string; env: NodeJS.ProcessEnv; models: ResolvedMemoryModels } | undefined;
	private activeModels: ResolvedMemoryModels | null = null;
	private targetModels: ResolvedMemoryModels | null = null;
	private configurationPhase: "pending" | "validating" | "applying" | "active" | "failed" = "pending";
	private configurationError: string | null = null;
	private applying = false;
	private admissionUncertain = false;
	private lifecycle = 0;
	private readonly fetcher: typeof fetch;
	private readonly serviceRoot: string;
	private readonly spawnProcess: SpawnProcess;
	private readonly wait: (durationMs: number) => Promise<void>;
	private ready: Promise<HindsightRuntime> | undefined;
	private child: ManagedHindsightChildProcess | undefined;
	private closing: Promise<void> | undefined;
	private startupAbort: AbortController | undefined;

	constructor(options: HindsightRuntimeManagerOptions = {}) {
		this.env = options.env ?? process.env;
		this.fetcher = options.fetcher ?? fetch;
		this.serviceRoot = resolve(options.serviceRoot ?? DEFAULT_SERVICE_ROOT);
		this.spawnProcess = options.spawnProcess ?? spawnHindsight;
		this.wait = options.wait ?? ((durationMs) =>
			new Promise((resolveWait) => setTimeout(resolveWait, durationMs)));
	}

	describeConfiguration() {
		const settings = loadSettings();
		return { settings: settings.memoryModels ?? DEFAULT_MEMORY_MODELS, pending: settings.pendingMemoryModels ?? null,
			active: this.activeModels, target: this.targetModels ?? resolveMemoryModels(settings),
			// The service cannot start without one; the page asks for it instead of reporting a failure.
			embeddingSelected: Boolean(resolveEmbedding("memory")),
			status: this.configurationPhase, error: this.configurationError };
	}

	async validateConfiguration(settings: PiSettings): Promise<void> {
		if (!isDeepStrictEqual(resolveMemoryModels(settings), this.activeModels)) await validateMemoryModels(settings);
	}

	async applyConfiguration(settings: PiSettings, publish: () => void = () => undefined): Promise<void> {
		if (this.applying) throw new Error("Memory configuration is already applying");
		this.applying = true;
		const lifecycle = this.lifecycle;
		const checkOpen = () => { if (lifecycle !== this.lifecycle) throw new Error("Memory configuration was cancelled by shutdown"); };
		this.configurationPhase = "validating";
		this.configurationError = null;
		const previous = this.serving;
		const previousModels = this.activeModels;
		let stopped = false;
		let candidateActivated = false;
		let runtime: HindsightRuntime | undefined;
		try {
			const target = resolveMemoryModels(settings);
			this.targetModels = target;
			if (isDeepStrictEqual(target, this.activeModels)) {
				if (this.admissionUncertain && this.ready) {
					await this.control((await this.ready).baseUrl, "resume");
					this.admissionUncertain = false;
				}
				publish(); this.configurationPhase = "active"; return;
			}
			await validateMemoryModels(settings, true, this.activeModels);
			checkOpen();
			this.configurationPhase = "applying";
			if (this.ready) {
				runtime = await this.ready;
				if (!runtime.owned || !this.serving) throw new Error("The running Hindsight service has no managed configuration boundary; its configuration was preserved");
				await this.drainAndStop(runtime);
				stopped = true;
			}
			checkOpen();
			this.serving = { ...await this.transport.register(target), models: target };
			checkOpen();
			const activated = await this.ensureReady();
			checkOpen();
			if (!activated.owned) throw new Error("Hindsight is externally managed; configuration was not activated");
			candidateActivated = true;
			this.activeModels = target;
			publish();
			this.transport.retainOnly(this.serving.id);
			this.configurationPhase = "active";
		} catch (error) {
			this.configurationPhase = "failed";
			this.configurationError = error instanceof Error ? error.message : "Memory configuration failed";
			if (lifecycle !== this.lifecycle) throw new Error(this.configurationError);
			if (candidateActivated && this.child && this.ready) {
				try { await this.drainAndStop(await this.ready); }
				catch {
					if (this.child) {
						// Never kill admitted work merely because the control endpoint failed.
						this.activeModels = this.serving?.models ?? null;
						this.configurationError += "; previous settings remain saved, but rollback could not drain the active replacement";
						throw new Error(this.configurationError);
					}
				}
			}
			this.serving = previous;
			this.activeModels = previousModels;
			if (stopped && previous) {
				try { await this.ensureReady(); }
				catch { this.activeModels = null; this.configurationError += "; restoring the previous service failed"; }
			} else if (runtime?.owned) await this.control(runtime.baseUrl, "resume").then(() => { this.admissionUncertain = false; }).catch(() => { this.configurationError += "; service admission recovery failed"; });
			this.transport.retainOnly(this.serving?.id);
			throw new Error(this.configurationError);
		} finally { this.applying = false; }
	}

	/**
	 * Swap the embedding storage while the service is drained. `commit` runs after the swap and
	 * before the restart so settings and storage agree even if the restart fails.
	 */
	async replaceEmbedding(cutover: () => Promise<void>, commit: () => void): Promise<void> {
		if (this.applying) throw new Error("Memory configuration is already applying");
		this.applying = true;
		const lifecycle = this.lifecycle;
		try {
			let runtime: HindsightRuntime | undefined;
			if (this.ready) {
				runtime = await this.ready;
				if (!runtime.owned) throw new Error("Hindsight is externally managed; its embedding configuration was preserved");
				await this.drainAndStop(runtime);
			}
			if (lifecycle !== this.lifecycle) throw new Error("Memory configuration was cancelled by shutdown");
			try { await cutover(); }
			catch (error) {
				if (runtime) await this.ensureReady().catch(() => undefined);
				throw error;
			}
			commit();
			// The service now starts with the committed selection, so an earlier failure, typically the
			// missing selection itself, no longer describes it until this start reports its own outcome.
			this.configurationPhase = "applying";
			this.configurationError = null;
			// A service that was not running starts with the new selection; if it still cannot, it reports
			// that startup failure itself rather than failing the migration that already committed.
			if (!runtime) { void this.ensureReady().catch(() => undefined); return; }
			await this.ensureReady().catch((error: unknown) => {
				// The page must not keep reporting "applying" for a service that is not coming back.
				this.configurationPhase = "failed";
				this.configurationError = `User Memory storage migrated, but the service failed to restart (${error instanceof Error ? error.message : String(error)}); the new selection is saved`;
				throw new Error(this.configurationError);
			});
			this.activeModels = this.serving?.models ?? null;
			this.configurationPhase = "active";
		} finally { this.applying = false; }
	}

	/** Runs one phase of the storage migration against the managed database with the target embedding environment. */
	async runEmbeddingMigration(phase: "estimate" | "prepare" | "cutover" | "abort", target: EmbeddingExecution, onProgress?: (progress: EmbeddingProgress) => void, signal?: AbortSignal): Promise<{ units?: number; characters?: number }> {
		signal?.throwIfAborted();
		const apiKey = target.connection === HINDSIGHT_LOCAL_CONNECTION ? undefined : await embeddingApiKey(target.connection);
		const child = this.spawnProcess(this.executable(), [
			"-B", join(DEFAULT_SERVICE_ROOT, "telomi_embedding_migration.py"),
			"--database-url", memoryDatabaseUrl(this.env),
			"--phase", phase,
		// The migration speaks only the target model; the selection still serving may point at a
		// connection that no longer exists, which must not keep the user from moving off it.
		], { cwd: this.serviceRoot, stdio: ["ignore", "pipe", "pipe"], env: await this.configurationEnv(memoryEmbeddingEnv(target, apiKey)) });
		let stdout = "";
		let stderr = "";
		const result: { units?: number; characters?: number } = {};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			const lines = stdout.split("\n");
			stdout = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as { event?: string; done?: number; total?: number; units?: number; characters?: number };
					if (event.event === "progress" && typeof event.done === "number" && typeof event.total === "number") onProgress?.({ done: event.done, total: event.total });
					if (event.event === "estimate") { result.units = event.units; result.characters = event.characters; }
				} catch { /* Native logging on stdout is not an event. */ }
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
		const abort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit, reject) => {
				child.once("error", reject);
				child.once("exit", (code, exitSignal) => resolveExit([code, exitSignal]));
			});
			signal?.throwIfAborted();
			if (code !== 0) {
				throw new Error(nativeErrorLine(stderr) ?? `User Memory embedding ${phase} exited with ${code}`);
			}
			return result;
		} finally { signal?.removeEventListener("abort", abort); }
	}

	private async embeddingEnv(): Promise<NodeJS.ProcessEnv> {
		const selection = resolveEmbedding("memory");
		if (!selection) throw new Error(MEMORY_EMBEDDING_UNSET);
		const apiKey = selection.connection === HINDSIGHT_LOCAL_CONNECTION ? undefined
			: await embeddingApiKey(selection.connection).catch((error: Error) => { throw new Error(`User Memory embedding connection: ${error.message}`); });
		return memoryEmbeddingEnv(selection, apiKey);
	}

	private async drainAndStop(runtime: HindsightRuntime): Promise<void> {
		this.admissionUncertain = true;
		let state = await this.control(runtime.baseUrl, "drain");
		const deadline = Date.now() + DRAIN_TIMEOUT_MS;
		while (state.activeOperations > 0) {
			// A stuck operation must not hold the configuration forever; the caller resumes admission.
			if (Date.now() > deadline) throw new Error(`Hindsight still had ${state.activeOperations} operation(s) running after ${DRAIN_TIMEOUT_MS / 1000}s; the previous configuration keeps serving`);
			await this.wait(250);
			state = await this.control(runtime.baseUrl, "status");
		}
		await this.stop();
		this.admissionUncertain = false;
		this.activeModels = null;
	}

	private async control(baseUrl: string, action: string): Promise<{ activeOperations: number }> {
		const url = new URL(baseUrl);
		url.pathname = `/ext/telomi-configuration/${action}`;
		const response = await this.fetcher(url.toString(), { method: "POST", headers: { authorization: `Bearer ${this.transport.token}` } });
		if (!response.ok) throw new Error(`Hindsight configuration boundary returned HTTP ${response.status}`);
		const result = await response.json() as { activeOperations?: unknown };
		if (typeof result.activeOperations !== "number" || result.activeOperations < 0) throw new Error("Hindsight did not confirm its operation boundary");
		return { activeOperations: result.activeOperations };
	}

	ensureReady(signal?: AbortSignal): Promise<HindsightRuntime> {
		if (this.closing) return Promise.reject(new Error("Hindsight is shutting down"));
		if (!this.ready) {
			this.startupAbort = new AbortController();
			const startupSignal = signal
				? AbortSignal.any([signal, this.startupAbort.signal])
				: this.startupAbort.signal;
			const ready = this.start(startupSignal).catch((error: unknown) => {
				if (this.ready === ready) this.ready = undefined;
				if (!this.applying) { this.configurationPhase = "failed"; this.configurationError = `Hindsight startup failed: ${error instanceof Error ? error.message : String(error)}`; }
				throw error;
			});
			this.ready = ready;
		}
		return this.ready;
	}

	close(): Promise<void> {
		if (!this.closing) this.lifecycle++;
		this.closing ??= this.stop().then(() => this.transport.close()).finally(() => {
			this.closing = undefined; this.serving = undefined; this.activeModels = null; this.targetModels = null; this.configurationPhase = "pending";
		});
		return this.closing;
	}

	private async stop(): Promise<void> {
		this.startupAbort?.abort(new Error("Hindsight startup cancelled"));
		// start() owns cleanup until readiness settles. Never race a new spawn
		// against shutdown or permit a retry before the previous child is reaped.
		await this.ready?.catch(() => undefined);
		if (this.child) await this.stopChild(this.child);
		this.ready = undefined;
		this.startupAbort = undefined;
	}

	private async stopChild(child: ManagedHindsightChildProcess): Promise<void> {
		if (!hasExited(child)) {
			const exited = waitForExit(child, 10_000);
			child.kill("SIGTERM");
			await exited;
			if (!hasExited(child)) {
				const killed = new Promise<void>((done) => child.once("exit", () => done()));
				child.kill("SIGKILL");
				await killed;
			}
		}
		if (this.child === child) this.child = undefined;
	}

	private async start(signal: AbortSignal): Promise<HindsightRuntime> {
		const baseUrl = normalizeBaseUrl(this.env.HINDSIGHT_URL);
		signal.throwIfAborted();
		if (await this.probe(baseUrl, signal)) return { baseUrl, owned: false };

		signal.throwIfAborted();
		const endpoint = managedEndpoint(baseUrl);
		const executable = this.executable();
		if (!this.serving) {
			const target = await validateMemoryModels(loadSettings());
			this.targetModels = target;
			this.serving = { ...await this.transport.register(target), models: target };
		}
		signal.throwIfAborted();
		const env = await this.configurationEnv();
		signal.throwIfAborted();
		const child = this.spawnProcess(executable, [
			join(DEFAULT_SERVICE_ROOT, "telomi_configuration.py"),
			"--host", endpoint.hostname,
			"--port", endpoint.port,
		], {
			cwd: this.serviceRoot,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
		this.child = child;
		const childAbort = new AbortController();
		const childSignal = AbortSignal.any([signal, childAbort.signal]);
		let healthy = false;
		const exitCleanup = () => { child.kill("SIGKILL"); };
		process.once("exit", exitCleanup);
		// Drain native output; only the last native error line reaches API errors, with database URLs redacted.
		let stderrTail = "";
		child.stdout?.resume();
		child.stderr?.on("data", (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-4_000); });
		const stopped = (error: Error) => {
			// A Python service leader may exit while its worker processes remain.
			exitCleanup();
			process.removeListener("exit", exitCleanup);
			childAbort.abort(error);
			if (this.child === child) {
				this.child = undefined;
				if (healthy) {
					this.ready = undefined;
					this.activeModels = null;
					if (!this.applying && !this.closing) { this.configurationPhase = "failed"; this.configurationError = "Hindsight exited"; }
				}
			}
		};
		child.once("exit", (code, signal) => stopped(new Error(`Hindsight exited: ${signal ?? code}`)));
		child.once("error", (error) => stopped(error));
		try {
			await this.waitUntilHealthy(baseUrl, child, childSignal);
			healthy = true;
			if (!this.applying) {
				this.activeModels = this.serving?.models ?? null;
				this.configurationPhase = isDeepStrictEqual(this.targetModels, this.activeModels) ? "active" : "failed";
				// A start that succeeds after an earlier failed one must not keep reporting that failure.
				if (this.configurationPhase === "active") this.configurationError = null;
			}
			return { baseUrl, owned: true };
		} catch (error) {
			await this.stopChild(child);
			const reason = nativeErrorLine(stderrTail);
			throw new Error(`Hindsight failed to start (process ${child.signalCode ?? child.exitCode ?? "cancelled"})${reason ? `: ${reason}` : ""}`, { cause: error });
		}
	}

	private executable(): string {
		const configuredExecutable = resolve(
			this.env.TELOMI_HINDSIGHT_EXECUTABLE?.trim()
				|| join(this.serviceRoot, ".venv", "bin", "python"),
		);
		// Managed worktrees still name the native CLI; run its interpreter with our native application.
		const siblingPython = join(dirname(configuredExecutable), "python");
		const executable = basename(configuredExecutable) === "hindsight-api" && existsSync(siblingPython) ? siblingPython : configuredExecutable;
		if (!existsSync(executable)) {
			throw new Error(`Hindsight Python environment is missing at ${executable}. Run npm run memory:install.`);
		}
		return executable;
	}

	private async configurationEnv(embeddingOverride?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
		const env = { ...this.env };
		const embedding = embeddingOverride ?? await this.embeddingEnv();
		// All model selection, fallback chains and request options come from managed settings. The reranker
		// is pinned below: Hindsight's own default (ms-marco-MiniLM, English) scores every long Chinese
		// memory near 1.0 whatever the query, which buried the user's stated preferences under topic notes.
		for (const key of Object.keys(env)) {
			if (/^HINDSIGHT_API_(?:(?:RETAIN_|REFLECT_|CONSOLIDATION_)?LLM_(?:PROVIDER|MODEL|API_KEY|BASE_URL|REASONING_EFFORT|TEMPERATURE(?:_.*)?|EXTRA_BODY|DEFAULT_HEADERS|LITELLMROUTER_CONFIG|[0-9]+_.*|STRATEGY)|RERANKER_(?:PROVIDER|[0-9]+_.*|.*(?:MODEL|API_KEY|BASE_URL|URL)))$/u.test(key)) delete env[key];
			if (key.startsWith("HINDSIGHT_API_EMBEDDINGS_")) delete env[key];
		}
		return { ...env, ...this.serving?.env, ...embedding,
			HINDSIGHT_API_HOST: "127.0.0.1",
			HINDSIGHT_API_DATABASE_URL: memoryDatabaseUrl(this.env),
			HINDSIGHT_API_WORKER_ID: this.env.HINDSIGHT_API_WORKER_ID || "pi-user-memory",
			HINDSIGHT_API_RERANKER_PROVIDER: "local",
			HINDSIGHT_API_RERANKER_LOCAL_MODEL: DEFAULT_MEMORY_RERANKER_MODEL,
			PYTHONPATH: [DEFAULT_SERVICE_ROOT, env.PYTHONPATH].filter(Boolean).join(delimiter),
			TELOMI_MEMORY_CONTROL_TOKEN: this.transport.token,
			PYTHONDONTWRITEBYTECODE: "1",
			TOKENIZERS_PARALLELISM: "false",
		};
	}

	private async probe(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
		try {
			const response = await this.fetcher(healthUrl(baseUrl), signal ? { signal } : undefined);
			signal?.throwIfAborted();
			return response.ok;
		} catch {
			return false;
		}
	}

	private async waitUntilHealthy(
		baseUrl: string,
		child: ManagedHindsightChildProcess,
		signal?: AbortSignal,
	): Promise<void> {
		while (true) {
			if (signal?.aborted) throw new Error("Hindsight startup cancelled");
			if (hasExited(child)) throw new Error(`Hindsight exited with code ${child.exitCode}`);
			if (await this.probe(baseUrl, signal)) return;
			await this.wait(250);
		}
	}

}

export function normalizeBaseUrl(value: string | undefined): string {
	const url = new URL(value?.trim() || DEFAULT_BASE_URL);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("HINDSIGHT_URL must use HTTP or HTTPS");
	}
	url.pathname = url.pathname.replace(/\/+$/u, "") || "/v1/default";
	return url.toString().replace(/\/$/u, "");
}

export function healthUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	url.pathname = url.pathname.replace(/\/v1\/default\/?$/u, "/health");
	url.search = "";
	url.hash = "";
	return url.toString();
}

function managedEndpoint(baseUrl: string): { hostname: string; port: string } {
	const url = new URL(baseUrl);
	if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
		throw new Error(`Hindsight at ${baseUrl} is external and cannot be started by Telomi`);
	}
	if (url.protocol !== "http:") throw new Error("Managed Hindsight must use loopback HTTP");
	return { hostname: "127.0.0.1", port: url.port || "80" };
}

/** The managed handle signals the whole Python service, including worker children. */
function spawnHindsight(command: string, args: readonly string[], options: SpawnOptions): ManagedHindsightChildProcess {
	const child = spawn(command, [...args], { ...options, detached: process.platform !== "win32" });
	if (process.platform !== "win32") {
		child.kill = (signal = "SIGTERM") => {
			if (!child.pid) return false;
			try { process.kill(-child.pid, signal); return true; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				throw error;
			}
		};
	}
	return child;
}

function hasExited(child: ManagedHindsightChildProcess): boolean {
	return child.exitCode !== null || child.signalCode != null;
}

function waitForExit(child: ManagedHindsightChildProcess, timeoutMs: number): Promise<void> {
	if (hasExited(child)) return Promise.resolve();
	return new Promise((resolveExit) => {
		const done = () => {
			clearTimeout(timer);
			child.removeListener("exit", done);
			resolveExit();
		};
		const timer = setTimeout(done, timeoutMs);
		child.once("exit", done);
	});
}

let defaultManager: HindsightRuntimeManager | undefined;

export function getHindsightRuntimeManager(): HindsightRuntimeManager {
	defaultManager ??= new HindsightRuntimeManager();
	return defaultManager;
}
