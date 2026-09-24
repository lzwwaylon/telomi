/** Catalog models Prime's own list lacks reach Prime through the native SDK, delegation included. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as prime from "prime-agent";

const root = mkdtempSync(join(tmpdir(), "telomi-prime-catalog-"));
const canonical = join(root, "canonical");
mkdirSync(canonical);
process.env.PI_CODING_AGENT_DIR = canonical;
const { PRIME_CATALOG_MODELS_KEY, PRIME_CREDENTIAL_SOURCE_ENV, createPrimeModelRegistry, primeModelDefinitions, stagePrimeAgentDirectory } =
	await import("../../server/agent-runtime/prime-agent-paths.js");
const { freezeModelDefinitions } = await import("../../server/agent-runtime/model-policy.js");
test.after(() => rmSync(root, { recursive: true, force: true }));

const codexModel = (id: string) => ({
	id, name: id, api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api", reasoning: true,
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000,
});

test("catalog models Prime's list lacks reach Prime, stay delegable, and leave the user's connections as they are", async () => {
	// pi's cached catalog: one model Prime already ships, one it does not know yet, a Provider Prime
	// cannot speak, and a Provider the user defined as a connection of their own.
	writeFileSync(join(canonical, "models-store.json"), JSON.stringify({
		"openai-codex": { models: [codexModel("gpt-5.6-terra"), codexModel("gpt-9-catalog")] },
		"not-a-prime-provider": { models: [{ ...codexModel("elsewhere-1"), provider: "not-a-prime-provider" }] },
		deepseek: { models: [{ ...codexModel("deepseek-v9"), api: "openai-completions", provider: "deepseek" }] },
	}));
	writeFileSync(join(canonical, "models.json"), JSON.stringify({ providers: {
		deepseek: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "user-key", models: [{ id: "deepseek-user", name: "Mine", reasoning: false }] },
	} }));
	writeFileSync(join(canonical, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: "codex-key" } }));

	const definitions = primeModelDefinitions() as { providers: Record<string, { models?: Array<{ id: string }>; apiKey?: string }>; [key: string]: unknown };
	assert.deepEqual(definitions.providers["openai-codex"]?.models?.map((model) => model.id), ["gpt-9-catalog"], "only what Prime lacks is added");
	assert.deepEqual(definitions[PRIME_CATALOG_MODELS_KEY], ["openai-codex/gpt-9-catalog"]);
	assert.equal(definitions.providers["not-a-prime-provider"], undefined, "a Provider Prime cannot speak is not added");
	assert.deepEqual(definitions.providers.deepseek?.models?.map((model) => model.id), ["deepseek-user"], "a user's own connection keeps its models");

	// Frozen with a Run, the catalog models travel with it even if the cache changes afterwards.
	const env = freezeModelDefinitions({ ...process.env }, join(root, "run"));
	writeFileSync(join(canonical, "models-store.json"), "{}");
	const agentDir = stagePrimeAgentDirectory(join(root, "agent"), env);
	const staged = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as typeof definitions;
	assert.deepEqual(staged.providers["openai-codex"]?.models?.map((model) => model.id), ["gpt-9-catalog"]);
	assert.equal(staged.providers["openai-codex"]?.apiKey, undefined, "catalog models sign in like the Provider's other models");
	assert.equal(staged.providers.deepseek?.apiKey, "telomi-request-auth");

	const { modelRegistry } = createPrimeModelRegistry(prime, agentDir, { ...process.env, [PRIME_CREDENTIAL_SOURCE_ENV]: canonical });
	const added = modelRegistry.find("openai-codex", "gpt-9-catalog");
	assert.ok(added, "Prime resolves the catalog model");
	assert.ok(modelRegistry.find("openai-codex", "gpt-5.6-terra"), "Prime's own model is untouched");
	// Preparing the Provider compares the user's connections only; the added model is not one of them.
	assert.equal(modelRegistry.hasConfiguredAuth(added), true);
	const delegable = (await modelRegistry.getExecutableModels()).map((model) => `${model.provider}/${model.id}`);
	assert.ok(delegable.includes("openai-codex/gpt-9-catalog"), "delegation keeps the catalog model its discovery cannot list");
});
