import { randomBytes } from "node:crypto";
import { redactSecret } from "../agent-runtime/model-connectivity.js";
import { runtimeControlRoot } from "../workspaces/server-runtime-paths.js";
import { resolveDataDir } from "../config/data-dir.js";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
	ResearchNodeError,
	waitForRetry,
	type ResearchFailureClass,
} from "../agent-runtime/retry-policy.js";
import type { ResearchSearchRequest, ResearchSearchResult } from "./search-types.js";
import { toErrorMessage } from "../lib/values.js";

const DEFAULT_PORT = 8791;
const DEFAULT_SERVICE_ROOT = fileURLToPath(new URL("../../services/research-source-service", import.meta.url));

interface SourceServiceErrorBody {
	error?: {
		code?: unknown;
		failure_class?: unknown;
		message?: unknown;
		retryable?: unknown;
		retry_after_ms?: unknown;
		details?: unknown;
	};
	detail?: unknown;
}

interface SourceServiceSearchResponse {
	schema_version?: unknown;
	source_id?: unknown;
	source?: unknown;
	results?: unknown;
}

interface CitationUrlValidationResponse {
	schema_version?: unknown;
	unavailable_urls?: unknown;
}

export interface ResearchSourceServiceClient {
	search(
		sourceId: string,
		request: ResearchSearchRequest,
		credential?: Record<string, string | null>,
	): Promise<ResearchSearchResult[]>;
}

export interface HttpResearchSourceServiceClientOptions {
	baseUrl?: string;
	token?: string;
	fetcher?: typeof fetch;
	ensureReady?: (signal?: AbortSignal) => Promise<{ baseUrl: string; token: string }>;
}

export class HttpResearchSourceServiceClient implements ResearchSourceServiceClient {
	private readonly configuredBaseUrl: string | undefined;
	private readonly configuredToken: string | undefined;
	private readonly fetcher: typeof fetch;
	private readonly ensureReady: (signal?: AbortSignal) => Promise<{ baseUrl: string; token: string }>;

	constructor(options: HttpResearchSourceServiceClientOptions = {}) {
		this.configuredBaseUrl = options.baseUrl?.replace(/\/+$/, "");
		this.configuredToken = options.token;
		this.fetcher = options.fetcher ?? fetch;
		this.ensureReady = options.ensureReady ?? ((signal) => getResearchSourceServiceManager().ensureReady(signal));
	}

	async search(
		sourceId: string,
		request: ResearchSearchRequest,
		credential?: Record<string, string | null>,
	): Promise<ResearchSearchResult[]> {
		const service = this.configuredBaseUrl
			? { baseUrl: this.configuredBaseUrl, token: this.configuredToken ?? "" }
			: await this.ensureReady(request.signal);
		// Source requests inherit caller cancellation. Do not add a wall-clock
		// deadline here because Provider pagination can legitimately run long.
		const signal = request.signal;
		let response: Response;
		try {
			response = await this.fetcher(`${service.baseUrl}/v1/search`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					...(service.token ? { authorization: `Bearer ${service.token}` } : {}),
				},
				body: JSON.stringify({
					schema_version: 1,
					source_id: sourceId,
					query: request.query,
					max_results: request.maxResults,
					criterion_ids: request.criterionIds,
					purpose: request.purpose,
					workspace_dir: request.workspaceDir,
					...(request.temporalRange ? {
						temporal_range: {
							start_date: request.temporalRange.startDate,
							end_date: request.temporalRange.endDate,
						},
					} : {}),
					...(request.providerRequest ? {
						provider_request: {
							operation: request.providerRequest.operation,
							parameters: request.providerRequest.parameters,
						},
					} : {}),
					// The Runtime states the credential for this one request, so the service answers
					// with exactly what the caller resolved rather than with settings it cached at
					// startup. Omitted only when a separately hosted service owns its own credentials.
					...(credential ? { credential } : {}),
				}),
				signal,
			});
		} catch (error) {
			if (request.signal.aborted) {
				throw new ResearchNodeError(`source '${sourceId}' request cancelled`, "cancelled", false, { cause: asError(error) });
			}
			const message = toErrorMessage(error);
			throw new ResearchNodeError(
				`FastAPI source '${sourceId}' request failed: ${message}`,
				/timeout/i.test(message) ? "timeout" : "provider",
				true,
				{ cause: asError(error) },
			);
		}
		if (!response.ok) throw await sourceServiceError(sourceId, response, credential);
		const payload = await response.json() as SourceServiceSearchResponse;
		if (payload.schema_version !== 1 || !Array.isArray(payload.results)) {
			throw new ResearchNodeError(`FastAPI source '${sourceId}' returned an invalid response`, "validation", false);
		}
		return payload.results.map((value, index) => parseSearchResult(sourceId, value, index));
	}

	/**
	 * Ask the Provider whether a candidate credential works, without it becoming the credential
	 * anything uses. The service builds a throwaway source for this call only, so no consumer,
	 * concurrent request or competing edit can pick the candidate up, and a rejection leaves the
	 * configuration in use exactly as it was. The verdict is the Provider's own answer.
	 */
	async verifyCredential(
		sourceId: string,
		credential: Record<string, string | null>,
		signal?: AbortSignal,
	): Promise<void> {
		await this.postJson(
			"/v1/credentials/verify",
			{ schema_version: 1, source_id: sourceId, credential },
			"provider-credential-check",
			signal,
		);
	}

	/** The source ids the running service registers. */
	async listSources(signal?: AbortSignal): Promise<string[]> {
		const service = this.configuredBaseUrl
			? { baseUrl: this.configuredBaseUrl, token: this.configuredToken ?? "" }
			: await this.ensureReady(signal);
		let response: Response;
		try {
			response = await this.fetcher(`${service.baseUrl}/v1/sources`, {
				headers: { accept: "application/json", ...(service.token ? { authorization: `Bearer ${service.token}` } : {}) },
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			if (signal?.aborted) throw new ResearchNodeError("source list request cancelled", "cancelled", false, { cause: asError(error) });
			throw new ResearchNodeError(`FastAPI source list request failed: ${toErrorMessage(error)}`, "provider", true, { cause: asError(error) });
		}
		if (!response.ok) throw await sourceServiceError("source-list", response);
		const payload = await response.json() as { sources?: unknown };
		if (!Array.isArray(payload.sources) || !payload.sources.every((id) => typeof id === "string")) {
			throw new ResearchNodeError("Source list returned an invalid response", "validation", false);
		}
		return payload.sources as string[];
	}

	/** Stores a directory as a content-addressed tree (material_cache). `path` must lie inside the service workspace roots. */
	async storeTree(
		path: string,
		exclude: readonly string[],
		signal?: AbortSignal,
	): Promise<{ treeSha: string; fileCount: number; totalBytes: number }> {
		const payload = await this.postJson("/v1/trees", { schema_version: 1, path, exclude: [...exclude] }, "workspace-tree", signal);
		if (
			payload.schema_version !== 1
			|| typeof payload.tree_sha !== "string"
			|| typeof payload.file_count !== "number"
			|| typeof payload.total_bytes !== "number"
		) {
			throw new ResearchNodeError("Workspace tree store returned an invalid response", "validation", false);
		}
		return { treeSha: payload.tree_sha, fileCount: payload.file_count, totalBytes: payload.total_bytes };
	}

	/** Drops snapshot trees not in keepTreeShas and collects unreferenced blobs. Provider material keeps its TTL. */
	async gcTrees(keepTreeShas: readonly string[], dryRun: boolean, signal?: AbortSignal): Promise<{ treesRemoved: number; blobsRemoved: number; bytesFreed: number }> {
		const payload = await this.postJson("/v1/trees/gc", { keep_tree_shas: [...keepTreeShas], dry_run: dryRun }, "workspace-tree", signal);
		if (typeof payload.trees_removed !== "number" || typeof payload.blobs_removed !== "number" || typeof payload.bytes_freed !== "number") {
			throw new ResearchNodeError("Workspace tree gc returned an invalid response", "validation", false);
		}
		return { treesRemoved: payload.trees_removed, blobsRemoved: payload.blobs_removed, bytesFreed: payload.bytes_freed };
	}

	/** Materializes a stored tree into an existing empty directory (clonefile on the same APFS volume). */
	async restoreTree(treeSha: string, path: string, signal?: AbortSignal): Promise<{ materializeMode: "clone" | "copy" }> {
		if (!/^[0-9a-f]{64}$/u.test(treeSha)) throw new ResearchNodeError("tree sha must be a hex sha256", "validation", false);
		const payload = await this.postJson(`/v1/trees/${treeSha}/restore`, { schema_version: 1, path }, "workspace-tree", signal);
		if (payload.schema_version !== 1 || (payload.materialize_mode !== "clone" && payload.materialize_mode !== "copy")) {
			throw new ResearchNodeError("Workspace tree restore returned an invalid response", "validation", false);
		}
		return { materializeMode: payload.materialize_mode };
	}

	private async postJson(
		route: string,
		body: Record<string, unknown>,
		label: string,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const service = this.configuredBaseUrl
			? { baseUrl: this.configuredBaseUrl, token: this.configuredToken ?? "" }
			: await this.ensureReady(signal);
		let response: Response;
		try {
			response = await this.fetcher(`${service.baseUrl}${route}`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					...(service.token ? { authorization: `Bearer ${service.token}` } : {}),
				},
				body: JSON.stringify(body),
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			if (signal?.aborted) throw new ResearchNodeError(`${label} request cancelled`, "cancelled", false, { cause: asError(error) });
			const message = toErrorMessage(error);
			throw new ResearchNodeError(`FastAPI ${label} request failed: ${message}`, "provider", true, { cause: asError(error) });
		}
		if (!response.ok) throw await sourceServiceError(label, response);
		return await response.json() as Record<string, unknown>;
	}

	async validateCitationUrls(markdown: string, signal: AbortSignal): Promise<ReadonlySet<string>> {
		const service = this.configuredBaseUrl
			? { baseUrl: this.configuredBaseUrl, token: this.configuredToken ?? "" }
			: await this.ensureReady(signal);
		let response: Response;
		try {
			response = await this.fetcher(`${service.baseUrl}/v1/citations/validate-urls`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					...(service.token ? { authorization: `Bearer ${service.token}` } : {}),
				},
				body: JSON.stringify({ schema_version: 1, markdown }),
				signal,
			});
		} catch (error) {
			if (signal.aborted) {
				throw new ResearchNodeError("citation URL validation cancelled", "cancelled", false, { cause: asError(error) });
			}
			throw new ResearchNodeError("Citation URL validation service request failed", "provider", true, { cause: asError(error) });
		}
		if (!response.ok) throw await sourceServiceError("citation-url-validator", response);
		const payload = await response.json() as CitationUrlValidationResponse;
		if (payload.schema_version !== 1 || !Array.isArray(payload.unavailable_urls)) {
			throw new ResearchNodeError("Citation URL validation service returned an invalid response", "validation", false);
		}
		return new Set(payload.unavailable_urls.map((value, index) => {
			if (typeof value !== "string") {
				throw new ResearchNodeError(`Citation URL validation result ${index} is not a URL`, "validation", false);
			}
			const url = new URL(value);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new ResearchNodeError(`Citation URL validation result ${index} is not HTTP(S)`, "validation", false);
			}
			return url.href;
		}));
	}
}

export class ResearchSourceServiceManager {
	private ready: Promise<{ baseUrl: string; token: string }> | undefined;
	private child: ChildProcess | undefined;
	private stopping = false;
	private readonly shutdown = new AbortController();
	private exitCleanup: (() => void) | undefined;

	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

	ensureReady(signal?: AbortSignal): Promise<{ baseUrl: string; token: string }> {
		// 失败不能被缓存成常驻状态。start() 在 spawn 之前就可能抛（缺 venv、无可用端口），
		// 那条路径没有 child exit 来复位 ready，于是一次早期失败会让整个 Server 进程
		// 此后永远拿不到 Source Service——Citation URL 校验会因此静默地把每份报告的
		// 全部链接判成不可达。这里让失败的尝试自己撤回，下一次调用重新启动。
		if (this.stopping) return Promise.reject(new ResearchNodeError("source service is closed", "cancelled", false));
		const startupSignal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
		this.ready ??= this.start(startupSignal).catch((error: unknown) => {
			if (!this.stopping) this.ready = undefined;
			throw error;
		});
		return this.ready;
	}

	async close(): Promise<void> {
		this.stopping = true;
		this.shutdown.abort();
		const child = this.child;
		this.child = undefined;
		this.ready = undefined;
		if (this.exitCleanup) process.removeListener("exit", this.exitCleanup);
		this.exitCleanup = undefined;
		if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		await new Promise<void>((resolveClose) => {
			const timer = setTimeout(() => {
				if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				resolveClose();
			}, 5_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolveClose();
			});
		});
	}

	private spawnOwned(command: string, args: string[], options: Parameters<typeof spawn>[2], resetReady = true): ChildProcess {
		const child = spawn(command, args, options);
		this.child = child;
		const cleanup = () => {
			if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		};
		this.exitCleanup = cleanup;
		process.once("exit", cleanup);
		child.once("close", () => {
			process.removeListener("exit", cleanup);
			if (this.child !== child) return;
			this.child = undefined;
			this.exitCleanup = undefined;
			if (resetReady && !this.stopping) this.ready = undefined;
		});
		return child;
	}

	private async preparePython(serviceRoot: string, signal?: AbortSignal): Promise<string> {
		const configured = this.env.TELOMI_RESEARCH_SOURCE_PYTHON?.trim();
		if (configured) return configured;
		const python = join(serviceRoot, ".venv", "bin", "python");
		const pendingInstall = join(serviceRoot, "artifacts", "python-install-pending");
		if (existsSync(python) && !existsSync(pendingInstall)) return python;
		signal?.throwIfAborted();
		mkdirSync(join(serviceRoot, "artifacts"), { recursive: true });
		// uv may create the interpreter before dependency installation succeeds.
		writeFileSync(pendingInstall, "uv sync --frozen pending\n");
		const child = this.spawnOwned("uv", ["sync", "--project", serviceRoot, "--frozen", "--extra", "dev", "--python", "3.11"], {
			cwd: serviceRoot,
			env: this.env,
			stdio: ["ignore", "ignore", "pipe"],
			signal,
		}, false);
		let diagnostic = "";
		child.stderr?.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4_000); });
		try {
			await new Promise<void>((resolveInstall, rejectInstall) => {
				child.once("error", rejectInstall);
				child.once("close", (code) => code === 0 ? resolveInstall() : rejectInstall(new Error(`uv exited with code ${code}`)));
			});
			if (!existsSync(python)) throw new Error(`Python environment is missing at ${python}`);
			rmSync(pendingInstall);
			return python;
		} catch (error) {
			throw new ResearchNodeError(
				`FastAPI source dependencies could not be prepared with uv sync --frozen: ${diagnostic.trim() || (toErrorMessage(error))}`,
				signal?.aborted ? "cancelled" : "permanent", false, { cause: asError(error) },
			);
		}
	}

	private async start(signal?: AbortSignal): Promise<{ baseUrl: string; token: string }> {
		const configured = this.env.TELOMI_RESEARCH_SOURCE_BASE_URL?.trim();
		const token = this.env.TELOMI_RESEARCH_SOURCE_SERVICE_TOKEN?.trim() ?? "";
		if (configured) {
			const service = { baseUrl: configured.replace(/\/+$/, ""), token };
			await waitUntilHealthy(service, signal);
			return service;
		}
		const serviceRoot = resolve(
			this.env.TELOMI_RESEARCH_SOURCE_SERVICE_DIR
				|| DEFAULT_SERVICE_ROOT,
		);
		const python = await this.preparePython(serviceRoot, signal);
		signal?.throwIfAborted();
		const configuredPort = this.env.TELOMI_RESEARCH_SOURCE_PORT?.trim();
		const port = configuredPort
			? configuredServicePort(configuredPort)
			: await availableAutostartPort(DEFAULT_PORT);
		signal?.throwIfAborted();
		const generatedToken = token || randomBytes(32).toString("base64url");
		const baseUrl = `http://127.0.0.1:${port}`;
		const stderr: Buffer[] = [];
		let stderrBytes = 0;
		const child = this.spawnOwned(python, [
			"-m",
			"research_source_service",
		], {
			cwd: serviceRoot,
			stdio: ["ignore", "ignore", "pipe"],
			env: {
				...this.env,
				PYTHONPATH: [join(serviceRoot, "src"), this.env.PYTHONPATH].filter(Boolean).join(":"),
				SOURCE_SERVICE_API_TOKEN: generatedToken,
				SOURCE_SERVICE_HOST: "127.0.0.1",
				SOURCE_SERVICE_PORT: String(port),
				SOURCE_SERVICE_WORKSPACE_ROOTS: resolveAutostartWorkspaceRoots(serviceRoot, this.env),
				SOURCE_SERVICE_ARXIV_SQLITE_PATH: resolveAutostartArxivSqlitePath(serviceRoot, this.env),
				SOURCE_SERVICE_MATERIAL_CACHE_ROOT: resolveAutostartMaterialCacheRoot(serviceRoot, this.env),
				HF_HOME: resolveAutostartHuggingFaceHome(serviceRoot, this.env),
			},
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrBytes >= 64 * 1024) return;
			stderr.push(chunk);
			stderrBytes += chunk.length;
		});
		try {
			await Promise.race([
				waitUntilHealthy({ baseUrl, token: generatedToken }, signal, child),
				new Promise<never>((_resolve, reject) => child.once("error", reject)),
			]);
			return { baseUrl, token: generatedToken };
		} catch (error) {
			if (child.pid) child.kill("SIGTERM");
			const diagnostic = Buffer.concat(stderr).toString("utf-8").trim().slice(-4_000);
			throw new ResearchNodeError(
				`FastAPI research source service failed to start: ${diagnostic || (toErrorMessage(error))}`,
				signal?.aborted ? "cancelled" : "permanent",
				false,
				{ cause: asError(error) },
			);
		}
	}
}

export function resolveAutostartWorkspaceRoots(
	serviceRoot: string,
	env: NodeJS.ProcessEnv,
): string {
	const configured = env.SOURCE_SERVICE_WORKSPACE_ROOTS?.trim();
	if (configured) return configured;
	const roots = [
		env.TELOMI_DATA_DIR?.trim(),
		resolve(serviceRoot, "../.."),
		tmpdir(),
	]
		.filter((value): value is string => Boolean(value))
		.map((value) => resolve(value));
	return [...new Set(roots)].join(delimiter);
}

export function resolveAutostartArxivSqlitePath(
	_serviceRoot: string,
	env: NodeJS.ProcessEnv,
): string {
	const configured = env.SOURCE_SERVICE_ARXIV_SQLITE_PATH?.trim();
	if (configured) return resolve(configured);
	return join(homedir(), ".telomi", "runtime", "research-sources", "arxiv-runtime.sqlite3");
}

export function resolveAutostartHuggingFaceHome(
	serviceRoot: string,
	env: NodeJS.ProcessEnv,
): string {
	const configured = env.SOURCE_SERVICE_HF_HOME?.trim();
	if (configured) return resolve(configured);
	const dataRoot = resolve(resolveDataDir(env, resolve(serviceRoot, "../..")));
	return join(runtimeControlRoot(dataRoot), "research-source-service", "huggingface");
}

export function resolveAutostartMaterialCacheRoot(
	serviceRoot: string,
	env: NodeJS.ProcessEnv,
): string {
	const configured = env.SOURCE_SERVICE_MATERIAL_CACHE_ROOT?.trim();
	if (configured) return resolve(configured);
	const dataRoot = resolve(resolveDataDir(env, resolve(serviceRoot, "../..")));
	return join(runtimeControlRoot(dataRoot), "research-source-service", "material-cache");
}

let defaultManager: ResearchSourceServiceManager | undefined;
let defaultClient: HttpResearchSourceServiceClient | undefined;

export function getResearchSourceServiceManager(): ResearchSourceServiceManager {
	defaultManager ??= new ResearchSourceServiceManager();
	return defaultManager;
}

export function getResearchSourceServiceClient(): HttpResearchSourceServiceClient {
	defaultClient ??= new HttpResearchSourceServiceClient();
	return defaultClient;
}

async function availableAutostartPort(preferredPort: number): Promise<number> {
	const preferred = await probeLoopbackPort(preferredPort);
	if (preferred !== undefined) return preferred;
	const fallback = await probeLoopbackPort(0);
	if (fallback !== undefined) return fallback;
	throw new ResearchNodeError("No loopback port is available for the FastAPI source service", "permanent", false);
}

async function probeLoopbackPort(port: number): Promise<number | undefined> {
	const server = createServer();
	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(port, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		if (!address || typeof address === "string") return undefined;
		return address.port;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return undefined;
		throw error;
	} finally {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
}

async function waitUntilHealthy(
	service: { baseUrl: string; token: string },
	signal?: AbortSignal,
	child?: ChildProcess,
): Promise<void> {
	// Readiness is governed by child exit or caller cancellation. Do not add a
	// startup deadline that can terminate a valid report run on a slow machine.
	const cancellation = signal ?? new AbortController().signal;
	while (true) {
		if (cancellation.aborted) throw new ResearchNodeError("source service startup cancelled", "cancelled", false);
		if (child && (child.exitCode !== null || child.signalCode !== null || !child.pid)) {
			throw new Error(`source service exited with code ${child.exitCode}`);
		}
		try {
			const response = await fetch(`${service.baseUrl}/v1/health`, {
				headers: service.token ? { authorization: `Bearer ${service.token}` } : {},
				signal: cancellation,
			});
			if (response.ok) return;
		} catch (error) {
			if (cancellation.aborted) throw new ResearchNodeError("source service startup cancelled", "cancelled", false, { cause: asError(error) });
		}
		await waitForRetry(100, cancellation);
	}
}

async function sourceServiceError(
	sourceId: string,
	response: Response,
	credential?: Record<string, string | null>,
): Promise<ResearchNodeError> {
	let payload: SourceServiceErrorBody = {};
	try {
		let body = await response.text();
		for (const value of Object.values(credential ?? {})) {
			if (value) body = redactSecret(body, JSON.stringify(value).slice(1, -1));
		}
		payload = JSON.parse(body) as SourceServiceErrorBody;
		// Cookie exports contain multiple independently usable secrets. Do not retain arbitrary
		// upstream diagnostics for those requests, even when only one cookie was echoed.
		if (credential?.SOURCE_SERVICE_TWITTER_COOKIE && payload.error) {
			payload.error.message = `FastAPI source '${sourceId}' returned HTTP ${response.status}`;
			payload.error.code = "provider_request_failed";
			payload.error.details = undefined;
		}
	} catch {
		// A bounded status-only error is safer than returning an upstream body.
	}
	const error = payload.error;
	const failureClass = isFailureClass(error?.failure_class) ? error.failure_class : classifyStatus(response.status);
	const retryable = typeof error?.retryable === "boolean"
		? error.retryable
		: ["timeout", "rate_limit", "provider"].includes(failureClass);
	const retryAfterMs = typeof error?.retry_after_ms === "number"
		&& Number.isFinite(error.retry_after_ms)
		&& error.retry_after_ms >= 0
		? Math.min(error.retry_after_ms, 30 * 60_000)
		: undefined;
	const message = typeof error?.message === "string"
		? error.message.replace(/\s+/g, " ").trim().slice(0, 1_000)
		: `FastAPI source '${sourceId}' returned HTTP ${response.status}`;
	const code = typeof error?.code === "string"
		? error.code.replace(/\s+/g, "_").trim().slice(0, 200)
		: undefined;
	const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details)
		? error.details as Record<string, unknown>
		: undefined;
	return new ResearchNodeError(message, failureClass, retryable, { retryAfterMs, code, details });
}

function parseSearchResult(sourceId: string, value: unknown, index: number): ResearchSearchResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ResearchNodeError(`FastAPI source '${sourceId}' result ${index} is not an object`, "validation", false);
	}
	const row = value as Record<string, unknown>;
	const id = boundedString(row.id, "id", 512);
	const title = boundedString(row.title, "title");
	const url = boundedString(row.url, "url", 8_000);
	const snippet = boundedString(row.snippet, "snippet", undefined, true);
	if (!/^https?:\/\//i.test(url)) {
		throw new ResearchNodeError(`FastAPI source '${sourceId}' result ${index} has a non-HTTP URL`, "validation", false);
	}
	const authors = Array.isArray(row.authors)
		? row.authors.map((author) => boundedString(author, "author"))
		: undefined;
	const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
		? row.metadata as Record<string, unknown>
		: undefined;
	return {
		id,
		title,
		url,
		snippet,
		...(typeof row.published_at === "string" && row.published_at.trim()
			? { publishedAt: row.published_at.trim() } : {}),
		...(authors && authors.length > 0 ? { authors } : {}),
		...(metadata ? { metadata } : {}),
	};
}

function boundedString(value: unknown, label: string, limit?: number, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && !value.trim()) || (limit !== undefined && value.length > limit)) {
		throw new ResearchNodeError(`FastAPI source result ${label} is invalid`, "validation", false);
	}
	return value.trim();
}

function isFailureClass(value: unknown): value is ResearchFailureClass {
	return typeof value === "string" && [
		"cancelled",
		"timeout",
		"rate_limit",
		"provider",
		"validation",
		"budget",
		"permanent",
	].includes(value);
}

function classifyStatus(status: number): ResearchFailureClass {
	if (status === 408 || status === 504) return "timeout";
	if (status === 429) return "rate_limit";
	if (status === 400 || status === 404 || status === 422) return "validation";
	if (status === 401 || status === 402 || status === 403) return "permanent";
	return "provider";
}

function configuredServicePort(value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
		throw new ResearchNodeError("TELOMI_RESEARCH_SOURCE_PORT must be an integer from 1 to 65535", "permanent", false);
	}
	return parsed;
}

function asError(error: unknown): Error | undefined {
	return error instanceof Error ? error : undefined;
}
