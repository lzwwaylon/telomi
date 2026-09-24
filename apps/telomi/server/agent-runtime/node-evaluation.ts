import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { sha256, stableJson } from "../lib/hash.js";
import type { PromptRevisionIdentity } from "./prompt-registry.js";
import { agentSessionPath, type WorkspaceSnapshotRecord } from "../observability/run-records.js";
import { PROVIDER_CALLS_FILE, readProviderCallRecords } from "../providers/provider-call-record.js";
import type { ResearchModelPolicy } from "./models/model-policy.js";
import {
	RunArtifactStore,
	type PublishedArtifactDirectoryRef,
	type PublishedArtifactRef,
} from "./artifact-store.js";
import type {
	AgentStageRequest,
	AgentStageRunner,
	StageArtifactKind,
	ValidatedStageArtifact,
} from "./agent-stage-runtime.js";
import { isInsideRoot } from "../lib/paths.js";
import { toErrorMessage } from "../lib/values.js";

const CASE_SCHEMA_VERSION = 1;
const CASES_DIRECTORY = "node-evaluation/cases";

export interface NodeReplayRecipeIdentity {
	id: string;
	version: number;
}

export interface NodeEvaluationCaptureSpec {
	agentId: string;
	recipe: NodeReplayRecipeIdentity;
	recipeInput: unknown;
	capabilitySnapshotId?: string;
	inputRelativePath?: string;
	inputGuestPath?: string;
	harnessMounts: Array<{
		guestPath: string;
		workspaceRelativePath: string;
	}>;
	writableGuestPaths?: string[];
	liveExternalState: boolean;
}

export interface NodeEvaluationCase {
	schemaVersion: 1;
	caseId: string;
	runId: string;
	nodeId: string;
	attemptId: string;
	agentId: string;
	role: string;
	status: "succeeded" | "failed" | "cancelled";
	capturedAt: string;
	recipe: NodeReplayRecipeIdentity;
	recipeInput: unknown;
	input: NodeEvaluationDirectoryRef;
	request: {
		promptConfig: {
			domain: string;
			id: string;
			sandboxRole: string;
			userVariant?: string;
			revisions?: { system?: PromptRevisionIdentity; user?: PromptRevisionIdentity };
			requestedSha256?: { system: string; user: string };
			composedSystemSha256?: string;
		};
		systemPrompt: NodeEvaluationFileRef;
		composedSystemPrompt: NodeEvaluationFileRef;
		userPrompt: NodeEvaluationFileRef;
		session: {
			key: string;
			policy: "fresh" | "continue";
			providerId?: string;
			contextBefore?: NodeEvaluationFileRef;
		};
		modelPolicy?: ResearchModelPolicy;
		actualModel: string;
		interactions?: NodeEvaluationFileRef;
		outputContract: {
			kind: StageArtifactKind;
			publishRelativePath: string;
			entryRelativePath?: string;
			rootRelativePath?: string;
			guestEntryPath?: string;
		};
		executionProfile?: AgentStageRequest<unknown>["executionProfile"];
	};
	mounts: NodeEvaluationMountRef[];
	writableMounts?: Array<{ guestPath: string; initial: NodeEvaluationDirectoryRef }>;
	liveExternalState: boolean;
	/** Capability Snapshot observed by this case, when capture ran from an immutable snapshot. */
	capabilitySnapshotId?: string;
	/** Work directory tree snapshots at node entry and exit; absent for cases captured before snapshots existed. */
	workspace?: WorkspaceSnapshotRecord;
	observed: {
		output?: NodeEvaluationArtifactRef;
		/** Per-session filesystem views captured before each Agent's first turn. */
		logicalWorkspaces?: NodeEvaluationDirectoryRef;
		/** Provider calls this node made, copied from the run's provider-calls.jsonl. */
		providerCalls?: NodeEvaluationFileRef;
		terminalWorkspace?: NodeEvaluationDirectoryRef;
		writableMounts?: Array<{ guestPath: string; final: NodeEvaluationDirectoryRef }>;
		trace?: NodeEvaluationTraceRef;
		traceDirectories?: Array<NodeEvaluationDirectoryRef & { root: "run" | "case" }>;
		durationMs?: number;
		error?: string;
		validationErrors: string[];
		metrics?: {
			inputTokens: number;
			outputTokens: number;
			costUsd: number;
			calls: number;
			turns: number;
			toolCalls: number;
		};
	};
}

export type NodeEvaluationInteraction = {
	kind: "tool";
	name: string;
	label: string;
	description: string;
	arguments: unknown;
	result: unknown;
} | {
	kind: "research_request";
	method: string;
	url: string;
	headers: Array<[string, string]>;
	bodyBase64: string;
	response: {
		status: number;
		headers: Array<[string, string]>;
		bodyBase64: string;
	};
};

export interface NodeEvaluationFileRef {
	ref: string;
	sha256: string;
	byteLength: number;
}

export interface NodeEvaluationTraceRef extends NodeEvaluationFileRef {
	root?: "case" | "run";
}

export interface NodeEvaluationDirectoryRef extends NodeEvaluationFileRef {
	fileCount: number;
	root?: "run" | "case" | "workspace";
}

export interface NodeEvaluationArtifactRef extends NodeEvaluationFileRef {
	directory: boolean;
}

export type NodeEvaluationMountRef = {
	guestPath: string;
	access: "read-only";
} & ({
	kind: "run";
	directory: NodeEvaluationDirectoryRef;
} | {
	kind: "harness";
	workspaceRelativePath: string;
});

export interface NodeEvaluationCaseDraft {
	caseId: string;
	caseDirectory: string;
	manifestPath: string;
	runDirectory: string;
	base: Omit<NodeEvaluationCase, "status" | "capturedAt" | "observed">;
	writableMountSources: Array<{ guestPath: string; hostPath: string }>;
}

export type EvaluationCaseCapture =
	| { status: "captured"; caseId: string; casePath: string }
	| { status: "capture_failed"; reason: string };

export interface NodeReplayResult {
	caseId: string;
	agentId: string;
	artifact: PublishedArtifactRef | PublishedArtifactDirectoryRef;
	usage: ValidatedStageArtifact<unknown>["usage"];
	turns: number;
	toolCalls: number;
}

export interface NodeReplayRecipe {
	identity: NodeReplayRecipeIdentity;
	replay(input: {
		casePath: string;
		value: NodeEvaluationCase;
		sourceRunDirectory: string;
		harnessWorkspaceDirectory: string;
		recordDirectory: string;
		workDirectory: string;
		artifactStore: RunArtifactStore;
		runner: AgentStageRunner;
		candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
		promptOverride?: { systemPrompt?: string; userPrompt?: string };
		signal: AbortSignal;
	}): Promise<NodeReplayResult>;
}

export class NodeEvaluationModule {
	private readonly recipes = new Map<string, NodeReplayRecipe>();

	constructor(recipes: readonly NodeReplayRecipe[]) {
		for (const recipe of recipes) {
			const key = recipeKey(recipe.identity);
			if (this.recipes.has(key)) throw new Error(`Duplicate Node Replay Recipe '${key}'`);
			this.recipes.set(key, recipe);
		}
	}

	async replay(input: {
		casePath: string;
		sourceRunDirectory: string;
		harnessWorkspaceDirectory: string;
		recordDirectory: string;
		workDirectory: string;
		artifactStore: RunArtifactStore;
		runner: AgentStageRunner;
		candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
		promptOverride?: { systemPrompt?: string; userPrompt?: string };
		signal: AbortSignal;
	}): Promise<NodeReplayResult> {
		const value = readNodeEvaluationCase(input.casePath, input.sourceRunDirectory);
		const recipe = this.recipes.get(recipeKey(value.recipe));
		if (!recipe) {
			throw new Error(`Node Replay Recipe '${recipeKey(value.recipe)}' is not registered`);
		}
		return recipe.replay({ ...input, value });
	}
}

export function beginNodeEvaluationCase(input: {
	request: AgentStageRequest<unknown>;
	recordDirectory: string;
	promptConfig: {
		domain: string;
		id: string;
		sandboxRole: string;
		userVariant?: string;
		revisions?: { system?: PromptRevisionIdentity; user?: PromptRevisionIdentity };
		requestedSha256?: { system: string; user: string };
		composedSystemSha256?: string;
	};
	sessionContextFile: string;
	composedSystemPrompt: string;
	actualModel: string;
	capabilitySnapshotId?: string;
}): NodeEvaluationCaseDraft | undefined {
	const spec = input.request.evaluation;
	if (!spec) return undefined;
	const capabilitySnapshotId = input.capabilitySnapshotId ?? spec.capabilitySnapshotId;
	const harnessBindings = new Map(
		spec.harnessMounts.map((mount) => [mount.guestPath, mount.workspaceRelativePath]),
	);
	const sourceInputPath = spec.inputRelativePath
		? new RunArtifactStore(input.recordDirectory).describeDirectory(spec.inputRelativePath).absolutePath
		: input.request.readonlyMounts.find((mount) => mount.guestPath === spec.inputGuestPath)?.hostPath;
	const sourceInput = sourceInputPath ? describeExternalDirectory(sourceInputPath) : undefined;
	const caseId = sha256(stableJson({
		schemaVersion: CASE_SCHEMA_VERSION,
		runId: input.request.runId,
		nodeId: input.request.stageId,
		attemptId: input.request.attemptId,
		agentId: spec.agentId,
		recipe: spec.recipe,
		inputSha256: sourceInput?.sha256 ?? sha256(input.request.userPrompt),
		modelPolicy: input.request.modelPolicy,
		promptConfig: input.promptConfig,
	})).slice(0, 32);
	const caseDirectory = join(input.recordDirectory, CASES_DIRECTORY, caseId);
	if (existsSync(caseDirectory)) {
		throw new Error(`Node Evaluation Case already exists: ${caseId}`);
	}
	mkdirSync(caseDirectory, { recursive: true });
	const emptyInput = join(caseDirectory, ".empty-input");
	if (!sourceInput) mkdirSync(emptyInput, { recursive: true });
	const inputSnapshot = new RunArtifactStore(caseDirectory).publishDirectory(
		sourceInput?.absolutePath ?? emptyInput,
		"input",
		sourceInput?.absolutePath ?? emptyInput,
	);
	if (!sourceInput) rmSync(emptyInput, { recursive: true, force: true });
	const inputRef = {
		...directoryRef(inputSnapshot),
		ref: `${CASES_DIRECTORY}/${caseId}/input`,
	};
	const mounts = input.request.readonlyMounts.map((mount, index): NodeEvaluationMountRef => {
		const workspaceRelativePath = harnessBindings.get(mount.guestPath);
		if (workspaceRelativePath) {
			return {
				kind: "harness",
				guestPath: mount.guestPath,
				access: "read-only",
				workspaceRelativePath: safeRelativePath(workspaceRelativePath, "Harness mount"),
			};
		}
		if (sourceInput && realpathSync(mount.hostPath) === sourceInput.absolutePath) {
			return {
				kind: "run",
				guestPath: mount.guestPath,
				access: "read-only",
				directory: inputRef,
			};
		}
		const snapshot = new RunArtifactStore(caseDirectory).publishDirectory(
			mount.hostPath,
			`mounts/${index}`,
			mount.hostPath,
		);
		return {
			kind: "run",
			guestPath: mount.guestPath,
			access: "read-only",
			directory: {
				...directoryRef(snapshot),
				ref: `${CASES_DIRECTORY}/${caseId}/mounts/${index}`,
			},
		};
	});
	const writableGuests = new Set(spec.writableGuestPaths ?? []);
	const writableMountSources = (input.request.writableMounts ?? [])
		.filter((mount) => writableGuests.has(mount.guestPath))
		.map((mount) => ({ guestPath: mount.guestPath, hostPath: mount.hostPath }));
	if (writableMountSources.length !== writableGuests.size) {
		throw new Error("Node Evaluation writable mount capture does not match the requested guest paths");
	}
	const writableMounts = writableMountSources.map((mount, index) => ({
		guestPath: mount.guestPath,
		initial: { ...directoryRef(new RunArtifactStore(caseDirectory).publishDirectory(
			mount.hostPath,
			`writable-mounts/${index}/initial`,
			mount.hostPath,
		)), root: "case" as const },
	}));
	const systemPrompt = writeCaseFile(caseDirectory, "system-prompt.txt", input.request.systemPrompt);
	const composedSystemPrompt = writeCaseFile(
		caseDirectory,
		"composed-system-prompt.txt",
		input.composedSystemPrompt,
	);
	const userPrompt = writeCaseFile(caseDirectory, "user-prompt.txt", input.request.userPrompt);
	const contextBefore = existsSync(input.sessionContextFile)
		? writeCaseFile(
				caseDirectory,
				"session-before.jsonl",
				readFileSync(safeRegularFile(input.sessionContextFile, "Agent Session")),
			)
		: undefined;
	return {
		caseId,
		caseDirectory,
		manifestPath: join(caseDirectory, "manifest.json"),
		runDirectory: input.recordDirectory,
		base: {
			schemaVersion: CASE_SCHEMA_VERSION,
			caseId,
			runId: input.request.runId,
			nodeId: input.request.stageId,
			attemptId: input.request.attemptId,
			agentId: spec.agentId,
			role: input.request.role,
			recipe: spec.recipe,
			recipeInput: spec.recipeInput,
			input: inputRef,
			request: {
				promptConfig: input.promptConfig,
				systemPrompt,
				composedSystemPrompt,
				userPrompt,
				session: {
					...input.request.session,
					...(contextBefore ? { contextBefore } : {}),
				},
				modelPolicy: input.request.modelPolicy,
				actualModel: input.actualModel,
				outputContract: {
					kind: input.request.output.kind,
					publishRelativePath: input.request.output.publishRelativePath,
					...(input.request.output.entryRelativePath
						? { entryRelativePath: input.request.output.entryRelativePath }
						: {}),
					...(input.request.output.rootRelativePath
						? { rootRelativePath: input.request.output.rootRelativePath }
						: {}),
					...(input.request.output.guestEntryPath
						? { guestEntryPath: input.request.output.guestEntryPath }
						: {}),
				},
				...(input.request.executionProfile ? { executionProfile: input.request.executionProfile } : {}),
			},
			mounts,
			...(writableMounts.length ? { writableMounts } : {}),
			liveExternalState: spec.liveExternalState,
			...(capabilitySnapshotId ? { capabilitySnapshotId } : {}),
		},
		writableMountSources,
	};
}

export function finishNodeEvaluationCase(
	draft: NodeEvaluationCaseDraft,
	input: {
		status: "succeeded" | "failed" | "cancelled";
		workDirectory: string;
		result?: ValidatedStageArtifact<unknown>;
		/** Session Trace for a failed stage that has no validated result artifact. */
		sessionPath?: string;
		validationErrors: readonly string[];
		error?: string;
		interactions?: readonly NodeEvaluationInteraction[];
		traceDirectories?: readonly string[];
		/** Already-scoped Provider records for a separately captured native child. */
		providerCallsPath?: string;
		logicalWorkspaces?: string;
		durationMs?: number;
		workspace?: WorkspaceSnapshotRecord;
	},
): EvaluationCaseCapture {
	try {
		let output: NodeEvaluationArtifactRef | undefined;
		if (input.result) {
			const caseStore = new RunArtifactStore(draft.caseDirectory);
			const artifact = "files" in input.result.artifact
				? caseStore.publishDirectory(
						input.result.artifact.absolutePath,
						"observed-output",
						input.result.artifact.absolutePath,
					)
				: caseStore.publishFile(input.result.artifact.absolutePath, "observed-output");
			output = {
				ref: artifact.relativePath,
				sha256: artifact.sha256,
				byteLength: artifact.byteLength,
				directory: "files" in artifact,
			};
		}
		// 失败和取消的 Capture 都没有 Observed 输出，终态 Workspace 是它作为
		// Recovery Case 唯一的产物证据，两种终态一视同仁。
		const terminalWorkspace = input.status !== "succeeded" && directoryHasEntries(input.workDirectory)
			? directoryRef(new RunArtifactStore(draft.caseDirectory).publishDirectory(
					input.workDirectory,
					"terminal-workspace",
					input.workDirectory,
				))
			: undefined;
		const logicalWorkspaces = input.logicalWorkspaces && directoryHasEntries(input.logicalWorkspaces)
			? directoryRef(new RunArtifactStore(draft.caseDirectory).publishDirectory(
					input.logicalWorkspaces,
					"logical-workspaces",
					input.logicalWorkspaces,
				))
			: undefined;
		const interactions = input.interactions?.length
			? writeCaseFile(draft.caseDirectory, "interactions.json", `${JSON.stringify(input.interactions, null, 2)}\n`)
			: undefined;
		const writableMounts = draft.writableMountSources.map((mount, index) => ({
			guestPath: mount.guestPath,
			final: { ...directoryRef(new RunArtifactStore(draft.caseDirectory).publishDirectory(
				mount.hostPath,
				`writable-mounts/${index}/final`,
				mount.hostPath,
			)), root: "case" as const },
		}));
		const sessionPath = input.result?.sessionPath ?? input.sessionPath;
		const trace = sessionPath && existsSync(sessionPath)
			? referenceRunFile(draft.runDirectory, sessionPath)
				?? { ...writeCaseFile(draft.caseDirectory, "agent-trace.jsonl", readFileSync(sessionPath)), root: "case" as const }
			: undefined;
		const traceDirectories = input.traceDirectories?.flatMap((path) => {
			const directory = referenceRunDirectory(draft.runDirectory, path);
			return directory ? [directory] : [];
		}) ?? [];
		const providerCallLines = readProviderCallRecords(draft.runDirectory)
			.filter((call) => call.node_id === draft.base.nodeId && call.attempt_id === draft.base.attemptId)
			.map((call) => JSON.stringify(call));
		const providerCalls = input.providerCallsPath
			? writeCaseFile(draft.caseDirectory, PROVIDER_CALLS_FILE, readFileSync(safeRegularFile(input.providerCallsPath, "Provider calls")))
			: providerCallLines.length
			? writeCaseFile(draft.caseDirectory, PROVIDER_CALLS_FILE, `${providerCallLines.join("\n")}\n`)
			: undefined;
		const value: NodeEvaluationCase = {
			...draft.base,
			request: {
				...draft.base.request,
				...(interactions ? { interactions } : {}),
			},
			status: input.status,
			capturedAt: new Date().toISOString(),
			...(input.workspace ? { workspace: input.workspace } : {}),
			observed: {
				...(output ? { output } : {}),
				...(logicalWorkspaces ? { logicalWorkspaces } : {}),
				...(providerCalls ? { providerCalls } : {}),
				...(terminalWorkspace ? { terminalWorkspace } : {}),
				...(writableMounts.length ? { writableMounts } : {}),
				...(trace ? { trace } : {}),
				...(traceDirectories.length ? { traceDirectories } : {}),
				...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
				...(input.error ? { error: input.error } : {}),
				validationErrors: [...input.validationErrors],
				...(input.result ? {
					metrics: {
						inputTokens: input.result.usage.inputTokens,
						outputTokens: input.result.usage.outputTokens,
						costUsd: input.result.usage.costUsd,
						calls: input.result.usage.calls,
						turns: input.result.turns,
						toolCalls: input.result.toolCalls,
					},
				} : {}),
			},
		};
		writeImmutable(draft.manifestPath, `${JSON.stringify(value, null, 2)}\n`);
		return { status: "captured", caseId: draft.caseId, casePath: draft.manifestPath };
	} catch (error) {
		return {
			status: "capture_failed",
			reason: toErrorMessage(error),
		};
	}
}

/**
 * 终态失败分类到 Case 终态的映射（计划 §9.3）。
 *
 * 每一种终态失败 - cancelled、timeout、rate_limit、budget、validation、provider、
 * permanent - 都留成 Recovery Case：冻结输入、终态 Workspace、Trace 和终态错误是
 * 恢复回放唯一的依据。失败分类只决定 Case 的终态字段，不决定要不要留；证据够不够
 * 由 Candidate Replay 入队时的 fail-closed 检查判断，那里才有 Recipe 和输出契约。
 */
export function failedNodeEvaluationStatus(failureClass: string): "failed" | "cancelled" {
	return failureClass === "cancelled" ? "cancelled" : "failed";
}

export function readNodeEvaluationCase(
	casePath: string,
	sourceRunDirectory?: string,
): NodeEvaluationCase {
	const manifestPath = safeRegularFile(casePath, "Node Evaluation Case manifest");
	const value = JSON.parse(readFileSync(manifestPath, "utf-8")) as NodeEvaluationCase;
	if (
		value.schemaVersion !== CASE_SCHEMA_VERSION
		|| !value.caseId
		|| !value.nodeId
		|| !value.agentId
		|| !value.recipe?.id
		|| !Number.isInteger(value.recipe.version)
	) {
		throw new Error(`Invalid Node Evaluation Case: ${manifestPath}`);
	}
	const caseDirectory = dirname(manifestPath);
	assertFileRef(caseDirectory, value.request.systemPrompt);
	assertFileRef(caseDirectory, value.request.composedSystemPrompt);
	assertFileRef(caseDirectory, value.request.userPrompt);
	if (value.request.interactions) assertFileRef(caseDirectory, value.request.interactions);
	if (value.request.session.contextBefore) {
		assertFileRef(caseDirectory, value.request.session.contextBefore);
	}
	assertObservedRef(caseDirectory, value.observed.output);
	if (value.observed.logicalWorkspaces) assertDirectoryRef(caseDirectory, value.observed.logicalWorkspaces);
	if (value.observed.providerCalls) assertFileRef(caseDirectory, value.observed.providerCalls);
	if (value.observed.terminalWorkspace) {
		assertDirectoryRef(caseDirectory, value.observed.terminalWorkspace);
	}
	for (const mount of value.writableMounts ?? []) assertDirectoryRef(caseDirectory, mount.initial);
	for (const mount of value.observed.writableMounts ?? []) assertDirectoryRef(caseDirectory, mount.final);
	const runDirectory = sourceRunDirectory ?? caseRunDirectory(manifestPath);
	if (value.observed.trace) {
		const traceRoot = value.observed.trace.root === "run" ? runDirectory : caseDirectory;
		if (value.observed.trace.root !== "run" || existsSync(resolveCaseRef(traceRoot, value.observed.trace.ref))
			|| !isImportedCaseDirectory(runDirectory)) assertFileRef(traceRoot, value.observed.trace);
	}
	for (const directory of value.observed.traceDirectories ?? []) {
		const traceRoot = directory.root === "run" ? runDirectory : caseDirectory;
		if (directory.root !== "run" || existsSync(resolveCaseRef(traceRoot, directory.ref))
			|| !isImportedCaseDirectory(runDirectory)) assertDirectoryRef(traceRoot, directory);
	}
	assertDirectoryRef(value.input.root === "case" ? caseDirectory : runDirectory, value.input);
	for (const mount of value.mounts) {
		if (mount.kind === "run") assertDirectoryRef(runDirectory, mount.directory);
	}
	return value;
}

export function findNodeEvaluationCases(
	runDirectory: string,
	agentId?: string,
): Array<{ path: string; value: NodeEvaluationCase }> {
	const root = join(runDirectory, CASES_DIRECTORY);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name, "manifest.json"))
		.filter(existsSync)
		.map((path) => ({ path, value: readNodeEvaluationCase(path, runDirectory) }))
		.filter(({ value }) => !agentId || value.agentId === agentId)
		.sort((left, right) => left.value.capturedAt.localeCompare(right.value.capturedAt));
}

/**
 * 冻结交互的取用账本：同名同参的调用按记录顺序各用一次。
 *
 * ponytail: exact fixture matching keeps external state frozen; capture a new Case when a
 * Candidate intentionally adds calls.
 */
export function frozenInteractionLedger(
	interactions: readonly NodeEvaluationInteraction[],
): (name: string, args: unknown) => unknown {
	const used = new Set<number>();
	return (name, args) => {
		const index = interactions.findIndex((item, candidate) => !used.has(candidate)
			&& item.kind === "tool"
			&& item.name === name
			&& stableJson(item.arguments) === stableJson(args));
		if (index < 0) throw new Error(`No frozen Tool interaction matches '${name}'`);
		used.add(index);
		const interaction = interactions[index]!;
		if (interaction.kind !== "tool") throw new Error("Frozen Tool interaction changed kind");
		return interaction.result;
	};
}

export function readNodeEvaluationFile(
	casePath: string,
	ref: NodeEvaluationFileRef,
): string {
	const root = dirname(safeRegularFile(casePath, "Node Evaluation Case manifest"));
	assertFileRef(root, ref);
	return readFileSync(resolveCaseRef(root, ref.ref), "utf-8");
}

export function restoreNodeEvaluationSession(
	casePath: string,
	value: NodeEvaluationCase,
	recordDirectory: string,
): void {
	const contextBefore = value.request.session.contextBefore;
	if (!contextBefore) return;
	const source = resolveCaseRef(dirname(casePath), contextBefore.ref);
	assertFileRef(dirname(casePath), contextBefore);
	const destination = agentSessionPath(
		recordDirectory,
		value.role,
		value.request.session.policy === "continue"
			? value.request.session.key
			: `${value.request.session.key}-${value.attemptId}`,
	);
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(source, destination);
}

export function resolveNodeEvaluationMounts(
	casePath: string,
	value: NodeEvaluationCase,
	sourceRunDirectory: string,
	harnessWorkspaceDirectory: string,
): Array<{ hostPath: string; guestPath: string; access: "read-only" }> {
	readNodeEvaluationCase(casePath, sourceRunDirectory);
	return value.mounts.map((mount) => ({
		guestPath: mount.guestPath,
		access: "read-only" as const,
		hostPath: mount.kind === "harness"
			? resolveSafeRelative(harnessWorkspaceDirectory, mount.workspaceRelativePath, "Harness mount")
			: resolveRunRef(sourceRunDirectory, mount.directory.ref),
	}));
}

function assertObservedRef(root: string, ref: NodeEvaluationArtifactRef | undefined): void {
	if (!ref) return;
	const store = new RunArtifactStore(root);
	const artifact = ref.directory ? store.openDirectory({
		relative_path: ref.ref, sha256: ref.sha256, byte_length: ref.byteLength,
	}) : store.describeFile(ref.ref);
	assertArtifact(artifact, ref);
}

function assertDirectoryRef(root: string, ref: NodeEvaluationDirectoryRef): void {
	const artifact = new RunArtifactStore(root).openDirectory({
		relative_path: ref.ref, sha256: ref.sha256, byte_length: ref.byteLength,
	});
	if (artifact.files.length !== ref.fileCount) {
		throw new Error(`Node Evaluation directory file count changed: ${ref.ref}`);
	}
}

function assertFileRef(root: string, ref: NodeEvaluationFileRef): void {
	const path = resolveCaseRef(root, ref.ref);
	const content = readFileSync(safeRegularFile(path, "Node Evaluation file"));
	if (sha256(content) !== ref.sha256 || content.byteLength !== ref.byteLength) {
		throw new Error(`Node Evaluation file changed: ${ref.ref}`);
	}
}

function assertArtifact(
	artifact: PublishedArtifactRef | PublishedArtifactDirectoryRef,
	ref: NodeEvaluationFileRef,
): void {
	if (artifact.sha256 !== ref.sha256 || artifact.byteLength !== ref.byteLength) {
		throw new Error(`Node Evaluation artifact changed: ${ref.ref}`);
	}
}

function directoryRef(
	artifact: PublishedArtifactDirectoryRef,
): NodeEvaluationDirectoryRef {
	return {
		ref: artifact.relativePath,
		sha256: artifact.sha256,
		byteLength: artifact.byteLength,
		fileCount: artifact.files.length,
	};
}

function describeExternalDirectory(path: string): PublishedArtifactDirectoryRef {
	const real = realpathSync(path);
	return new RunArtifactStore(dirname(real)).describeDirectory(relative(dirname(real), real));
}

function writeCaseFile(
	caseDirectory: string,
	name: string,
	content: string | Buffer,
): NodeEvaluationFileRef {
	const path = join(caseDirectory, name);
	writeImmutable(path, content);
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
	return {
		ref: name,
		sha256: sha256(bytes),
		byteLength: bytes.byteLength,
	};
}

function referenceRunFile(runDirectory: string, path: string): NodeEvaluationTraceRef | undefined {
	const root = realpathSync(runDirectory);
	const source = safeRegularFile(path, "Agent Session");
	const ref = relative(root, source);
	if (!ref || !isInsideRoot(root, source)) return undefined;
	const content = readFileSync(source);
	return {
		root: "run",
		ref: safeRelativePath(ref, "Agent Session reference"),
		sha256: sha256(content),
		byteLength: content.byteLength,
	};
}

function referenceRunDirectory(
	runDirectory: string,
	path: string,
): (NodeEvaluationDirectoryRef & { root: "run" }) | undefined {
	const root = realpathSync(runDirectory);
	const real = realpathSync(path);
	const ref = relative(root, real);
	if (!ref || !isInsideRoot(root, real)) return undefined;
	return { ...directoryRef(new RunArtifactStore(root).describeDirectory(ref)), root: "run" };
}

function caseRunDirectory(casePath: string): string {
	return resolve(dirname(casePath), "../../..");
}

function isImportedCaseDirectory(path: string): boolean {
	return basename(dirname(path)) === "imported-cases" && /^[a-f0-9]{64}$/u.test(basename(path));
}

function resolveCaseRef(root: string, ref: string): string {
	const safe = safeRelativePath(ref, "Node Evaluation reference");
	const path = resolve(root, safe);
	if (path === resolve(root) || !isInsideRoot(root, path)) {
		throw new Error(`Node Evaluation reference escapes its root: ${ref}`);
	}
	return path;
}

function resolveRunRef(runDirectory: string, ref: string): string {
	return resolveCaseRef(realpathSync(runDirectory), ref);
}

function safeRelativePath(value: string, label: string): string {
	if (!value || isAbsolute(value) || value.includes("\0")) {
		throw new Error(`${label} must be a safe relative path`);
	}
	const normalized = value.replaceAll("\\", "/");
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new Error(`${label} escapes its root`);
	}
	return normalized;
}

function resolveSafeRelative(root: string, value: string, label: string): string {
	const safe = safeRelativePath(value, label);
	const rootReal = realpathSync(root);
	const path = resolve(rootReal, safe);
	if (path === rootReal || !isInsideRoot(rootReal, path)) {
		throw new Error(`${label} escapes its root`);
	}
	return realpathSync(path);
}

function safeRegularFile(path: string, label: string): string {
	if (!existsSync(path)) throw new Error(`${label} does not exist`);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
		throw new Error(`${label} must be one regular file`);
	}
	return realpathSync(path);
}

function directoryHasEntries(path: string): boolean {
	return existsSync(path)
		&& lstatSync(path).isDirectory()
		&& readdirSync(path).length > 0;
}

function writeImmutable(path: string, content: string | Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	if (Buffer.isBuffer(content)) {
		writeFileSync(path, content, { flag: "wx", mode: 0o600 });
		return;
	}
	writeFileSync(path, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
}

function recipeKey(identity: NodeReplayRecipeIdentity): string {
	return `${identity.id}@${identity.version}`;
}
