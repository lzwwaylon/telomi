/** A Run's frozen Provider connection survives models appended to the live catalog, and nothing else. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prime from "prime-agent";

const root = mkdtempSync(join(tmpdir(), "telomi-prime-model-growth-"));
const canonical = join(root, "canonical");
mkdirSync(canonical);
process.env.PI_CODING_AGENT_DIR = canonical;
const { PRIME_CREDENTIAL_SOURCE_ENV, createPrimeModelRegistry, stagePrimeAgentDirectory } =
	await import("../../server/agent-runtime/prime-agent-paths.js");
const { freezeModelDefinitions } = await import("../../server/agent-runtime/model-policy.js");

const provider = (models: Array<Record<string, unknown>>, baseUrl = "http://127.0.0.1:9/v1") => ({ providers: {
	grow: { apiKey: "LITERAL", baseUrl, api: "openai-completions", models },
} });
const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, reasoning: false, ...extra });
const live = (value: unknown) => writeFileSync(join(canonical, "models.json"), JSON.stringify(value));

try {
	writeFileSync(join(canonical, "auth.json"), "{}");
	live(provider([model("a")]));
	const env = freezeModelDefinitions({ PRIME_AGENT_CODING_AGENT_DIR: canonical }, join(root, "control"));
	const { modelRegistry } = createPrimeModelRegistry(prime, stagePrimeAgentDirectory(join(root, "run"), env),
		{ [PRIME_CREDENTIAL_SOURCE_ENV]: canonical });
	assert.equal(await modelRegistry.getApiKeyForProvider("grow"), "LITERAL");

	// A catalog sync appends models the Run never saw: provider-level checks must not treat that as a change.
	live(provider([model("a"), model("b"), model("c")]));
	assert.equal(await modelRegistry.getApiKeyForProvider("grow"), "LITERAL");
	assert.equal(modelRegistry.getProviderAuthStatus("grow").configured, true);

	// Anything the Run can actually use still invalidates it.
	for (const [reason, value] of [
		["a frozen model's endpoint changed", provider([model("a", { baseUrl: "http://127.0.0.1:9/other" }), model("b")])],
		["a frozen model was removed", provider([model("b")])],
		["the provider endpoint changed", provider([model("a"), model("b")], "http://127.0.0.1:9/v2")],
	] as const) {
		live(value);
		await assert.rejects(modelRegistry.getApiKeyForProvider("grow"), /Provider connection 'grow' changed/u, reason);
		assert.throws(() => modelRegistry.getProviderAuthStatus("grow"), /Provider connection 'grow' changed/u, reason);
	}
	console.log("Frozen Provider connections ignore appended models and still reject real changes");
} finally {
	rmSync(root, { recursive: true, force: true });
}
