import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "telomi-task-model-environment-"));
process.env.PI_CODING_AGENT_DIR = root;
const { saveSettings } = await import("../../server/config/settings.js");
const { clearAmbientTaskModelOverrides } = await import("../../server/config/task-model-environment.js");
const { resolveLLMConfig, resolveStageThinkingLevel } = await import("../../server/agent-runtime/model-config/resolve.js");

try {
	saveSettings({ defaultProvider: "test", defaultModel: "default", defaultThinkingLevel: "high",
		taskModels: { primeRoot: "test/selected" } });
	const original = readFileSync(join(root, "settings.json"), "utf8");
	const ambient = { TELOMI_PRIME_AGENT_ROOT_MODEL: "test/retired", TELOMI_PRIME_REPORT_THINKING_LEVEL: "low", PATH: "unchanged" };
	const pinned = { ...ambient };
	clearAmbientTaskModelOverrides(ambient);
	assert.deepEqual(ambient, { PATH: "unchanged" });
	assert.equal(readFileSync(join(root, "settings.json"), "utf8"), original, "startup must not rewrite saved selections");
	assert.equal(resolveLLMConfig({ taskModelRole: "primeRoot", envOverride: ambient }).model, "test/selected");
	assert.equal(resolveStageThinkingLevel("primeRoot", "reportWriter", ambient).thinkingLevel, "high");
	assert.equal(resolveLLMConfig({ taskModelRole: "primeRoot", envVarName: "TELOMI_PRIME_AGENT_ROOT_MODEL", envOverride: pinned }).model, "test/retired");
	assert.equal(resolveStageThinkingLevel("primeRoot", "reportWriter", pinned).thinkingLevel, "low");
	clearAmbientTaskModelOverrides(ambient);
	assert.deepEqual(ambient, { PATH: "unchanged" });
} finally {
	rmSync(root, { recursive: true, force: true });
}
