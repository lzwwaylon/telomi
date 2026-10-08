import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "@sinclair/typebox";

import { ArtifactRefSchema, RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { validateJsonSchema } from "../agent-runtime/structured-output.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { hashJson, sha256 } from "../lib/hash.js";
import { toErrorMessage } from "../lib/values.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { createCueNoteSnapshot } from "./cue-note-snapshot.js";
import { validateGoalTopicPlan, requireWikiGoalContext, type GoalTopicPlan, type WikiGoalContext, type WikiInvestigationReview } from "../wiki/contracts.js";
import { WikiCueOriginSchema, WikiCurationReviewSchema, WikiUpdateJobStore } from "../wiki/wiki-update-job.js";
import { resumeWikiUpdate, startWikiUpdateActivity, wikiUpdateRecordDir, type WikiUpdateDependencies } from "../wiki/update-runner.js";
import { readGoalWikiMainContext, WikiMainSessionContextSchema, type WikiMainSessionContext } from '../main-agent/wiki-context.js';

const Sha = Type.String({ pattern: "^[a-f0-9]{64}$" });
const BatchStatus = Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("interrupted")]);
const QueueSchema = Type.Object({
	schema_version: Type.Literal(1),
	goal_id: Type.String({ minLength: 1 }),
	entries: Type.Array(Type.Object({
		key: Sha,
		origin: WikiCueOriginSchema,
		curation_review: Type.Optional(WikiCurationReviewSchema),
		ready_at: Type.Optional(Type.String({ format: "date-time" })),
		batch_id: Type.Optional(Sha),
	}, { additionalProperties: false })),
	batches: Type.Array(Type.Object({
		id: Sha,
		keys: Type.Array(Sha, { minItems: 1, uniqueItems: true }),
		status: BatchStatus,
		wiki_update_id: Type.String({ pattern: "^wiki_cue_[a-f0-9]{64}$" }),
		snapshot_ref: Type.Optional(ArtifactRefSchema),
		curation_reviews: Type.Optional(Type.Array(WikiCurationReviewSchema)),
		main_session: Type.Optional(WikiMainSessionContextSchema),
		curation_instructions: Type.Optional(Type.String({ minLength: 1 })),
		message: Type.Optional(Type.String()),
	}, { additionalProperties: false })),
}, { additionalProperties: false });
type Queue = Static<typeof QueueSchema>;
interface GoalLocation { workspaceDir: string; goalId: string; goalDir: string }

export interface CueWikiQueueStatus {
	status: "idle" | "pending" | "running" | "failed" | "interrupted";
	pendingCount: number;
	wikiUpdateId?: string;
	message?: string;
}

export function enqueueCueWikiUpdate(input: GoalLocation & {
	artifactRef: { path: string; sha256: string };
	investigationId: string;
	threadId?: string;
	curationReview: WikiInvestigationReview;
	clock?: { now(): number };
}): CueWikiQueueStatus {
	const origin = {
		investigation_id: input.investigationId,
		...(input.threadId ? { thread_id: input.threadId } : {}),
		artifact_ref: { relative_path: input.artifactRef.path, sha256: input.artifactRef.sha256 },
	};
	validateJsonSchema(WikiCueOriginSchema, origin);
	validateJsonSchema(WikiCurationReviewSchema, input.curationReview);
	const artifact = new RunArtifactStore(input.goalDir).describeFile(input.artifactRef.path);
	if (artifact.sha256 !== input.artifactRef.sha256) throw new Error("Cue Wiki input hash changed");
	const result = JSON.parse(readFileSync(artifact.absolutePath, "utf-8")) as { cues?: unknown[] };
	const queue = loadQueue(input);
	if (!Array.isArray(result.cues)) throw new Error("Cue Wiki input must contain saved Cues");
	if (!result.cues.length) return describe(queue);
	const artifactKey = sha256(`${origin.artifact_ref.relative_path}\n${origin.artifact_ref.sha256}`);
	const key = sha256(`${artifactKey}\n${hashJson(input.curationReview)}`);
	const existing = queue.entries.find(entry => entry.key === key);
	if (!existing || (!existing.batch_id && !existing.curation_review)) {
		// Revalidate persisted origins before admission so one damaged historical file cannot poison a batch.
		createCueNoteSnapshot({ goalDir: input.goalDir, artifactRefs: [input.artifactRef], snapshotId: `cue-admission-${key}` });
		const entry = { key, origin, curation_review: input.curationReview,
			ready_at: new Date((input.clock?.now() ?? Date.now()) + 5_000).toISOString() };
		if (existing) Object.assign(existing, entry);
		else queue.entries.push(entry);
		saveQueue(input, queue);
	}
	return describe(queue);
}

export function getCueWikiQueueStatus(input: GoalLocation): CueWikiQueueStatus {
	const queue = loadQueue(input);
	synchronizeJobs(input, queue);
	return describe(queue);
}

const activeDrains = new Map<string, Promise<CueWikiQueueStatus>>();

/** Call after durable Cue commit, Topic confirmation, startup rescan, or explicit retry.
 * No investigation AbortSignal is accepted: committed evidence belongs to background maintenance.
 */
export function drainCueWikiUpdates(input: GoalLocation & {
	goalContext: WikiGoalContext;
	topicPlan?: GoalTopicPlan;
	env: Record<string, string | undefined>;
	retry?: boolean;
	curationInstructions?: string;
	mainSession?: WikiMainSessionContext;
	/** Re-read Goal/Topic readiness between batches rather than extending a stale foreground snapshot. */
	getContext?: () => { goalContext: WikiGoalContext; topicPlan?: GoalTopicPlan };
	/** Deterministic queue-clock seam; production uses the real clock and timer. */
	clock?: { now(): number; wait(milliseconds: number): Promise<void> };
	dependencies?: WikiUpdateDependencies;
}): Promise<CueWikiQueueStatus> {
	const key = queuePath(input);
	const active = activeDrains.get(key);
	if (active) return active.then(() => drainCueWikiUpdates(input));
	const execution = drain(input).finally(() => { if (activeDrains.get(key) === execution) activeDrains.delete(key); });
	activeDrains.set(key, execution);
	return execution;
}

async function drain(input: Parameters<typeof drainCueWikiUpdates>[0]): Promise<CueWikiQueueStatus> {
	let retry = input.retry === true;
	while (true) {
		const context = input.getContext?.() ?? input;
		const goalContext = requireWikiGoalContext(context.goalContext);
		const topicPlan = context.topicPlan ? validateGoalTopicPlan(context.topicPlan) : undefined;
		if (topicPlan && topicPlan.goal_id !== input.goalId) throw new Error("Cue Wiki Topic Plan belongs to another Goal");
		const queue = loadQueue(input);
		synchronizeJobs(input, queue);
		if (!topicPlan) return describe(queue);
		let batch = executableBatch(queue, retry);
		if (batch && batch.status !== "pending" && (!retry || batch.status === "running")) return describe(queue);
		if (!batch) {
			const entries = queue.entries.filter(entry => !entry.batch_id && entry.curation_review)
				.sort((left, right) => left.key.localeCompare(right.key));
			if (!entries.length) return describe(queue);
			const readyAt = Math.max(...entries.map(entry => entry.ready_at ? Date.parse(entry.ready_at) : 0));
			const wait = readyAt - (input.clock?.now() ?? Date.now());
			if (wait > 0) { await (input.clock?.wait(wait) ?? delay(wait)); continue; }
			const mainSession = input.mainSession ?? readGoalWikiMainContext(input.workspaceDir, input.goalId, goalContext);
			if (mainSession && mainSession.goalId !== input.goalId) throw new Error('Main branch context belongs to another Goal');
			const id = sha256(JSON.stringify({ keys: entries.map(entry => entry.key), mainSession }));
			batch = { id, keys: entries.map(entry => entry.key), status: "pending", wiki_update_id: `wiki_cue_${id}`,
				...(input.curationInstructions ? { curation_instructions: input.curationInstructions } : {}),
				...(mainSession ? { main_session: mainSession } : {}),
				curation_reviews: [...new Map([...entries].sort((a, b) => (a.ready_at ?? "").localeCompare(b.ready_at ?? ""))
					.map(entry => [entry.curation_review!.investigationId, entry.curation_review!])).values()] };
			for (const entry of entries) entry.batch_id = id;
			queue.batches.push(batch);
			saveQueue(input, queue);
		}
		const batchId = batch.id;
		try {
			let job = new WikiUpdateJobStore(wikiUpdateRecordDir(input.workspaceDir, input.goalId, batch.wiki_update_id)).load();
			if (job && retry && (JSON.stringify(job.topic_plan) !== JSON.stringify(topicPlan)
				|| JSON.stringify(job.goal_context) !== JSON.stringify(goalContext)
				|| (input.curationInstructions && input.curationInstructions !== job.reason))) {
				// Explicit retry may refresh stale Topic/Goal inputs. Keep the failed Activity and frozen Cue batch.
				if (input.curationInstructions) batch.curation_instructions = input.curationInstructions;
				batch.wiki_update_id = `wiki_cue_${sha256(JSON.stringify({ batch: batch.id, topicPlan, goalContext,
					...(batch.curation_instructions ? { curationInstructions: batch.curation_instructions } : {}) }))}`;
				batch.status = "pending";
				delete batch.message;
				saveQueue(input, queue);
				job = new WikiUpdateJobStore(wikiUpdateRecordDir(input.workspaceDir, input.goalId, batch.wiki_update_id)).load();
			}
			let execution: Promise<unknown>;
			if (job) {
				if (["queued", "running", "succeeded"].includes(job.status)) {
					synchronizeJobs(input, queue);
					if (job.status === "succeeded") { retry = false; continue; }
					return describe(queue);
				}
				if (!retry) return describe(queue);
				execution = resumeWikiUpdate({ ...input, runId: batch.wiki_update_id });
			} else {
				const entries = batch.keys.map(key => queue.entries.find(entry => entry.key === key)!);
				const sourceRunDirectory = join(input.goalDir, "wiki", "cue-batches", batch.id);
				const store = new RunArtifactStore(sourceRunDirectory);
				const path = "artifacts/input/notes.json";
				if (!batch.snapshot_ref) {
					const snapshot = createCueNoteSnapshot({ goalDir: input.goalDir,
						artifactRefs: entries.map(entry => ({ path: entry.origin.artifact_ref.relative_path, sha256: entry.origin.artifact_ref.sha256 })),
						snapshotId: `cue-batch-${batch.id}` });
					const text = `${JSON.stringify(snapshot, null, 2)}\n`;
					const frozen = existsSync(join(sourceRunDirectory, path)) ? store.describeFile(path) : store.publishText(text, path);
					if (frozen.sha256 !== sha256(text)) throw new Error("Cue Wiki frozen batch snapshot changed");
					batch.snapshot_ref = { relative_path: path, sha256: frozen.sha256, byte_length: frozen.byteLength };
					saveQueue(input, queue);
				}
				const frozen = store.openFile(batch.snapshot_ref);
				const started = startWikiUpdateActivity({ ...input, wikiUpdateId: batch.wiki_update_id,
					goal: `${goalContext.title}\n${goalContext.description}`, goalContext, topicPlan, sourceRunDirectory,
					sourceNotes: { relative_path: path, sha256: frozen.sha256, byte_length: frozen.byteLength },
					cueOrigins: entries.map(entry => entry.origin), curationReviews: batch.curation_reviews,
					...(batch.main_session ? { mainSession: batch.main_session as WikiMainSessionContext } : {}),
					trigger: { kind: "system" }, reason: batch.curation_instructions ?? "整理已交付调查中适合 Goal 的新 Cue Notes 到 Wiki" });
				if (started.reused) return describe(queue);
				execution = started.execution;
			}
			batch.status = "running";
			delete batch.message;
			saveQueue(input, queue);
			await execution;
			retry = false;
			// Enqueue may have added a next batch while the Agent ran; never overwrite its new entries.
			const current = loadQueue(input);
			synchronizeJobs(input, current);
			if (current.batches.find(candidate => candidate.id === batchId)?.status !== "succeeded") return describe(current);
		} catch (error) {
			const current = loadQueue(input);
			const failed = current.batches.find(candidate => candidate.id === batchId)!;
			failed.status = "failed";
			failed.message = toErrorMessage(error);
			saveQueue(input, current);
			return describe(current);
		}
	}
}

function synchronizeJobs(input: GoalLocation, queue: Queue): void {
	let changed = false;
	for (const batch of queue.batches) {
		if (batch.status === "succeeded") continue;
		const job = new WikiUpdateJobStore(wikiUpdateRecordDir(input.workspaceDir, input.goalId, batch.wiki_update_id)).load();
		if (!job) continue;
		const status = job.status === "succeeded" ? "succeeded"
			: job.status === "interrupted" ? "interrupted"
				: ["failed", "partial", "cancelled"].includes(job.status) ? "failed" : "running";
		if (status !== batch.status || job.message !== batch.message) {
			batch.status = status;
			if (job.message) batch.message = job.message;
			else delete batch.message;
			changed = true;
		}
	}
	if (changed) saveQueue(input, queue);
}

function executableBatch(queue: Queue, retry: boolean): Queue['batches'][number] | undefined {
	return queue.batches.find(batch => batch.status === 'running')
		?? (retry ? queue.batches.find(batch => batch.status === 'failed' || batch.status === 'interrupted') : undefined)
		?? queue.batches.find(batch => batch.status === 'pending' && batch.curation_reviews?.length);
}

function describe(queue: Queue): CueWikiQueueStatus {
	const active = executableBatch(queue, false);
	const batch = active ?? queue.batches.find(candidate => candidate.status === 'failed' || candidate.status === 'interrupted');
	const pendingCount = queue.entries.filter(entry => entry.batch_id
		? queue.batches.some(candidate => candidate.id === entry.batch_id && candidate.status !== "succeeded"
			&& (candidate.status !== "pending" || candidate.curation_reviews?.length))
		: Boolean(entry.curation_review)).length;
	const hasReadyCandidates = queue.entries.some(entry => !entry.batch_id && entry.curation_review);
	const receiptBatch = active || !hasReadyCandidates ? batch : undefined;
	return { status: active ? active.status === 'running' ? 'running' : 'pending'
		: hasReadyCandidates ? 'pending' : batch ? batch.status === 'interrupted' ? 'interrupted' : 'failed' : 'idle', pendingCount,
		...(receiptBatch ? { wikiUpdateId: receiptBatch.wiki_update_id, ...(receiptBatch.message ? { message: receiptBatch.message } : {}) } : {}) };
}

function queuePath(input: GoalLocation): string { return join(serverRuntimeDirForGoal(input.goalId, input.workspaceDir), "cue-wiki-queue.json"); }
function loadQueue(input: GoalLocation): Queue {
	const path = queuePath(input);
	if (!existsSync(path)) return { schema_version: 1, goal_id: input.goalId, entries: [], batches: [] };
	const value = JSON.parse(readFileSync(path, "utf-8")) as Queue;
	validateJsonSchema(QueueSchema, value);
	if (value.goal_id !== input.goalId || new Set(value.entries.map(entry => entry.key)).size !== value.entries.length
		|| new Set(value.batches.map(batch => batch.id)).size !== value.batches.length
		|| value.entries.some(entry => {
			const artifactKey = sha256(`${entry.origin.artifact_ref.relative_path}\n${entry.origin.artifact_ref.sha256}`);
			return (entry.key !== artifactKey && (!entry.curation_review || entry.key !== sha256(`${artifactKey}\n${hashJson(entry.curation_review)}`)))
				|| (entry.batch_id && !value.batches.some(batch => batch.id === entry.batch_id && batch.keys.includes(entry.key)));
		})
		|| value.batches.some(batch => batch.keys.some(key => !value.entries.some(entry => entry.key === key && entry.batch_id === batch.id)))) {
		throw new Error("Cue Wiki queue has inconsistent Goal or batch identities");
	}
	return value;
}
function saveQueue(input: GoalLocation, queue: Queue): void { validateJsonSchema(QueueSchema, queue); writeJsonAtomic(queuePath(input), queue); }
