import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { GoalTopicPlanStore } from "../goals/topic-plan/index.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { toErrorMessage } from "../lib/values.js";
import { isRecord } from "../lib/values.js";
import { readJsonl } from "../lib/fs.js";
import { validateJsonSchema } from "../agent-runtime/structured-output.js";
import { WikiCurationReviewSchema } from "../wiki/wiki-update-job.js";
import type { WikiGoalContext, WikiInvestigationReview } from "../wiki/contracts.js";
import type { WikiMainSessionContext } from '../main-agent/wiki-context.js';
import { readInvestigationResult } from "./investigate.js";
import { resolveNoteReadingCue } from "./note-reading.js";
import { drainCueWikiUpdates, enqueueCueWikiUpdate, getCueWikiQueueStatus } from "./cue-wiki-queue.js";

interface GoalInput {
	workspaceDir: string;
	goalId: string;
	goalDir: string;
	goalContext: WikiGoalContext;
	env: Record<string, string | undefined>;
	getGoalContext?: () => WikiGoalContext;
	curationInstructions?: string;
	mainSession?: WikiMainSessionContext;
}

export interface InvestigationWikiReview {
	useful_findings: string[];
	excluded_findings: Array<{ finding: string; reason: string }>;
}

const foregroundGoals = new Set<string>();
export function setGoalCueWikiForeground(goalDir: string, active: boolean): void {
	if (active) foregroundGoals.add(goalDir);
	else foregroundGoals.delete(goalDir);
}

function reviewStore(input: Pick<GoalInput, "workspaceDir" | "goalId">, id: string): RunArtifactStore {
	if (!/^[a-f0-9]{24}$/u.test(id)) throw new Error("Invalid delivered investigation id");
	return new RunArtifactStore(join(serverRuntimeDirForGoal(input.goalId, input.workspaceDir), "research", "investigations", id));
}

/** Called only after the final assistant reply is durable, never from a Reader or Tool execution. */
export function recordDeliveredInvestigationReview(input: Pick<GoalInput, "workspaceDir" | "goalId" | "goalDir">,
	id: string, review?: InvestigationWikiReview): void {
	const store = reviewStore(input, id);
	const previous = readReview(input, id);
	if (previous && !review) return;
	const result = readInvestigationResult(input.goalDir, id);
	const curation: WikiInvestigationReview = { investigationId: id, question: result.question, answer: result.answer,
		usefulFindings: review?.useful_findings ?? [], excludedFindings: review?.excluded_findings ?? [] };
	validateJsonSchema(WikiCurationReviewSchema, curation);
	if (previous && JSON.stringify(previous) === JSON.stringify(curation)) return;
	appendFileSync(join(store.root, "wiki-reviews.jsonl"), `${JSON.stringify({ schema_version: 1, goal_id: input.goalId,
		delivered_at: new Date().toISOString(), review: curation })}\n`);
}

function readReview(input: Pick<GoalInput, "workspaceDir" | "goalId">, id: string): WikiInvestigationReview | undefined {
	const store = reviewStore(input, id);
	const history = join(store.root, "wiki-reviews.jsonl");
	const value = existsSync(history) ? readJsonl<unknown>(store.describeFile("wiki-reviews.jsonl").absolutePath).at(-1)
		: existsSync(join(store.root, "wiki-review.json")) ? store.readJson<unknown>(store.describeFile("wiki-review.json")) : undefined;
	if (value === undefined) return undefined;
	if (!isRecord(value) || value.schema_version !== 1 || value.goal_id !== input.goalId
		|| typeof value.delivered_at !== "string" || !Number.isFinite(Date.parse(value.delivered_at))) throw new Error("Invalid Wiki delivery review");
	validateJsonSchema(WikiCurationReviewSchema, value.review);
	const review = value.review as WikiInvestigationReview;
	if (review.investigationId !== id) throw new Error("Wiki review belongs to another investigation");
	return review;
}

/** Latest editorial review for explicit whole-corpus maintenance; frozen batches keep their own versions. */
export function listDeliveredInvestigationReviews(input: Pick<GoalInput, "workspaceDir" | "goalId">): WikiInvestigationReview[] {
	const root = join(serverRuntimeDirForGoal(input.goalId, input.workspaceDir), "research", "investigations");
	return (existsSync(root) ? readdirSync(root, { withFileTypes: true }) : [])
		.filter(entry => entry.isDirectory() && /^[a-f0-9]{24}$/u.test(entry.name)).flatMap(entry => {
			try { const review = readReview(input, entry.name); return review ? [review] : []; }
			catch (error) { console.warn(`[telomi][cue-wiki] review unavailable for ${entry.name}: ${toErrorMessage(error)}`); return []; }
		});
}

/** A Tool receipt alone is preparatory; its persisted final assistant reply proves delivery. */
function recoverDeliveredReviews(input: Pick<GoalInput, "workspaceDir" | "goalId" | "goalDir">): void {
	const path = join(input.goalDir, "context.jsonl");
	if (!existsSync(path)) return;
	const store = new RunArtifactStore(input.goalDir);
	let delivery: { id: string; review?: InvestigationWikiReview } | undefined;
	const delivered = new Map<string, InvestigationWikiReview | undefined>();
	for (const entry of readJsonl<unknown>(store.describeFile("context.jsonl").absolutePath)) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role === "user") delivery = undefined;
		if (message.role === "toolResult" && message.isError !== true && message.toolName === "deliver_investigation"
			&& isRecord(message.details) && typeof message.details.investigation_id === "string") {
			delivery = { id: message.details.investigation_id,
				...(isRecord(message.details.wiki_review) ? { review: message.details.wiki_review as unknown as InvestigationWikiReview } : {}) };
		}
		if (message.role !== "assistant" || !delivery || !isRecord(message.mainRoute)
			|| !isRecord(message.mainRoute.trace) || message.mainRoute.trace.coarseAction !== "deliver_investigation") continue;
		delivered.set(delivery.id, delivery.review);
		delivery = undefined;
	}
	for (const [id, review] of delivered) {
		try { recordDeliveredInvestigationReview(input, id, review); }
		catch (error) { console.warn(`[telomi][cue-wiki] delivery recovery failed for ${id}: ${toErrorMessage(error)}`); }
	}
}

/** Startup repairs registration after successful delivery; saved or interrupted readings stay separate. */
export function registerSavedInvestigationCues(input: Pick<GoalInput, "workspaceDir" | "goalId" | "goalDir">,
	origin?: { invocationId?: string; investigationId: string; threadId?: string }): void {
	const root = join(input.goalDir, "artifacts", "deep-search");
	if (!existsSync(root)) return;
	if (!origin) recoverDeliveredReviews(input);
	const ownFiles = readdirSync(root).filter(file => /^[a-f0-9]{24}-(?:external-)?[1-9][0-9]*\.json$/u.test(file)).sort();
	const reviews = origin ? [readReview(input, origin.investigationId)].filter((review): review is WikiInvestigationReview => Boolean(review))
		: listDeliveredInvestigationReviews(input);
	const store = new RunArtifactStore(input.goalDir);
	for (const curationReview of reviews) {
		const files = new Set(origin?.invocationId ? [`${origin.invocationId}.json`]
			: ownFiles.filter(file => file.startsWith(`${curationReview.investigationId}-`)));
		try { for (const file of referencedReaderArtifacts(input.goalDir, curationReview.investigationId)) files.add(file); }
		catch (error) { console.warn(`[telomi][cue-wiki] reused evidence unavailable for ${curationReview.investigationId}: ${toErrorMessage(error)}`); }
		for (const file of files) {
			try {
				const investigationId = file.slice(0, 24);
				const binding = join(serverRuntimeDirForGoal(input.goalId, input.workspaceDir), "research", "investigations", investigationId, "thread-binding.json");
				const threadId = (investigationId === curationReview.investigationId ? origin?.threadId : undefined)
					?? (existsSync(binding) ? (JSON.parse(readFileSync(binding, "utf8")) as { thread_id?: string }).thread_id : undefined);
				const artifact = store.describeFile(`artifacts/deep-search/${file}`);
				enqueueCueWikiUpdate({ ...input, investigationId, threadId, curationReview,
					artifactRef: { path: artifact.relativePath, sha256: artifact.sha256 } });
			} catch (error) {
				// One damaged historical file cannot hide other committed Notes or fail a user answer.
				console.warn(`[telomi][cue-wiki] registration failed for ${file}: ${toErrorMessage(error)}`);
			}
		}
	}
}

/** Resolve only durable Cue refs in this delivered answer's frozen citation mapping. */
function referencedReaderArtifacts(goalDir: string, investigationId: string): string[] {
	const result = readInvestigationResult(goalDir, investigationId);
	const store = new RunArtifactStore(goalDir);
	const path = `artifacts/investigations/${investigationId}/citations.json`;
	if (!existsSync(join(goalDir, path))) return [];
	const mapping = store.readJson<unknown>(store.describeFile(path));
	if (!isRecord(mapping) || mapping.schema_version !== 1 || !Array.isArray(mapping.citations)) throw new Error("Invalid frozen investigation citations");
	const references = new Set(result.citation_refs);
	return mapping.citations.flatMap((row): string[] => {
		if (!isRecord(row) || typeof row.ref !== "string" || !references.has(row.ref) || !row.ref.startsWith("deep-search:")) return [];
		if (!isRecord(row.cue) || row.cue.ref !== row.ref) throw new Error("Frozen investigation Cue identity changed");
		const match = /^deep-search:([a-f0-9]{24}-(?:external-)?[1-9][0-9]*):cue-[1-9][0-9]*$/u.exec(row.ref);
		if (!match) throw new Error("Invalid retained Reader reference");
		// Validate the owning Goal boundary before the resolver can read a historical artifact.
		store.describeFile(`artifacts/deep-search/${match[1]}.json`);
		const cue = resolveNoteReadingCue(goalDir, row.ref);
		if (!cue || cue.cue !== row.cue.cue || cue.note !== row.cue.note || cue.section_title !== row.cue.section_title) {
			throw new Error("Retained Reader Cue differs from frozen delivery evidence");
		}
		return [`${match[1]}.json`];
	});
}

/** Returns a durable start receipt; background errors remain in the queue and Wiki Activity. */
export function startGoalCueWikiUpdates(input: GoalInput & { retry?: boolean }) {
	const getContext = () => {
		const topics = new GoalTopicPlanStore(input.goalId, input.workspaceDir);
		const active = topics.readActive();
		const reframePending = active && topics.listProposals().some(proposal => proposal.status === "activated"
			&& proposal.candidate_plan.revision === active.revision
			&& (!proposal.reframe || ["running", "failed"].includes(proposal.reframe.status)));
		return { goalContext: input.getGoalContext?.() ?? input.goalContext,
			topicPlan: active && (!foregroundGoals.has(input.goalDir) || input.retry === true)
				&& !topics.hasPendingRequiredConfirmation() && !reframePending ? active : undefined };
	};
	const execution = drainCueWikiUpdates({ ...input, ...getContext(), getContext });
	void execution.then(status => {
		if (status.status === "failed" || status.status === "interrupted") console.warn(`[telomi][cue-wiki] ${input.goalId}: ${status.message ?? status.status}`);
	}).catch(error => console.warn(`[telomi][cue-wiki] ${input.goalId}: ${toErrorMessage(error)}`));
	return { receipt: getCueWikiQueueStatus(input), execution };
}
