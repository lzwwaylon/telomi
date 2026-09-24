import assert from "node:assert/strict";
import { browserSkillEvolutionModelPolicy } from "../../server/evolution/browser-inner-loop.js";

const configured = browserSkillEvolutionModelPolicy({}, {
	defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra", defaultThinkingLevel: "medium",
});
assert.deepEqual(configured.preferred, ["openai-codex/gpt-5.6-terra"]);
assert.equal(configured.reasoning, "medium");
assert.deepEqual(browserSkillEvolutionModelPolicy({ TELOMI_EVOLUTION_MODEL: "deepseek/deepseek-v4-pro" }, {
	defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra",
}).preferred, ["deepseek/deepseek-v4-pro"]);
assert.throws(() => browserSkillEvolutionModelPolicy({}, {}), /requires a configured/);
assert.deepEqual(browserSkillEvolutionModelPolicy({}, {
	defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra",
	taskModels: { browserEvolution: "deepseek/deepseek-v4-pro" },
	stageThinkingLevels: { "browserEvolution.evolution": { level: "low", provenance: "user" } },
}), { preferred: ["deepseek/deepseek-v4-pro"], fallback: [], reasoning: "low" });
console.log("Browser Evolution uses configured model and thinking, with explicit override and no hidden default");
