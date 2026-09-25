// The Memory page's view of User Memory: what the user said, what Hindsight extracted from it, and
// the curation the user may apply. Hindsight stays the only store; these routes expose just the
// operations below, never bank-level deletes or clears, and nothing here lets an Agent write memory.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { Router, type Response } from "express";
import {
	GLOBAL_MEMORY_TAG,
	HindsightClient,
	isMemoryUnavailable,
	resolvePiUserMemoryConfig,
	type HindsightDocument,
	type HindsightMemoryUnit,
} from "pi-user-memory";

import type { GoalService } from "../service.js";
import { UserMemoryProjector } from "./user-memory-projector.js";
import { completeUserMemoryMigrations } from "./user-memory-migrations.js";
import { toErrorMessage } from "../../lib/values.js";
import { ResearchScheduleStore } from "../../research/schedules/store.js";
import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import {
	USER_MEMORY_UNAVAILABLE,
	type MemoryEpisodeSource,
	type MemoryEpisodeStatus,
	type MemoryEpisodeView,
	type MemoryFactView,
	type RejectedScheduleProposalView,
	type UserMemoryResponse,
} from "../../../shared/user-memory.js";

const MAX_FACT_LENGTH = 2_000;
/** Hindsight appends who is involved and why after the statement itself. */
const FACT_DETAIL_SEPARATOR = " | ";

class MemoryRequestError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

export function userMemoryClient(): HindsightClient {
	const { baseUrl, bankId } = resolvePiUserMemoryConfig();
	return new HindsightClient(baseUrl, bankId);
}

export function createUserMemoryRouter(
	workspaceDir: string,
	goals: Pick<GoalService, "getGoal">,
	client: HindsightClient = userMemoryClient(),
): Router {
	const router = Router();
	const route = (res: Response, goalId: string, work: (goalTag: string) => Promise<unknown>) => {
		void (async () => {
			try {
				if (!goals.getGoal(goalId)) throw new MemoryRequestError(404, `Unknown goal: ${goalId}`);
				// Startup normally finishes this; it waits here too in case User Memory came up later.
				await completeUserMemoryMigrations(client, workspaceDir);
				res.json(await work(`goal:${goalId}`));
			} catch (error) {
				if (error instanceof MemoryRequestError) res.status(error.status).json({ error: error.message });
				else if (isMemoryUnavailable(error)) res.status(503).json({ error: USER_MEMORY_UNAVAILABLE });
				else res.status(502).json({ error: toErrorMessage(error) });
			}
		})();
	};
	/** A Goal may curate its own Episodes and the global ones, never another Goal's. */
	const reachable = (tags: string[], goalTag: string) => tags.includes(goalTag) || tags.includes(GLOBAL_MEMORY_TAG);
	const episode = async (documentId: string, goalTag: string) => {
		const document = await client.getDocument(documentId);
		if (!document || !reachable(document.tags, goalTag)) throw new MemoryRequestError(404, "Memory Episode not found");
		return document;
	};

	router.get("/api/goals/:goalId/memory", (req, res) => route(res, req.params.goalId, async (goalTag): Promise<UserMemoryResponse> => {
		const goalId = req.params.goalId;
		const tags = [goalTag, GLOBAL_MEMORY_TAG];
		const [documents, valid, invalidated] = await Promise.all([
			client.listDocuments(tags),
			client.listMemoryUnits(tags, "valid"),
			client.listMemoryUnits(tags, "invalidated"),
		]);
		const facts = new Map<string, MemoryFactView[]>();
		for (const unit of [...valid, ...invalidated]) {
			// Observations are Hindsight's own consolidation of the facts and follow them.
			if (unit.fact_type === "observation" || !unit.document_id) continue;
			facts.set(unit.document_id, [...facts.get(unit.document_id) ?? [], factView(unit)]);
		}
		// ponytail: one request per Episode for its original text; page the list once a bank holds thousands.
		const details = await Promise.all(documents.map((document) => client.getDocument(document.id)));
		const episodes = documents.map((document, index) => episodeView(document, {
			text: details[index]?.original_text ?? "",
			facts: facts.get(document.id) ?? [],
			status: "retained",
			goals,
			workspaceDir,
		}));
		const retained = new Set(documents.map((document) => document.id));
		const pendingStatus: MemoryEpisodeStatus = goals.getGoal(goalId)?.isStreaming ? "waiting" : "failed";
		for (const pending of new UserMemoryProjector(workspaceDir, goalId).pendingEpisodes()) {
			// Accepted by Hindsight but not yet in the ledger (the write raced a restart): it is retained.
			if (retained.has(pending.documentId)) continue;
			episodes.push(episodeView({
				id: pending.documentId,
				created_at: pending.occurredAt,
				tags: [goalTag],
				...(pending.metadata ? { document_metadata: pending.metadata } : {}),
			}, { text: pending.content, facts: [], status: pendingStatus, goals, workspaceDir }));
		}
		episodes.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
		return { goal: episodes.filter((item) => !item.global), global: episodes.filter((item) => item.global) };
	}));

	router.patch("/api/goals/:goalId/memory/facts/:factId", (req, res) => route(res, req.params.goalId, async (goalTag) => {
		const body = (req.body ?? {}) as { text?: unknown; invalidated?: unknown };
		const unit = await client.getMemoryUnit(req.params.factId);
		if (!unit || unit.fact_type === "observation" || !reachable(unit.tags, goalTag)) {
			throw new MemoryRequestError(404, "Memory Fact not found");
		}
		if (typeof body.invalidated === "boolean" && body.text === undefined) {
			return factView(await client.updateMemoryUnit(unit.id, { state: body.invalidated ? "invalidated" : "valid" }));
		}
		if (typeof body.text !== "string" || body.invalidated !== undefined) {
			throw new MemoryRequestError(400, "Send either text or invalidated");
		}
		const statement = body.text.trim();
		if (!statement || statement.length > MAX_FACT_LENGTH) {
			throw new MemoryRequestError(400, `Memory Fact text must be 1-${MAX_FACT_LENGTH} characters`);
		}
		const { detail } = splitFact(unit.text);
		const updated = await client.updateMemoryUnit(unit.id, { text: detail ? `${statement}${FACT_DETAIL_SEPARATOR}${detail}` : statement });
		return factView(updated);
	}));

	router.delete("/api/goals/:goalId/memory/episodes/:documentId", (req, res) => route(res, req.params.goalId, async (goalTag) => {
		await client.deleteDocument((await episode(req.params.documentId, goalTag)).id);
		return { deleted: true };
	}));

	router.put("/api/goals/:goalId/memory/episodes/:documentId/scope", (req, res) => route(res, req.params.goalId, async (goalTag) => {
		const global = (req.body as { global?: unknown } | undefined)?.global;
		if (typeof global !== "boolean") throw new MemoryRequestError(400, "global must be true or false");
		const document = await episode(req.params.documentId, goalTag);
		const kept = document.tags.filter((tag) => tag !== GLOBAL_MEMORY_TAG);
		if (!global && !kept.some((tag) => tag.startsWith("goal:"))) {
			throw new MemoryRequestError(409, "This Episode's Goal was deleted; it can stay global or be deleted");
		}
		await client.setDocumentTags(document.id, global ? [...kept, GLOBAL_MEMORY_TAG] : kept);
		return { global };
	}));

	return router;
}

function splitFact(text: string): { statement: string; detail?: string } {
	const at = text.indexOf(FACT_DETAIL_SEPARATOR);
	return at < 0 ? { statement: text } : { statement: text.slice(0, at), detail: text.slice(at + FACT_DETAIL_SEPARATOR.length) };
}

function factView(unit: HindsightMemoryUnit): MemoryFactView {
	return {
		id: unit.id,
		text: splitFact(unit.text).statement,
		invalidated: unit.state === "invalidated",
		...(unit.edited_at ? { editedAt: unit.edited_at } : {}),
	};
}

function sourceOfDocument(documentId: string, metadataSource?: string): MemoryEpisodeSource {
	if (metadataSource === "research_schedule_proposal" || documentId.startsWith("pi-schedule-proposal-")) return "schedule_proposal";
	if (/^pi-(?:task|turn)-/u.test(documentId)) return "message";
	return "other";
}

function episodeView(document: HindsightDocument, view: {
	text: string;
	facts: MemoryFactView[];
	status: MemoryEpisodeStatus;
	goals: Pick<GoalService, "getGoal">;
	workspaceDir: string;
}): MemoryEpisodeView {
	const goalId = document.tags.find((tag) => tag.startsWith("goal:"))?.slice("goal:".length);
	const source = sourceOfDocument(document.id, document.document_metadata?.source);
	const scheduleProposal = source === "schedule_proposal" && goalId
		? rejectedScheduleProposal(view.workspaceDir, goalId, document)
		: undefined;
	return {
		documentId: document.id,
		source,
		// A rejected Proposal's retained text is Telomi's extraction input, never shown as the user's words.
		text: source === "schedule_proposal" ? "" : view.text,
		...(scheduleProposal ? { scheduleProposal } : {}),
		occurredAt: document.created_at,
		...(goalId ? { goalId, goalTitle: view.goals.getGoal(goalId)?.title } : {}),
		global: document.tags.includes(GLOBAL_MEMORY_TAG),
		status: view.status,
		facts: view.facts,
	};
}

/** The rejected Proposal as its Schedule records it; undefined once the Schedule or its Goal is gone. */
function rejectedScheduleProposal(workspaceDir: string, goalId: string, document: HindsightDocument): RejectedScheduleProposalView | undefined {
	const scheduleId = document.document_metadata?.schedule_id;
	const proposalId = document.document_metadata?.source_id ?? document.id.replace(/^pi-schedule-proposal-/u, "");
	// Opening the store would create a Schedule database for a Goal that never had one.
	if (!scheduleId || !existsSync(join(serverRuntimeDirForGoal(goalId, workspaceDir), "research/schedules.sqlite"))) return undefined;
	const store = new ResearchScheduleStore(goalId, workspaceDir);
	try {
		const schedule = store.get(scheduleId);
		const proposal = schedule ? store.listProposals(scheduleId).find((candidate) => candidate.id === proposalId) : undefined;
		if (!schedule || !proposal) return undefined;
		return {
			scheduleTitle: schedule.title,
			summary: proposal.summary,
			...(proposal.rejectionReason ? { reason: proposal.rejectionReason } : {}),
		};
	} finally {
		store.close();
	}
}
