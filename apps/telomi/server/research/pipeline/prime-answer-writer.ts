import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, join, relative } from "node:path";

import { finalizeStageOutput, type AgentStageRequest, type ValidatedStageArtifact } from "../../agent-runtime/agent-stage-runtime.js";
import { primeAgentModulePath } from "../../agent-runtime/prime-agent-paths.js";
import { parseResearchModelRef } from "../../agent-runtime/models/model-policy.js";
import { bundledAgentSkillPaths, materializeSkills, snapshotSkills } from "../../agent-runtime/skill-registry.js";
import { preparePythonSkillEnvironment } from "../../agent-runtime/python-environment.js";
import { resolveDataDir } from "../../config/data-dir.js";
import { isInsideRoot } from "../../lib/paths.js";
import { listFilesRecursive, writeJsonAtomic } from "../../lib/fs.js";
import { toErrorMessage } from "../../lib/values.js";
import { agentSessionPath, appendNodeExecutionRecord, appendRuntimeContext, latestNodeDependencyIds,
	writeAgentSystemPrompt } from "../../observability/run-records.js";
import { runPrime } from "./prime-search-batch.js";
import { snapshotSourceDirectory } from "./source-bundle.js";

/** One independently captured Writer Session over frozen investigation evidence. */
export async function runPrimeAnswerStage<T>(
	request: AgentStageRequest<T>,
	executionId: string,
	options: { env?: NodeJS.ProcessEnv; execute?: typeof runPrime } = {},
	logicalWorkspaceCaptureRoot?: string,
): Promise<ValidatedStageArtifact<T>> {
	request.signal.throwIfAborted();
	if (request.session.policy !== "fresh") throw new Error("Answer Writer requires a fresh Session");
	if (request.output.entryRelativePath !== "work/answer.json") throw new Error("Answer Writer requires work/answer.json");
	const input = request.readonlyMounts.find((mount) => mount.guestPath === "/inputs");
	if (!input) throw new Error("Answer Writer requires the bounded /inputs mount");
	const env = options.env ?? process.env;
	const model = parseResearchModelRef(request.modelPolicy.preferred[0] ?? "");
	const recordRoot = request.recordDirectory ?? request.controlDirectory;
	const recordKind = request.recordKind ?? "research";
	const agentRoot = join(request.workDirectory, "agent");
	const inputRoot = join(agentRoot, "inputs");
	const runtimeRoot = join(request.workDirectory, "runtime", executionId);
	const tracePath = agentSessionPath(recordRoot, "report_writer", executionId);
	const dependencies = latestNodeDependencyIds(recordRoot, recordKind);
	const startedAt = new Date().toISOString();
	// Each answer is a fresh Session; an earlier failed attempt cannot supply its output.
	rmSync(join(agentRoot, "work"), { recursive: true, force: true });
	mkdirSync(join(agentRoot, "work"), { recursive: true });
	mkdirSync(runtimeRoot, { recursive: true });
	snapshotSourceDirectory(input.hostPath, inputRoot);
	const writingSkill = bundledAgentSkillPaths("research", "report-writer").find((path) => basename(path) === "writing-skill");
	if (!writingSkill) throw new Error("Answer Writer requires the bundled writing-skill");
	const skills = [...materializeSkills(snapshotSkills([writingSkill]), join(agentRoot, "skills")).values()];
	const pythonPaths = (await Promise.all(skills.map((skill) =>
		preparePythonSkillEnvironment(skill, { dataDir: resolveDataDir(env), env })))).flatMap((prepared) => prepared?.pythonPaths ?? []);
	writeFileSync(join(runtimeRoot, "system-prompt.md"), request.systemPrompt);
	const systemPromptFile = writeAgentSystemPrompt(recordRoot, request.role, request.stageId, request.attemptId, request.systemPrompt);
	appendRuntimeContext(recordRoot, recordKind, { type: "runtime.agent_bound", stage_id: request.stageId,
		execution_id: executionId, attempt: request.attempt ?? 1, agent: request.role,
		session_file: basename(tracePath), system_prompt_file: basename(systemPromptFile),
		session_mode: "fresh", model: `${model.provider}/${model.modelId}`, execution_profile: "prime_ipython" });
	let status: "succeeded" | "failed" | "cancelled" = "failed";
	let output: Record<string, unknown> = {};
	try {
		const run = await (options.execute ?? runPrime)({
			module: primeAgentModulePath(env), cwd: agentRoot, runtimeRoot,
			readonlyRoots: [inputRoot, ...skills, ...pythonPaths],
			sessionDir: join(runtimeRoot, "session", "session"),
			provider: model.provider, model: model.modelId, prompt: request.userPrompt, systemPrompt: request.systemPrompt,
			skills, tools: ["ipython"], thinking: request.modelPolicy.reasoning ?? "off",
			scopedModels: [], rlmMaxDepth: 0,
			extraEnv: { RLM_MAX_DEPTH: "0", PYTHONPATH: [...skills.map((skill) => join(skill, "src")), ...pythonPaths].join(delimiter),
				PYTHONDONTWRITEBYTECODE: "1" },
			env, signal: request.signal, onActivity: request.onActivity,
			activity: { stageId: request.stageId, attemptId: request.attemptId, role: request.role },
			tracePath, conditionsPath: join(runtimeRoot, "execution-conditions.jsonl"), launchKind: "standalone_answer_writer",
			...(logicalWorkspaceCaptureRoot ? { logicalWorkspaceCapture: { root: logicalWorkspaceCaptureRoot, key: "root" } } : {}),
		});
		if (run.rootError) throw new Error(run.rootError);
		request.signal.throwIfAborted();
		const answerPath = join(agentRoot, "work", "answer.json");
		const outputDirectory = lstatSync(join(agentRoot, "work"), { throwIfNoEntry: false });
		const stat = lstatSync(answerPath, { throwIfNoEntry: false });
		if (!outputDirectory?.isDirectory() || outputDirectory.isSymbolicLink()
			|| !stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128_000
			|| !isInsideRoot(realpathSync(agentRoot), realpathSync(answerPath))) {
			throw new Error("Answer Writer did not write a bounded regular work/answer.json");
		}
		mkdirSync(join(request.workDirectory, "work"), { recursive: true });
		copyFileSync(answerPath, join(request.workDirectory, "work", "answer.json"));
		const finalized = await finalizeStageOutput({ artifactStore: request.artifactStore, output: request.output,
			workDirectory: request.workDirectory });
		status = "succeeded";
		output = { artifact_ref: finalized.artifact.relativePath, artifact_sha256: finalized.artifact.sha256,
			metrics: { input_tokens: run.usage.inputTokens, output_tokens: run.usage.outputTokens,
				cost_usd: run.usage.costUsd, model_calls: run.usage.calls, tool_calls: run.toolCalls } };
		return { value: finalized.value, artifact: finalized.artifact, submissionCount: 1, validationErrors: [],
			session: { id: `prime:${request.runId}:${request.stageId}`, mode: "fresh" },
			turns: run.usage.calls, toolCalls: run.toolCalls, toolCounts: { ipython: run.toolCalls }, usage: run.usage, sessionPath: tracePath };
	} catch (error) {
		status = request.signal.aborted ? "cancelled" : "failed";
		output = { error: toErrorMessage(error) };
		throw error;
	} finally {
		// Archive native sessions before the shared Stage Capture removes a successful workspace.
		const sessions = join(runtimeRoot, "session");
		let archiveError: unknown;
		try {
			if (existsSync(sessions)) {
				const archive = join(recordRoot, "answer-writer-traces", basename(tracePath, ".jsonl"));
				cpSync(sessions, archive, { recursive: true });
				const conditions = join(runtimeRoot, "execution-conditions.jsonl");
				if (existsSync(conditions)) copyFileSync(conditions, join(archive, "execution-conditions.jsonl"));
				const nativeSession = listFilesRecursive(join(archive, "session"), { absolute: true })
					.find((path) => path.endsWith(".jsonl"));
				if (nativeSession) copyFileSync(nativeSession, tracePath);
				writeJsonAtomic(`${tracePath}.sessions.json`, { schemaVersion: 1,
					sessions: [{ path: relative(recordRoot, tracePath), label: "Answer Writer" }] });
			}
		} catch (error) {
			output = { ...output, trace_archive_error: toErrorMessage(error) };
			// Keep the model or validation error when archival also fails. A successful Stage
			// still fails archival so Capture retains the workspace rather than deleting its traces.
			if (status === "succeeded") {
				status = "failed";
				archiveError = error;
			}
		}
		const finishedAt = new Date().toISOString();
		appendNodeExecutionRecord(recordRoot, recordKind, { node_id: request.stageId, node_type: "agent", agent: request.role,
			execution_id: executionId, attempt: request.attempt ?? 1, status, depends_on: dependencies,
			input: { model: `${model.provider}/${model.modelId}`, session_policy: "fresh", rlm_max_depth: 0, mode: "investigation-answer" },
			output, time: { started_at: startedAt, finished_at: finishedAt, duration_ms: Date.parse(finishedAt) - Date.parse(startedAt) },
			trace_ref: basename(tracePath) });
		if (archiveError !== undefined) throw archiveError;
	}
}
