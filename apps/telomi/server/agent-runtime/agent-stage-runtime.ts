import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, type Api, type Credential, type Message, type Model } from "@earendil-works/pi-ai";
import {
	AgentSession,
	convertToLlm,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TObject, type TProperties } from "@sinclair/typebox";

import type {
	ReportSandboxRole,
	SandboxExecutionSpec,
	SandboxMountSpec,
	SandboxRole,
	SandboxToolName,
} from "../../../extensions/telomi-srt/sandbox-spec.js";
import { SANDBOX_TOOL_NAMES } from "../../../extensions/telomi-srt/sandbox-spec.js";
import { accountManagerFor } from "../accounts/manager.js";
import { streamWithAccountFallback } from "../accounts/stream-fallback.js";
import { lastAssistantModel, type ModelSwitch } from "../../shared/model-switch.js";
import { modelDefinitionHash } from "./model-policy.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { resolveAgentDir, resolveAgentPath } from "../config/agent-directory.js";
import {
	parseResearchModelRef,
	researchModelCandidates,
	type ResearchModelPolicy,
} from "./models/model-policy.js";
import { classifyResearchError, type ResearchFailureClass } from "./retry-policy.js";
import type { ResearchModelUsage } from "./model-usage.js";
import {
	agentSessionPath,
	appendNodeExecutionRecord,
	appendRuntimeContext,
	latestNodeDependencyIds,
	type RuntimeRecordKind,
	writeAgentSystemPrompt,
} from "../observability/run-records.js";
import { recordCaseCaptureFailure } from "../observability/case-capture.js";
import { sha256 } from "../lib/hash.js";
import {
	RunArtifactStore,
	safeRegularFile,
	type PublishedArtifactDirectoryRef,
	type PublishedArtifactRef,
} from "./artifact-store.js";
import {
	createSrtAgentSandbox,
	type SrtAgentFileToolPolicy,
} from "./srt-agent-sandbox.js";
import {
	loadAgentPromptConfig,
	renderAgentPrompt,
	type PromptDomain,
	type PromptKind,
	type PromptRevisionIdentity,
} from "./prompt-registry.js";
import { composeAgentSystemPrompt } from "./global-system-prompt.js";
import {
	beginNodeEvaluationCase,
	failedNodeEvaluationStatus,
	finishNodeEvaluationCase,
	type EvaluationCaseCapture,
	type NodeEvaluationCaptureSpec,
	type NodeEvaluationCaseDraft,
	type NodeEvaluationInteraction,
} from "./node-evaluation.js";
import { emptyWorkspaceSnapshot, snapshotWorkspaceTree } from "./workspace-snapshot.js";
import { isInsideRoot } from "../lib/paths.js";
import { toErrorMessage } from "../lib/values.js";

export type ResearchAgentStageRole =
	| "cornell_note"
	| "report_writer";

export type AgentStageRole = ResearchAgentStageRole | (string & {});

export type StageArtifactKind =
	| "source_bundle"
	| "cornell_note"
	| "chapter"
	| "writer_chapters"
	| "stage_report"
	| "json_candidate"
	| "route_decision";

export type AgentStageExecutionProfile = "bash_only" | "pi_builtin" | "prime_ipython";

export interface AgentStageActivity {
	stageId: string;
	attemptId: string;
	role: AgentStageRole;
	status: "running" | "succeeded" | "failed" | "cancelled";
	kind: "status" | "text" | "tool";
	text?: string;
	toolName?: string;
}

export function describeModelSwitch(event: ModelSwitch): string {
	return `${event.kind === "account" ? "账号故障转移" : "切换到备用模型"}：${event.from} → ${event.to}（${event.reason}）`;
}

export function sandboxSkillPath(filePath: string, mounts: readonly SandboxMountSpec[]): string | undefined {
	for (const mount of mounts) {
		if (isInsideRoot(mount.hostPath, filePath)) return join(mount.guestPath, relative(mount.hostPath, filePath));
	}
	return undefined;
}

export interface AgentStageRequest<T> {
	runId: string;
	stageId: string;
	attemptId: string;
	/** Ordinal retry number. attemptId is an identity and may contain random digits. */
	attempt?: number;
	role: AgentStageRole;
	promptConfig?: {
		domain: PromptDomain;
		id: string;
		sandboxRole: SandboxRole;
		userVariant?: string;
		revisions?: { system?: PromptRevisionIdentity; user?: PromptRevisionIdentity };
	};
	recordKind?: RuntimeRecordKind;
	/**
	 * Identity of the logical fanout this Stage belongs to, unique within the Run and role
	 * (a Cornell Note batch sequence, for example). Every member of one fanout shares it,
	 * whether it starts with the first wave or after a concurrency slot frees up.
	 */
	parallelGroup?: string;
	evaluation?: NodeEvaluationCaptureSpec;
	session: {
		key: string;
		policy: "fresh" | "continue";
		providerId?: string;
	};
	modelPolicy: ResearchModelPolicy;
	systemPrompt: string;
	userPrompt: string;
	workDirectory: string;
	readonlyMounts: SandboxMountSpec[];
	writableMounts?: SandboxMountSpec[];
	controlDirectory: string;
	recordDirectory?: string;
	artifactStore: RunArtifactStore;
	output: {
		kind: StageArtifactKind;
		maxSubmissions?: number;
		entryRelativePath?: string;
		rootRelativePath?: string;
		guestEntryPath?: string;
		publishRelativePath: string;
		validate(context: {
			entryPath: string;
			outputRoot: string;
			workDirectory: string;
		}): T;
		validateAsync?(value: T): Promise<void>;
		isValidationErrorRepairable?(error: unknown): boolean;
		toolSubmission?: {
			parameters: TObject<TProperties>;
			description: string;
			instructions: string;
			materialize(input: Record<string, unknown>, entryPath: string): void;
		};
	};
	executionProfile?: AgentStageExecutionProfile;
	additionalTools?: readonly AgentTool[];
	fileToolPolicy?: SrtAgentFileToolPolicy;
	onActivity?: (activity: AgentStageActivity) => void;
	sandbox?: {
		executionSpec?: SandboxExecutionSpec;
		env?: Record<string, string>;
	};
	signal: AbortSignal;
}

export interface ValidatedStageArtifact<T> {
	value: T;
	artifact: PublishedArtifactRef | PublishedArtifactDirectoryRef;
	submissionCount: number;
	validationErrors: string[];
	session: {
		id: string;
		file?: string;
		mode: "fresh" | "continued";
	};
	turns: number;
	toolCalls: number;
	toolCounts: Record<string, number>;
	usage: ResearchModelUsage;
	sessionPath: string;
	evaluationCapture?: EvaluationCaseCapture;
}

export async function awaitAuthoritativeStagePrompt(
	prompt: Promise<void>,
	acceptedSignal: Promise<void>,
	abort: () => void,
): Promise<"agent_stop" | "accepted"> {
	const outcome = await Promise.race([
		prompt.then(() => "agent_stop" as const),
		acceptedSignal.then(() => "accepted" as const),
	]);
	if (outcome === "accepted") {
		abort();
		void prompt.catch(() => undefined);
	}
	return outcome;
}

/**
 * Sends the Stage repair prompt. The Agent is often still streaming when Runtime
 * rejects its output, so the repair must be queued as a follow-up instead of
 * failing with "Agent is already processing". A queued prompt resolves as soon as
 * it is queued, so the repair turn only becomes authoritative once the session
 * settles.
 */
export async function awaitStageRepairPrompt(
	session: Pick<AgentSession, "prompt" | "waitForIdle">,
	repairPrompt: string,
	acceptedSignal: Promise<void>,
	abort: () => void,
): Promise<"agent_stop" | "accepted"> {
	return awaitAuthoritativeStagePrompt(
		session
			.prompt(repairPrompt, { expandPromptTemplates: false, streamingBehavior: "followUp" })
			.then(() => session.waitForIdle()),
		acceptedSignal,
		abort,
	);
}

export interface AgentStageRunner {
	runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>>;
}

/** A completed Agent execution that failed before producing an accepted semantic output. */
export class AgentStageExecutionError extends Error {
	constructor(
		message: string,
		readonly failureClass: ResearchFailureClass,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AgentStageExecutionError";
	}
}

/** Runtime-owned Stage setup, filesystem, or Artifact publication failed. */
class AgentStageInfrastructureError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AgentStageInfrastructureError";
	}
}

/**
 * Reuses a validated, immutable Stage Submission after process restart. The
 * delegate still owns every incomplete Agent execution.
 */
export class CheckpointingAgentStageRunner implements AgentStageRunner {
	constructor(private readonly delegate: AgentStageRunner) {}

	async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
		const target = join(request.artifactStore.root, request.output.publishRelativePath);
		if (!existsSync(target)) {
			return this.delegate.runStage(request);
		}
		const definition = stageOutputDefinition(request.output);
		const artifact = definition.root
			? request.artifactStore.describeDirectory(request.output.publishRelativePath)
			: request.artifactStore.describeFile(request.output.publishRelativePath);
		const entryPath = definition.root
			? join(artifact.absolutePath, relative(definition.root, definition.entry))
			: artifact.absolutePath;
		const value = request.output.validate({
			entryPath,
			outputRoot: artifact.absolutePath,
			workDirectory: request.workDirectory,
		});
		await request.output.validateAsync?.(value);
		appendRuntimeContext(
			request.recordDirectory ?? request.controlDirectory,
			request.recordKind ?? "research",
			{
				type: "runtime.stage_checkpoint_reused",
				stage_id: request.stageId,
				execution_id: request.attemptId,
				output_ref: artifact.relativePath,
				output_sha256: artifact.sha256,
			},
		);
		request.onActivity?.({
			stageId: request.stageId,
			attemptId: request.attemptId,
			role: request.role,
			status: "succeeded",
			kind: "status",
			text: "Validated Agent checkpoint reused",
		});
		return {
			value,
			artifact,
			submissionCount: 0,
			validationErrors: [],
			session: { id: `checkpoint:${request.stageId}`, mode: "continued" },
			turns: 0,
			toolCalls: 0,
			toolCounts: {},
			usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
			sessionPath: agentSessionPath(
				request.recordDirectory ?? request.controlDirectory,
				request.role,
				request.attemptId,
			),
		};
	}
}

interface AcceptedSubmission<T> {
	value: T;
	artifact: PublishedArtifactRef | PublishedArtifactDirectoryRef;
}

export interface FinalizedStageOutput<T> extends AcceptedSubmission<T> {
	source: "fixed_output" | "final_text";
}

export async function validateStageOutputCandidate<T>(
	request: Pick<AgentStageRequest<T>, "output" | "workDirectory">,
	location: { entryPath: string; outputRoot: string },
): Promise<T> {
	const value = request.output.validate({
		entryPath: location.entryPath,
		outputRoot: location.outputRoot,
		workDirectory: request.workDirectory,
	});
	await request.output.validateAsync?.(value);
	return value;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

const SubmitStageOutputSchema = Type.Object({}, { additionalProperties: false });

export async function finalizeStageOutput<T>(request: Pick<
	AgentStageRequest<T>,
	"artifactStore" | "output" | "workDirectory"
> & {
	finalText?: string;
}): Promise<FinalizedStageOutput<T>> {
	const outputLocation = fixedOutputLocation(request.output, request.workDirectory);
	let source: FinalizedStageOutput<T>["source"] = "fixed_output";
	const validate = () => validateStageOutputCandidate(request, {
		entryPath: outputLocation.hostEntryPath,
		outputRoot: outputLocation.hostOutputRoot,
	});
	let value: T;
	if (!existsSync(outputLocation.hostEntryPath)) {
		if (!request.finalText) {
			value = await validate();
		} else if (outputLocation.directory) {
			throw new Error("Directory Stage output must be written to its fixed output directory");
		} else {
			assertStageEntryInsideWorkDirectory(request.workDirectory, outputLocation.hostEntryPath);
			mkdirSync(dirname(outputLocation.hostEntryPath), { recursive: true });
			writeFileSync(outputLocation.hostEntryPath, request.finalText, { encoding: "utf-8", flag: "wx" });
			source = "final_text";
			value = await validate();
		}
	} else {
		try {
			value = await validate();
		} catch (fixedOutputError) {
			if (!request.finalText || outputLocation.directory) throw fixedOutputError;
			assertStageEntryInsideWorkDirectory(request.workDirectory, outputLocation.hostEntryPath);
			const safeEntry = safeRegularFile(outputLocation.hostEntryPath, "Stage output");
			const previous = readFileSync(safeEntry);
			writeFileSync(safeEntry, request.finalText, "utf-8");
			try {
				value = await validate();
				source = "final_text";
			} catch (finalTextError) {
				writeFileSync(safeEntry, previous);
				throw finalTextError;
			}
		}
	}
	let artifact: PublishedArtifactRef | PublishedArtifactDirectoryRef;
	try {
		artifact = outputLocation.directory
			? request.artifactStore.publishDirectory(
				outputLocation.hostOutputRoot,
				request.output.publishRelativePath,
				request.workDirectory,
			)
			: request.artifactStore.publishFileFromRoot(
				request.workDirectory,
				outputLocation.hostEntryPath,
				request.output.publishRelativePath,
			);
	} catch (error) {
		throw new AgentStageInfrastructureError(
			`Stage Artifact publication failed: ${toErrorMessage(error)}`,
			{ cause: error },
		);
	}
	return { value, artifact, source };
}

export class SrtStageRuntime implements AgentStageRunner {
	async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
		if (request.output.maxSubmissions !== undefined
			&& (!Number.isInteger(request.output.maxSubmissions) || request.output.maxSubmissions < 1)) {
			throw new Error("output.maxSubmissions must be a positive integer");
		}
		const recordDirectory = request.recordDirectory ?? request.controlDirectory;
		const recordKind = request.recordKind ?? "research";
		const evaluationInteractions: NodeEvaluationInteraction[] | undefined = recordKind === "research" && request.evaluation
			? []
			: undefined;
		const additionalTools = evaluationInteractions
			? captureAdditionalTools(request.additionalTools ?? [], evaluationInteractions)
			: request.additionalTools ?? [];
		const nodeStartedAtMs = Date.now();
		const nodeStartedAt = new Date(nodeStartedAtMs).toISOString();
		const ownsNodeRecord = recordKind === "research" || recordKind === "main" || recordKind === "evaluation";
		const nodeGroupId = stageNodeGroupId(request, recordKind);
		const nodeDependencies = ownsNodeRecord
			? latestNodeDependencyIds(recordDirectory, recordKind, { group: nodeGroupId })
			: [];
		mkdirSync(recordDirectory, { recursive: true });
		const outputLocation = fixedOutputLocation(request.output, request.workDirectory);
		const promptIdentity = request.promptConfig ?? defaultResearchPromptConfig(request.role);
		const promptConfig = loadAgentPromptConfig(promptIdentity.domain, promptIdentity.id);
		const promptRevisions = promptIdentity.revisions ?? {};
		const systemKind = promptConfig.prompts.system?.default ? "system" as const
			: promptConfig.prompts["system-append"]?.default ? "system-append" as const
				: undefined;
		if (promptRevisions.system && !systemKind) {
			throw new Error(`Agent '${request.role}' carries a system Prompt revision but declares no default system Prompt`);
		}
		if (systemKind) validateCarriedPromptRevision(promptRevisions.system, promptIdentity, systemKind, "default");
		validateCarriedPromptRevision(promptRevisions.user, promptIdentity, "user", promptIdentity.userVariant ?? "default");
		const requestedPromptSha256 = { system: sha256(request.systemPrompt), user: sha256(request.userPrompt) };
		const sandboxPolicy = promptConfig.sandbox;
		if (!sandboxPolicy) throw new Error(`Agent '${request.role}' is missing sandbox configuration`);
		const expectedRole = promptIdentity.sandboxRole;
		if (sandboxPolicy.role !== expectedRole) {
			throw new Error(`Agent '${request.role}' sandbox role must be '${expectedRole}'`);
		}
		const executionProfile = sandboxPolicy.executionProfile ?? "bash_only";
		if (request.executionProfile && request.executionProfile !== executionProfile) {
			throw new Error(
				`Agent '${request.role}' execution profile '${request.executionProfile}' conflicts with Prompt config '${executionProfile}'`,
			);
		}
		const sandboxToolNames = sandboxPolicy.tools.filter(
			(tool): tool is SandboxToolName => (SANDBOX_TOOL_NAMES as readonly string[]).includes(tool),
		);
		const toolNames = [
			...sandboxToolNames,
			...additionalTools.map((tool) => tool.name),
			"submit_stage_output",
		];
		if (new Set(toolNames).size !== toolNames.length) {
			throw new Error(`Agent stage '${request.stageId}' contains duplicate Tool names`);
		}
		const disallowedTools = toolNames.filter((tool) => !sandboxPolicy.tools.includes(tool));
		if (disallowedTools.length > 0) {
			throw new Error(
				`Agent '${request.role}' Prompt config does not allow Tools: ${disallowedTools.join(", ")}`,
			);
		}
		const sandbox = createSrtAgentSandbox({
			id: `${request.runId}:${request.stageId}:${request.attemptId}`,
			role: expectedRole,
			workDirectory: request.workDirectory,
			readonlyMounts: request.readonlyMounts,
			writableMounts: request.writableMounts ?? [],
			activeTools: sandboxToolNames,
			network: sandboxPolicy.network,
			...(request.sandbox?.executionSpec
				? { executionSpec: request.sandbox.executionSpec }
				: {}),
			...(request.fileToolPolicy ? { fileToolPolicy: request.fileToolPolicy } : {}),
			...(request.sandbox?.env ? { env: request.sandbox.env } : {}),
		});
		// Work directory tree at node entry, before the Agent runs. Research nodes only:
		// they are the ones replayed as Node Evaluation Cases.
		const workspace = recordKind === "research" ? emptyWorkspaceSnapshot() : undefined;
		if (workspace) await snapshotWorkspaceTree(workspace, "input", request.workDirectory);
		const toolSubmission = request.output.toolSubmission;
		const stageInstructions = renderAgentPrompt("main", "stage-runtime", "system", {
			agent_instructions: request.systemPrompt.trim(),
			pi_builtin: executionProfile === "pi_builtin",
			tool_names: toolNames.join(", "),
			custom_submission: Boolean(toolSubmission),
			submission_instructions: toolSubmission?.instructions ?? "",
			output_path: outputLocation.guestEntryPath,
		}).content;
		let submissionCount = 0;
		const validationErrors: string[] = [];
		let fatalValidationError: unknown;
		let accepted: AcceptedSubmission<T> | undefined;
		let agent: Agent | undefined;
		let resolveAcceptedSignal!: () => void;
		const acceptedSignal = new Promise<void>((resolve) => { resolveAcceptedSignal = resolve; });
		let executionId = request.attemptId;
		const acceptStageOutput = async (
			submissionMode: "tool" | "agent_stop",
			finalText?: string,
		): Promise<AcceptedSubmission<T>> => {
			if (request.output.maxSubmissions !== undefined && submissionCount >= request.output.maxSubmissions) {
				throw new Error(`Stage output submission limit reached (${request.output.maxSubmissions})`);
			}
			submissionCount += 1;
			try {
				const finalized = await finalizeStageOutput({
					artifactStore: request.artifactStore,
					output: request.output,
					workDirectory: request.workDirectory,
					...(finalText === undefined ? {} : { finalText }),
				});
				accepted = finalized;
				appendRuntimeContext(recordDirectory, recordKind, {
					type: "runtime.stage_output_accepted",
					stage_id: request.stageId,
					execution_id: executionId,
					submission: submissionCount,
					submission_mode: submissionMode,
					output_source: finalized.source,
					output_ref: finalized.artifact.relativePath,
					output_sha256: finalized.artifact.sha256,
				});
				return finalized;
			} catch (error) {
				const message = toErrorMessage(error);
				validationErrors.push(message);
				if (error instanceof AgentStageInfrastructureError
					|| isNodeIoError(error)
					|| request.output.isValidationErrorRepairable?.(error) === false) {
					fatalValidationError = error;
				}
				appendRuntimeContext(recordDirectory, recordKind, {
					type: "runtime.stage_output_rejected",
					stage_id: request.stageId,
					execution_id: executionId,
					submission: submissionCount,
					submission_mode: submissionMode,
					validation_error: message,
				});
				throw error;
			}
		};
		const submitToolDefinition: AnyToolDefinition = {
			name: "submit_stage_output",
			label: "submit_stage_output",
			description: toolSubmission?.description
				?? renderAgentPrompt("main", "stage-runtime", "tool", {}, "submit-description").content,
			promptSnippet: toolSubmission
				? renderAgentPrompt("main", "stage-runtime", "tool", {}, "submit-custom-snippet").content
				: renderAgentPrompt("main", "stage-runtime", "tool", {}, "submit-snippet").content,
			parameters: toolSubmission?.parameters ?? SubmitStageOutputSchema,
			executionMode: "sequential",
			execute: async (_toolCallId, input: Record<string, unknown>) => {
				if (accepted) {
					return {
						content: [{ type: "text", text: renderAgentPrompt("main", "stage-runtime", "tool", {},
							"submit-already-accepted").content }],
						details: { accepted: true },
						terminate: true,
					};
				}
				if (request.output.maxSubmissions !== undefined && submissionCount >= request.output.maxSubmissions) {
					const message = renderAgentPrompt("main", "stage-runtime", "tool", {
						max_submissions: request.output.maxSubmissions,
					}, "submit-exhausted").content;
					return {
						content: [{ type: "text", text: message }],
						details: { accepted: false, errors: [message] },
						terminate: true,
					};
				}
				try {
					toolSubmission?.materialize(input, outputLocation.hostEntryPath);
					await acceptStageOutput("tool");
					return {
						content: [{ type: "text", text: renderAgentPrompt("main", "stage-runtime", "tool", {},
							"submit-accepted").content }],
						details: { accepted: true },
						terminate: true,
					};
				} catch (error) {
					const message = toErrorMessage(error);
					const repairable = fatalValidationError !== error;
					return {
						content: [{
							type: "text",
							text: renderAgentPrompt("main", "stage-runtime", "tool", {
								validation_error: message,
							}, repairable ? "submit-rejected" : "submit-fatal").content,
						}],
						details: { accepted: false, errors: [message] },
						...(repairable ? {} : { terminate: true }),
					};
				}
			},
		};
		const submitTool = toAgentTool(submitToolDefinition);
		const additionalToolDefinitions = additionalTools.map(toToolDefinition);
		const toolDefinitions = [
			...sandbox.toolDefinitions,
			...additionalToolDefinitions,
			submitToolDefinition,
		];
		const composedSystemPrompt = composeAgentSystemPrompt(stageInstructions, {
			tools: toolDefinitions,
			conciseResponses: request.role !== "report_writer",
		});
		const composedSystemPromptSha256 = sha256(composedSystemPrompt);
		const agentTools = [
			...sandbox.tools,
			...additionalTools,
			submitTool,
		];

		const modelsPath = resolveAgentPath("models.json");
		const connectionEnv = { PI_CODING_AGENT_DIR: resolveAgentDir() };
		const definitions = new Map(researchModelCandidates(request.modelPolicy)
			.map((selector) => [selector, modelDefinitionHash(selector, connectionEnv)]));
		// The default on-create refresh stays offline here; it restores the persisted pi.dev catalog so
		// a model the static table predates still resolves.
		const discoveryRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath,
		});
		const discoveredModel = resolveResearchModel(
			discoveryRuntime,
			request.modelPolicy,
		);
		let modelRuntime: ModelRuntime;
		const accountManager = accountManagerFor(discoveredModel.provider);
		await accountManager.load();
		if (accountManager.hasAnyAccount()) {
			const candidate = accountManager.pickFallbackCandidate(new Set());
			const credentials = new InMemoryCredentialStore();
			if (candidate) {
				await credentials.modify(
					discoveredModel.provider,
					async () => candidate.credentialSnapshot as Credential,
				);
			}
			modelRuntime = await ModelRuntime.create({
				credentials,
				modelsPath,
			});
		} else {
			modelRuntime = await ModelRuntime.create({
				authPath: resolveAgentPath("auth.json"),
				modelsPath,
			});
		}
		const modelRegistry = new ModelRegistry(modelRuntime);
		// The Stage owns fixed selections; only credentials may change between requests.
		const assertConnection = (selected: Model<Api>) => {
			const selector = `${selected.provider}/${selected.id}`;
			if (isProviderCredentialDeleted(selected.provider)) throw new Error("Stage provider credential was deleted");
			if (definitions.get(selector) !== modelDefinitionHash(selector, connectionEnv)) {
				throw new Error("Stage provider connection changed; start a new operation");
			}
		};
		modelRegistry.getApiKeyAndHeaders = async (selected) => {
			assertConnection(selected);
			const live = await ModelRuntime.create({ authPath: resolveAgentPath("auth.json"), modelsPath, refreshOnCreate: false });
			assertConnection(selected);
			const auth = await new ModelRegistry(live).getApiKeyAndHeaders(selected);
			assertConnection(selected);
			return auth;
		};
		const model = resolveResearchModel(modelRuntime, request.modelPolicy);
		const skillMounts = request.readonlyMounts.filter((mount) =>
			mount.guestPath === "/workspace/skills" || mount.guestPath.startsWith("/skills/"));
		const createResourceLoader = async () => {
			const loader = new DefaultResourceLoader({
				cwd: request.workDirectory,
				agentDir: resolveAgentDir(),
				systemPrompt: composedSystemPrompt,
				additionalSkillPaths: skillMounts.map((mount) => mount.hostPath),
				skillsOverride: (current) => ({
					...current,
					skills: current.skills.map((skill) => {
						const filePath = sandboxSkillPath(skill.filePath, skillMounts);
						if (!filePath) return skill;
						return {
							...skill,
							filePath,
							baseDir: dirname(filePath),
						};
					}),
				}),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			return loader;
		};
		// The Activity and the node record carry the model that actually served and every switch the
		// stream layer made to get there; a switch is only ever to an explicitly configured fallback.
		const modelSwitches: ModelSwitch[] = [];
		const onSwitch = (event: ModelSwitch) => {
			modelSwitches.push(event);
			appendRuntimeContext(recordDirectory, recordKind, { type: "runtime.model_switched", stage_id: request.stageId, execution_id: executionId, ...event });
			request.onActivity?.({ stageId: request.stageId, attemptId: request.attemptId, role: request.role, status: "running", kind: "status", text: describeModelSwitch(event) });
		};
		const createAgent = (sessionId: string, initialSystemPrompt: string) => new Agent({
			initialState: {
				systemPrompt: initialSystemPrompt,
				model,
				thinkingLevel: normalizeResearchThinkingLevel(request.modelPolicy.reasoning),
				tools: agentTools,
			},
			convertToLlm: (messages) => convertToLlm(messages) as Message[],
			streamFn: (selectedModel, context, options) => streamWithAccountFallback({
				model: selectedModel,
				context,
				options: {
					...options,
					...(request.modelPolicy.maxTokens === undefined ? {} : { maxTokens: request.modelPolicy.maxTokens }),
					// Native payload hooks run after authorization for every adapter, including Codex.
					onPayload: async (payload, candidate) => {
						const transformed = await options?.onPayload?.(payload, candidate);
						assertConnection(candidate);
						return transformed;
					},
				},
				modelRegistry,
				providerFallbackModels: request.modelPolicy.fallback ?? [],
				onSwitch,
			}),
			maxRetryDelayMs: request.modelPolicy.maxRetryDelayMs,
			toolExecution: "sequential",
			sessionId,
		});
		const createSession = (
			sessionAgent: Agent,
			sessionManager: SessionManager,
			resourceLoader: DefaultResourceLoader,
		) => new AgentSession({
			agent: sessionAgent,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: request.sandbox?.executionSpec?.guestCwd ?? "/work",
			modelRuntime,
			resourceLoader,
			customTools: toolDefinitions,
			initialActiveToolNames: toolNames,
			allowedToolNames: toolNames,
		});

		const guestCwd = request.sandbox?.executionSpec?.guestCwd ?? "/work";
		const promptSessionManager = SessionManager.inMemory(guestCwd);
		const promptResourceLoader = await createResourceLoader();
		const promptAgent = createAgent(promptSessionManager.getSessionId(), composedSystemPrompt);
		const promptSession = createSession(promptAgent, promptSessionManager, promptResourceLoader);
		const systemPrompt = promptSession.systemPrompt;
		promptSession.dispose();

		const sessionResolution = resolveSession(request, recordDirectory);
		executionId = sessionResolution.executionId;

		const sessionManager = SessionManager.open(
			sessionResolution.contextFile,
			sessionResolution.directory,
			guestCwd,
		);
		agent = createAgent(sessionManager.getSessionId(), systemPrompt);
		const resourceLoader = await createResourceLoader();
		const session = createSession(agent, sessionManager, resourceLoader);
		if (session.systemPrompt !== systemPrompt) {
			session.dispose();
			throw new Error(`Agent stage '${request.stageId}' produced a nondeterministic Pi system prompt`);
		}
		const loaded = sessionManager.buildSessionContext();
		const messageCountBefore = loaded.messages.length;
		if (messageCountBefore > 0) agent.state.messages = loaded.messages;
		let evaluationDraft: NodeEvaluationCaseDraft | undefined;
		let evaluationCapture: EvaluationCaseCapture | undefined;
		if (recordKind === "research" && request.evaluation) {
			try {
					evaluationDraft = beginNodeEvaluationCase({
					request,
					recordDirectory,
					promptConfig: { ...promptIdentity, revisions: promptRevisions,
						requestedSha256: requestedPromptSha256, composedSystemSha256: composedSystemPromptSha256 },
					sessionContextFile: sessionResolution.contextFile,
					composedSystemPrompt: systemPrompt,
					actualModel: `${model.provider}/${model.id}`,
				});
			} catch (error) {
				// Candidate Replay Evidence 是 fail-closed 的；正式 Capture 才 fail-open。
				if (request.evaluation.capabilitySnapshotId) throw error;
				evaluationCapture = {
					status: "capture_failed",
					reason: toErrorMessage(error),
				};
			}
		}

		let turns = 0;
		let toolCalls = 0;
		const toolCounts: Record<string, number> = {};
		let liveText = "";
		let lastTextEmissionAt = 0;
		const emitActivity = (
			status: AgentStageActivity["status"],
			kind: AgentStageActivity["kind"],
			detail: Pick<AgentStageActivity, "text" | "toolName"> = {},
		) => request.onActivity?.({
			stageId: request.stageId,
			attemptId: request.attemptId,
			role: request.role,
			status,
			kind,
			...(detail.text ? { text: detail.text } : {}),
			...(detail.toolName ? { toolName: detail.toolName } : {}),
		});
		const systemPromptFile = writeAgentSystemPrompt(
			recordDirectory,
			request.role,
			request.stageId,
			request.attemptId,
			systemPrompt,
		);
		appendRuntimeContext(recordDirectory, recordKind, {
			type: "runtime.agent_bound",
			stage_id: request.stageId,
			execution_id: sessionResolution.executionId,
			attempt: request.attempt ?? 1,
			agent: request.role,
			session_id: sessionManager.getSessionId(),
			session_file: basename(sessionResolution.contextFile),
			system_prompt_file: basename(systemPromptFile),
			session_mode: sessionResolution.mode,
			message_count_before: messageCountBefore,
			model: `${model.provider}/${model.id}`,
			execution_profile: executionProfile,
			prompt: { domain: promptIdentity.domain, id: promptIdentity.id, revisions: promptRevisions,
				requested_sha256: requestedPromptSha256, composed_system_sha256: composedSystemPromptSha256 },
		});
		const recordStageNode = (
			status: "succeeded" | "failed" | "cancelled",
			output: Record<string, unknown>,
		) => {
			if (!ownsNodeRecord) return;
			const finishedAtMs = Date.now();
			appendNodeExecutionRecord(recordDirectory, recordKind, {
				node_id: request.stageId,
				node_type: "agent",
				agent: request.role,
				execution_id: executionId,
				attempt: request.attempt ?? 1,
				status,
				group_id: nodeGroupId,
				depends_on: nodeDependencies,
				input: {
					stage_id: request.stageId,
					role: request.role,
					prompt: {
						domain: promptIdentity.domain,
						id: promptIdentity.id,
						system_prompt_ref: basename(systemPromptFile),
						revisions: promptRevisions,
						requested_sha256: requestedPromptSha256,
						composed_system_sha256: composedSystemPromptSha256,
					},
					session_policy: request.session.policy,
					model: `${model.provider}/${model.id}`,
					input_mounts: [...request.readonlyMounts, ...(request.writableMounts ?? [])].map((mount) => ({
						path: mount.guestPath,
						access: mount.access,
					})),
				},
				output: {
					model: lastAssistantModel(agent.state.messages as ReadonlyArray<{ role?: string; provider?: string; model?: string }>, `${model.provider}/${model.id}`),
					...(modelSwitches.length ? { model_switches: modelSwitches } : {}),
					...output,
					...(evaluationCapture
						? { node_evaluation: evaluationCaptureRecord(evaluationCapture, recordDirectory) }
						: {}),
				},
				time: {
					started_at: nodeStartedAt,
					finished_at: new Date(finishedAtMs).toISOString(),
					duration_ms: Math.max(0, finishedAtMs - nodeStartedAtMs),
				},
				trace_ref: basename(sessionResolution.contextFile),
				...(workspace ? { workspace } : {}),
			});
		};
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "turn_start") {
				turns += 1;
			}
			if (
				event.type === "message_update"
				&& event.assistantMessageEvent.type === "text_delta"
				&& event.assistantMessageEvent.delta
			) {
				liveText = `${liveText}${event.assistantMessageEvent.delta}`.slice(-2_000);
				const now = Date.now();
				if (now - lastTextEmissionAt >= 200) {
					lastTextEmissionAt = now;
					emitActivity("running", "text", { text: liveText });
				}
			}
			if (event.type === "tool_execution_start") {
				toolCalls += 1;
				toolCounts[event.toolName] = (toolCounts[event.toolName] ?? 0) + 1;
				emitActivity("running", "tool", {
					text: liveText,
					toolName: event.toolName,
				});
			}
			if (event.type === "message_end"
				&& event.message.role === "toolResult"
				&& event.message.toolName === "submit_stage_output"
				&& accepted) {
				resolveAcceptedSignal();
			}
		});
		// Report Agent stages are cancellation-bound. Do not add a wall-clock
		// deadline here because legitimate research and generation can run long.
		const onAbort = () => agent!.abort();
		request.signal.addEventListener("abort", onAbort, { once: true });
		try {
			emitActivity("running", "status");
			try {
				await awaitAuthoritativeStagePrompt(
					session.prompt(request.userPrompt, { expandPromptTemplates: false }),
					acceptedSignal,
					() => agent!.abort(),
				);
			} catch (error) {
				if (fatalValidationError) throw fatalValidationError;
				if (!accepted && !request.signal.aborted) throw error;
			}
			if (request.signal.aborted) throw new Error(`Agent stage '${request.stageId}' cancelled`);
			if (fatalValidationError) throw fatalValidationError;
			let runMessages = agent.state.messages.slice(messageCountBefore);
			let stageOutput = accepted;
			if (!stageOutput) {
				let initialValidationError: unknown;
				if (toolSubmission && submissionCount === 0) {
					initialValidationError = new Error("Stage output must be submitted with submit_stage_output");
				} else if (submissionCount > 0) {
					initialValidationError = new Error(validationErrors.at(-1) ?? "Stage output was rejected");
				} else {
					try {
						stageOutput = await acceptStageOutput("agent_stop", extractFinalAssistantText(runMessages));
					} catch (error) {
						initialValidationError = error;
					}
				}
				if (initialValidationError
					&& request.output.maxSubmissions !== undefined
					&& submissionCount >= request.output.maxSubmissions) {
					throw new Error(
						`Agent stage '${request.stageId}' exhausted ${request.output.maxSubmissions} Stage output submissions: ${validationErrors.at(-1) ?? "Stage output was rejected"}`,
					);
				}
				if (initialValidationError) {
					const initialMessage = initialValidationError instanceof Error
						? initialValidationError.message
						: String(initialValidationError);
					const submissionCountBeforeRepair = submissionCount;
					try {
						await awaitStageRepairPrompt(session, renderAgentPrompt("main", "stage-runtime", "user", {
							tool_submission: Boolean(toolSubmission),
							validation_error: initialMessage,
							tool_submission_instructions: toolSubmission?.instructions ?? "",
							output_path: outputLocation.guestEntryPath,
						}, "repair").content, acceptedSignal, () => agent!.abort());
					} catch (error) {
						if (!accepted && !request.signal.aborted) throw error;
					}
					if (request.signal.aborted) throw new Error(`Agent stage '${request.stageId}' cancelled`);
					runMessages = agent.state.messages.slice(messageCountBefore);
					stageOutput = accepted;
					if (!stageOutput) {
						if (submissionCount > submissionCountBeforeRepair) {
							throw new Error(
								`Agent stage '${request.stageId}' ended without valid Stage output after one repair turn: ${validationErrors.at(-1) ?? "Stage output was rejected"}`,
							);
						}
						if (toolSubmission) {
							throw new Error(
								`Agent stage '${request.stageId}' ended without calling submit_stage_output after one repair turn`,
							);
						}
						try {
							stageOutput = await acceptStageOutput(
								"agent_stop",
								extractFinalAssistantText(runMessages),
							);
						} catch (repairValidationError) {
							const message = repairValidationError instanceof Error
								? repairValidationError.message
								: String(repairValidationError);
							throw new Error(
								`Agent stage '${request.stageId}' ended without valid Stage output after one repair turn: ${message}`,
							);
						}
					}
				}
			}
			if (!stageOutput) {
				throw new Error(`Agent stage '${request.stageId}' ended without a valid Stage output`);
			}
			const usage = collectAgentUsage(runMessages);
			const result: ValidatedStageArtifact<T> = {
				value: stageOutput.value,
				artifact: stageOutput.artifact,
				submissionCount,
				validationErrors,
				session: {
					id: sessionManager.getSessionId(),
					...(sessionManager.getSessionFile() ? { file: sessionManager.getSessionFile() } : {}),
					mode: sessionResolution.mode,
				},
				turns,
				toolCalls,
				toolCounts,
				usage,
				sessionPath: sessionResolution.contextFile,
			};
			if (workspace) await snapshotWorkspaceTree(workspace, "output", request.workDirectory);
			if (evaluationDraft) {
				evaluationCapture = finishNodeEvaluationCase(evaluationDraft, {
					status: "succeeded",
					workDirectory: request.workDirectory,
					result,
					validationErrors,
					durationMs: Date.now() - nodeStartedAtMs,
					...(evaluationInteractions ? { interactions: evaluationInteractions } : {}),
					...(workspace ? { workspace } : {}),
				});
				result.evaluationCapture = evaluationCapture;
				if (request.evaluation?.capabilitySnapshotId && evaluationCapture.status !== "captured") {
					throw new Error(`Candidate Replay Evidence is incomplete: ${evaluationCapture.reason}`);
				}
			}
			appendRuntimeContext(recordDirectory, recordKind, {
				type: "runtime.stage_completed",
				stage_id: request.stageId,
				execution_id: executionId,
				session_file: basename(sessionResolution.contextFile),
				output_ref: stageOutput.artifact.relativePath,
				metrics: {
					turns,
					tool_calls: toolCalls,
					tool_counts: toolCounts,
					input_tokens: usage.inputTokens,
					output_tokens: usage.outputTokens,
					cost_usd: usage.costUsd,
					model_calls: usage.calls,
				},
			});
			recordStageNode("succeeded", {
				artifact_ref: stageOutput.artifact.relativePath,
				artifact_sha256: stageOutput.artifact.sha256,
				submission_count: submissionCount,
				validation_errors: validationErrors,
				metrics: {
					turns,
					tool_calls: toolCalls,
					tool_counts: toolCounts,
					input_tokens: usage.inputTokens,
					output_tokens: usage.outputTokens,
					cost_usd: usage.costUsd,
					model_calls: usage.calls,
				},
			});
			const submittedOutput = activityOutputPreview(stageOutput.value);
			emitActivity("succeeded", submittedOutput ? "text" : "status", {
				text: submittedOutput || liveText || extractFinalAssistantText(runMessages),
			});
			return result;
		} catch (error) {
			const failureClass = request.signal.aborted ? "cancelled" : classifyResearchError(error);
			const usage = collectAgentUsage(agent.state.messages.slice(messageCountBefore));
			if (workspace) await snapshotWorkspaceTree(workspace, "output", request.workDirectory);
			if (evaluationDraft) {
				// 任何终态失败都尝试留成 Recovery Case，不按失败分类丢弃证据。Capture 依旧
				// fail-open：写不出来只记录健康度（见 evaluationCaptureRecord），产品失败
				// 路径不变，原始错误照常抛给调用方。
				evaluationCapture = finishNodeEvaluationCase(evaluationDraft, {
					status: failedNodeEvaluationStatus(failureClass),
					workDirectory: request.workDirectory,
					validationErrors,
					durationMs: Date.now() - nodeStartedAtMs,
					error: toErrorMessage(error),
					...(evaluationInteractions ? { interactions: evaluationInteractions } : {}),
					...(workspace ? { workspace } : {}),
				});
			}
			emitActivity(request.signal.aborted ? "cancelled" : "failed", "status", {
				text: liveText || (toErrorMessage(error)),
			});
			const metrics = {
				input_tokens: usage.inputTokens,
				output_tokens: usage.outputTokens,
				cost_usd: usage.costUsd,
				model_calls: usage.calls,
			};
			appendRuntimeContext(recordDirectory, recordKind, {
				type: request.signal.aborted ? "runtime.stage_cancelled" : "runtime.stage_failed",
				stage_id: request.stageId,
				execution_id: executionId,
				session_file: basename(sessionResolution.contextFile),
				failure_class: failureClass,
				error: toErrorMessage(error),
				metrics,
			});
			recordStageNode(request.signal.aborted ? "cancelled" : "failed", {
				submission_count: submissionCount,
				validation_errors: validationErrors,
				error: toErrorMessage(error),
				metrics,
			});
			if (error instanceof AgentStageInfrastructureError || isNodeIoError(error)) throw error;
			throw error instanceof AgentStageExecutionError
				? error
				: new AgentStageExecutionError(
					toErrorMessage(error),
					failureClass,
					{ cause: error },
				);
		} finally {
			request.signal.removeEventListener("abort", onAbort);
			unsubscribe();
			session.dispose();
			await sandbox.close();
		}
	}
}

function isNodeIoError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error
		&& typeof (error as NodeJS.ErrnoException).code === "string"
		&& ("path" in error || "syscall" in error);
}

function extractFinalAssistantText(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as {
			role?: string;
			stopReason?: string;
			content?: unknown;
		};
		if (message.role !== "assistant" || message.stopReason !== "stop") continue;
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content
					.filter((part): part is { type: "text"; text: string } =>
						Boolean(part)
						&& typeof part === "object"
						&& (part as { type?: unknown }).type === "text"
						&& typeof (part as { text?: unknown }).text === "string")
					.map((part) => part.text)
					.join("\n")
				: "";
		if (text) return text;
	}
	return undefined;
}

function activityOutputPreview(value: unknown): string | undefined {
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
		return text?.trim().slice(0, 2_000) || undefined;
	} catch {
		return undefined;
	}
}

function toAgentTool(definition: AnyToolDefinition): AgentTool {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, undefined as never),
	};
}

function captureAdditionalTools(
	tools: readonly AgentTool[],
	interactions: NodeEvaluationInteraction[],
): AgentTool[] {
	return tools.map((tool) => ({
		...tool,
		execute: async (toolCallId, args, signal, onUpdate) => {
			const result = await tool.execute(toolCallId, args, signal, onUpdate);
			try {
				interactions.push({
					kind: "tool",
					name: tool.name,
					label: tool.label,
					description: tool.description,
					arguments: jsonValue(args),
					result: jsonValue(result),
				});
			} catch {
				// Evaluation capture must never turn a successful production Tool call into a failure.
			}
			return result;
		},
	}));
}

function jsonValue(value: unknown): unknown {
	if (value === undefined) return null;
	return JSON.parse(JSON.stringify(value)) as unknown;
}

function toToolDefinition(tool: AgentTool): AnyToolDefinition {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		promptSnippet: tool.description.replace(/\s+/gu, " ").trim().slice(0, 240),
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params, signal, onUpdate),
	};
}

function fixedOutputLocation(
	output: AgentStageRequest<unknown>["output"],
	workDirectory: string,
): {
	guestEntryPath: string;
	hostEntryPath: string;
	hostOutputRoot: string;
	directory: boolean;
} {
	const definition = stageOutputDefinition(output);
	const hostEntryPath = resolve(workDirectory, definition.entry);
	const hostOutputRoot = resolve(workDirectory, definition.root ?? definition.entry);
	return {
		guestEntryPath: output.guestEntryPath ?? `/work/${definition.entry}`,
		hostEntryPath,
		hostOutputRoot,
		directory: Boolean(definition.root),
	};
}

function stageOutputDefinition(
	output: AgentStageRequest<unknown>["output"],
): { entry: string; root?: string } {
	const definitions: Record<StageArtifactKind, { entry: string; root?: string }> = {
		source_bundle: { entry: "source-bundle/result.json", root: "source-bundle" },
		cornell_note: { entry: "cornell-note.json" },
		chapter: { entry: "chapter.md" },
		writer_chapters: { entry: "writer-output/manifest.json", root: "writer-output" },
		stage_report: { entry: "stage-report.md" },
		json_candidate: { entry: "candidate.json" },
		route_decision: { entry: "route-decision.json" },
	};
	return {
		entry: output.entryRelativePath ?? definitions[output.kind].entry,
		root: output.rootRelativePath ?? definitions[output.kind].root,
	};
}

function assertStageEntryInsideWorkDirectory(workDirectory: string, entryPath: string): void {
	if (resolve(entryPath) === resolve(workDirectory) || !isInsideRoot(workDirectory, entryPath)) {
		throw new Error("Stage output entry escapes its Worker Workspace");
	}
}

function reportSandboxRole(role: ResearchAgentStageRole): ReportSandboxRole {
	const roles: Record<ResearchAgentStageRole, ReportSandboxRole> = {
		cornell_note: "report.cornell_note",
		report_writer: "report.report_writer",
	};
	return roles[role];
}

function researchPromptId(role: ResearchAgentStageRole): string {
	const ids: Record<ResearchAgentStageRole, string> = {
		cornell_note: "cornell-note",
		report_writer: "report-writer",
	};
	return ids[role];
}

function defaultResearchPromptConfig(role: AgentStageRole): NonNullable<AgentStageRequest<unknown>["promptConfig"]> {
	if (!isResearchAgentStageRole(role)) {
		throw new Error(`Agent stage role '${role}' requires an explicit Prompt config`);
	}
	return {
		domain: "research",
		id: researchPromptId(role),
		sandboxRole: reportSandboxRole(role),
	};
}

function validateCarriedPromptRevision(
	revision: PromptRevisionIdentity | undefined,
	prompt: Pick<NonNullable<AgentStageRequest<unknown>["promptConfig"]>, "domain" | "id">,
	kind: PromptKind,
	variant: string,
): void {
	if (!revision) return;
	if (revision.domain !== prompt.domain || revision.id !== prompt.id
		|| revision.kind !== kind || revision.variant !== variant) {
		throw new Error(`Agent Prompt revision '${revision.revisionId}' does not match '${prompt.domain}/${prompt.id}/${kind}:${variant}'`);
	}
}

function isResearchAgentStageRole(role: AgentStageRole): role is ResearchAgentStageRole {
	return [
		"cornell_note",
		"report_writer",
	].includes(role);
}

function resolveSession<T>(
	request: AgentStageRequest<T>,
	recordDirectory: string,
): {
	directory: string;
	contextFile: string;
	executionId: string;
	mode: "fresh" | "continued";
} {
	const executionId = request.session.policy === "continue"
		? `${request.stageId}-${request.attemptId}`
		: `${request.session.key}-${request.attemptId}`;
	const contextFile = agentSessionPath(
		recordDirectory,
		request.role,
		request.session.policy === "continue" ? request.session.key : executionId,
	);
	const continued = request.session.policy === "continue" && existsSync(contextFile);
	return {
		directory: recordDirectory,
		contextFile,
		executionId,
		mode: continued ? "continued" : "fresh",
	};
}

/**
 * Node Execution Record group for one logical fanout. Callers own the fanout identity;
 * deriving it from the records present when a Stage starts would split one fanout into
 * one group per start wave.
 */
export function stageNodeGroupId(
	request: Pick<AgentStageRequest<unknown>, "runId" | "role" | "parallelGroup">,
	recordKind: RuntimeRecordKind,
): string | null {
	return recordKind === "research" && request.parallelGroup
		? `${request.runId}:${request.role}:${request.parallelGroup}`
		: null;
}

function evaluationCaptureRecord(
	capture: EvaluationCaseCapture,
	recordDirectory: string,
): Record<string, unknown> {
	// fail-open：Stage 结果已经落盘，Capture 失败只写运行记录和 Operations Status。
	if (capture.status === "capture_failed") recordCaseCaptureFailure("research-stage", capture.reason);
	if (capture.status !== "captured") return capture;
	return {
		status: capture.status,
		case_id: capture.caseId,
		case_ref: relative(recordDirectory, capture.casePath).split(sep).join("/"),
	};
}

function resolveResearchModel(runtime: ModelRuntime, policy: ResearchModelPolicy): Model<Api> {
	const loadError = runtime.getError();
	if (loadError) throw new Error(`Research Agent model registry failed to load: ${loadError}`);
	for (const ref of researchModelCandidates(policy)) {
		const { provider, modelId } = parseResearchModelRef(ref);
		const model = runtime.getModel(provider, modelId);
		if (model) return model as Model<Api>;
	}
	throw new Error(`Research Agent could not resolve any configured model: ${researchModelCandidates(policy).join(", ")}`);
}

function normalizeResearchThinkingLevel(
	value: ResearchModelPolicy["reasoning"],
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
	return value && ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
		? value as "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
		: "off";
}

function collectAgentUsage(messages: readonly unknown[]): ResearchModelUsage {
	const usage: ResearchModelUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
	for (const message of messages) {
		if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
		const item = message as { usage?: { input?: number; output?: number; cost?: { total?: number } } };
		usage.inputTokens += finite(item.usage?.input);
		usage.outputTokens += finite(item.usage?.output);
		usage.costUsd += finite(item.usage?.cost?.total);
		usage.calls += 1;
	}
	return usage;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
