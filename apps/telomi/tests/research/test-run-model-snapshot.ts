/**
 * Unified model configuration from the settings API through to a Research Run.
 *
 * The assertions are about what a Run actually uses, not about how the selection is stored: a
 * new Run adopts the applied default, a Run already executing keeps the selection it started
 * with wherever a later Stage or a descendant resolves a model, the settings entry point says
 * which Runs have not adopted a change instead of reporting blanket success, and a role with no
 * configured selection fails explicitly rather than running on a model nobody chose.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

const root = mkdtempSync(join(tmpdir(), "telomi-run-model-snapshot-"));
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
	},
}, null, 2));
// Isolate the Agent directory before the configuration modules capture their paths.
process.env.PI_CODING_AGENT_DIR = agentDir;

const { mountProviderConfigApi } = await import("../../server/providers/config-api.js");
const { researchConfigFromEnv } = await import("../../server/research/config.js");
const { resolvePrimeAgentModels } = await import("../../server/agent-runtime/model-policy.js");
const { primeSearchBatchContractIdentity } = await import("../../server/research/pipeline/prime-search-batch.js");
const { primeReportWriterStageModelPolicy } = await import("../../server/research/pipeline/prime-report-writer.js");
const { freezeRunModelSelection, pinRunModelSelection, runModelSelection } = await import("../../server/research/run-model-selection.js");
const { ResearchRuntime } = await import("../../server/research/runtime.js");
const { loadResearchHarnessSnapshot } = await import("../../server/research/harness/snapshot.js");
const { buildRunContextSnapshotFromHarness } = await import("../../server/research/run-context.js");

const app = express();
app.use(express.json());
mountProviderConfigApi(app, {
	mainAgent: {
		describeMainAgentConfiguration: () => ({
			inheritedModel: "telomi-test/small-1",
			inheritedSource: "settings",
			inheritedThinkingLevel: "off",
			inheritedFailure: null,
			overrides: [],
			pendingGoalIds: [],
		}),
	},
});
const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

interface ConfigResponse {
	consumers: Array<{
		id: string;
		effectiveModel: string;
		source: string;
		status: string;
		pendingCount: number;
		stages: Array<{
			key: string;
			label: string;
			thinkingLevel: string;
			source: string;
		}>;
		overrides: Array<{ id: string; model: string }>;
	}>;
}

async function readConfig(): Promise<ConfigResponse> {
	const response = await fetch(`${base}/api/provider-config`);
	assert.equal(response.status, 200);
	const text = await response.text();
	// A configuration status response describes what runs; it never carries the secret itself.
	assert.equal(text.includes(providerApiKey), false, "provider-config must not expose a credential");
	return JSON.parse(text) as ConfigResponse;
}

async function applyDefault(model: string, thinking = "low"): Promise<void> {
	const response = await fetch(`${base}/api/provider-config/apply`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ defaultProvider: "telomi-test", defaultModel: model, defaultThinkingLevel: thinking }),
	});
	assert.equal(response.status, 200, await response.text());
}

async function patchConfig(body: unknown): Promise<Response> {
	return fetch(`${base}/api/provider-config`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => { resolve = settle; });
	return { promise, resolve };
}

function roleConsumer(config: ConfigResponse, id: string) {
	const consumer = config.consumers.find((entry) => entry.id === id);
	assert.ok(consumer, `missing consumer ${id}`);
	return consumer;
}

try {
	// Nothing is configured yet: no role runs on a model nobody chose.
	assert.throws(() => pinRunModelSelection({}), /Cornell Note requires a configured provider\/model/u);
	for (const role of ["cornellNote", "primeRoot", "primeChild"]) {
		assert.equal(roleConsumer(await readConfig(), role).source, "unset");
	}

	await applyDefault("small-1");
	const applied = await readConfig();
	for (const role of ["cornellNote", "primeRoot", "primeChild"]) {
		const consumer = roleConsumer(applied, role);
		assert.equal(consumer.effectiveModel, "telomi-test/small-1", `${role} inherits the applied default`);
		assert.equal(consumer.source, "settings");
		assert.equal(consumer.status, "active");
		assert.deepEqual(consumer.overrides, []);
	}
	// With no explicit choice a Run Stage follows the activated capability default, and the page
	// reports that as its source rather than presenting a value the code fixed.
	assert.deepEqual(roleConsumer(applied, "cornellNote").stages, [
		{ key: "cornellNote.evidenceNote", label: "证据笔记", thinkingLevel: "low", source: "settings" },
	]);
	assert.deepEqual(roleConsumer(applied, "primeRoot").stages.map((stage) => stage.key),
		["primeRoot.searchAcquisition", "primeRoot.podcastWriter", "primeRoot.scheduleReview", "primeRoot.reportWriter"]);

	assert.deepEqual(roleConsumer(applied, "primeChild").stages.map((stage) => stage.key),
		["primeRoot.searchAcquisition", "primeRoot.podcastWriter", "primeRoot.reportWriter", "wikiMaintainer.maintenance"]);

	// A Stage the user chose a depth for keeps it, and restoring inheritance follows the default again.
	assert.equal((await patchConfig({ stageThinkingLevels: { "primeRoot.reportWriter": "xhigh" } })).status, 200);
	const withStageOverride = roleConsumer(await readConfig(), "primeRoot").stages
		.find((stage) => stage.key === "primeRoot.reportWriter");
	assert.deepEqual(withStageOverride,
		{ key: "primeRoot.reportWriter", label: "报告写作", thinkingLevel: "xhigh", source: "override" });
	assert.equal((await patchConfig({ stageThinkingLevels: {} })).status, 200);
	assert.equal(roleConsumer(await readConfig(), "primeRoot").stages
		.find((stage) => stage.key === "primeRoot.reportWriter")?.source, "settings");

	// A Run resolves its selection once, at its start.
	const runEnv = freezeRunModelSelection({}, join(root, "pinned-run"));
	// Independent roles must not expand the persisted ticket03 Research Run snapshot contract.
	assert.deepEqual(Object.keys(runModelSelection(runEnv).stageThinkingLevels).sort(),
		["cornellNote.evidenceNote", "primeRoot.reportWriter", "primeRoot.searchAcquisition"]);
	assert.deepEqual(runModelSelection(runEnv).models, {
		cornellNote: "telomi-test/small-1",
		primeRoot: "telomi-test/small-1",
		primeChild: "telomi-test/small-1",
	});

	await applyDefault("large-1", "high");

	// Every later Stage and descendant of that Run still resolves the selection it started with.
	assert.equal(researchConfigFromEnv(runEnv).cornellNoteModel, "telomi-test/small-1");
	assert.equal(resolvePrimeAgentModels(runEnv).root.selector, "telomi-test/small-1");
	assert.equal(resolvePrimeAgentModels(runEnv).child.selector, "telomi-test/small-1");
	assert.equal(primeSearchBatchContractIdentity(runEnv).rootModel, "telomi-test/small-1");
	assert.equal(primeSearchBatchContractIdentity(runEnv).childModel, "telomi-test/small-1");
	assert.equal(primeReportWriterStageModelPolicy(runEnv).preferred[0], "telomi-test/small-1");
	// Parameters freeze with the model: the Run keeps the depth it started with as well.
	assert.equal(researchConfigFromEnv(runEnv).cornellNoteThinkingLevel, "low");
	assert.equal(primeReportWriterStageModelPolicy(runEnv).reasoning, "low");
	assert.deepEqual(runModelSelection(runEnv).stageThinkingLevels, {
		"cornellNote.evidenceNote": "low",
		"primeRoot.searchAcquisition": "low",
		"primeRoot.reportWriter": "low",
	});

	// A resumed Run restores its starting model and parameters after a global edit.
	assert.deepEqual(runModelSelection(freezeRunModelSelection({}, join(root, "pinned-run"))), runModelSelection(runEnv));
	assert.equal(runModelSelection(pinRunModelSelection({})).stageThinkingLevels["primeRoot.reportWriter"], "high");
	// A Run started after the change adopts it.
	assert.equal(runModelSelection(pinRunModelSelection({})).models.primeRoot, "telomi-test/large-1");

	// An explicit per-execution pin - an Attestation Replay stating its model identity - wins.
	assert.equal(
		runModelSelection(pinRunModelSelection({ TELOMI_PRIME_AGENT_ROOT_MODEL: "telomi-test/small-1" })).models.primeRoot,
		"telomi-test/small-1",
	);

	// An explicit role override outranks the default and is reported as such, and restoring
	// inheritance makes the role follow later default changes again.
	assert.equal((await patchConfig({ taskModels: { cornellNote: "telomi-test/small-1" } })).status, 200);
	const overridden = roleConsumer(await readConfig(), "cornellNote");
	assert.equal(overridden.effectiveModel, "telomi-test/small-1");
	assert.equal(overridden.source, "override");
	assert.deepEqual(overridden.overrides.map((entry) => entry.model), ["telomi-test/small-1"]);
	assert.equal(runModelSelection(pinRunModelSelection({})).models.cornellNote, "telomi-test/small-1");
	assert.equal((await patchConfig({ taskModels: {} })).status, 200);
	assert.equal(roleConsumer(await readConfig(), "cornellNote").source, "settings");
	assert.equal(runModelSelection(pinRunModelSelection({})).models.cornellNote, "telomi-test/large-1");

	// An executing Run keeps its selection, and the entry point says so instead of reporting
	// that every consumer has adopted the change.
	const goalId = "goal_snapshot";
	const runId = "run_snapshot";
	const goalDir = join(root, goalId);
	const controlDirectory = join(root, "control", runId);
	const reachedSearch = deferred();
	const releaseSearch = deferred();
	let reachedCount = 0;
	const runtime = new ResearchRuntime({
		stageRunner: { async runStage() { throw new Error("This test must not invoke an Agent"); } },
		searchBatchExecutor: {
			async execute() {
				if (++reachedCount === 2) reachedSearch.resolve();
				await releaseSearch.promise;
				throw new Error("Deterministic search interruption");
			},
		},
	});
	const harness = loadResearchHarnessSnapshot(goalDir);
	const runContext = buildRunContextSnapshotFromHarness({ goalId, goalDir, dataDir: root, harness });
	const request = {
		goalId,
		runId,
		question: "Which model does this Run use?",
		reportContext: "Verify the Run keeps its starting selection",
		discoveryEnabled: true,
		workspaceDirectory: join(goalDir, "wiki/runs", runId),
		controlDirectory,
		goalWorkspaceDirectory: goalDir,
		workspaceRootDirectory: root,
		researchHarnessSnapshot: harness,
		runContextSnapshot: runContext.snapshot,
	};
	const executing = assert.rejects(runtime.run(request), /Deterministic search interruption/u);
	// Timestamp Run names may repeat across Goals; both executing Runs must remain visible.
	const otherGoalId = "goal_snapshot_other";
	const otherGoalDir = join(root, otherGoalId);
	const other = assert.rejects(runtime.run({
		...request, goalId: otherGoalId, goalWorkspaceDirectory: otherGoalDir,
		workspaceDirectory: join(otherGoalDir, "wiki/runs", runId),
		controlDirectory: join(root, "other-control", runId),
		runContextSnapshot: buildRunContextSnapshotFromHarness({ goalId: otherGoalId, goalDir: otherGoalDir, dataDir: root, harness }).snapshot,
	}), /Deterministic search interruption/u);
	await reachedSearch.promise;

	const duringRun = await readConfig();
	for (const role of ["cornellNote", "primeRoot", "primeChild"]) {
		const consumer = roleConsumer(duringRun, role);
		assert.equal(consumer.effectiveModel, "telomi-test/large-1");
		assert.equal(consumer.status, "active", `${role} is executing on the configuration in effect`);
	}

	// A same-id connection edit is also pending for consumers pinned to its previous definition.
	const modelsPath = join(agentDir, "models.json");
	const models = JSON.parse(readFileSync(modelsPath, "utf8"));
	models.providers["telomi-test"].baseUrl = "http://127.0.0.1:8/v1";
	writeFileSync(modelsPath, JSON.stringify(models));
	for (const role of ["cornellNote", "primeRoot", "primeChild"]) {
		assert.equal(roleConsumer(await readConfig(), role).status, "pending");
	}
	await applyDefault("small-1");
	const afterChange = await readConfig();
	for (const role of ["cornellNote", "primeRoot", "primeChild"]) {
		const consumer = roleConsumer(afterChange, role);
		assert.equal(consumer.effectiveModel, "telomi-test/small-1", `${role} reports the new default`);
		assert.equal(consumer.status, "pending", `${role} has a Run still on its own selection`);
		assert.equal(consumer.pendingCount, 2);
	}

	releaseSearch.resolve();
	await Promise.all([executing, other]);
	const afterRun = await readConfig();
	for (const role of ["cornellNote", "primeRoot", "primeChild"]) {
		assert.equal(roleConsumer(afterRun, role).status, "active", `${role} has no Run left to adopt the change`);
		assert.equal(roleConsumer(afterRun, role).pendingCount, 0);
	}

	console.log("research run model snapshot: ok");
} finally {
	server.close();
	rmSync(root, { recursive: true, force: true });
}
