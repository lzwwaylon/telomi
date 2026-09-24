import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { sha256 } from "../../lib/hash.js";
import { writeFileAtomic } from "../../lib/fs.js";
import { Router } from "express";
import { Agent as HttpAgent } from "undici";

import type { BrowserReleaseReason, BrowserSessionRegistry } from "./session-registry.js";
import { toErrorMessage } from "../../lib/values.js";

const ROUTE = "/_runtime/browser-tool";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MATERIAL_BYTES = 50 * 1024 * 1024;

interface BrowserMaterialScope {
	goalId: string;
	runId: string;
	root: string;
	closed: boolean;
	releasedChildren: Set<string>;
	pendingReleases: Map<string, Promise<void>>;
}

const browserRuntimes = new Map<string, BrowserSessionRegistry>();

const materialScopes = new Map<string, BrowserMaterialScope>();

export interface BrowserToolClientConfig {
	baseUrl: string;
	token: string;
	scopeId: string;
	goalId: string;
	runId: string;
}

export function registerBrowserMaterialScope(
	config: BrowserToolClientConfig,
	root: string,
): () => void {
	const resolved = resolve(root);
	mkdirSync(join(resolved, "work", "materials", "browser"), { recursive: true });
	const key = materialScopeKey(config.token, config.scopeId);
	materialScopes.set(key, { goalId: config.goalId, runId: config.runId, root: resolved, closed: false, releasedChildren: new Set(), pendingReleases: new Map() });
	return () => materialScopes.delete(key);
}

export function browserToolClientConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): BrowserToolClientConfig | undefined {
	const baseUrl = env.TELOMI_BROWSER_TOOL_URL?.trim();
	const token = env.TELOMI_BROWSER_TOOL_TOKEN?.trim();
	const scopeId = env.TELOMI_BROWSER_TOOL_SCOPE?.trim();
	const goalId = env.TELOMI_BROWSER_TOOL_GOAL_ID?.trim();
	const runId = env.TELOMI_BROWSER_TOOL_RUN_ID?.trim();
	return baseUrl && token && scopeId && goalId && runId
		? { baseUrl, token, scopeId, goalId, runId }
		: undefined;
}

export function createBrowserToolRouter(
	registry: BrowserSessionRegistry,
	token: string,
	options: { maxMaterialBytes?: number } = {},
): Router {
	browserRuntimes.set(token, registry);
	const router = Router();
	const maxMaterialBytes = options.maxMaterialBytes ?? DEFAULT_MAX_MATERIAL_BYTES;
	router.use(ROUTE, (request, response, next) => {
		if (!isLoopback(request.socket.remoteAddress ?? "")
			|| request.headers.authorization !== `Bearer ${token}`) {
			response.status(403).json({ error: "Browser Tool is private" });
			return;
		}
		next();
	});

	router.post(`${ROUTE}/execute`, async (request, response) => {
		try {
			const body = requireBody(request.body);
			await assertBrowserChild(token, body);
			const ownerId = ownerIdFor(body.scopeId, body.agentSessionId);
			registry.beginTask({
				ownerId,
				scopeId: body.scopeId,
				goalId: body.goalId,
				runId: `${body.runId}:${body.agentSessionId}`,
			});
			const controller = new AbortController();
			request.once("aborted", () => controller.abort());
			response.once("close", () => {
				if (!response.writableEnded) controller.abort();
			});
			const output: Buffer[] = [];
			let outputBytes = 0;
			const result = await registry.execute(ownerId, body.args, {
				signal: controller.signal,
				onData: (chunk) => {
					if (outputBytes >= MAX_OUTPUT_BYTES) return;
					const remaining = MAX_OUTPUT_BYTES - outputBytes;
					const kept = chunk.subarray(0, remaining);
					output.push(kept);
					outputBytes += kept.length;
				},
			});
			response.json({
				exitCode: result.exitCode,
				output: Buffer.concat(output).toString("utf-8"),
				truncated: outputBytes >= MAX_OUTPUT_BYTES,
			});
		} catch (error) {
			response.status(422).json({ error: toErrorMessage(error) });
		}
	});

	router.post(`${ROUTE}/capture-page`, async (request, response) => {
		try {
			const body = requireIdentity(request.body);
			await assertBrowserChild(token, body);
			const outputPath = materialOutputPath(token, body, request.body?.relative_path);
			const ownerId = ownerIdFor(body.scopeId, body.agentSessionId);
			registry.beginTask({
				ownerId,
				scopeId: body.scopeId,
				goalId: body.goalId,
				runId: `${body.runId}:${body.agentSessionId}`,
			});
			const controller = new AbortController();
			request.once("aborted", () => controller.abort());
			response.once("close", () => {
				if (!response.writableEnded) controller.abort();
			});
			const output = await captureCommand(registry, ownerId, ["get", "html", "body"], maxMaterialBytes, controller.signal);
			writeFileAtomic(outputPath, output);
			response.json({ ok: true, bytes: output.byteLength });
		} catch (error) {
			response.status(422).json({ error: toErrorMessage(error) });
		}
	});

	router.post(`${ROUTE}/download`, async (request, response) => {
		try {
			const body = requireIdentity(request.body);
			const ref = requiredString(request.body?.ref, "ref");
			await assertBrowserChild(token, body);
			const outputPath = materialOutputPath(token, body, request.body?.relative_path);
			const ownerId = ownerIdFor(body.scopeId, body.agentSessionId);
			registry.beginTask({
				ownerId,
				scopeId: body.scopeId,
				goalId: body.goalId,
				runId: `${body.runId}:${body.agentSessionId}`,
			});
			const controller = new AbortController();
			request.once("aborted", () => controller.abort());
			response.once("close", () => {
				if (!response.writableEnded) controller.abort();
			});
			mkdirSync(dirname(outputPath), { recursive: true });
			const result = await registry.download(ownerId, ref, outputPath, { signal: controller.signal });
			if (result.exitCode !== 0 || !existsSync(outputPath) || !statSync(outputPath).isFile()) {
				throw new Error(`Browser attachment download failed with exit code ${result.exitCode}`);
			}
			const bytes = statSync(outputPath).size;
			if (bytes > maxMaterialBytes) {
				rmSync(outputPath, { force: true });
				throw new Error(`Browser attachment exceeds the ${maxMaterialBytes} byte limit`);
			}
			response.json({ ok: true, bytes });
		} catch (error) {
			response.status(422).json({ error: toErrorMessage(error) });
		}
	});

	return router;
}

export async function executeBrowserTool(
	config: BrowserToolClientConfig,
	agentSessionId: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; truncated: boolean }> {
	return browserToolRequest(config, "execute", {
		agent_session_id: agentSessionId,
		args,
	}, signal) as Promise<{ exitCode: number; output: string; truncated: boolean }>;
}

export async function releaseBrowserTool(
	config: BrowserToolClientConfig,
	agentSessionId: string,
	reason: BrowserReleaseReason = "completed",
): Promise<void> {
	const scope = materialScopes.get(materialScopeKey(config.token, config.scopeId));
	if (!scope) throw new Error("Browser scope is not registered");
	scope.releasedChildren.add(agentSessionId);
	const cleanup = localBrowserRuntime(config).endTask(ownerIdFor(config.scopeId, agentSessionId), reason);
	scope.pendingReleases.set(agentSessionId, cleanup);
	await cleanup;
}

/** Only a native lifecycle event may reactivate a retained Child for another turn. */
export function resumeBrowserTool(config: BrowserToolClientConfig, agentSessionId: string): void {
	const scope = materialScopes.get(materialScopeKey(config.token, config.scopeId));
	if (scope && !scope.closed) scope.releasedChildren.delete(agentSessionId);
}

export async function releaseBrowserToolScope(
	config: BrowserToolClientConfig,
	reason: BrowserReleaseReason,
): Promise<void> {
	const scope = materialScopes.get(materialScopeKey(config.token, config.scopeId));
	if (!scope) throw new Error("Browser scope is not registered");
	scope.closed = true;
	await localBrowserRuntime(config).endScope(config.scopeId, reason);
}

export async function captureBrowserPage(
	config: BrowserToolClientConfig,
	agentSessionId: string,
	relativePath: string,
	signal?: AbortSignal,
): Promise<{ ok: true; bytes: number }> {
	return browserToolRequest(config, "capture-page", {
		agent_session_id: agentSessionId,
		relative_path: relativePath,
	}, signal) as Promise<{ ok: true; bytes: number }>;
}

export async function downloadBrowserAttachment(
	config: BrowserToolClientConfig,
	agentSessionId: string,
	ref: string,
	relativePath: string,
	signal?: AbortSignal,
): Promise<{ ok: true; bytes: number }> {
	return browserToolRequest(config, "download", {
		agent_session_id: agentSessionId,
		ref,
		relative_path: relativePath,
	}, signal) as Promise<{ ok: true; bytes: number }>;
}

// A Browser call waits in the Runtime's admission queue for as long as the pool is full and then
// runs a real page; fetch's default 5-minute headers timeout turned every queued call into an
// opaque "fetch failed". Cancellation still arrives through the signal.
const browserToolDispatcher = new HttpAgent({ headersTimeout: 0, bodyTimeout: 0 });

async function browserToolRequest(
	config: BrowserToolClientConfig,
	action: "execute" | "capture-page" | "download",
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`${config.baseUrl.replace(/\/+$/u, "")}/${action}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${config.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				scope_id: config.scopeId,
				goal_id: config.goalId,
				run_id: config.runId,
				...body,
			}),
			...(signal ? { signal } : {}),
			// Node's fetch accepts an undici dispatcher; the DOM RequestInit type does not name it.
			...({ dispatcher: browserToolDispatcher } as object),
		});
	} catch (error) {
		const cause = (error as { cause?: unknown }).cause;
		throw new Error(`Browser Tool request failed: ${toErrorMessage(cause ?? error)}`);
	}
	const value = await response.json().catch(() => ({})) as { error?: unknown };
	if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `Browser Tool HTTP ${response.status}`);
	return value;
}

function requireBody(value: unknown): {
	scopeId: string;
	goalId: string;
	runId: string;
	agentSessionId: string;
	args: string[];
} {
	const identity = requireIdentity(value);
	const body = value as Record<string, unknown>;
	if (!Array.isArray(body.args) || body.args.length === 0 || body.args.length > 64
		|| body.args.some((arg) => typeof arg !== "string" || arg.length === 0 || arg.length > 4_096)) {
		throw new Error("Browser Tool args must contain 1 to 64 bounded strings");
	}
	return { ...identity, args: body.args as string[] };
}

function requireIdentity(value: unknown): {
	scopeId: string;
	goalId: string;
	runId: string;
	agentSessionId: string;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Browser Tool request must be an object");
	}
	const body = value as Record<string, unknown>;
	return {
		scopeId: requiredString(body.scope_id, "scope_id"),
		goalId: requiredString(body.goal_id, "goal_id"),
		runId: requiredString(body.run_id, "run_id"),
		agentSessionId: requiredString(body.agent_session_id, "agent_session_id"),
	};
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 512) {
		throw new Error(`Browser Tool ${name} is invalid`);
	}
	return value.trim();
}

function ownerIdFor(scopeId: string, agentSessionId: string): string {
	return `prime:${sha256(`${scopeId}\0${agentSessionId}`)}`;
}

function localBrowserRuntime(config: BrowserToolClientConfig): BrowserSessionRegistry {
	const registry = browserRuntimes.get(config.token);
	if (!registry) throw new Error("Browser lifecycle must run in its owning Runtime");
	return registry;
}

/** Host-only check, before materialization or Browser resource allocation. */
export async function assertBrowserToolChild(config: BrowserToolClientConfig, agentSessionId: string): Promise<void> {
	await assertBrowserChild(config.token, { ...config, agentSessionId });
}

async function assertBrowserChild(token: string, identity: { scopeId: string; goalId: string; runId: string; agentSessionId: string }): Promise<void> {
	if (!/^sub-[A-Za-z0-9-]+$/u.test(identity.agentSessionId)) {
		throw new Error("Browser is available only to Provider children");
	}
	const scope = materialScopes.get(materialScopeKey(token, identity.scopeId));
	if (!scope || scope.goalId !== identity.goalId || scope.runId !== identity.runId || scope.closed) {
		throw new Error("Browser scope is not active");
	}
	await scope.pendingReleases.get(identity.agentSessionId);
	if (scope.closed || materialScopes.get(materialScopeKey(token, identity.scopeId)) !== scope) throw new Error("Browser scope is not active");
	if (scope.releasedChildren.has(identity.agentSessionId)) throw new Error("Browser child has already ended");
}

function isLoopback(address: string): boolean {
	return address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127.");
}

function materialScopeKey(token: string, scopeId: string): string {
	return sha256(`${token}\0${scopeId}`);
}

function materialOutputPath(
	token: string,
	identity: { scopeId: string; goalId: string; runId: string },
	value: unknown,
): string {
	const scope = materialScopes.get(materialScopeKey(token, identity.scopeId));
	if (!scope || scope.goalId !== identity.goalId || scope.runId !== identity.runId) {
		throw new Error("Browser material scope is not registered");
	}
	const relativePath = requiredString(value, "relative_path").replaceAll("\\", "/");
	const allowedPrefix = relativePath.startsWith("work/materials/browser/")
		|| /^provider-executions\/sub-[A-Za-z0-9-]+\/work\/materials\/browser\//u.test(relativePath);
	if (isAbsolute(relativePath)
		|| !allowedPrefix
		|| relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error("Browser material path must stay under work/materials/browser/");
	}
	const root = resolve(scope.root);
	const target = resolve(root, relativePath);
	const parent = dirname(target);
	mkdirSync(parent, { recursive: true });
	const safeRoot = realpathSync(root);
	const safeParent = realpathSync(parent);
	const rel = relative(safeRoot, safeParent);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Browser material path escapes its workspace");
	}
	if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
		throw new Error("Browser material output must not be a symbolic link");
	}
	return target;
}

async function captureCommand(
	registry: BrowserSessionRegistry,
	ownerId: string,
	args: string[],
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Buffer> {
	const controller = new AbortController();
	const chunks: Buffer[] = [];
	let bytes = 0;
	const result = await registry.execute(ownerId, args, {
		signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
		onData: (chunk) => {
			bytes += chunk.byteLength;
			if (bytes > maxBytes) {
				controller.abort(new Error(`Browser page capture exceeds the ${maxBytes} byte limit`));
				return;
			}
			chunks.push(chunk);
		},
	});
	if (controller.signal.aborted) throw controller.signal.reason;
	if (result.exitCode !== 0) throw new Error(`Browser page capture failed with exit code ${result.exitCode}`);
	return Buffer.concat(chunks);
}
