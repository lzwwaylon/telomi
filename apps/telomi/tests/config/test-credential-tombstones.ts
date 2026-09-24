/**
 * A credential deleted in the unified entry point stays deleted.
 *
 * Stored credentials already outrank the environment, so the gap this covers is the opposite
 * direction: a Provider with no stored credential falls back to ambient environment variables,
 * which would silently reactivate it after a restart that reloads `.env*`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "telomi-credential-tombstones-"));
const agentDir = join(root, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
	applyCredentialTombstones,
	clearProviderCredentialTombstone,
	isProviderCredentialDeleted,
	markProviderCredentialDeleted,
} = await import("../../server/config/credential-tombstones.js");

const secret = "sk-environment-value-that-must-not-return";

try {
	const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: secret, UNRELATED: "keep" };
	assert.deepEqual(markProviderCredentialDeleted("openai", env), ["OPENAI_API_KEY"]);
	assert.equal(env.OPENAI_API_KEY, undefined, "deleting a credential drops its ambient value");
	assert.equal(env.UNRELATED, "keep");
	assert.ok(isProviderCredentialDeleted("openai"));

	// A restart reloads the environment files; the recorded deletion still wins.
	const afterRestart: NodeJS.ProcessEnv = { OPENAI_API_KEY: secret };
	assert.deepEqual(applyCredentialTombstones(afterRestart), ["OPENAI_API_KEY"]);
	assert.equal(afterRestart.OPENAI_API_KEY, undefined);

	// Every alias a Provider authenticates with is covered, not just the canonical name.
	const aliases: NodeJS.ProcessEnv = {
		ANTHROPIC_API_KEY: secret,
		ANTHROPIC_AUTH_TOKEN: secret,
		ANTHROPIC_OAUTH_TOKEN: secret,
	};
	assert.deepEqual(
		markProviderCredentialDeleted("anthropic", aliases).sort(),
		["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
	);
	assert.deepEqual(Object.keys(aliases), []);
	clearProviderCredentialTombstone("anthropic");

	// A connection the user declared in models.json carries its own key; deleting that connection
	// is what removes it, so there is no ambient value to strip and none is claimed.
	assert.deepEqual(markProviderCredentialDeleted("telomi-local", { TELOMI_LOCAL_API_KEY: secret }), []);
	clearProviderCredentialTombstone("telomi-local");

	// Deleting one Provider leaves every other Provider's environment untouched.
	const other: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: secret };
	assert.deepEqual(applyCredentialTombstones(other), []);
	assert.equal(other.ANTHROPIC_API_KEY, secret);

	// Configuring the Provider again makes it managed rather than deleted.
	clearProviderCredentialTombstone("openai");
	assert.equal(isProviderCredentialDeleted("openai"), false);
	const reconfigured: NodeJS.ProcessEnv = { OPENAI_API_KEY: secret };
	assert.deepEqual(applyCredentialTombstones(reconfigured), []);
	assert.equal(reconfigured.OPENAI_API_KEY, secret);

	// The record names a Provider, never a secret.
	const settings = readFileSync(join(agentDir, "settings.json"), "utf8");
	assert.ok(!settings.includes(secret), "settings must not store credential values");

	console.log("Deleted Provider credentials stay deleted");
} finally {
	rmSync(root, { recursive: true, force: true });
}
