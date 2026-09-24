/**
 * Unified model configuration from the settings API through to the Main Agent.
 *
 * The assertions are about what a Goal's next turn actually uses, not about how the configuration
 * is stored: saving for later changes nothing, applying reaches the next turn of an existing Goal,
 * an executing turn keeps its own selection, an explicit Goal override survives later default
 * changes until inheritance is restored, a connection activated mid-turn resolves at the next
 * turn, and recorded session selections never outrank the configuration.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { GoalExecution, GoalSession } from "../../server/goals/execution.js";
import type { GoalSnapshot, PromptInput } from "../../shared/types.js";

const root = mkdtempSync(join(tmpdir(), "telomi-main-agent-config-"));
const agentDir = join(root, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
const providerApiKey = "test-provider-key-must-not-leak";
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
	providers: {
		"telomi-test": {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			apiKey: providerApiKey,
			models: [{ id: "small-1", name: "Small One" }, { id: "large-1", name: "Large One" }],
		},
		// A connection the user activates while a turn is already running.
		"telomi-late": {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			models: [{ id: "late-1", name: "Late One" }],
		},
		// A local service that legitimately needs no credential.
		"telomi-local": {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			models: [{ id: "local-1", name: "Local One" }],
		},
		"kimi-coding": {
			baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions",
			models: [{ id: "probe-1" }],
		},
	},
}, null, 2));
// Isolate the Agent directory before the configuration modules capture their paths.
process.env.PI_CODING_AGENT_DIR = agentDir;

// Native OAuth refresh is an awaited external boundary where another settings request can land.
let duringRefresh: (() => Promise<void>) | undefined;
let rejectRefresh = false;
const authEndpoint = createServer((request, response) => {
	request.resume();
	request.on("end", async () => {
		const hook = duringRefresh;
		duringRefresh = undefined;
		await hook?.();
		response.writeHead(rejectRefresh ? 401 : 200, { "content-type": "application/json" });
		response.end(JSON.stringify(rejectRefresh ? { error: "invalid_grant" } : {
			access_token: "controlled-access", refresh_token: "controlled-refresh", expires_in: 86400, token_type: "Bearer",
		}));
	});
});
await new Promise<void>((resolve) => authEndpoint.listen(0, "127.0.0.1", resolve));
process.env.KIMI_CODE_OAUTH_HOST = `http://127.0.0.1:${(authEndpoint.address() as AddressInfo).port}`;
const expireCredential = () => writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
	"kimi-coding": { type: "oauth", access: "expired-access", refresh: "controlled-refresh", expires: 1 },
}));

const { GoalService } = await import("../../server/goals/service.js");
const { mountProviderConfigApi } = await import("../../server/providers/config-api.js");
const { NO_DEFAULT_MODEL_ERROR } = await import("../../server/goals/service.js");
const { recordModelVerdict } = await import("../../server/agent-runtime/model-config/model-verdicts.js");

type Service = InstanceType<typeof GoalService>;

/** Connection definitions activated after a Runner started; its catalog learns them on reload. */
const ACTIVATED_MODELS = new Set<string>();

/** Runs once inside the next catalog reload, which is when the boundary is still undecided. */
let onRefresh: ((runner: RecordingRunner) => Promise<void>) | null = null;

/** Rewrite the catalog so its revision changes without changing any Provider or model id. */
const editCatalog = (): void => {
	const contents = readFileSync(join(agentDir, "models.json"), "utf8");
	writeFileSync(join(agentDir, "models.json"), `${contents}\n`);
};

const KNOWN_MODELS = new Set([
	"telomi-test/small-1",
	"telomi-test/large-1",
	"telomi-local/local-1",
]);

/** Records the configuration each turn starts with, the way a real Runner receives it. */
class RecordingRunner implements GoalSession {
	/** Unset until the owner applies a selection; there is no built-in model. */
	modelId = "";
	thinkingLevel: GoalSnapshot["thinkingLevel"] = "off";
	readonly startedTurns: string[] = [];
	refreshes = 0;
	private running = false;

	constructor(private readonly goalId: string) {}

	getSnapshot(): GoalSnapshot {
		return {
			goalId: this.goalId,
			title: "Goal",
			description: "",
			messages: [],
			isStreaming: this.running,
			pendingToolCalls: [],
			stopState: "idle",
			...(this.modelId ? { modelId: this.modelId } : {}),
			thinkingLevel: this.thinkingLevel,
		};
	}
	getPreview(): string { return ""; }
	isRunning(): boolean { return this.running; }
	start(_input: PromptInput): void {
		this.running = true;
		this.startedTurns.push(this.modelId);
	}
	finishTurn(): void { this.running = false; }
	/** The real Runner reloads models.json here; this mirrors the contract it fulfils. */
	async refreshModelCatalog(): Promise<void> {
		this.refreshes += 1;
		const hook = onRefresh;
		onRefresh = null;
		if (hook) await hook(this);
		for (const model of ACTIVATED_MODELS) KNOWN_MODELS.add(model);
	}
	async steer(): Promise<void> {}
	abort(): void { this.running = false; }
	dispose(): void {}
	updateConfig(config: { modelId?: string; thinkingLevel?: GoalSnapshot["thinkingLevel"] }): void {
		// The real Runner is only reconfigured at a boundary; doing it mid-turn would change a Run
		// that is already executing, so the fake refuses rather than hiding it.
		if (this.running) throw new Error("a running turn must not be reconfigured");
		// The real Runner rejects a model its registry cannot serve.
		if (config.modelId && !KNOWN_MODELS.has(config.modelId)) {
			throw new Error(`Unsupported model: ${config.modelId}`);
		}
		if (config.modelId) this.modelId = config.modelId;
		if (config.thinkingLevel) this.thinkingLevel = config.thinkingLevel;
	}
	setTitle(): void {}
	setDescription(): void {}
	async appendExternalAssistantMessage(): Promise<void> {}
	async recordEvent(): Promise<boolean> { return true; }
	subscribe(): () => void { return () => undefined; }
	async projectUserMemory(): Promise<void> {}
}

const runners = new Map<string, RecordingRunner>();
const execution: GoalExecution = {
	async resumeWikiUpdate() { throw new Error("not used"); },
	async createRunner({ goal }) {
		const runner = new RecordingRunner(goal.id);
		runners.set(goal.id, runner);
		return runner;
	},
	async executeResearchRun() { throw new Error("not used"); },
	async resumeResearchRun() { throw new Error("not used"); },
};

const workspaceDir = join(root, "workspace");
mkdirSync(workspaceDir, { recursive: true });
let goals: Service = new GoalService(workspaceDir, execution);

const app = express();
app.use(express.json());
mountProviderConfigApi(app, { mainAgent: { describeMainAgentConfiguration: () => goals.describeMainAgentConfiguration() } });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as AddressInfo).port;

interface ConfigResponse {
	defaultProvider: string | null;
	defaultModel: string | null;
	status?: string;
	error?: string;
	consumers: Array<{
		id: string;
		effectiveModel: string;
		source: string;
		status: string;
		error?: string;
		pendingCount: number;
		fallback: { models: string[]; applies: boolean };
		overrides: Array<{
			id: string;
			model: string;
			modelOverridden: boolean;
			thinkingLevelOverridden: boolean;
		}>;
	}>;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: ConfigResponse }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: response.status, json: await response.json() as ConfigResponse };
}

const mainAgent = (config: ConfigResponse) => {
	const consumer = config.consumers.find((entry) => entry.id === "mainAgent");
	assert.ok(consumer, "the entry point must report the Main Agent consumer");
	return consumer;
};

/** Creating a Goal starts a Topic discussion turn; let it settle so later turns are its next ones. */
async function createSettledGoal(title: string): Promise<{ id: string }> {
	const goal = goals.createGoal({ title });
	// The Runner exists before its first turn starts; finishing earlier would leave that turn
	// queued behind the next one.
	for (let attempt = 0; attempt < 100 && !runners.get(goal.id)?.isRunning(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const runner = runners.get(goal.id);
	assert.ok(runner?.isRunning(), "creating a Goal must start its Runner");
	runner.finishTurn();
	runner.startedTurns.length = 0;
	return goal;
}

async function runTurn(goalId: string): Promise<string> {
	await goals.startRun(goalId, "next question");
	const runner = runners.get(goalId);
	assert.ok(runner);
	runner.finishTurn();
	return runner.startedTurns[runner.startedTurns.length - 1]!;
}

try {
	// A fresh installation has no model at all and says so instead of picking a built-in one.
	const initial = await call("GET", "/api/provider-config");
	assert.equal(mainAgent(initial.json).effectiveModel, "");
	assert.equal(mainAgent(initial.json).source, "unset");

	// Without a default, a turn cannot start; the error names the fix. The Topic discussion that
	// creating the Goal triggers fails the same way, so the Goal's Runner never starts a turn.
	const unconfigured = goals.createGoal({ title: "Unconfigured" });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(runners.get(unconfigured.id)?.startedTurns.length ?? 0, 0);
	assert.equal(goals.getTopicPlanGeneration(unconfigured.id)?.error, NO_DEFAULT_MODEL_ERROR);
	await assert.rejects(goals.startRun(unconfigured.id, "hello"), { message: NO_DEFAULT_MODEL_ERROR });

	const seeded = await call("POST", "/api/provider-config/apply", { defaultProvider: "telomi-test", defaultModel: "small-1" });
	assert.equal(seeded.status, 200);
	const goal = await createSettledGoal("Existing conversation");
	assert.equal(await runTurn(goal.id), "telomi-test/small-1");

	// Applying validates and activates; the existing conversation adopts it on its next turn.
	const applied = await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-test",
		defaultModel: "small-1",
	});
	assert.equal(applied.status, 200);
	assert.equal(applied.json.status, "active");
	assert.equal(applied.json.defaultModel, "small-1");

	// A Provider that rejected the default, in a connection test or a turn, is reported instead of
	// "active" until a test or turn succeeds on that model. Another model's verdict is its own.
	recordModelVerdict("telomi-test/small-1", "the Provider does not serve small-1");
	const rejected = mainAgent((await call("GET", "/api/provider-config")).json);
	assert.equal(rejected.status, "failed");
	assert.equal(rejected.error, "the Provider does not serve small-1");
	recordModelVerdict("telomi-test/large-1", "unrelated");
	recordModelVerdict("telomi-test/small-1", undefined);
	const recovered = mainAgent((await call("GET", "/api/provider-config")).json);
	assert.equal(recovered.status, "active");
	assert.equal(recovered.error, undefined);
	recordModelVerdict("telomi-test/large-1", undefined);
	assert.equal(mainAgent(applied.json).effectiveModel, "telomi-test/small-1");
	assert.equal(mainAgent(applied.json).source, "settings");
	assert.equal(await runTurn(goal.id), "telomi-test/small-1");

	// An executing turn keeps the selection it started with, and the entry point reports the
	// consumer as pending instead of claiming a completed change.
	const runner = runners.get(goal.id)!;
	await goals.startRun(goal.id, "long running question");
	const during = await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-test",
		defaultModel: "large-1",
	});
	assert.equal(during.json.status, "pending");
	assert.equal(mainAgent(during.json).status, "pending");
	assert.equal(mainAgent(during.json).pendingCount, 1);
	assert.equal(runner.modelId, "telomi-test/small-1", "an executing turn must not switch model");
	runner.finishTurn();
	assert.equal(await runTurn(goal.id), "telomi-test/large-1");

	// An explicit Goal override outranks later default changes until inheritance is restored.
	await goals.updateGoalConfig(goal.id, { modelId: "telomi-test/small-1" });
	assert.equal(await runTurn(goal.id), "telomi-test/small-1");
	const overridden = await call("GET", "/api/provider-config");
	assert.equal(mainAgent(overridden.json).effectiveModel, "telomi-test/large-1");
	assert.deepEqual(mainAgent(overridden.json).overrides.map((entry) => [entry.id, entry.model]), [
		[goal.id, "telomi-test/small-1"],
	]);

	await goals.updateGoalConfig(goal.id, { modelId: null });
	assert.equal(await runTurn(goal.id), "telomi-test/large-1", "restoring inheritance follows the default");
	assert.deepEqual(mainAgent((await call("GET", "/api/provider-config")).json).overrides, []);

	// Failed validation preserves the configuration that works.
	const invalid = await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-test",
		defaultModel: "does-not-exist",
	});
	assert.equal(invalid.status, 422);
	assert.equal(invalid.json.status, "failed");
	assert.match(invalid.json.error ?? "", /does-not-exist/u);
	assert.equal(invalid.json.defaultModel, "large-1");
	assert.equal(await runTurn(goal.id), "telomi-test/large-1");

	// A model from a connection activated after this Runner started is unknown to its catalog until
	// it reloads; the next turn must still use it, without disturbing the turn in progress.
	await goals.startRun(goal.id, "question that spans the activation");
	ACTIVATED_MODELS.add("telomi-late/late-1");
	assert.equal((await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-late",
		defaultModel: "late-1",
	})).status, 200);
	assert.equal(runners.get(goal.id)!.modelId, "telomi-test/large-1", "the executing turn keeps its model");
	runners.get(goal.id)!.finishTurn();
	assert.equal(await runTurn(goal.id), "telomi-late/late-1", "the next turn resolves the activated connection");
	assert.equal((await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-test",
		defaultModel: "large-1",
	})).status, 200);

	// An edit that keeps every Provider and model id still changes what a Runner would send, so the
	// boundary reloads the catalog on any activation rather than only on an unknown model.
	const runnerBefore = runners.get(goal.id)!;
	const refreshesBefore = runnerBefore.refreshes;
	editCatalog();
	assert.equal(await runTurn(goal.id), "telomi-test/large-1");
	assert.equal(runnerBefore.refreshes, refreshesBefore + 1, "an activated catalog is reloaded at the boundary");
	assert.equal(await runTurn(goal.id), "telomi-test/large-1");
	assert.equal(runnerBefore.refreshes, refreshesBefore + 1, "an unchanged catalog is not reloaded again");

	// A turn that starts while the catalog is reloading is left exactly as it is.
	editCatalog();
	onRefresh = async (runner) => {
		runner.start("a turn that starts during preparation");
	};
	await goals.updateGoalConfig(goal.id, { modelId: "telomi-test/small-1" });
	assert.equal(
		runners.get(goal.id)!.modelId,
		"telomi-test/large-1",
		"a turn that started while the catalog was reloading is never reconfigured",
	);
	runners.get(goal.id)!.finishTurn();
	assert.equal(await runTurn(goal.id), "telomi-test/small-1", "the next turn adopts it instead");

	// A newer decision taken while an older one waits for a reload is the user's latest word. The
	// reload is held open from outside, so the two updates overlap the way two requests would.
	editCatalog();
	KNOWN_MODELS.delete("telomi-test/small-1");
	const reloadStarted = Promise.withResolvers<void>();
	const releaseReload = Promise.withResolvers<void>();
	onRefresh = async () => {
		reloadStarted.resolve();
		await releaseReload.promise;
	};
	const olderUpdate = goals.updateGoalConfig(goal.id, { modelId: "telomi-test/small-1" })
		.catch(() => undefined);
	await reloadStarted.promise;
	const newerUpdate = goals.updateGoalConfig(goal.id, { modelId: "telomi-test/large-1" });
	releaseReload.resolve();
	await Promise.all([olderUpdate, newerUpdate]);
	assert.equal(
		goals.getGoalModelConfiguration(goal.id).effectiveModel,
		"telomi-test/large-1",
		"a failed older update must not roll back a newer choice",
	);
	KNOWN_MODELS.add("telomi-test/small-1");
	await goals.updateGoalConfig(goal.id, { modelId: null });

	// A keyless local connection is a valid selection; requiring a credential would reject it.
	const local = await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-local",
		defaultModel: "local-1",
	});
	assert.equal(local.status, 200);
	assert.equal(await runTurn(goal.id), "telomi-local/local-1");
	assert.equal((await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-test",
		defaultModel: "large-1",
	})).status, 200);

	// Thinking level follows the same path as the model, including back down to the authoritative
	// default: a cleared setting must reset the loaded Runner instead of leaving it where it was.
	assert.equal(runners.get(goal.id)!.thinkingLevel, "off");
	assert.equal((await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-test",
		defaultModel: "large-1",
		defaultThinkingLevel: "high",
	})).status, 200);
	await runTurn(goal.id);
	assert.equal(runners.get(goal.id)!.thinkingLevel, "high");

	await goals.updateGoalConfig(goal.id, { thinkingLevel: "low" });
	await runTurn(goal.id);
	assert.equal(runners.get(goal.id)!.thinkingLevel, "low", "an explicit Goal override wins");
	await goals.updateGoalConfig(goal.id, { thinkingLevel: null });
	await runTurn(goal.id);
	assert.equal(runners.get(goal.id)!.thinkingLevel, "high", "restoring inheritance follows the default");

	assert.equal((await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-test",
		defaultModel: "large-1",
	})).status, 200);
	await runTurn(goal.id);
	assert.equal(runners.get(goal.id)!.thinkingLevel, "off", "clearing the default resets the Runner");

	// Applying nothing must not be read as clearing the configuration.
	const empty = await call("POST", "/api/provider-config/apply");
	assert.equal(empty.status, 400);
	assert.equal(empty.json.defaultModel, "large-1");

	// A selection the Runtime cannot serve is refused, and the Goal keeps what worked: no model,
	// no thinking level may be left behind by the rejected edit.
	await assert.rejects(
		goals.updateGoalConfig(goal.id, { modelId: "telomi-test/retired-1" }),
		/Unsupported model/u,
	);
	assert.equal(goals.getGoalModelConfiguration(goal.id).effectiveModel, "telomi-test/large-1");
	assert.equal(goals.getGoalModelConfiguration(goal.id).overridden, false);
	assert.deepEqual(mainAgent((await call("GET", "/api/provider-config")).json).overrides, []);

	// A model that disappears later fails the turn instead of quietly running another one while
	// the entry point still reports the configured selection.
	await goals.updateGoalConfig(goal.id, { modelId: "telomi-test/small-1" });
	KNOWN_MODELS.delete("telomi-test/small-1");
	await assert.rejects(goals.startRun(goal.id, "question"), /Unsupported model/u);
	KNOWN_MODELS.add("telomi-test/small-1");
	await goals.updateGoalConfig(goal.id, { modelId: null });

	// Changing a Goal's own configuration mid-turn waits for the turn boundary too.
	await goals.startRun(goal.id, "another long running question");
	await goals.updateGoalConfig(goal.id, { modelId: "telomi-test/small-1" });
	assert.equal(runners.get(goal.id)!.modelId, "telomi-test/large-1", "an executing turn is never reconfigured");
	runners.get(goal.id)!.finishTurn();
	assert.equal(await runTurn(goal.id), "telomi-test/small-1");

	// A Goal that only overrides the thinking level is still reported as an override.
	await goals.updateGoalConfig(goal.id, { modelId: null, thinkingLevel: "high" });
	const thinkingOnly = mainAgent((await call("GET", "/api/provider-config")).json).overrides;
	assert.deepEqual(
		thinkingOnly.map((entry) => [entry.id, entry.modelOverridden, entry.thinkingLevelOverridden]),
		[[goal.id, false, true]],
	);
	await goals.updateGoalConfig(goal.id, { thinkingLevel: null });
	assert.deepEqual(mainAgent((await call("GET", "/api/provider-config")).json).overrides, []);

	// Recorded session selections never become configuration, even when override fields are absent.
	const historicalSession = await createSettledGoal("Goal with a historical session");
	const sameAsDefault = await createSettledGoal("Goal with a session matching the default");
	for (const [goalId, model] of [[historicalSession.id, "small-1"], [sameAsDefault.id, "large-1"]] as const) {
		const goalDir = join(workspaceDir, goalId);
		mkdirSync(goalDir, { recursive: true });
		const sessionManager = SessionManager.open(join(goalDir, "context.jsonl"), goalDir);
		// A session only reaches disk once it holds a real exchange.
		sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Answered." }] });
		sessionManager.appendModelChange("telomi-test", model);
		sessionManager.appendThinkingLevelChange("high");
	}
	// An installation that predates unified configuration has no override fields on disk.
	const goalsFile = join(workspaceDir, "goals.json");
	writeFileSync(goalsFile, JSON.stringify(
		(JSON.parse(readFileSync(goalsFile, "utf8")) as Array<Record<string, unknown>>).map((record) => {
			if (record.id !== historicalSession.id && record.id !== sameAsDefault.id) return record;
			const { modelOverride, thinkingLevelOverride, ...inheritedRecord } = record;
			return inheritedRecord;
		}),
		null,
		2,
	));
	runners.delete(historicalSession.id);
	goals = new GoalService(workspaceDir, execution);

	assert.deepEqual(goals.describeMainAgentConfiguration().overrides, []);
	for (const goalId of [historicalSession.id, sameAsDefault.id]) {
		assert.equal(goals.getGoalModelConfiguration(goalId).source, "settings");
		assert.equal(await runTurn(goalId), "telomi-test/large-1");
		assert.equal(runners.get(goalId)!.thinkingLevel, "off", "session thinking levels do not override settings");
	}

	// The Goal that matched the default keeps following it when the default changes again.
	assert.equal((await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-test",
		defaultModel: "small-1",
	})).status, 200);
	assert.equal(goals.getGoalModelConfiguration(sameAsDefault.id).effectiveModel, "telomi-test/small-1");
	assert.equal(goals.getGoalModelConfiguration(historicalSession.id).effectiveModel, "telomi-test/small-1",
		"a differing historical session still follows the current default");
	assert.equal((await call("POST", "/api/provider-config/apply", {
		defaultProvider: "telomi-test",
		defaultModel: "large-1",
	})).status, 200);

	// Goal summaries carry no configuration fields; those belong to the settings entry point.
	const summary = goals.listGoals().find((entry) => entry.id === historicalSession.id);
	assert.ok(summary && !("modelOverride" in summary) && !("overrideProvenance" in summary));

	// Restarting preserves explicit overrides and the active configuration, regardless of sessions.
	await goals.updateGoalConfig(historicalSession.id, { modelId: "telomi-test/small-1", thinkingLevel: "low" });
	goals = new GoalService(workspaceDir, execution);
	assert.equal(goals.getGoalModelConfiguration(historicalSession.id).effectiveModel, "telomi-test/small-1");
	assert.equal(goals.getGoalModelConfiguration(historicalSession.id).overridden, true);
	assert.equal(await runTurn(historicalSession.id), "telomi-test/small-1");
	assert.equal(runners.get(historicalSession.id)!.thinkingLevel, "low");
	assert.equal(await runTurn(sameAsDefault.id), "telomi-test/large-1");
	assert.equal(goals.describeMainAgentConfiguration().inheritedModel, "telomi-test/large-1");

	// Configuration responses describe selections, never credentials.
	const responseText = JSON.stringify((await call("GET", "/api/provider-config")).json);
	assert.ok(!responseText.includes(providerApiKey), "the configuration response must not expose a secret");
	assert.ok(readFileSync(join(agentDir, "settings.json"), "utf8").includes("large-1"));

	const oauthDefaults = { defaultProvider: "kimi-coding", defaultModel: "probe-1" };
	const newerDefaults = { defaultProvider: "telomi-test", defaultModel: "small-1" };
	for (const failure of [false, true]) {
		expireCredential();
		rejectRefresh = failure;
		const delayed = await call("POST", "/api/provider-config/apply", oauthDefaults);
		assert.equal(delayed.status, failure ? 422 : 200);
	}
	// A newer Apply wins even if the older validation completes last.
	rejectRefresh = false;
	expireCredential();
	duringRefresh = async () => {
		assert.equal((await call("POST", "/api/provider-config/apply", newerDefaults)).status, 200);
	};
	assert.equal((await call("POST", "/api/provider-config/apply", oauthDefaults)).status, 409);
	assert.equal(await runTurn(sameAsDefault.id), "telomi-test/small-1");

	// Explicit fallback models are validated like a default: an unusable entry is refused, a usable
	// one is accepted and every consumer reports whether the chain applies to it.
	const { markProviderCredentialDeleted } = await import("../../server/config/credential-tombstones.js");
	markProviderCredentialDeleted("telomi-local");
	const unusable = await call("PATCH", "/api/provider-config", { providerFallbackModels: ["telomi-local/local-1"] });
	assert.equal(unusable.status, 422, JSON.stringify(unusable.json.error));
	assert.match(unusable.json.error ?? "", /fallback model 'telomi-local\/local-1'.*deleted/u);
	const usable = await call("PATCH", "/api/provider-config", { providerFallbackModels: ["telomi-test/large-1"] });
	assert.equal(usable.status, 200);
	assert.deepEqual(mainAgent(usable.json).fallback, { models: ["telomi-test/large-1"], applies: true });
	assert.deepEqual(usable.json.consumers.find((entry) => entry.id === "primeRoot")?.fallback, { models: ["telomi-test/large-1"], applies: false });

	// A partial update validates against the Provider while another setting is applied. It must
	// write only the keys it names, onto the file as it is when validation ends.
	expireCredential();
	duringRefresh = async () => {
		assert.equal((await call("POST", "/api/provider-config/apply", { defaultProvider: "telomi-test", defaultModel: "large-1", defaultThinkingLevel: "high" })).status, 200);
	};
	const racing = await call("PATCH", "/api/provider-config", { providerFallbackModels: ["kimi-coding/k3"] });
	assert.equal(racing.status, 200, JSON.stringify(racing.json.error));
	const afterRace = (await call("GET", "/api/provider-config")).json;
	assert.deepEqual([afterRace.defaultModel, afterRace.defaultThinkingLevel, afterRace.providerFallbackModels], ["large-1", "high", ["kimi-coding/k3"]]);

	console.log("Main Agent unified model configuration passed");
} finally {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await new Promise<void>((resolve) => authEndpoint.close(() => resolve()));
	rmSync(root, { recursive: true, force: true });
}
