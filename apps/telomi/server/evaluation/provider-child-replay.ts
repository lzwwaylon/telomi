import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { NodeReplayRecipe } from "../agent-runtime/node-evaluation.js";
import { loadResearchHarnessSnapshot } from "../research/harness/snapshot.js";
import { createHarnessResearchSourceRegistry } from "../research/sources/builtin-registry.js";
import { executeProviderChildReplay } from "../research/pipeline/provider-child-executor.js";
import { toErrorMessage } from "../lib/values.js";
import { captureProviderChildCase, copyChildWorkspace, readProviderChildInput } from "./provider-child-case.js";

export function createProviderChildReplayRecipe(options: { execute?: typeof executeProviderChildReplay } = {}): NodeReplayRecipe {
	return {
		identity: { id: "provider-child", version: 1 },
		async replay(input) {
			if (input.value.agentId !== "provider-child") throw new Error("Provider Child Recipe needs a Provider Child Case");
			if (input.promptOverride) throw new Error("Provider Child task is frozen; use a Candidate Skill instead of a prompt override");
			const directory = join(dirname(input.casePath), "input");
			const request = readProviderChildInput(directory);
			const frozenSkills = input.value.mounts.find((mount) => mount.guestPath === "/frozen-skills");
			if (!frozenSkills || frozenSkills.kind !== "run") throw new Error("Provider Child Case lacks frozen supporting Skills");
			const frozenSkillsDirectory = join(input.sourceRunDirectory, frozenSkills.directory.ref);
			const harness = loadResearchHarnessSnapshot(input.harnessWorkspaceDirectory);
			const registry = createHarnessResearchSourceRegistry(harness, process.env);
			if (!input.candidateCase) throw new Error("Provider Child Replay requires Candidate Case identity");
			const copiedInput = join(input.recordDirectory, "child-input");
			cpSync(directory, copiedInput, { recursive: true });
			let result;
			try {
				result = await (options.execute ?? executeProviderChildReplay)({
					registry, harness, recordDirectory: input.recordDirectory, goalId: request.goal_id,
					runId: input.candidateCase.sourceRunId,
					task: readFileSync(join(directory, "task.md"), "utf-8"), providerId: request.provider_id,
					model: request.model, thinking: request.thinking, serviceTier: request.service_tier, temporalContext: request.temporal_context,
					initialWorkspace: join(directory, "workspace"), frozenSkillsDirectory, signal: input.signal,
				});
			} catch (error) {
				const failed = mkdtempSync(join(tmpdir(), "telomi-child-failure-"));
				try {
					mkdirSync(join(failed, "traces"));
					for (const [source, target] of [["runtime/trace.jsonl", "traces/session.jsonl"],
						["runtime/execution-conditions.jsonl", "traces/execution-conditions.jsonl"], ["provider-calls.jsonl", "provider-calls.jsonl"]]) {
						if (existsSync(join(input.recordDirectory, source!))) cpSync(join(input.recordDirectory, source!), join(failed, target!));
					}
					const children = join(input.recordDirectory, "agent/provider-executions");
					if (existsSync(children)) {
						const ids = readdirSync(children).filter((id) => /^sub-[A-Za-z0-9-]+$/u.test(id));
						if (ids.length === 1) copyChildWorkspace(join(children, ids[0]!), join(failed, "workspace"));
					}
					writeFileSync(join(failed, "failure.json"), JSON.stringify({ status: input.signal.aborted ? "cancelled" : "failed", error: toErrorMessage(error) }));
					captureProviderChildCase({ request, inputDirectory: copiedInput, evidenceDirectory: failed,
						recordDirectory: input.recordDirectory, ...input.candidateCase,
						usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, toolCalls: 0, durationMs: 0,
						status: input.signal.aborted ? "cancelled" : "failed", error: toErrorMessage(error),
						frozenSkillsDirectory: existsSync(join(input.recordDirectory, "agent/skills"))
							? join(input.recordDirectory, "agent/skills") : frozenSkillsDirectory });
				} finally { rmSync(failed, { recursive: true, force: true }); }
				throw error;
			}
			const staging = mkdtempSync(join(tmpdir(), "telomi-child-output-"));
			try {
				copyChildWorkspace(result.workspaceRoot, join(staging, "workspace"));
				mkdirSync(join(staging, "traces"));
				cpSync(result.tracePath, join(staging, "traces/session.jsonl"));
				cpSync(result.conditionsPath, join(staging, "traces/execution-conditions.jsonl"));
				if (result.systemPromptPath) cpSync(result.systemPromptPath, join(staging, "system-prompt.md"));
				if (existsSync(result.providerCallsPath)) cpSync(result.providerCallsPath, join(staging, "provider-calls.jsonl"));
				writeFileSync(join(staging, "result.json"), JSON.stringify({ schema_version: 1,
					provider_id: request.provider_id, child_id: result.childId,
					execution_id: `provider-execution:1:${request.provider_id}:${result.childId}`,
					terminal_status: "valid_bundle", usage: result.usage, tool_calls: result.toolCalls }, null, 2) + "\n");
				captureProviderChildCase({ request, inputDirectory: copiedInput, evidenceDirectory: staging,
					recordDirectory: input.recordDirectory, ...input.candidateCase,
					usage: result.usage, toolCalls: result.toolCalls, durationMs: result.durationMs, frozenSkillsDirectory: result.skillsDirectory });
				return { caseId: input.value.caseId, agentId: "provider-child",
					artifact: input.artifactStore.describeDirectory("result"), usage: result.usage,
					turns: result.usage.calls, toolCalls: result.toolCalls };
			} finally { rmSync(staging, { recursive: true, force: true }); }
		},
	};
}
export const liveProviderChildReplayRecipe = createProviderChildReplayRecipe();
