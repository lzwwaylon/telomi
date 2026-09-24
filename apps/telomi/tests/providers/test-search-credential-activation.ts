/**
 * Search Provider credentials: save for later, isolated validation, rotation and deletion.
 *
 * The Provider itself decides whether a candidate works, and it is the Python Source Service that
 * asks it, so the seam here is that service: a controlled stand-in that records what it was asked
 * to check and can refuse. What the assertions establish: preparing a key changes nothing, a
 * candidate is never published while it is unproven, a rejected candidate leaves the working
 * credential untouched, an activated key is what the next search states on its request, an edit or
 * deletion that lands during validation keeps its own outcome, a deletion survives a restart that
 * reloads the environment, and no response or settings file carries a secret.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

const root = mkdtempSync(join(tmpdir(), "telomi-search-credentials-"));
const agentDir = join(root, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const { mountSearchCredentialsApi } = await import("../../server/providers/search-credentials-api.js");
const {
	activeSearchCredentialEnvironment,
	applySearchCredentialEnvironment,
	importLegacySearchCredentials,
	searchCredentialEnvironmentFor,
} = await import("../../server/providers/search-credentials.js");
const { searchCredentialOverride } = await import("../../server/providers/search-credential-catalog.js");
const { applyCredentialTombstones } = await import("../../server/config/credential-tombstones.js");

const TAVILY_ENV = "SOURCE_SERVICE_TAVILY_API_KEY";
const storedValue = (fieldId: string): string | undefined => {
	const path = join(agentDir, "search-auth.json");
	if (!existsSync(path)) return undefined;
	return (JSON.parse(readFileSync(path, "utf8")) as Record<string, { key?: string }>)[fieldId]?.key;
};
const stagedValue = (fieldId: string): string | undefined => {
	const path = join(agentDir, "search-auth-pending.json");
	if (!existsSync(path)) return undefined;
	return (JSON.parse(readFileSync(path, "utf8")) as Record<string, { key?: string }>)[fieldId]?.key;
};

/** Stands in for the Source Service asking the Provider about a candidate credential. */
class ServiceStand {
	readonly accepted = new Set<string>();
	readonly seen: Array<{ sourceId: string; credential: Record<string, string | null> }> = [];
	/** Runs while the Provider is answering, which is exactly when activation is still undecided. */
	whileDeciding: (() => Promise<void>) | null = null;
	unreachable: string | null = null;

	async verifyCredential(sourceId: string, credential: Record<string, string | null>): Promise<void> {
		this.seen.push({ sourceId, credential: { ...credential } });
		const hook = this.whileDeciding;
		this.whileDeciding = null;
		if (hook) await hook();
		if (this.unreachable) throw new Error(this.unreachable);
		for (const value of Object.values(credential)) {
			if (value && !this.accepted.has(value)) {
				// Providers routinely quote the rejected key back in the failure they return.
				throw new Error(`general_web_tavily cannot serve this request with current credentials: invalid api key: ${value}`);
			}
		}
	}
}

/** What the next search for this source will state on its request, from the same authority. */
const nextRequestCredential = (ambient: NodeJS.ProcessEnv = {}) =>
	searchCredentialOverride("general_web_tavily", searchCredentialEnvironmentFor(ambient));

const service = new ServiceStand();
const env: NodeJS.ProcessEnv = {};
const app = express();
app.use(express.json());
mountSearchCredentialsApi(app, { sourceService: service, env });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as AddressInfo).port;

interface FieldStatus {
	id: string;
	configured: boolean;
	keyHint: string | null;
	provenance: "user" | "imported" | null;
	pendingConfigured: boolean;
	deleted: boolean;
	legacyEnvSet: string[];
}
interface SearchCredentialsResponse {
	error?: string;
	providers?: Array<{ id: string; status: string; pendingReason: string | null; fields: FieldStatus[] }>;
	consumers?: Array<{ id: string; status: string; pendingProviders: string[] }>;
}

async function call(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; text: string; json: SearchCredentialsResponse }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	return { status: response.status, text, json: JSON.parse(text) as SearchCredentialsResponse };
}

const tavily = (response: SearchCredentialsResponse) =>
	response.providers?.find((provider) => provider.id === "tavily");
const tavilyField = (response: SearchCredentialsResponse) =>
	tavily(response)?.fields.find((field) => field.id === "tavily_api_key");

const secrets = [
	"tvly-prepared-key-0001",
	"tvly-typo-key-0002",
	"tvly-rotated-key-0003",
	"tvly-late-key-0004",
	"tvly-legacy-env-0005",
	"tvly-newer-bearer-0006",
	"tvly-competing-bearer-0007",
];
const [PREPARED, TYPO, ROTATED, LATE, LEGACY, NEWER_BEARER, COMPETING_BEARER] =
	secrets as [string, string, string, string, string, string, string];

try {
	// Nothing is configured yet, and nothing was asked of the service.
	const initial = await call("GET", "/api/search-credentials");
	assert.equal(tavily(initial.json)?.status, "unconfigured");
	assert.equal(service.seen.length, 0);
	assert.deepEqual(
		initial.json.providers?.map((provider) => provider.id),
		["twitter", "github", "huggingface", "firecrawl", "tavily", "exa"],
		"the entry point covers the already integrated search Providers and adds no arbitrary API",
	);

	// Save for later prepares a credential without configuring anything.
	const pending = await call("PUT", "/api/search-credentials/tavily", {
		mode: "pending",
		values: { tavily_api_key: PREPARED },
	});
	assert.equal(pending.status, 200);
	assert.equal(tavilyField(pending.json)?.pendingConfigured, true);
	assert.equal(tavilyField(pending.json)?.configured, false);
	assert.equal(storedValue("tavily_api_key"), undefined, "a prepared credential is not in use");
	assert.equal(service.seen.length, 0, "saving for later never touches the running service");

	// The Provider rejects the prepared key, so nothing is activated anywhere.
	const rejected = await call("PUT", "/api/search-credentials/tavily", { values: {} });
	assert.equal(rejected.status, 422);
	assert.match(rejected.json.error ?? "", /invalid api key/u);
	assert.ok(!rejected.text.includes(PREPARED), "a failure must not expose the candidate");
	assert.equal(storedValue("tavily_api_key"), undefined);
	assert.equal(nextRequestCredential()?.[TAVILY_ENV], null, "no search states a credential that was refused");
	assert.equal(tavilyField(rejected.json)?.pendingConfigured, true, "the prepared credential is kept for a retry");
	assert.deepEqual(service.seen, [{
		sourceId: "general_web_tavily",
		credential: { [TAVILY_ENV]: PREPARED },
	}], "the candidate is checked against the Provider, and only the candidate");

	// An accepted candidate becomes the credential every later search states.
	service.accepted.add(PREPARED);
	const applied = await call("PUT", "/api/search-credentials/tavily", { values: {} });
	assert.equal(applied.status, 200);
	assert.equal(tavilyField(applied.json)?.configured, true);
	assert.equal(tavilyField(applied.json)?.pendingConfigured, false, "the staged value this activation used is gone");
	assert.equal(tavilyField(applied.json)?.provenance, "user");
	assert.equal(storedValue("tavily_api_key"), PREPARED);
	assert.equal(tavily(applied.json)?.status, "active");

	// The value a search states on its request is the value this store holds, so the credential a
	// request is answered with and the one its cache scope names cannot describe different keys.
	assert.deepEqual(nextRequestCredential(), { [TAVILY_ENV]: PREPARED });
	assert.equal(activeSearchCredentialEnvironment()[TAVILY_ENV], PREPARED);
	assert.equal(env[TAVILY_ENV], PREPARED, "a Source Service restarted later starts on the active credential");

	// A stale environment value does not decide anything once the user has configured one here.
	assert.deepEqual(
		nextRequestCredential({ TAVILY_API_KEY: LEGACY, [TAVILY_ENV]: LEGACY }),
		{ [TAVILY_ENV]: PREPARED },
	);

	// A rejected replacement leaves the credential that works untouched, in the store and in the service.
	const failedReplacement = await call("PUT", "/api/search-credentials/tavily", { values: { tavily_api_key: TYPO } });
	assert.equal(failedReplacement.status, 422);
	for (const secret of [TYPO, PREPARED]) {
		assert.ok(
			!failedReplacement.text.includes(secret),
			"neither the rejected candidate nor the credential it would have replaced may appear",
		);
	}
	assert.equal(storedValue("tavily_api_key"), PREPARED);
	assert.deepEqual(nextRequestCredential(), { [TAVILY_ENV]: PREPARED });

	// A Source Service that cannot be reached fails the activation rather than publishing an
	// unchecked key, and what was working keeps working.
	service.unreachable = "the source service is not reachable";
	const unreachable = await call("PUT", "/api/search-credentials/tavily", { values: { tavily_api_key: TYPO } });
	assert.equal(unreachable.status, 422);
	assert.match(unreachable.json.error ?? "", /not reachable/u);
	assert.equal(storedValue("tavily_api_key"), PREPARED);
	assert.deepEqual(nextRequestCredential(), { [TAVILY_ENV]: PREPARED });
	service.unreachable = null;

	// A rotation reaches the next request without a restart.
	service.accepted.add(ROTATED);
	const rotated = await call("PUT", "/api/search-credentials/tavily", { values: { tavily_api_key: ROTATED } });
	assert.equal(rotated.status, 200);
	assert.equal(storedValue("tavily_api_key"), ROTATED);
	assert.deepEqual(nextRequestCredential(), { [TAVILY_ENV]: ROTATED });
	assert.equal(env[TAVILY_ENV], ROTATED);

	// A deletion that lands while a slower activation is being validated wins. The candidate was
	// never installed anywhere, so the deleted key cannot keep serving a request.
	service.accepted.add(LATE);
	service.whileDeciding = async () => {
		await call("DELETE", "/api/search-credentials/tavily");
	};
	const conflicted = await call("PUT", "/api/search-credentials/tavily", { values: { tavily_api_key: LATE } });
	assert.equal(conflicted.status, 409);
	assert.equal(storedValue("tavily_api_key"), undefined, "the newer deletion is preserved");
	assert.equal(nextRequestCredential()?.[TAVILY_ENV], null, "a search after the deletion states no credential");
	assert.equal(tavilyField(conflicted.json)?.configured, false);
	assert.equal(tavilyField(conflicted.json)?.deleted, true);
	assert.equal(env[TAVILY_ENV], undefined, "deleting drops the ambient value too");
	// A stale environment value cannot answer for a deleted credential either, whatever environment
	// a Run happens to carry.
	assert.equal(nextRequestCredential({ TAVILY_API_KEY: LEGACY })?.[TAVILY_ENV], null);

	// An edit that lands during validation is a newer decision than the one being validated. The
	// Provider was checked as one set, so it activates as one set: the field that did publish goes
	// back rather than leaving a cookie and bearer pair running that was never checked together.
	service.accepted.add(PREPARED);
	service.accepted.add(LATE);
	// Start from a deleted Provider, so activation has to lift its own deletion to take effect
	// rather than being left recorded but suppressed.
	assert.equal((await call("DELETE", "/api/search-credentials/twitter")).status, 200);
	assert.equal(
		(await call("PUT", "/api/search-credentials/twitter", {
			values: { twitter_cookie: PREPARED, twitter_bearer_token: LATE },
		})).status,
		200,
	);
	assert.equal(storedValue("twitter_cookie"), PREPARED);
	assert.deepEqual(
		searchCredentialOverride("twitter", searchCredentialEnvironmentFor({})),
		{
			SOURCE_SERVICE_TWITTER_COOKIE: PREPARED,
			SOURCE_SERVICE_TWITTER_COOKIE_FILE: null,
			SOURCE_SERVICE_TWITTER_BEARER_TOKEN: LATE,
		},
		"activation lifts the deletion, so the Provider is actually usable again",
	);

	service.accepted.add(ROTATED);
	service.accepted.add(NEWER_BEARER);
	service.accepted.add(COMPETING_BEARER);
	service.whileDeciding = async () => {
		// Only the bearer is edited, so the cookie the slower request is validating is untouched.
		await call("PUT", "/api/search-credentials/twitter", { values: { twitter_bearer_token: COMPETING_BEARER } });
	};
	const partial = await call("PUT", "/api/search-credentials/twitter", {
		values: { twitter_cookie: ROTATED, twitter_bearer_token: NEWER_BEARER },
	});
	assert.equal(partial.status, 409);
	assert.match(partial.json.error ?? "", /twitter_bearer_token/u);
	assert.equal(storedValue("twitter_bearer_token"), COMPETING_BEARER, "the newer field edit is preserved");
	assert.equal(
		storedValue("twitter_cookie"),
		PREPARED,
		"the field that published is put back, so no unchecked combination is left running",
	);
	assert.deepEqual(
		searchCredentialOverride("twitter", searchCredentialEnvironmentFor({})),
		{
			SOURCE_SERVICE_TWITTER_COOKIE: PREPARED,
			SOURCE_SERVICE_TWITTER_COOKIE_FILE: null,
			SOURCE_SERVICE_TWITTER_BEARER_TOKEN: COMPETING_BEARER,
		},
	);

	// A cookie file is where the credential is read from, not a value the entry point keeps. The
	// deletion still has to suppress it, or the Provider keeps authenticating from the file.
	assert.equal((await call("DELETE", "/api/search-credentials/twitter")).status, 200);
	const withCookieFile = { X_COOKIE_FILE: "/tmp/telomi-cookies.txt" };
	assert.equal(
		searchCredentialOverride("twitter", searchCredentialEnvironmentFor(withCookieFile))
			?.SOURCE_SERVICE_TWITTER_COOKIE_FILE,
		null,
		"a deleted Twitter credential cannot keep answering from its cookie file",
	);
	assert.deepEqual(applyCredentialTombstones({ ...withCookieFile }), ["X_COOKIE_FILE"]);

	// A restart reloads `.env*`; a deleted credential must not come back under any of its names.
	const afterRestart: NodeJS.ProcessEnv = {
		TAVILY_API_KEY: LEGACY,
		[TAVILY_ENV]: LEGACY,
		EXA_API_KEY: LEGACY,
	};
	assert.deepEqual(importLegacySearchCredentials(afterRestart), ["exa_api_key"], "a deleted credential is never re-imported");
	assert.deepEqual(applySearchCredentialEnvironment(afterRestart), ["SOURCE_SERVICE_EXA_API_KEY"]);
	assert.deepEqual(applyCredentialTombstones(afterRestart).sort(), ["SOURCE_SERVICE_TAVILY_API_KEY", "TAVILY_API_KEY"]);
	assert.equal(afterRestart.TAVILY_API_KEY, undefined);
	assert.equal(afterRestart[TAVILY_ENV], undefined);
	assert.equal(activeSearchCredentialEnvironment()[TAVILY_ENV], undefined);

	// The imported credential is managed from now on and says where it came from.
	const imported = await call("GET", "/api/search-credentials");
	const exa = imported.json.providers?.find((provider) => provider.id === "exa");
	assert.equal(exa?.status, "active");
	assert.equal(exa?.fields[0]?.provenance, "imported");
	assert.equal(exa?.fields[0]?.keyHint, `${LEGACY.slice(0, 4)}…${LEGACY.slice(-4)}`);
	// Importing again is a no-op: the managed value is the authority, not the environment.
	assert.deepEqual(importLegacySearchCredentials({ EXA_API_KEY: "tvly-different-0006" }), []);
	assert.equal(activeSearchCredentialEnvironment().SOURCE_SERVICE_EXA_API_KEY, LEGACY);

	// Managed credentials take effect on a remote service; only untouched Providers stay unmanaged.
	env.TELOMI_RESEARCH_SOURCE_BASE_URL = "http://source.internal:9000";
	const remote = await call("GET", "/api/search-credentials");
	const remoteExa = remote.json.providers?.find((provider) => provider.id === "exa");
	assert.equal(remoteExa?.status, "active");
	assert.equal(remoteExa?.pendingReason, null);
	assert.deepEqual(remote.json.consumers,
		[{ id: "sourceService", status: "pending", pendingProviders: ["github", "huggingface", "firecrawl"] }]);
	delete env.TELOMI_RESEARCH_SOURCE_BASE_URL;

	// Neither the entry point's answers nor the settings record ever carry a secret.
	const settings = readFileSync(join(agentDir, "settings.json"), "utf8");
	assert.ok(settings.includes("tavily_api_key"), "the deletion is recorded so the environment cannot revive it");
	assert.deepEqual(
		imported.json.consumers,
		[{ id: "sourceService", status: "active", pendingProviders: [] }],
		"every search resolves its credential from this store, so nothing is left to adopt it",
	);
	for (const secret of secrets) {
		assert.ok(!settings.includes(secret), "settings must not contain credential values");
		assert.ok(!imported.text.includes(secret), "the configuration status must not contain credential values");
	}
	assert.equal(stagedValue("tavily_api_key"), undefined);

	console.log("Search credential save for later, isolated validation, rotation and deletion passed");
} finally {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(root, { recursive: true, force: true });
}
