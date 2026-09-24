import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "capability-alerts-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.TELOMI_DATA_DIR = join(root, "data");
mkdirSync(process.env.TELOMI_DATA_DIR, { recursive: true });

// A speech service that answers the way an account out of credit does until it is topped up.
let credit = false;
const upstream = createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		if (req.url === "/v1/audio/speech" && credit) { res.setHeader("Content-Type", "audio/mpeg"); res.end(Buffer.alloc(2048, 1)); return; }
		if (req.url === "/v1/audio/speech") { res.statusCode = 402; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: { message: "Insufficient Balance" } })); return; }
		res.statusCode = 404; res.end("{}");
	});
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
writeFileSync(join(root, "models.json"), JSON.stringify({ providers: {
	"unit-audio": { api: "openai-completions", baseUrl, models: [{ id: "speech-1", capabilities: ["tts"], supportedVoices: ["nova"] }] },
} }));
writeFileSync(join(root, "auth.json"), JSON.stringify({ "unit-audio": { type: "api_key", key: "sk-unit-1234" } }));

const { describeCapabilityAlerts } = await import("../../server/providers/capability-alerts.js");
const { observeModelFailureText, recordModelVerdict, MODEL_VERDICTS_FILE } = await import("../../server/agent-runtime/model-config/model-verdicts.js");
const { testConnectionCapability } = await import("../../server/providers/connections-api.js");
const { loadSettings, saveSettings } = await import("../../server/config/settings.js");
type Embedding = Awaited<ReturnType<typeof import("../../server/embedding/configuration.js").describeEmbedding>>;

const noEmbedding: Embedding = {
	active: {}, pending: null, target: null, effective: { wiki: null, memory: null }, sources: { wiki: null, memory: null },
	consumers: [{ id: "wiki", status: "unconfigured", serving: null }, { id: "memory", status: "unconfigured", serving: null }], status: "active",
};
const wikiEmbedding: Embedding = {
	...noEmbedding,
	effective: { wiki: { connection: "unit-embed", model: "embed-1", baseUrl }, memory: null },
	consumers: [{ id: "wiki", status: "active", serving: { connection: "unit-embed", model: "embed-1" } }, { id: "memory", status: "unconfigured", serving: null }],
};
const sourceStates = new Map<string, "ok" | "unconfigured" | "error">([["firecrawl", "unconfigured"], ["tavily", "unconfigured"], ["exa", "unconfigured"]]);
const disabled = new Set<string>();

function deps(options: { chat?: string | null; embedding?: Embedding; memory?: { status: "active" | "failed"; error?: string; model?: string | null; embeddingSelected?: boolean } } = {}) {
	const memoryModel = { model: options.memory?.model ?? null, reasoningEffort: "medium", source: "memory" as const };
	return {
		mainAgent: { describeMainAgentConfiguration: () => ({
			inheritedModel: options.chat ?? null, inheritedSource: "settings" as const, inheritedThinkingLevel: "medium" as const,
			inheritedFailure: null, overrides: [], pendingGoalIds: [],
		}) },
		...(options.memory ? { memory: { describeConfiguration: () => ({
			settings: { llm: {}, retain: {}, reflect: {}, consolidation: {} }, pending: null, active: null,
			target: { llm: memoryModel, retain: memoryModel, reflect: memoryModel, consolidation: memoryModel },
			embeddingSelected: options.memory!.embeddingSelected ?? true, status: options.memory!.status, error: options.memory!.error,
		}) } } : {}),
		sources: {
			lacksCredential: (id: string) => sourceStates.get(id) === "unconfigured",
			isEnabled: (id: string) => !disabled.has(id),
		},
		describeEmbedding: async () => options.embedding ?? noEmbedding,
	};
}

test("a fresh install is told what to choose first", async () => {
	assert.deepEqual(await describeCapabilityAlerts(deps()), [
		{ kind: "unset", area: "chat" },
		{ kind: "unset", area: "embedding" },
		{ kind: "unset", area: "general_web" },
	]);
	sourceStates.set("tavily", "ok");
	assert.deepEqual(await describeCapabilityAlerts(deps({ chat: "unit/chat-1", embedding: wikiEmbedding })), [],
		"one working general web backend is enough");
	disabled.add("tavily");
	assert.deepEqual(await describeCapabilityAlerts(deps({ chat: "unit/chat-1", embedding: wikiEmbedding })), [{ kind: "unset", area: "general_web" }],
		"a backend switched off leaves research without general web");
	disabled.delete("tavily");
});

test("a Worker's model refusal reaches the capability that uses it until a success clears it", async () => {
	const chat = "deepseek/deepseek-v4-pro";
	observeModelFailureText(`Prime Cornell Note exited with code 1: model '${chat}' failed: 402 Insufficient Balance`);
	assert.ok(existsSync(join(root, MODEL_VERDICTS_FILE)), "the refusal survives a restart");
	assert.match(readFileSync(join(root, MODEL_VERDICTS_FILE), "utf-8"), /Insufficient Balance/u);
	const [rejected] = await describeCapabilityAlerts(deps({ chat, embedding: wikiEmbedding }));
	assert.equal(rejected?.kind, "rejected");
	assert.equal(rejected?.kind === "rejected" && rejected.area, "chat");
	assert.equal(rejected?.kind === "rejected" && rejected.error, "402 Insufficient Balance");

	observeModelFailureText(`model '${chat}' failed: 503 Service Unavailable`);
	assert.equal((await describeCapabilityAlerts(deps({ chat, embedding: wikiEmbedding }))).length, 1, "an outage does not hide the refusal");
	recordModelVerdict(chat, undefined);
	assert.deepEqual(await describeCapabilityAlerts(deps({ chat, embedding: wikiEmbedding })), []);

	// Codex logins and quota have their own account alerts; a model Codex does not serve does not.
	observeModelFailureText("model 'openai-codex/gpt-x' failed: 401 Unauthorized");
	assert.deepEqual(await describeCapabilityAlerts(deps({ chat: "openai-codex/gpt-x", embedding: wikiEmbedding })), []);
	observeModelFailureText("model 'openai-codex/gpt-x' failed: 404 model gpt-x does not exist");
	assert.equal((await describeCapabilityAlerts(deps({ chat: "openai-codex/gpt-x", embedding: wikiEmbedding })))[0]?.kind, "rejected");
	recordModelVerdict("openai-codex/gpt-x", undefined);
});

test("Memory reports its service failure and its own model's refusal", async () => {
	const memory = "deepseek/deepseek-flash";
	observeModelFailureText(`model '${memory}' failed: 402 Insufficient Balance`);
	const alerts = await describeCapabilityAlerts(deps({ chat: "unit/chat-1", embedding: wikiEmbedding, memory: { status: "failed", error: "Hindsight startup failed: exit 1", model: memory } }));
	assert.deepEqual(alerts.map((alert) => [alert.kind, alert.area]), [["failed", "memory"], ["rejected", "memory"]]);
	recordModelVerdict(memory, undefined);
});

test("Memory that has no model yet is not reported as failed; the unset alerts say what to choose", async () => {
	const failed = { status: "failed" as const, error: "Hindsight startup failed: Configure the Memory llm model or global LLM default" };
	assert.deepEqual((await describeCapabilityAlerts(deps({ memory: { ...failed, model: null } })))
		.filter((alert) => alert.area !== "general_web").map((alert) => [alert.kind, alert.area]), [["unset", "chat"], ["unset", "embedding"]]);
	assert.deepEqual(await describeCapabilityAlerts(deps({ chat: "unit/chat-1", embedding: wikiEmbedding, memory: { ...failed, model: "unit/chat-1", embeddingSelected: false } })), []);
});

test("a refused speech request raises a read-aloud alert and a successful test clears it", async () => {
	saveSettings({ ...loadSettings(), audioGeneration: { default: { connection: "unit-audio", model: "speech-1", voice: "nova", rate: 1 } } });
	const failed = await testConnectionCapability({ connection: "unit-audio", capability: "tts", model: "speech-1", voice: "nova" });
	assert.equal(failed.ok, false);
	const [alert] = await describeCapabilityAlerts(deps({ chat: "unit/chat-1", embedding: wikiEmbedding }));
	assert.equal(alert?.kind === "rejected" && alert.area, "tts");
	assert.equal(alert?.kind === "rejected" && alert.model, "unit-audio/speech-1");
	assert.match(alert?.kind === "rejected" ? alert.error : "", /^402: .*Insufficient Balance/u);

	credit = true;
	const passed = await testConnectionCapability({ connection: "unit-audio", capability: "tts", model: "speech-1", voice: "nova" });
	assert.equal(passed.ok, true, JSON.stringify(passed));
	assert.deepEqual(await describeCapabilityAlerts(deps({ chat: "unit/chat-1", embedding: wikiEmbedding })), []);
});

test.after(() => {
	upstream.close();
	rmSync(root, { recursive: true, force: true });
});
