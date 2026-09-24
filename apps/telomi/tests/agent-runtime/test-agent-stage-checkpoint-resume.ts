import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CheckpointingAgentStageRunner,
	type AgentStageRequest,
	type AgentStageRunner,
	type ValidatedStageArtifact,
} from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";

class PublishingRunner implements AgentStageRunner {
	calls = 0;

	async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
		this.calls += 1;
		mkdirSync(request.workDirectory, { recursive: true });
		const output = join(request.workDirectory, "candidate.json");
		writeFileSync(output, `${JSON.stringify({ answer: 42 })}\n`, "utf8");
		const artifact = request.artifactStore.publishFile(output, request.output.publishRelativePath);
		return {
			value: request.output.validate({
				entryPath: output,
				outputRoot: output,
				workDirectory: request.workDirectory,
			}),
			artifact,
			submissionCount: 1,
			validationErrors: [],
			session: { id: `session-${this.calls}`, mode: "fresh" },
			turns: 1,
			toolCalls: 1,
			toolCounts: { submit_stage_output: 1 },
			usage: { inputTokens: 10, outputTokens: 2, costUsd: 0, calls: 1 },
			sessionPath: join(request.controlDirectory, `session-${this.calls}.jsonl`),
		};
	}
}

const root = mkdtempSync(join(tmpdir(), "telomi-agent-checkpoint-"));
try {
	const delegate = new PublishingRunner();
	const runner = new CheckpointingAgentStageRunner(delegate);
	const artifactStore = new RunArtifactStore(join(root, "workspace"));
	const request: AgentStageRequest<{ answer: number }> = {
		runId: "run-resume",
		stageId: "checkpoint-stage",
		attemptId: "attempt-1",
		role: "checkpoint-test",
		promptConfig: { domain: "research", id: "report-writer", sandboxRole: "report.report_writer" },
		session: { key: "checkpoint-stage", policy: "fresh" },
		modelPolicy: { preferred: ["test/model"], fallback: [], reasoning: "off", maxRetries: 0, maxRetryDelayMs: 0 },
		systemPrompt: "stable system prompt",
		userPrompt: "stable user prompt",
		workDirectory: join(root, "work"),
		readonlyMounts: [],
		controlDirectory: join(root, "control"),
		artifactStore,
		output: {
			kind: "json_candidate",
			publishRelativePath: "artifacts/checkpoint/output.json",
			validate: ({ entryPath }) => JSON.parse(readFileSync(entryPath, "utf8")) as { answer: number },
		},
		signal: new AbortController().signal,
	};

	const first = await runner.runStage(request);
	assert.equal(first.value.answer, 42);
	assert.equal(delegate.calls, 1);

	const resumed = await runner.runStage({ ...request, attemptId: "attempt-after-restart" });
	assert.equal(resumed.value.answer, 42);
	assert.equal(resumed.artifact.relativePath, "artifacts/checkpoint/output.json");
	assert.equal(resumed.session.mode, "continued");
	assert.equal(delegate.calls, 1, "a validated Agent checkpoint must skip the completed Agent");
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("Agent stage checkpoint resume test passed");
