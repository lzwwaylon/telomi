import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import { providerToolRuntime } from "../../server/research/pipeline/provider-tool-runtime.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import { sha256 } from "../../server/lib/hash.js";
import { BrowserSessionRegistry } from "../../server/providers/browser/session-registry.js";
import { createBrowserToolRouter, executeBrowserTool } from "../../server/providers/browser/tool-router.js";
import { startPrimeSourceBridge } from "../../server/research/pipeline/prime-search-batch.js";
import { parseMaterializeSource } from "../../server/research/pipeline/browser-materialize.js";
import { providerExecutionWorkspace } from "../../server/research/pipeline/provider-execution-workspace.js";
import { ResearchSourceRegistry, ProviderRuntime } from "../../server/research/index.js";
import { ResearchNodeError } from "../../server/agent-runtime/retry-policy.js";

// The Prime kernel reaches the Browser, general web search and Skill reads through the per-run
// bridge from ipython (research_runtime). This drives the bridge the way the Python SDK does.
const root = mkdtempSync(join(tmpdir(), "telomi-prime-bridge-"));
const daemonHome = join(root, "home");
const namespace = "telomi-prime-bridge-test";
const runDir = join(daemonHome, "namespaces", namespace, "run");
mkdirSync(runDir, { recursive: true });
const fakeBin = join(root, "fake-agent-browser");
writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const session = sessionIndex >= 0 ? args[sessionIndex + 1] : process.env.AGENT_BROWSER_SESSION;
if (sessionIndex >= 0 && args[sessionIndex + 2] === "close") {
	try { fs.unlinkSync(path.join(${JSON.stringify(runDir)}, session + ".pid")); } catch {}
} else {
	fs.writeFileSync(path.join(${JSON.stringify(runDir)}, session + ".pid"), ${JSON.stringify(`${process.pid}\n`)});
	if (args.some((value) => value.endsWith("/fail"))) { process.stderr.write("boom"); process.exit(2); }
	process.stdout.write(JSON.stringify({ args, session }));
}
`, { mode: 0o755 });
chmodSync(fakeBin, 0o755);

const registry = new BrowserSessionRegistry({
	namespace,
	daemonHome,
	agentBrowserBin: fakeBin,
	maxConcurrentWorkspaces: 2,
	isProcessAlive: (pid) => pid === process.pid,
});
const token = "prime-bridge-browser-token";
const app = express();
app.use(express.json());
app.use(createBrowserToolRouter(registry, token));
const server = createServer(app);
await new Promise<void>((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind");
const browserConfig = {
	baseUrl: `http://127.0.0.1:${address.port}/_runtime/browser-tool`,
	token, scopeId: "scope-1", goalId: "goal-1", runId: "run-1",
};

const stageRoot = join(root, "stage");
mkdirSync(join(stageRoot, "skills", "provider-workers", "browser", "prime-browser-provider-skill", "references"), { recursive: true });
const referencePath = "skills/provider-workers/browser/prime-browser-provider-skill/references/dynamic-feeds.md";
writeFileSync(join(stageRoot, referencePath), "# Dynamic feeds\n");
const child = providerExecutionWorkspace(stageRoot, "sub-1a2b3c4d");
assert.equal(readFileSync(join(child.absolutePath, "work", ".execution-id"), "utf-8").trim(), "sub-1a2b3c4d",
	"a Provider child workspace carries its execution id for the Python SDK");
const conditionsPath = join(root, "execution-conditions.jsonl");
const sourceRegistry = new ResearchSourceRegistry(new ProviderRuntime({ databasePath: join(root, "provider-runtime.sqlite3") }));
sourceRegistry.register({
	id: "arxiv",
	catalog: {
		implementationVersion: "test", capability: "papers", supportedContentTypes: ["application/atom+xml"],
		fullTextAvailability: "metadata_only", credentialRequirement: "none", reliabilityTier: 1,
		freshness: "daily", costClass: "free", latencyClass: "low", capabilities: ["scholarly_papers"],
	},
	runtimePolicy: () => ({ accessScope: "test:arxiv", maxConcurrency: 1, minIntervalMs: 0, maxAttempts: 1, overloadBudgetMs: 10 }),
	search: async () => { throw new ResearchNodeError("limited", "rate_limit", true, { retryAfterMs: 100 }); },
});
sourceRegistry.register({
	id: "huggingface",
	catalog: {
		implementationVersion: "test", capability: "papers", supportedContentTypes: ["application/json"],
		fullTextAvailability: "mixed", credentialRequirement: "none", reliabilityTier: 1,
		freshness: "realtime", costClass: "free", latencyClass: "low", capabilities: ["scholarly_papers"],
	},
	search: async () => [],
});
sourceRegistry.register({
	id: "user_documents",
	catalog: {
		implementationVersion: "test", capability: "workspace files", supportedContentTypes: ["text/plain"],
		fullTextAvailability: "full_text", credentialRequirement: "none", reliabilityTier: 1,
		freshness: "static", costClass: "free", latencyClass: "low", capabilities: ["user_documents"],
	},
	search: async () => [],
});
const lifecycle = providerToolRuntime([{ ...sourceRegistry.catalog()[0]!, workerTool: {
	name: "browser", skill: "prime-browser-provider-skill", tools: ["browser", "materialize_source"],
} }], browserConfig, browserConfig.scopeId, {
	TELOMI_BROWSER_TOOL_URL: browserConfig.baseUrl, TELOMI_BROWSER_TOOL_TOKEN: token,
})!;
const unregister = lifecycle.registerWorkspace(stageRoot);
const bridge = await startPrimeSourceBridge(sourceRegistry, new Set(["arxiv", "huggingface", "user_documents"]), {
	workspaceDirectory: root,
	temporalContext: { schemaVersion: 1, currentDate: "2026-09-13", timeZone: "Asia/Singapore" },
	signal: new AbortController().signal,
}, stageRoot, { runDir: join(root, "run"), nodeId: "prime-search-batch-1", attemptId: "1" }, {
	browser: { config: browserConfig, root: stageRoot },
	conditionsPath,
});
const call = async (route: string, body: Record<string, unknown>, identity = String(body.agent_session_id ?? "root")) => {
	const response = await fetch(`${bridge.baseUrl}${route}`, {
		method: "POST", headers: { authorization: `Bearer ${primeExecutionToken(bridge.token, identity)}` }, body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json() as Record<string, unknown> };
};

try {
	const single = await call("/v1/browser", { agent_session_id: "sub-1a2b3c4d", args: ["open", "https://example.com"] });
	assert.equal(single.status, 200, JSON.stringify(single.body));
	const steps = single.body.steps as Array<{ args: string[]; exitCode: number; output: string }>;
	assert.equal(steps.length, 1);
	assert.equal(steps[0]?.exitCode, 0);
	const spawned = JSON.parse(steps[0]!.output) as { args: string[] };
	assert.ok(spawned.args.includes("open") && spawned.args.includes("https://example.com"), `the child's command reaches its Browser session: ${spawned.args.join(" ")}`);

	const program = await call("/v1/browser", { agent_session_id: "sub-1a2b3c4d", program: [["get", "title"], ["open", "https://example.com/fail"], ["get", "url"]] });
	assert.equal(program.status, 200, JSON.stringify(program.body));
	const programSteps = program.body.steps as Array<{ exitCode: number }>;
	assert.deepEqual(programSteps.map((step) => step.exitCode), [0, 2], "a program stops at the first failing command and returns every executed step");

	const misuse = await call("/v1/browser", { agent_session_id: "sub-1a2b3c4d", args: ["get", "links"] });
	assert.equal(misuse.status, 422);
	assert.match(String(misuse.body.error), /Usage: get title \| get url/u, "a malformed command comes back with its usage");
	const help = await call("/v1/browser", { agent_session_id: "sub-1a2b3c4d", args: ["help"] });
	assert.equal(help.status, 200);
	assert.match(String((help.body.steps as Array<{ output: string }>)[0]?.output), /Browser commands: open/u);
	const anonymous = await call("/v1/browser", { args: ["open", "https://example.com"] });
	assert.equal(anonymous.status, 422, "the caller must name its execution");
	const badId = await call("/v1/browser", { agent_session_id: "../../etc", args: ["open", "https://example.com"] });
	assert.equal(badId.status, 422);
	const rootCall = await call("/v1/browser", { agent_session_id: "root", args: ["snapshot", "-i"] });
	assert.equal(rootCall.status, 422, "Root cannot acquire Browser resources");
	assert.equal(registry.config.activeWorkspaces, 1);
	assert.equal(registry.observations("goal-1").length, 1);
	const rootMaterial = await call("/v1/browser/materialize", { agent_session_id: "root", source: { kind: "current_page" } });
	assert.equal(rootMaterial.status, 422, "Root cannot retain Browser material either");
	const forgedChild = await call("/v1/browser", { agent_session_id: "sub-other", args: ["open", "https://example.com"] }, "root");
	assert.equal(forgedChild.status, 401, "Root token cannot impersonate a Child");
	const forgedRoot = await call("/v1/root-search", { agent_session_id: "root", query: "test", max_results: 1 }, "sub-other");
	assert.equal(forgedRoot.status, 401, "Child token cannot impersonate Root");
	assert.equal(registry.config.activeWorkspaces, 1, "rejected calls create no workspace");

	const read = await call("/v1/skill-read", { agent_session_id: "sub-1a2b3c4d", path: referencePath });
	assert.equal(read.status, 200, JSON.stringify(read.body));
	assert.equal(read.body.text, "# Dynamic feeds\n");
	assert.equal(read.body.sha256, sha256(Buffer.from("# Dynamic feeds\n")));
	const receipts = readFileSync(conditionsPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.deepEqual(receipts.map((receipt) => [receipt.kind, receipt.agent_session_id, receipt.path, receipt.sha256]),
		[["skill_read", "sub-1a2b3c4d", referencePath, read.body.sha256]], "Runtime records the read it served, keyed by the child");
	const escape = await call("/v1/skill-read", { agent_session_id: "sub-1a2b3c4d", path: "skills/../work/.execution-id" });
	assert.equal(escape.status, 422);
	const outside = await call("/v1/skill-read", { agent_session_id: "sub-1a2b3c4d", path: "work/.execution-id" });
	assert.equal(outside.status, 422);
	assert.equal(readFileSync(conditionsPath, "utf-8").trim().split("\n").length, 1, "a rejected read leaves no receipt");

	const prematureFallback = await call("/v1/provider-fallback", {
		agent_session_id: "root", from_source_id: "arxiv", to_source_id: "huggingface",
	});
	assert.equal(prematureFallback.status, 422, "Root cannot publish a fallback before its source is unavailable");
	const unavailable = await call("/v1/search", {
		agent_session_id: "sub-1a2b3c4d", source_id: "arxiv", query: "cat:cs.SD", max_results: 1,
		workspace_dir: child.absolutePath,
	});
	assert.equal(unavailable.status, 422);
	assert.equal((unavailable.body.error as Record<string, unknown>).code, "source_unavailable");
	const incompatibleFallback = await call("/v1/provider-fallback", {
		agent_session_id: "root", from_source_id: "arxiv", to_source_id: "user_documents",
	});
	assert.equal(incompatibleFallback.status, 422, "a matching evidence type cannot replace a missing Provider capability");
	const fallback = await call("/v1/provider-fallback", {
		agent_session_id: "root", from_source_id: "arxiv", to_source_id: "huggingface",
	});
	assert.deepEqual(fallback, { status: 200, body: { accepted: true } });
	const childFallback = await call("/v1/provider-fallback", {
		agent_session_id: "sub-1a2b3c4d", from_source_id: "arxiv", to_source_id: "huggingface",
	});
	assert.equal(childFallback.status, 422, "a Provider child cannot claim that Root selected a fallback");
	const runtimeEvents = readFileSync(join(root, "run", "runtime--research.jsonl"), "utf-8")
		.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.deepEqual(runtimeEvents.at(-1), {
		type: "runtime.provider_fallback_selected",
		from_provider_id: "arxiv",
		to_provider_id: "huggingface",
		created_at: runtimeEvents.at(-1)?.created_at,
	});

	assert.deepEqual(parseMaterializeSource({ kind: "element", ref: "@e12" }), { kind: "element", ref: "@e12" });
	assert.throws(() => parseMaterializeSource({ kind: "element", ref: "e12" }), /ref like @e12/u);
	assert.throws(() => parseMaterializeSource({ kind: "file" }), /kind must be/u);
	const badSource = await call("/v1/browser/materialize", { agent_session_id: "sub-1a2b3c4d", source: { kind: "file" } });
	assert.equal(badSource.status, 422);
	assert.equal(existsSync(join(child.absolutePath, "work", "materials")), false, "a rejected materialize writes nothing");

	// Host lifecycle events release slots without any Worker HTTP cleanup call.
	const second = await call("/v1/browser", { agent_session_id: "sub-second", args: ["open", "https://example.com"] });
	assert.equal(second.status, 200);
	const third = call("/v1/browser", { agent_session_id: "sub-third", args: ["open", "https://example.com"] });
	await until(() => registry.config.queuedWorkspaces === 1);
	lifecycle.onChildEvent({ type: "rlm_child_update", child: { id: "sub-1a2b3c4d", status: "done" } });
	lifecycle.onChildEvent({ type: "rlm_child_update", child: { id: "sub-1a2b3c4d", status: "done" } });
	assert.equal((await third).status, 200, "Child terminal event admits the next queued Child");
	const stale = await call("/v1/browser", { agent_session_id: "sub-1a2b3c4d", args: ["open", "https://example.com"] });
	assert.equal(stale.status, 422, "late requests cannot resurrect an ended Child");
	// Native follow-up turns retain done status and report current work via activity.
	lifecycle.onChildEvent({ type: "rlm_child_update", child: { id: "sub-second", status: "done" } });
	lifecycle.onChildEvent({ type: "rlm_child_update", child: { id: "sub-second", status: "done", activity: { kind: "writing" } } });
	const resumed = await call("/v1/browser", { agent_session_id: "sub-second", args: ["open", "https://example.com"] });
	assert.equal(resumed.status, 200, "authoritative follow-up waits for cleanup then reacquires its own Browser");
	lifecycle.onChildEvent({ type: "rlm_child_update", child: { id: "sub-second", status: "done", activity: { kind: "waiting" } } });
	assert.equal((await call("/v1/browser", { agent_session_id: "sub-second", args: ["get", "title"] })).status, 200,
		"done status with live activity must not release an active follow-up");
	lifecycle.onChildEvent({ type: "rlm_child_update", child: { id: "sub-second", status: "cancelled" } });
	lifecycle.onChildEvent({ type: "rlm_child_update", child: { id: "sub-third", status: "failed" } });
	await until(() => registry.config.activeWorkspaces === 0);
	await lifecycle.release("completed");
	assert.equal(registry.config.queuedWorkspaces, 0);
	const late = await call("/v1/browser", { agent_session_id: "sub-new", args: ["open", "https://example.com"] });
	assert.equal(late.status, 422, "closed scope cannot acquire new Browser resources");

	// A native teardown failure is observable and aborts the affected execution; scope cleanup retries.
	const failedConfig = { ...browserConfig, scopeId: "cleanup-failure" };
	const failedLifecycle = providerToolRuntime([{ ...sourceRegistry.catalog()[0]!, workerTool: {
		name: "browser", skill: "prime-browser-provider-skill", tools: ["browser", "materialize_source"],
	} }], failedConfig, failedConfig.scopeId, {
		TELOMI_BROWSER_TOOL_URL: failedConfig.baseUrl, TELOMI_BROWSER_TOOL_TOKEN: token,
	})!;
	const unregisterFailure = failedLifecycle.registerWorkspace(join(root, "failed-scope"));
	const originalEndTask = registry.endTask.bind(registry);
	const originalError = console.error;
	let cleanupErrors = 0;
	try {
		await executeBrowserTool(failedConfig, "sub-failure", ["open", "https://example.com"]);
		let failOnce = true;
		registry.endTask = async (...args) => {
			if (failOnce) { failOnce = false; throw new Error("injected native cleanup failure"); }
			return originalEndTask(...args);
		};
		console.error = (...args) => {
			if (String(args[0]).includes("Child cleanup failed")) cleanupErrors++;
			else originalError(...args);
		};
		failedLifecycle.onChildEvent({ type: "rlm_child_update", child: { id: "sub-failure", status: "done" } });
		await until(() => failedLifecycle.signal.aborted);
		assert.equal(cleanupErrors, 1, "cleanup failure is recorded instead of swallowed");
		await assert.rejects(failedLifecycle.release("error"), /injected native cleanup failure/u);
		assert.equal(registry.config.activeWorkspaces, 0, "scope cleanup retries the remaining owner");
	} finally {
		registry.endTask = originalEndTask;
		console.error = originalError;
		unregisterFailure();
	}

	console.log("Prime bridge serves Browser, Skill reads and materialize validation to ipython callers");
} finally {
	unregister();
	await bridge.close();
	await registry.shutdownAll().catch(() => undefined);
	server.close();
	rmSync(root, { recursive: true, force: true });
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Browser lifecycle did not make progress");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
