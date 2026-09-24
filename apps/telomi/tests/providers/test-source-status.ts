/**
 * Source status: what each verification outcome means for the settings page.
 *
 * The Source Service, the browser host and yt-dlp are stood in for, so what is established is the
 * mapping: a browser-backed source with no login or a rejected login needs a login, an API-key
 * source with nothing configured is merely unconfigured, a source the service does not register
 * is an error, a credential the entry point just validated is recorded without another probe, and
 * the outcome survives a restart.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

const root = mkdtempSync(join(tmpdir(), "telomi-source-status-"));
const agentDir = join(root, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const { SourceStatusMonitor } = await import("../../server/providers/source-status.js");
const { mountSourcesApi, listSources } = await import("../../server/providers/sources-api.js");
const { mountSearchCredentialsApi } = await import("../../server/providers/search-credentials-api.js");
const { ResearchNodeError } = await import("../../server/agent-runtime/retry-policy.js");
const { SOURCE_DESCRIPTORS } = await import("../../server/providers/source-descriptors.js");
const { SEARCH_CREDENTIAL_PROVIDERS } = await import("../../server/providers/search-credential-catalog.js");

const REGISTERED = ["arxiv", "general_web_exa", "general_web_firecrawl", "general_web_tavily", "github", "huggingface", "twitter", "user_documents"];

class ServiceStand {
	readonly verified: string[] = [];
	sources = REGISTERED;
	reject: Record<string, Error> = {};
	async listSources(): Promise<string[]> { return this.sources; }
	async verifyCredential(sourceId: string): Promise<void> {
		this.verified.push(sourceId);
		if (this.reject[sourceId]) throw this.reject[sourceId];
	}
}

function monitorWith(env: NodeJS.ProcessEnv, service = new ServiceStand(), overrides: Partial<ConstructorParameters<typeof SourceStatusMonitor>[0]> = {}) {
	return new SourceStatusMonitor({
		sourceService: service,
		env,
		statusPath: join(agentDir, "source-status.json"),
		refreshBrowserSessions: async () => [],
		probeYouTube: async () => undefined,
		probeBrowser: async () => true,
		...overrides,
	});
}

try {
	// The credential catalog is the descriptors' fields, nothing else.
	assert.deepEqual(
		SEARCH_CREDENTIAL_PROVIDERS.map((provider) => provider.id),
		SOURCE_DESCRIPTORS.filter((source) => source.fields).map((source) => source.id),
	);

	// Nothing configured, nothing logged in.
	const service = new ServiceStand();
	const bare = monitorWith({}, service);
	await bare.verifyAll();
	const state = (id: string) => bare.status(id)?.state;
	assert.equal(state("twitter"), "needs_login", "a browser-backed source with no cookie needs a login");
	assert.equal(state("youtube"), "needs_login", "no cookie file means no YouTube login");
	assert.equal(bare.status("youtube")?.code, "no_login");
	assert.equal(state("github"), "unconfigured", "an API-key source without a key is not an error");
	assert.equal(state("tavily"), "unconfigured");
	assert.equal(state("browser"), "ok");
	assert.equal(state("arxiv"), "ok");
	assert.equal(state("user_documents"), "ok");
	assert.deepEqual(service.verified, [], "nothing is probed without a credential to probe");

	// A login the browser holds is probed; a rejection means the login is gone.
	const withLogins = new ServiceStand();
	withLogins.reject.twitter = new ResearchNodeError("FastAPI source 'twitter' returned HTTP 401", "permanent", false);
	const loggedIn = monitorWith({
		SOURCE_SERVICE_TWITTER_COOKIE: "auth_token=a; ct0=b",
		SOURCE_SERVICE_GITHUB_TOKEN: "ghp_x",
		PI_YOUTUBE_YTDLP_COOKIE_FILE: join(root, "youtube-cookies.txt"),
	}, withLogins, {
		probeYouTube: async () => { throw new ResearchNodeError("yt-dlp requires account authorization", "permanent", false, { code: "youtube_ytdlp_authorization_required" }); },
	});
	await loggedIn.verifyAll();
	assert.equal(loggedIn.status("twitter")?.state, "needs_login");
	assert.equal(loggedIn.status("twitter")?.code, "login_rejected");
	assert.equal(loggedIn.status("github")?.state, "ok");
	assert.equal(loggedIn.status("youtube")?.state, "needs_login");
	assert.ok(withLogins.verified.includes("twitter") && withLogins.verified.includes("github"));
	assert.ok(!JSON.stringify(loggedIn.status("twitter")).includes("auth_token=a"), "a status never carries the credential");

	// An API-key rejection is an error, not a login problem; a service that does not register the
	// source, or is unreachable, is reported as such.
	const partial = new ServiceStand();
	partial.sources = REGISTERED.filter((id) => id !== "general_web_exa");
	partial.reject.github = new ResearchNodeError("FastAPI source 'github' returned HTTP 401", "permanent", false);
	const keyed = monitorWith({ SOURCE_SERVICE_GITHUB_TOKEN: "ghp_bad", SOURCE_SERVICE_EXA_API_KEY: "exa" }, partial, { probeBrowser: async () => false });
	await keyed.verifyAll();
	assert.equal(keyed.status("github")?.state, "error");
	assert.equal(keyed.status("exa")?.state, "error");
	assert.equal(keyed.status("exa")?.code, "not_registered");
	assert.equal(keyed.status("browser")?.state, "error");
	const down = new ServiceStand();
	down.listSources = async () => { throw new Error("connection refused"); };
	const offline = monitorWith({ SOURCE_SERVICE_GITHUB_TOKEN: "ghp_x" }, down);
	await offline.verify("github");
	assert.equal(offline.status("github")?.state, "error");
	assert.equal(offline.status("github")?.code, "service_unavailable");

	// A change is reported once, with what it changed from; re-recording the same state is silent.
	const changes: string[] = [];
	const watched = monitorWith({}, new ServiceStand(), { onChange: (event) => changes.push(`${event.sourceId}:${event.previous}>${event.state}`) });
	watched.record("github", "ok");
	watched.record("github", "ok");
	watched.record("github", "error");
	assert.deepEqual(changes, ["github:error>ok", "github:ok>error"]);
	watched.record("github", "error");

	// The outcome is what a fresh process reads back.
	const reloaded = monitorWith({}, new ServiceStand());
	assert.equal(reloaded.status("github")?.state, "error");
	assert.equal(reloaded.status("browser")?.state, "error");
	assert.ok(!readFileSync(join(agentDir, "source-status.json"), "utf8").includes("ghp_"));

	// A browser host that just started gets one late re-check; API-key sources are not re-probed.
	let youtubeCalls = 0;
	const settling = new ServiceStand();
	const late = monitorWith({ PI_YOUTUBE_YTDLP_COOKIE_FILE: join(root, "c.txt"), SOURCE_SERVICE_GITHUB_TOKEN: "ghp_x" }, settling, {
		probeYouTube: async () => { youtubeCalls += 1; if (youtubeCalls === 1) throw new Error("Failed to resolve url"); },
	});
	await late.verifyAll({ settleRetryMs: 10 });
	assert.equal(youtubeCalls, 2);
	assert.equal(late.status("youtube")?.state, "ok");
	assert.equal(settling.verified.filter((id) => id === "github").length, 1, "only browser-backed sources are re-checked");

	// The API lists every source with its status; activating a credential records the outcome the
	// Provider just gave without a second probe, and deleting it records the absence.
	const apiService = new ServiceStand();
	const monitor = monitorWith({ SOURCE_SERVICE_GITHUB_TOKEN: "ghp_x" }, apiService);
	const env: NodeJS.ProcessEnv = {};
	const app = express();
	app.use(express.json());
	let liveSessions: string[] = [];
	let synced = 0;
	mountSourcesApi(app, { monitor, env, liveBrowserSessions: () => liveSessions, resyncBrowserProfile: async () => { synced += 1; } });
	mountSearchCredentialsApi(app, { sourceService: apiService, env, statuses: monitor });
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = async (method: string, path: string, body?: unknown) => {
		const response = await fetch(`${baseUrl}${path}`, {
			method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() as Record<string, unknown> };
	};
	try {
		const listed = await call("GET", "/api/sources");
		assert.equal(listed.status, 200);
		const sources = listed.body.sources as Array<{ id: string; auth: string; credential: unknown; status: unknown }>;
		assert.deepEqual(sources.map((source) => source.id),
			SOURCE_DESCRIPTORS.filter((source) => source.provider.catalog.sourceClass !== "workspace").map((source) => source.id),
			"workspace sources such as user documents are not listed as external sources");
		assert.equal(sources.find((source) => source.id === "youtube")?.credential, null);
		assert.ok(sources.find((source) => source.id === "tavily")?.credential, "an API-key source carries its credential entry");
		assert.ok(!JSON.stringify(listed.body).includes("ghp_x"));

		const verified = await call("POST", "/api/sources/verify");
		assert.equal(verified.status, 200);
		assert.equal((verified.body.sources as Array<{ id: string; status: { state: string } }>).find((s) => s.id === "arxiv")?.status.state, "ok");
		assert.equal((await call("POST", "/api/sources/nope/verify")).status, 400);

		const probes = apiService.verified.length;
		const applied = await call("PUT", "/api/search-credentials/tavily", { values: { tavily_api_key: "tvly-live-0001" } });
		assert.equal(applied.status, 200, JSON.stringify(applied.body));
		assert.equal(apiService.verified.length, probes + 1, "activation asks the Provider exactly once");
		assert.equal(monitor.status("tavily")?.state, "ok");
		assert.equal((await call("DELETE", "/api/search-credentials/tavily")).status, 200);
		assert.equal(monitor.status("tavily")?.state, "unconfigured");
		assert.equal((await call("DELETE", "/api/search-credentials/twitter")).status, 200);
		assert.equal(monitor.status("twitter")?.state, "needs_login");
		assert.equal(listSources(monitor, env).verifying, false);

		// Switching a source off takes it out of the Provider Catalog and out of verification;
		// switching it on checks it again. A logged-out or failing source is excluded as well.
		assert.ok(!monitor.excludedSourceIds().includes("arxiv"));
		const off = await call("PUT", "/api/sources/arxiv/enabled", { enabled: false });
		assert.equal(off.status, 200);
		assert.equal((off.body.sources as Array<{ id: string; enabled: boolean }>).find((s) => s.id === "arxiv")?.enabled, false);
		assert.ok(monitor.excludedSourceIds().includes("arxiv"));
		assert.ok(monitor.excludedSourceIds().includes("twitter"), "a source needing a login is excluded");
		assert.equal((await call("PUT", "/api/sources/arxiv/enabled", { enabled: "yes" })).status, 400);
		assert.equal((await call("PUT", "/api/sources/arxiv/enabled", { enabled: true })).status, 200);
		assert.ok(!monitor.excludedSourceIds().includes("arxiv"));
		assert.ok(monitor.excludedSourceIds().includes("twitter"), "switching a source on does not make a missing login usable");

		// A fresh pass is not repeated; a stale one is.
		const passes = apiService.verified.length;
		await monitor.verifyIfStale(60_000);
		assert.equal(apiService.verified.length, passes, "everything was just checked");
		await monitor.verifyIfStale(0);
		assert.ok(apiService.verified.length > passes, "an aged status is checked again");

		// The browser profile is not replaced under a running session.
		liveSessions = ["s1"];
		assert.equal((await call("POST", "/api/sources/browser/sync")).status, 409);
		liveSessions = [];
		assert.equal((await call("POST", "/api/sources/browser/sync")).status, 200);
		assert.equal(synced, 1);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	console.log("source status: ok");
} finally {
	rmSync(root, { recursive: true, force: true });
}
