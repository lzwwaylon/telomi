import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runtimeControlRoot } from "../../workspaces/server-runtime-paths.js";
import { sha256, stableJson } from "../../lib/hash.js";
import { recordProviderCall, type ProviderCallRecorder } from "../../providers/provider-call-record.js";
import {
	ResearchNodeError,
	retryDecision,
	waitForRetry,
} from "../../agent-runtime/retry-policy.js";
import type {
	ProviderSearchOutcome,
	ProviderRuntimeEvent,
	ResearchProviderRuntimePolicy,
	ResearchSearchProvider,
	ResearchSearchRequest,
	ResearchSearchResult,
} from "../../providers/search-types.js";
import { toErrorMessage } from "../../lib/values.js";

export interface ProviderRuntimeOptions {
	databasePath: string;
}

export interface ProviderSearchContext {
	recorder?: ProviderCallRecorder;
	/** Overload state shared by every request of one Provider Child. */
	overloadBudget?: ProviderOverloadBudget;
}

let defaultRuntime: ProviderRuntime | undefined;

export function getDefaultProviderRuntime(): ProviderRuntime {
	defaultRuntime ??= new ProviderRuntime({
		databasePath: resolve(
			runtimeControlRoot(),
			"research-sources",
			"provider-runtime.sqlite3",
		),
	});
	return defaultRuntime;
}

export class ProviderRuntime {
	private readonly db: DatabaseSync;
	private readonly inflight = new Map<string, ProviderFlight>();
	private readonly accessGates = new Map<string, AccessGate>();
	private lastCleanupAt = 0;

	constructor(options: ProviderRuntimeOptions) {
		const databasePath = resolve(options.databasePath);
		mkdirSync(dirname(databasePath), { recursive: true });
		this.db = new DatabaseSync(databasePath, { timeout: 10_000 });
		this.db.exec(`
			PRAGMA journal_mode=WAL;
			PRAGMA synchronous=FULL;
			PRAGMA busy_timeout=10000;
			CREATE TABLE IF NOT EXISTS provider_cache (
				cache_key TEXT PRIMARY KEY,
				provider_id TEXT NOT NULL,
				implementation_version TEXT NOT NULL,
				scope_hash TEXT NOT NULL,
				response_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				stale_until INTEGER,
				last_accessed_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS provider_cache_expiry ON provider_cache(expires_at);
			CREATE TABLE IF NOT EXISTS provider_request_failures (
				request_key TEXT PRIMARY KEY,
				access_scope_hash TEXT NOT NULL,
				overload_attempts INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS provider_request_failures_expiry
			ON provider_request_failures(expires_at);
			CREATE TABLE IF NOT EXISTS provider_access_cooldowns (
				access_scope_hash TEXT PRIMARY KEY,
				cooldown_until INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS provider_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider_id TEXT NOT NULL,
				access_scope_hash TEXT NOT NULL,
				cache_status TEXT NOT NULL,
				outcome_status TEXT NOT NULL DEFAULT 'succeeded',
				failure_class TEXT,
				error_code TEXT,
				error_message TEXT,
				upstream_called INTEGER NOT NULL,
				attempts INTEGER NOT NULL,
				queue_wait_ms INTEGER NOT NULL,
				rate_limit_wait_ms INTEGER NOT NULL,
				started_at INTEGER NOT NULL,
				finished_at INTEGER NOT NULL
			);
		`);
		this.cleanup(Date.now());
	}

	close(): void {
		this.db.close();
	}

	async search(
		provider: ResearchSearchProvider,
		request: ResearchSearchRequest,
		context: ProviderSearchContext = {},
	): Promise<ProviderSearchOutcome> {
		this.cleanup(Date.now());
		const policy = provider.runtimePolicy?.(request) ?? bypassPolicy(provider);
		const startedAt = Date.now();
		try {
			const outcome = await this.executeSearch(provider, request, policy, context.overloadBudget);
			this.recordEvent(provider.id, policy.accessScope, outcome, startedAt, Date.now());
			if (context.recorder) recordProviderCall(context.recorder, {
				provider: provider.id, request, startedAt, outcome,
			});
			return outcome;
		} catch (error) {
			const failure = error instanceof ProviderFetchFailure ? error : undefined;
			this.recordFailureEvent(
				provider.id,
				policy.accessScope,
				failure?.execution ?? emptyExecution(),
				failure?.cause ?? error,
				startedAt,
				Date.now(),
			);
			if (context.recorder) {
				recordProviderCall(context.recorder, {
					provider: provider.id, request, startedAt, error: failure?.cause ?? error, execution: failure?.execution,
				});
			}
			throw failure?.cause ?? error;
		}
	}

	recentEvents(limit = 100): ProviderRuntimeEvent[] {
		const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
		const rows = this.db.prepare(`
			SELECT id, provider_id, access_scope_hash, cache_status, outcome_status, upstream_called,
				attempts, queue_wait_ms, rate_limit_wait_ms, failure_class, error_code,
				error_message, started_at, finished_at
			FROM provider_events ORDER BY id DESC LIMIT ?
		`).all(boundedLimit) as Array<{
			id: number;
			provider_id: string;
			access_scope_hash: string;
			cache_status: ProviderRuntimeEvent["cacheStatus"];
			outcome_status: ProviderRuntimeEvent["outcomeStatus"];
			upstream_called: number;
			attempts: number;
			queue_wait_ms: number;
			rate_limit_wait_ms: number;
			failure_class: string | null;
			error_code: string | null;
			error_message: string | null;
			started_at: number;
			finished_at: number;
		}>;
		return rows.map((row) => ({
			id: row.id,
			providerId: row.provider_id,
			accessScopeHash: row.access_scope_hash,
			cacheStatus: row.cache_status,
			outcomeStatus: row.outcome_status,
			upstreamCalled: row.upstream_called === 1,
			attempts: row.attempts,
			queueWaitMs: row.queue_wait_ms,
			rateLimitWaitMs: row.rate_limit_wait_ms,
			...(row.failure_class ? { failureClass: row.failure_class } : {}),
			...(row.error_code ? { errorCode: row.error_code } : {}),
			...(row.error_message ? { errorMessage: row.error_message } : {}),
			startedAt: row.started_at,
			finishedAt: row.finished_at,
		}));
	}

	private recordFailureEvent(
		providerId: string,
		accessScope: string,
		execution: ProviderSearchOutcome["execution"],
		error: unknown,
		startedAt: number,
		finishedAt: number,
	): void {
		this.db.prepare(`
			INSERT INTO provider_events (
				provider_id, access_scope_hash, cache_status, outcome_status, upstream_called,
				attempts, queue_wait_ms, rate_limit_wait_ms, failure_class, error_code,
				error_message, started_at, finished_at
			) VALUES (?, ?, 'error', 'failed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			providerId,
			sha256(accessScope),
			execution.upstreamCalled ? 1 : 0,
			execution.attempts,
			execution.queueWaitMs,
			execution.rateLimitWaitMs,
			error instanceof ResearchNodeError ? error.failureClass : null,
			error instanceof ResearchNodeError ? error.code ?? null : null,
			toErrorMessage(error),
			startedAt,
			finishedAt,
		);
	}

	private async executeSearch(
		provider: ResearchSearchProvider,
		request: ResearchSearchRequest,
		policy: ResearchProviderRuntimePolicy,
		overloadBudget: ProviderOverloadBudget | undefined,
	): Promise<ProviderSearchOutcome> {
		const key = requestKey(provider, policy);
		const cached = key ? this.cached(key) : undefined;
		if (cached) return cached;
		if (!key) return await this.fetch(provider, request, policy, undefined, overloadBudget);
		const pending = this.inflight.get(key);
		if (pending) return await this.joinFlight(pending, request.signal, true);
		const controller = new AbortController();
		const leader = this.fetch(provider, { ...request, signal: controller.signal }, policy, key, overloadBudget);
		const flight: ProviderFlight = { promise: leader, controller, waiters: 0, settled: false };
		this.inflight.set(key, flight);
		void leader.then(() => {
			flight.settled = true;
			this.inflight.delete(key);
		}, () => {
			flight.settled = true;
			this.inflight.delete(key);
		});
		return await this.joinFlight(flight, request.signal, false);
	}

	private recordEvent(
		providerId: string,
		accessScope: string,
		outcome: ProviderSearchOutcome,
		startedAt: number,
		finishedAt: number,
	): void {
		this.db.prepare(`
			INSERT INTO provider_events (
				provider_id, access_scope_hash, cache_status, outcome_status, upstream_called,
				attempts, queue_wait_ms, rate_limit_wait_ms, started_at, finished_at
			) VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?)
		`).run(
			providerId,
			sha256(accessScope),
			outcome.cache.status,
			outcome.execution.upstreamCalled ? 1 : 0,
			outcome.execution.attempts,
			outcome.execution.queueWaitMs,
			outcome.execution.rateLimitWaitMs,
			startedAt,
			finishedAt,
		);
	}

	private cleanup(now: number): void {
		if (now - this.lastCleanupAt < 60 * 60_000) return;
		this.db.prepare("DELETE FROM provider_cache WHERE expires_at<=?").run(now);
		this.db.prepare("DELETE FROM provider_request_failures WHERE expires_at<=?").run(now);
		this.db.prepare("DELETE FROM provider_access_cooldowns WHERE cooldown_until<=?").run(now);
		this.db.prepare("DELETE FROM provider_events WHERE finished_at<=?").run(now - 30 * 24 * 60 * 60_000);
		this.lastCleanupAt = now;
	}

	private joinFlight(
		flight: ProviderFlight,
		signal: AbortSignal,
		coalesced: boolean,
	): Promise<ProviderSearchOutcome> {
		if (signal.aborted) return Promise.reject(cancelled());
		flight.waiters += 1;
		return new Promise<ProviderSearchOutcome>((resolve, reject) => {
			let finished = false;
			const finish = (operation: () => void) => {
				if (finished) return;
				finished = true;
				signal.removeEventListener("abort", abort);
				flight.waiters -= 1;
				if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
				operation();
			};
			const abort = () => finish(() => reject(cancelled()));
			signal.addEventListener("abort", abort, { once: true });
			void flight.promise.then(
				(outcome) => finish(() => resolve(coalesced ? {
					...outcome,
					cache: { status: "coalesced", ageMs: outcome.cache.ageMs },
					execution: { ...outcome.execution, upstreamCalled: false },
				} : outcome)),
				(error) => finish(() => reject(error)),
			);
		});
	}

	private cached(key: string): ProviderSearchOutcome | undefined {
		const now = Date.now();
		const row = this.db.prepare(`
			SELECT response_json, created_at
			FROM provider_cache
			WHERE cache_key=? AND expires_at>?
		`).get(key, now) as { response_json: string; created_at: number } | undefined;
		if (!row) return undefined;
		try {
			return {
				results: JSON.parse(row.response_json) as ResearchSearchResult[],
				cache: { status: "hit", ageMs: Math.max(0, now - Number(row.created_at)) },
				execution: emptyExecution(),
			};
		} catch {
			this.db.prepare("DELETE FROM provider_cache WHERE cache_key=?").run(key);
			return undefined;
		}
	}

	private async fetch(
		provider: ResearchSearchProvider,
		request: ResearchSearchRequest,
		policy: ResearchProviderRuntimePolicy,
		key: string | undefined,
		sharedBudget: ProviderOverloadBudget | undefined,
	): Promise<ProviderSearchOutcome> {
		const gate = this.accessGates.get(policy.accessScope) ?? new AccessGate(policy);
		this.accessGates.set(policy.accessScope, gate);
		const maxAttempts = sharedBudget ? 2 : policy.maxAttempts ?? 3;
		// A caller outside a Provider Child still gets a budget of its own for this one request.
		const budgetMs = policy.overloadBudgetMs;
		const budget = budgetMs === undefined ? undefined : sharedBudget ?? new ProviderOverloadBudget();
		let attempts = 0;
		let queueWaitMs = 0;
		let intervalWaitMs = 0;
		let rateLimitWaitMs = 0;
		// This request's own controlled retry; the shared budget only records that the Child spent it.
		let retryPending = false;
		const failure = (cause: unknown) => new ProviderFetchFailure(cause, {
			upstreamCalled: attempts > 0,
			attempts,
			queueWaitMs,
			intervalWaitMs,
			rateLimitWaitMs,
		});
		let execution!: AccessResult<ResearchSearchResult[]>;
		for (;;) {
			const now = Date.now();
			if (budget?.terminal) throw failure(budget.terminal);
			const priorFailures = key ? this.requestFailureBudget(key, now) : 0;
			if (priorFailures >= maxAttempts) {
				const exhausted = upstreamBudgetExhausted(policy);
				if (!budget) throw failure(exhausted);
				// This exact request already overloaded the Provider: the Child stops rather than try other keys.
				budget.lastCause = exhausted;
				throw failure(budget.trip(provider.id, "request_retry_budget_exhausted", gate.cooldownRemainingMs()));
			}
			const persistedCooldownUntil = this.persistedCooldownUntil(policy.accessScope);
			gate.cooldown(Math.max(0, persistedCooldownUntil - now));
			const controlled = retryPending;
			retryPending = false;
			const remainingMs = budget ? budgetMs! - budget.spentMs : undefined;
			if (budget && controlled && remainingMs! <= 0) {
				throw failure(budget.trip(provider.id, "budget_exhausted", gate.cooldownRemainingMs()));
			}
			// A controlled retry ends when the budget does; the gate bounds cooldown waits by the same remainder.
			const signal = budget
				? AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, remainingMs!))])
				: request.signal;
			let upstreamStartedAt = 0;
			try {
				execution = await gate.run(signal, policy, async () => {
					// A request queued before the Child's circuit opened must not reach the Provider.
					if (budget?.terminal) throw budget.terminal;
					attempts += 1;
					upstreamStartedAt = Date.now();
					if (controlled) budget!.attempts += 1;
					try {
						// The credential captured with this policy, not whatever is configured by the
						// time the request leaves the queue: the answer and the cache entry it is
						// filed under must describe the same credential.
						return await provider.search(budget ? { ...request, signal } : request, { credential: policy.credential });
					} catch (error) {
						const decision = retryDecision(error, attempts, maxAttempts);
						if (isUpstreamOverload(error)) {
							const delayMs = overloadDelayMs(error, decision.delayMs, policy);
							gate.cooldown(delayMs);
							this.persistCooldown(policy.accessScope, delayMs);
						}
						throw error;
					}
				}, remainingMs);
				queueWaitMs += execution.queueWaitMs;
				intervalWaitMs += execution.intervalWaitMs;
				rateLimitWaitMs += execution.rateLimitWaitMs;
				if (budget) budget.spentMs += execution.rateLimitWaitMs + (controlled ? Date.now() - upstreamStartedAt : 0);
				if (controlled) budget!.recovered(provider.id);
				break;
			} catch (error) {
				if (error instanceof CooldownBeyondBudget) {
					throw failure(budget!.trip(provider.id, "retry_after_exceeds_budget", error.cooldownMs));
				}
				const accessFailure = error instanceof AccessFailure ? error : undefined;
				const cause = accessFailure?.cause ?? error;
				queueWaitMs += accessFailure?.execution.queueWaitMs ?? 0;
				intervalWaitMs += accessFailure?.execution.intervalWaitMs ?? 0;
				rateLimitWaitMs += accessFailure?.execution.rateLimitWaitMs ?? 0;
				if (budget && cause === budget.terminal) throw failure(cause);
				const overloaded = isUpstreamOverload(cause);
				const overloadFailures = key && overloaded
					? this.recordRequestFailure(key, policy, Date.now())
					: 0;
				if (key && !overloaded) this.clearRequestFailure(key);
				if (budget) {
					budget.spentMs += accessFailure?.execution.rateLimitWaitMs ?? 0;
					if (signal.aborted && !request.signal.aborted) {
						budget.spentMs = Math.max(budget.spentMs, budgetMs!);
						budget.lastCause = new ResearchNodeError(
							"Provider request did not finish within this Provider Child's overload budget",
							"timeout",
							false,
						);
						throw failure(budget.trip(provider.id, "budget_exhausted", gate.cooldownRemainingMs()));
					}
					// Overloads and other transient upstream failures share the Child's single controlled retry.
					const transient = overloaded
						|| (cause instanceof ResearchNodeError && cause.retryable && cause.failureClass !== "cancelled");
					if (accessFailure && transient) {
						budget.spentMs += Date.now() - upstreamStartedAt;
						if (!controlled) budget.attempts += 1;
						budget.lastCause = cause;
						if (budget.retryUsed || overloadFailures >= maxAttempts) {
							throw failure(budget.trip(provider.id, "retry_attempts_exhausted", gate.cooldownRemainingMs()));
						}
						budget.cooling(
							provider.id,
							cause instanceof ResearchNodeError ? cause.failureClass : "rate_limit",
							budgetMs!,
							gate.cooldownRemainingMs(),
						);
						// The gate checks the cooldown this failure set against the budget before the retry.
						budget.retryUsed = true;
						retryPending = true;
						continue;
					}
				}
				const budgetAttempts = Math.max(attempts, overloadFailures);
				const decision = retryDecision(cause, budgetAttempts, maxAttempts);
				if (!decision.retry) {
					throw failure(overloadFailures >= maxAttempts ? upstreamBudgetExhausted(policy, cause) : cause);
				}
				if (!overloaded) {
					await waitForRetry(decision.delayMs, request.signal);
				}
			}
		}
		const results = execution.value;
		if (key) this.clearRequestFailure(key);
		const now = Date.now();
		if (key && policy.cacheTtlMs && policy.cacheTtlMs > 0) {
			this.db.prepare(`
				INSERT INTO provider_cache (
					cache_key, provider_id, implementation_version, scope_hash, response_json,
					created_at, expires_at, stale_until, last_accessed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(cache_key) DO UPDATE SET
					response_json=excluded.response_json,
					created_at=excluded.created_at,
					expires_at=excluded.expires_at,
					stale_until=excluded.stale_until,
					last_accessed_at=excluded.last_accessed_at
			`).run(
				key,
				provider.id,
					provider.catalog!.implementationVersion,
				sha256(policy.cacheScope ?? ""),
				JSON.stringify(results),
				now,
				now + policy.cacheTtlMs,
				null,
				now,
			);
		}
		return {
			results,
			cache: { status: key ? "miss" : "bypass", ageMs: 0 },
			execution: {
				upstreamCalled: true,
				attempts,
				queueWaitMs,
				intervalWaitMs,
				rateLimitWaitMs,
			},
		};
	}

	private requestFailureBudget(key: string, now: number): number {
		const row = this.db.prepare(`
			SELECT overload_attempts FROM provider_request_failures
			WHERE request_key=? AND expires_at>?
		`).get(key, now) as { overload_attempts: number } | undefined;
		return row?.overload_attempts ?? 0;
	}

	private recordRequestFailure(
		key: string,
		policy: ResearchProviderRuntimePolicy,
		now: number,
	): number {
		const windowMs = policy.overloadBudgetWindowMs ?? 0;
		if (windowMs <= 0) return 0;
		this.db.prepare(`
			INSERT INTO provider_request_failures (
				request_key, access_scope_hash, overload_attempts, expires_at, updated_at
			) VALUES (?, ?, 1, ?, ?)
			ON CONFLICT(request_key) DO UPDATE SET
				overload_attempts=CASE
					WHEN provider_request_failures.expires_at<=excluded.updated_at THEN 1
					ELSE provider_request_failures.overload_attempts+1
				END,
				expires_at=excluded.expires_at,
				updated_at=excluded.updated_at
		`).run(key, sha256(policy.accessScope), now + windowMs, now);
		return this.requestFailureBudget(key, now);
	}

	private clearRequestFailure(key: string): void {
		this.db.prepare("DELETE FROM provider_request_failures WHERE request_key=?").run(key);
	}

	private persistedCooldownUntil(accessScope: string): number {
		const row = this.db.prepare(`
			SELECT cooldown_until FROM provider_access_cooldowns WHERE access_scope_hash=?
		`).get(sha256(accessScope)) as { cooldown_until: number } | undefined;
		return row?.cooldown_until ?? 0;
	}

	private persistCooldown(accessScope: string, delayMs: number): void {
		if (delayMs <= 0) return;
		this.db.prepare(`
			INSERT INTO provider_access_cooldowns (access_scope_hash, cooldown_until)
			VALUES (?, ?)
			ON CONFLICT(access_scope_hash) DO UPDATE SET
				cooldown_until=max(provider_access_cooldowns.cooldown_until, excluded.cooldown_until)
		`).run(sha256(accessScope), Date.now() + delayMs);
	}
}

/**
 * Overload state one Provider Child shares across all its requests to one Provider, owned by the
 * bridge serving that Child. Once it trips, every later request fails with `source_unavailable`
 * without reaching the Provider, so a new request key cannot extend the wait.
 */
export type ProviderOverloadTripReason =
	| "retry_attempts_exhausted"
	| "retry_after_exceeds_budget"
	| "budget_exhausted"
	| "request_retry_budget_exhausted";

export type ProviderOverloadState =
	| {
		state: "cooling";
		providerId: string;
		failureClass: string;
		waitStartedAt: number;
		budgetDeadlineAt: number;
		nextAttemptAt: number;
	}
	| {
		state: "recovered";
		providerId: string;
		failureClass: string;
		waitStartedAt: number;
		endedAt: number;
	}
	| {
		state: "unavailable";
		providerId: string;
		failureClass: string;
		waitStartedAt: number;
		endedAt: number;
		reason: ProviderOverloadTripReason;
	};

export class ProviderOverloadBudget {
	spentMs = 0;
	/** Overloaded or transiently failed attempts plus the controlled retry. */
	attempts = 0;
	retryUsed = false;
	lastCause: unknown;
	terminal: ResearchNodeError | undefined;
	private waitStartedAt: number | undefined;

	constructor(private readonly onState?: (state: ProviderOverloadState) => void) {}

	cooling(providerId: string, failureClass: string, budgetMs: number, cooldownMs: number): void {
		const now = Date.now();
		this.waitStartedAt ??= now;
		this.onState?.({
			state: "cooling",
			providerId,
			failureClass,
			waitStartedAt: this.waitStartedAt,
			budgetDeadlineAt: this.waitStartedAt + budgetMs,
			nextAttemptAt: now + cooldownMs,
		});
	}

	recovered(providerId: string): void {
		if (this.waitStartedAt === undefined || this.terminal) return;
		this.onState?.({
			state: "recovered",
			providerId,
			failureClass: this.lastCause instanceof ResearchNodeError ? this.lastCause.failureClass : "rate_limit",
			waitStartedAt: this.waitStartedAt,
			endedAt: Date.now(),
		});
		this.waitStartedAt = undefined;
	}

	trip(providerId: string, reason: ProviderOverloadTripReason, cooldownMs: number): ResearchNodeError {
		const cause = this.lastCause;
		const failureClass = cause instanceof ResearchNodeError ? cause.failureClass : "rate_limit";
		const retryAfterMs = cooldownMs > 0 ? cooldownMs : cause instanceof ResearchNodeError ? cause.retryAfterMs : undefined;
		const lastError = cause === undefined
			? "the Provider cooldown shared with other requests is still active"
			: toErrorMessage(cause).replace(/\s+/gu, " ").trim().slice(0, 500);
		this.terminal = new ResearchNodeError(
			`Provider '${providerId}' is temporarily unavailable (${reason}): ${lastError} `
			+ "This Provider Child makes no further requests to it; report the uncovered scope instead of retrying.",
			failureClass,
			false,
			{
				cause,
				...(retryAfterMs === undefined ? {} : { retryAfterMs }),
				code: "source_unavailable",
				details: {
					provider_id: providerId,
					failure_class: failureClass,
					elapsed_ms: Math.round(this.spentMs),
					attempts: this.attempts,
					retry_after_ms: retryAfterMs === undefined ? null : Math.round(retryAfterMs),
					reason,
				},
			},
		);
		const endedAt = Date.now();
		this.onState?.({
			state: "unavailable",
			providerId,
			failureClass,
			waitStartedAt: this.waitStartedAt ?? endedAt,
			endedAt,
			reason,
		});
		return this.terminal;
	}
}

interface ProviderFlight {
	promise: Promise<ProviderSearchOutcome>;
	controller: AbortController;
	waiters: number;
	settled: boolean;
}

interface QueuedAccess<T> {
	signal: AbortSignal;
	enqueuedAt: number;
	operation: () => Promise<T>;
	resolve: (result: AccessResult<T>) => void;
	reject: (error: unknown) => void;
	onAbort: () => void;
	intervalWaitMs: number;
	cooldownWaitMs: number;
	/** Longest overload cooldown this request may wait out; beyond it the gate rejects instead of waiting. */
	cooldownLimitMs: number | undefined;
}

interface AccessResult<T> {
	value: T;
	queueWaitMs: number;
	intervalWaitMs: number;
	rateLimitWaitMs: number;
}

class AccessGate {
	private readonly queue: QueuedAccess<unknown>[] = [];
	private active = 0;
	private maxConcurrency: number;
	private minIntervalMs: number;
	private lastStartedAt = 0;
	private cooldownUntil = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(policy: ResearchProviderRuntimePolicy) {
		this.maxConcurrency = policy.maxConcurrency;
		this.minIntervalMs = policy.minIntervalMs;
	}

	run<T>(
		signal: AbortSignal,
		policy: ResearchProviderRuntimePolicy,
		operation: () => Promise<T>,
		cooldownLimitMs?: number,
	): Promise<AccessResult<T>> {
		this.maxConcurrency = Math.min(this.maxConcurrency, policy.maxConcurrency);
		this.minIntervalMs = Math.max(this.minIntervalMs, policy.minIntervalMs);
		if (signal.aborted) return Promise.reject(cancelled());
		return new Promise<AccessResult<T>>((resolve, reject) => {
			const queued: QueuedAccess<T> = {
				signal,
				enqueuedAt: Date.now(),
				operation,
				resolve,
				reject,
				onAbort: () => {
					const index = this.queue.indexOf(queued as QueuedAccess<unknown>);
					if (index >= 0) this.queue.splice(index, 1);
					reject(cancelled());
				},
				intervalWaitMs: 0,
				cooldownWaitMs: 0,
				cooldownLimitMs,
			};
			signal.addEventListener("abort", queued.onAbort, { once: true });
			this.queue.push(queued as QueuedAccess<unknown>);
			this.drain();
		});
	}

	cooldown(delayMs: number): void {
		if (!Number.isFinite(delayMs) || delayMs <= 0) return;
		this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delayMs);
	}

	cooldownRemainingMs(): number {
		return Math.max(0, this.cooldownUntil - Date.now());
	}

	private drain(): void {
		if (this.timer || this.active >= this.maxConcurrency || this.queue.length === 0) return;
		const now = Date.now();
		const intervalReadyAt = this.lastStartedAt + this.minIntervalMs;
		const waitMs = Math.max(intervalReadyAt, this.cooldownUntil) - now;
		if (waitMs > 0) {
			const head = this.queue[0]!;
			const cooling = this.cooldownUntil > intervalReadyAt;
			const cooldownMs = Math.max(0, this.cooldownUntil - Math.max(now, intervalReadyAt));
			if (cooling && head.cooldownLimitMs !== undefined && cooldownMs > head.cooldownLimitMs) {
				this.queue.shift();
				head.signal.removeEventListener("abort", head.onAbort);
				head.reject(new CooldownBeyondBudget(cooldownMs));
				this.drain();
				return;
			}
			this.timer = setTimeout(() => {
				this.timer = undefined;
				// The spacing every request owes is interval wait; the rest, timer overshoot included,
				// belongs to whichever limit set this wait.
				const waited = Date.now() - now;
				const interval = cooling ? Math.min(waited, Math.max(0, intervalReadyAt - now)) : waited;
				head.intervalWaitMs += interval;
				head.cooldownWaitMs += waited - interval;
				this.drain();
			}, waitMs);
			return;
		}
		const queued = this.queue.shift();
		if (!queued) return;
		queued.signal.removeEventListener("abort", queued.onAbort);
		if (queued.signal.aborted) {
			queued.reject(cancelled());
			this.drain();
			return;
		}
		this.active += 1;
		const startedAt = Date.now();
		this.lastStartedAt = startedAt;
		const execution = {
			queueWaitMs: Math.max(0, startedAt - queued.enqueuedAt),
			intervalWaitMs: queued.intervalWaitMs,
			rateLimitWaitMs: queued.cooldownWaitMs,
		};
		void queued.operation()
			.then((value) => queued.resolve({
				value,
				...execution,
			}), (error) => queued.reject(new AccessFailure(error, execution)))
			.finally(() => {
				this.active -= 1;
				this.drain();
			});
		this.drain();
	}
}

class AccessFailure {
	constructor(
		readonly cause: unknown,
		readonly execution: Pick<ProviderSearchOutcome["execution"], "queueWaitMs" | "intervalWaitMs" | "rateLimitWaitMs">,
	) {}
}

class CooldownBeyondBudget {
	constructor(readonly cooldownMs: number) {}
}

class ProviderFetchFailure {
	constructor(
		readonly cause: unknown,
		readonly execution: ProviderSearchOutcome["execution"],
	) {}
}

function emptyExecution(): ProviderSearchOutcome["execution"] {
	return { upstreamCalled: false, attempts: 0, queueWaitMs: 0, intervalWaitMs: 0, rateLimitWaitMs: 0 };
}

function cancelled(): ResearchNodeError {
	return new ResearchNodeError("provider access wait cancelled", "cancelled", false);
}

function isUpstreamOverload(error: unknown): boolean {
	return error instanceof ResearchNodeError
		&& error.retryable
		&& (error.failureClass === "rate_limit"
			|| (error.failureClass === "provider"
				&& ["provider_error", "provider_network_error", "provider_timeout"].includes(error.code ?? "")));
}

function overloadDelayMs(
	error: unknown,
	defaultDelayMs: number,
	policy: ResearchProviderRuntimePolicy,
): number {
	return error instanceof ResearchNodeError && error.retryAfterMs !== undefined
		? error.retryAfterMs
		: policy.overloadCooldownMs ?? defaultDelayMs;
}

function upstreamBudgetExhausted(
	policy: ResearchProviderRuntimePolicy,
	cause?: unknown,
): ResearchNodeError {
	const lastError = cause instanceof Error
		? cause.message.replace(/\s+/gu, " ").trim().slice(0, 500)
		: cause === undefined ? "unavailable" : String(cause).replace(/\s+/gu, " ").trim().slice(0, 500);
	// The service states the cooldown it applied; the policy window is only a fallback for the message.
	const retryAfterMs = cause instanceof ResearchNodeError && cause.retryAfterMs !== undefined
		? cause.retryAfterMs
		: policy.overloadBudgetWindowMs ?? policy.overloadCooldownMs;
	return new ResearchNodeError(
		`Provider upstream retry budget exhausted after ${policy.maxAttempts ?? 3} attempts. `
		+ `Last upstream error: ${lastError}. `
		+ (retryAfterMs === undefined ? "Wait for the Provider cooldown before retrying; "
			: `Retry after about ${Math.ceil(retryAfterMs / 1_000)} seconds; `)
		+ "if the request is broad, narrow or split it into smaller requests.",
		"provider",
		false,
		{
			cause,
			retryAfterMs,
			code: "provider_upstream_budget_exhausted",
			details: {
				circuit_scope: "operation",
				failure_health: "upstream_overloaded",
				...(cause instanceof ResearchNodeError ? {
					last_error_code: cause.code,
					last_failure_class: cause.failureClass,
				} : {}),
			},
		},
	);
}

function requestKey(
	provider: ResearchSearchProvider,
	policy: ResearchProviderRuntimePolicy,
): string | undefined {
	if (!policy.cacheScope || policy.cacheKey === undefined || !policy.cacheTtlMs || policy.cacheTtlMs <= 0) return undefined;
	if (!provider.catalog) throw new ResearchNodeError(
		`research source '${provider.id}' cannot cache without a catalog`,
		"permanent",
		false,
	);
	return sha256(stableJson({
		provider_id: provider.id,
		implementation_version: provider.catalog.implementationVersion,
		cache_scope: policy.cacheScope,
		request: policy.cacheKey,
	}, "native"));
}

function bypassPolicy(provider: ResearchSearchProvider): ResearchProviderRuntimePolicy {
	return {
		accessScope: provider.id,
		maxConcurrency: provider.policy?.maxConcurrency ?? 2,
		minIntervalMs: provider.policy?.minIntervalMs ?? 0,
	};
}
