import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";
import {
	createPodcastWriterReplayRecipe,
	runPodcastWriterNodeEvaluation,
} from "../../server/evaluation/podcast-replay.js";
import type { PrimePodcastWritingResult } from "../../server/media/podcast/writer.js";

const root = mkdtempSync(join(tmpdir(), "telomi-podcast-frozen-replay-"));
const workspaceDir = join(root, "data");
const goalId = "goal_podcast_frozen";
const goalDirectory = join(workspaceDir, goalId);
const sourceRunId = "source-podcast-frozen";
const sourceRun = join(goalDirectory, ".pi", "runtime", "runs", "podcast-ai", sourceRunId);
const candidateRoot = join(root, "candidate");

for (const [variant, directory] of [["baseline", goalDirectory], ["candidate", candidateRoot]] as const) {
	const skill = join(directory, "skills", "podcast-writer", "podcast-writing");
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), `---\nname: podcast-writing\ndescription: Podcast ${variant} fixture.\n---\n`);
	writeFileSync(join(skill, "variant.txt"), `${variant}\n`);
}
mkdirSync(sourceRun, { recursive: true });

await runPodcastWriterNodeEvaluation({
	sourceText: "# Runtime evaluation\n\nA canonical report used to evaluate podcast writing.",
	sessionDir: sourceRun,
	title: "Runtime evaluation",
	language: "zh-CN",
	audience: "Technical decision makers",
	generationBrief: { durablePreference: null, generationInstruction: "Keep concrete details." },
	emitProgress: () => undefined,
	observe: () => undefined,
	signal: new AbortController().signal,
}, {
	recordDirectory: sourceRun,
	runId: sourceRunId,
	execute: async (input) => {
		assert.equal(input.env?.TELOMI_PODCAST_WRITER_THINKING_LEVEL, "low");
		return fakeCapturedPodcast(input.sessionDir);
	},
	env: {
		TELOMI_PODCAST_WRITER_THINKING_LEVEL: "low",
		TELOMI_PRIME_AGENT_ROOT_MODEL: "openai-codex/gpt-5.6-luna",
		TELOMI_PRIME_AGENT_CHILD_MODEL: "openai-codex/gpt-5.6-luna",
	},
});

const recipe = createPodcastWriterReplayRecipe({
	async execute(input) {
		const frozen = JSON.parse(readFileSync(join(input.caseInputDirectory, "request.json"), "utf8"));
		assert.equal(frozen.models.thinking, "low");
		const variant = readFileSync(join(
			input.harnessWorkspaceDirectory,
			"skills",
			"podcast-writer",
			"podcast-writing",
			"variant.txt",
		), "utf-8").trim();
		writePodcastTrace(input.workDirectory);
		writeFileSync(join(input.workDirectory, "media", "podcast", "writer", "agent-workspace", "writer-output", ".complete"), "");
		return {
			artifact: input.artifactStore.publishText(`${JSON.stringify({ variant })}\n`, "result.json"),
			usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
			turns: 1,
			toolCalls: 1,
		};
	},
});
const service = new NodeBacktestService({ workspaceDir, listGoalIds: () => [goalId], recipes: [recipe] });

try {
	service.start();
	const cases = service.listCases(goalId, "podcast-writer", 10);
	assert.equal(cases.length, 1, "production podcast writing must capture one Node Case");
	assert.ok(cases[0]!.value.workspace, "production Podcast Case must record workspace snapshots");
	const files = service.listCaseFiles(goalId, cases[0]!.ref);
	for (const kind of [
		"agent_trace",
		"related_agent_trace",
		"child_lifecycle",
		"kernel_trace",
		"runtime_result",
		"agent_input",
		"agent_file_contract",
	]) assert.ok(files.some((file) => file.kind === kind), `Podcast Case must expose ${kind}`);
	assert.match(readFileSync(join(
		sourceRun,
		"node-evaluation",
		"cases",
		cases[0]!.value.caseId,
		"observed-output",
		"rubric.md",
	), "utf-8"), /Canonical Report/u);

	const candidate = service.createCapabilitySnapshot(goalId, candidateRoot);
	const run = service.enqueue(goalId, {
		agentId: "podcast-writer",
		cases: [cases[0]!.ref],
		candidate: { capabilitySnapshotId: candidate.id },
		repetitions: 1,
		rubricId: "podcast-writer-content-v1",
	});
	const completed = await waitFor(service, run.id);
	assert.equal(completed.status, "awaiting_evaluation", completed.error);
	const execution = completed.executions[0]!;
	assert.deepEqual(execution.candidateCaseRef, {
		sourceRunId: `${run.id}::executions::${execution.id}`,
		caseId: execution.candidateCaseRef?.caseId,
	});
	const candidateCase = service.readCase(goalId, execution.candidateCaseRef!);
	assert.equal(candidateCase.capabilitySnapshotId, candidate.id);
	assert.ok(candidateCase.workspace, "Podcast Candidate Replay Case must record workspace snapshots");
	assert.ok(candidateCase.observed.output, "Podcast Candidate Replay Case must record its output");
	assert.deepEqual(JSON.parse(readFileSync(service.artifactFile(
		goalId,
		run.id,
		execution.id,
	), "utf-8")), { variant: "candidate" });
	const refs = execution.refs ?? {};
	assert.equal(refs.agentTrace, refs.podcastRootTrace);
	for (const ref of [
		"podcastRootTrace",
		"podcastChildLifecycle",
		"podcastChildTrace1",
		"podcastInput1",
		"podcastProtocolFile1",
		"podcastKernelTrace",
		"podcastRuntimeResult",
	]) assert.ok(refs[ref], `Podcast replay must expose ${ref}`);
	assert.ok(Object.values(refs).every((ref) => !ref?.endsWith("/.complete")),
		"Podcast replay must not expose dotfile sentinels as downloadable traces");
	assert.equal(service.evaluationBatch(goalId, run.id).pairs.length, 1);
	console.log("Podcast Writer Candidate Replay exposes native Prime traces and file protocol artifacts");
} finally {
	service.stop();
	// Workspace tree snapshots autostart the research-source-service; close it like app.ts does on shutdown.
	await getResearchSourceServiceManager().close().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}

function fakeCapturedPodcast(sessionDir: string): PrimePodcastWritingResult {
	const writerRoot = writePodcastTrace(sessionDir);
	const artifactRoot = join(writerRoot, "agent-workspace", "writer-output");
	const sections = [1, 2, 3].map((index) => ({
		sectionId: `segment-${String(index).padStart(3, "0")}`,
		title: `Segment ${index}`,
		text: `Concrete source-grounded segment ${index}.`,
	}));
	for (const section of sections) writeFileSync(join(artifactRoot, "sections", `${section.sectionId}.txt`), section.text);
	writeFileSync(join(artifactRoot, "manifest.json"), `${JSON.stringify({
		version: 1,
		title: "Runtime evaluation",
		sections: sections.map((section) => ({
			sectionId: section.sectionId,
			title: section.title,
			path: `sections/${section.sectionId}.txt`,
		})),
	}, null, 2)}\n`);
	writeFileSync(join(artifactRoot, ".complete"), "complete\n");
	return {
		title: "Runtime evaluation",
		sections,
		artifactRoot,
		rootModel: "openai-codex/gpt-5.6-luna",
		childModel: "openai-codex/gpt-5.6-luna",
	};
}

function writePodcastTrace(sessionDir: string): string {
	const writerRoot = join(sessionDir, "media", "podcast", "writer");
	for (const [relativePath, content] of [
		["runtime/session/root.jsonl", '{"type":"message"}\n'],
		["runtime/root-events.jsonl", '{"type":"rlm_child_update","child":{"id":"sub-1","status":"completed"}}\n'],
		["runtime/session-artifacts/sub-1/child.jsonl", '{"type":"message"}\n'],
		["runtime/kernel-launches.jsonl", '{"operation":"kernel"}\n'],
		["runtime/result.json", '{"usage":{"input_tokens":3,"output_tokens":2,"cost_usd":0.01,"model_calls":2}}\n'],
		["agent-workspace/inputs/request.json", '{"title":"Runtime evaluation"}\n'],
		["agent-workspace/inputs/canonical-report.md", "# Runtime evaluation\n"],
		["agent-workspace/work/plan.json", '{"segments":[]}\n'],
	] as const) {
		const path = join(writerRoot, relativePath);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}
	mkdirSync(join(writerRoot, "agent-workspace", "writer-output", "sections"), { recursive: true });
	writeFileSync(join(writerRoot, "agent-workspace", "writer-output", "review.json"), '{"approved":true}\n');
	return writerRoot;
}

async function waitFor(service: NodeBacktestService, runId: string) {
	while (true) {
		const run = service.read(goalId, runId)!;
		if (["awaiting_evaluation", "failed", "cancelled"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
