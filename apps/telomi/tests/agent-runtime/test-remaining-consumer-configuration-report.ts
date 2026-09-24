/** Configuration API to the Report writer and Browser Evolution through native Prime transport, using only local HTTP. */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startConsumerConfiguration } from "./fixtures/consumer-configuration.js";

const harness = await startConsumerConfiguration();
const { root, env, control, signal, apply, configure, stopped, selected } = harness;
const { PrimeReportWriterStageRunner, primeReportWriterStageModelPolicy } = await import("../../server/research/pipeline/prime-report-writer.js");
const { readRuntimeRecords } = await import("../../server/observability/run-records.js");
const { pinRunModelSelection } = await import("../../server/research/run-model-selection.js");
const { RunArtifactStore } = await import("../../server/agent-runtime/artifact-store.js");
const { createGoalLlmWikiTools } = await import("../../server/wiki/tools.js");
const { createBrowserSkillEvolutionLoop } = await import("../../server/evolution/browser-inner-loop.js");
const { NodeBacktestService } = await import("../../server/evaluation/node-backtest.js");
try {
	// A report belongs to its enclosing Run and retains that Run's model and depth.
	await apply("second", "high");
	const reportEnv = pinRunModelSelection(env);
	await apply("first", "low");
	const reportRoot = join(root, "report");
	const reportInputs = join(root, "report-inputs");
	mkdirSync(reportInputs);
	writeFileSync(join(reportInputs, "materials.json"), JSON.stringify({ schema_version: 1, kind: "wiki", refs: ["wiki:test"] }));
	const reportRunner = new PrimeReportWriterStageRunner({ async runStage() { throw new Error("Unexpected delegate"); } }, { env: reportEnv });
	let liveReportTrace = false;
	let firstReportRootSessionDirectory = "";
	let firstReportLiveIndex = "";
	control.duringRequest = async () => {
		const bound = readRuntimeRecords(reportRoot, "research").find((event) => event.type === "runtime.agent_bound");
		assert.ok(bound, "Reporter registers its trace before the first model request");
		firstReportLiveIndex = readFileSync(join(reportRoot, `${bound.session_file}.sessions.json`), "utf8");
		const manifest = JSON.parse(firstReportLiveIndex);
		assert.equal(manifest.schemaVersion, 1);
		assert.deepEqual(manifest.sessions, [
			{ path: `runtime/${bound.execution_id}/session`, label: "Reporter" },
			{ path: `runtime/${bound.execution_id}/session-artifacts`, label: "Section" },
		]);
		firstReportRootSessionDirectory = join(reportRoot, manifest.sessions[0].path);
		writeFileSync(join(reportRoot, manifest.sessions[1].path, "section.jsonl"),
			`${JSON.stringify({ type: "message", message: { role: "assistant", content: "Section trace survives failure" } })}\n`);
		liveReportTrace = true;
	};
	const runReport = (reportSignal = signal, attemptId = "1") => reportRunner.runStage({
		runId: "report", stageId: "writer-report", attemptId, role: "report_writer",
		session: { key: "report", policy: "fresh" }, modelPolicy: primeReportWriterStageModelPolicy(reportEnv),
		systemPrompt: "Write a report.", userPrompt: "Write the report.", workDirectory: reportRoot,
		readonlyMounts: [{ hostPath: reportInputs, guestPath: "/inputs", access: "read-only" }],
		controlDirectory: reportRoot, artifactStore: new RunArtifactStore(reportRoot),
		output: { kind: "writer_chapters", publishRelativePath: "output", validate() { throw new Error("No synthetic report accepted"); } },
		additionalTools: createGoalLlmWikiTools({ goalDir: root }), signal: reportSignal,
	});
	await stopped(() => runReport(), "second", "high");
	control.duringRequest = undefined;
	assert.equal(liveReportTrace, true);
	const reportRecord = readRuntimeRecords(reportRoot, "research").find((event) => event.type === "node_execution");
	assert.equal(reportRecord?.status, "failed");
	assert.equal(reportRecord?.agent, "report_writer");
	const reportTrace = join(reportRoot, String(reportRecord?.trace_ref));
	const preservedSessions = JSON.parse(readFileSync(`${reportTrace}.sessions.json`, "utf8")).sessions as Array<{ path: string; label: string }>;
	assert.ok(existsSync(reportTrace), "native Root trace is archived");
	assert.deepEqual(preservedSessions.map((entry) => entry.label), ["Reporter", "Section 1"]);
	for (const entry of preservedSessions) assert.ok(existsSync(join(reportRoot, entry.path)));
	assert.match(readFileSync(join(reportRoot, preservedSessions[1]!.path), "utf8"), /Section trace survives failure/);
	assert.deepEqual(selected("report/agent").scoped, [{ model: "second", thinking: "high" }, { model: "second", thinking: "high" }]);
	const reportCancellation = new AbortController();
	const firstRootFile = join(firstReportRootSessionDirectory, readdirSync(firstReportRootSessionDirectory).find((name) => name.endsWith(".jsonl"))!);
	appendFileSync(firstRootFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: "Previous execution only" } })}\n`);
	// Recreate a process crash: only the live index and SDK files survived.
	for (const entry of preservedSessions) rmSync(join(reportRoot, entry.path));
	writeFileSync(`${reportTrace}.sessions.json`, firstReportLiveIndex);
	// Cancel after one completed response: before any response the native SDK may
	// legitimately have no persisted session, so there is no trace to archive yet.
	control.replyOnce = true;
	let cancellationRequests = 0;
	control.duringRequest = async () => {
		if (++cancellationRequests === 2) reportCancellation.abort();
	};
	await assert.rejects(() => runReport(reportCancellation.signal));
	assert.equal(cancellationRequests, 2, "cancel the repair request after the Root produced a response");
	control.duringRequest = undefined;
	const cancelledReport = readRuntimeRecords(reportRoot, "research").filter((event) => event.type === "node_execution").at(-1);
	assert.equal(cancelledReport?.status, "cancelled");
	assert.notEqual(cancelledReport?.execution_id, reportRecord?.execution_id, "reusing an attemptId creates a distinct execution");
	assert.notEqual(cancelledReport?.trace_ref, reportRecord?.trace_ref);
	rmSync(join(reportRoot, "runtime"), { recursive: true });
	assert.doesNotMatch(readFileSync(join(reportRoot, String(cancelledReport?.trace_ref)), "utf8"), /Previous execution only/);
	for (const entry of preservedSessions) assert.ok(existsSync(join(reportRoot, entry.path)), "prior crashed sessions survive runtime cleanup");
	assert.match(readFileSync(reportTrace, "utf8"), /Previous execution only/);
	assert.deepEqual(JSON.parse(readFileSync(`${reportTrace}.sessions.json`, "utf8")).sessions, preservedSessions);
	await apply("second", "high");
	// Browser Evolution's factory lives across operations. The next invocation must re-resolve.
	const evidenceDirectory = join(root, "evolution-evidence");
	const baselineDirectory = join(root, "evolution-baseline");
	mkdirSync(evidenceDirectory);
	mkdirSync(join(baselineDirectory, "prime-browser-provider-skill"), { recursive: true });
	writeFileSync(join(baselineDirectory, "prime-browser-provider-skill", "SKILL.md"), "Browser fixture");
	writeFileSync(join(evidenceDirectory, "manifest.json"), JSON.stringify({ runs: [1, 2, 3].map((id) => ({
		child_case_ref: { sourceRunId: `run-${id}`, caseId: `child-case-${id}` },
	})) }));
	const policies: unknown[] = [];
	const loop = createBrowserSkillEvolutionLoop({
		nodeBacktests: new NodeBacktestService({ workspaceDir: root, listGoalIds: () => [], recipes: [] }),
		runner: { async runStage(request) { policies.push(request.modelPolicy); throw new Error("controlled Stage stop"); } },
	});
	const evolution = (name: string) => loop({
		run: { schemaVersion: 1, id: name, goalId: "test", targetId: "prime-search/browser-provider", ownerAgentId: "prime-search",
			status: "authoring", objective: "Improve the skill", acceptanceCriteria: ["Preserve evidence"], evidenceRefs: [],
			directory: join(root, name), createdAt: "2026-09-11", updatedAt: "2026-09-11", baseline: { skillSetSha256: "test" } },
		goalDirectory: root, evidenceDirectory, baselineDirectory, candidateDirectory: join(root, name, "candidate"),
		recordDirectory: join(root, name), setStatus: () => {}, signal,
	});
	await assert.rejects(() => evolution("evolution-first"), /controlled Stage stop/);
	assert.deepEqual(policies.at(-1), { preferred: ["consumer-test/second"], fallback: [], reasoning: "high" });
	await configure({ taskModels: { browserEvolution: "consumer-test/first" }, stageThinkingLevels: { "browserEvolution.evolution": "low" } });
	await assert.rejects(() => evolution("evolution-next"), /controlled Stage stop/);
	assert.deepEqual(policies.at(-1), { preferred: ["consumer-test/first"], fallback: [], reasoning: "low" });
	console.log("Report writer keeps its Run's pinned selection and traces; Browser Evolution re-resolves per operation through native local transport");
} finally {
	await harness.close();
}
