import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PiSettings } from "../../config/settings.js";

import {
	resolvePrimeAgentModels,
} from "../../agent-runtime/model-policy.js";
import { isThinkingLevel, resolveStageThinkingLevel, type ThinkingLevel } from "../../agent-runtime/model-config/resolve.js";
import { sha256 } from "../../lib/hash.js";
import { loadReportNoteWorkspace, NoteWorkspace, type NoteWorkspaceQuery } from "../../research/notes/workspace.js";
import {
	appendNodeExecutionRecord,
	appendRuntimeContext,
	agentSessionPath,
	latestNodeDependencyIds,
} from "../../observability/run-records.js";
import { primeKernelPython } from "../../agent-runtime/prime-agent-paths.js";
import {
	bridgePositiveInteger,
	bridgeString,
	startAgentToolBridge,
	type AgentToolBridge,
} from "../../agent-runtime/agent-tool-bridge.js";
import { spawnPrimeWorker } from "../../agent-runtime/prime-worker.js";
import { preparePythonSkillEnvironment } from "../../agent-runtime/python-environment.js";
import { resolveDataDir } from "../../config/data-dir.js";
import { bundledAgentSkillPaths, materializeSkills, snapshotSkills } from "../../agent-runtime/skill-registry.js";
import { parseResearchModelRef, type ResearchModelPolicy } from "../../agent-runtime/models/model-policy.js";
import {
	finalizeStageOutput,
	validateStageOutputCandidate,
	type AgentStageRequest,
	type AgentStageRunner,
	type ValidatedStageArtifact,
} from "../../agent-runtime/agent-stage-runtime.js";
import {
	beginNodeEvaluationCase,
	finishNodeEvaluationCase,
	type EvaluationCaseCapture,
	type NodeEvaluationCaseDraft,
} from "../../agent-runtime/node-evaluation.js";
import {
	findOutSelfDirectedDelegationPrompt,
	primeWriterCompletedSectionsPrompt,
	primeWriterFinalPrompt,
	primeWriterFinalRepairPrompt,
	primeWriterResumeContextPrompt,
	wikiSelfDirectedDelegationPrompt,
} from "./report-prompts.js";
import { emptyWorkspaceSnapshot, snapshotWorkspaceTree } from "../../agent-runtime/workspace-snapshot.js";
import { listFilesRecursive, writeJsonAtomic } from "../../lib/fs.js";
import { toErrorMessage } from "../../lib/values.js";

const WORKER = new URL("./prime-report-writer-worker.ts", import.meta.url);
const PRIME_AGENT_PATHS_MODULE = fileURLToPath(new URL("../../agent-runtime/prime-agent-paths.ts", import.meta.url));
const LOGICAL_WORKSPACE_MODULE = fileURLToPath(new URL("../../agent-runtime/logical-workspace-snapshot.ts", import.meta.url));

export function stagePrimeReportWriterWorker(runtimeRoot: string): string {
	const worker = join(runtimeRoot, "worker.mts");
	// Keep module resolution rooted at the source, including transitive shared helpers.
	writeFileSync(worker, `await import(${JSON.stringify(WORKER.href)});\n`);
	return worker;
}

interface PrimeWorkerResult {
	schema_version: 1;
	root_model: string;
	child_model: string;
	usage: { input_tokens: number; output_tokens: number; cost_usd: number; model_calls: number };
	tool_calls: number;
	turns: number;
	session_path: string;
}


export function primeReportWriterContractIdentity(
	env: Record<string, string | undefined> = {},
	actual?: { rootModel: string; childModel: string; thinkingLevel: ResearchModelPolicy["reasoning"] },
	settingsOverride?: PiSettings,
) {
	// A caller that states what it actually ran needs no resolution: an identity is a record of
	// the execution, and recomputing it would fail wherever that configuration no longer exists.
	const rootPolicy = () => primeReportWriterStageModelPolicy(env, settingsOverride);
	return {
		id: "prime-report-writer",
		version: 5,
		rootModel: actual?.rootModel ?? rootPolicy().preferred[0],
		childModel: actual?.childModel ?? resolvePrimeAgentModels(env, settingsOverride).child.selector,
		thinkingLevel: actual?.thinkingLevel ?? rootPolicy().reasoning,
		knowledge: "frozen-material-adapter",
		orchestration: "root-plan-delegate-edit",
	};
}

/** Writer input file carrying the Run's resolved report language. Prompt text is never parsed for it. */
export const REPORT_WRITER_REQUEST_FILE = "request.json";

export function readReportWriterLanguage(inputRoot: string): string | undefined {
	const path = join(inputRoot, REPORT_WRITER_REQUEST_FILE);
	// Cases captured before this file existed replay without it and keep their recorded no-lint behavior.
	if (!existsSync(path)) return undefined;
	const language = (JSON.parse(readFileSync(path, "utf-8")) as { language?: unknown }).language;
	if (typeof language !== "string" || !language.trim()) {
		throw new Error(`Prime Report Writer ${REPORT_WRITER_REQUEST_FILE} requires a non-empty language`);
	}
	return language.trim();
}

/** The deterministic prose scanner only has Chinese rules. */
export function reportWriterUsesChineseLint(inputRoot: string): boolean {
	return readReportWriterLanguage(inputRoot)?.toLocaleLowerCase().startsWith("zh") ?? false;
}

/** The Stage policy must describe the model the Prime writer actually launches. */
export function primeReportWriterStageModelPolicy(
	env: NodeJS.ProcessEnv,
	settingsOverride?: PiSettings,
): ResearchModelPolicy {
	const root = resolvePrimeAgentModels(env, settingsOverride).root;
	return {
		preferred: [root.selector],
		reasoning: resolveStageThinkingLevel("primeRoot", "reportWriter", env, settingsOverride).thinkingLevel,
	};
}

/** Replaces only the production writer-report Stage. All other stages use the existing runner. */
export class PrimeReportWriterStageRunner implements AgentStageRunner {
	constructor(
		private readonly delegate: AgentStageRunner,
		private readonly options: { env?: NodeJS.ProcessEnv },
	) {}

	async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
		if (request.stageId !== "writer-report" || request.output.kind !== "writer_chapters") {
			return this.delegate.runStage(request);
		}
		const executionId = `${request.stageId}-${request.attemptId}-${randomUUID()}`;
		const recordKind = request.recordKind ?? "research";
		if (recordKind !== "research" || !request.evaluation) return this.runPrimeStage(request, executionId);
		const recordDirectory = request.recordDirectory ?? request.controlDirectory;
		const root = parseResearchModelRef(request.modelPolicy.preferred[0] ?? "");
		const workspace = emptyWorkspaceSnapshot();
		mkdirSync(request.workDirectory, { recursive: true });
		await snapshotWorkspaceTree(workspace, "input", request.workDirectory);
		const logicalWorkspaces = join(request.workDirectory, "runtime", executionId, "logical-workspaces");
		let draft: NodeEvaluationCaseDraft | undefined;
		let capture: EvaluationCaseCapture | undefined;
		try {
			draft = beginNodeEvaluationCase({
				request: request as AgentStageRequest<unknown>,
				recordDirectory,
				promptConfig: {
					domain: request.promptConfig?.domain ?? "research",
					id: request.promptConfig?.id ?? "report-writer",
					sandboxRole: request.promptConfig?.sandboxRole ?? "report.report_writer",
					...(request.promptConfig?.userVariant ? { userVariant: request.promptConfig.userVariant } : {}),
					...(request.promptConfig?.revisions ? { revisions: request.promptConfig.revisions } : {}),
					requestedSha256: { system: sha256(request.systemPrompt), user: sha256(request.userPrompt) },
					composedSystemSha256: sha256(request.systemPrompt),
				},
				sessionContextFile: join(request.workDirectory, "runtime", executionId, "root-events.jsonl"),
				composedSystemPrompt: request.systemPrompt,
					actualModel: `${root.provider}/${root.modelId}`,
			});
		} catch (error) {
			capture = { status: "capture_failed", reason: toErrorMessage(error) };
		}
		try {
			const result = await this.runPrimeStage(request, executionId, logicalWorkspaces);
			await snapshotWorkspaceTree(workspace, "output", request.workDirectory);
			if (draft) capture = finishNodeEvaluationCase(draft, {
				status: "succeeded",
				workDirectory: request.workDirectory,
				result: result as ValidatedStageArtifact<unknown>,
				validationErrors: result.validationErrors,
				logicalWorkspaces,
				workspace,
			});
			if (capture) result.evaluationCapture = capture;
			// 产物已发布、会话已另存、评估用例已采集，剩下的执行现场可以回收。
			// 失败路径刻意不回收：Node Evaluation Case 要把它作为 terminal-workspace 留档，
			// 现场本身也是"上一次没有跑完"的证据。
			rmSync(request.workDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
			return result;
		} catch (error) {
			await snapshotWorkspaceTree(workspace, "output", request.workDirectory);
			if (draft) finishNodeEvaluationCase(draft, {
				status: request.signal.aborted ? "cancelled" : "failed",
				workDirectory: request.workDirectory,
				validationErrors: [],
				logicalWorkspaces,
				error: toErrorMessage(error),
				workspace,
			});
			throw error;
		}
	}

	private async runPrimeStage<T>(request: AgentStageRequest<T>, executionId: string, logicalWorkspaceCaptureRoot?: string): Promise<ValidatedStageArtifact<T>> {
		request.signal.throwIfAborted();
		const startedAt = Date.now();
		const recordRoot = request.recordDirectory ?? request.controlDirectory;
		const recordKind = request.recordKind ?? "research";
		let submissionCount = 0;
		const validationErrors: string[] = [];
		let outputAccepted = false;
		let outcome!: Awaited<ReturnType<typeof spawnPrimeWorker>>;
		const input = request.readonlyMounts.find((mount) => mount.guestPath === "/inputs");
		if (!input) throw new Error("Prime Report Writer requires the bounded /inputs mount");
		const mode = existsSync(join(input.hostPath, "findout", "index.json")) ? "findout" as const : "wiki" as const;
		const tools = mode === "wiki" ? reportWikiTools(request.additionalTools ?? []) : new Map<string, AgentTool>();
		const noteWorkspace = mode === "findout" ? loadReportNoteWorkspace(join(input.hostPath, "findout")) : undefined;
		const env = this.options.env ?? process.env;
		const root = parseResearchModelRef(request.modelPolicy.preferred[0] ?? "");
		const rootProvider = root.provider;
		const rootModel = root.modelId;
		const child = resolvePrimeAgentModels({ ...env, ...(request.sandbox?.env ?? {}) }).child;
		const childProvider = child.provider;
		const childModel = child.modelId;
		const thinkingLevel = reportThinkingLevel(request.modelPolicy.reasoning);
		const runtimeRoot = join(request.workDirectory, "runtime", executionId);
		// A previous process may have exited before archiving its sessions. Preserve them
		// before this execution can succeed and reclaim the shared work directory.
		if (existsSync(dirname(runtimeRoot))) {
			for (const entry of readdirSync(dirname(runtimeRoot), { withFileTypes: true })) {
				if (!entry.isDirectory() || !entry.name.startsWith(`${request.stageId}-`)
					|| !existsSync(`${agentSessionPath(recordRoot, "report_writer", entry.name)}.sessions.json`)) continue;
				const previousRuntime = join(dirname(runtimeRoot), entry.name);
				const previousRootSession = listFilesRecursive(join(previousRuntime, "session"), { absolute: true })
					.find((path) => path.endsWith(".jsonl"));
				preserveWriterTrace(previousRootSession, previousRuntime, recordRoot, entry.name, false);
			}
		}
		const agentRoot = join(request.workDirectory, "agent");
		const inputRoot = join(agentRoot, "inputs");
		mkdirSync(agentRoot, { recursive: true });
		const completedSections = reuseCompletedSections(agentRoot);
		mkdirSync(runtimeRoot, { recursive: true });
		mkdirSync(inputRoot, { recursive: true });
		cpSync(realpathSync(input.hostPath), inputRoot, { recursive: true });
		if (mode === "findout") {
			rmSync(join(inputRoot, "findout", "notes"), { recursive: true, force: true });
			writeFileSync(join(inputRoot, "findout", "index.json"), `${JSON.stringify({
				schema_version: 2,
				knowledge_interface: "notes_report",
				note_count: noteWorkspace!.size,
			}, null, 2)}\n`);
		}
		const configuredSkillPaths = bundledAgentSkillPaths("research",
			mode === "findout" ? "find-out-report-writer" : "report-writer");
		const configuredSkillNames = configuredSkillPaths.map((path) => basename(path));
		const stagedSkills = materializeSkills(
			snapshotSkills(configuredSkillPaths),
			join(runtimeRoot, "skills"),
		);
		const stagedSkillPaths = configuredSkillNames.map((name) => stagedSkills.get(name)!);
		const useChineseLint = reportWriterUsesChineseLint(input.hostPath);
		const goalSkillRoot = request.readonlyMounts.find((mount) => mount.guestPath === "/workspace/skills")?.hostPath;
		const goalSkillDirectories = goalSkillRoot && existsSync(goalSkillRoot)
			? readdirSync(goalSkillRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && existsSync(join(goalSkillRoot, entry.name, "SKILL.md")))
				.map((entry) => join(goalSkillRoot, entry.name))
			: [];
		const goalPythonPaths = (await Promise.all(goalSkillDirectories.map((skill) =>
			preparePythonSkillEnvironment(skill, { dataDir: resolveDataDir(), env })))).flatMap((prepared) => prepared?.pythonPaths ?? []);
		writeFileSync(join(runtimeRoot, "system-prompt.md"), request.systemPrompt);
		writeFileSync(join(runtimeRoot, "initial-prompt.md"), [
			request.userPrompt.replaceAll("{{CHILD_MODEL}}", `${childProvider}/${childModel}`),
			...(completedSections.length > 0 ? [primeWriterResumeContextPrompt(completedSections)] : []),
		].join("\n\n"));
		const delegationPrompt = mode === "findout"
			? findOutSelfDirectedDelegationPrompt(`${childProvider}/${childModel}`)
			: wikiSelfDirectedDelegationPrompt(`${childProvider}/${childModel}`);
		writeFileSync(join(runtimeRoot, "delegation-prompt.md"), [
			delegationPrompt,
			...(completedSections.length > 0 ? [primeWriterCompletedSectionsPrompt(completedSections)] : []),
		].join("\n\n"));
		writeFileSync(join(runtimeRoot, "final-prompt.md"), primeWriterFinalPrompt(mode, useChineseLint));
		writeFileSync(join(runtimeRoot, "final-repair-prompt.md"), primeWriterFinalRepairPrompt(mode));
		const stagedWorker = stagePrimeReportWriterWorker(runtimeRoot);

		const tracePath = agentSessionPath(recordRoot, "report_writer", executionId);
		writeWriterSessionIndex(tracePath, [
			{ path: relative(recordRoot, join(runtimeRoot, "session")), label: "Reporter" },
			{ path: relative(recordRoot, join(runtimeRoot, "session-artifacts")), label: "Section" },
		]);
		appendRuntimeContext(recordRoot, recordKind, {
			type: "runtime.agent_bound",
			stage_id: request.stageId,
			execution_id: executionId,
			attempt: request.attempt ?? 1,
			agent: "report_writer",
			session_id: `prime:${request.runId}:${request.stageId}`,
			session_file: basename(tracePath),
			session_mode: "fresh",
			message_count_before: 0,
			model: `${rootProvider}/${rootModel}`,
			execution_profile: "prime_ipython",
		});
		try {
			const bridge = mode === "wiki"
				? await startWikiBridge(tools, request.signal, join(runtimeRoot, "wiki-tools.jsonl"))
				: await startNoteBridge(noteWorkspace!, request.signal, join(runtimeRoot, "note-tools.jsonl"));
			try {
				request.onActivity?.({
					stageId: request.stageId,
					attemptId: request.attemptId,
					role: request.role,
					status: "running",
					kind: "status",
					text: `Prime Agent ${rootModel} planning with ${childModel} Section children`,
				});
				let validationQueue = Promise.resolve();
				try {
					outcome = await spawnPrimeWorker({
						name: "Prime Report Writer",
						worker: stagedWorker,
						agentRoot,
						runtimeRoot,
						readonlyRoots: [inputRoot, ...stagedSkillPaths,
							...(goalSkillRoot ? [goalSkillRoot] : []), ...goalPythonPaths],
						env,
						extraEnv: {
							PRIME_AGENT_REPORT_CWD: agentRoot,
							PRIME_AGENT_REPORT_RUNTIME: runtimeRoot,
							PRIME_AGENT_REPORT_SKILLS: JSON.stringify([
								...stagedSkillPaths,
								...(goalSkillRoot ? [goalSkillRoot] : []),
							]),
							PRIME_AGENT_REPORT_EXPECTED_SKILLS: JSON.stringify(configuredSkillNames),
							PRIME_AGENT_REPORT_COMPLETED_SECTIONS: JSON.stringify(completedSections),
							PRIME_AGENT_REPORT_ROOT_PROVIDER: rootProvider,
							PRIME_AGENT_REPORT_ROOT_MODEL: rootModel,
							PRIME_AGENT_REPORT_CHILD_PROVIDER: childProvider,
							PRIME_AGENT_REPORT_CHILD_MODEL: childModel,
							PRIME_AGENT_REPORT_THINKING_LEVEL: thinkingLevel,
							PRIME_AGENT_REPORT_KNOWLEDGE_MODE: mode,
							PRIME_AGENT_PATHS_MODULE_PATH: PRIME_AGENT_PATHS_MODULE,
							...(logicalWorkspaceCaptureRoot ? {
								PRIME_AGENT_LOGICAL_WORKSPACE_MODULE_PATH: LOGICAL_WORKSPACE_MODULE,
								PRIME_AGENT_REPORT_LOGICAL_WORKSPACE_ROOT: logicalWorkspaceCaptureRoot,
							} : {}),
							PYTHONPATH: [
								...stagedSkillPaths.map((skill) => join(skill, "src")),
								...goalSkillDirectories.map((skill) => join(skill, "src")),
								...goalPythonPaths,
								env.PYTHONPATH,
							].filter(Boolean).join(":"),
							...(mode === "wiki" ? {
								PRIME_AGENT_REPORT_WIKI_URL: bridge.baseUrl,
								PRIME_AGENT_REPORT_WIKI_TOKEN: bridge.token,
							} : {
								PRIME_AGENT_REPORT_NOTES_URL: bridge.baseUrl,
								PRIME_AGENT_REPORT_NOTES_TOKEN: bridge.token,
							}),
						},
						signal: request.signal,
						onMessage: (message, reply) => {
							if (!isStageOutputCandidate(message)) return;
							validationQueue = validationQueue.then(async () => {
								submissionCount += 1;
								try {
									const outputRoot = join(request.workDirectory, "writer-output");
									const candidateRoot = join(agentRoot, "writer-output");
									const candidateManifest = join(candidateRoot, "manifest.json");
									if (!existsSync(candidateManifest)) {
										throw new Error("writer-output/manifest.json is missing; complete every Section output before submission");
									}
									rmSync(outputRoot, { recursive: true, force: true });
									cpSync(candidateRoot, outputRoot, { recursive: true });
									const authoredOutline = join(agentRoot, "work", "report-outline.json");
									if (!existsSync(authoredOutline)) {
										throw new Error("work/report-outline.json is missing; preserve the complete authored Report Outline");
									}
									copyFileSync(authoredOutline, join(outputRoot, "outline.json"));
									await validateStageOutputCandidate(request, {
										entryPath: join(outputRoot, "manifest.json"),
										outputRoot,
									});
									outputAccepted = true;
									reply({ type: "stage_output_validation", submission: message.submission, accepted: true });
								} catch (error) {
									const validationError = toErrorMessage(error);
									validationErrors.push(validationError);
									appendRuntimeContext(recordRoot, recordKind, {
										type: "runtime.stage_output_rejected",
										stage_id: request.stageId,
										execution_id: executionId,
										submission: submissionCount,
										submission_mode: "prime_file",
										validation_error: validationError,
									});
									reply({
										type: "stage_output_validation",
										submission: message.submission,
										accepted: false,
										error: validationError,
									});
								}
							});
						},
					});
				} finally {
					await validationQueue;
				}
				if (!outputAccepted) throw new Error("Prime Report Writer exited without Runtime validation");
				const authoredOutline = join(agentRoot, "work", "report-outline.json");
				if (!existsSync(authoredOutline)) throw new Error("Prime Report Writer did not preserve its authored Outline");
				copyFileSync(authoredOutline, join(request.workDirectory, "writer-output", "outline.json"));
				await writeProseLintEvidence({
					outputRoot: join(request.workDirectory, "writer-output"),
					runtimeRoot,
					skillPythonPaths: stagedSkillPaths.map((skill) => join(skill, "src")),
					useChineseLint,
					env,
					signal: request.signal,
				});
			} finally {
				await bridge?.close();
			}

			const worker = readWorkerResult(join(runtimeRoot, "result.json"));
			const runtimeMetadata = {
				schema_version: 1,
				contract: primeReportWriterContractIdentity(env, {
					rootModel: worker.root_model,
					childModel: worker.child_model,
					thinkingLevel,
				}),
				root_model: worker.root_model,
				child_model: worker.child_model,
				knowledge: mode === "findout" ? "find-out-notes" : "wiki-tools-only",
				prose_lint: useChineseLint ? "performed"
					: readReportWriterLanguage(input.hostPath) ? "skipped_non_chinese" : "skipped_language_missing",
				prompt_sha256: {
					system: sha256(request.systemPrompt),
					initial: sha256(request.userPrompt),
					delegation: sha256(delegationPrompt),
					final: sha256(primeWriterFinalPrompt(mode, useChineseLint)),
				},
				usage: worker.usage,
				tool_calls: worker.tool_calls,
				...(mode === "wiki" ? { wiki_tool_calls: bridge.calls() } : { note_tool_calls: bridge.calls() }),
			};
			writeFileSync(join(request.workDirectory, "writer-output", "runtime.json"),
				`${JSON.stringify(runtimeMetadata, null, 2)}\n`);
			const finalized = await finalizeStageOutput({
				artifactStore: request.artifactStore,
				output: request.output,
				workDirectory: request.workDirectory,
			});
			const usage = outcome.usage;
			const result: ValidatedStageArtifact<T> = {
				value: finalized.value,
				artifact: finalized.artifact,
				submissionCount,
				validationErrors,
				session: { id: `prime:${request.runId}:${request.stageId}`, mode: "fresh" },
				turns: worker.turns,
				toolCalls: worker.tool_calls,
				toolCounts: { ipython: worker.tool_calls, ...(bridge?.calls() ?? {}) },
				usage,
				sessionPath: worker.session_path,
			};
			appendRuntimeContext(recordRoot, recordKind, {
				type: "runtime.stage_output_accepted",
				stage_id: request.stageId,
				execution_id: executionId,
				submission: submissionCount,
				submission_mode: "prime_file",
				output_source: finalized.source,
				output_ref: finalized.artifact.relativePath,
				output_sha256: finalized.artifact.sha256,
			});
			appendRuntimeContext(recordRoot, recordKind, {
				type: "runtime.prime_report_writer_completed",
				stage_id: request.stageId,
				root_model: worker.root_model,
				child_model: worker.child_model,
				knowledge: mode === "findout" ? "find-out-notes" : "wiki-tools-only",
				output_ref: finalized.artifact.relativePath,
				metrics: worker.usage,
			});
			// Writer 原本不写 Node Execution Record，也不保留自己的 Agent 会话：它的 trace
			// 只存在于未被回收的 Stage 目录里，没有任何东西引用得到。结果是产出报告、耗时
			// 最长的这个 Agent 在 Unified Research Trace 与 Activity 投影里完全缺席。
			// 与 Prime Search 对齐：先把会话另存为可观测证据，再写执行记录，最后回收现场。
			const traceRef = preserveWriterTrace(worker.session_path, runtimeRoot, recordRoot, executionId, request.evaluation !== undefined);
			const finishedAt = new Date().toISOString();
			appendNodeExecutionRecord(recordRoot, request.recordKind ?? "research", {
				node_id: request.stageId,
				node_type: "agent",
				agent: "report_writer",
				execution_id: executionId,
				attempt: request.attempt ?? 1,
				status: "succeeded",
				depends_on: latestNodeDependencyIds(recordRoot, recordKind),
				input: {
					stage_id: request.stageId,
					role: request.role,
					session_policy: "fresh",
					model: `${rootProvider}/${rootModel}`,
					child_model: `${childProvider}/${childModel}`,
					execution_profile: "prime_ipython",
					knowledge: mode === "findout" ? "find-out-notes" : "wiki-tools-only",
				},
				output: {
					artifact_ref: finalized.artifact.relativePath,
					artifact_sha256: finalized.artifact.sha256,
					submission_count: submissionCount,
					validation_errors: validationErrors,
					metrics: {
						turns: worker.turns,
						tool_calls: worker.tool_calls,
						input_tokens: usage.inputTokens,
						output_tokens: usage.outputTokens,
						cost_usd: usage.costUsd,
						model_calls: usage.calls,
					},
				},
				time: {
					started_at: new Date(startedAt).toISOString(),
					finished_at: finishedAt,
					duration_ms: Math.max(0, Date.now() - startedAt),
				},
				trace_ref: basename(tracePath),
			});
			request.onActivity?.({
				stageId: request.stageId,
				attemptId: request.attemptId,
				role: request.role,
				status: "succeeded",
				kind: "status",
				text: `Prime Report Writer completed in ${Math.round((Date.now() - startedAt) / 1000)}s`,
			});
			// 会话已经另存到 Run 根目录，让下游读那一份而不是 Stage 目录里的原件：
			// Stage 目录随后会被回收，而 Node Evaluation Case 要在本方法返回之后才去读
			// sessionPath 生成 agent-trace.jsonl。
			if (traceRef) result.sessionPath = join(recordRoot, traceRef);
			return result;
		} catch (error) {
			const rootSession = listFilesRecursive(join(runtimeRoot, "session"), { absolute: true })
				.find((path) => path.endsWith(".jsonl"));
			preserveWriterTrace(rootSession, runtimeRoot, recordRoot, executionId, false);
			appendNodeExecutionRecord(recordRoot, recordKind, {
				node_id: request.stageId,
				node_type: "agent",
				agent: "report_writer",
				execution_id: executionId,
				attempt: request.attempt ?? 1,
				status: request.signal.aborted ? "cancelled" : "failed",
				depends_on: latestNodeDependencyIds(recordRoot, recordKind),
				input: { stage_id: request.stageId, role: request.role, model: `${rootProvider}/${rootModel}` },
				output: { error: toErrorMessage(error), submission_count: submissionCount, validation_errors: validationErrors },
				time: {
					started_at: new Date(startedAt).toISOString(),
					finished_at: new Date().toISOString(),
					duration_ms: Math.max(0, Date.now() - startedAt),
				},
				trace_ref: basename(tracePath),
			});
			throw error;
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

/** Preserve every depth accepted by unified configuration and the native SDK. */
function reportThinkingLevel(value: ResearchModelPolicy["reasoning"] | string | undefined): ThinkingLevel {
	if (value === undefined) return "off";
	if (!isThinkingLevel(value)) throw new Error(`Unsupported Prime Report Writer thinking level '${value}'`);
	return value;
}

function writeWriterSessionIndex(tracePath: string, sessions: Array<{ path: string; label: string }>): void {
	mkdirSync(dirname(tracePath), { recursive: true });
	writeJsonAtomic(`${tracePath}.sessions.json`, { schemaVersion: 1, sessions });
}

/**
 * 把 Writer 的 Agent 会话另存到 Run 根目录，返回 Node Execution Record 用的 trace_ref。
 *
 * 保存原生 Root Session，保留全部阶段输入和工具调用；生命周期事件不包含完整会话。
 * 在 Stage 目录回收前落到 Run 根目录，与其他 Agent 的会话放在一起。
 */
function preserveWriterTrace(
	sessionPath: string | undefined,
	runtimeRoot: string,
	recordRoot: string,
	executionId: string,
	strict: boolean,
): string | undefined {
	const target = agentSessionPath(recordRoot, "report_writer", executionId);
	const sessions: Array<{ path: string; label: string }> = [];
	try {
		if (sessionPath && existsSync(sessionPath)) {
			copyFileSync(sessionPath, target);
			sessions.push({ path: basename(target), label: "Reporter" });
		} else if (strict) {
			throw new Error("Prime Report Writer evaluation is missing its Root trace");
		}
		const stem = basename(target).replace(/\.jsonl$/u, "");
		let bridgeLogCopied = false;
		for (const name of ["note-tools.jsonl", "wiki-tools.jsonl"]) {
			const path = join(runtimeRoot, name);
			if (existsSync(path)) {
				copyFileSync(path, join(recordRoot, `${stem}-${name}`));
				bridgeLogCopied = true;
			}
		}
		if (strict && !bridgeLogCopied) throw new Error("Prime Report Writer evaluation is missing its Knowledge call log");
		const children = join(runtimeRoot, "session-artifacts");
		const childSessions = listFilesRecursive(children).filter((rel) => rel.endsWith(".jsonl"));
		if (strict && childSessions.length === 0) throw new Error("Prime Report Writer evaluation is missing Section child traces");
		for (const [index, path] of childSessions.entries()) {
			const name = `${stem}-child-${String(index + 1).padStart(2, "0")}.jsonl`;
			copyFileSync(join(children, path), join(recordRoot, name));
			sessions.push({ path: name, label: `Section ${index + 1}` });
		}
		writeWriterSessionIndex(target, sessions);
	} catch (error) {
		if (strict) throw error;
		// Keep the live index if archival fails, so the retained workspace remains inspectable.
	}
	return existsSync(target) ? basename(target) : undefined;
}

function reportWikiTools(tools: readonly AgentTool[]): Map<string, AgentTool> {
	const selected = new Map(tools
		.filter((tool) => ["wiki_search", "wiki_read_page", "wiki_graph_search"].includes(tool.name))
		.map((tool) => [tool.name, tool]));
	for (const name of ["wiki_search", "wiki_read_page", "wiki_graph_search"]) {
		if (!selected.has(name)) throw new Error(`Prime Report Writer requires ${name}`);
	}
	return selected;
}

async function writeProseLintEvidence(input: {
	outputRoot: string;
	runtimeRoot: string;
	skillPythonPaths: string[];
	useChineseLint: boolean;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
}): Promise<void> {
	const reportPath = join(input.outputRoot, "prose-lint.txt");
	if (!input.useChineseLint) {
		writeFileSync(reportPath, "skipped: deterministic prose lint is Chinese-specific\n");
		return;
	}
	const manifest = JSON.parse(readFileSync(join(input.outputRoot, "manifest.json"), "utf-8")) as {
		sections?: Array<{ section_id?: unknown; path?: unknown; title?: unknown }>;
	};
	if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) {
		throw new Error("Prime Report Writer prose lint requires a non-empty manifest");
	}
	const sections = manifest.sections.map((section, index) => {
		if (typeof section.section_id !== "string" || typeof section.path !== "string"
			|| typeof section.title !== "string" || !section.title.trim()
			|| !/^sections\/[A-Za-z0-9._-]+\.md$/u.test(section.path)) {
			throw new Error(`Prime Report Writer prose lint manifest Section ${index + 1} is invalid`);
		}
		const body = readFileSync(join(input.outputRoot, section.path), "utf-8").trim();
		if (!body) throw new Error(`Prime Report Writer prose lint Section '${section.section_id}' is empty`);
		return { title: section.title.trim(), body };
	});
	const lintInput = join(input.runtimeRoot, "prose-lint-input.md");
	writeFileSync(lintInput, renderReportProseLintInput(sections));
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const child = spawn(primeKernelPython(input.env), [
		"-m",
		"writing_skill.external_prose_lint_cli",
		basename(lintInput),
		"--fail-on",
		"never",
	], {
		cwd: input.runtimeRoot,
		env: {
			...input.env,
			PYTHONPATH: [...input.skillPythonPaths, input.env.PYTHONPATH].filter(Boolean).join(":"),
			PYTHONDONTWRITEBYTECODE: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
	const abort = () => child.kill("SIGTERM");
	input.signal.addEventListener("abort", abort, { once: true });
	const exitCode = await new Promise<number>((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolveExit(code ?? 1));
	}).finally(() => input.signal.removeEventListener("abort", abort));
	if (input.signal.aborted) throw new Error("Prime Report Writer prose lint cancelled");
	if (exitCode !== 0) {
		throw new Error(`Prime Report Writer prose lint exited with code ${exitCode}: ${Buffer.concat(stderr).toString("utf-8").trim()}`);
	}
	writeFileSync(reportPath, Buffer.concat(stdout));
}

export function renderReportProseLintInput(sections: readonly { title: string; body: string }[]): string {
	return `${sections.map(({ title, body }) => `## ${title.trim()}\n\n${body.trim()}`).join("\n\n")}\n`;
}

async function startWikiBridge(
	tools: ReadonlyMap<string, AgentTool>,
	signal: AbortSignal,
	logPath: string,
): Promise<AgentToolBridge> {
	return startAgentToolBridge("/v1/wiki", logPath, async (body) => {
		const operation = bridgeString(body.operation, "Wiki operation");
		const toolName = operation === "search" ? "wiki_search"
			: operation === "read_page" ? "wiki_read_page"
				: operation === "graph_search" ? "wiki_graph_search" : "";
		const tool = tools.get(toolName);
		if (!tool) throw new Error(`Unsupported Wiki operation '${operation}'`);
		const args = operation === "read_page"
			? { path: bridgeString(body.path, "Wiki path") }
			: { query: bridgeString(body.query, "Wiki query"), top_k: bridgePositiveInteger(body.top_k, "top_k", 20) };
		const result = await tool.execute(randomUUID(), args, signal);
		return { operation, args, value: result.details
			?? JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}") };
	});
}

async function startNoteBridge(
	workspace: NoteWorkspace,
	signal: AbortSignal,
	logPath: string,
): Promise<AgentToolBridge> {
	return startAgentToolBridge("/v1/notes", logPath, async (body) => {
		signal.throwIfAborted();
		const operation = bridgeString(body.operation, "Note operation") as NoteWorkspaceQuery["operation"];
		const source = body.source === undefined ? undefined : Array.isArray(body.source)
			? body.source.map((value) => bridgeString(value, "Note source"))
			: bridgeString(body.source, "Note source");
		const args: NoteWorkspaceQuery = {
			operation,
			...(body.offset === undefined ? {} : { offset: Number(body.offset) }),
			...(body.limit === undefined ? {} : { limit: Number(body.limit) }),
			...(source === undefined ? {} : { source }),
			...(typeof body.query === "string" ? { query: body.query } : {}),
			...(Array.isArray(body.refs) ? { refs: body.refs.map(String) } : {}),
		};
		return { operation, args, value: workspace.query(args) };
	});
}

/** 一个 Section 完成的信号，和 Worker 等待子 Agent 时用的判据保持一致。 */
const SECTION_OUTPUT_FILES = ["draft.md", "ledger.md"] as const;

/**
 * 保留上一次中断留下的、已完成的 Section 草稿，其余全部丢弃。
 *
 * work/sections/<id>/ 是子 Agent 唯一的产出契约；runtime/ 与 inputs/ 是 Runtime 每次重铺的
 * 输入；writer-output/ 只要还留在这里就说明它没有发布成功，半截的 manifest 会误导 Worker。
 * 只认当前 Outline 里的 Section，避免复用到已经不属于这篇报告的草稿。
 */
export function reuseCompletedSections(workDirectory: string): string[] {
	if (!existsSync(workDirectory)) return [];
	const workRoot = join(workDirectory, "work");
	const sectionsRoot = join(workRoot, "sections");
	const authoredOutlinePath = join(workRoot, "report-outline.json");
	const outline = existsSync(authoredOutlinePath)
		? JSON.parse(readFileSync(authoredOutlinePath, "utf-8")) as { sections?: Array<{ section_id?: unknown }> }
		: { sections: [] };
	const planned = new Set((outline.sections ?? [])
		.map((section) => section.section_id)
		.filter((id): id is string => typeof id === "string"));
	const completed = existsSync(sectionsRoot)
		? readdirSync(sectionsRoot).filter((id) => planned.has(id)
			&& SECTION_OUTPUT_FILES.every((name) => {
				const path = join(sectionsRoot, id, name);
				return existsSync(path) && readFileSync(path, "utf-8").trim().length > 0;
			}))
		: [];
	// 清扫必须无条件执行：中断也可能发生在 Agent 建出 work/sections 之前，
	// 而 runtime/ 与 inputs/ 里有以只读权限落盘的文件，留着会让下一次重铺直接失败。
	for (const entry of readdirSync(workDirectory)) {
		if (entry !== "work") rmSync(join(workDirectory, entry), { recursive: true, force: true });
	}
	for (const entry of existsSync(workRoot) ? readdirSync(workRoot) : []) {
		if (entry !== "sections" && entry !== "report-outline.json") {
			rmSync(join(workRoot, entry), { recursive: true, force: true });
		}
	}
	for (const id of existsSync(sectionsRoot) ? readdirSync(sectionsRoot) : []) {
		if (!completed.includes(id)) rmSync(join(sectionsRoot, id), { recursive: true, force: true });
	}
	return [...completed].sort();
}

function readWorkerResult(path: string): PrimeWorkerResult {
	if (!existsSync(path)) throw new Error("Prime Report Writer did not produce runtime/result.json");
	const value = JSON.parse(readFileSync(path, "utf-8")) as PrimeWorkerResult;
	if (value.schema_version !== 1 || !value.root_model || !value.child_model || !value.session_path) {
		throw new Error("Prime Report Writer produced invalid runtime metadata");
	}
	return value;
}

