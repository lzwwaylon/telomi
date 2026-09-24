import { EventEmitter } from "node:events";

import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveAgentPath } from "../../config/agent-directory.js";

import { readCodexUsageViaAppServer } from "./app-server-usage-client.js";
import { codexAccountManager } from "../manager.js";
import {
	CODEX_PROVIDER_KEY,
} from "../store.js";
import type {
	AccountCredential,
	CodexUsageSnapshot,
	CodexUsageTokenSummary,
} from "../types.js";
import { toErrorMessage } from "../../lib/values.js";

const DEFAULT_POLL_MS = 5 * 60_000;
const MIN_POLL_MS = 60_000;

class CodexUsageMonitor extends EventEmitter {
	private state: CodexUsageSnapshot = { status: "idle" };
	private timer: NodeJS.Timeout | null = null;
	private refreshPromise: Promise<CodexUsageSnapshot> | null = null;
	private activeAccountId: string | null = null;
	private managerListener: (() => void) | null = null;

	start(): void {
		if (this.timer) return;
		this.activeAccountId = codexAccountManager.snapshot().activeId;
		this.managerListener = () => {
			const nextActiveId = codexAccountManager.snapshot().activeId;
			if (nextActiveId === this.activeAccountId) return;
			this.activeAccountId = nextActiveId;
			void this.refresh();
		};
		codexAccountManager.on("change", this.managerListener);
		const pollMs = pollIntervalMs();
		this.timer = setInterval(() => void this.refresh(), pollMs);
		this.timer.unref();
		void this.refresh();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (this.managerListener) codexAccountManager.off("change", this.managerListener);
		this.managerListener = null;
	}

	snapshot(): CodexUsageSnapshot {
		return structuredClone(this.state);
	}

	refresh(): Promise<CodexUsageSnapshot> {
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = this.refreshOnce().finally(() => {
			this.refreshPromise = null;
		});
		return this.refreshPromise;
	}

	private async refreshOnce(): Promise<CodexUsageSnapshot> {
		const previous = this.state;
		this.state = { ...previous, status: "loading", error: undefined };
		this.emit("change", this.snapshot());

		const active = codexAccountManager.getActiveSummary();
		if (!active) {
			return this.commit({ status: "unsupported", error: "未配置 Codex 账号" });
		}

		try {
			const credential = await refreshedActiveCredential(active.id);
			if (credential.type !== "oauth") {
				return this.commit({
					status: "unsupported",
					accountId: active.id,
					error: "API Key 登录不提供 ChatGPT 订阅用量",
				});
			}
			const result = await readCodexUsageViaAppServer(credential);
			const bucket = result.rateLimits.rateLimits;
			await codexAccountManager.recordSuccess(active.id);
			return this.commit({
				status: "ok",
				checkedAt: Date.now(),
				accountId: active.id,
				planType: bucket.planType ?? null,
				primary: normalizeWindow(bucket.primary),
				secondary: normalizeWindow(bucket.secondary),
				rateLimitReachedType: bucket.rateLimitReachedType ?? null,
				resetCreditsAvailable:
					result.rateLimits.rateLimitResetCredits?.availableCount ?? null,
				tokenSummary: normalizeTokenSummary(result.tokenUsage.summary),
			});
		} catch (error) {
			return this.commit({
				status: "error",
				checkedAt: Date.now(),
				accountId: active.id,
				error: sanitizeMonitorError(error),
				...(previous.status === "ok"
					? {
							planType: previous.planType,
							primary: previous.primary,
							secondary: previous.secondary,
							rateLimitReachedType: previous.rateLimitReachedType,
							resetCreditsAvailable: previous.resetCreditsAvailable,
							tokenSummary: previous.tokenSummary,
						}
					: {}),
			});
		}
	}

	private commit(next: CodexUsageSnapshot): CodexUsageSnapshot {
		this.state = next;
		this.emit("change", this.snapshot());
		return this.snapshot();
	}
}

async function refreshedActiveCredential(activeId: string): Promise<AccountCredential> {
	const credential = codexAccountManager.getActiveCredential();
	if (!credential) throw new Error("Codex active credential is unavailable");
	if (credential.type !== "oauth") return credential;

	const credentials = new InMemoryCredentialStore();
	await credentials.modify(CODEX_PROVIDER_KEY, async () => credential as Credential);
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: resolveAgentPath("models.json"),
		refreshOnCreate: false,
	});
	// The refresh is a Provider-level credential operation; it names no model.
	if (!await runtime.getAuth(CODEX_PROVIDER_KEY)) throw new Error("Codex OAuth credential could not be resolved");

	const refreshed = await credentials.read(CODEX_PROVIDER_KEY) as AccountCredential | undefined;
	if (
		refreshed?.type === "oauth" &&
		refreshed.accountId === credential.accountId
	) {
		if (JSON.stringify(refreshed) !== JSON.stringify(credential)) {
			await codexAccountManager.updateCredential(activeId, refreshed);
		}
		return refreshed;
	}
	return credential;
}

function normalizeWindow(
	window:
		| { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null }
		| null
		| undefined,
) {
	if (!window || !Number.isFinite(window.usedPercent)) return null;
	return {
		usedPercent: window.usedPercent,
		windowDurationMins:
			typeof window.windowDurationMins === "number" ? window.windowDurationMins : null,
		resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
	};
}

function normalizeTokenSummary(
	summary: Partial<CodexUsageTokenSummary>,
): CodexUsageTokenSummary {
	return {
		lifetimeTokens: finiteOrNull(summary.lifetimeTokens),
		peakDailyTokens: finiteOrNull(summary.peakDailyTokens),
		longestRunningTurnSec: finiteOrNull(summary.longestRunningTurnSec),
		currentStreakDays: finiteOrNull(summary.currentStreakDays),
		longestStreakDays: finiteOrNull(summary.longestStreakDays),
	};
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pollIntervalMs(): number {
	const value = Number(process.env.TELOMI_CODEX_USAGE_POLL_MS);
	return Number.isFinite(value) && value > 0
		? Math.max(MIN_POLL_MS, Math.floor(value))
		: DEFAULT_POLL_MS;
}

function sanitizeMonitorError(error: unknown): string {
	const message = toErrorMessage(error);
	return message
		.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]")
		.slice(0, 500);
}

export const codexUsageMonitor = new CodexUsageMonitor();
