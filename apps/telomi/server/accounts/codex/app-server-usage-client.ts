import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { AccountCredential } from "../types.js";

const TELOMI_VERSION = (createRequire(import.meta.url)("../../../package.json") as { version: string }).version;

interface RpcMessage {
	id?: number | string;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
	method?: string;
	params?: unknown;
}

interface RateLimitWindowResponse {
	usedPercent: number;
	windowDurationMins?: number | null;
	resetsAt?: number | null;
}

interface RateLimitSnapshotResponse {
	limitId?: string | null;
	limitName?: string | null;
	primary?: RateLimitWindowResponse | null;
	secondary?: RateLimitWindowResponse | null;
	planType?: string | null;
	rateLimitReachedType?: string | null;
}

interface AccountRateLimitsResponse {
	rateLimits: RateLimitSnapshotResponse;
	rateLimitsByLimitId?: Record<string, RateLimitSnapshotResponse> | null;
	rateLimitResetCredits?: {
		availableCount: number;
	} | null;
}

interface AccountTokenUsageResponse {
	summary: {
		lifetimeTokens?: number | null;
		peakDailyTokens?: number | null;
		longestRunningTurnSec?: number | null;
		currentStreakDays?: number | null;
		longestStreakDays?: number | null;
	};
	dailyUsageBuckets?: Array<{ startDate: string; tokens: number }> | null;
}

export interface CodexAppServerUsageResult {
	rateLimits: AccountRateLimitsResponse;
	tokenUsage: AccountTokenUsageResponse;
}

type RemoveDirectory = (path: string) => Promise<void>;

export interface RemoveCodexUsageHomeOptions {
	remove?: RemoveDirectory;
	wait?: (delayMs: number) => Promise<void>;
}

const CLEANUP_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_600];

/**
 * Reads ChatGPT-backed Codex limits through the official app-server protocol.
 *
 * The external-token login mode is experimental. The credential is sent over
 * stdin, never placed in command arguments or environment variables, and the
 * subprocess uses an isolated temporary CODEX_HOME that is removed afterward.
 */
export async function readCodexUsageViaAppServer(
	credential: AccountCredential,
	timeoutMs = 15_000,
): Promise<CodexAppServerUsageResult> {
	if (credential.type !== "oauth" || !credential.access || !credential.accountId) {
		throw new Error("Codex usage requires an OAuth access token and ChatGPT account id");
	}

	const isolatedCodexHome = mkdtempSync(join(tmpdir(), "telomi-codex-usage-"));
	const childEnv: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: isolatedCodexHome };
	delete childEnv.CODEX_ACCESS_TOKEN;
	const ownsProcessGroup = process.platform !== "win32";
	const child = spawn("codex", ["app-server", "--stdio"], {
		env: childEnv,
		stdio: ["pipe", "pipe", "pipe"],
		detached: ownsProcessGroup,
	});
	child.stdout.setEncoding("utf-8");
	child.stderr.setEncoding("utf-8");

	let stderr = "";
	child.stderr.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-4_000);
	});

	const pending = new Map<
		number,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	let terminalError: Error | null = null;
	let nextId = 1;
	const lines = createInterface({ input: child.stdout });

	const rejectPending = (error: Error) => {
		terminalError = error;
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
	};

	lines.on("line", (line) => {
		let message: RpcMessage;
		try {
			message = JSON.parse(line) as RpcMessage;
		} catch {
			return;
		}

		if (message.method && message.id !== undefined) {
			child.stdin.write(
				`${JSON.stringify({
					id: message.id,
					error: {
						code: -32_001,
						message: `Telomi cannot satisfy app-server request ${message.method} during a one-shot usage read`,
					},
				})}\n`,
			);
			return;
		}

		if (typeof message.id !== "number") return;
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		clearTimeout(request.timer);
		if (message.error) {
			request.reject(
				new Error(
					`Codex app-server RPC failed (${message.error.code ?? "unknown"}): ${message.error.message ?? "unknown error"}`,
				),
			);
			return;
		}
		request.resolve(message.result);
	});
	child.once("error", (error) => rejectPending(error));
	child.stdin.once("error", (error) => rejectPending(error));
	child.once("exit", (code, signal) => {
		if (code === 0 || terminalError) return;
		rejectPending(
			new Error(
				`Codex app-server exited before completing usage read (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			),
		);
	});

	const request = (method: string, params?: unknown): Promise<unknown> => {
		if (terminalError) return Promise.reject(terminalError);
		const id = nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(
					new Error(
						`Codex app-server request timed out: ${method}${stderr ? `; stderr=${sanitizeDiagnostic(stderr)}` : ""}`,
					),
				);
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			child.stdin.write(
				`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`,
			);
		});
	};

	try {
		await request("initialize", {
			clientInfo: { name: "telomi", title: "Telomi", version: TELOMI_VERSION },
			capabilities: { experimentalApi: true },
		});
		child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
		await request("account/login/start", {
			type: "chatgptAuthTokens",
			accessToken: credential.access,
			chatgptAccountId: credential.accountId,
		});
		const rateLimits = (await request("account/rateLimits/read")) as AccountRateLimitsResponse;
		const tokenUsage = (await request("account/usage/read")) as AccountTokenUsageResponse;
		if (!rateLimits?.rateLimits || !tokenUsage?.summary) {
			throw new Error("Codex app-server returned an incomplete usage response");
		}
		return { rateLimits, tokenUsage };
	} finally {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("Codex app-server usage reader closed"));
		}
		pending.clear();
		child.stdin.end();
		await terminateChildTree(child, ownsProcessGroup ? child.pid : undefined);
		lines.close();
		await removeCodexUsageHome(isolatedCodexHome);
	}
}

/**
 * Remove the isolated CODEX_HOME after the whole app-server process tree has
 * stopped. macOS can report ENOTEMPTY/EBUSY while a just-terminated process is
 * releasing files, so retry those lifecycle races without masking real
 * permission or path errors.
 */
export async function removeCodexUsageHome(
	path: string,
	options: RemoveCodexUsageHomeOptions = {},
): Promise<void> {
	const removeDirectory =
		options.remove ??
		((target) =>
			rm(target, {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 25,
			}));
	const wait =
		options.wait ??
		((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

	for (let attempt = 0; ; attempt += 1) {
		try {
			await removeDirectory(path);
			return;
		} catch (error) {
			if (
				!isRetryableCleanupError(error) ||
				attempt >= CLEANUP_RETRY_DELAYS_MS.length
			) {
				throw error;
			}
			await wait(CLEANUP_RETRY_DELAYS_MS[attempt]!);
		}
	}
}

async function terminateChildTree(
	child: ChildProcess,
	processGroupId: number | undefined,
): Promise<void> {
	await waitForExit(child, 250);

	if (processGroupId !== undefined) {
		signalProcessGroup(processGroupId, "SIGTERM");
		if (!(await waitForProcessGroupExit(processGroupId, 1_000))) {
			signalProcessGroup(processGroupId, "SIGKILL");
			await waitForProcessGroupExit(processGroupId, 1_000);
		}
		await waitForExit(child, 250);
		return;
	}

	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	if (await waitForExit(child, 1_000)) return;
	child.kill("SIGKILL");
	await waitForExit(child, 1_000);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off("exit", onExit);
			resolve(value);
		};
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("exit", onExit);
	});
}

async function waitForProcessGroupExit(
	processGroupId: number,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessGroupAlive(processGroupId)) {
		if (Date.now() >= deadline) return false;
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
	return true;
}

function isProcessGroupAlive(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function signalProcessGroup(
	processGroupId: number,
	signal: NodeJS.Signals,
): void {
	try {
		process.kill(-processGroupId, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function isRetryableCleanupError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
}

function sanitizeDiagnostic(value: string): string {
	return value
		.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]")
		.slice(-1_000);
}
