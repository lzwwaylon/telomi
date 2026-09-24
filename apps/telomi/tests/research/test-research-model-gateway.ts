import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ResearchModelGateway } from "../../server/agent-runtime/models/model-gateway.js";
import { resolveAgentPath } from "../../server/config/agent-directory.js";

function configuredModel(): string {
	const explicit = process.env.TELOMI_RESEARCH_E2E_MODEL?.trim();
	if (explicit) return explicit;
	const settings = JSON.parse(readFileSync(resolveAgentPath("settings.json"), "utf-8")) as {
		defaultProvider?: string;
		defaultModel?: string;
	};
	if (!settings.defaultProvider || !settings.defaultModel) throw new Error("configure a default provider/model or TELOMI_RESEARCH_E2E_MODEL");
	return `${settings.defaultProvider}/${settings.defaultModel}`;
}

const model = configuredModel();
const gateway = new ResearchModelGateway();
await gateway.refresh();
const result = await gateway.complete({
	runId: ` research-gateway-${Date.now()}`,
	nodeId: "real-gateway-test",
	attempt: 1,
	systemPrompt: "Return one strict JSON object only. Do not use tools or Markdown.",
	messages: [{ role: "user", content: "Return {\"status\":\"ok\",\"sum\":5} after calculating 2+3.", timestamp: Date.now() }],
	policy: { preferred: [model], maxTokens: 512, maxRetries: 1 },
});
const value = JSON.parse(result.text) as { status?: string; sum?: number };
assert.equal(value.status, "ok");
assert.equal(value.sum, 5);
assert.ok(result.usage.input > 0, "real provider must report input tokens");
assert.ok(result.usage.output > 0, "real provider must report output tokens");
assert.equal(result.attempts.at(-1)?.outcome, "succeeded");
console.log(JSON.stringify({ passed: true, requestedModel: model, actualModel: result.actualModel,
	durationMs: result.durationMs, inputTokens: result.usage.input, outputTokens: result.usage.output }));
