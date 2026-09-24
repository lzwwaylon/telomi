import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../../server/lib/hash.js";
import { startPrimeSourceBridge } from "../../server/research/pipeline/prime-search-batch.js";
import { readProviderCallRecords } from "../../server/providers/provider-call-record.js";
import { ProviderRuntime, ResearchSourceRegistry, builtInFastApiRuntimePolicy } from "../../server/research/index.js";
import { ResearchNodeError } from "../../server/agent-runtime/retry-policy.js";
import {
	type ResearchProviderRequest,
	type ResearchSearchProvider,
	type ResearchSearchRequest,
} from "../../server/providers/search-types.js";

const providerRequest = (operation: string, parameters: Record<string, unknown>): ResearchProviderRequest =>
	({ operation, parameters });

const root = mkdtempSync(join(tmpdir(), "telomi-provider-runtime-"));
const request: ResearchSearchRequest = {
	query: "shared query",
	maxResults: 5,
	criterionIds: ["criterion"],
	purpose: "provider runtime test",
	signal: new AbortController().signal,
	workspaceDir: root,
};

try {
	let upstreamCalls = 0;
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const provider: ResearchSearchProvider = {
		id: "shared",
		catalog: {
			implementationVersion: "shared-v1",
			capability: "test",
			supportedContentTypes: ["application/json"],
			fullTextAvailability: "metadata_only",
			credentialRequirement: "none",
			reliabilityTier: 1,
			freshness: "daily",
			costClass: "free",
			latencyClass: "low",
		},
		runtimePolicy: () => ({
			accessScope: "shared:public",
			cacheScope: "shared:public",
			cacheKey: { query: "shared query", maxResults: 5 },
			cacheTtlMs: 60_000,
			maxConcurrency: 1,
			minIntervalMs: 0,
		}),
		async search() {
			upstreamCalls += 1;
			await blocked;
			return [{
				id: "result",
				title: "Shared result",
				url: "https://example.com/result",
				snippet: "result",
			}];
		},
	};
	const runtime = new ProviderRuntime({ databasePath: join(root, "provider-runtime.sqlite3") });
	const first = runtime.search(provider, request);
	const second = runtime.search(provider, request);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(upstreamCalls, 1, "concurrent identical requests must share one upstream call");
	release();
	const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
	assert.equal(firstOutcome.results[0]?.id, "result");
	assert.equal(secondOutcome.results[0]?.id, "result");
	assert.deepEqual(
		new Set([firstOutcome.cache.status, secondOutcome.cache.status]),
		new Set(["miss", "coalesced"]),
	);

	const materialFile = join(root, "material.txt");
	writeFileSync(materialFile, "material bytes");
	const recordedProvider: ResearchSearchProvider = {
		...provider,
		id: "recorded",
		async search() {
			return [{
				id: "doc-1",
				title: "Recorded",
				url: "https://example.com/recorded",
				snippet: "",
				metadata: { provider_artifact_path: materialFile, created_at: "2026-03-01", pushed_at: "2026-03-02T00:00:00Z" },
			}];
		},
	};
	const failingProvider: ResearchSearchProvider = {
		...provider,
		id: "failing",
		runtimePolicy: () => ({ ...provider.runtimePolicy(request), maxAttempts: 1 }),
		async search() { throw new Error("upstream down"); },
	};
	const recorder = { runDir: join(root, "run"), nodeId: "prime-search-batch-1", attemptId: "1" };
	await runtime.search(recordedProvider, request, { recorder });
	await runtime.search(recordedProvider, request, { recorder });
	await assert.rejects(runtime.search(failingProvider, request, { recorder }));
	const records = readProviderCallRecords(recorder.runDir);
	assert.equal(records.length, 3, "every Provider call through the runtime is recorded");
	assert.deepEqual(records.map((record) => record.seq), [1, 2, 3]);
	assert.deepEqual(records.map((record) => record.response.cache), ["miss", "hit", "miss"]);
	assert.deepEqual(records.map((record) => record.response.status), ["ok", "ok", "error"]);
	assert.equal(records[0]?.node_id, "prime-search-batch-1");
	assert.equal(records[0]?.request.query, "shared query");
	assert.deepEqual(records[0]?.response.doc_ids, ["doc-1"]);
	assert.deepEqual(records[0]?.response.docs, [{ id: "doc-1", url: "https://example.com/recorded", title: "Recorded", published_at: "2026-03-01", updated_at: "2026-03-02T00:00:00Z" }]);
	assert.deepEqual(records[2]?.response.docs, []);
	assert.deepEqual(records[0]?.response.material_sha256, [sha256(readFileSync(materialFile))]);
	assert.equal(records[2]?.response.error, "upstream down");

	const bridgeProvider: ResearchSearchProvider = { ...recordedProvider, id: "bridge" };
	const bridgeRegistry = new ResearchSourceRegistry(runtime).register(bridgeProvider).register({ ...recordedProvider, id: "general_web" });
	const bridgeWorkspace = join(root, "bridge-workspace");
	const childWorkspace = join(bridgeWorkspace, "provider-executions", "sub-3171269c");
	mkdirSync(childWorkspace, { recursive: true });
	const bridgeRecorder = { ...recorder, runDir: join(root, "bridge-run") };
	const bridge = await startPrimeSourceBridge(bridgeRegistry, new Set([bridgeProvider.id]), {
		workspaceDirectory: root,
		temporalContext: { schemaVersion: 1, currentDate: "2026-09-04", timeZone: "Asia/Singapore" },
		signal: new AbortController().signal,
	}, bridgeWorkspace, bridgeRecorder);
	try {
		const response = await fetch(`${bridge.baseUrl}/v1/search`, {
			method: "POST",
			headers: { authorization: `Bearer ${primeExecutionToken(bridge.token, "sub-3171269c")}`, "content-type": "application/json" },
			body: JSON.stringify({
				agent_session_id: "sub-3171269c",
				source_id: bridgeProvider.id,
				query: "child request",
				max_results: 5,
				workspace_dir: childWorkspace,
			}),
		});
		assert.equal(response.status, 200, await response.text());
		// General Web reaches the bridge from ipython (research_runtime.search_general_web); the
		// caller names its execution id and only the Search Root is served.
		const generalInput = { query: "root discovery", max_results: 5 };
		const rootSearch = (body: Record<string, unknown>) => fetch(`${bridge.baseUrl}/v1/root-search`, {
			method: "POST", headers: { authorization: `Bearer ${primeExecutionToken(bridge.token, String(body.agent_session_id ?? "root"))}` }, body: JSON.stringify(body),
		});
		const childDenied = await rootSearch({ ...generalInput, agent_session_id: "sub-3171269c" });
		assert.equal(childDenied.status, 422, "a Provider child cannot call the Root endpoint");
		assert.match((await childDenied.json() as { error: string }).error, /only to the Search Root/);
		const anonymousDenied = await rootSearch(generalInput);
		assert.equal(anonymousDenied.status, 422, "an unnamed caller cannot call the Root endpoint");
		const wrongToken = await fetch(`${bridge.baseUrl}/v1/root-search`, {
			method: "POST", headers: { authorization: "Bearer nope" }, body: JSON.stringify({ ...generalInput, agent_session_id: "root" }),
		});
		assert.equal(wrongToken.status, 401);
		const bypass = await fetch(`${bridge.baseUrl}/v1/search`, {
			method: "POST", headers: { authorization: `Bearer ${primeExecutionToken(bridge.token, "sub-3171269c")}` },
			body: JSON.stringify({ ...generalInput, agent_session_id: "sub-3171269c", source_id: "general_web", workspace_dir: childWorkspace }),
		});
		assert.equal(bypass.status, 422, "child Provider endpoint rejects General Web");
		const rootResponse = await rootSearch({ ...generalInput, agent_session_id: "root" });
		assert.equal(rootResponse.status, 200);
		assert.equal((await rootResponse.json() as { results: unknown[] }).results.length, 1);
		const browserUnavailable = await fetch(`${bridge.baseUrl}/v1/browser`, {
			method: "POST", headers: { authorization: `Bearer ${primeExecutionToken(bridge.token, "sub-3171269c")}` },
			body: JSON.stringify({ agent_session_id: "sub-3171269c", args: ["open", "https://example.com"] }),
		});
		assert.equal(browserUnavailable.status, 422, "a run without the Browser Provider has no Browser bridge");
		const rootCalls = readProviderCallRecords(bridgeRecorder.runDir).filter((call) => call.provider === "general_web");
		assert.equal(rootCalls.length, 1, "denied child attempts never reach the Provider");
		assert.equal(rootCalls[0]?.sub_execution_id, undefined, "General Web calls belong to Root");
	} finally {
		await bridge.close();
	}
	const [bridgeRecord] = readProviderCallRecords(bridgeRecorder.runDir);
	assert.equal(bridgeRecord?.sub_execution_id, "sub-3171269c");
	assert.equal(bridgeRecord?.provider, bridgeProvider.id);

	let githubCalls = 0;
	const githubProvider: ResearchSearchProvider = {
		...provider,
		id: "github",
		runtimePolicy: builtInFastApiRuntimePolicy({
			sourceId: "github",
			env: { GITHUB_TOKEN: "github-cache-test-token" },
		}),
		async search(searchRequest) {
			githubCalls += 1;
			return [{
				id: `github-${githubCalls}`,
				title: "GitHub result",
				url: `https://github.com/example/repository?operation=${searchRequest.providerRequest?.operation}`,
				snippet: "",
			}];
		},
	};
	const githubQueryRequest: ResearchSearchRequest = {
		...request,
		query: "authentication",
		providerRequest: providerRequest("search_issues", {
			query: "authentication",
			repository: "cli/cli",
			state: "all",
			limit: 5,
		}),
	};
	assert.equal((await runtime.search(githubProvider, githubQueryRequest)).cache.status, "miss");
	assert.equal((await runtime.search(githubProvider, githubQueryRequest)).cache.status, "hit");
	assert.equal(githubCalls, 1, "GitHub query operations must use the Provider Runtime cache");

	const arxivPolicy = builtInFastApiRuntimePolicy({ sourceId: "arxiv", env: {}, minIntervalMs: 4_000 })(
		{ ...request, providerRequest: providerRequest("query", { search_query: "cat:cs.SD", max_results: 1 }) },
	);
	assert.equal(arxivPolicy.maxConcurrency, 1);
	assert.equal(arxivPolicy.minIntervalMs, 4_000);
	assert.equal(arxivPolicy.maxAttempts, 1);
	assert.equal(arxivPolicy.overloadCooldownMs, 15 * 60_000);
	assert.equal(arxivPolicy.overloadBudgetMs, 60_000);

	for (const materialRequest of [
		providerRequest("clone_repository", {
			repository: "cli/cli",
			full_history: false,
		}),
		providerRequest("download_release", {
			repository: "cli/cli",
			archive: "zip",
		}),
		providerRequest("download_file", {
			repository: "cli/cli",
			path: "README.md",
		}),
	]) {
		const materializingRequest = { ...request, providerRequest: materialRequest };
		assert.equal((await runtime.search(githubProvider, materializingRequest)).cache.status, "bypass");
		assert.equal((await runtime.search(githubProvider, materializingRequest)).cache.status, "bypass");
	}
	assert.equal(githubCalls, 7, "GitHub materializing operations must never reuse cross-task cache entries");

	let active = 0;
	let maxActive = 0;
	let releaseQueued!: () => void;
	const queuedBlock = new Promise<void>((resolve) => { releaseQueued = resolve; });
	const queuedProvider: ResearchSearchProvider = {
		...provider,
		id: "queued",
		runtimePolicy: (searchRequest) => ({
			accessScope: "shared-upstream:public",
			cacheScope: "shared-upstream:public",
			cacheKey: { query: searchRequest.query },
			cacheTtlMs: 60_000,
			maxConcurrency: 1,
			minIntervalMs: 0,
		}),
		async search(searchRequest) {
			active += 1;
			maxActive = Math.max(maxActive, active);
			if (searchRequest.query === "first") await queuedBlock;
			active -= 1;
			return [{
				id: searchRequest.query,
				title: searchRequest.query,
				url: `https://example.com/${searchRequest.query}`,
				snippet: "",
			}];
		},
	};
	const queuedFirst = runtime.search(queuedProvider, { ...request, query: "first" });
	const queuedSecond = runtime.search(queuedProvider, { ...request, query: "second" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(maxActive, 1, "different Goal requests sharing one access scope must obey global concurrency");
	releaseQueued();
	await Promise.all([queuedFirst, queuedSecond]);

	let crossGoalCalls = 0;
	let releaseCrossGoal!: () => void;
	const crossGoalBlock = new Promise<void>((resolve) => { releaseCrossGoal = resolve; });
	const crossGoalProvider: ResearchSearchProvider = {
		...provider,
		id: "cross_goal",
		runtimePolicy: () => ({
			accessScope: "cross-goal:public",
			cacheScope: "cross-goal:public",
			cacheKey: { query: "same" },
			cacheTtlMs: 60_000,
			maxConcurrency: 1,
			minIntervalMs: 0,
		}),
		async search() {
			crossGoalCalls += 1;
			await crossGoalBlock;
			return [{
				id: "cross-goal",
				title: "Cross Goal",
				url: "https://example.com/cross-goal",
				snippet: "",
			}];
		},
	};
	const goalOneRegistry = new ResearchSourceRegistry(runtime).register(crossGoalProvider);
	const goalTwoRegistry = new ResearchSourceRegistry(runtime).register(crossGoalProvider);
	const goalOne = goalOneRegistry.search("cross_goal", request);
	const goalTwo = goalTwoRegistry.search("cross_goal", request);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(crossGoalCalls, 1, "separate Goal registries must share the Host Provider Runtime");
	releaseCrossGoal();
	await Promise.all([goalOne, goalTwo]);

	const rateLimitStarts: number[] = [];
	let limitedAttempts = 0;
	const rateLimitedProvider: ResearchSearchProvider = {
		...provider,
		id: "rate_limited",
		runtimePolicy: (searchRequest) => ({
			accessScope: "rate-limited:public",
			cacheScope: "rate-limited:public",
			cacheKey: { query: searchRequest.query },
			cacheTtlMs: 60_000,
			maxConcurrency: 1,
			minIntervalMs: 0,
		}),
		async search(searchRequest) {
			rateLimitStarts.push(Date.now());
			if (searchRequest.query === "limited" && limitedAttempts++ === 0) {
				throw new ResearchNodeError("slow down", "rate_limit", true, { retryAfterMs: 50 });
			}
			return [{
				id: searchRequest.query,
				title: searchRequest.query,
				url: `https://example.com/${searchRequest.query}`,
				snippet: "",
			}];
		},
	};
	const limited = runtime.search(rateLimitedProvider, { ...request, query: "limited" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	const sibling = runtime.search(rateLimitedProvider, { ...request, query: "sibling" });
	const [limitedOutcome] = await Promise.all([limited, sibling]);
	assert.equal(limitedOutcome.execution.attempts, 2);
	assert.ok(
		Math.min(...rateLimitStarts.slice(1)) - rateLimitStarts[0]! >= 40,
		"Retry-After from one Goal must cool down every request sharing the access scope",
	);

	let terminalAttempts = 0;
	let lastTerminalRejectAt = 0;
	let afterTerminalCalledAt = 0;
	const terminalRateLimitedProvider: ResearchSearchProvider = {
		...provider,
		id: "terminal_rate_limited",
		runtimePolicy: (searchRequest) => ({
			accessScope: "terminal-rate-limited:public",
			cacheScope: "terminal-rate-limited:public",
			cacheKey: { query: searchRequest.query },
			cacheTtlMs: 60_000,
			maxConcurrency: 1,
			minIntervalMs: 0,
			maxAttempts: 4,
		}),
		async search(searchRequest) {
			terminalAttempts += 1;
			if (searchRequest.query === "after-terminal") afterTerminalCalledAt = Date.now();
			if (searchRequest.query === "terminal") {
				lastTerminalRejectAt = Date.now();
				throw new ResearchNodeError("terminal rate limit", "rate_limit", true, {
					code: "provider_rate_limit",
					retryAfterMs: 50,
				});
			}
			return [{
				id: searchRequest.query,
				title: searchRequest.query,
				url: `https://example.com/${searchRequest.query}`,
				snippet: "",
			}];
		},
	};
	await assert.rejects(runtime.search(terminalRateLimitedProvider, { ...request, query: "terminal" }));
	const terminalStartedAt = Date.now();
	const afterTerminal = await runtime.search(terminalRateLimitedProvider, { ...request, query: "after-terminal" });
	// Anchor on the provider's own timestamps: the cooldown starts at the last rejection, and a
	// busy host may spend part of it before this test even reads the clock.
	assert.ok(
		afterTerminalCalledAt - lastTerminalRejectAt >= 40,
		"terminal Retry-After must remain active for the shared access scope",
	);
	// On a busy host the cooldown can elapse during cache/DB work before the access gate.
	assert.ok(afterTerminal.execution.rateLimitWaitMs >= 0
		&& afterTerminal.execution.rateLimitWaitMs <= Date.now() - terminalStartedAt,
	"recorded access-gate wait must fit within the measured call duration");
	assert.equal(terminalAttempts, 5);
	const failedEvent = runtime.recentEvents().find((event) =>
		event.providerId === "terminal_rate_limited" && event.outcomeStatus === "failed");
	assert.equal(failedEvent?.outcomeStatus, "failed");
	assert.equal(failedEvent?.attempts, 4);
	assert.equal(failedEvent?.failureClass, "rate_limit");
	assert.equal(failedEvent?.errorCode, "provider_rate_limit");

	let persistentOverloadCalls = 0;
	/** The Runtime persists `cooldown_until` right after an upstream overload, so this is a lower bound on it. */
	let persistentOverloadUpstreamAt = 0;
	const persistentOverloadProvider: ResearchSearchProvider = {
		...provider,
		id: "persistent_overload",
		runtimePolicy: (searchRequest) => ({
			accessScope: "persistent-overload:public",
			cacheScope: "persistent-overload:public",
			cacheKey: { query: searchRequest.query },
			cacheTtlMs: 60_000,
			maxConcurrency: 1,
			minIntervalMs: 0,
			maxAttempts: 2,
			overloadCooldownMs: 500,
			overloadBudgetWindowMs: 60_000,
		}),
		async search(searchRequest) {
			persistentOverloadCalls += 1;
			persistentOverloadUpstreamAt = Date.now();
			if (searchRequest.query === "overloaded") {
				throw new ResearchNodeError(
					persistentOverloadCalls % 2 === 0 ? "HTTP 429" : "HTTP 503",
					persistentOverloadCalls % 2 === 0 ? "rate_limit" : "provider",
					true,
					{ code: persistentOverloadCalls % 2 === 0 ? "provider_rate_limit" : "provider_error" },
				);
			}
			return [{
				id: searchRequest.query,
				title: searchRequest.query,
				url: `https://example.com/${searchRequest.query}`,
				snippet: "",
			}];
		},
	};
	await assert.rejects(
		runtime.search(persistentOverloadProvider, { ...request, query: "overloaded" }),
		(error: unknown) => error instanceof ResearchNodeError
			&& error.code === "provider_upstream_budget_exhausted"
			&& error.retryable === false
			&& error.retryAfterMs === 60_000
			&& /Last upstream error: HTTP 429/u.test(error.message)
			&& /Retry after about 60 seconds[\s\S]+narrow or split/iu.test(error.message),
	);
	assert.equal(persistentOverloadCalls, 2);
	// Only the last upstream overload sets the surviving deadline: the first one is already
	// spent waiting for the retry inside the call above. A busy host can only move the real
	// deadline later than this anchor, so the lower bound below never reports falsely.
	const lastOverloadUpstreamAt = persistentOverloadUpstreamAt;

	let releaseAbortable!: () => void;
	const abortableBlock = new Promise<void>((resolve) => { releaseAbortable = resolve; });
	const abortableProvider: ResearchSearchProvider = {
		...provider,
		id: "abortable",
		runtimePolicy: () => ({
			accessScope: "abortable:public",
			cacheScope: "abortable:public",
			cacheKey: { query: "same" },
			cacheTtlMs: 60_000,
			maxConcurrency: 1,
			minIntervalMs: 0,
		}),
		async search() {
			await abortableBlock;
			return [{
				id: "abortable",
				title: "Abortable",
				url: "https://example.com/abortable",
				snippet: "",
			}];
		},
	};
	const leaderController = new AbortController();
	const followerController = new AbortController();
	const leader = runtime.search(abortableProvider, { ...request, signal: leaderController.signal });
	const follower = runtime.search(abortableProvider, { ...request, signal: followerController.signal });
	followerController.abort();
	const followerStatus = await Promise.race([
		follower.then(() => "resolved", (error: unknown) =>
			error instanceof ResearchNodeError && error.failureClass === "cancelled" ? "cancelled" : "wrong-error"),
		new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
	]);
	releaseAbortable();
	await leader;
	await follower.catch(() => undefined);
	assert.equal(followerStatus, "cancelled", "a cancelled follower must detach without cancelling the shared upstream call");
	runtime.close();

	const reopened = new ProviderRuntime({ databasePath: join(root, "provider-runtime.sqlite3") });
	await assert.rejects(
		reopened.search(persistentOverloadProvider, { ...request, query: "overloaded" }),
		(error: unknown) => error instanceof ResearchNodeError
			&& error.code === "provider_upstream_budget_exhausted",
	);
	assert.equal(persistentOverloadCalls, 2, "canonical overload budget must survive Runtime restart");
	// A different cache key in the same access scope: the reopened Runtime must not reach
	// upstream before the deadline the last overload persisted.
	await reopened.search(persistentOverloadProvider, { ...request, query: "sibling" });
	assert.equal(persistentOverloadCalls, 3);
	assert.ok(
		persistentOverloadUpstreamAt - lastOverloadUpstreamAt >= 500,
		"Provider overload cooldown must survive Runtime restart and apply across the access scope",
	);
	const persisted = await reopened.search(provider, request);
	assert.equal(persisted.cache.status, "hit", "cache entries must survive Host Runtime restart");
	assert.equal(upstreamCalls, 1);
	const events = reopened.recentEvents();
	assert.ok(events.some((event) => event.providerId === "shared" && event.cacheStatus === "coalesced"));
	assert.ok(events.some((event) => event.providerId === "shared" && event.cacheStatus === "hit" && !event.upstreamCalled));
	assert.ok(events.every((event) => /^[a-f0-9]{64}$/.test(event.accessScopeHash)));
	reopened.close();
	console.log("Provider Runtime coalescing, concurrency, cooldown, persistence, audit, and cancellation tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
