import assert from "node:assert/strict";

import { researchRunConfig } from "../../server/research/workspace-adapter.js";

// The language resolved for a Run must reach the Runtime config; otherwise every Run writes in the default language.
assert.deepEqual(researchRunConfig({ maxSearchBatches: 2 }, "zh-CN"), { maxSearchBatches: 2, outputLanguage: "zh-CN" });
assert.deepEqual(researchRunConfig({ outputLanguage: "en" as const }, "zh-CN"), { outputLanguage: "zh-CN" },
	"the Goal's resolved language outranks a Harness default");
assert.deepEqual(researchRunConfig({ maxSearchBatches: 2 }, undefined), { maxSearchBatches: 2 });
assert.deepEqual(researchRunConfig(undefined, "en"), { outputLanguage: "en" });

console.log("research run language: resolved output language reaches the Runtime config");
