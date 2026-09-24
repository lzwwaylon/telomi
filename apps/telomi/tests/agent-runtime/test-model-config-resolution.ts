import assert from "node:assert/strict";

import { resolveLLMConfig } from "../../server/agent-runtime/model-config/resolve.js";
import { resolvePrimeAgentModels } from "../../server/agent-runtime/model-policy.js";
import {
	researchConfigFromEnv,
} from "../../server/research/config.js";

const settings = {
	defaultProvider: "deepseek",
	defaultModel: "deepseek-v4-pro",
	defaultThinkingLevel: "high",
	providerFallbackModels: ["openai-codex/gpt-5.6-luna"],
};

const taskSettings = {
	...settings,
	taskModels: {
		cornellNote: "deepseek/deepseek-v4-pro",
		primeRoot: "openai-codex/gpt-5.6-sol",
		primeChild: "openai-codex/gpt-5.6-luna",
		wikiMaintainer: "openai-codex/gpt-5.6-terra",
	},
};
assert.equal(researchConfigFromEnv({}, taskSettings).cornellNoteModel, "deepseek/deepseek-v4-pro");
assert.equal(resolveLLMConfig({
	taskModelRole: "wikiMaintainer",
	settingsOverride: taskSettings,
}).model, "openai-codex/gpt-5.6-terra");
assert.deepEqual(resolvePrimeAgentModels({}, taskSettings), {
	root: { provider: "openai-codex", modelId: "gpt-5.6-sol", selector: "openai-codex/gpt-5.6-sol" },
	child: { provider: "openai-codex", modelId: "gpt-5.6-luna", selector: "openai-codex/gpt-5.6-luna" },
});
assert.equal(resolvePrimeAgentModels({
	TELOMI_PRIME_AGENT_ROOT_MODEL: "deepseek/deepseek-v4-flash",
}, taskSettings).root.selector, "deepseek/deepseek-v4-flash");

assert.equal(researchConfigFromEnv({ TELOMI_RESEARCH_OUTPUT_LANGUAGE: "zh-CN" }, taskSettings).outputLanguage, "zh-CN");
assert.equal(researchConfigFromEnv({ TELOMI_RESEARCH_CORNELL_NOTE_MODEL: "deepseek/deepseek-v4-flash" }, taskSettings).cornellNoteModel, "deepseek/deepseek-v4-flash");

// A role with no override inherits the capability default, so one change reaches every role.
assert.equal(researchConfigFromEnv({}, settings).cornellNoteModel, "deepseek/deepseek-v4-pro");
assert.deepEqual(resolvePrimeAgentModels({}, settings), {
	root: { provider: "deepseek", modelId: "deepseek-v4-pro", selector: "deepseek/deepseek-v4-pro" },
	child: { provider: "deepseek", modelId: "deepseek-v4-pro", selector: "deepseek/deepseek-v4-pro" },
});
assert.equal(resolveLLMConfig({ taskModelRole: "cornellNote", settingsOverride: settings }).source, "settings");

// Nothing substitutes a model nobody configured: the role fails where the user can see it.
assert.equal(resolveLLMConfig({ taskModelRole: "primeRoot", settingsOverride: {} }).model, null);
assert.throws(() => resolvePrimeAgentModels({}, {}), /Prime Root requires a configured provider\/model/u);
assert.throws(() => researchConfigFromEnv({}, {}), /Cornell Note requires a configured provider\/model/u);

console.log("model config resolution: ok");
