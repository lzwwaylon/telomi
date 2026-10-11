import { writeTaskContext } from "../task-context.js";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, join, relative } from "node:path";

import { finalizeStageOutput, validateStageOutputCandidate, type AgentStageRequest, type ValidatedStageArtifact } from "../../agent-runtime/agent-stage-runtime.js";
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
import { readPrimeSessionUsage, runPrime } from "./prime-search-batch.js";
import { snapshotSourceDirectory } from "./source-bundle.js";

interface AnswerWriterFailureDetails {
	submissionCount: number;
	validationErrors: string[];
}
// Preserve the original error identity and classification across the outer Capture boundary.
const failureDetails = new WeakMap<object, AnswerWriterFailureDetails>();
export function answerWriterFailureDetails(error: unknown): AnswerWriterFailureDetails | undefined {
	return typeof error === "object" && error !== null ? failureDetails.get(error) : undefined;
}

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
	if (!existsSync(join(inputRoot, "context.md"))) {
		const historical = JSON.parse(readFileSync(join(inputRoot, "request.json"), "utf8")) as { context?: string };
		writeTaskContext(inputRoot, historical.context ?? "");
	}
	const writingSkill = bundledAgentSkillPaths("research", "report-writer").find((path) => basename(path) === "writing-skill");
	if (!writingSkill) throw new Error("Answer Writer requires the bundled writing-skill");
	const skills = [...materializeSkills(snapshotSkills([writingSkill]), join(agentRoot, "skills")).values()];
	const pythonPaths = (await Promise.all(skills.map((skill) =>
		preparePythonSkillEnvironment(skill, { dataDir: resolveDataDir(env), env })))).flatMap((prepared) => prepared?.pythonPaths ?? []);
	writeFileSync(join(runtimeRoot, "system-prompt.md"), request.systemPrompt);
	const systemPromptFile = writeAgentSystemPrompt(recordRoot, request.role, request.stageId, request.attemptId, request.systemPrompt);
	writeJsonAtomic(`${tracePath}.sessions.json`, { schemaVersion: 1,
		sessions: [{ path: relative(recordRoot, join(runtimeRoot, "session", "session")), label: "Answer Writer" }] });
	appendRuntimeContext(recordRoot, recordKind, { type: "runtime.agent_bound", stage_id: request.stageId,
		execution_id: executionId, attempt: request.attempt ?? 1, agent: request.role,
		session_file: basename(tracePath), system_prompt_file: basename(systemPromptFile),
		session_mode: "fresh", model: `${model.provider}/${model.modelId}`, execution_profile: "prime_ipython" });
	let status: "succeeded" | "failed" | "cancelled" = "failed";
	let output: Record<string, unknown> = {};
	let submissionCount = 0;
	const validationErrors: string[] = [];
	let outputAccepted = false;
	let completedRun: Awaited<ReturnType<typeof runPrime>> | undefined;
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
			validateOutput: async (submission) => {
				request.signal.throwIfAborted();
				if (!Number.isSafeInteger(submission) || submission !== submissionCount + 1 || submission > 3 || outputAccepted) {
					throw new Error("Answer Writer submitted an invalid validation sequence");
				}
				submissionCount = submission;
				const reject = (error: unknown) => {
					const message = toErrorMessage(error);
					validationErrors.push(message);
					appendRuntimeContext(recordRoot, recordKind, { type: "runtime.output_validation_rejected", stage_id: request.stageId,
						execution_id: executionId, submission, error: message });
					return { accepted: false, error: message };
				};
				const answerPath = join(agentRoot, "work", "answer.json");
				const outputDirectory = lstatSync(join(agentRoot, "work"), { throwIfNoEntry: false });
				const stat = lstatSync(answerPath, { throwIfNoEntry: false });
				if (!outputDirectory?.isDirectory() || outputDirectory.isSymbolicLink()
					|| !stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128_000
					|| !isInsideRoot(realpathSync(agentRoot), realpathSync(answerPath))) {
					return reject(new Error("Answer Writer did not write a bounded regular work/answer.json"));
				}
				// Copying is host infrastructure. Its errors must not spend model repair turns.
				mkdirSync(join(request.workDirectory, "work"), { recursive: true });
				const entryPath = join(request.workDirectory, "work", "answer.json");
				copyFileSync(answerPath, entryPath);
				try {
					await validateStageOutputCandidate(request, { entryPath, outputRoot: join(request.workDirectory, request.output.rootRelativePath ?? "work/answer.json") });
				} catch (error) {
					request.signal.throwIfAborted();
					return reject(error);
				}
				request.signal.throwIfAborted();
				outputAccepted = true;
				return { accepted: true };
			},
			...(logicalWorkspaceCaptureRoot ? { logicalWorkspaceCapture: { root: logicalWorkspaceCaptureRoot, key: "root" } } : {}),
		});
		completedRun = run;
		if (run.rootError) throw new Error(run.rootError);
		request.signal.throwIfAborted();
		if (!outputAccepted) throw new Error("Answer Writer finished without an accepted output submission");
		// Publication happens after acceptance and Worker shutdown, outside the repair loop.
		const finalized = await finalizeStageOutput({ artifactStore: request.artifactStore, output: request.output,
			workDirectory: request.workDirectory });
		status = "succeeded";
		output = { artifact_ref: finalized.artifact.relativePath, artifact_sha256: finalized.artifact.sha256,
			submission_count: submissionCount, validation_errors: validationErrors,
			metrics: { input_tokens: run.usage.inputTokens, output_tokens: run.usage.outputTokens,
				cost_usd: run.usage.costUsd, model_calls: run.usage.calls, tool_calls: run.toolCalls } };
		return { value: finalized.value, artifact: finalized.artifact, submissionCount, validationErrors,
			session: { id: `prime:${request.runId}:${request.stageId}`, mode: "fresh" },
			turns: run.usage.calls, toolCalls: run.toolCalls, toolCounts: { ipython: run.toolCalls }, usage: run.usage, sessionPath: tracePath };
	} catch (error) {
		status = request.signal.aborted ? "cancelled" : "failed";
		const run = completedRun ?? readPrimeSessionUsage([join(runtimeRoot, "session", "session"), join(runtimeRoot, "session", "session-artifacts")]);
		output = { error: toErrorMessage(error), submission_count: submissionCount, validation_errors: validationErrors,
			metrics: { input_tokens: run.usage.inputTokens, output_tokens: run.usage.outputTokens,
				cost_usd: run.usage.costUsd, model_calls: run.usage.calls, tool_calls: run.toolCalls } };
		if (typeof error === "object" && error !== null) failureDetails.set(error, { submissionCount, validationErrors: [...validationErrors] });
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
		if (archiveError !== undefined) {
			if (typeof archiveError === "object" && archiveError !== null) failureDetails.set(archiveError, { submissionCount, validationErrors: [...validationErrors] });
			throw archiveError;
		}
	}
}
