import { isRecord } from "../../lib/values.js";
import { copyTaskContext, writeTaskContext } from "../task-context.js";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "../../lib/hash.js";
import { renderAgentPrompt } from "../../agent-runtime/prompt-registry.js";
import {
	agentSessionPath,
	appendNodeExecutionRecord,
	appendRuntimeContext,
	latestNodeDependencyIds,
	writeAgentSystemPrompt,
} from "../../observability/run-records.js";
import type { ResearchModelUsage } from "../../agent-runtime/model-usage.js";
import {
	AgentStageExecutionError,
	finalizeStageOutput,
	stageNodeGroupId,
	type AgentStageRequest,
	type AgentStageRunner,
	type FinalizedStageOutput,
	type ValidatedStageArtifact,
} from "../../agent-runtime/agent-stage-runtime.js";
import {
	beginNodeEvaluationCase,
	finishNodeEvaluationCase,
	type EvaluationCaseCapture,
	type NodeEvaluationCaseDraft,
} from "../../agent-runtime/node-evaluation.js";
import { snapshotSourceDirectory } from "./source-bundle.js";
import { spawnPrimeWorker } from "../../agent-runtime/prime-worker.js";
import { ResearchNodeError } from "../../agent-runtime/retry-policy.js";
import { renderPrimeNoteAgentUserPrompt } from "./note-agent-prompt.js";
import { runPiReaderSubagents } from "./note-reader-pi-subagents.js";
import { readQuestionReaderConfiguration } from "./reader-configuration.js";
import { emptyWorkspaceSnapshot, snapshotWorkspaceTree } from "../../agent-runtime/workspace-snapshot.js";
import { toErrorMessage } from "../../lib/values.js";
import { writeJsonAtomic } from "../../lib/fs.js";

const WORKER = fileURLToPath(new URL("./prime-note-agent-worker.mjs", import.meta.url));
const PRIME_AGENT_PATHS_MODULE = fileURLToPath(new URL("../../agent-runtime/prime-agent-paths.ts", import.meta.url));

interface PrimeEvidenceWorkerResult {
	schema_version: 1;
	model: string;
	usage: { input_tokens: number; output_tokens: number; cost_usd: number; model_calls: number };
	tool_calls: number;
	tool_counts?: Record<string, number>;
	turns: number;
}

export class PrimeNoteAgentStageRunner implements AgentStageRunner {
	constructor(
		private readonly delegate: AgentStageRunner,
		private readonly options: { env?: NodeJS.ProcessEnv },
	) {}

	async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
		if (request.role !== "note_agent" || request.output.kind !== "note") {
			return this.delegate.runStage(request);
		}
		return this.runPrimeStage(request);
	}

	private async runPrimeStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
		request.signal.throwIfAborted();
		if (request.session.policy !== "fresh") throw new Error("Note Agent requires a fresh Session");
		if (request.output.entryRelativePath !== "note.json") {
			throw new Error("Note Agent requires note.json");
		}
		const source = request.readonlyMounts.find((mount) => mount.guestPath === "/source");
		if (!source) throw new Error("Note Agent requires the bounded /source mount");
		const skillMounts = request.readonlyMounts.filter((mount) => mount.guestPath.startsWith("/skills/"));
		const skillPythonPaths = request.sandbox?.env?.TELOMI_SKILL_PYTHONPATH?.split(":").filter(Boolean) ?? [];
		const model = request.modelPolicy.preferred[0];
		if (!model?.includes("/")) throw new Error("Note Agent requires a provider/model selector");
		const [provider, ...modelParts] = model.split("/");
		const modelId = modelParts.join("/");
		if (!provider || !modelId) throw new Error("Note Agent requires a nonempty provider/model selector");
		const env = this.options.env ?? process.env;
		const piReader = request.executionProfile === "pi_builtin" && request.promptConfig?.userVariant === "question-reading";
		if (request.executionProfile === "pi_builtin" && (!piReader || request.promptConfig?.systemVariant !== "question-reading-pi")) {
			throw new Error("Unsupported Pi Reader profile; replay this historical Case in candidate mode");
		}
		const frozenInputs = request.readonlyMounts.find(mount => mount.guestPath === "/inputs");
		const recipe = request.evaluation?.recipeInput;
		const question = isRecord(recipe) && typeof recipe.question === "string" ? recipe.question : undefined;
		const reader = piReader ? readQuestionReaderConfiguration(frozenInputs?.hostPath, question, env, source.hostPath) : undefined;
		if (piReader) for (const name of ["reader-child-system.md", "reader-child-prompt.md"]) {
			if (!frozenInputs || !existsSync(join(frozenInputs.hostPath, name))) {
				throw new Error("Pi Reader requires frozen child Prompts; replay this historical Case in candidate mode");
			}
		}
		const executionProfile = piReader ? "pi_builtin" : "prime_ipython";
		const recordDirectory = request.recordDirectory ?? request.controlDirectory;
		const recordKind = request.recordKind ?? "research";
		const executionId = `${request.session.key}-${request.attemptId}`;
		const groupId = stageNodeGroupId(request, recordKind);
		const dependencies = latestNodeDependencyIds(recordDirectory, recordKind, { group: groupId });
		const startedAt = new Date().toISOString();
		const startedAtMs = Date.now();
		// Stage 直接在 Runtime 交下来的工作目录里执行。一次性 tmpdir 会让"回收执行现场"
		// 和"删除产物"变成同一个动作，中断后连排查现场都不剩。
		const stageRoot = request.workDirectory;
		const workspace = recordKind === "research" ? emptyWorkspaceSnapshot() : undefined;
		let completed = false;
		const runtimeRoot = join(stageRoot, "runtime");
		const agentRoot = join(stageRoot, "agent");
		const sessionPath = agentSessionPath(recordDirectory, request.role, executionId);
		let submissionCount = 0;
		const validationErrors: string[] = [];
		let finalized: FinalizedStageOutput<T> | undefined;
		let evaluationDraft: NodeEvaluationCaseDraft | undefined;
		let evaluationCapture: EvaluationCaseCapture | undefined;
		const readerSessions: Array<{ id: string; path: string; label: string }> = [];
		const updateReaderSessions = () => writeJsonAtomic(`${sessionPath}.sessions.json`, { schemaVersion: 1,
			sessions: readerSessions.map(item => ({ ...item, path: relative(recordDirectory, item.path) })) });
		const retainReaderTrace = () => {
			const target = join(recordDirectory, `${basename(sessionPath, ".jsonl")}-reader-runtime`);
			mkdirSync(target, { recursive: true });
			for (const name of ["sessions", "session.jsonl", "result.json", "root-result.json", "failure.json", "stdout.txt", "stderr.txt", "conditions.json", "effective-system-prompt.md",
				"tool-events.jsonl", "tool-output", "logical-workspaces", "children", "reader-delivery.jsonl", "reader-assembly.json",
				"reader-assembly-errors.jsonl", "official-subagent.json", "root-note.json", "reader_read.py"]) {
				const source = join(runtimeRoot, name);
				if (existsSync(source)) cpSync(source, join(target, name), { recursive: true });
			}
			const receipts = join(agentRoot, "inputs", "reader-results");
			if (existsSync(receipts)) cpSync(receipts, join(target, "reader-results"), { recursive: true });
			if (existsSync(join(agentRoot, "reader-plan.json"))) copyFileSync(join(agentRoot, "reader-plan.json"), join(target, "reader-plan.json"));
			for (const item of readerSessions) item.path = join(target, relative(runtimeRoot, item.path));
			updateReaderSessions();
		};
		mkdirSync(stageRoot, { recursive: true });
		if (workspace) await snapshotWorkspaceTree(workspace, "input", stageRoot);
		mkdirSync(runtimeRoot, { recursive: true });
		mkdirSync(agentRoot, { recursive: true });
		snapshotSourceDirectory(source.hostPath, join(agentRoot, "source"));
		const inputs = request.readonlyMounts.find((mount) => mount.guestPath === "/inputs");
		const inputRoot = join(agentRoot, "inputs");
		if (inputs) copyTaskContext(inputRoot, join(inputs.hostPath, "context.md"));
		else {
			// Historical source-reading Cases kept noteFocus in their frozen business input.
			const recipeInput = request.evaluation?.recipeInput;
			const noteFocus = isRecord(recipeInput) ? recipeInput.noteFocus : undefined;
			writeTaskContext(inputRoot, typeof noteFocus === "string" ? noteFocus : "");
		}
		if (piReader && frozenInputs && existsSync(join(frozenInputs.hostPath, "reader-config.json"))) {
			copyFileSync(join(frozenInputs.hostPath, "reader-config.json"), join(inputRoot, "reader-config.json"));
		}
		if (piReader) for (const name of ["reader-child-system.md", "reader-child-prompt.md"]) {
			copyFileSync(join(frozenInputs!.hostPath, name), join(inputRoot, name));
		}
		if (!piReader && request.promptConfig?.userVariant !== "question-reading") {
			const helper = fileURLToPath(new URL("./reader_read.py", import.meta.url));
			mkdirSync(join(inputRoot, "reader-tools"), { recursive: true });
			copyFileSync(helper, join(inputRoot, "reader-tools", "reader_read.py"));
			copyFileSync(helper, join(runtimeRoot, "reader_read.py"));
		}
		writeFileSync(join(runtimeRoot, "system-prompt.md"), request.systemPrompt);
		writeFileSync(join(runtimeRoot, "user-prompt.md"), piReader ? request.userPrompt : `${renderPrimeNoteAgentUserPrompt(request.userPrompt,
			request.promptConfig?.userVariant === "question-reading" ? "question-reading" : "prime-execution")}\n`);
		writeFileSync(join(runtimeRoot, "repair-prompt.md"),
			renderAgentPrompt("research", "note-agent", "user", {},
				request.promptConfig?.userVariant === "question-reading" ? "question-reading-repair" : "repair").content);
		const workerPath = join(runtimeRoot, "worker.mjs");
		if (!piReader) copyFileSync(WORKER, workerPath);
		const systemPromptFile = writeAgentSystemPrompt(
			recordDirectory,
			request.role,
			request.stageId,
			request.attemptId,
			request.systemPrompt,
		);
		try {
			if (recordKind === "research") evaluationDraft = beginNodeEvaluationCase({
				request: request as AgentStageRequest<unknown>,
				recordDirectory,
				promptConfig: {
					domain: request.promptConfig?.domain ?? "research",
					id: request.promptConfig?.id ?? "note-agent",
					sandboxRole: request.promptConfig?.sandboxRole ?? "report.note_agent",
					...(request.promptConfig?.systemVariant ? { systemVariant: request.promptConfig.systemVariant } : {}),
					...(request.promptConfig?.userVariant ? { userVariant: request.promptConfig.userVariant } : {}),
					...(request.promptConfig?.revisions ? { revisions: request.promptConfig.revisions } : {}),
					requestedSha256: { system: sha256(request.systemPrompt), user: sha256(request.userPrompt) },
					composedSystemSha256: sha256(request.systemPrompt),
				},
				sessionContextFile: sessionPath,
				composedSystemPrompt: request.systemPrompt,
				actualModel: model,
			});
		} catch (error) {
			evaluationCapture = {
				status: "capture_failed",
				reason: toErrorMessage(error),
			};
		}
		readerSessions.push({ id: "root", path: join(runtimeRoot, "session.jsonl"), label: piReader ? "Reader Root" : "Note Agent" });
		updateReaderSessions();
		appendRuntimeContext(recordDirectory, recordKind, {
			type: "runtime.agent_bound",
			stage_id: request.stageId,
			execution_id: executionId,
			attempt: request.attempt ?? 1,
			agent: request.role,
			session_id: `${piReader ? "pi" : "prime"}:${request.runId}:${request.stageId}`,
			session_file: basename(sessionPath),
			system_prompt_file: basename(systemPromptFile),
			session_mode: "fresh",
			message_count_before: 0,
			model,
			execution_profile: executionProfile,
		});
		request.onActivity?.({
			stageId: request.stageId,
			attemptId: request.attemptId,
			role: request.role,
			status: "running",
			kind: "status",
			text: `${piReader ? "Pi Reader" : "Prime Agent"} ${model} is reviewing the Source`,
		});

		const validateOutput = async () => {
			submissionCount += 1;
			try {
				request.signal.throwIfAborted();
				const entryPath = join(stageRoot, "note.json");
				const candidatePath = join(agentRoot, "note.json");
				if (!existsSync(candidatePath)) throw new Error("note.json is missing; create the complete fixed output file");
				copyFileSync(candidatePath, entryPath);
				finalized = await finalizeStageOutput({ artifactStore: request.artifactStore, output: request.output,
					workDirectory: request.workDirectory });
			} catch (error) {
				const validationError = toErrorMessage(error);
				validationErrors.push(validationError);
				appendRuntimeContext(recordDirectory, recordKind, { type: "runtime.stage_output_rejected",
					stage_id: request.stageId, execution_id: executionId, submission: submissionCount,
					submission_mode: piReader ? "pi_file" : "prime_file", validation_error: validationError });
				throw error;
			}
		};

		try {
			let validationQueue = Promise.resolve();
			let outcome!: { usage: ResearchModelUsage };
			try {
				outcome = reader ? await runPiReaderSubagents({ work: agentRoot, runtimeRoot, provider, modelId,
					thinking: request.modelPolicy.reasoning ?? "off", systemPrompt: request.systemPrompt,
					userPrompt: request.userPrompt, childModel: reader.childModel, language: reader.language,
					env, signal: request.signal, validate: validateOutput,
					onSession: item => { readerSessions.push(item); updateReaderSessions(); },
				}) : await spawnPrimeWorker({
					name: "Note Agent",
					worker: workerPath,
					agentRoot,
					runtimeRoot,
					readonlyRoots: [join(agentRoot, "source"), inputRoot, ...skillMounts.map((mount) => mount.hostPath), ...skillPythonPaths],
					env,
					extraEnv: {
						PRIME_AGENT_EVIDENCE_CWD: agentRoot,
						PRIME_AGENT_EVIDENCE_RUNTIME: runtimeRoot,
						PRIME_AGENT_EVIDENCE_PROVIDER: provider,
						PRIME_AGENT_EVIDENCE_MODEL: modelId,
						// The Stage runs at the depth this Run froze, not at a constant in the Worker.
						PRIME_AGENT_EVIDENCE_THINKING: request.modelPolicy.reasoning ?? "off",
						PRIME_AGENT_PATHS_MODULE_PATH: PRIME_AGENT_PATHS_MODULE,
						PRIME_AGENT_EVIDENCE_SKILLS: JSON.stringify(skillMounts.map((mount) => mount.hostPath)),
						PYTHONPATH: [
							...skillMounts.map((mount) => join(mount.hostPath, "src")),
							...skillPythonPaths,
							env.PYTHONPATH,
						].filter(Boolean).join(":"),
					},
					signal: request.signal,
					onMessage: (message, reply) => {
						if (!isStageOutputCandidate(message)) return;
						validationQueue = validationQueue.then(async () => {
							try {
								await validateOutput();
								reply({ type: "stage_output_validation", submission: message.submission, accepted: true });
							} catch (error) {
								reply({ type: "stage_output_validation", submission: message.submission, accepted: false, error: toErrorMessage(error) });
							}
						});
					},
				});
			} finally {
				await validationQueue;
			}
			if (!finalized) throw new Error("Note Agent exited without Runtime validation");
			copyFileSync(join(runtimeRoot, "session.jsonl"), sessionPath);
			const worker = readWorkerResult(join(runtimeRoot, "result.json"));
			const toolCounts = worker.tool_counts ?? { ipython: worker.tool_calls };
			const usage = outcome.usage;
			const finishedAt = new Date().toISOString();
			appendRuntimeContext(recordDirectory, recordKind, {
				type: "runtime.stage_output_accepted",
				stage_id: request.stageId,
				execution_id: executionId,
				submission: submissionCount,
				submission_mode: piReader ? "pi_file" : "prime_file",
				output_source: finalized.source,
				output_ref: finalized.artifact.relativePath,
				output_sha256: finalized.artifact.sha256,
			});
			appendRuntimeContext(recordDirectory, recordKind, {
				type: "runtime.stage_completed",
				stage_id: request.stageId,
				execution_id: executionId,
				session_file: basename(sessionPath),
				output_ref: finalized.artifact.relativePath,
				metrics: { turns: worker.turns, tool_calls: worker.tool_calls, tool_counts: toolCounts,
					input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_usd: usage.costUsd,
					model_calls: usage.calls },
			});
			appendNodeExecutionRecord(recordDirectory, recordKind, {
				node_id: request.stageId,
				node_type: "agent",
				agent: request.role,
				execution_id: executionId,
				attempt: request.attempt ?? 1,
				status: "succeeded",
				group_id: groupId,
				depends_on: dependencies,
				input: { stage_id: request.stageId, role: request.role, session_policy: "fresh", model,
					execution_profile: executionProfile, input_mounts: [{ path: "/source", access: "read-only" }] },
				output: { artifact_ref: finalized.artifact.relativePath, artifact_sha256: finalized.artifact.sha256,
					submission_count: submissionCount, validation_errors: validationErrors, metrics: { turns: worker.turns,
						tool_calls: worker.tool_calls, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
						cost_usd: usage.costUsd, model_calls: usage.calls } },
				time: { started_at: startedAt, finished_at: finishedAt,
					duration_ms: Math.max(0, Date.now() - startedAtMs) },
				trace_ref: basename(sessionPath),
			});
			request.onActivity?.({ stageId: request.stageId, attemptId: request.attemptId, role: request.role,
				status: "succeeded", kind: "status", text: "Note Agent completed" });
			const result: ValidatedStageArtifact<T> = {
				value: finalized.value,
				artifact: finalized.artifact,
				submissionCount,
				validationErrors,
				session: { id: `${piReader ? "pi" : "prime"}:${request.runId}:${request.stageId}`, file: basename(sessionPath), mode: "fresh" },
				turns: worker.turns,
				toolCalls: worker.tool_calls,
				toolCounts,
				usage,
				sessionPath,
			};
			if (workspace) await snapshotWorkspaceTree(workspace, "output", stageRoot);
			if (evaluationDraft) {
				evaluationCapture = finishNodeEvaluationCase(evaluationDraft, {
					status: "succeeded",
					...(piReader ? { traceDirectories: [join(runtimeRoot, "sessions"), join(runtimeRoot, "children")],
						composedSystemPrompt: readFileSync(join(runtimeRoot, "effective-system-prompt.md"), "utf8") } : {}),
					workDirectory: request.workDirectory,
					result: result as ValidatedStageArtifact<unknown>,
					validationErrors,
					durationMs: Math.max(0, Date.now() - startedAtMs),
					...(workspace ? { workspace } : {}),
				});
			}
			if (evaluationCapture) result.evaluationCapture = evaluationCapture;
			completed = true;
			return result;
		} catch (error) {
			const workerSessionPath = join(runtimeRoot, "session.jsonl");
			if (existsSync(workerSessionPath)) copyFileSync(workerSessionPath, sessionPath);
			const failedUsage = readFailedSessionUsage(workerSessionPath);
			const children = join(runtimeRoot, "children");
			if (piReader && existsSync(children)) for (const id of readdirSync(children)) {
				const child = readFailedSessionUsage(join(children, id, "session.jsonl"));
				failedUsage.inputTokens += child.inputTokens;
				failedUsage.outputTokens += child.outputTokens;
				failedUsage.costUsd += child.costUsd;
				failedUsage.calls += child.calls;
			}
			const finishedAt = new Date().toISOString();
			const status = request.signal.aborted ? "cancelled" : "failed";
			if (workspace) await snapshotWorkspaceTree(workspace, "output", stageRoot);
			if (evaluationDraft) {
				evaluationCapture = finishNodeEvaluationCase(evaluationDraft, {
					status,
					...(piReader ? { traceDirectories: [runtimeRoot] } : {}),
					workDirectory: request.workDirectory,
					validationErrors,
					error: toErrorMessage(error),
					durationMs: Math.max(0, Date.now() - startedAtMs),
					...(workspace ? { workspace } : {}),
				});
			}
			appendRuntimeContext(recordDirectory, recordKind, {
				type: status === "cancelled" ? "runtime.stage_cancelled" : "runtime.stage_failed",
				stage_id: request.stageId,
				execution_id: executionId,
				error: toErrorMessage(error),
			});
			appendNodeExecutionRecord(recordDirectory, recordKind, {
				node_id: request.stageId,
				node_type: "agent",
				agent: request.role,
				execution_id: executionId,
				attempt: request.attempt ?? 1,
				status,
				group_id: groupId,
				depends_on: dependencies,
				input: { stage_id: request.stageId, role: request.role, session_policy: "fresh", model,
					execution_profile: executionProfile },
				output: {
					error: toErrorMessage(error),
					submission_count: submissionCount,
					validation_errors: validationErrors,
					metrics: {
						input_tokens: failedUsage.inputTokens,
						output_tokens: failedUsage.outputTokens,
						cost_usd: failedUsage.costUsd,
						model_calls: failedUsage.calls,
					},
				},
				time: { started_at: startedAt, finished_at: finishedAt,
					duration_ms: Math.max(0, Date.now() - startedAtMs) },
				...(existsSync(sessionPath) ? { trace_ref: basename(sessionPath) } : {}),
			});
			// Worker 上报的失败（上游模型错误、校验次数用尽）是这次 Agent 执行的结果，只属于这个 Source，
			// 按 Stage Runner 契约交给调用方隔离；Runtime 自身的故障照原样上抛。
			throw error instanceof ResearchNodeError
				? new AgentStageExecutionError(error.message, error.failureClass, { cause: error })
				: error;
		} finally {
			retainReaderTrace();
			// 会话轨迹已经另存到 Run 记录里；成功后回收体积大的 Source 快照与 Agent 现场，
			// 失败或中断则整体保留，供排查。
			if (completed) rmSync(stageRoot, { recursive: true, force: true });
		}
	}
}

function isStageOutputCandidate(value: unknown): value is { type: "stage_output_candidate"; submission: number } {
	if (!value || typeof value !== "object") return false;
	const message = value as Record<string, unknown>;
	return message.type === "stage_output_candidate"
		&& Number.isInteger(message.submission)
		&& (message.submission as number) > 0;
}

function readFailedSessionUsage(path: string): ResearchModelUsage {
	const usage: ResearchModelUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
	if (!existsSync(path)) return usage;
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as { message?: { role?: string; usage?: {
				input?: number; output?: number; cost?: { total?: number };
			} } };
			if (event.message?.role !== "assistant") continue;
			usage.inputTokens += Number.isFinite(event.message.usage?.input) ? event.message.usage!.input! : 0;
			usage.outputTokens += Number.isFinite(event.message.usage?.output) ? event.message.usage!.output! : 0;
			usage.costUsd += Number.isFinite(event.message.usage?.cost?.total) ? event.message.usage!.cost!.total! : 0;
			usage.calls += 1;
		} catch {
			// A truncated final trace line must not hide usage from earlier complete messages.
		}
	}
	return usage;
}

function readWorkerResult(path: string): PrimeEvidenceWorkerResult {
	const value = JSON.parse(readFileSync(path, "utf-8")) as PrimeEvidenceWorkerResult;
	if (value.schema_version !== 1 || !value.model || !value.usage || !Number.isInteger(value.tool_calls)) {
		throw new Error("Note Agent produced invalid runtime metadata");
	}
	return value;
}
