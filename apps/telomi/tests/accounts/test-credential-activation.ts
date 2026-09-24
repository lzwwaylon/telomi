/**
 * Connections follow the same save-for-later and apply rules as capability defaults.
 *
 * The Provider itself decides whether a candidate credential works, so the upstream here is a
 * controlled endpoint rather than a real Provider. What the assertions establish: preparing a
 * credential changes nothing, a candidate is never published while it is being checked, a
 * rejected candidate leaves the working credential in place, a rotation reaches the next request
 * of a long-lived Runtime, and an edit that lands during validation is not overwritten.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "telomi-credential-activation-"));
const agentDir = join(root, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
const modelsPath = join(agentDir, "models.json");
const authPath = join(agentDir, "auth.json");
const pendingAuthPath = join(agentDir, "auth-pending.json");
process.env.PI_CODING_AGENT_DIR = agentDir;

const storedKey = (provider: string): string | undefined => {
	if (!existsSync(authPath)) return undefined;
	const entry = (JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { key?: string }>)[provider];
	return entry?.key;
};

const accepted = new Set<string>();
/** Runs while the Provider is answering, which is exactly when activation is still undecided. */
let duringValidation: (() => Promise<void>) | null = null;
const keysSeenUpstream: string[] = [];
const storedDuringValidation: Array<string | undefined> = [];

const upstream = createServer((request, response) => {
	const key = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
	keysSeenUpstream.push(key);
	storedDuringValidation.push(storedKey("anthropic"));
	request.resume();
	request.on("end", () => {
		void (async () => {
			const hook = duringValidation;
			duringValidation = null;
			if (hook) await hook();
			if (!accepted.has(key)) {
				// Providers routinely quote the rejected key back in the failure they return.
				response.writeHead(401, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: `invalid api key: ${key}` } }));
				return;
			}
			const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
				id: "probe", object: "chat.completion.chunk", created: 1, model: "probe-1",
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(chunk({ role: "assistant", content: "OK" }, null));
			response.write(chunk({}, "stop"));
			response.write("data: [DONE]\n\n");
			response.end();
		})();
	});
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
const upstreamPort = (upstream.address() as AddressInfo).port;
writeFileSync(modelsPath, JSON.stringify({
	providers: {
		anthropic: {
			baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
			api: "openai-completions",
			models: [{ id: "probe-1", name: "Probe" }],
		},
		"kimi-coding": {
			baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
			api: "openai-completions",
			models: [{ id: "probe-1", name: "Probe" }],
		},
	},
}, null, 2));

const { mountAuthApi } = await import("../../server/accounts/auth-api.js");

const app = express();
app.use(express.json());
mountAuthApi(app);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as AddressInfo).port;

interface AuthResponse {
	error?: string;
	authEntry?: { configured: boolean; keyHint: string | null };
	pendingEntry?: { configured: boolean; keyHint: string | null };
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: AuthResponse }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: response.status, json: await response.json() as AuthResponse };
}

const applyKey = (key?: string) =>
	call("PUT", "/api/auth/anthropic", { modelId: "probe-1", ...(key === undefined ? {} : { key }) });

try {
	// Save for later prepares a credential without configuring the Provider.
	const pending = await call("PUT", "/api/auth/anthropic", { key: "prepared-key", mode: "pending" });
	assert.equal(pending.status, 200);
	assert.equal(pending.json.pendingEntry?.configured, true);
	assert.equal(pending.json.authEntry?.configured, false);
	assert.equal(storedKey("anthropic"), undefined, "a prepared credential is not in use");

	// The Provider rejects the prepared key, so nothing is activated and nothing was published.
	const rejected = await applyKey();
	assert.equal(rejected.status, 422);
	assert.match(rejected.json.error ?? "", /invalid api key/u);
	// The Provider echoed the key; the failure the user sees must not carry it.
	assert.ok(!(rejected.json.error ?? "").includes("prepared-key"), "a failure must not expose the candidate");
	assert.equal(storedKey("anthropic"), undefined);
	assert.deepEqual(keysSeenUpstream, ["prepared-key"], "the candidate is checked against the Provider");
	assert.deepEqual(storedDuringValidation, [undefined], "a candidate is never active while it is checked");
	assert.equal(rejected.json.pendingEntry?.configured, true, "the prepared credential is kept for a retry");
	const shortRejected = await applyKey("abc");
	assert.equal(shortRejected.status, 422);
	assert.ok(!shortRejected.json.error?.includes("abc"), "short credentials are still secrets");

	// An accepted candidate becomes the active credential.
	accepted.add("prepared-key");
	const applied = await applyKey();
	assert.equal(applied.status, 200);
	assert.equal(applied.json.authEntry?.configured, true);
	assert.equal(applied.json.pendingEntry?.configured, false);
	assert.equal(storedKey("anthropic"), "prepared-key");

	// A rejected replacement leaves the credential that works untouched.
	const failedReplacement = await applyKey("typo-key");
	assert.equal(failedReplacement.status, 422);
	assert.equal(storedKey("anthropic"), "prepared-key", "a rejected replacement preserves the active credential");
	assert.ok(
		!storedDuringValidation.includes("typo-key"),
		"the rejected candidate was never stored, not even briefly",
	);

	// A long-lived Runtime picks up a rotation on its next request; no restart is required.
	const runtime = await ModelRuntime.create({ authPath, modelsPath });
	assert.equal((await runtime.getAuth("anthropic"))?.auth.apiKey, "prepared-key");
	accepted.add("rotated-key");
	assert.equal((await applyKey("rotated-key")).status, 200);
	assert.equal((await runtime.getAuth("anthropic"))?.auth.apiKey, "rotated-key");

	// A draft saved while a slower activation is validating is a newer decision and survives it.
	accepted.add("second-key");
	duringValidation = async () => {
		await call("PUT", "/api/auth/anthropic", { key: "newer-draft", mode: "pending" });
	};
	const withNewerDraft = await applyKey("second-key");
	assert.equal(withNewerDraft.status, 200);
	assert.equal(storedKey("anthropic"), "second-key");
	assert.equal(withNewerDraft.json.pendingEntry?.configured, true, "a newer Save for Later is kept");

	// A deletion that lands while a slower activation is validating wins; the credential the user
	// deleted must not come back through the in-flight request.
	accepted.add("late-key");
	duringValidation = async () => {
		await call("DELETE", "/api/auth/anthropic");
	};
	const conflicted = await applyKey("late-key");
	assert.equal(conflicted.status, 409);
	assert.equal(storedKey("anthropic"), undefined, "the newer deletion is preserved");
	assert.equal(conflicted.json.authEntry?.configured, false);

	// An OAuth login prepares its authorization in the pending store. Activating it goes through
	// the same validated, compare-and-swap path as a key, so a completed login does not by itself
	// replace the credential in use.
	const accessToken = "oauth-access-token";
	writeFileSync(pendingAuthPath, JSON.stringify({
		anthropic: { type: "oauth", access: accessToken, refresh: "oauth-refresh", expires: Date.now() + 86_400_000 },
	}));
	const staged = await call("GET", "/api/auth");
	const anthropic = (staged.json as unknown as { providers: Array<{ id: string; authEntry: { configured: boolean }; pendingEntry: { configured: boolean; type: string | null } }> })
		.providers.find((entry) => entry.id === "anthropic");
	assert.equal(anthropic?.pendingEntry.configured, true);
	assert.equal(anthropic?.pendingEntry.type, "oauth");
	assert.equal(anthropic?.authEntry.configured, false, "a completed login does not replace the active credential");
	assert.equal(storedKey("anthropic"), undefined);

	// The Provider rejects the prepared authorization, so nothing is activated.
	const rejectedOauth = await applyKey();
	assert.equal(rejectedOauth.status, 422);
	assert.equal(storedKey("anthropic"), undefined);

	// Accepting it activates the OAuth credential itself, not a key.
	accepted.add(accessToken);
	const activatedOauth = await applyKey();
	assert.equal(activatedOauth.status, 200);
	assert.equal(activatedOauth.json.authEntry?.configured, true);
	assert.equal(
		(JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { type?: string; access?: string }>).anthropic?.type,
		"oauth",
	);
	assert.deepEqual(JSON.parse(readFileSync(pendingAuthPath, "utf8")), {}, "the consumed authorization is cleared");
	await call("DELETE", "/api/auth/anthropic");

	// A second OAuth login can finish while the first prepared token is being validated.
	// Applying the first token must not activate or discard that newer, unvalidated draft.
	const firstOauth = {
		type: "oauth", access: "first-oauth-candidate", refresh: "first-oauth-refresh",
		expires: Date.now() + 86_400_000,
	};
	const laterOauth = {
		type: "oauth", access: "later-oauth-draft", refresh: "later-oauth-refresh",
		expires: Date.now() + 86_400_000,
	};
	writeFileSync(pendingAuthPath, JSON.stringify({ anthropic: firstOauth }));
	accepted.add(firstOauth.access);
	accepted.add(laterOauth.access);
	duringValidation = async () => {
		writeFileSync(pendingAuthPath, JSON.stringify({ anthropic: laterOauth }));
	};
	const oauthWithNewerDraft = await applyKey();
	assert.equal(oauthWithNewerDraft.status, 200);
	assert.equal(
		(await runtime.getAuth("anthropic"))?.auth.apiKey,
		firstOauth.access,
		"the consumer uses the OAuth credential that was validated, not a newer pending login",
	);
	assert.equal(oauthWithNewerDraft.json.pendingEntry?.configured, true, "the newer OAuth login stays pending");
	assert.equal((await applyKey()).status, 200);
	assert.equal((await runtime.getAuth("anthropic"))?.auth.apiKey, laterOauth.access);
	await call("DELETE", "/api/auth/anthropic");

	// Native Kimi OAuth resolves only an Authorization header, with no apiKey field.
	// A rejection that echoes just its token must still be scrubbed.
	const headerToken = "headers-only-oauth-secret";
	writeFileSync(pendingAuthPath, JSON.stringify({
		"kimi-coding": { type: "oauth", access: headerToken, refresh: "header-refresh", expires: Date.now() + 86_400_000 },
	}));
	const headerRejected = await call("PUT", "/api/auth/kimi-coding", { modelId: "probe-1" });
	assert.equal(headerRejected.status, 422);
	assert.equal(keysSeenUpstream.at(-1), headerToken);
	assert.ok(!JSON.stringify(headerRejected.json).includes(headerToken), "bare OAuth tokens must be redacted");
	assert.ok(!headerRejected.json.error?.includes(headerToken.slice(0, 8)), "the token prefix must not survive header redaction");

	const settings = readFileSync(join(agentDir, "settings.json"), "utf8");
	assert.ok(settings.includes("anthropic"), "the deletion is recorded so the environment cannot revive it");
	for (const secret of [
		"prepared-key", "rotated-key", "typo-key", "late-key", "second-key", "newer-draft", accessToken,
	]) {
		assert.ok(!settings.includes(secret), "settings must not contain credential values");
	}

	console.log("Credential save for later, isolated validation and activation passed");
} finally {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
	rmSync(root, { recursive: true, force: true });
}
