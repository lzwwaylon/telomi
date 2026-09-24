/**
 * Every Provider keeps a multi-account fallback chain, not only openai-codex.
 *
 * Applying a credential in Connections adds it to the Provider's chain as the active entry, a
 * second apply adds a sibling instead of overwriting, the accounts API manages that chain per
 * Provider, runtime failover rotates to the sibling, and the Provider-level delete clears it all.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

const root = mkdtempSync(join(tmpdir(), "telomi-provider-account-chain-"));
const agentDir = join(root, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
const authPath = join(agentDir, "auth.json");
const chainPath = join(agentDir, "accounts", "deepseek.json");
const storedKey = (): string | undefined =>
	existsSync(authPath) ? (JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { key?: string }>).deepseek?.key : undefined;

const upstream = createServer((request, response) => {
	request.resume();
	request.on("end", () => {
		const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
			id: "probe", object: "chat.completion.chunk", created: 1, model: "probe-1",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(chunk({ role: "assistant", content: "OK" }, null));
		response.write(chunk({}, "stop"));
		response.write("data: [DONE]\n\n");
		response.end();
	});
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
	providers: {
		deepseek: {
			baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
			api: "openai-completions",
			models: [{ id: "probe-1", name: "Probe" }],
		},
	},
}));

const { mountAuthApi } = await import("../../server/accounts/auth-api.js");
const { mountAccountsApi } = await import("../../server/accounts/accounts-api.js");
const { accountManagerFor, hasAccountChain, loadAllAccountManagers } = await import("../../server/accounts/manager.js");

const app = express();
app.use(express.json());
mountAuthApi(app);
const changes: string[] = [];
mountAccountsApi(app, (provider) => changes.push(provider));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as AddressInfo).port;

interface ChainState { accounts: Array<{ id: string; isActive: boolean; maskedToken?: string }>; activeId: string | null; usage?: unknown }
async function call<T = ChainState>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: response.status, json: await response.json() as T };
}
const apply = (key: string) => call("PUT", "/api/auth/deepseek", { key, modelId: "probe-1" });

try {
	assert.equal(hasAccountChain("deepseek"), false, "no chain before the first credential");

	// A credential that predates the chain becomes the group's first account when a sibling
	// is applied; the applied one is the account in use.
	writeFileSync(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "legacy-key-0000" } }));
	assert.equal((await apply("first-key-0001")).status, 200);
	assert.equal(storedKey(), "first-key-0001");
	assert.equal(hasAccountChain("deepseek"), true);
	let state = (await call("GET", "/api/accounts/deepseek")).json;
	assert.deepEqual(state.accounts.map((a) => [a.maskedToken, a.isActive]), [["lega…0000", false], ["firs…0001", true]]);
	assert.equal(state.usage, undefined, "subscription usage is a Codex-only extension");
	assert.equal((await call("DELETE", `/api/accounts/deepseek/${state.accounts[0]!.id}`)).json.accounts.length, 1);

	// A second apply adds a sibling and makes it the credential in use; the first one stays.
	assert.equal((await apply("second-key-0002")).status, 200);
	assert.equal(storedKey(), "second-key-0002");
	state = (await call("GET", "/api/accounts/deepseek")).json;
	assert.equal(state.accounts.length, 2, "applying again adds an account instead of overwriting");
	const [first, second] = state.accounts;
	assert.equal(second?.isActive, true);
	assert.equal(first?.isActive, false);
	// Re-applying an existing key neither duplicates nor disturbs the chain.
	assert.equal((await apply("second-key-0002")).status, 200);
	assert.equal((await call("GET", "/api/accounts/deepseek")).json.accounts.length, 2);

	// Chain management is per Provider: activate, reorder, and the usage endpoint stays Codex-only.
	assert.equal((await call("POST", `/api/accounts/deepseek/${first!.id}/activate`)).json.activeId, first!.id);
	assert.equal(storedKey(), "first-key-0001", "activating mirrors the account into auth.json");
	assert.equal((await call("POST", "/api/accounts/deepseek/usage/refresh")).status, 400);
	assert.equal((await call("GET", "/api/accounts/not-a-provider")).status, 400);
	assert.ok(changes.includes("deepseek"), "chain changes are published with their provider");

	// Runtime failover: a quota failure on the active account rotates to the sibling.
	const manager = accountManagerFor("deepseek");
	await manager.recordFailure(first!.id, "quota", "429 rate limit");
	assert.equal(manager.snapshot().activeId, second!.id, "the sibling takes over after a quota failure");
	assert.equal(storedKey(), "second-key-0002");
	assert.equal(manager.pickFallbackCandidate(new Set())?.account.id, second!.id, "the next request starts on the healthy account");

	// A failure the Provider does not attribute to the credential leaves the chain untouched:
	// not the healthy active account, and not the quota verdict already standing on its sibling.
	const requestLevelError = "Codex error: The 'probe-mini' model is not supported when using Codex with a ChatGPT account.";
	const beforeRequestErrors = manager.snapshot();
	for (const errorClass of ["permanent", "transient"] as const) {
		for (const target of [first!, second!]) {
			await manager.recordFailure(target.id, errorClass, requestLevelError);
		}
		assert.deepEqual(
			manager.snapshot(),
			beforeRequestErrors,
			`a ${errorClass} failure must change no account status, diagnostic or active selection`,
		);
		assert.equal(storedKey(), "second-key-0002", `a ${errorClass} failure must not rewrite the mirrored credential`);
	}

	// Auth attribution still condemns the credential and takes it out of the rotation.
	await manager.recordFailure(second!.id, "auth", "401 unauthorized");
	assert.equal(
		manager.snapshot().accounts.find((entry) => entry.id === second!.id)?.status,
		"auth-error",
		"an auth failure still marks the credential unusable",
	);
	assert.equal(manager.pickFallbackCandidate(new Set())?.account.id, first!.id, "a condemned credential leaves the rotation");

	// A fresh process finds the chain on disk and routes through it.
	const persisted = JSON.parse(readFileSync(chainPath, "utf8")) as { accounts: unknown[] };
	assert.equal(persisted.accounts.length, 2);
	assert.ok((await loadAllAccountManagers()).some((m) => m.provider === "deepseek"));

	// The Provider-level delete removes the credential in use and the whole chain with it.
	await call("DELETE", "/api/auth/deepseek");
	assert.equal(storedKey(), undefined);
	assert.equal(hasAccountChain("deepseek"), false, "nothing in the chain brings a deleted Provider back");
	assert.equal((await call("GET", "/api/accounts/deepseek")).json.accounts.length, 0);

	console.log("provider account chain test passed");
} finally {
	server.close();
	upstream.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
