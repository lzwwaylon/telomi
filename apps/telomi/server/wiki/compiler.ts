import { isThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { freezeModelDefinitions, pinTaskModelSelection, trackTaskModelSelection } from "../agent-runtime/model-policy.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { listJsonl, writeJsonAtomic } from "../lib/fs.js";

import { serverRuntimeDirForGoalDir } from "../workspaces/server-runtime-paths.js";
import { hashJson } from "../lib/hash.js";
import type { CornellNotesSnapshot } from "../cornell/contracts.js";
import { validateCornellNotesSnapshot } from "../cornell/contracts.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { PRIME_AUTO_REFINE_ENABLED } from "../agent-runtime/prime-agent-paths.js";
import {
	validateGoalTopicPlan,
	requireWikiGoalContext,
	wikiLanguage,
	type WikiCompilationBatchFailure,
	type WikiCompilationRequest,
	type WikiCompilationResult,
} from "./contracts.js";
import { hashWikiDirectory } from "./files.js";
import {
	NOTE_WIKI_MAINTAINER_CONTRACT_VERSION,
	noteWikiEntries,
	runPrimeNoteWikiMaintainer,
} from "./note-wiki-maintainer.js";
import { curateWikiEdition, prepareEmptyEdition } from "./wiki-shard-merge.js";
import { caseCapture } from "../observability/case-capture.js";
import { isInsideRoot } from "../lib/paths.js";
import { isRecord, toErrorMessage } from "../lib/values.js";

/**
 * Wiki 节点的产品执行路径。Case Capture 关闭时直接执行产品实现，不写 Evaluation Case；
 * 打开时由 Capture Hook 包住同一次执行，Capture 失败不改变产品结果。
 */
function runWikiShard(
	input: Parameters<typeof runPrimeNoteWikiMaintainer>[0],
	recordDirectory: string,
	runId: string,
): ReturnType<typeof runPrimeNoteWikiMaintainer> {
	const capture = caseCapture();
	return capture?.wikiShard ? capture.wikiShard(input, { recordDirectory, runId }) : runPrimeNoteWikiMaintainer(input);
}

function runWikiCurator(
	input: Parameters<typeof curateWikiEdition>[0],
	recordDirectory: string,
	runId: string,
): ReturnType<typeof curateWikiEdition> {
	const capture = caseCapture();
	return capture?.wikiCurator ? capture.wikiCurator(input, { recordDirectory, runId }) : curateWikiEdition(input);
}

interface CompilationRecord {
	schema_version: 5;
	compilation_id: string;
	base_knowledge_sha256: string;
	cornell_notes_snapshot_ref: string;
	topic_plan_revision: string;
	topic_plan_sha256: string;
	knowledge_ref: string;
	usage: WikiCompilationResult["usage"];
	agent_stages: number;
	session_paths: string[];
	page_count: number;
	failed_batches: WikiCompilationBatchFailure[];
}

/**
 * 一个独立 Batch Wiki Shard 跑完后留下的续跑凭据。每个 Shard 只依赖自己的 Source batch，
 * 所以任意一个有效凭据都可以独立复用。
 */
interface BatchCheckpoint {
	schema_version: 1;
	batch_index: number;
	batch_digest: string;
	knowledge_path: string;
	page_count: number;
	usage: WikiCompilationResult["usage"];
	session_paths: string[];
}

const goalTails = new Map<string, Promise<void>>();
const SOURCE_BATCH_LIMIT = 10;
const BATCH_CONCURRENCY = 4;
const BATCH_CHECKPOINT = "checkpoint.json";

export function llmWikiCompilerContractIdentity(): { promptBundle: string; schemaBundle: string } {
	return {
		promptBundle: hashJson({
			maintainer: NOTE_WIKI_MAINTAINER_CONTRACT_VERSION,
			autoRefine: PRIME_AUTO_REFINE_ENABLED,
		}),
		schemaBundle: hashJson({ compiler: 28, input: "cornell-evidence+goals/topic-plan+previous-wiki-edition", output: "native-workspace-wiki-curator-edition" }),
	};
}

export class LlmWikiCompiler {
		constructor(private readonly options: {
			maintain?: typeof runPrimeNoteWikiMaintainer;
			curate?: typeof curateWikiEdition;
		} = {}) {}

	async compile(request: WikiCompilationRequest): Promise<WikiCompilationResult> {
		const key = request.goalDir;
		const previous = goalTails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		goalTails.set(key, current);
		await previous;
		try {
			const selectionPath = join(request.controlDirectory, "wiki-model-selection.json");
			const saved = existsSync(selectionPath) ? JSON.parse(readFileSync(selectionPath, "utf-8")) : undefined;
			if (saved !== undefined && (!isRecord(saved) || Object.keys(saved).length !== 3
				|| ![saved.TELOMI_WIKI_MAINTAINER_MODEL, saved.TELOMI_PRIME_AGENT_CHILD_MODEL]
				.every((model) => typeof model === "string" && /^[^/]+\/.+$/u.test(model))
				|| !isThinkingLevel(saved.TELOMI_WIKI_MAINTAINER_THINKING_LEVEL))) {
				throw new Error("Invalid persisted Wiki model selection");
			}
			const pinned = pinTaskModelSelection(["wikiMaintainer", "primeChild"], { ...(request.env ?? process.env), ...saved });
			mkdirSync(request.controlDirectory, { recursive: true });
			writeJsonAtomic(selectionPath, {
				TELOMI_WIKI_MAINTAINER_MODEL: pinned.TELOMI_WIKI_MAINTAINER_MODEL,
				TELOMI_PRIME_AGENT_CHILD_MODEL: pinned.TELOMI_PRIME_AGENT_CHILD_MODEL,
				TELOMI_WIKI_MAINTAINER_THINKING_LEVEL: pinned.TELOMI_WIKI_MAINTAINER_THINKING_LEVEL,
			});
			const env = freezeModelDefinitions(pinned, request.controlDirectory);
			const stopTracking = trackTaskModelSelection(["wikiMaintainer", "primeChild"], env, ["wikiMaintainer.maintenance"]);
			try { return await this.compileLocked({ ...request, env }); } finally { stopTracking(); }
		} finally {
			release();
			if (goalTails.get(key) === current) goalTails.delete(key);
		}
	}

	private async compileLocked(request: WikiCompilationRequest): Promise<WikiCompilationResult> {
		requireWikiGoalContext(request.goalContext);
		const topicPlan = validateGoalTopicPlan(request.topicPlan);
		const topicPlanSha256 = hashJson(topicPlan);
		const store = new RunArtifactStore(request.runDirectory);
		const cornellNotesArtifact = store.openFile(request.cornellNotesSnapshot);
		const evidence = projectWikiEvidence(validateCornellNotesSnapshot(
			JSON.parse(readFileSync(cornellNotesArtifact.absolutePath, "utf-8")),
		) as CornellNotesSnapshot);
		const batches = batchEvidenceBySourceLimit(evidence);
		request.onStarted?.(batches.length);
		const knowledgeRoot = join(request.goalDir, "wiki", "knowledge");
		const baseKnowledgeSha256 = hashWikiDirectory(knowledgeRoot);
		const compilationId = `note-wiki-${hashJson({
			run: request.runId,
			evidence: cornellNotesArtifact.sha256,
			base: baseKnowledgeSha256,
			topicPlan: topicPlanSha256,
			contract: NOTE_WIKI_MAINTAINER_CONTRACT_VERSION,
			goalContext: request.goalContext,
		}).slice(0, 24)}`;
		const compilationRoot = `artifacts/wiki-compilations/${compilationId}`;
		const recordPath = `${compilationRoot}/compilation.json`;
		if (existsSync(join(request.runDirectory, recordPath))) return reopen(store, recordPath);
		const workRoot = join(request.controlDirectory, "note-wiki", compilationId);
		const shardSessionRoot = join(
			serverRuntimeDirForGoalDir(request.goalDir),
			"wiki-shards",
			`v${NOTE_WIKI_MAINTAINER_CONTRACT_VERSION}`,
			compilationId,
		);
		mkdirSync(workRoot, { recursive: true });
		const usage: WikiCompilationResult["usage"] = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
		const sessionPaths: string[] = [];
		let pageCount = 0;
		// 中断可能正好落在"知识已发布、编译记录还没写"之间。发布是不可变的，也就意味着
		// 这次续跑不需要、也不允许重做任何批次，直接认领那份产物即可。
		const knowledgePath = `${compilationRoot}/knowledge`;
		const knowledgePublished = existsSync(join(request.runDirectory, knowledgePath));
		const existingBase = !request.rebuild && existsSync(join(knowledgeRoot, ".note-registry.json"))
			? knowledgeRoot
			: undefined;
		const goalContextSha256 = hashJson(request.goalContext);
		const alreadyKnown = Boolean(existingBase && evidenceAlreadyKnown(existingBase, evidence)
			&& wikiGoalContextMatches(existingBase, goalContextSha256));
		const batchPromises = knowledgePublished || alreadyKnown ? [] : scheduleConcurrent(
			batches.map((batch, index) => ({ batch, index })),
			BATCH_CONCURRENCY,
			async ({ batch, index }) => {
			request.signal.throwIfAborted();
			const batchRoot = join(workRoot, `batch-${String(index + 1).padStart(3, "0")}`);
			const batchSessionRoot = join(shardSessionRoot, `batch-${String(index + 1).padStart(3, "0")}`);
			const digest = hashJson(batch);
			const checkpoint = readBatchCheckpoint(batchRoot, index, digest);
			const traceName = `${compilationId}-batch-${index + 1}`;
			const traceSessions = ["entity", "concept"].flatMap((role) => [
				{ path: join(batchSessionRoot, "sessions", role), label: `Wiki ${role}` },
				{ path: join(batchRoot, "maintainer", "runtime", role, "session-artifacts"), label: `Wiki ${role} child` },
			]);
			const traceRef = sessionTraceRef(request.controlDirectory, traceName, traceSessions, checkpoint?.session_paths);
			if (checkpoint) {
				request.onBatchProgress?.({
					batchIndex: index,
					totalBatches: batches.length,
					status: "succeeded",
					pageCount: checkpoint.page_count,
					usage: checkpoint.usage,
					traceRef,
					reused: true,
				});
				return { status: "succeeded" as const, index, checkpoint, knowledgeRoot: join(batchRoot, checkpoint.knowledge_path) };
			}
			// A Shard Root persists accepted child result files before the whole Root commits. Preserve that partial
			// workspace on process resume. A present but invalid final checkpoint is different: its history
			// cannot be trusted, so discard the whole Root workspace before rerunning.
			if (existsSync(join(batchRoot, BATCH_CHECKPOINT))) rmSync(batchRoot, { recursive: true, force: true });
			request.onBatchProgress?.({
				batchIndex: index,
				totalBatches: batches.length,
				status: "running",
				traceRef,
				pageCount: 0,
				usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
				reused: false,
			});
			let maintained: Awaited<ReturnType<typeof runPrimeNoteWikiMaintainer>>;
			try {
				const shardInput = {
					goal: request.goal?.trim() || request.runId,
					goalContext: request.goalContext,
					evidence: batch,
					topicPlan,
					workRoot: batchRoot,
					sessionRoot: batchSessionRoot,
					batch: {
						id: `${compilationId}:source-batch-${index + 1}`,
						index,
						total: batches.length,
						sourceIds: sourceIds(batch),
					},
					signal: request.signal,
					env: request.env,
				};
				maintained = this.options.maintain
					? await this.options.maintain(shardInput)
					: await runWikiShard(shardInput, request.controlDirectory, `${request.runId}-wiki-shard-${index + 1}`);
			} catch (error) {
				request.signal.throwIfAborted();
				const message = (toErrorMessage(error)).slice(0, 4_000);
				const failedTraces = [join(batchSessionRoot, "sessions"), join(batchRoot, "maintainer", "runtime")];
				const failedUsage = collectTraceUsage(failedTraces);
				request.onBatchProgress?.({
					batchIndex: index,
					totalBatches: batches.length,
					status: "failed",
					pageCount: 0,
					usage: failedUsage,
					traceRef,
					message,
					reused: false,
				});
				return {
					status: "failed" as const,
					index,
					failure: {
						batchIndex: index,
						sourceIds: sourceIds(batch),
						message,
						usage: failedUsage,
					},
				};
			}
			const completed: BatchCheckpoint = {
				schema_version: 1,
				batch_index: index,
				batch_digest: digest,
				knowledge_path: containedPath(batchRoot, maintained.knowledgeRoot),
				page_count: maintained.pageCount,
				usage: maintained.usage,
				session_paths: maintained.sessionPaths,
			};
			writeBatchCheckpoint(batchRoot, completed);
			sessionTraceRef(request.controlDirectory, traceName, traceSessions, maintained.sessionPaths);
			request.onBatchProgress?.({
				batchIndex: index,
				totalBatches: batches.length,
				status: "succeeded",
				pageCount: maintained.pageCount,
				usage: maintained.usage,
				traceRef,
				reused: false,
			});
			return { status: "succeeded" as const, index, checkpoint: completed, knowledgeRoot: maintained.knowledgeRoot };
		});
		const settledBatchPromises = batchPromises.map((promise) => promise.then(
			(value) => ({ status: "fulfilled" as const, value }),
			(reason: unknown) => ({ status: "rejected" as const, reason }),
		));
		const failedBatches: WikiCompilationBatchFailure[] = [];
		let shardAgentStages = 0;
		let successfulShards = 0;
		let candidateRoot: string;
		let curatorStages = 0;
		if (knowledgePublished) {
			candidateRoot = join(request.runDirectory, knowledgePath);
		} else if (alreadyKnown && wikiTopicPlanMatches(existingBase!, topicPlanSha256)) {
			candidateRoot = existingBase!;
			pageCount = countWikiPages(candidateRoot);
		} else if (alreadyKnown) {
			const curatorWorkRoot = join(workRoot, "curation", "reframe");
			const curatorSessionRoot = join(shardSessionRoot, "curator-reframe");
			const traceName = `${compilationId}-curator-reframe`;
			const traceSessions = [
				{ path: join(curatorSessionRoot, "sessions"), label: "Wiki Curator Root" },
				{ path: join(curatorWorkRoot, "curator-runtime", "session-artifacts"), label: "Wiki Curator child" },
			];
			const traceRef = sessionTraceRef(request.controlDirectory, traceName, traceSessions);
			request.onStageProgress?.({
				kind: "curation", stageIndex: 0, totalStages: 1, status: "running", pageCount: 0,
				usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, traceRef,
			});
			let curated: Awaited<ReturnType<typeof curateWikiEdition>>;
			try {
				const curatorInput = {
					operation: "reframe",
					goal: request.goal?.trim() || request.runId,
					language: wikiLanguage(request.goalContext),
					topicPlan,
					previousEditionRoot: existingBase!,
					draftRoots: [],
					workRoot: curatorWorkRoot,
					sessionRoot: curatorSessionRoot,
					signal: request.signal,
					env: request.env,
				} as const;
				curated = this.options.curate
					? await this.options.curate(curatorInput)
					: await runWikiCurator(curatorInput, request.controlDirectory, `${request.runId}-wiki-curator-reframe`);
			} catch (error) {
				request.onStageProgress?.({
					kind: "curation", stageIndex: 0, totalStages: 1, status: "failed", pageCount: 0,
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, traceRef,
					message: toErrorMessage(error),
				});
				throw error;
			}
			candidateRoot = curated.knowledgeRoot;
			pageCount = curated.pageCount;
			addUsage(usage, curated.usage);
			sessionPaths.push(...curated.sessionPaths);
			curatorStages = curated.usage.calls > 0 ? 1 : 0;
			sessionTraceRef(request.controlDirectory, traceName, traceSessions, curated.sessionPaths);
			request.onStageProgress?.({
				kind: "curation", stageIndex: 0, totalStages: 1, status: "succeeded",
				pageCount: curated.pageCount, usage: curated.usage, traceRef,
			});
		} else {
			let rollingEditionRoot = existingBase;
			let curationFailure: unknown;
			for (const settledPromise of settledBatchPromises) {
				const settled = await settledPromise;
				if (settled.status === "rejected") {
					await Promise.all(settledBatchPromises);
					throw settled.reason;
				}
				const shard = settled.value;
				if (shard.status === "failed") {
					failedBatches.push(shard.failure);
					addUsage(usage, shard.failure.usage);
					continue;
				}
				addUsage(usage, shard.checkpoint.usage);
				sessionPaths.push(...shard.checkpoint.session_paths);
				if (shard.checkpoint.usage.calls > 0) shardAgentStages += 1;
				successfulShards += 1;
				if (shard.checkpoint.page_count === 0) {
					// An empty Shard has nothing to merge, and the Curator plan contract cannot be met
					// without an incoming Page, so the rolling Edition simply carries over.
					request.onStageProgress?.({
						kind: "curation", stageIndex: shard.index, totalStages: batches.length, status: "succeeded",
						pageCount: rollingEditionRoot ? countWikiPages(rollingEditionRoot) : 0,
						usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
					});
					continue;
				}
				const operation = rollingEditionRoot ? "update" : "initialize";
				const stageName = `batch-${String(shard.index + 1).padStart(3, "0")}`;
				const curatorWorkRoot = join(workRoot, "curation", stageName);
				const curatorSessionRoot = join(shardSessionRoot, "curator", stageName);
				const traceName = `${compilationId}-curator-${stageName}`;
				const traceSessions = [
					{ path: join(curatorSessionRoot, "sessions"), label: "Wiki Curator Root" },
					{ path: join(curatorWorkRoot, "curator-runtime", "session-artifacts"), label: "Wiki Curator child" },
				];
				const traceRef = sessionTraceRef(request.controlDirectory, traceName, traceSessions);
				request.onStageProgress?.({
					kind: "curation", stageIndex: shard.index, totalStages: batches.length, status: "running", pageCount: 0,
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, traceRef,
				});
				let curated: Awaited<ReturnType<typeof curateWikiEdition>>;
				try {
					const curatorInput: Parameters<typeof curateWikiEdition>[0] = {
						operation,
						goal: request.goal?.trim() || request.runId,
						language: wikiLanguage(request.goalContext),
						topicPlan,
						...(rollingEditionRoot ? { previousEditionRoot: rollingEditionRoot } : {}),
						draftRoots: [shard.knowledgeRoot],
						workRoot: curatorWorkRoot,
						sessionRoot: curatorSessionRoot,
						signal: request.signal,
					env: request.env,
					};
					curated = this.options.curate
						? await this.options.curate(curatorInput)
						: await runWikiCurator(curatorInput, request.controlDirectory, `${request.runId}-wiki-curator-${stageName}`);
				} catch (error) {
					request.signal.throwIfAborted();
					// A rejected Curation costs this Source batch, not the whole Edition: the rolling Edition
					// carries over, the Run reports a partial result, and the next Run retries the batch.
					const message = toErrorMessage(error).slice(0, 4_000);
					const failedUsage = collectTraceUsage(traceSessions.map(({ path }) => path));
					request.onStageProgress?.({
						kind: "curation", stageIndex: shard.index, totalStages: batches.length, status: "failed", pageCount: 0,
						usage: failedUsage, traceRef, message,
					});
					addUsage(usage, failedUsage);
					failedBatches.push({ batchIndex: shard.index, sourceIds: sourceIds(batches[shard.index]!), message, usage: failedUsage });
					curationFailure ??= error;
					continue;
				}
				rollingEditionRoot = curated.knowledgeRoot;
				pageCount = curated.pageCount;
				addUsage(usage, curated.usage);
				sessionPaths.push(...curated.sessionPaths);
				if (curated.usage.calls > 0) curatorStages += 1;
				sessionTraceRef(request.controlDirectory, traceName, traceSessions, curated.sessionPaths);
				request.onStageProgress?.({
					kind: "curation", stageIndex: shard.index, totalStages: batches.length, status: "succeeded",
					pageCount: curated.pageCount, usage: curated.usage, traceRef,
				});
			}
			if (successfulShards === 0) throw new Error(`All ${failedBatches.length} Wiki mini-batches failed`);
			// A first Edition that exists only because every Curation failed would be an empty Wiki, not a partial one.
			if (!rollingEditionRoot && curationFailure) throw curationFailure;
			if (!rollingEditionRoot) {
				// Every Shard was empty and no Edition exists yet: publish an empty Edition rather than fail.
				rollingEditionRoot = join(workRoot, "curation", "empty-edition");
				prepareEmptyEdition(rollingEditionRoot);
			}
			candidateRoot = rollingEditionRoot;
			// The rolling Edition is authoritative: a skipped or rejected final batch must not report a stale count.
			pageCount = countWikiPages(candidateRoot);
			failedBatches.sort((left, right) => left.batchIndex - right.batchIndex);
		}
		if (!knowledgePublished && candidateRoot !== existingBase) {
			const contextPath = join(candidateRoot, ".goal-context.sha256");
			if (failedBatches.length) rmSync(contextPath, { force: true });
			else writeFileSync(contextPath, `${goalContextSha256}\n`);
		}
		const knowledge = knowledgePublished
			? store.describeDirectory(knowledgePath)
			: store.publishDirectory(candidateRoot, knowledgePath, candidateRoot);
		if (knowledgePublished) pageCount = countWikiPages(knowledge.absolutePath);
		const record: CompilationRecord = {
			schema_version: 5,
			compilation_id: compilationId,
			base_knowledge_sha256: baseKnowledgeSha256,
			cornell_notes_snapshot_ref: cornellNotesArtifact.relativePath,
			topic_plan_revision: topicPlan.revision,
			topic_plan_sha256: topicPlanSha256,
			knowledge_ref: knowledge.relativePath,
			usage,
			agent_stages: shardAgentStages + curatorStages,
			session_paths: sessionPaths,
			page_count: pageCount,
			failed_batches: failedBatches,
		};
		store.publishText(`${JSON.stringify(record, null, 2)}\n`, recordPath);
		return result(record, knowledge);
	}
}

function sessionTraceRef(
	controlDirectory: string,
	name: string,
	sessions: ReadonlyArray<{ path: string; label: string }>,
	completedRoots: readonly string[] = [],
): string {
	const traceRef = `wiki-trace-${name}.json`;
	writeJsonAtomic(join(controlDirectory, traceRef), {
		schemaVersion: 1,
		sessions: [...sessions, ...completedRoots.map((path) => ({ path, label: "Wiki Session" }))]
			.map((session) => ({ ...session, path: relative(controlDirectory, session.path) })),
	});
	return traceRef;
}

export function projectWikiEvidence(evidence: CornellNotesSnapshot): CornellNotesSnapshot {
	return {
		...evidence,
		notes: evidence.notes.map((record) => ({
			...record,
			note: {
				...record.note,
				sections: record.note.sections.map((section) => ({
					...section,
					cue_notes: section.cue_notes.map(({ discovery: _discovery, ...cue }) => cue),
				})),
			},
		})),
	};
}

export function batchEvidenceBySourceLimit(
	evidence: CornellNotesSnapshot,
	limit = SOURCE_BATCH_LIMIT,
): CornellNotesSnapshot[] {
	if (!Number.isInteger(limit) || limit < 1) throw new Error("Source batch limit must be a positive integer");
	const recordsBySource = new Map<string, CornellNotesSnapshot["notes"]>();
	for (const record of evidence.notes) {
		const sourceId = record.note.source_id;
		recordsBySource.set(sourceId, [...(recordsBySource.get(sourceId) ?? []), record]);
	}
	const sources = [...recordsBySource.values()];
	const batches = Array.from({ length: Math.ceil(sources.length / limit) }, (_, index) =>
		sources.slice(index * limit, (index + 1) * limit).flat());
	return (batches.length ? batches : [[]]).map((records) => ({ ...evidence, notes: records }));
}

function sourceIds(evidence: CornellNotesSnapshot): string[] {
	return [...new Set(evidence.notes.map((record) => record.note.source_id))];
}

function collectTraceUsage(roots: string[]): WikiCompilationResult["usage"] {
	const usage: WikiCompilationResult["usage"] = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
	for (const path of roots.flatMap((root) => listJsonl(root))) {
		for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
			try {
				const value = JSON.parse(line) as {
					type?: string;
					message?: { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } };
				};
				if (!new Set(["message", "message_end"]).has(value.type ?? "")
					|| value.message?.role !== "assistant" || !value.message.usage) continue;
				usage.inputTokens += value.message.usage.input ?? 0;
				usage.outputTokens += value.message.usage.output ?? 0;
				usage.costUsd += value.message.usage.cost?.total ?? 0;
				usage.calls += 1;
			} catch {
				// Ignore an incomplete final JSONL line.
			}
		}
	}
	return usage;
}

function evidenceAlreadyKnown(knowledgeRoot: string, evidence: CornellNotesSnapshot): boolean {
	const path = join(knowledgeRoot, ".note-registry.json");
	if (!existsSync(path)) return false;
	try {
		const registry = JSON.parse(readFileSync(path, "utf-8")) as {
			entries?: Array<{ id?: string; revisionSha256?: string }>;
		};
		const known = new Map((registry.entries ?? []).flatMap((entry) =>
			typeof entry.id === "string" && typeof entry.revisionSha256 === "string"
				? [[entry.id, entry.revisionSha256] as const]
				: []));
		return noteWikiEntries(evidence).every((entry) => known.get(entry.id) === entry.revisionSha256);
	} catch {
		return false;
	}
}

function wikiGoalContextMatches(knowledgeRoot: string, expectedSha256: string): boolean {
	try {
		return readFileSync(join(knowledgeRoot, ".goal-context.sha256"), "utf-8").trim() === expectedSha256;
	} catch {
		return false;
	}
}

function wikiTopicPlanMatches(knowledgeRoot: string, expectedSha256: string): boolean {
	try {
		return hashJson(JSON.parse(readFileSync(join(knowledgeRoot, ".topic-plan.json"), "utf-8"))) === expectedSha256;
	} catch {
		return false;
	}
}

function scheduleConcurrent<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R>[] {
	const pending = items.map(() => {
		let resolve!: (value: R) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<R>((accept, fail) => { resolve = accept; reject = fail; });
		return { promise, resolve, reject };
	});
	let next = 0;
	for (let worker = 0; worker < Math.min(concurrency, items.length); worker += 1) void (async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			await new Promise<void>((resolve) => setImmediate(resolve));
			try {
				pending[index]!.resolve(await task(items[index]!));
			} catch (error) {
				pending[index]!.reject(error);
			}
		}
	})();
	return pending.map((item) => item.promise);
}

function readBatchCheckpoint(batchRoot: string, index: number, digest: string): BatchCheckpoint | undefined {
	const path = join(batchRoot, BATCH_CHECKPOINT);
	if (!existsSync(path)) return undefined;
	let checkpoint: BatchCheckpoint;
	try {
		checkpoint = JSON.parse(readFileSync(path, "utf-8")) as BatchCheckpoint;
	} catch {
		return undefined;
	}
	if (checkpoint.schema_version !== 1) return undefined;
	if (checkpoint.batch_index !== index || checkpoint.batch_digest !== digest) return undefined;
	if (typeof checkpoint.knowledge_path !== "string" || !checkpoint.knowledge_path) return undefined;
	return existsSync(join(batchRoot, checkpoint.knowledge_path)) ? checkpoint : undefined;
}

function writeBatchCheckpoint(batchRoot: string, checkpoint: BatchCheckpoint): void {
	// 先写好 Wiki 产物再落凭据，所以凭据存在就代表这一批完整可用。
	writeFileSync(join(batchRoot, BATCH_CHECKPOINT), `${JSON.stringify(checkpoint, null, 2)}\n`);
}

function containedPath(root: string, target: string): string {
	if (!isInsideRoot(root, target, { rejectDotPrefix: true, allowRoot: false })) {
		throw new Error(`Note Wiki Maintainer must write its Wiki inside the batch work directory: ${target}`);
	}
	return relative(root, target);
}

function countWikiPages(root: string): number {
	return ["concepts", "entities"].reduce((total, directory) => {
		const absolute = join(root, directory);
		if (!existsSync(absolute)) return total;
		return total + readdirSync(absolute, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
	}, 0);
}

function addUsage(total: WikiCompilationResult["usage"], delta: WikiCompilationResult["usage"]): void {
	total.inputTokens += delta.inputTokens;
	total.outputTokens += delta.outputTokens;
	total.costUsd += delta.costUsd;
	total.calls += delta.calls;
}

function reopen(store: RunArtifactStore, recordPath: string): WikiCompilationResult {
	const record = store.readJson<CompilationRecord>(store.describeFile(recordPath));
	if (record.schema_version !== 5) throw new Error(`Unsupported Wiki compilation schema '${String(record.schema_version)}'`);
	return { ...result(record, store.describeDirectory(record.knowledge_ref)), status: "reused" };
}

function result(
	record: CompilationRecord,
	knowledge: ReturnType<RunArtifactStore["describeDirectory"]>,
): WikiCompilationResult {
	return {
		status: "compiled",
		compilationId: record.compilation_id,
		baseKnowledgeSha256: record.base_knowledge_sha256,
		knowledge,
		pageCount: record.page_count,
		usage: record.usage,
		agentStages: record.agent_stages,
		sessionPaths: record.session_paths,
		failedBatches: record.failed_batches,
	};
}
