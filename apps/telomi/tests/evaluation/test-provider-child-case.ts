import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { deriveProviderChildCase, inspectProviderChildCapture, captureProviderChildCase, childTraceFacts, readProviderChildInput, type ChildCaseFile } from "../../server/evaluation/provider-child-case.js";
import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { liveProviderChildReplayRecipe } from "../../server/evaluation/provider-child-replay.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import type { NodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";
import { sha256 } from "../../server/lib/hash.js";

const root = mkdtempSync(join(tmpdir(), "telomi-child-case-test-"));
const goalId = "goal_child_case";
const workspaceDir = join(root, "data");
mkdirSync(join(workspaceDir, goalId), { recursive: true });
const service = new NodeBacktestService({ workspaceDir, listGoalIds: () => [goalId], recipes: [liveProviderChildReplayRecipe] });
const source = { sourceRunId: "historical", caseId: "parent" };
const childId = "sub-browser";
const executionId = `provider-execution:1:browser:${childId}`;
const task = "Read official release notes within the assigned date window.";
const trace = [
	{ type: "session", rlmDepth: 1, timestamp: "2026-01-01T00:00:00Z" },
	{ type: "model_change", provider: "test", modelId: "child" },
	{ type: "thinking_level_change", thinkingLevel: "medium" },
	{ type: "service_tier_change", serviceTier: "default" },
	{ type: "custom_message", customType: "agent_message", content: `[task from parent]\n\n${task}` },
	{ type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [],
		usage: { input: 10, output: 5, cost: { total: 0.01 } } } },
].map((r) => JSON.stringify(r)).join("\n") + "\n";
const files: ChildCaseFile[] = [];
function file(ref: string, kind: string, content: string) {
	const path = join(root, "files", String(files.length)); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
	files.push({ ref, kind, absolutePath: path, sha256: sha256(content), byteLength: Buffer.byteLength(content) });
}
file("output:result.json", "observed_output", JSON.stringify({ execution_records: [
	{ provider_id: "browser", execution_id: executionId, terminal_status: "valid_bundle" },
	{ provider_id: "github", execution_id: "provider-execution:1:github:sub-other", terminal_status: "valid_bundle" },
] }));
file(`run:acquisition-session/session-artifacts/${childId}/session.jsonl`, "child_trace", trace);
file("run:acquisition-session/session-artifacts/sub-other/session.jsonl", "child_trace", "OTHER CHILD SECRET");
file(`output:logical-workspaces/provider/${childId}/workspace/work/.execution-id`, "observed_output", childId);
file(`output:logical-workspaces/provider/${childId}/workspace/work/input.txt`, "observed_output", "Frozen initial dependency");
file(`output:logical-workspaces/provider/${childId}/workspace/skills/provider-workers/browser/prime-browser-provider-skill/SKILL.md`,
	"observed_output", "---\nname: prime-browser-provider-skill\ndescription: Browser evidence\n---\nRead sources.\n");
file(`output:logical-workspaces/provider/${childId}/workspace/skills/root-agent/shared/references/context.md`,
	"observed_output", "Frozen ancillary context");
file("input:request.json", "input", JSON.stringify({ temporal_context: { schemaVersion: 1, timeZone: "UTC", currentDate: "2026-01-01" } }));
file("run:execution-conditions.jsonl", "execution_conditions", [
	{ agent_session_id: childId, tools: ["ipython", "submit_candidate_ledger"], custom_tools: ["submit_candidate_ledger"], skills: { items: [{ name: "prime-browser-provider-skill", sha256: "abc" }] } },
	{ kind: "skill_read", agent_session_id: childId, path: "SKILL.md" },
	{ kind: "skill_read", agent_session_id: "sub-other", path: "OTHER CHILD SECRET" },
	{ launch_kind: "root_with_native_rlm_children", tools: ["ipython", "submit_candidate_ledger"], custom_tools: ["submit_candidate_ledger"], prompt: "ROOT SECRET" },
].map((r) => JSON.stringify(r)).join("\n"));
file("case:provider-calls.jsonl", "provider_calls", JSON.stringify({ sub_execution_id: childId, operation: "browser" }) + "\n");
const terminal = join(root, "terminal");
mkdirSync(join(terminal, "provider-executions", childId, "work"), { recursive: true });
writeFileSync(join(terminal, "provider-executions", childId, "work/browser_candidates.json"), '{"candidates":[]}');
writeFileSync(join(terminal, "provider-executions", childId, "work/.task.md"), task + "\n");
writeFileSync(join(terminal, "provider-executions", childId, "work/terminal-only.txt"), "Historical answer");
const recordDirectory = join(serverRuntimeDirForGoal(goalId, workspaceDir), "evaluation/provider-child-cases/test");
mkdirSync(recordDirectory, { recursive: true });
const input = { goalId, parentRef: source, executionId, parent: { agentId: "prime-search", observed: { providerCalls: { ref: "provider-calls.jsonl" } } } as NodeEvaluationCase,
	files, recordDirectory, restoreOutput: async (destination: string) => { cpSync(terminal, destination, { recursive: true }); },
	capabilitySnapshot: (sourceDir: string) => service.createCapabilitySnapshot(goalId, sourceDir).id };
try {
	const ref = await deriveProviderChildCase(input);
	const value = service.readCase(goalId, ref);
	assert.equal(value.agentId, "provider-child");
	assert.ok(value.observed.providerCalls?.ref, "scoped Provider calls have a Case descriptor");
	assert.equal(inspectProviderChildCapture(input).childId, childId);
	assert.throws(() => childTraceFacts(trace.replace('"rlmDepth":1', '"rlmDepth":2')), /native depth-1/);
	assert.throws(() => inspectProviderChildCapture({ ...input, files: files.filter((f) => !f.ref.includes("skills/provider-workers/browser/")) }), /target Provider Skills/);
	const frozenSkillsMount = value.mounts.find((mount) => mount.guestPath === "/frozen-skills");
	assert.equal(frozenSkillsMount?.kind, "run");
	assert.ok(frozenSkillsMount && frozenSkillsMount.kind === "run");
	const frozenSkillsDirectory = join(service.caseRoots(goalId, ref).sourceRunDirectory, frozenSkillsMount.directory.ref);
	assert.equal(readFileSync(join(frozenSkillsDirectory, "root-agent/shared/references/context.md"), "utf-8"), "Frozen ancillary context");
	assert.throws(() => inspectProviderChildCapture({ ...input, files: files.filter((f) => !f.ref.endsWith(".execution-id")) }), /initial execution identity/);
	assert.throws(() => inspectProviderChildCapture({ ...input, files: [...files, { ...files[3]!, ref: `output:logical-workspaces/provider/${childId}/workspace/../escape` }] }), /safe regular files/);
	assert.equal(value.observed.metrics?.calls, 1);
	const paths = service.listCaseFilePaths(goalId, ref);
	assert.ok(paths.some((f) => f.kind === "child_trace"));
	assert.ok(paths.some((f) => f.kind === "execution_conditions"));
	assert.ok(!paths.some((f) => f.ref.startsWith("input:workspace/skills/")));
	assert.ok(!paths.some((f) => f.ref === "input:workspace/work/terminal-only.txt"));
	assert.ok(paths.every((f) => !readFileSync(f.absolutePath, "utf-8").includes("SECRET")));
	assert.equal(readProviderChildInput(join(service.caseRoots(goalId, ref).caseDirectory, "input")).model, "test/child");
	assert.deepEqual(await service.ensureProviderChildCase(goalId, source, executionId), ref);
	const bundle = await service.exportCaseBundle(goalId, "Child", ref);
	const other = join(root, "imported-data"); mkdirSync(join(other, goalId), { recursive: true });
	const importer = new NodeBacktestService({ workspaceDir: other, listGoalIds: () => [goalId], recipes: [liveProviderChildReplayRecipe] });
	try {
		const imported = importer.importBundle(bundle.path, () => undefined);
		assert.equal(importer.readCase(goalId, imported.caseRef).observed.trace?.root, "case");
		assert.equal(readFileSync(importer.caseFile(goalId, imported.caseRef, "output:traces/session.jsonl"), "utf-8"), trace);
		assert.ok(existsSync(importer.caseInputFile(goalId, imported.caseRef, "workspace/work/input.txt")));
		const importedMount = importer.readCase(goalId, imported.caseRef).mounts.find((m) => m.guestPath === "/frozen-skills")!;
		assert.ok(importedMount.kind === "run");
		assert.equal(readFileSync(join(importer.caseRoots(goalId, imported.caseRef).sourceRunDirectory, importedMount.directory.ref, "root-agent/shared/references/context.md"), "utf-8"), "Frozen ancillary context");
	} finally { importer.stop(); bundle.cleanup(); }
	assert.throws(() => childTraceFacts(trace + JSON.stringify({ type: "custom_message", customType: "agent_message", content: "[task from parent] change the task" })), /exactly one/);
	assert.throws(() => childTraceFacts(trace + JSON.stringify({ type: "custom_message", customType: "agent_message", details: { fromRelationship: "sibling" }, content: "Sibling update" })), /additional inbound messages/);
	await assert.rejects(deriveProviderChildCase({ ...input, executionId: "provider-execution:1:browser:sub-unknown" }), /Unknown/);
	await assert.rejects(deriveProviderChildCase({ ...input, files: files.filter((f) => !f.ref.startsWith("output:logical-workspaces/")) }), /pre-execution/);
	const conditionsFile = files.find((f) => f.kind === "execution_conditions")!;
	const previousConditions = readFileSync(conditionsFile.absolutePath, "utf-8");
	writeFileSync(conditionsFile.absolutePath, previousConditions.split("\n").slice(1).join("\n"));
	const inherited = await deriveProviderChildCase({ ...input, parentRef: { ...source, sourceRunId: "inherited" },
		recordDirectory: join(serverRuntimeDirForGoal(goalId, workspaceDir), "evaluation/provider-child-cases/inherited") });
	const inheritedConditions = readFileSync(service.caseFile(goalId, inherited, "output:traces/execution-conditions.jsonl"), "utf-8");
	assert.match(inheritedConditions, /inherited_parent_launch/u);
	assert.match(inheritedConditions, /prime-browser-provider-skill/u);
	assert.ok(!inheritedConditions.includes("SECRET"));
	writeFileSync(conditionsFile.absolutePath, previousConditions);
	const failedRecord = join(serverRuntimeDirForGoal(goalId, workspaceDir), "evaluation/provider-child-cases/failed");
	mkdirSync(failedRecord, { recursive: true });
	const frozen = join(service.caseRoots(goalId, ref).caseDirectory, "input");
	cpSync(frozen, join(failedRecord, "child-input"), { recursive: true });
	const failed = captureProviderChildCase({ request: readProviderChildInput(frozen), inputDirectory: join(failedRecord, "child-input"),
		evidenceDirectory: join(recordDirectory, "result"), frozenSkillsDirectory, recordDirectory: failedRecord, sourceRunId: "failed-run",
		capabilitySnapshotId: value.capabilitySnapshotId!, status: "failed", error: "Test failure",
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, toolCalls: 0, durationMs: 1 });
	assert.equal(service.readCase(goalId, failed).status, "failed");
	assert.ok(service.readCase(goalId, failed).observed.terminalWorkspace);
	assert.equal(service.readCase(goalId, failed).observed.output, undefined);
	console.log("Provider child capture isolates evidence, freezes initial input and exports self-contained replayable Cases");
} finally { service.stop(); rmSync(root, { recursive: true, force: true }); }
