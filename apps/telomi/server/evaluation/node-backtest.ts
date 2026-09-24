import { daemonRunsDirByName } from "../workspaces/goal-runtime-paths.js";
import { RECORDED_STAGE_AGENT_IDS } from "../agent-runtime/recorded-stage-replay.js";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	cpSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { listFilesRecursive, writeFileAtomic } from "../lib/fs.js";
import { hashDirectory, sha256, stableJson } from "../lib/hash.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { WORKSPACE_AGENT_IDS } from "../workspaces/agent-layout.js";
import { materializeSkills, snapshotSkills } from "../agent-runtime/skill-registry.js";
import { readRuntimeRecords } from "../observability/run-records.js";
import { getResearchSourceServiceClient } from "../providers/source-service-client.js";
import * as log from "../lib/log.js";
import { createProductionResearchStageRunner } from "../research/pipeline/index.js";
import {
	findNodeEvaluationCases,
	NodeEvaluationModule,
	readNodeEvaluationCase,
	readNodeEvaluationFile,
	type NodeEvaluationCase,
	type NodeEvaluationFileRef,
	type NodeReplayRecipe,
	type NodeReplayRecipeIdentity,
} from "../agent-runtime/node-evaluation.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { type AgentStageRequest, type AgentStageRunner } from "../agent-runtime/agent-stage-runtime.js";
import { createCaseBundle, importCaseBundle } from "./case-bundle.js";
import { deriveProviderChildCase } from "./provider-child-case.js";
import { withCaseExport } from "./case-export-lock.js";
import { assertSafeRelativePath, isFileNameSegment } from "../lib/paths.js";
import { toErrorMessage } from "../lib/values.js";

const RUN_SCHEMA_VERSION = 4 as const;
const MAX_CASES = 20;
const MAX_REPETITIONS = 5;
const MAX_PROMPT_CHARACTERS = 200_000;
const INLINE_ARTIFACT_BYTES = 1_000_000;

export type NodeBacktestStatus =
	| "queued"
	| "running"
	| "awaiting_evaluation"
	| "completed"
	| "failed"
	| "cancelled";

/**
 * Observed 有输出的 Case 进入 Quality Replay（匿名 A/B + 人工 Judgment）；
 * Observed 失败或没有输出的 Case 进入 Recovery Replay（只证明故障能否恢复）。
 */
export type NodeBacktestCaseClass = "quality" | "recovery";

export interface NodeBacktestCaseRef {
	sourceRunId: string;
	caseId: string;
}

export interface NodeBacktestCaseFile {
	ref: string;
	kind: string;
	sha256: string;
	byteLength: number;
}

/** Trace, prompt and artifact refs of one execution, relative to the Run directory. */
export interface NodeExecutionRefs {
	[name: string]: string | undefined;
	agentTrace?: string;
	activityTrace?: string;
	acquisitionTrace?: string;
	organizerTrace?: string;
	runtimeTrace?: string;
	providerLog?: string;
	organizerDecision?: string;
	organizerIndex?: string;
	sourceIndex?: string;
}

export interface NodeBacktestPromptOverride {
	systemPrompt?: string;
	userPrompt?: string;
}

export interface NodeBacktestVariantRequest {
	promptMode?: "observed" | "override";
	promptOverride?: NodeBacktestPromptOverride;
	capabilitySnapshotId?: string;
	expectedRuntimeBuild?: string;
	expectedAgentBundleSha256?: string;
}

export interface NodeBacktestRequest {
	agentId: string;
	cases: NodeBacktestCaseRef[];
	candidate: NodeBacktestVariantRequest;
	repetitions?: number;
	rubricId: string;
}

export interface NodeBacktestResolvedVariant extends NodeBacktestVariantRequest {
	workspaceContentHash: string;
	capabilitySnapshotId: string;
	capabilityBundleHash: string;
	promptBundle?: NodeBacktestCandidatePromptBundle;
}

export interface NodeBacktestCandidatePromptBundle {
	schemaVersion: 1;
	source: "observed" | "override";
	sha256: string;
	cases: Array<{
		caseRef: NodeBacktestCaseRef;
		systemPrompt: string;
		userPrompt: string;
		systemSha256: string;
		userSha256: string;
	}>;
}

export interface NodeBacktestCapabilitySnapshot {
	schemaVersion: 1;
	id: string;
	goalId: string;
	workspaceContentHash: string;
	createdAt: string;
	ref: string;
}

export interface NodeBacktestExecution {
	id: string;
	caseRef: NodeBacktestCaseRef;
	repetition: number;
	variant: "candidate";
	status?: "completed" | "failed";
	candidateCaseRef?: NodeBacktestCaseRef;
	error?: string;
	artifact: {
		ref: string;
		sha256: string;
		byteLength: number;
		directory: boolean;
	};
	metrics: {
		inputTokens: number;
		outputTokens: number;
		costUsd: number;
		calls: number;
		turns: number;
		toolCalls: number;
		durationMs: number;
	};
	refs?: NodeExecutionRefs;
}

export interface NodeBacktestActiveExecution {
	id: string;
	caseRef: NodeBacktestCaseRef;
	repetition: number;
	variant: "candidate";
	status: "running";
	refs: NodeExecutionRefs;
}

export interface NodeBacktestPair {
	id: string;
	caseRef: NodeBacktestCaseRef;
	repetition: number;
	a: "observed" | "candidate";
	b: "observed" | "candidate";
	candidateExecutionId: string;
}

export interface NodeBacktestAggregateMetrics {
	executions: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	calls: number;
	turns: number;
	toolCalls: number;
	durationMs: number;
}

export interface NodeBacktestRun {
	schemaVersion: 4;
	mode: "candidate-replay";
	/** Recovery Run does not produce blind pairs. Human Judgment belongs to the external evaluation environment. */
	kind: NodeBacktestCaseClass;
	id: string;
	goalId: string;
	status: NodeBacktestStatus;
	agentId: string;
	cases: NodeBacktestCaseRef[];
	candidate: NodeBacktestResolvedVariant;
	observedMetrics: NodeBacktestAggregateMetrics;
	repetitions: number;
	rubricId: string;
	runtimeBuild?: string;
	agentBundleSha256?: string;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	executions: NodeBacktestExecution[];
	activeExecution?: NodeBacktestActiveExecution;
	pairs: NodeBacktestPair[];
	error?: string;
}

export interface NodeBacktestEvaluationBatch {
	runId: string;
	agentId: string;
	rubricId: string;
	pairs: Array<{
		pairId: string;
		caseRef: NodeBacktestCaseRef;
		repetition: number;
		input: NodeBacktestEvaluationInput;
		outputs: {
			A: NodeBacktestEvaluationArtifact;
			B: NodeBacktestEvaluationArtifact;
		};
	}>;
}

export interface NodeBacktestEvaluationInput {
	userPrompt: string;
	sha256: string;
	byteLength: number;
	files: Array<{
		relativePath: string;
		sha256: string;
		byteLength: number;
		content?: string;
	}>;
}

export interface NodeBacktestEvaluationArtifact {
	sha256: string;
	byteLength: number;
	directory: boolean;
	content?: string;
	files?: Array<{ relativePath: string; sha256: string; byteLength: number }>;
}

export interface NodeBacktestServiceOptions {
	workspaceDir: string;
	applicationDir?: string;
	listGoalIds: () => string[];
	recipes: readonly NodeReplayRecipe[];
	runner?: AgentStageRunner;
	concurrency?: number;
}

interface QueueRef {
	goalId: string;
	runId: string;
}

export class NodeBacktestService {
	private readonly module: NodeEvaluationModule;
	private readonly recipeKeys: Set<string>;
	private readonly runner: AgentStageRunner;
	private readonly concurrency: number;
	private readonly loadedRuntimeBuild: string;
	private readonly loadedAgentBundleSha256: string;
	private readonly queue: QueueRef[] = [];
	private readonly active = new Map<string, Promise<void>>();
	private readonly controllers = new Map<string, AbortController>();
	private stopped = true;

	constructor(private readonly options: NodeBacktestServiceOptions) {
		this.module = new NodeEvaluationModule(options.recipes);
		this.recipeKeys = new Set(options.recipes.map((recipe) => recipeKey(recipe.identity)));
		this.runner = options.runner ?? createProductionResearchStageRunner({ env: process.env });
		// ponytail: one worker is deliberate; raise only when Provider quotas and host capacity justify it.
		this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
		this.loadedRuntimeBuild = applicationBuildIdentity(options.applicationDir ?? process.cwd());
		this.loadedAgentBundleSha256 = hashDirectory(join(options.applicationDir ?? process.cwd(), "agents"));
	}

	start(): void {
		this.stopped = false;
		this.resumeInterruptedRuns();
		this.pump();
	}

	stop(): void {
		this.stopped = true;
		for (const controller of this.controllers.values()) controller.abort();
	}

	status(): {
		active: number;
		queued: number;
		concurrency: number;
		recipes: string[];
		runtimeBuild: string;
		runtimeBuildMatchesDisk: boolean;
		agentBundleSha256: string;
	} {
		const currentRuntimeBuild = applicationBuildIdentity(this.options.applicationDir ?? process.cwd());
		return {
			active: this.active.size,
			queued: this.queue.length,
			concurrency: this.concurrency,
			recipes: [...this.recipeKeys].sort(),
			runtimeBuild: this.loadedRuntimeBuild,
			runtimeBuildMatchesDisk: currentRuntimeBuild === this.loadedRuntimeBuild,
			agentBundleSha256: this.loadedAgentBundleSha256,
		};
	}

	createCapabilitySnapshot(
		goalId: string,
		sourceDirectory: string,
		harnessPaths: readonly string[] = [],
	): NodeBacktestCapabilitySnapshot {
		if (!existsSync(this.goalDirectory(goalId))) throw new Error(`Unknown goal '${goalId}'`);
		if (!existsSync(sourceDirectory) || !lstatSync(sourceDirectory).isDirectory()) {
			throw new Error("Capability Snapshot source must be a directory");
		}
		const wikiPaths = ["wiki/knowledge", ...harnessPaths];
		const workspaceContentHash = capabilityContentHash(sourceDirectory, wikiPaths);
		const id = `caps_${workspaceContentHash}`;
		const root = join(this.capabilitySnapshotsDirectory(goalId), id);
		if (existsSync(root)) return this.requireCapabilitySnapshot(goalId, id);
		const temporary = `${root}.${randomUUID()}.tmp`;
		mkdirSync(temporary, { recursive: true });
		try {
			materializeCapabilities(sourceDirectory, join(temporary, "content"), wikiPaths);
			if (capabilityContentHash(join(temporary, "content")) !== workspaceContentHash) {
				throw new Error("Materialized Capability Snapshot changed");
			}
			const snapshot: NodeBacktestCapabilitySnapshot = {
				schemaVersion: 1,
				id,
				goalId,
				workspaceContentHash,
				createdAt: new Date().toISOString(),
				ref: `evaluation/capability-snapshots/${id}/content`,
			};
			writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(snapshot, null, 2)}\n`, {
				encoding: "utf-8",
				mode: 0o600,
			});
			mkdirSync(this.capabilitySnapshotsDirectory(goalId), { recursive: true });
			renameSync(temporary, root);
			return snapshot;
		} finally {
			if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
		}
	}

	enqueue(goalId: string, request: NodeBacktestRequest): NodeBacktestRun {
		const goalDirectory = this.goalDirectory(goalId);
		if (!existsSync(goalDirectory)) throw new Error(`Unknown goal '${goalId}'`);
		const parsed = validateRequest(request, new Set([...this.recipeKeys].map((key) => key.split("@")[0]!)));
		this.assertRuntimeBuild(parsed.candidate.expectedRuntimeBuild, parsed.candidate.expectedAgentBundleSha256);
		const caseValues = parsed.cases.map((caseRef) => {
			const location = this.caseLocation(goalId, caseRef);
			const casePath = location.casePath;
			const value = readNodeEvaluationCase(casePath, location.sourceRunDirectory);
			if (value.agentId !== parsed.agentId) {
				throw new Error(`Node Case '${caseRef.caseId}' belongs to Agent '${value.agentId}', not '${parsed.agentId}'`);
			}
			if (!this.recipeKeys.has(recipeKey(value.recipe))) {
				throw new Error(`Node Replay Recipe '${recipeKey(value.recipe)}' is not registered`);
			}
			return { ref: caseRef, value, casePath, sourceRunDirectory: location.sourceRunDirectory };
		});
		const cases = caseValues.map((item) => item.ref);
		const kind = resolveCaseClass(caseValues.map((item) => item.value));
		const now = new Date().toISOString();
		const snapshot = parsed.candidate.capabilitySnapshotId
			? this.requireCapabilitySnapshot(goalId, parsed.candidate.capabilitySnapshotId)
			: this.createCapabilitySnapshot(goalId, goalDirectory, caseValues.flatMap(({ value }) =>
				value.mounts.flatMap((mount) => mount.kind === "harness" ? [mount.workspaceRelativePath] : [])));
		const promptBundle = RECORDED_STAGE_AGENT_IDS.includes(parsed.agentId as typeof RECORDED_STAGE_AGENT_IDS[number])
			? resolveCandidatePromptBundle(caseValues, parsed.candidate)
			: undefined;
		const capabilityBundleHash = sha256(stableJson({
			agentId: parsed.agentId,
			runtimeBuild: this.loadedRuntimeBuild,
			agentBundleSha256: this.loadedAgentBundleSha256,
			workspaceContentHash: snapshot.workspaceContentHash,
			prompt: promptBundle?.sha256 ?? parsed.candidate.promptOverride ?? null,
		}));
		const run: NodeBacktestRun = {
			schemaVersion: RUN_SCHEMA_VERSION,
			mode: "candidate-replay",
			kind,
			id: `nodebt_${Date.now()}_${randomUUID().slice(0, 8)}`,
			goalId,
			status: "queued",
			agentId: parsed.agentId,
			cases,
			candidate: {
				capabilitySnapshotId: snapshot.id,
				workspaceContentHash: snapshot.workspaceContentHash,
				capabilityBundleHash,
				...(promptBundle
					? { promptMode: parsed.candidate.promptMode, promptBundle }
					: parsed.candidate.promptOverride ? { promptOverride: parsed.candidate.promptOverride } : {}),
			},
			observedMetrics: aggregateObserved(caseValues.map((item) => item.value)),
			repetitions: parsed.repetitions ?? 2,
			rubricId: parsed.rubricId,
			runtimeBuild: this.loadedRuntimeBuild,
			agentBundleSha256: this.loadedAgentBundleSha256,
			createdAt: now,
			updatedAt: now,
			executions: [],
			pairs: [],
		};
		this.save(run);
		this.queue.push({ goalId, runId: run.id });
		this.pump();
		return run;
	}

	read(goalId: string, runId: string): NodeBacktestRun | null {
		try {
			const run = parseRun(readFileSync(this.runPath(goalId, runId), "utf-8"));
			if (!run) return null;
			return projectFrozenRun(run, this.runDirectory(goalId, runId));
		} catch {
			return null;
		}
	}

	list(goalId: string, limit = 50): NodeBacktestRun[] {
		const root = this.runsDirectory(goalId);
		if (!existsSync(root)) return [];
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => this.read(goalId, entry.name))
			.filter((run): run is NodeBacktestRun => Boolean(run))
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
			.slice(0, Math.max(1, Math.min(500, Math.floor(limit))));
	}

	private readonly childCaptures = new Map<string, Promise<NodeBacktestCaseRef>>();

	/** A child is a normal immutable Case, identified externally by the existing CaseRef. */
	async ensureProviderChildCase(goalId: string, parentRef: NodeBacktestCaseRef, executionId: string): Promise<NodeBacktestCaseRef> {
		const key = sha256(stableJson({ goalId, parentRef, executionId }));
		const pending = this.childCaptures.get(key);
		if (pending) return pending;
		const capture = this.deriveChildCase(goalId, parentRef, executionId, key);
		this.childCaptures.set(key, capture);
		try { return await capture; } finally { this.childCaptures.delete(key); }
	}

	private async deriveChildCase(goalId: string, parentRef: NodeBacktestCaseRef, executionId: string, key: string): Promise<NodeBacktestCaseRef> {
		// Inspect only small manifests while locating provenance; hash the selected Case once.
		const rootsToSearch = [...this.sourceRunsDirectories(goalId), this.importedCasesDirectory(goalId)];
		const locations = rootsToSearch.flatMap((root) => existsSync(root)
			? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
				const sourceRunDirectory = join(root, entry.name);
				const cases = join(sourceRunDirectory, "node-evaluation/cases");
				return existsSync(cases) ? readdirSync(cases, { withFileTypes: true }).filter((item) => item.isDirectory())
					.map((item) => ({ sourceRunDirectory, casePath: join(cases, item.name, "manifest.json") })) : [];
			}) : []).concat(this.candidateReplayCaseLocations(goalId));
		for (const location of locations) {
			if (!existsSync(location.casePath)) continue;
			const value = JSON.parse(readFileSync(location.casePath, "utf-8")) as NodeEvaluationCase;
			if (value.agentId !== "provider-child" || value.runId !== parentRef.sourceRunId) continue;
			const request = JSON.parse(readFileSync(join(dirname(location.casePath), "input/request.json"), "utf-8"));
			if (request.source?.sourceRunId === parentRef.sourceRunId && request.source.caseId === parentRef.caseId
				&& request.source.executionId === executionId) {
				readNodeEvaluationCase(location.casePath, location.sourceRunDirectory);
				return { sourceRunId: value.runId, caseId: value.caseId };
			}
		}
		const roots = this.caseRoots(goalId, parentRef);
		const parent = this.readCase(goalId, parentRef);
		const destination = join(serverRuntimeDirForGoal(goalId, this.options.workspaceDir), "evaluation/provider-child-cases", key);
		const temporary = `${destination}.${randomUUID()}.tmp`;
		mkdirSync(temporary, { recursive: true });
		try {
			const ref = await deriveProviderChildCase({
				goalId, parentRef, executionId, parent, recordDirectory: temporary,
				files: this.listCaseFilePaths(goalId, parentRef),
				restoreOutput: async (output) => {
					mkdirSync(output, { recursive: true });
					const bundled = join(roots.sourceRunDirectory, "workspace", "output");
					if (existsSync(bundled)) cpSync(bundled, output, { recursive: true });
					else {
						if (!parent.workspace?.output_tree_sha) throw new Error("Provider Child Case has no terminal Workspace snapshot");
						await getResearchSourceServiceClient().restoreTree(parent.workspace.output_tree_sha, output);
					}
				},
				capabilitySnapshot: (source) => this.createCapabilitySnapshot(goalId, source).id,
			});
			rmSync(join(temporary, "child-input"), { recursive: true, force: true });
			mkdirSync(dirname(destination), { recursive: true });
			renameSync(temporary, destination);
			return ref;
		} finally { rmSync(temporary, { recursive: true, force: true }); }
	}

	async exportCaseBundle(goalId: string, goalTitle: string, caseRef: NodeBacktestCaseRef) {
		const location = this.caseLocation(goalId, caseRef);
		return withCaseExport(dirname(location.casePath), async () => {
			const value = readNodeEvaluationCase(location.casePath, location.sourceRunDirectory);
			const capabilitySnapshotId = value.capabilitySnapshotId;
			if (capabilitySnapshotId) this.requireCapabilitySnapshot(goalId, capabilitySnapshotId);
			return createCaseBundle({
				dataDir: this.options.workspaceDir,
				goalId,
				goalTitle,
				casePath: location.casePath,
				value,
				runtimeBuild: this.loadedRuntimeBuild,
				agentBundleSha256: this.loadedAgentBundleSha256,
				...(capabilitySnapshotId ? {
					capabilitySnapshotId,
					capabilityContentDirectory: this.capabilitySnapshotContentDirectory(goalId, capabilitySnapshotId),
				} : {}),
				restoreTree: (treeSha, destination) => getResearchSourceServiceClient().restoreTree(treeSha, destination),
			});
		});
	}

	importBundle(path: string, ensureGoal: (id: string, title: string) => void) {
		return importCaseBundle({
			path,
			dataDir: this.options.workspaceDir,
			ensureGoal,
			capabilityContentHash: (directory) => capabilityContentHash(directory),
		});
	}

	listCases(goalId: string, agentId?: string, limit = 100): Array<{
		ref: NodeBacktestCaseRef;
		value: NodeEvaluationCase;
	}> {
		const result: Array<{ ref: NodeBacktestCaseRef; value: NodeEvaluationCase }> = [];
		for (const runsRoot of this.sourceRunsDirectories(goalId)) {
			if (!existsSync(runsRoot)) continue;
			for (const run of readdirSync(runsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
				const sourceRunDirectory = join(runsRoot, run.name);
				const nativeRoot = join(sourceRunDirectory, "node-evaluation", "cases");
				if (!existsSync(nativeRoot)) continue;
				for (const path of readdirSync(nativeRoot, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(nativeRoot, entry.name, "manifest.json"))
					.filter(existsSync)) {
					let value: NodeEvaluationCase;
					try {
						value = readNodeEvaluationCase(path, sourceRunDirectory);
					} catch (error) {
						log.logWarning(
							`Skipping invalid Node Evaluation Case '${relative(sourceRunDirectory, path)}'`,
							toErrorMessage(error),
						);
						continue;
					}
					if (this.recipeKeys.has(recipeKey(value.recipe)) && (!agentId || value.agentId === agentId)) {
						result.push({ ref: { sourceRunId: value.runId, caseId: value.caseId }, value });
					}
				}
			}
		}
		for (const location of this.candidateReplayCaseLocations(goalId)) {
			try {
				const value = readNodeEvaluationCase(location.casePath, location.sourceRunDirectory);
				if (this.recipeKeys.has(recipeKey(value.recipe)) && (!agentId || value.agentId === agentId)) {
					result.push({ ref: { sourceRunId: value.runId, caseId: value.caseId }, value });
				}
			} catch (error) {
				log.logWarning(`Skipping invalid Candidate Replay Case '${location.casePath}'`,
					toErrorMessage(error));
			}
		}
		const importedRoot = this.importedCasesDirectory(goalId);
		if (existsSync(importedRoot)) {
			for (const bundle of readdirSync(importedRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
				const sourceRunDirectory = join(importedRoot, bundle.name);
				const casesRoot = join(sourceRunDirectory, "node-evaluation", "cases");
				if (!existsSync(casesRoot)) continue;
				for (const path of readdirSync(casesRoot, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(casesRoot, entry.name, "manifest.json"))
					.filter(existsSync)) {
					try {
						const value = readNodeEvaluationCase(path, sourceRunDirectory);
						if (this.recipeKeys.has(recipeKey(value.recipe)) && (!agentId || value.agentId === agentId)) {
							result.push({ ref: { sourceRunId: value.runId, caseId: value.caseId }, value });
						}
					} catch (error) {
						log.logWarning(
							`Skipping invalid imported Node Evaluation Case '${relative(sourceRunDirectory, path)}'`,
							toErrorMessage(error),
						);
					}
				}
			}
		}
		return result
			.sort((left, right) => right.value.capturedAt.localeCompare(left.value.capturedAt))
			.slice(0, Math.max(1, Math.min(500, Math.floor(limit))));
	}

	evaluationBatch(goalId: string, runId: string): NodeBacktestEvaluationBatch {
		const run = this.requireRun(goalId, runId);
		assertQualityRun(run, runId);
		if (run.status !== "awaiting_evaluation" && run.status !== "completed"
			&& !(run.status === "failed" && run.pairs.length > 0)) {
			throw new Error(`Node Backtest '${runId}' has no evaluation batch yet`);
		}
		const byId = new Map(run.executions.map((execution) => [execution.id, execution]));
		return {
			runId,
			agentId: run.agentId,
			rubricId: run.rubricId,
			pairs: run.pairs.map((pair) => {
				const candidate = byId.get(pair.candidateExecutionId)!;
				const observed = this.observedEvaluationArtifact(run.goalId, pair.caseRef);
				const candidateArtifact = this.evaluationArtifact(run, candidate);
				return {
					pairId: pair.id,
					caseRef: pair.caseRef,
					repetition: pair.repetition,
					input: this.evaluationInput(run.goalId, pair.caseRef),
					outputs: {
						A: pair.a === "observed" ? observed : candidateArtifact,
						B: pair.b === "observed" ? observed : candidateArtifact,
					},
				};
			}),
		};
	}

	caseInputFile(goalId: string, caseRef: NodeBacktestCaseRef, relativeFile: string): string {
		const casePath = this.casePath(goalId, caseRef);
		const sourceRunDirectory = this.caseLocation(goalId, caseRef).sourceRunDirectory;
		const value = readNodeEvaluationCase(casePath, sourceRunDirectory);
		const input = new RunArtifactStore(sourceRunDirectory).describeDirectory(value.input.ref);
		const expected = input.files.find((file) => file.relativePath === relativeFile);
		if (!expected) throw new Error(`Unknown Node Case input file '${relativeFile}'`);
		return verifiedNestedFile(input.absolutePath, expected);
	}

	readCase(goalId: string, caseRef: NodeBacktestCaseRef): NodeEvaluationCase {
		const location = this.caseLocation(goalId, caseRef);
		return readNodeEvaluationCase(location.casePath, location.sourceRunDirectory);
	}

	/**
	 * On-disk roots of one Case, for a caller that has to freeze the whole Case rather than read
	 * files out of it. `listCaseFiles` covers reading; freezing needs the directories the refs
	 * resolve against, because a frozen copy must reproduce the same ref set somewhere else.
	 */
	caseRoots(goalId: string, caseRef: NodeBacktestCaseRef): {
		caseDirectory: string;
		sourceRunDirectory: string;
		workspaceRunDirectory: string;
	} {
		const location = this.caseLocation(goalId, caseRef);
		return {
			caseDirectory: dirname(location.casePath),
			sourceRunDirectory: location.sourceRunDirectory,
			workspaceRunDirectory: join(this.goalDirectory(goalId), "wiki", "runs", requiredSegment(caseRef.sourceRunId, "Source Run id")),
		};
	}

	listCaseFiles(goalId: string, caseRef: NodeBacktestCaseRef): NodeBacktestCaseFile[] {
		return this.caseFileEntries(goalId, caseRef).map(({ absolutePath: _absolutePath, ...entry }) => entry);
	}

	/**
	 * Every Case file with its on-disk path, from one verified scan. Reading many files through
	 * `caseFile` rescans and rehashes the whole Case per file, which blocks the event loop for
	 * minutes on a large Case. Host paths stay server-side; HTTP callers get `listCaseFiles`.
	 */
	listCaseFilePaths(goalId: string, caseRef: NodeBacktestCaseRef): Array<NodeBacktestCaseFile & { absolutePath: string }> {
		return this.caseFileEntries(goalId, caseRef);
	}

	caseFile(goalId: string, caseRef: NodeBacktestCaseRef, ref: string): string {
		const entry = this.caseFileEntries(goalId, caseRef).find((item) => item.ref === ref);
		if (!entry) throw new Error(`Unknown Node Case file ref '${ref}'`);
		return entry.absolutePath;
	}

	private caseFileEntries(goalId: string, caseRef: NodeBacktestCaseRef): Array<NodeBacktestCaseFile & { absolutePath: string }> {
		const casePath = this.casePath(goalId, caseRef);
		const caseDirectory = dirname(casePath);
		const sourceRunDirectory = this.caseLocation(goalId, caseRef).sourceRunDirectory;
		const value = readNodeEvaluationCase(casePath, sourceRunDirectory);
		const entries: Array<NodeBacktestCaseFile & { absolutePath: string }> = [];
		const addDirectory = (
			refPrefix: "input" | "output" | "run" | "terminal",
			root: string,
			directoryRef: string,
			kind: string | ((relativePath: string) => string | undefined),
		) => {
			const directory = new RunArtifactStore(root).describeDirectory(directoryRef);
			for (const file of directory.files) {
				const fileKind = typeof kind === "string" ? kind : kind(file.relativePath);
				if (!fileKind) continue;
				entries.push({
					ref: `${refPrefix}:${refPrefix === "run" ? `${directoryRef}/` : ""}${file.relativePath}`,
					kind: fileKind,
					sha256: file.sha256,
					byteLength: file.byteLength,
					absolutePath: safeArtifactPath(directory.absolutePath, file.relativePath),
				});
			}
		};
		const addFile = (rootName: "case" | "run" | "workspace", root: string, file: NodeEvaluationFileRef, kind: string) => {
			const absolutePath = safeArtifactPath(root, file.ref);
			const content = readFileSync(absolutePath);
			if (sha256(content) !== file.sha256 || content.byteLength !== file.byteLength) {
				throw new Error(`Node Case file changed: ${file.ref}`);
			}
			entries.push({ ref: `${rootName}:${file.ref}`, kind, sha256: file.sha256,
				byteLength: file.byteLength, absolutePath });
		};
		const addExistingFile = (rootName: "case" | "run" | "workspace", root: string, ref: string, kind: string) => {
			const absolutePath = safeArtifactPath(root, ref);
			const content = readFileSync(absolutePath);
			entries.push({ ref: `${rootName}:${ref}`, kind, sha256: sha256(content),
				byteLength: content.byteLength, absolutePath });
		};
		if (value.observed.providerCalls) addFile("case", caseDirectory, value.observed.providerCalls, "provider_calls");
		addFile("case", caseDirectory, value.request.systemPrompt, "system_prompt");
		addFile("case", caseDirectory, value.request.composedSystemPrompt, "composed_system_prompt");
		addFile("case", caseDirectory, value.request.userPrompt, "user_prompt");
		addDirectory("input", value.input.root === "case" ? caseDirectory : sourceRunDirectory, value.input.ref, "input");
		if (value.observed.trace) {
			const rootName = value.observed.trace.root === "run" ? "run" : "case";
			const traceRoot = rootName === "run" ? sourceRunDirectory : caseDirectory;
			const traceExists = existsSync(join(traceRoot, value.observed.trace.ref));
			if (traceExists) addFile(rootName, traceRoot, value.observed.trace, "agent_trace");
			if (traceExists && rootName === "run" && value.observed.trace.ref.endsWith(".jsonl")) {
				const traceStem = basename(value.observed.trace.ref, ".jsonl");
				for (const entry of readdirSync(sourceRunDirectory, { withFileTypes: true })
					.filter((entry) => entry.isFile() && entry.name.startsWith(`${traceStem}-`) && entry.name.endsWith(".jsonl"))) {
					addExistingFile("run", sourceRunDirectory, entry.name, "related_agent_trace");
				}
			}
			const traceDirectory = primeSearchCaseTraceDirectory(value);
			if (traceDirectory && existsSync(join(sourceRunDirectory, traceDirectory))) {
				addDirectory("run", sourceRunDirectory, traceDirectory, primeSearchCaseTraceKind);
			}
			for (const wikiTraceDirectory of wikiCaseTraceDirectories(value)) {
				if (existsSync(join(sourceRunDirectory, wikiTraceDirectory))) {
					// Wiki Curator 的 Runtime 目录与 Worker Workspace 并列；按 Runtime 内的相对路径分类。
					const kind = basename(wikiTraceDirectory) === "curator-runtime"
						? (relativePath: string) => wikiCaseTraceKind(`runtime/${relativePath}`)
						: wikiCaseTraceKind;
					addDirectory("run", sourceRunDirectory, wikiTraceDirectory, kind);
				}
			}
			for (const podcastTraceDirectory of podcastCaseTraceDirectories(value)) {
				if (existsSync(join(sourceRunDirectory, podcastTraceDirectory))) {
					addDirectory("run", sourceRunDirectory, podcastTraceDirectory, podcastCaseTraceKind);
				}
			}
		}
		// Reviewer 的现场是两个目录，没有单独的 Trace 文件；它的 Case 因此在 observed.trace 之外
		// 暴露 Trace。映射是白名单：staged 凭证所在的 runtime/agent 永远不在其中。
		if (value.agentId === "schedule-reviewer") {
			for (const directory of value.observed.traceDirectories ?? []) {
				if (directory.root === "run" && existsSync(join(sourceRunDirectory, directory.ref))) {
					addDirectory("run", sourceRunDirectory, directory.ref, scheduleReviewCaseTraceKind);
				}
			}
		}
		// 失败或取消的 Capture 没有 Observed 输出，终态 Workspace 就是它的恢复证据。
		if (value.observed.terminalWorkspace) {
			addDirectory("terminal", caseDirectory, value.observed.terminalWorkspace.ref, "terminal_workspace");
		}
		if (value.observed.output) {
			if (value.observed.output.directory) {
				addDirectory("output", caseDirectory, value.observed.output.ref, value.agentId === "provider-child"
					? (path) => path === "traces/session.jsonl" ? "child_trace"
						: path === "traces/execution-conditions.jsonl" ? "execution_conditions" : "observed_output"
					: "observed_output");
			} else {
				addFile("case", caseDirectory, value.observed.output, "completion_marker");
			}
		}
		if (value.agentId === "main-agent") {
			for (const [ref, kind] of [
				["main-agent.jsonl", "agent_trace"],
				["runtime--main.jsonl", "runtime_trace"],
				["route-trace.json", "route_decision"],
				["publication.json", "publication"],
				["session.json", "session"],
			] as const) {
				if (existsSync(join(sourceRunDirectory, ref))) addExistingFile("run", sourceRunDirectory, ref, kind);
			}
		}
		if (value.agentId === "prime-search") {
			const workspaceRun = join(this.goalDirectory(goalId), "wiki", "runs", caseRef.sourceRunId);
			const workspaceArtifacts = join(workspaceRun, "artifacts");
			if (existsSync(workspaceArtifacts)) {
				for (const path of listFilesRecursive(workspaceArtifacts, { absolute: true, strict: true })) {
					const ref = relative(workspaceRun, path).split(sep).join("/");
					if (ref.endsWith("/source-index.json") && ref.includes("/source-bundles/")) {
						addExistingFile("workspace", workspaceRun, ref, "source_bundle_index");
					} else if (/^artifacts\/search-executions\/.+\.json$/u.test(ref)) {
						addExistingFile("workspace", workspaceRun, ref, "search_execution");
					}
				}
			}
		}
		return [...new Map(entries.map((entry) => [entry.ref, entry])).values()].sort((left, right) => left.ref.localeCompare(right.ref));
	}

	artifactFile(goalId: string, runId: string, executionId: string, relativeFile?: string): string {
		const run = this.requireRun(goalId, runId);
		const execution = run.executions.find((item) => item.id === executionId);
		if (!execution) throw new Error(`Unknown Node Backtest execution '${executionId}'`);
		if (!execution.artifact) throw new Error(`Node Backtest execution '${executionId}' has no output artifact`);
		const store = new RunArtifactStore(this.runDirectory(goalId, runId));
		if (!execution.artifact.directory) {
			if (relativeFile) throw new Error("File artifacts do not accept a nested file path");
			const artifact = store.describeFile(execution.artifact.ref);
			assertArtifactIdentity(execution, artifact);
			return artifact.absolutePath;
		}
		if (!relativeFile) throw new Error("Directory artifacts require a file query");
		const artifact = store.openDirectory({ relative_path: execution.artifact.ref,
			sha256: execution.artifact.sha256, byte_length: execution.artifact.byteLength });
		assertArtifactIdentity(execution, artifact);
		const expected = artifact.files.find((file) => file.relativePath === relativeFile);
		if (!expected) throw new Error(`Unknown artifact file '${relativeFile}'`);
		return verifiedNestedFile(artifact.absolutePath, expected);
	}

	evaluationArtifactFile(
		goalId: string,
		runId: string,
		pairId: string,
		label: "A" | "B",
		relativeFile?: string,
	): string {
		const run = this.requireRun(goalId, runId);
		assertQualityRun(run, runId);
		if (run.status !== "awaiting_evaluation" && run.status !== "completed"
			&& !(run.status === "failed" && run.pairs.length > 0)) {
			throw new Error(`Node Backtest '${runId}' has no evaluation batch yet`);
		}
		const pair = run.pairs.find((item) => item.id === pairId);
		if (!pair) throw new Error(`Unknown blind pair '${pairId}'`);
		const variant = label === "A" ? pair.a : pair.b;
		return variant === "observed"
			? this.observedArtifactFile(goalId, pair.caseRef, relativeFile)
			: this.artifactFile(goalId, runId, pair.candidateExecutionId, relativeFile);
	}

	private observedArtifactFile(goalId: string, caseRef: NodeBacktestCaseRef, relativeFile?: string): string {
		const casePath = this.casePath(goalId, caseRef);
		const value = readNodeEvaluationCase(casePath, this.caseLocation(goalId, caseRef).sourceRunDirectory);
		const output = value.observed.output;
		if (!output) throw new Error(`Node Case '${caseRef.caseId}' has no Observed Baseline output`);
		const store = new RunArtifactStore(dirname(casePath));
		if (!output.directory) {
			if (relativeFile) throw new Error("File artifacts do not accept a nested file path");
			const artifact = store.describeFile(output.ref);
			if (artifact.sha256 !== output.sha256 || artifact.byteLength !== output.byteLength) {
				throw new Error(`Observed Baseline artifact changed: ${output.ref}`);
			}
			return artifact.absolutePath;
		}
		if (!relativeFile) throw new Error("Directory artifacts require a file query");
		const artifact = store.openDirectory({ relative_path: output.ref, sha256: output.sha256, byte_length: output.byteLength });
		if (artifact.sha256 !== output.sha256 || artifact.byteLength !== output.byteLength) {
			throw new Error(`Observed Baseline artifact changed: ${output.ref}`);
		}
		const expected = artifact.files.find((file) => file.relativePath === relativeFile);
		if (!expected) throw new Error(`Unknown artifact file '${relativeFile}'`);
		return verifiedNestedFile(artifact.absolutePath, expected);
	}

	replayFile(goalId: string, runId: string, ref: string): string {
		const run = this.requireRun(goalId, runId);
		const allowed = new Set([
			...run.executions.flatMap((execution) => Object.values(execution.refs ?? {})),
			...Object.values(run.activeExecution?.refs ?? {}),
		].filter((value): value is string => Boolean(value)));
		if (!allowed.has(ref)) throw new Error(`Unknown Node Backtest file ref '${ref}'`);
		const root = realpathSync(this.runDirectory(goalId, runId));
		const path = resolve(root, ref);
		const rel = relative(root, path);
		if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Trace ref escapes its run");
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Trace ref is not a safe regular file");
		return realpathSync(path);
	}

	cancel(goalId: string, runId: string): NodeBacktestRun {
		const run = this.requireRun(goalId, runId);
		if (!["queued", "running"].includes(run.status)) return run;
		for (let index = this.queue.length - 1; index >= 0; index -= 1) {
			if (this.queue[index]?.goalId === goalId && this.queue[index]?.runId === runId) this.queue.splice(index, 1);
		}
		const now = new Date().toISOString();
		const cancelled = { ...run, status: "cancelled" as const, updatedAt: now, finishedAt: now };
		this.save(cancelled);
		this.controllers.get(this.activeKey(goalId, runId))?.abort();
		return this.requireRun(goalId, runId);
	}

	private pump(): void {
		if (this.stopped) return;
		while (this.active.size < this.concurrency && this.queue.length > 0) {
			const ref = this.queue.shift()!;
			const key = this.activeKey(ref.goalId, ref.runId);
			if (this.active.has(key)) continue;
			const promise = this.execute(ref)
				.catch(() => undefined)
				.finally(() => {
					this.active.delete(key);
					this.controllers.delete(key);
					this.pump();
				});
			this.active.set(key, promise);
		}
	}

	private async execute(ref: QueueRef): Promise<void> {
		let run = this.read(ref.goalId, ref.runId);
		if (!run || run.status !== "queued") return;
		const controller = new AbortController();
		this.controllers.set(this.activeKey(ref.goalId, ref.runId), controller);
		const startedAt = new Date().toISOString();
		run = { ...run, status: "running", startedAt, updatedAt: startedAt, error: undefined };
		this.save(run);
		const runDirectory = this.runDirectory(run.goalId, run.id);
		try {
			this.assertRuntimeBuild(run.runtimeBuild, run.agentBundleSha256);
			const workspaceDirectory = join(runDirectory, "capabilities", "candidate");
			rmSync(workspaceDirectory, { recursive: true, force: true });
			const snapshot = this.requireCapabilitySnapshot(run.goalId, run.candidate.capabilitySnapshotId);
			if (snapshot.workspaceContentHash !== run.candidate.workspaceContentHash) {
				throw new Error("Node Backtest Candidate Capability Snapshot identity changed");
			}
			materializeCapabilities(this.capabilitySnapshotContentDirectory(run.goalId, snapshot.id), workspaceDirectory);
			if (capabilityContentHash(workspaceDirectory) !== run.candidate.workspaceContentHash) {
				throw new Error("Node Backtest Candidate Capability Snapshot changed");
			}
			for (let caseIndex = 0; caseIndex < run.cases.length; caseIndex += 1) {
				const caseRef = run.cases[caseIndex]!;
				const casePath = this.casePath(run.goalId, caseRef);
				const sourceRunDirectory = this.caseLocation(run.goalId, caseRef).sourceRunDirectory;
				for (let repetition = 1; repetition <= run.repetitions; repetition += 1) {
					if (controller.signal.aborted) throw new Error("Node Backtest cancelled");
					const execution = await this.replay({
						run,
						caseRef,
						casePath,
						sourceRunDirectory,
						repetition,
						workspaceDirectory,
						signal: controller.signal,
					});
					// cancel() owns the terminal record; do not overwrite it with this stale running copy.
					if (controller.signal.aborted) return;
					run.executions.push(execution);
					run.updatedAt = new Date().toISOString();
					this.save(run);
					if (run.kind === "quality") {
						const blind = Number.parseInt(sha256(`${run.id}:${caseRef.caseId}:${repetition}`).slice(0, 2), 16) % 2 === 0;
						run.pairs.push({
							id: `pair_${caseRef.caseId}_${repetition}`,
							caseRef,
							repetition,
							a: blind ? "observed" : "candidate",
							b: blind ? "candidate" : "observed",
							candidateExecutionId: execution.id,
						});
						this.save(run);
					}
					if (execution.status === "failed") {
						// A failed Case still blocks the batch, but every independent Case needs evidence.
						run.error ??= execution.error ?? "Node Backtest Candidate replay failed";
					}
				}
			}
			// Recovery Replay 没有 Observed Baseline 可比：Candidate 正常结束并通过原有
			// 输出契约本身就是结论，因此直接进入终态，不等待也不接受语义 Judgment。
			const settledAt = new Date().toISOString();
			run.status = run.error ? "failed" : run.kind === "recovery" ? "completed" : "awaiting_evaluation";
			run.updatedAt = settledAt;
			if (run.status !== "awaiting_evaluation") run.finishedAt = settledAt;
			this.save(run);
		} catch (error) {
			const current = this.read(run.goalId, run.id);
			if (current?.status === "cancelled" || controller.signal.aborted) return;
			const now = new Date().toISOString();
			this.save({
				...(current ?? run),
				status: "failed",
				updatedAt: now,
				finishedAt: now,
				error: toErrorMessage(error),
			});
			throw error;
		}
	}

	private async replay(input: {
		run: NodeBacktestRun;
		caseRef: NodeBacktestCaseRef;
		casePath: string;
		sourceRunDirectory: string;
		repetition: number;
		workspaceDirectory: string;
		signal: AbortSignal;
	}): Promise<NodeBacktestExecution> {
		const executionId = `candidate_${input.caseRef.caseId}_${input.repetition}`;
		const runDirectory = this.runDirectory(input.run.goalId, input.run.id);
		const recordDirectory = join(runDirectory, "executions", executionId);
		const startedAt = Date.now();
		let result;
		let candidateCaseRef: NodeBacktestCaseRef | undefined;
		try {
			const bundledPrompt = input.run.candidate.promptBundle
				? candidatePromptForCase(input.run.candidate.promptBundle, input.caseRef)
				: undefined;
			const promptOverride = bundledPrompt ?? input.run.candidate.promptOverride;
			result = await this.module.replay({
				casePath: input.casePath,
				sourceRunDirectory: input.sourceRunDirectory,
				harnessWorkspaceDirectory: input.workspaceDirectory,
				recordDirectory,
				workDirectory: join(recordDirectory, "work"),
				artifactStore: new RunArtifactStore(recordDirectory),
				runner: withPromptOverride(this.runner, promptOverride),
				candidateCase: {
					sourceRunId: `${input.run.id}::executions::${executionId}`,
					capabilitySnapshotId: input.run.candidate.capabilitySnapshotId,
				},
				...(promptOverride
					? { promptOverride }
					: {}),
				signal: input.signal,
			});
			// Candidate Evidence 是 fail-closed 的。Capture 本身由各 Recipe 在捕获点强制
			// （见 wiki-replay、podcast-replay、prime-search-replay 和 agent-stage-runtime）；
			// 这里只拒绝无法归属的多份 Candidate Case。
			const captured = findNodeEvaluationCases(recordDirectory, input.run.agentId);
			if (captured.length > 1) {
				throw new Error(
					`Candidate Replay produced ${captured.length} Candidate Cases for Agent '${input.run.agentId}'; Evidence is ambiguous`,
				);
			}
			if (captured.length === 1) {
				candidateCaseRef = { sourceRunId: captured[0]!.value.runId, caseId: captured[0]!.value.caseId };
			}
		} catch (error) {
			if (input.signal.aborted) throw error;
			const message = toErrorMessage(error);
			const partial = inspectPartialReplay({ recordDirectory, startedAt, agentId: input.run.agentId });
			const artifact = new RunArtifactStore(recordDirectory).publishText(`${JSON.stringify({
				schema_version: 1,
				status: "failed",
				error: message,
			}, null, 2)}\n`, "failure.json");
			return {
				id: executionId,
				caseRef: input.caseRef,
				repetition: input.repetition,
				variant: "candidate",
				status: "failed",
				error: message,
				artifact: {
					ref: relative(realpathSync(runDirectory), artifact.absolutePath).split(sep).join("/"),
					sha256: artifact.sha256,
					byteLength: artifact.byteLength,
					directory: false,
				},
				metrics: { ...partial.usage, turns: 0, toolCalls: partial.toolCalls, durationMs: partial.durationMs },
				refs: Object.fromEntries(Object.entries(partial.refs).map(([name, ref]) => [
					name,
					ref ? `executions/${executionId}/${ref}` : ref,
				])) as NodeExecutionRefs,
			};
		}
		return {
			id: executionId,
			caseRef: input.caseRef,
			repetition: input.repetition,
			variant: "candidate",
			status: "completed",
			...(candidateCaseRef ? { candidateCaseRef } : {}),
			artifact: {
				ref: relative(realpathSync(runDirectory), result.artifact.absolutePath).split(sep).join("/"),
				sha256: result.artifact.sha256,
				byteLength: result.artifact.byteLength,
				directory: "files" in result.artifact,
			},
			metrics: {
				inputTokens: result.usage.inputTokens,
				outputTokens: result.usage.outputTokens,
				costUsd: result.usage.costUsd,
				calls: result.usage.calls,
				turns: result.turns,
				toolCalls: result.toolCalls,
				durationMs: Date.now() - startedAt,
			},
		};
	}

	private evaluationArtifact(run: NodeBacktestRun, execution: NodeBacktestExecution): NodeBacktestEvaluationArtifact {
		const store = new RunArtifactStore(this.runDirectory(run.goalId, run.id));
		if (execution.artifact.directory) {
			const artifact = store.openDirectory({ relative_path: execution.artifact.ref,
				sha256: execution.artifact.sha256, byte_length: execution.artifact.byteLength });
			assertArtifactIdentity(execution, artifact);
			return {
				sha256: artifact.sha256,
				byteLength: artifact.byteLength,
				directory: true,
				files: artifact.files,
			};
		}
		const artifact = store.describeFile(execution.artifact.ref);
		assertArtifactIdentity(execution, artifact);
		return {
			sha256: artifact.sha256,
			byteLength: artifact.byteLength,
			directory: false,
			...(artifact.byteLength <= INLINE_ARTIFACT_BYTES
				? { content: readFileSync(artifact.absolutePath, "utf-8") }
				: {}),
		};
	}

	private observedEvaluationArtifact(goalId: string, caseRef: NodeBacktestCaseRef): NodeBacktestEvaluationArtifact {
		const casePath = this.casePath(goalId, caseRef);
		const value = readNodeEvaluationCase(casePath, this.caseLocation(goalId, caseRef).sourceRunDirectory);
		const output = value.observed.output;
		if (!output) throw new Error(`Node Case '${caseRef.caseId}' has no Observed Baseline output`);
		const store = new RunArtifactStore(dirname(casePath));
		if (output.directory) {
			const artifact = store.openDirectory({ relative_path: output.ref, sha256: output.sha256, byte_length: output.byteLength });
			if (artifact.sha256 !== output.sha256 || artifact.byteLength !== output.byteLength) {
				throw new Error(`Observed Baseline artifact changed: ${output.ref}`);
			}
			return {
				sha256: artifact.sha256,
				byteLength: artifact.byteLength,
				directory: true,
				files: artifact.files,
			};
		}
		const artifact = store.describeFile(output.ref);
		if (artifact.sha256 !== output.sha256 || artifact.byteLength !== output.byteLength) {
			throw new Error(`Observed Baseline artifact changed: ${output.ref}`);
		}
		return {
			sha256: artifact.sha256,
			byteLength: artifact.byteLength,
			directory: false,
			...(artifact.byteLength <= INLINE_ARTIFACT_BYTES
				? { content: readFileSync(artifact.absolutePath, "utf-8") }
				: {}),
		};
	}

	private evaluationInput(goalId: string, caseRef: NodeBacktestCaseRef): NodeBacktestEvaluationInput {
		const casePath = this.casePath(goalId, caseRef);
		const sourceRunDirectory = this.caseLocation(goalId, caseRef).sourceRunDirectory;
		const value = readNodeEvaluationCase(casePath, sourceRunDirectory);
		const input = new RunArtifactStore(sourceRunDirectory).describeDirectory(value.input.ref);
		const caseDirectory = dirname(casePath);
		const promptPath = resolve(caseDirectory, value.request.userPrompt.ref);
		const promptRelative = relative(caseDirectory, promptPath);
		if (!promptRelative || promptRelative === ".." || promptRelative.startsWith(`..${sep}`) || isAbsolute(promptRelative)) {
			throw new Error("Node Case user Prompt escapes its directory");
		}
		const inline = input.byteLength <= INLINE_ARTIFACT_BYTES;
		return {
			userPrompt: readFileSync(promptPath, "utf-8"),
			sha256: input.sha256,
			byteLength: input.byteLength,
			files: input.files.map((file) => ({
				...file,
				...(inline ? { content: readFileSync(join(input.absolutePath, file.relativePath), "utf-8") } : {}),
			})),
		};
	}

	private resumeInterruptedRuns(): void {
		for (const goalId of this.options.listGoalIds()) {
			for (const run of this.list(goalId, 500)) {
				if (run.status !== "queued" && run.status !== "running") continue;
				const resumed: NodeBacktestRun = run.status === "running"
					? { ...run, status: "queued", executions: [], pairs: [], updatedAt: new Date().toISOString(), error: "requeued after server restart" }
					: run;
				if (resumed !== run) {
					rmSync(join(this.runDirectory(goalId, run.id), "executions"), { recursive: true, force: true });
					this.save(resumed);
				}
				this.queue.push({ goalId, runId: run.id });
			}
		}
	}

	private requireRun(goalId: string, runId: string): NodeBacktestRun {
		const run = this.read(goalId, runId);
		if (!run) throw new Error(`Unknown Node Backtest '${runId}'`);
		return run;
	}

	private goalDirectory(goalId: string): string {
		return join(this.options.workspaceDir, requiredSegment(goalId, "Goal id"));
	}

	private assertRuntimeBuild(expected?: string, expectedAgentBundleSha256?: string): void {
		const current = applicationBuildIdentity(this.options.applicationDir ?? process.cwd());
		if (current !== this.loadedRuntimeBuild) {
			throw new Error(`Telomi Runtime loaded '${this.loadedRuntimeBuild}' but repository is '${current}'; restart Telomi before Candidate Replay`);
		}
		if (expected && expected !== this.loadedRuntimeBuild) {
			throw new Error(`Candidate expected Runtime build '${expected}' but Telomi loaded '${this.loadedRuntimeBuild}'`);
		}
		if (expectedAgentBundleSha256 && expectedAgentBundleSha256 !== this.loadedAgentBundleSha256) {
			throw new Error(`Candidate expected Agent Bundle '${expectedAgentBundleSha256}' but Telomi loaded '${this.loadedAgentBundleSha256}'`);
		}
	}

	private sourceRunsDirectories(goalId: string): string[] {
		return [...capturedCaseRunRoots(this.options.workspaceDir, goalId),
			join(serverRuntimeDirForGoal(goalId, this.options.workspaceDir), "evaluation/provider-child-cases")];
	}

	private importedCasesDirectory(goalId: string): string {
		return join(serverRuntimeDirForGoal(goalId, this.options.workspaceDir), "evaluation/imported-cases");
	}

	private caseLocation(goalId: string, ref: NodeBacktestCaseRef): { casePath: string; sourceRunDirectory: string } {
		const sourceRunId = requiredSegment(ref.sourceRunId, "Source Run id");
		const caseId = requiredSegment(ref.caseId, "Node Case id");
		const native = this.sourceRunsDirectories(goalId).map((root) => {
			const sourceRunDirectory = join(root, sourceRunId);
			return { sourceRunDirectory, casePath: join(sourceRunDirectory, "node-evaluation", "cases", caseId, "manifest.json") };
		}).filter((location) => existsSync(location.casePath));
		if (native.length > 1) throw new Error(`Ambiguous Node Case '${sourceRunId}/${caseId}'`);
		if (native[0]) return native[0];
		const nestedNative = this.sourceRunsDirectories(goalId).flatMap((root) => existsSync(root)
			? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
				const sourceRunDirectory = join(root, entry.name);
				const casePath = join(sourceRunDirectory, "node-evaluation", "cases", caseId, "manifest.json");
				if (!existsSync(casePath)) return [];
				try {
					return (JSON.parse(readFileSync(casePath, "utf-8")) as { runId?: unknown }).runId === sourceRunId
						? [{ sourceRunDirectory, casePath }] : [];
				} catch {
					return [];
				}
			}) : []);
		if (nestedNative.length > 1) throw new Error(`Ambiguous Node Case '${sourceRunId}/${caseId}'`);
		if (nestedNative[0]) return nestedNative[0];
		const replay = this.candidateReplayCaseLocations(goalId, caseId).filter((location) => {
			try {
				return (JSON.parse(readFileSync(location.casePath, "utf-8")) as { runId?: unknown }).runId === sourceRunId;
			} catch {
				return false;
			}
		});
		if (replay.length > 1) throw new Error(`Ambiguous Node Case '${sourceRunId}/${caseId}'`);
		if (replay[0]) return replay[0];
		const importedRoot = this.importedCasesDirectory(goalId);
		const imported = existsSync(importedRoot)
			? readdirSync(importedRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
				const sourceRunDirectory = join(importedRoot, entry.name);
				const casePath = join(sourceRunDirectory, "node-evaluation", "cases", caseId, "manifest.json");
				if (!existsSync(casePath)) return [];
				try {
					const value = JSON.parse(readFileSync(casePath, "utf-8")) as { runId?: unknown };
					return value.runId === sourceRunId ? [{ sourceRunDirectory, casePath }] : [];
				} catch {
					return [];
				}
			})
			: [];
		if (imported.length !== 1) throw new Error(`Unknown or ambiguous Node Case '${sourceRunId}/${caseId}'`);
		return imported[0]!;
	}

	private casePath(goalId: string, ref: NodeBacktestCaseRef): string {
		return this.caseLocation(goalId, ref).casePath;
	}

	private candidateReplayCaseLocations(goalId: string, caseId?: string): Array<{ casePath: string; sourceRunDirectory: string }> {
		const root = this.runsDirectory(goalId);
		if (!existsSync(root)) return [];
		return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((run) => {
			const executions = join(root, run.name, "executions");
			if (!existsSync(executions)) return [];
			return readdirSync(executions, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((execution) => {
				const sourceRunDirectory = join(executions, execution.name);
				const cases = join(sourceRunDirectory, "node-evaluation", "cases");
				if (!existsSync(cases)) return [];
				const ids = caseId ? [caseId] : readdirSync(cases, { withFileTypes: true })
					.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
				return ids.map((id) => ({ sourceRunDirectory, casePath: join(cases, id, "manifest.json") }))
					.filter((location) => existsSync(location.casePath));
			});
		});
	}

	private runsDirectory(goalId: string): string {
		return nodeBacktestRunsDirectory(this.options.workspaceDir, goalId);
	}

	private capabilitySnapshotsDirectory(goalId: string): string {
		return join(serverRuntimeDirForGoal(goalId, this.options.workspaceDir), "evaluation/capability-snapshots");
	}

	private capabilitySnapshotContentDirectory(goalId: string, snapshotId: string): string {
		return join(this.capabilitySnapshotsDirectory(goalId), safeCapabilitySnapshotId(snapshotId), "content");
	}

	readCapabilitySnapshot(goalId: string, snapshotId: string): NodeBacktestCapabilitySnapshot {
		return this.requireCapabilitySnapshot(goalId, snapshotId);
	}

	private requireCapabilitySnapshot(goalId: string, snapshotId: string): NodeBacktestCapabilitySnapshot {
		const id = safeCapabilitySnapshotId(snapshotId);
		const root = join(this.capabilitySnapshotsDirectory(goalId), id);
		const manifestPath = join(root, "manifest.json");
		if (!existsSync(manifestPath)) throw new Error(`Unknown Capability Snapshot '${id}'`);
		const snapshot = JSON.parse(readFileSync(manifestPath, "utf-8")) as NodeBacktestCapabilitySnapshot;
		if (snapshot.schemaVersion !== 1 || snapshot.id !== id || snapshot.goalId !== goalId
			|| snapshot.workspaceContentHash !== id.slice("caps_".length)) {
			throw new Error(`Capability Snapshot '${id}' manifest is invalid`);
		}
		const content = join(root, "content");
		if (!existsSync(content) || capabilityContentHash(content) !== snapshot.workspaceContentHash) {
			throw new Error(`Capability Snapshot '${id}' content changed`);
		}
		return snapshot;
	}

	private runDirectory(goalId: string, runId: string): string {
		return join(this.runsDirectory(goalId), requiredSegment(runId, "Node Backtest id"));
	}

	private runPath(goalId: string, runId: string): string {
		return join(this.runDirectory(goalId, runId), "run.json");
	}

	private save(run: NodeBacktestRun): void {
		const path = this.runPath(run.goalId, run.id);
		if (existsSync(path)) {
			const current = parseRun(readFileSync(path, "utf-8"));
			if (current && isTerminalStatus(current.status) && current.status !== run.status) return;
			if (current?.status === "cancelled" && run.status === "cancelled" && current.finishedAt) {
				run = { ...run, finishedAt: current.finishedAt };
			}
		}
		// activeExecution 是只读投影，不写入 Run。
		const { activeExecution: _activeExecution, ...persisted } = run;
		writeFileAtomic(path, `${JSON.stringify(persisted, null, 2)}\n`);
	}

	private activeKey(goalId: string, runId: string): string {
		return `${goalId}:${runId}`;
	}
}

/** Recovers usage, tool calls, duration and Trace refs of a Candidate execution that failed mid-flight. */
function inspectPartialReplay(input: {
	agentId: string;
	recordDirectory: string;
	startedAt: number;
}): {
	usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
	toolCalls: number;
	durationMs: number;
	refs: NodeExecutionRefs;
} {
	const jsonlFiles = input.agentId === "provider-child"
		? [join(input.recordDirectory, "runtime/trace.jsonl")].filter(existsSync)
		: existsSync(input.recordDirectory)
		? listFilesRecursive(input.recordDirectory, { absolute: true, sort: false, strict: true }).filter((path) => path.endsWith(".jsonl"))
		: [];
	const traces = jsonlFiles.filter((path) => (input.agentId === "provider-child" || basename(path).includes("--")) && !basename(path).startsWith("runtime--"));
	const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
	let toolCalls = 0;
	let firstEventAt = Number.POSITIVE_INFINITY;
	let lastEventAt = 0;
	for (const trace of traces) {
		const parsed = readCompleteJsonLines(trace);
		for (const entry of parsed.entries) {
			const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
			const eventAt = timestampMs(record.timestamp);
			if (eventAt !== undefined) {
				firstEventAt = Math.min(firstEventAt, eventAt);
				lastEventAt = Math.max(lastEventAt, eventAt);
			}
			const message = record.type === "message" && record.message && typeof record.message === "object"
				? record.message as Record<string, unknown>
				: record;
			if (message.role !== "assistant") continue;
			const modelUsage = message.usage && typeof message.usage === "object"
				? message.usage as Record<string, unknown>
				: {};
			const cost = modelUsage.cost && typeof modelUsage.cost === "object"
				? modelUsage.cost as Record<string, unknown>
				: {};
			usage.inputTokens += finiteNumber(modelUsage.input);
			usage.outputTokens += finiteNumber(modelUsage.output);
			usage.costUsd += finiteNumber(cost.total);
			usage.calls += 1;
			if (Array.isArray(message.content)) {
				toolCalls += message.content.filter((part) => part && typeof part === "object"
					&& (part as { type?: unknown }).type === "toolCall").length;
			}
		}
	}
	const ref = (path: string | undefined) => path
		? relative(input.recordDirectory, path).split(sep).join("/")
		: undefined;
	return {
		usage,
		toolCalls,
		durationMs: firstEventAt < Number.POSITIVE_INFINITY && lastEventAt >= firstEventAt
			? Math.max(1, lastEventAt - firstEventAt)
			: Math.max(1, Date.now() - input.startedAt),
		refs: {
			...(traces[0] ? { agentTrace: ref(traces[0]) } : {}),
		},
	};
}

function readCompleteJsonLines(path: string): { entries: unknown[]; truncated: boolean } {
	const lines = readFileSync(path, "utf-8").split(/\r?\n/u).filter(Boolean);
	const entries: unknown[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		try {
			entries.push(JSON.parse(lines[index]!) as unknown);
		} catch (error) {
			if (index === lines.length - 1) return { entries, truncated: true };
			throw new Error(`Invalid partial trace JSONL at ${path}:${index + 1}: ${toErrorMessage(error)}`);
		}
	}
	return { entries, truncated: false };
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isTerminalStatus(status: NodeBacktestStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function withPromptOverride(
	runner: AgentStageRunner,
	override: NodeBacktestPromptOverride | undefined,
): AgentStageRunner {
	if (!override?.systemPrompt && !override?.userPrompt) return runner;
	return {
		runStage: <T>(request: AgentStageRequest<T>) => runner.runStage({
			...request,
			...(override.systemPrompt ? { systemPrompt: override.systemPrompt } : {}),
			...(override.userPrompt ? { userPrompt: override.userPrompt } : {}),
		}),
	};
}

function validateRequest(request: NodeBacktestRequest, registeredAgentIds: ReadonlySet<string>): NodeBacktestRequest {
	if (!request || typeof request !== "object") throw new Error("Node Backtest request is required");
	if ("baseline" in request) {
		throw new Error("baseline is not accepted; Observed Baseline comes from each Node Case");
	}
	if (!request.agentId?.trim()) throw new Error("agentId is required");
	if (!registeredAgentIds.has(request.agentId.trim())) {
		throw new Error(`Unknown Workspace Agent '${request.agentId.trim()}'`);
	}
	if (!Array.isArray(request.cases) || request.cases.length === 0 || request.cases.length > MAX_CASES) {
		throw new Error(`cases must contain between 1 and ${MAX_CASES} Node Case refs`);
	}
	const cases = request.cases.map((item) => ({
		sourceRunId: requiredSegment(item?.sourceRunId, "Source Run id"),
		caseId: requiredSegment(item?.caseId, "Node Case id"),
	}));
	if (new Set(cases.map((item) => `${item.sourceRunId}:${item.caseId}`)).size !== cases.length) {
		throw new Error("cases contains duplicate Node Case refs");
	}
	const repetitions = request.repetitions ?? 2;
	if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
		throw new Error(`repetitions must be between 1 and ${MAX_REPETITIONS}`);
	}
	if (typeof request.rubricId !== "string" || !request.rubricId.trim()) throw new Error("rubricId is required");
	return {
		agentId: request.agentId.trim(),
		cases,
		candidate: validateVariant(request.candidate, "candidate"),
		repetitions,
		rubricId: request.rubricId.trim(),
	};
}

function validateVariant(value: NodeBacktestVariantRequest, label: string): NodeBacktestVariantRequest {
	if (!value || typeof value !== "object") throw new Error(`${label} is required`);
	const promptOverride = value.promptOverride;
	if (promptOverride !== undefined && (!promptOverride || typeof promptOverride !== "object")) {
		throw new Error(`${label}.promptOverride must be an object`);
	}
	const validated = promptOverride ? validatePromptOverride(promptOverride, `${label}.promptOverride`) : undefined;
	const capabilitySnapshotId = value.capabilitySnapshotId === undefined
		? undefined
		: safeCapabilitySnapshotId(value.capabilitySnapshotId);
	const promptMode = value.promptMode;
	if (promptMode !== undefined && promptMode !== "observed" && promptMode !== "override") {
		throw new Error(`${label}.promptMode must be 'observed' or 'override'`);
	}
	const expectedRuntimeBuild = value.expectedRuntimeBuild;
	if (expectedRuntimeBuild !== undefined && (typeof expectedRuntimeBuild !== "string" || !expectedRuntimeBuild.trim())) {
		throw new Error(`${label}.expectedRuntimeBuild must be non-empty text`);
	}
	const expectedAgentBundleSha256 = value.expectedAgentBundleSha256;
	if (expectedAgentBundleSha256 !== undefined
		&& (typeof expectedAgentBundleSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedAgentBundleSha256))) {
		throw new Error(`${label}.expectedAgentBundleSha256 must be a sha256`);
	}
	return {
		...(promptMode ? { promptMode } : {}),
		...(validated ? { promptOverride: validated } : {}),
		...(capabilitySnapshotId ? { capabilitySnapshotId } : {}),
		...(expectedRuntimeBuild ? { expectedRuntimeBuild: expectedRuntimeBuild.trim() } : {}),
		...(expectedAgentBundleSha256 ? { expectedAgentBundleSha256 } : {}),
	};
}

function resolveCandidatePromptBundle(
	cases: readonly { ref: NodeBacktestCaseRef; value: NodeEvaluationCase; casePath: string }[],
	candidate: NodeBacktestVariantRequest,
): NodeBacktestCandidatePromptBundle {
	if (!candidate.promptMode) {
		throw new Error("Candidate Capability Bundle requires promptMode 'observed' or 'override'");
	}
	if (candidate.promptMode === "observed" && candidate.promptOverride) {
		throw new Error("Candidate promptMode 'observed' does not accept promptOverride");
	}
	if (candidate.promptMode === "override"
		&& (!candidate.promptOverride?.systemPrompt || !candidate.promptOverride.userPrompt)) {
		throw new Error("Candidate promptMode 'override' requires complete systemPrompt and userPrompt");
	}
	const prompts = cases.map(({ ref, value, casePath }) => {
		const systemPrompt = candidate.promptMode === "override"
			? candidate.promptOverride!.systemPrompt!
			: readNodeEvaluationFile(casePath, value.request.systemPrompt);
		const userPrompt = candidate.promptMode === "override"
			? candidate.promptOverride!.userPrompt!
			: readNodeEvaluationFile(casePath, value.request.userPrompt);
		return {
			caseRef: ref,
			systemPrompt,
			userPrompt,
			systemSha256: sha256(systemPrompt),
			userSha256: sha256(userPrompt),
		};
	});
	const identity = { source: candidate.promptMode, cases: prompts };
	return { schemaVersion: 1, ...identity, sha256: sha256(stableJson(identity)) };
}

function candidatePromptForCase(
	bundle: NodeBacktestCandidatePromptBundle,
	caseRef: NodeBacktestCaseRef,
): Required<NodeBacktestPromptOverride> {
	if (bundle.schemaVersion !== 1
		|| bundle.sha256 !== sha256(stableJson({ source: bundle.source, cases: bundle.cases }))) {
		throw new Error("Candidate Prompt Bundle identity changed");
	}
	const prompt = bundle.cases.find((item) => item.caseRef.sourceRunId === caseRef.sourceRunId
		&& item.caseRef.caseId === caseRef.caseId);
	if (!prompt || prompt.systemSha256 !== sha256(prompt.systemPrompt)
		|| prompt.userSha256 !== sha256(prompt.userPrompt)) {
		throw new Error(`Candidate Prompt Bundle has no valid Prompt for Case '${caseRef.caseId}'`);
	}
	return { systemPrompt: prompt.systemPrompt, userPrompt: prompt.userPrompt };
}

function safeCapabilitySnapshotId(value: unknown): string {
	if (typeof value !== "string" || !/^caps_[a-f0-9]{64}$/u.test(value)) {
		throw new Error("capabilitySnapshotId must be an immutable Capability Snapshot id");
	}
	return value;
}

function validatePromptOverride(promptOverride: NodeBacktestPromptOverride, label: string): NodeBacktestPromptOverride {
	for (const [name, prompt] of Object.entries(promptOverride)) {
		if (!["systemPrompt", "userPrompt"].includes(name)) throw new Error(`${label} contains unknown field '${name}'`);
		if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`${label}.${name} must be non-empty text`);
		if (prompt.length > MAX_PROMPT_CHARACTERS) throw new Error(`${label}.${name} is too large`);
	}
	return { ...promptOverride };
}

function aggregateObserved(cases: NodeEvaluationCase[]): NodeBacktestAggregateMetrics {
	return cases.reduce<NodeBacktestAggregateMetrics>((total, value) => ({
		executions: total.executions + 1,
		inputTokens: total.inputTokens + (value.observed.metrics?.inputTokens ?? 0),
		outputTokens: total.outputTokens + (value.observed.metrics?.outputTokens ?? 0),
		costUsd: total.costUsd + (value.observed.metrics?.costUsd ?? 0),
		calls: total.calls + (value.observed.metrics?.calls ?? 0),
		turns: total.turns + (value.observed.metrics?.turns ?? 0),
		toolCalls: total.toolCalls + (value.observed.metrics?.toolCalls ?? 0),
		durationMs: total.durationMs + (value.observed.durationMs ?? 0),
	}), emptyAggregate());
}

function emptyAggregate(): NodeBacktestAggregateMetrics {
	return {
		executions: 0,
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		calls: 0,
		turns: 0,
		toolCalls: 0,
		durationMs: 0,
	};
}

function parseRun(text: string): NodeBacktestRun | null {
	try {
		const run = JSON.parse(text) as NodeBacktestRun;
		if (run.schemaVersion !== RUN_SCHEMA_VERSION || !run.id || !run.goalId || !run.agentId) return null;
		if (run.mode !== "candidate-replay") return null;
		if (!["queued", "running", "awaiting_evaluation", "completed", "failed", "cancelled"].includes(run.status)) return null;
		return { ...run, kind: run.kind === "recovery" ? "recovery" : "quality" };
	} catch {
		return null;
	}
}

function assertArtifactIdentity(
	execution: { artifact?: { ref: string; sha256: string; byteLength: number } },
	artifact: { sha256: string; byteLength: number },
): void {
	if (!execution.artifact) throw new Error("Node Backtest execution has no artifact");
	if (execution.artifact.sha256 !== artifact.sha256 || execution.artifact.byteLength !== artifact.byteLength) {
		throw new Error(`Node Backtest artifact changed: ${execution.artifact.ref}`);
	}
}

function verifiedNestedFile(
	root: string,
	expected: { relativePath: string; sha256: string; byteLength: number },
): string {
	const path = resolve(root, expected.relativePath);
	const rel = relative(root, path);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Artifact file escapes its directory");
	}
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Artifact file is not a safe regular file");
	const real = realpathSync(path);
	const content = readFileSync(real);
	if (content.byteLength !== expected.byteLength || sha256(content) !== expected.sha256) {
		throw new Error(`Artifact file changed: ${expected.relativePath}`);
	}
	return real;
}

/**
 * 正式 Capture 拥有的全部 Run 根。Capture 只会把 Case 写到这些 Run 的
 * `node-evaluation/cases` 下；Candidate Replay Run、导入的 Bundle 和
 * Capability Snapshot 都在 `evaluation/` 里，因此这个列表就是 Case 保留策略
 * 唯一可以触碰的所有权边界。
 */
export function nodeBacktestRunsDirectory(workspaceDir: string, goalId: string): string {
	return join(serverRuntimeDirForGoal(goalId, workspaceDir), "evaluation/node-backtests");
}

export function capturedCaseRunRoots(workspaceDir: string, goalId: string): string[] {
	const root = serverRuntimeDirForGoal(goalId, workspaceDir);
	return [
		join(root, "runs"),
		join(root, "main-agent", "runs"),
		join(root, "wiki-updates"),
		// One terminal Evolution Run is one captured Case, written into the Run's own record
		// directory. It is a Capture-owned Run root like any other, so retention treats the
		// Case the same way and never touches the Evolution Run record around it.
		join(root, "evolution", "runs"),
		// One Research Schedule Review is one recorded execution with its own Case.
		join(root, "research", "schedule-reviews"),
		daemonRunsDirByName(join(workspaceDir, requiredSegment(goalId, "Goal id")), "podcast-ai"),
	];
}

/**
 * Quality 与 Recovery 的分流（计划 §9.2、§9.3）。两类 Run 的结论不可比 - 一个是
 * 相对 Observed 的质量判断，一个是故障是否恢复 - 因此一个 Run 不允许混装。
 *
 * Recovery Case 的证据是 fail-closed 的：终态、错误和终态 Workspace 或 Trace 缺
 * 任何一项都在排队时被拒绝，不会先跑完 Candidate 再发现无从判断，也不会用一个
 * 空的 Observed 侧伪造 A/B Pair。
 */
function resolveCaseClass(values: readonly NodeEvaluationCase[]): NodeBacktestCaseClass {
	const recovery = values.filter((value) => !value.observed.output);
	if (recovery.length === 0) return "quality";
	if (recovery.length !== values.length) {
		throw new Error("Node Backtest cannot mix Quality Cases and Recovery Cases in one Run");
	}
	for (const value of recovery) assertRecoveryEvidence(value);
	return "recovery";
}

function assertRecoveryEvidence(value: NodeEvaluationCase): void {
	const missing: string[] = [];
	if (value.status === "succeeded") missing.push("a terminal failure status");
	if (!value.observed.error && value.observed.validationErrors.length === 0) missing.push("terminal error evidence");
	if (!value.observed.terminalWorkspace && !value.observed.trace && !value.observed.traceDirectories?.length) {
		missing.push("a terminal workspace or trace");
	}
	if (missing.length) {
		throw new Error(
			`Recovery Case '${value.caseId}' has no Observed Baseline output and is missing ${missing.join(", ")}`,
		);
	}
}

function assertQualityRun(run: NodeBacktestRun, runId: string): void {
	if (run.kind === "recovery") {
		throw new Error(`Node Backtest '${runId}' is a Recovery Replay and has no Observed Baseline to judge against`);
	}
}

function requiredSegment(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} is required`);
	const segment = value.trim();
	if (!isFileNameSegment(segment)) throw new Error(`${label} is invalid`);
	return segment;
}

function capabilityContentHash(goalDirectory: string, wikiPaths?: readonly string[]): string {
	return sha256(stableJson({
		skills: WORKSPACE_AGENT_IDS.map((agentId) => ({
			agentId,
			sha256: snapshotSkills([join(goalDirectory, "skills", agentId)]).sha256,
		})),
		wiki: hashDirectory(join(goalDirectory, "wiki"), capabilityWikiFilter(wikiPaths)),
	}));
}

/** Omit wikiPaths only when restoring an already frozen Snapshot, including historical ones. */
export function materializeCapabilities(goalDirectory: string, destination: string, wikiPaths?: readonly string[]): void {
	const includeWiki = capabilityWikiFilter(wikiPaths);
	for (const agentId of WORKSPACE_AGENT_IDS) {
		materializeSkills(
			snapshotSkills([join(goalDirectory, "skills", agentId)]),
			join(destination, "skills", agentId),
		);
	}
	if (existsSync(join(goalDirectory, "wiki"))) {
		cpSync(join(goalDirectory, "wiki"), join(destination, "wiki"), {
			recursive: true,
			...(includeWiki ? { filter: (source: string) => includeWiki(relative(join(goalDirectory, "wiki"), source)) } : {}),
		});
	}
}

/** Keep selected Wiki subtrees and their ancestors, without traversing unrelated history. */
function capabilityWikiFilter(workspacePaths?: readonly string[]): ((path: string) => boolean) | undefined {
	if (!workspacePaths) return undefined;
	const paths = workspacePaths.map((path) => {
		assertSafeRelativePath(path, "Capability mount");
		return normalize(path.replaceAll("\\", "/")).replace(/\/$/u, "");
	}).filter((path) => path === "wiki" || path.startsWith("wiki/"));
	return (path) => paths.some((selected) => {
		const candidate = path ? `wiki/${path}` : "wiki";
		return candidate === selected || candidate.startsWith(`${selected}/`) || selected.startsWith(`${candidate}/`);
	});
}

function gitOutput(cwd: string, args: string[]): string {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	// ponytail: bound synchronous Git output at 16 MiB; stream-hash if larger dirty worktrees become normal.
	const result = spawnSync("git", args, { cwd, env, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} failed`);
	return result.stdout;
}

function applicationBuildIdentity(directory: string): string {
	const head = gitOutput(directory, ["rev-parse", "HEAD"]).trim();
	const status = gitOutput(directory, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const diff = gitOutput(directory, ["diff", "--binary", "HEAD"]);
	return status ? `${head}+dirty.${sha256(`${status}\n${diff}`).slice(0, 16)}` : head;
}

function projectFrozenRun(run: NodeBacktestRun, runDirectory: string): NodeBacktestRun {
	// 只保留有值的 ref。ref 表是契约的一部分，`{ agentTrace: undefined }` 会被 JSON
	// 序列化悄悄丢掉，却会让响应验证看到一个 undefined 值。
	const executionRefs = (execution: { id: string; refs?: NodeExecutionRefs }): NodeExecutionRefs =>
		Object.fromEntries(Object.entries({
			...execution.refs,
			...(run.agentId === "provider-child" ? providerChildTraceRefs(runDirectory, execution) : candidateTraceRefs(runDirectory, execution)),
			...(run.agentId === "prime-search" ? primeSearchTraceRefs(runDirectory, execution) : {}),
			...(run.agentId === "report-writer" ? reportWriterTraceRefs(runDirectory, execution) : {}),
			...(run.agentId === "podcast-writer" ? podcastWriterTraceRefs(runDirectory, execution) : {}),
			...(run.agentId === "main-agent" ? mainAgentTraceRefs(runDirectory, execution) : {}),
			...(["wiki-shard-builder", "wiki-curator"].includes(run.agentId)
				? wikiTraceRefs(runDirectory, execution) : {}),
		}).filter((entry): entry is [string, string] => Boolean(entry[1])));
	const activeExecution = projectCandidateActiveExecution(run, runDirectory, executionRefs);
	return {
		...run,
		executions: run.executions.map((execution) => ({
			...execution,
			refs: executionRefs(execution),
		})),
		...(activeExecution ? { activeExecution } : {}),
	};
}

function projectCandidateActiveExecution(
	run: NodeBacktestRun,
	runDirectory: string,
	executionRefs: (execution: { id: string; refs?: NodeExecutionRefs }) => NodeExecutionRefs,
): NodeBacktestActiveExecution | undefined {
	if (run.status !== "running") return undefined;
	const completed = new Set(run.executions.map((execution) => execution.id));
	for (const caseRef of run.cases) {
		for (let repetition = 1; repetition <= run.repetitions; repetition += 1) {
			const id = `candidate_${caseRef.caseId}_${repetition}`;
			if (completed.has(id)) continue;
			const executionRoot = join(runDirectory, "executions", id);
			return {
				id,
				caseRef,
				repetition,
				variant: "candidate",
				status: "running",
				refs: existsSync(executionRoot) ? executionRefs({ id, refs: {} }) : {},
			};
		}
	}
	return undefined;
}

function providerChildTraceRefs(runDirectory: string, execution: { id: string }): NodeExecutionRefs {
	const root = join(runDirectory, "executions", execution.id);
	return Object.fromEntries([
		["agentTrace", "runtime/trace.jsonl"], ["executionConditions", "runtime/execution-conditions.jsonl"],
		["providerCalls", "provider-calls.jsonl"],
	].filter(([, path]) => existsSync(join(root, path!)))
		.map(([key, path]) => [key!, relative(runDirectory, join(root, path!)).split(sep).join("/")]));
}

function candidateTraceRefs(
	runDirectory: string,
	execution: { id: string },
): NodeExecutionRefs {
	const executionRoot = join(runDirectory, "executions", execution.id);
	if (!existsSync(executionRoot)) return {};
	const files = readdirSync(executionRoot, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(executionRoot, entry.name))
		.sort();
	const relativeRef = (path: string) => relative(runDirectory, path).split(sep).join("/");
	const agentTraces = files.filter((path) => path.endsWith(".jsonl") && !basename(path).startsWith("runtime--"));
	const runtimeTraces = files.filter((path) => path.endsWith(".jsonl") && basename(path).startsWith("runtime--"));
	const systemPrompts = files.filter((path) => path.endsWith(".system-prompt.txt"));
	const userPrompts = files.filter((path) => path.endsWith(".user-prompt.txt"));
	return {
		...(agentTraces[0] ? { agentTrace: relativeRef(agentTraces[0]) } : {}),
		...Object.fromEntries(agentTraces.map((path, index) => [`agentTrace${index + 1}`, relativeRef(path)])),
		...(runtimeTraces[0] ? { runtimeTrace: relativeRef(runtimeTraces[0]) } : {}),
		...Object.fromEntries(runtimeTraces.map((path, index) => [`runtimeTrace${index + 1}`, relativeRef(path)])),
		...(systemPrompts[0] ? { systemPrompt: relativeRef(systemPrompts[0]) } : {}),
		...(userPrompts[0] ? { userPrompt: relativeRef(userPrompts[0]) } : {}),
	};
}

function reportWriterTraceRefs(
	runDirectory: string,
	execution: { id: string },
): NodeExecutionRefs {
	const executionRoot = join(runDirectory, "executions", execution.id);
	const runtimeRoot = join(executionRoot, "work", "runtime");
	if (!existsSync(runtimeRoot)) return {};
	const records = [...readRuntimeRecords(executionRoot, "evaluation")].reverse();
	const currentExecutionId = records.find((event) => event.agent === "report_writer"
		&& (event.type === "runtime.agent_bound" || event.type === "node_execution"))?.execution_id;
	const currentRuntime = typeof currentExecutionId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(currentExecutionId)
		? join(runtimeRoot, currentExecutionId) : undefined;
	const sessionRuntime = currentRuntime && existsSync(currentRuntime) && lstatSync(currentRuntime).isDirectory()
		? currentRuntime : runtimeRoot;
	const files = listFilesRecursive(sessionRuntime, { absolute: true, strict: true });
	const relativeRef = (path: string) => relative(runDirectory, path).split(sep).join("/");
	const find = (suffix: string) => files.find((path) => path.endsWith(`${sep}${suffix}`));
	const nativeRootTraceRef = records.find((event) => event.type === "node_execution" && event.agent === "report_writer"
		&& (currentExecutionId === undefined || event.execution_id === currentExecutionId))?.trace_ref;
	const rootTrace = typeof nativeRootTraceRef === "string"
		&& basename(nativeRootTraceRef) === nativeRootTraceRef
		&& existsSync(join(executionRoot, nativeRootTraceRef))
		? join(executionRoot, nativeRootTraceRef)
		: undefined;
	const childTraces = files.filter((path) => path.endsWith(".jsonl")
		&& path.includes(`${sep}session-artifacts${sep}`));
	const nativeRootTrace = files.find((path) =>
		/^session\/[^/]+\.jsonl$/u.test(relative(sessionRuntime, path).split(sep).join("/")));
	const rootEvents = find("root-events.jsonl");
	const kernelTrace = find("kernel-launches.jsonl");
	const noteToolTrace = find("note-tools.jsonl");
	const initialPrompt = find("initial-prompt.md");
	const delegationPrompt = find("delegation-prompt.md");
	const finalPrompt = find("final-prompt.md");
	const finalRepairPrompt = find("final-repair-prompt.md");
	const systemPrompt = find("system-prompt.md");
	const result = find("result.json");
	return {
		...(nativeRootTrace ? { agentTrace: relativeRef(nativeRootTrace), reportRootTrace: relativeRef(nativeRootTrace) }
			: rootTrace ? { agentTrace: relativeRef(rootTrace) } : {}),
		...(rootTrace ? { reportActivityTrace: relativeRef(rootTrace) } : {}),
		...Object.fromEntries(childTraces.map((path, index) => [`reportChildTrace${index + 1}`, relativeRef(path)])),
		...(rootEvents ? { reportRootEvents: relativeRef(rootEvents) } : {}),
		...(kernelTrace ? { reportKernelTrace: relativeRef(kernelTrace) } : {}),
		...(noteToolTrace ? { reportNoteToolTrace: relativeRef(noteToolTrace) } : {}),
		...(initialPrompt ? { reportInitialPrompt: relativeRef(initialPrompt) } : {}),
		...(delegationPrompt ? { reportDelegationPrompt: relativeRef(delegationPrompt) } : {}),
		...(finalPrompt ? { reportFinalPrompt: relativeRef(finalPrompt) } : {}),
		...(finalRepairPrompt ? { reportFinalRepairPrompt: relativeRef(finalRepairPrompt) } : {}),
		...(systemPrompt ? { reportSystemPrompt: relativeRef(systemPrompt) } : {}),
		...(result ? { reportRuntimeResult: relativeRef(result) } : {}),
	};
}

function podcastWriterTraceRefs(
	runDirectory: string,
	execution: { id: string },
): NodeExecutionRefs {
	const executionRoot = join(runDirectory, "executions", execution.id);
	const writerRoot = join(executionRoot, "work", "media", "podcast", "writer");
	if (!existsSync(writerRoot)) return {};
	const files = listFilesRecursive(writerRoot, { absolute: true, strict: true });
	const relativeRef = (path: string) => relative(runDirectory, path).split(sep).join("/");
	const writerRef = (path: string) => relative(writerRoot, path).split(sep).join("/");
	const rootTrace = files.find((path) => /^runtime\/session\/[^/]+\.jsonl$/u.test(writerRef(path)));
	const lifecycle = files.find((path) => writerRef(path) === "runtime/root-events.jsonl");
	const childTraces = files.filter((path) => /^runtime\/session-artifacts\/sub-[^/]+\/[^/]+\.jsonl$/u.test(writerRef(path)));
	const childMetadata = files.filter((path) => /^runtime\/session-artifacts\/sub-[^/]+\/rlm-subagent\.json$/u.test(writerRef(path)));
	const inputs = files.filter((path) => writerRef(path).startsWith("agent-workspace/inputs/"));
	const protocolFiles = files.filter((path) => /^agent-workspace\/(?:work|writer-output)\/.+$/u.test(writerRef(path))
		&& basename(path) !== ".complete");
	const kernelTrace = files.find((path) => writerRef(path) === "runtime/kernel-launches.jsonl");
	const result = files.find((path) => writerRef(path) === "runtime/result.json");
	return {
		...(rootTrace ? { agentTrace: relativeRef(rootTrace), podcastRootTrace: relativeRef(rootTrace) } : {}),
		...(lifecycle ? { podcastChildLifecycle: relativeRef(lifecycle) } : {}),
		...Object.fromEntries(childTraces.map((path, index) => [`podcastChildTrace${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(childMetadata.map((path, index) => [`podcastChildMetadata${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(inputs.map((path, index) => [`podcastInput${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(protocolFiles.map((path, index) => [`podcastProtocolFile${index + 1}`, relativeRef(path)])),
		...(kernelTrace ? { podcastKernelTrace: relativeRef(kernelTrace) } : {}),
		...(result ? { podcastRuntimeResult: relativeRef(result) } : {}),
	};
}

function mainAgentTraceRefs(
	runDirectory: string,
	execution: { id: string },
): NodeExecutionRefs {
	const traceRoot = join(runDirectory, "executions", execution.id, "main-agent-trace");
	if (!existsSync(traceRoot)) return {};
	const relativeRef = (name: string) => relative(runDirectory, join(traceRoot, name)).split(sep).join("/");
	const ref = (name: string) => existsSync(join(traceRoot, name)) ? relativeRef(name) : undefined;
	return {
		...(ref("main-agent.jsonl") ? { agentTrace: ref("main-agent.jsonl") } : {}),
		...(ref("runtime--main.jsonl") ? { runtimeTrace: ref("runtime--main.jsonl") } : {}),
		...(ref("route-trace.json") ? { routeDecision: ref("route-trace.json") } : {}),
		...(ref("publication.json") ? { publication: ref("publication.json") } : {}),
		...(ref("session.json") ? { session: ref("session.json") } : {}),
	};
}

function wikiTraceRefs(
	runDirectory: string,
	execution: { id: string },
): NodeExecutionRefs {
	const executionRoot = join(runDirectory, "executions", execution.id);
	if (!existsSync(executionRoot)) return {};
	const files = listFilesRecursive(executionRoot, { absolute: true, strict: true });
	const relativeRef = (path: string) => relative(runDirectory, path).split(sep).join("/");
	const executionRef = (path: string) => relative(executionRoot, path).split(sep).join("/");
	const rootTraces = files.filter((path) => path.endsWith(".jsonl")
		&& path.includes(`${sep}sessions${sep}sessions${sep}`));
	const sdkEvents = files.filter((path) => /runtime[/\\](?:(?:entity|concept)[/\\])?sdk-events\.jsonl$/u.test(path)
		&& path.includes(`${sep}work${sep}`));
	const childTraces = files.filter((path) => path.endsWith(".jsonl")
		&& /runtime[/\\](?:entity|concept)?[/\\]?session-artifacts[/\\]sub-/u.test(path));
	const systemPrompt = files.find((path) => /runtime[/\\]system-prompt\.md$/u.test(path));
	const userPrompts = files.filter((path) => /runtime[/\\](?:(?:entity|concept)[/\\])?user-prompt\.md$/u.test(path));
	const runtimeResult = files.find((path) => /runtime[/\\]result\.json$/u.test(path));
	const workerResults = files.filter((path) => {
		const ref = relative(executionRoot, path);
		return ref.endsWith(`${sep}result.json`) && ref.startsWith(`work${sep}`)
			&& !ref.includes(`${sep}runtime${sep}`);
	});
	const childMetadata = files.filter((path) => /^work\/(?:maintainer\/runtime\/(?:entity|concept)|curator-runtime)\/session-artifacts\/sub-[^/]+\/rlm-subagent\.json$/u.test(executionRef(path)));
	const plan = files.find((path) => /^work\/(?:maintainer|curator)\/work\/plan\.json$/u.test(executionRef(path)));
	const assignments = files.filter((path) => /^work\/(?:maintainer|curator)\/work\/assignments\/[^/]+\.json$/u.test(executionRef(path)));
	const childContract = files.find((path) => /^work\/(?:maintainer|curator)\/work\/child-contract\.md$/u.test(executionRef(path)));
	const inputs = files.filter((path) => /^work\/(?:(?:maintainer|curator)\/input\/|maintainer\/workspace\/notes\/).+$/u.test(executionRef(path)));
	const relationAssignment = files.find((path) => executionRef(path) === "work/curator/work/relation-assignment.json");
	const relationContract = files.find((path) => executionRef(path) === "work/curator/work/relation-contract.md");
	const rootTrace = rootTraces[0];
	return {
		...(rootTrace
			? { agentTrace: relativeRef(rootTrace) }
			: sdkEvents[0] ? { agentTrace: relativeRef(sdkEvents[0]) } : {}),
		...(sdkEvents[0] ? { wikiSdkEvents: relativeRef(sdkEvents[0]) } : {}),
		...Object.fromEntries(sdkEvents.map((path, index) => [`wikiSdkEvents${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(rootTraces.map((path, index) => [`wikiRootTrace${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(childTraces.map((path, index) => [`wikiChildTrace${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(childMetadata.map((path, index) => [`wikiChildMetadata${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(workerResults.map((path, index) => [`wikiWorkerResult${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(assignments.map((path, index) => [`wikiAssignment${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(inputs.map((path, index) => [`wikiInput${index + 1}`, relativeRef(path)])),
		...(plan ? { wikiPlan: relativeRef(plan) } : {}),
		...(childContract ? { wikiChildContract: relativeRef(childContract) } : {}),
		...(relationAssignment ? { wikiRelationAssignment: relativeRef(relationAssignment) } : {}),
		...(relationContract ? { wikiRelationContract: relativeRef(relationContract) } : {}),
		...(systemPrompt ? { wikiSystemPrompt: relativeRef(systemPrompt) } : {}),
		...(userPrompts[0] ? { wikiUserPrompt: relativeRef(userPrompts[0]) } : {}),
		...Object.fromEntries(userPrompts.map((path, index) => [`wikiUserPrompt${index + 1}`, relativeRef(path)])),
		...(runtimeResult ? { wikiRuntimeResult: relativeRef(runtimeResult) } : {}),
	};
}

function primeSearchTraceRefs(
	runDirectory: string,
	execution: { id: string; refs?: NodeExecutionRefs },
): NodeExecutionRefs {
	const executionRoot = join(runDirectory, "executions", execution.id);
	const publishedTraceRoot = join(executionRoot, "prime-search-traces");
	const workspacesRoot = join(executionRoot, "workspaces");
	const traceRoots = [
		...(existsSync(publishedTraceRoot) ? [publishedTraceRoot] : []),
		...(existsSync(workspacesRoot) ? readdirSync(workspacesRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(join(workspacesRoot, entry.name, "runtime")))
			.map((entry) => join(workspacesRoot, entry.name, "runtime")) : []),
	];
	const workspaceDecisionFiles = existsSync(workspacesRoot)
		? readdirSync(workspacesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
			const agentRoot = join(workspacesRoot, entry.name, "agent");
			const providerExecutions = join(agentRoot, "provider-executions");
			const ledgers = existsSync(providerExecutions)
				? readdirSync(providerExecutions, { withFileTypes: true }).filter((child) => child.isDirectory()).flatMap((child) => {
					const work = join(providerExecutions, child.name, "work");
					if (!existsSync(join(work, ".provider-assignment"))) return [];
					return existsSync(work) ? readdirSync(work, { withFileTypes: true })
						.filter((file) => file.isFile() && file.name.endsWith("_candidates.json"))
						.map((file) => join(work, file.name)) : [];
				}) : [];
			return ledgers;
		}) : [];
	if (traceRoots.length === 0 && workspaceDecisionFiles.length === 0) return {};
	const files = [...new Set(traceRoots.flatMap((root) => listFilesRecursive(root, { absolute: true, sort: false, strict: true })))].sort();
	const relativeRef = (path: string) => relative(runDirectory, path).split(sep).join("/");
	const acquisitionTrace = files.find((path) => path.endsWith(".jsonl")
		&& path.includes(`${sep}acquisition-session${sep}session${sep}`));
	const organizerTrace = files.find((path) => path.endsWith(".jsonl")
		&& path.includes(`${sep}organizer-session${sep}session${sep}`));
	const acquisitionSdkEvents = files.find((path) => path.endsWith(`${sep}acquisition-session${sep}sdk-events.jsonl`));
	const providerLog = files.find((path) => path.endsWith(`${sep}provider.jsonl`));
	const organizerDecision = files.find((path) => path.endsWith(`${sep}decisions${sep}organizer${sep}groups.json`));
	const organizerIndex = files.find((path) => path.endsWith(`${sep}decisions${sep}organizer${sep}index.json`));
	const childTraces = files.filter((path) => path.endsWith(".jsonl")
		&& path.includes(`${sep}acquisition-session${sep}session-artifacts${sep}`));
	const childMetadata = files.filter((path) => path.endsWith(`${sep}rlm-subagent.json`));
	const publishedCandidateLedgers = files.filter((path) => path.endsWith("_candidates.json")
		&& path.includes(`${sep}decisions${sep}provider-executions${sep}`));
	const candidateLedgers = (publishedCandidateLedgers.length > 0
		? publishedCandidateLedgers
		: workspaceDecisionFiles.filter((path) => path.endsWith("_candidates.json"))).sort();
	const kernelTraces = files.filter((path) => path.endsWith("kernel-launches.jsonl"));
	const rlmTraces = files.filter((path) => path.endsWith(".jsonl")
		&& path.includes(`${sep}agent${sep}rlm-ledger${sep}`));
	const runtimeAgentLog = files.find((path) => path.endsWith(`${sep}agent${sep}logs${sep}agent.jsonl`));
	const telemetry = files.find((path) => path.endsWith(`${sep}agent${sep}telemetry.json`));
	const agentSettings = files.find((path) => path.endsWith(`${sep}agent${sep}settings.json`));
	const organizerRawDecision = files.find((path) => path.endsWith(`${sep}decisions${sep}organizer${sep}decision.json`));
	const executionConditions = files.find((path) => path.endsWith(`${sep}execution-conditions.jsonl`));
	const acquisitionRef = acquisitionTrace ? relativeRef(acquisitionTrace) : undefined;
	const activityPath = readdirSync(executionRoot, { withFileTypes: true })
		.find((entry) => entry.isFile() && entry.name.startsWith("prime_search--") && entry.name.endsWith(".jsonl"));
	const discoveredActivityTrace = activityPath ? relativeRef(join(executionRoot, activityPath.name)) : undefined;
	const activityTrace = discoveredActivityTrace
		?? execution.refs?.activityTrace
		?? (execution.refs?.agentTrace && execution.refs.agentTrace !== acquisitionRef ? execution.refs.agentTrace : undefined);
	const artifactRefs = primeSearchArtifactRefs(runDirectory, executionRoot);
	const refs: NodeExecutionRefs = {
		...(acquisitionTrace ? {
			agentTrace: acquisitionRef,
			acquisitionTrace: acquisitionRef,
			...(activityTrace ? { activityTrace } : {}),
		} : {}),
		...(organizerTrace ? { organizerTrace: relativeRef(organizerTrace) } : {}),
		...(acquisitionSdkEvents ? { sdkEvents: relativeRef(acquisitionSdkEvents) } : {}),
		...(providerLog ? { providerLog: relativeRef(providerLog) } : {}),
		...(organizerDecision ? { organizerDecision: relativeRef(organizerDecision) } : {}),
		...(organizerIndex ? { organizerIndex: relativeRef(organizerIndex) } : {}),
		...Object.fromEntries(childTraces.map((path, index) => [`childTrace${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(childMetadata.map((path, index) => [`childMetadata${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(candidateLedgers.map((path, index) => [`candidateLedger${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(kernelTraces.map((path, index) => [`kernelTrace${index + 1}`, relativeRef(path)])),
		...Object.fromEntries(rlmTraces.map((path, index) => [`rlmTrace${index + 1}`, relativeRef(path)])),
		...(runtimeAgentLog ? { runtimeAgentLog: relativeRef(runtimeAgentLog) } : {}),
		...(telemetry ? { telemetry: relativeRef(telemetry) } : {}),
		...(agentSettings ? { agentSettings: relativeRef(agentSettings) } : {}),
		...(organizerRawDecision ? { organizerRawDecision: relativeRef(organizerRawDecision) } : {}),
		...(executionConditions ? { executionConditions: relativeRef(executionConditions) } : {}),
		...artifactRefs,
	};
	const projected = new Set(Object.values(refs));
	return {
		...refs,
		...Object.fromEntries(files.filter((path) => (path.endsWith(".jsonl") || path.endsWith(".log"))
			&& !projected.has(relativeRef(path)))
			.map((path, index) => [`primeTraceFile${index + 1}`, relativeRef(path)])),
	};
}

function primeSearchArtifactRefs(
	runDirectory: string,
	executionRoot: string,
): NodeExecutionRefs {
	const artifactsRoot = join(executionRoot, "artifacts");
	if (!existsSync(artifactsRoot)) return {};
	const files = listFilesRecursive(artifactsRoot, { absolute: true, strict: true });
	const fileRef = (path: string) => relative(runDirectory, path).split(sep).join("/");
	const sourceIndexes = files.filter((path) => path.endsWith(`${sep}source-index.json`)
		&& path.includes(`${sep}source-bundles${sep}`));
	const executionRecords = files.filter((path) => path.endsWith(".json")
		&& path.includes(`${sep}search-executions${sep}`));
	return {
		...(sourceIndexes[0] ? { sourceIndex: fileRef(sourceIndexes[0]) } : {}),
		...Object.fromEntries(sourceIndexes.map((path, index) => [`sourceIndex${index + 1}`, fileRef(path)])),
		...Object.fromEntries(executionRecords.map((path, index) => [`searchExecution${index + 1}`, fileRef(path)])),
	};
}

function primeSearchCaseTraceDirectory(value: NodeEvaluationCase): string | undefined {
	if (value.agentId !== "prime-search" || value.observed.trace?.root !== "run") return undefined;
	const match = /^prime_search--([A-Za-z0-9._-]+)\.jsonl$/u.exec(basename(value.observed.trace.ref));
	return match ? `prime-search-traces/${match[1]}` : undefined;
}

function primeSearchCaseTraceKind(relativePath: string): string | undefined {
	if (relativePath === "acquisition-session/sdk-events.jsonl") return "child_lifecycle";
	if (/^acquisition-session\/session-artifacts\/.+\.jsonl$/u.test(relativePath)) return "child_trace";
	if (/^acquisition-session\/session\/.+\.jsonl$/u.test(relativePath)) return "acquisition_trace";
	if (/^organizer-session\/session\/.+\.jsonl$/u.test(relativePath)) return "organizer_trace";
	if (relativePath === "provider.jsonl") return "provider_trace";
	if (relativePath.startsWith("decisions/organizer/")) return "organizer_decision";
	if (relativePath.startsWith("decisions/provider-executions/")) return "candidate_ledger";
	if (relativePath.endsWith("/rlm-subagent.json")) return "child_metadata";
	if (relativePath === "kernel-launches.jsonl" || relativePath === "organizer-kernel-launches.jsonl") return "kernel_trace";
	if (relativePath.startsWith("agent/rlm-ledger/") && relativePath.endsWith(".jsonl")) return "rlm_trace";
	if (relativePath === "agent/logs/agent.jsonl") return "runtime_trace";
	if (relativePath === "agent/telemetry.json") return "telemetry";
	if (relativePath === "execution-conditions.jsonl") return "execution_conditions";
	return "prime_trace_file";
}

function wikiCaseTraceDirectories(value: NodeEvaluationCase): string[] {
	if (!["wiki-shard-builder", "wiki-curator"].includes(value.agentId)
		|| value.observed.trace?.root !== "run") return [];
	const recorded = value.observed.traceDirectories?.filter((directory) => directory.root === "run")
		.map((directory) => directory.ref) ?? [];
	return recorded.length ? recorded : [dirname(dirname(value.observed.trace.ref))];
}

function podcastCaseTraceDirectories(value: NodeEvaluationCase): string[] {
	if (value.agentId !== "podcast-writer" || value.observed.trace?.root !== "run") return [];
	return value.observed.traceDirectories?.filter((directory) => directory.root === "run")
		.map((directory) => directory.ref) ?? [];
}

/**
 * 相对于 Reviewer 的两个现场目录（Runtime 与 Worker Workspace）之一。白名单之外的一切
 * 都不暴露，`runtime/agent/` 下的 staged 凭证与配置因此不会出现在 Case 文件里。
 */
function scheduleReviewCaseTraceKind(relativePath: string): string | undefined {
	if (/^session\/[^/]+\.jsonl$/u.test(relativePath)) return "agent_trace";
	if (relativePath === "review-tools.jsonl") return "tool_calls";
	if (relativePath === "root-events.jsonl") return "child_lifecycle";
	if (relativePath === "kernel-launches.jsonl") return "kernel_trace";
	if (relativePath === "result.json") return "runtime_result";
	if (relativePath.startsWith("inputs/")) return "agent_input";
	if (relativePath.startsWith("review-output/")) return "agent_file_contract";
	return undefined;
}

function podcastCaseTraceKind(relativePath: string): string | undefined {
	if (/^runtime\/session\/[^/]+\.jsonl$/u.test(relativePath)) return "agent_trace";
	if (/^runtime\/session-artifacts\/sub-[^/]+\/[^/]+\.jsonl$/u.test(relativePath)) return "related_agent_trace";
	if (/^runtime\/session-artifacts\/sub-[^/]+\/rlm-subagent\.json$/u.test(relativePath)) return "child_metadata";
	if (relativePath === "runtime/root-events.jsonl") return "child_lifecycle";
	if (relativePath === "runtime/kernel-launches.jsonl") return "kernel_trace";
	if (relativePath === "runtime/result.json") return "runtime_result";
	if (relativePath.startsWith("agent-workspace/inputs/")) return "agent_input";
	if (relativePath.startsWith("agent-workspace/work/") || relativePath.startsWith("agent-workspace/writer-output/")) return "agent_file_contract";
	return undefined;
}

function wikiCaseTraceKind(relativePath: string): string | undefined {
	if (/^(?:(?:entity|concept)\/)?[^/]+\.jsonl$/u.test(relativePath)) return "agent_trace";
	if (relativePath === "runtime/sdk-events.jsonl") return "runtime_trace";
	if (/^runtime\/(?:entity|concept)\/sdk-events\.jsonl$/u.test(relativePath)) return "runtime_trace";
	if (/^runtime\/session-artifacts\/sub-[^/]+\/[^/]+\.jsonl$/u.test(relativePath)) return "related_agent_trace";
	if (/^runtime\/(?:entity|concept)\/session-artifacts\/sub-[^/]+\/[^/]+\.jsonl$/u.test(relativePath)) return "related_agent_trace";
	if (/^runtime\/session-artifacts\/sub-[^/]+\/rlm-subagent\.json$/u.test(relativePath)) return "child_metadata";
	if (/^runtime\/(?:entity|concept)\/session-artifacts\/sub-[^/]+\/rlm-subagent\.json$/u.test(relativePath)) return "child_metadata";
	if (relativePath === "runtime/system-prompt.md") return "system_prompt";
	if (/^runtime\/(?:entity|concept)\/system-prompt\.md$/u.test(relativePath)) return "system_prompt";
	if (relativePath === "runtime/user-prompt.md") return "user_prompt";
	if (/^runtime\/(?:entity|concept)\/user-prompt\.md$/u.test(relativePath)) return "user_prompt";
	if (relativePath === "runtime/result.json") return "runtime_result";
	if (relativePath === "work/plan.json") return "agent_plan";
	if (/^work\/assignments\/[^/]+\.json$/u.test(relativePath)) return "agent_assignment";
	if (relativePath === "work/child-contract.md") return "agent_contract";
	if (relativePath === "work/relation-assignment.json") return "relation_assignment";
	if (relativePath === "work/relation-contract.md") return "relation_contract";
	if (relativePath.startsWith("input/") || relativePath.startsWith("workspace/notes/")) return "agent_input";
	if (/^(?:workspace\/)?work\/(?:entity|concept)\/result\.json$/u.test(relativePath)) return "worker_result";
	if (/^work\/(?:results|groups)\/[^/]+\/result\.json$/u.test(relativePath)
		|| relativePath === "work/relations/result.json") return "worker_result";
	return undefined;
}

function safeArtifactPath(root: string, ref: string): string {
	const rootPath = realpathSync(root);
	const path = resolve(rootPath, ref);
	const rel = relative(rootPath, path);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`Node Case file ref escapes its root: ${ref}`);
	}
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Node Case ref is not a safe regular file: ${ref}`);
	return realpathSync(path);
}

function recipeKey(identity: NodeReplayRecipeIdentity): string {
	return `${identity.id}@${identity.version}`;
}
