import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { pinRunModelSelection } from "../run-model-selection.js";
import { createGoalLlmWikiTools, type WikiCompilationResult } from "../../wiki/index.js";
import { resolveWikiEdition } from "../../wiki/editions.js";
import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import { loadResearchHarnessSnapshot } from "../harness/snapshot.js";
import { RunArtifactStore } from "../../agent-runtime/artifact-store.js";
import type { CornellNotesSnapshot } from "../../cornell/contracts.js";
import { RunStateStore, type RunStateV2 } from "../run-state.js";
import { buildRunContextSnapshotFromHarness } from "../run-context.js";
import { ResearchRuntime } from "../runtime.js";
import { inferOutputLanguage } from "../../../shared/languages.js";
import type { ResolvedOutputLanguage } from "../../../shared/languages.js";
import { isInsideRoot } from "../../lib/paths.js";
import { JsonDocumentStore } from "../../lib/json-document-store.js";
import { toErrorMessage } from "../../lib/values.js";

export interface ReportRunRecord {
	schemaVersion: 3;
	id: string;
	goalId: string;
	wikiRevision: string;
	reportContext: string;
	reportTitle?: string;
	outputLanguage?: ResolvedOutputLanguage;
	status: "queued" | "running" | "completed" | "failed";
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	input: {
		ref: string;
		sha256: string;
		byteLength: number;
		cornellNotesRef: string;
	};
	result?: {
		reportRef: string;
		usage: RunStateV2["usage"];
	};
	error?: string;
}

export class ReportRunService {
	private readonly active = new Map<string, Promise<void>>();

	constructor(private readonly workspaceDir: string) {}

	enqueueLatest(goalId: string, request: { reportContext: string; reportTitle?: string; outputLanguage?: ResolvedOutputLanguage }, signal?: AbortSignal): ReportRunRecord {
		if (typeof request.reportContext !== "string" || !request.reportContext.trim()) throw new Error("Report Run reportContext must be non-empty");
		if (request.reportTitle !== undefined && !request.reportTitle.trim()) throw new Error("reportTitle must be non-empty");
		const edition = resolveWikiEdition(this.workspaceDir, goalId);
		const id = `report_run_${Date.now()}_${randomUUID().slice(0, 8)}`;
		const store = new RunArtifactStore(this.runDirectory(goalId, id));
		store.publishDirectory(edition.root, "artifacts/report-run/knowledge-snapshot/wiki", edition.root);
		const knowledge = store.describeDirectory("artifacts/report-run/knowledge-snapshot");
		const cornellNotes = store.publishText(`${JSON.stringify(emptyWikiEvidence(id), null, 2)}\n`,
			"artifacts/report-run/cornell-notes.json");
		const now = new Date().toISOString();
		const record: ReportRunRecord = {
			schemaVersion: 3,
			id,
			goalId,
			wikiRevision: edition.revision,
			reportContext: request.reportContext.trim(),
			...(request.reportTitle?.trim() ? { reportTitle: request.reportTitle.trim() } : {}),
			...(request.outputLanguage ? { outputLanguage: request.outputLanguage } : {}),
			status: "queued",
			createdAt: now,
			updatedAt: now,
			input: {
				ref: knowledge.relativePath,
				sha256: knowledge.sha256,
				byteLength: knowledge.byteLength,
				cornellNotesRef: cornellNotes.relativePath,
			},
		};
		this.save(record);
		const task = this.execute(record, signal).finally(() => this.active.delete(`${goalId}/${id}`));
		this.active.set(`${goalId}/${id}`, task);
		return record;
	}

	async wait(goalId: string, id: string): Promise<ReportRunRecord> {
		await this.active.get(`${goalId}/${id}`);
		const record = this.read(goalId, id);
		if (!record) throw new Error(`Unknown Report Run '${id}'`);
		return record;
	}

	read(goalId: string, id: string): ReportRunRecord | null {
		return reportRunStore(this.runDirectory(goalId, id)).get("report-run") ?? null;
	}

	file(goalId: string, id: string, ref: string): string {
		if (!ref || isAbsolute(ref) || ref.includes("\0")) throw new Error("ref must be a safe relative path");
		const root = realpathSync(this.runDirectory(goalId, id));
		const path = realpathSync(resolve(root, ref));
		if (!isInsideRoot(root, path)) throw new Error("ref escapes Report Run");
		return path;
	}

	private async execute(initial: ReportRunRecord, signal?: AbortSignal): Promise<void> {
		const startedAt = new Date().toISOString();
		let record: ReportRunRecord = { ...initial, status: "running", startedAt, updatedAt: startedAt };
		this.save(record);
		try {
			signal?.throwIfAborted();
			const runDirectory = this.runDirectory(record.goalId, record.id);
			const goalDirectory = join(this.workspaceDir, record.goalId);
			const controlDirectory = join(serverRuntimeDirForGoal(record.goalId, this.workspaceDir), "runs", record.id);
			mkdirSync(controlDirectory, { recursive: true });
			const targetStore = new RunArtifactStore(runDirectory);
			const cornellNotesArtifact = targetStore.describeFile(record.input.cornellNotesRef);
			const knowledge = targetStore.openDirectory({
				relative_path: record.input.ref, sha256: record.input.sha256, byte_length: record.input.byteLength,
			});
			const harness = loadResearchHarnessSnapshot(goalDirectory);
			const runContext = buildRunContextSnapshotFromHarness({
				goalId: record.goalId,
				goalDir: goalDirectory,
				dataDir: this.workspaceDir,
				harness,
			}).snapshot;
			const env = reportModelEnv();
			const result = await new ResearchRuntime().run({
				runId: record.id,
				goalId: record.goalId,
				discoveryEnabled: false,
				question: record.reportContext,
				reportContext: record.reportTitle
					? `${record.reportContext}\n\nRequired report title: ${record.reportTitle}`
					: record.reportContext,
				workspaceDirectory: runDirectory,
				controlDirectory,
				goalWorkspaceDirectory: goalDirectory,
				workspaceRootDirectory: this.workspaceDir,
				env,
				config: {
					...harness.runPolicy.configOverrides,
					outputLanguage: record.outputLanguage ?? inferOutputLanguage(`${record.reportContext}\n${record.reportTitle ?? ""}`),
				},
				researchHarnessSnapshot: harness,
				runContextSnapshot: runContext,
				reportInput: {
					sourceRunId: `wiki-edition:${record.wikiRevision}`,
					cornellNotesArtifact,
					wikiCompilation: compilationResult(record.wikiRevision,
						targetStore.describeDirectory(`${knowledge.relativePath}/wiki`)),
					knowledgeInput: { ref: knowledge.relativePath, sha256: knowledge.sha256, byteLength: knowledge.byteLength },
				},
				reportTools: createGoalLlmWikiTools({
					goalDir: goalDirectory,
					knowledgeRoot: join(knowledge.absolutePath, "wiki"),
				}),
				signal,
			});
			const finalReport = targetStore.describeFile("report/final.md");
			const finishedAt = new Date().toISOString();
			record = {
				...record,
				status: "completed",
				updatedAt: finishedAt,
				finishedAt,
				result: { reportRef: finalReport.relativePath, usage: result.state.usage },
			};
			this.save(record);
		} catch (error) {
			const runState = new RunStateStore(join(
				serverRuntimeDirForGoal(record.goalId, this.workspaceDir), "runs", record.id,
			));
			const interrupted = loadRunStateIfValid(runState);
			if (interrupted?.status === "interrupted") {
				const now = new Date().toISOString();
				runState.save(interrupted, { ...interrupted, status: "failed", updated_at: now, finished_at: now,
					failure: { failure_class: "infrastructure", failed_stage: interrupted.failure?.failed_stage ?? "report_run",
						message: toErrorMessage(error) } });
			}
			const finishedAt = new Date().toISOString();
			this.save({ ...record, status: "failed", updatedAt: finishedAt, finishedAt,
				error: toErrorMessage(error) });
		}
	}

	private runDirectory(goalId: string, id: string): string {
		return join(this.workspaceDir, goalId, "wiki", "runs", id);
	}

	private save(record: ReportRunRecord): void {
		reportRunStore(this.runDirectory(record.goalId, record.id)).put("report-run", record);
		const indexRoot = join(serverRuntimeDirForGoal(record.goalId, this.workspaceDir), "report-runs", record.id);
		reportRunStore(indexRoot).put("report-run", record);
	}
}

function reportRunStore(directory: string): JsonDocumentStore<ReportRunRecord> {
	return new JsonDocumentStore(directory, (value) => {
		const record = value as Partial<ReportRunRecord> | null;
		if (!record || record.schemaVersion !== 3
			|| typeof record.id !== "string" || typeof record.goalId !== "string"
			|| typeof record.wikiRevision !== "string" || typeof record.reportContext !== "string"
			|| typeof record.createdAt !== "string" || typeof record.updatedAt !== "string"
			|| typeof record.status !== "string" || !["queued", "running", "completed", "failed"].includes(record.status)
			|| !record.input || typeof record.input !== "object" || Array.isArray(record.input)) {
			throw new Error("Report Run record is invalid");
		}
		return record as ReportRunRecord;
	});
}

function emptyWikiEvidence(runId: string): CornellNotesSnapshot {
	return {
		schema_version: 1,
		snapshot_id: "snapshot:wiki-edition",
		run_id: runId,
		pipeline: { id: "wiki-edition", version: "1", sha256: "0".repeat(64) },
		source_bundle_refs: [],
		notes: [],
	};
}

function compilationResult(
	revision: string,
	knowledge: ReturnType<RunArtifactStore["describeDirectory"]>,
): WikiCompilationResult {
	return {
		status: "reused",
		compilationId: `wiki-edition-${revision}`,
		baseKnowledgeSha256: knowledge.sha256,
		knowledge,
		pageCount: knowledge.files.filter((file) => file.relativePath.endsWith(".md")).length,
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
		agentStages: 0,
		sessionPaths: [],
		failedBatches: [],
	};
}

function loadRunStateIfValid(store: RunStateStore): RunStateV2 | null {
	try { return store.load() ?? null; } catch { return null; }
}

/** A Report Run freezes its models and Stage parameters the same way a Research Run does. */
function reportModelEnv(): NodeJS.ProcessEnv {
	return pinRunModelSelection(process.env);
}
