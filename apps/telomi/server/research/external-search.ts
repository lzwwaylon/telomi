import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentStageActivity, AgentStageRunner } from "../agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { caseCapture } from "../observability/case-capture.js";
import { getSourceStatusMonitor, type SourceStatusMonitor } from "../providers/source-status.js";
import { executeNoteReading } from "./note-reading.js";
import { loadResearchHarnessSnapshot } from "./harness/snapshot.js";
import { loadOrganizedSources } from "./pipeline/organized-sources.js";
import { PrimeSearchBatchExecutor, primeProviderCatalog } from "./pipeline/prime-search-batch.js";
import type { SearchBatchExecutor } from "./pipeline/search-batch.js";
import { availableResearchProviders, createHarnessResearchSourceRegistry } from "./sources/builtin-registry.js";
import { resolveResearchTemporalContext } from "./temporal-context.js";
import type { InvestigationCitationCue } from "./investigation-citations.js";

/** Acquire a remaining evidence need through the ordinary Prime/Provider flow, then verify it with Cornell. */
export async function readExternalSources(input: {
	goalDir: string; goalId: string; runDir: string; investigationId: string; sequence: number;
	question: string; originalQuestion?: string; taskContextFile?: string; signal: AbortSignal; env: NodeJS.ProcessEnv;
	knownCues?: readonly InvestigationCitationCue[];
	onActivity?: (activity: AgentStageActivity) => void;
	searchBatchExecutor?: SearchBatchExecutor;
	sourceStatus?: Pick<SourceStatusMonitor, "verifyIfStale" | "excludedSourceIds">;
	stageRunner?: AgentStageRunner;
}) {
	const question = input.question.trim();
	if (!question || question.length > 20_000) throw new Error("External search requires a question of at most 20000 characters");
	if (!/^[a-f0-9]{24}$/u.test(input.investigationId) || !Number.isSafeInteger(input.sequence) || input.sequence < 1) {
		throw new Error("Invalid external search invocation");
	}
	input.signal.throwIfAborted();
	const sourceRunId = `external-${input.investigationId}-${input.sequence}`;
	const sourceRunRoot = join(input.goalDir, "wiki", "runs", sourceRunId);
	const controlDir = join(input.runDir, `external-search-${input.sequence}`);
	const stagedRoot = join(controlDir, "source-run");
	const request = { question, originalQuestion: input.originalQuestion ?? "" };
	const requestRoot = existsSync(sourceRunRoot) ? sourceRunRoot : stagedRoot;
	const requestPath = join(requestRoot, "external-request.json");
	if (existsSync(requestPath)) {
		if (JSON.stringify(JSON.parse(readFileSync(requestPath, "utf-8"))) !== JSON.stringify(request)) {
			throw new Error("External Source run belongs to a different question");
		}
	} else {
		if (existsSync(sourceRunRoot)) throw new Error("External Source run has no request identity");
		mkdirSync(stagedRoot, { recursive: true });
		writeJsonAtomic(requestPath, request);
	}
	if (!existsSync(sourceRunRoot)) {
		const harness = loadResearchHarnessSnapshot(input.goalDir);
		const registry = createHarnessResearchSourceRegistry(harness, input.env);
		const sourceStatus = input.sourceStatus ?? getSourceStatusMonitor();
		await sourceStatus.verifyIfStale(5 * 60_000).catch(() => undefined);
		input.signal.throwIfAborted();
		const catalog = registry.catalog();
		const available = availableResearchProviders(catalog, harness.primeSearch.policy.allowedSources,
			sourceStatus.excludedSourceIds());
		if (!available.length) throw new Error("Prime Search has no allowed Provider");
		const production = new PrimeSearchBatchExecutor(registry, harness, { env: input.env });
		const executor = input.searchBatchExecutor ?? caseCapture()?.primeSearchBatch?.(production, {
			env: input.env,
			availableProviders: primeProviderCatalog(catalog, Object.fromEntries(catalog.map((provider) => [
				provider.id, provider.workerSkills ?? [],
			]))),
		}) ?? production;
		await executor.execute({
			goalId: input.goalId, runId: sourceRunId, sequence: 1,
			taskContextFile: input.taskContextFile,
				question: input.originalQuestion ? `${input.originalQuestion}\n\nRemaining evidence need: ${question}` : question,
			availableProviderIds: available.map((provider) => provider.id),
			workspaceDirectory: input.goalDir, controlDirectory: controlDir,
			organizerStorageRoot: join(controlDir, "research-sources"),
			artifactStore: new RunArtifactStore(stagedRoot),
			temporalContext: resolveResearchTemporalContext(input.originalQuestion ?? question),
			signal: input.signal, onActivity: input.onActivity,
		});
		// Validate the published acquisition contract before exposing this Run to Goal readers.
		loadOrganizedSources(new RunArtifactStore(stagedRoot).describeDirectory("artifacts/find-out-sources/sequence-1"));
		input.signal.throwIfAborted();
		mkdirSync(dirname(sourceRunRoot), { recursive: true });
		renameSync(stagedRoot, sourceRunRoot);
	}
	const sources = loadOrganizedSources(new RunArtifactStore(sourceRunRoot).describeDirectory("artifacts/find-out-sources/sequence-1"));
	const reading = await executeNoteReading({
		goalDir: input.goalDir, goalId: input.goalId, question,
		originalQuestion: input.originalQuestion, taskContextFile: input.taskContextFile, knownCues: input.knownCues,
		invocationId: `${input.investigationId}-external-${input.sequence}`,
		preferredSourceRunId: sourceRunId,
		signal: input.signal, env: input.env, stageRunner: input.stageRunner, onActivity: input.onActivity,
	});
	return { ...reading, sources: sources.map((source) => ({ id: source.id, title: source.title,
		revision_sha256: source.revisionSha256, url: source.url })) };
}
