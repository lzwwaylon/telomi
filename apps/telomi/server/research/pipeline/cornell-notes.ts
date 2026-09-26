import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { hashJson } from "../../lib/hash.js";
import type { CornellNoteProcessor, CornellSourceFailure } from "../cornell-note.js";
import type { GoalTopicPlan } from "../../goals/topic-plan/index.js";
import type { ResearchModelUsage } from "../../agent-runtime/model-usage.js";
import type { LogicalSource } from "../research-types.js";
import type { RunArtifactStore } from "../../agent-runtime/artifact-store.js";
import {
	validateCornellNotesSnapshot,
	validateCornellNoteArtifact,
	type CornellNoteRecord,
	type CornellNotesSnapshot,
} from "../../cornell/contracts.js";

export interface CornellNotesMaterializeRequest {
	runId: string;
	sequence: number;
	question: string;
	goal: { title: string; description: string };
	discoveryEnabled: boolean;
	sources: LogicalSource[];
	previousSnapshot?: CornellNotesSnapshot;
	sourceBundleRefs: string[];
	pipeline: { id: string; version: string; sha256: string };
	workspaceDir: string;
	controlDir: string;
	signal: AbortSignal;
	artifactStore?: RunArtifactStore;
	topicPlan?: GoalTopicPlan;
	noteFocus?: string;
	onAgentStageCompleted?: (usage: ResearchModelUsage) => void;
}

export interface CornellNotesMaterializer {
	materialize(request: CornellNotesMaterializeRequest): Promise<CornellNotesMaterialization>;
}

export interface CornellNoteFailureRecord {
	source_id: string;
	title: string;
	canonical_locator: string;
	failure_class: "agent_stage_failed";
	message: string;
}

export interface CornellNotesMaterialization {
	evidence: CornellNotesSnapshot;
	failures: CornellNoteFailureRecord[];
}

export class RuntimeCornellNotesMaterializer implements CornellNotesMaterializer {
	constructor(private readonly processor: CornellNoteProcessor) {}

	async materialize(request: CornellNotesMaterializeRequest): Promise<CornellNotesMaterialization> {
		const documents = dedupeLogicalSources(request.sources);
		const previous = request.previousSnapshot;
		if (previous && previous.run_id !== request.runId) {
			throw new Error("Previous Cornell Note snapshot belongs to a different Run");
		}
		const pipelineMatches = !previous || hashJson(previous.pipeline) === hashJson(request.pipeline);
		const documentIds = new Set(documents.map((document) => document.id));
		const previousBySource = new Map((previous?.notes ?? [])
			.filter((record) => documentIds.has(record.note.source_id))
			.map((record) => [record.note.source_id, record]));
		if (pipelineMatches) {
			for (const document of documents) {
				if (previousBySource.has(document.id)) continue;
				const path = join(request.workspaceDir, cornellNoteArtifactPath(
					request.sequence,
					document.id,
					document.revisionSha256,
				));
				if (!existsSync(path)) continue;
				const note = validateCornellNoteArtifact(readObject(path));
				if (note.source_id !== document.id) {
					throw new Error(`Cornell Note checkpoint '${path}' belongs to '${note.source_id}'`);
				}
				previousBySource.set(document.id, toNoteRecord(document, note));
			}
		}
		const pending = documents.filter((document) => {
			const existing = previousBySource.get(document.id);
			return !pipelineMatches || existing?.source_revision_sha256 !== sourceRevision(document);
		});
		const pendingIds = new Set(pending.map((document) => document.id));
		const produced = pending.length === 0 ? { notes: [], failures: [] } : await this.processor.process({
			runId: request.runId,
			sequence: request.sequence,
			question: request.question,
			goal: request.goal,
			discoveryEnabled: request.discoveryEnabled,
			sources: pending,
			signal: request.signal,
			workspaceDir: request.workspaceDir,
			controlDir: request.controlDir,
			...(request.artifactStore ? { artifactStore: request.artifactStore } : {}),
			...(request.topicPlan ? { topicPlan: request.topicPlan } : {}),
			...(request.noteFocus ? { noteFocus: request.noteFocus } : {}),
			...(request.onAgentStageCompleted ? { onAgentStageCompleted: request.onAgentStageCompleted } : {}),
		});
		const processedIds = [...produced.notes.map((item) => item.source.id), ...produced.failures.map((item) => item.source.id)];
		if (processedIds.length !== pending.length
			|| new Set(processedIds).size !== pending.length
			|| processedIds.some((id) => !pendingIds.has(id))) {
			throw new Error("Cornell Note processor did not return every Source exactly once");
		}
		for (const item of produced.notes) previousBySource.set(item.source.id, toNoteRecord(item.source, item.note));
		const seed = {
			run_id: request.runId,
			pipeline: request.pipeline,
			source_bundle_refs: [...new Set([...(previous?.source_bundle_refs ?? []), ...request.sourceBundleRefs])].sort(),
			notes: [...previousBySource.values()]
				.sort((left, right) => left.note.source_id.localeCompare(right.note.source_id)),
		};
		return {
			evidence: validateCornellNotesSnapshot({
				schema_version: 1,
				snapshot_id: `snapshot:${hashJson(seed).slice(0, 24)}`,
				...seed,
			}),
			failures: produced.failures.map(toFailureRecord)
				.sort((left, right) => left.source_id.localeCompare(right.source_id)),
		};
	}
}

export function cornellNoteArtifactPath(sequence: number, sourceId: string, sourceRevisionSha256: string): string {
	const name = sourceId.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 100) || "source";
	return `artifacts/cornell-notes/sequence-${sequence}/${name}-${sourceRevisionSha256.slice(0, 12)}.json`;
}

function toFailureRecord(failure: CornellSourceFailure): CornellNoteFailureRecord {
	return {
		source_id: failure.source.id,
		title: failure.source.title,
		canonical_locator: failure.source.url,
		failure_class: "agent_stage_failed",
		message: failure.message.slice(0, 4_000),
	};
}

export function dedupeLogicalSources(documents: readonly LogicalSource[]): LogicalSource[] {
	const byId = new Map<string, LogicalSource>();
	for (const document of documents) {
		const existing = byId.get(document.id);
		if (existing && logicalSourceKey(existing) !== logicalSourceKey(document)) {
			throw new Error(`Logical Source identity '${document.id}' changed across Search Batches`);
		}
		byId.set(document.id, document);
	}
	return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function toNoteRecord(
	document: LogicalSource,
	note: CornellNoteRecord["note"],
): CornellNoteRecord {
	if (note.source_id !== document.id) throw new Error(`Cornell Note source_id '${note.source_id}' does not match '${document.id}'`);
	return {
		note,
		title: document.title,
		canonical_locator: document.url,
		provider_id: providerIdentity(document),
		provenance_ref: provenanceReference(document),
		source_revision_sha256: sourceRevision(document),
		members: sourceMembers(document),
	};
}

function sourceRevision(document: LogicalSource): string {
	return document.revisionSha256;
}

function providerIdentity(document: LogicalSource): string {
	return safeRuntimeId(document.providerId);
}

function provenanceReference(document: LogicalSource): string {
	return `provider:${providerIdentity(document)}:${safeRuntimeId(document.id)}`;
}

function sourceMembers(document: LogicalSource): CornellNoteRecord["members"] {
	return document.members.map((member) => ({
		source_id: safeRuntimeId(member.sourceId),
		provider_id: safeRuntimeId(member.providerId),
		title: member.title,
		canonical_locator: member.canonicalLocator,
	}));
}

function logicalSourceKey(document: LogicalSource): string {
	return hashJson({
		id: document.id,
		sourceIdentity: document.sourceIdentity,
		organizationKind: document.organizationKind,
		groupId: document.groupId,
	});
}

function safeRuntimeId(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._:-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 120) || "unknown";
}

function readObject(path: string): Record<string, unknown> {
	const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`);
	return value as Record<string, unknown>;
}
