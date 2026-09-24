import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResearchNodeError } from "../../server/agent-runtime/retry-policy.js";
import { readProviderCallRecords } from "../../server/providers/provider-call-record.js";
import type { ResearchSearchProvider, ResearchSearchRequest } from "../../server/providers/search-types.js";
import { primeProviderAccess, startPrimeSourceBridge } from "../../server/research/pipeline/prime-search-batch.js";
import { ProviderOverloadBudget, ProviderRuntime, ResearchSourceRegistry, builtInFastApiRuntimePolicy } from "../../server/research/index.js";
import { readRuntimeRecords } from "../../server/observability/run-records.js";

// Production waits are scaled down; the attempt limits and the arXiv policy values stay production ones.
const BUDGET_MS = 600;
const root = mkdtempSync(join(tmpdir(), "telomi-arxiv-child-overload-"));

const policyRequest: ResearchSearchRequest = {
	query: "cat:cs.SD",
	maxResults: 1,
	criterionIds: [],
	purpose: "policy",
	signal: new AbortController().signal,
	workspaceDir: root,
	providerRequest: { operation: "query", parameters: { search_query: "cat:cs.SD", max_results: 1 } },
};
const production = builtInFastApiRuntimePolicy({ sourceId: "arxiv", env: {} })(policyRequest);
assert.equal(production.overloadBudgetMs, 60_000, "an arXiv Provider Child gets 60 seconds of overload budget");
assert.equal(production.maxAttempts, 1, "requests outside a Provider Child keep the single-attempt guard");

interface ErrorBody { error: { code: string; message: string; details?: Record<string, unknown> } }

/** One Prime Search bridge whose fake arXiv upstream fails with 429 on the calls `retryAfter` returns a delay for. */
async function scenario(name: string, minIntervalMs: number, retryAfter: (call: number) => number | undefined) {
	const upstream: string[] = [];
	const upstreamAt: number[] = [];
	const runtime = new ProviderRuntime({ databasePath: join(root, `${name}.sqlite3`) });
	const provider: ResearchSearchProvider = {
		id: "arxiv",
		catalog: {
			implementationVersion: "arxiv-test",
			capability: "test",
			supportedContentTypes: ["application/atom+xml"],
			fullTextAvailability: "metadata_only",
			credentialRequirement: "none",
			reliabilityTier: 1,
			freshness: "daily",
			costClass: "free",
			latencyClass: "low",
		},
		runtimePolicy: (request) => ({
			...builtInFastApiRuntimePolicy({ sourceId: "arxiv", env: {}, minIntervalMs })(request),
			overloadBudgetMs: BUDGET_MS,
		}),
		async search(request) {
			upstream.push(request.providerRequest?.operation ?? "search");
			upstreamAt.push(Date.now());
			const delay = retryAfter(upstream.length);
			if (delay !== undefined) {
				throw new ResearchNodeError("arXiv returned HTTP 429: Rate exceeded.", "rate_limit", true, {
					code: "provider_rate_limit",
					retryAfterMs: delay,
				});
			}
			return [{ id: `paper-${upstream.length}`, title: "Paper", url: `https://arxiv.org/abs/2601.0000${upstream.length}`, snippet: "" }];
		},
	};
	const workspace = join(root, name);
	for (const child of ["sub-a", "sub-b"]) mkdirSync(join(workspace, "provider-executions", child), { recursive: true });
	const runDir = join(root, `${name}-run`);
	const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(runtime).register(provider), new Set(["arxiv"]), {
		workspaceDirectory: root,
		temporalContext: { schemaVersion: 1, currentDate: "2026-09-04", timeZone: "UTC" },
		signal: new AbortController().signal,
	}, workspace, { runDir, nodeId: "prime-search-batch-1", attemptId: "attempt-1" });
	const post = async (child: string, query: string, operation: string, parameters: Record<string, unknown>) => {
		const response = await fetch(`${bridge.baseUrl}/v1/search`, {
			method: "POST",
			headers: { authorization: `Bearer ${primeExecutionToken(bridge.token, child)}`, "content-type": "application/json" },
			body: JSON.stringify({
				source_id: "arxiv",
				agent_session_id: child,
				query,
				max_results: 50,
				workspace_dir: join(workspace, "provider-executions", child),
				provider_request: { operation, parameters },
			}),
		});
		return { status: response.status, body: await response.json() as ErrorBody };
	};
	// The exact lane request `tools.arxiv.discover_papers` issues for one calendar month.
	const month = (child: string, index: number) => {
		const query = `cat:cs.SD AND submittedDate:[2026${String(index).padStart(2, "0")}010000 TO 2026${String(index).padStart(2, "0")}282359]`;
		return post(child, query, "query", {
			search_query: query, start: 0, max_results: 50, sortBy: "relevance", sortOrder: "descending", http_method: "auto",
		});
	};
	return {
		upstream,
		upstreamAt,
		month,
		post,
		calls: () => readProviderCallRecords(runDir),
		events: () => readRuntimeRecords(runDir, "research"),
		close: async () => { await bridge.close(); runtime.close(); },
	};
}

function assertUnavailable(response: { status: number; body: ErrorBody }, expected: Record<string, unknown>) {
	assert.equal(response.status, 422);
	assert.equal(response.body.error.code, "source_unavailable", response.body.error.message);
	const details = response.body.error.details ?? {};
	for (const key of ["provider_id", "failure_class", "elapsed_ms", "attempts", "retry_after_ms"]) {
		assert.ok(key in details, `source_unavailable details must carry ${key}`);
	}
	assert.equal(details.provider_id, "arxiv");
	assert.equal(details.failure_class, "rate_limit");
	assert.ok(Number(details.elapsed_ms) <= BUDGET_MS, "the Provider Child never spends more than its budget");
	for (const [key, value] of Object.entries(expected)) assert.equal(details[key], value, key);
}

try {
	// Seven consecutive failing months: the first 429 earns one controlled retry, the second trips the child.
	const consecutive = await scenario("consecutive", 0, (call) => call === 1 ? 150 : 900);
	try {
		const startedAt = Date.now();
		for (let index = 1; index <= 7; index += 1) {
			assertUnavailable(await consecutive.month("sub-a", index), { attempts: 2, reason: "retry_attempts_exhausted" });
		}
		assertUnavailable(await consecutive.post("sub-a", "paper_front=2601.00001", "paper_front", { arxiv_id: "2601.00001" }), { attempts: 2 });
		assertUnavailable(await consecutive.post("sub-a", "download_pdf=2601.00001", "download_pdf", { arxiv_id: "2601.00001" }), { attempts: 2 });
		const elapsedMs = Date.now() - startedAt;
		assert.deepEqual(consecutive.upstream, ["query", "query"], "after the circuit opens no month, profile, or download reaches arXiv");
		// Per-month accumulation would wait 150 ms and then 900 ms for each later month (over 5 seconds).
		assert.ok(elapsedMs < 3_000, `seven failing months must not accumulate cooldowns (took ${elapsedMs} ms)`);
		const calls = consecutive.calls();
		assert.equal(calls.length, 9);
		assert.deepEqual(calls.map((call) => call.execution?.attempts), [2, 0, 0, 0, 0, 0, 0, 0, 0]);
		// Anchor on the fake upstream's own timestamps: the recorded gate wait can be shorter than
		// Retry-After when a busy host spends part of the cooldown elsewhere before the gate.
		assert.ok(consecutive.upstreamAt[1]! - consecutive.upstreamAt[0]! >= 140, `the controlled retry waited out Retry-After (retried after ${consecutive.upstreamAt[1]! - consecutive.upstreamAt[0]!} ms)`);
		assert.ok((calls[0]?.execution?.rate_limit_wait_ms ?? 0) >= 0);
		assert.ok(calls.reduce((sum, call) => sum + (call.execution?.rate_limit_wait_ms ?? 0), 0) <= BUDGET_MS);
		assert.ok(calls.every((call) => call.response.error_code === "source_unavailable"));
		assert.deepEqual(primeProviderAccess(calls, { provider_id: "arxiv", workspace_path: "provider-executions/sub-a" }), {
			upstream_attempts: 2,
			interval_wait_ms: calls.reduce((sum, call) => sum + (call.execution?.interval_wait_ms ?? 0), 0),
			rate_limit_wait_ms: calls.reduce((sum, call) => sum + (call.execution?.rate_limit_wait_ms ?? 0), 0),
			termination: { code: "source_unavailable", reason: "retry_attempts_exhausted" },
		});
		assert.equal(primeProviderAccess(calls, { provider_id: "arxiv", workspace_path: "provider-executions/sub-b" }), undefined);
	} finally {
		await consecutive.close();
	}

	// A Retry-After beyond the remaining budget ends the child at once: no wait and no second request.
	const longRetryAfter = await scenario("long-retry-after", 0, () => 5_000);
	try {
		const startedAt = Date.now();
		const first = await longRetryAfter.month("sub-a", 1);
		assertUnavailable(first, { attempts: 1, reason: "retry_after_exceeds_budget" });
		assert.ok(Number(first.body.error.details?.retry_after_ms) > BUDGET_MS);
		const states = longRetryAfter.events().filter((event) => event.type === "runtime.provider_access");
		assert.deepEqual(states.map((event) => event.state), ["cooling", "unavailable"]);
		assert.equal(states[0]?.failure_class, "rate_limit");
		assert.equal(typeof states[0]?.budget_deadline_at, "string");
		assert.equal(typeof states[0]?.next_attempt_at, "string");
		assert.equal(states[1]?.reason, "retry_after_exceeds_budget");
		assert.doesNotMatch(JSON.stringify(states), /query|credential|access_scope|workspace/u);
		assertUnavailable(await longRetryAfter.month("sub-a", 2), { attempts: 1 });
		assert.ok(Date.now() - startedAt < 2_000, "a Retry-After beyond the budget must not be waited out");
		assert.equal(longRetryAfter.upstream.length, 1);
	} finally {
		await longRetryAfter.close();
	}

	// Partial coverage: a recovered retry keeps working months, the next overload trips only that child.
	const partial = await scenario("partial", 200, (call) => call === 3 || call === 5 ? 400 : undefined);
	try {
		assert.equal((await partial.month("sub-a", 1)).status, 200);
		assert.equal((await partial.month("sub-a", 2)).status, 200);
		assert.equal((await partial.month("sub-a", 3)).status, 200, "one controlled retry recovers a transient 429");
		const recoveredStates = partial.events().filter((event) => event.type === "runtime.provider_access");
		assert.deepEqual(recoveredStates.map((event) => event.state), ["cooling", "recovered"], "a successful retry must end Activity's cooling state");
		assert.equal(recoveredStates[1]?.sub_execution_id, "sub-a");
		assert.equal(recoveredStates[1]?.failure_class, "rate_limit");
		assert.equal(recoveredStates[1]?.wait_started_at, recoveredStates[0]?.wait_started_at);
		assert.equal(typeof recoveredStates[1]?.ended_at, "string");
		assertUnavailable(await partial.month("sub-a", 4), { attempts: 3, reason: "retry_attempts_exhausted" });
		for (let index = 5; index <= 7; index += 1) assertUnavailable(await partial.month("sub-a", index), { attempts: 3 });
		assert.equal(partial.upstream.length, 5);
		assert.equal((await partial.month("sub-b", 8)).status, 200, "another Provider Child keeps its own budget");
		assert.equal(partial.upstream.length, 6);
		const [first, second, recovered] = partial.calls();
		assert.equal(first?.execution?.attempts, 1);
		// Spacing and Retry-After are measured on the fake upstream's own timestamps, as above: on a busy
		// host the test itself can spend part of either wait before the gate, so the recorded wait shrinks.
		const [firstAt, secondAt, limitedAt, retriedAt] = partial.upstreamAt;
		assert.ok(secondAt! - firstAt! >= 190, `ordinary spacing holds the 200 ms interval (next call after ${secondAt! - firstAt!} ms)`);
		assert.ok((second?.execution?.interval_wait_ms ?? -1) >= 0, "ordinary spacing is recorded as interval wait");
		assert.equal(second?.execution?.rate_limit_wait_ms, 0, "ordinary spacing is not a rate-limit cooldown");
		assert.equal(recovered?.execution?.attempts, 2);
		assert.ok(retriedAt! - limitedAt! >= 390, `the retry waited out Retry-After (retried after ${retriedAt! - limitedAt!} ms)`);
		assert.ok((recovered?.execution?.rate_limit_wait_ms ?? 0) > 0, "the Retry-After wait is recorded as rate-limit wait");
	} finally {
		await partial.close();
	}

	const timeoutRuntime = new ProviderRuntime({ databasePath: join(root, "timeout.sqlite3") });
	const timeoutBudget = new ProviderOverloadBudget();
	try {
		await assert.rejects(timeoutRuntime.search({
			id: "arxiv",
			runtimePolicy: () => ({ accessScope: "timeout", maxConcurrency: 1, minIntervalMs: 0, overloadBudgetMs: 20 }),
			async search(request) {
				await new Promise((resolve) => setTimeout(resolve, 30));
				request.signal.throwIfAborted();
				return [];
			},
		}, policyRequest, { overloadBudget: timeoutBudget }), /did not finish within/u);
		assert.equal(timeoutBudget.terminal?.failureClass, "timeout", "a request deadline is not mislabeled as a rate limit");
		assert.equal(timeoutBudget.terminal?.details?.failure_class, "timeout");
	} finally {
		timeoutRuntime.close();
	}
	console.log("arXiv Provider Child overload budget tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
