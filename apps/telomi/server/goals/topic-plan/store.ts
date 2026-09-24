import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { JsonDocumentStore } from "../../lib/json-document-store.js";
import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import type {
	DiscoveryCandidate,
	DiscoveryInboxItem,
	GoalTopic,
	GoalTopicPatch,
	GoalTopicPlan,
	GoalTopicPlanProposal,
} from "./contracts.js";
import {
	validateDiscoveryCandidate,
	validateGoalTopicPatch,
	validateGoalTopicPlan,
} from "./validation.js";
import {
	assignGoalTopicDocumentIds,
	goalTopicDocumentFromPlan,
	goalTopicPlanFromDocument,
	goalTopicDocumentToPatch,
	hashGoalTopicDocument,
	type GoalTopicDocument,
} from "./document.js";
import { GoalTopicPlanHistory, type GoalTopicPlanHistoryEntry } from "./history.js";
import { writeJsonAtomic } from "../../lib/fs.js";

const PROPOSAL_FIELDS = new Set([
	"schema_version", "proposal_id", "goal_id", "base_revision", "status", "created_at", "activated_at",
	"superseded_at", "superseded_by", "source", "draft_sha256", "source_discovery_ids", "confirmed_version",
	"patch", "candidate_plan", "diff", "reframe",
]);

export class GoalTopicPlanStore {
	private readonly root: string;
	private readonly history: GoalTopicPlanHistory;
	private readonly proposals: JsonDocumentStore<GoalTopicPlanProposal>;
	private readonly revisions: JsonDocumentStore<GoalTopicPlan>;
	private readonly discoveries: JsonDocumentStore<DiscoveryCandidate>;

	constructor(private readonly goalId: string, private readonly dataDir: string) {
		this.root = join(serverRuntimeDirForGoal(goalId, dataDir), "topic-plan");
		this.history = new GoalTopicPlanHistory(goalId, dataDir);
		this.proposals = new JsonDocumentStore(join(this.root, "proposals"), (value, id) =>
			validateProposal(value as GoalTopicPlanProposal | undefined, goalId, safeId(id)));
		this.revisions = new JsonDocumentStore(join(this.root, "revisions"), (value) => validateGoalTopicPlan(value as GoalTopicPlan));
		this.discoveries = new JsonDocumentStore(join(this.root, "discoveries"), (value, id) => {
			safeId(id);
			const candidate = value as DiscoveryCandidate;
			return validateDiscoveryCandidate(candidate, this.readRevision(candidate.topic_plan_revision));
		});
	}

	readActive(): GoalTopicPlan | undefined {
		const pointer = readRecord<{ schema_version?: unknown; revision?: unknown }>(join(this.root, "active.json"), false);
		const latest = this.history.latest();
		if (latest && (!pointer || pointer.revision !== latest.version)) {
			const recovered = goalTopicPlanFromDocument(this.goalId, latest.plan, latest.version);
			this.revisions.put(latest.version, recovered);
			writeJsonAtomic(join(this.root, "active.json"), { schema_version: 1, revision: latest.version }, { mode: 0o600 });
			this.recoverConfirmedProposal(latest, recovered);
			this.history.materializeCurrent(join(this.dataDir, this.goalId), latest);
			return recovered;
		}
		if (latest) this.history.materializeCurrent(join(this.dataDir, this.goalId), latest);
		if (!pointer) return undefined;
		if (pointer.schema_version !== 1 || typeof pointer.revision !== "string") throw new Error("Active Goal Topic Plan pointer is invalid");
		const active = this.readRevision(pointer.revision);
		if (latest) this.recoverConfirmedProposal(latest, active);
		return active;
	}

	/** The mutable document Main Agent sees, without IDs for unconfirmed Topics. */
	readMainAgentDocument(): GoalTopicDocument {
		const active = this.readActive();
		const pending = this.listProposals().find((proposal) => proposal.status === "proposed");
		const document = goalTopicDocumentFromPlan(pending?.candidate_plan ?? active);
		if (pending) {
			const confirmedIds = new Set(active?.topics.map((topic) => topic.id) ?? []);
			document.topics = document.topics.map((topic) => {
				if (topic.id && confirmedIds.has(topic.id)) return topic;
				const { id: _draftId, ...unconfirmedTopic } = topic;
				return unconfirmedTopic;
			});
		}
		return document;
	}

	requireResearchReady(): GoalTopicPlan {
		const active = this.readActive();
		if (!active) throw new Error("Goal Topic Plan must be confirmed before research or scheduling.");
		if (this.hasPendingRequiredConfirmation()) {
			throw new Error("The user-requested Topic Plan revision must be confirmed before research or scheduling.");
		}
		return active;
	}

	hasPendingRequiredConfirmation(): boolean {
		return this.listProposals().some((proposal) => proposal.status === "proposed");
	}

	readRevision(revision: string): GoalTopicPlan {
		const plan = this.revisions.get(safeId(revision));
		if (!plan) throw new Error(`Missing Goal Topic Plan record: ${join(this.root, "revisions", `${revision}.json`)}`);
		return plan;
	}

	readProposal(proposalId: string): GoalTopicPlanProposal {
		const proposal = this.proposals.get(safeId(proposalId));
		if (!proposal) throw new Error(`Missing Goal Topic Plan record: ${join(this.root, "proposals", `${proposalId}.json`)}`);
		return proposal;
	}

	listProposals(): GoalTopicPlanProposal[] {
		return this.proposals.list()
			.sort((left, right) => right.created_at.localeCompare(left.created_at));
	}

	/**
	 * 启动时修复中断的激活。没有任何 reframe 记录同样算中断：`activate()` 只在激活流程里
	 * 调用，进程启动时不可能还有在跑的后续处理，所以这种 Proposal 的确认之后停在了半路。
	 */
	markInterruptedActivities(now = new Date()): { reframes: string[] } {
		const reframes = this.listProposals()
			.filter((proposal) => proposal.status === "activated"
				&& (proposal.reframe === undefined || proposal.reframe.status === "running"))
			.map((proposal) => {
				this.recordReframe(proposal.proposal_id, {
					status: "failed",
					updated_at: now.toISOString(),
					message: "Topic Plan 已确认，后续处理因后端进程停止而中断，可以重试。",
				});
				return proposal.proposal_id;
			});
		return { reframes };
	}

	proposePatch(input: {
		patch: GoalTopicPatch;
		source: GoalTopicPlanProposal["source"];
		draftSha256?: string;
		sourceDiscoveryIds?: readonly string[];
	}): GoalTopicPlanProposal {
		const patch = validateGoalTopicPatch(input.patch);
		const active = this.readActive();
		if ((active?.revision ?? null) !== patch.base_revision) {
			throw new Error(`Goal Topic Patch base revision is stale: expected ${active?.revision ?? "none"}`);
		}
		const proposalId = `topic_proposal_${Date.now().toString(36)}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
		const revision = `topic_plan_${Date.now().toString(36)}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
		const candidatePlan = applyGoalTopicPatch(this.goalId, active, patch, revision);
		const proposal: GoalTopicPlanProposal = {
			schema_version: 1,
			proposal_id: proposalId,
			goal_id: this.goalId,
			base_revision: patch.base_revision,
			status: "proposed",
			created_at: new Date().toISOString(),
			source: input.source,
			...(input.draftSha256 ? { draft_sha256: input.draftSha256 } : {}),
			...(input.sourceDiscoveryIds?.length ? { source_discovery_ids: [...new Set(input.sourceDiscoveryIds.map(safeId))] } : {}),
			patch,
			candidate_plan: candidatePlan,
			diff: describeTopicPatch(active, patch),
		};
		this.proposals.put(proposalId, proposal);
		return proposal;
	}

	syncDocument(input: {
		document: GoalTopicDocument;
		source: GoalTopicPlanProposal["source"];
		summary: string;
		sourceDiscoveryIds?: readonly string[];
	}): { proposal?: GoalTopicPlanProposal; changed: boolean } {
		const active = this.readActive();
		const knownIds = this.knownTopicIds(active);
		const unknown = input.document.topics.find((topic) => topic.id && !knownIds.has(topic.id));
		if (unknown) throw new Error(`Topic Plan document references unknown Topic ID '${unknown.id}'`);
		const draftSha256 = hashGoalTopicDocument(input.document);
		const pending = this.listProposals().filter((proposal) => proposal.status === "proposed");
		const current = pending.find((proposal) => proposal.draft_sha256 === draftSha256);
		if (current) {
			const sourceDiscoveryIds = [...new Set([...(current.source_discovery_ids ?? []), ...(input.sourceDiscoveryIds ?? [])])];
			if (!isDeepStrictEqual(sourceDiscoveryIds, current.source_discovery_ids ?? [])) {
				const updated = { ...current, source_discovery_ids: sourceDiscoveryIds };
				this.proposals.put(safeId(current.proposal_id), updated);
				return { proposal: updated, changed: false };
			}
			return { proposal: current, changed: false };
		}
		const patch = goalTopicDocumentToPatch(active, input.document, input.summary);
		if (patch.operations.length === 0) {
			for (const proposal of pending) this.supersedeProposal(proposal, active?.revision ?? "topic-plan:no-change");
			return { changed: pending.length > 0 };
		}
		const sourceDiscoveryIds = [...new Set([
			...(input.sourceDiscoveryIds ?? []),
			...pending.flatMap((proposal) => proposal.source_discovery_ids ?? []),
		])];
		const proposal = this.proposePatch({ patch, source: input.source, draftSha256, sourceDiscoveryIds });
		for (const previous of pending) this.supersedeProposal(previous, proposal.proposal_id);
		return { proposal, changed: true };
	}

	reviseProposal(proposalId: string, input: {
		patch: GoalTopicPatch;
		source: GoalTopicPlanProposal["source"];
	}): GoalTopicPlanProposal {
		const previous = this.readProposal(proposalId);
		if (previous.status !== "proposed") throw new Error("Only a proposed Goal Topic Plan can be revised");
		const patch = validateGoalTopicPatch(input.patch);
		if (patch.base_revision !== previous.candidate_plan.revision) throw new Error("Topic Plan refinement does not target the proposed draft");
		const refined = applyGoalTopicPatch(this.goalId, previous.candidate_plan, patch, "topic-plan-refinement");
		const base = previous.base_revision ? this.readRevision(previous.base_revision) : undefined;
		const combined = squashTopicPatch(base, refined, patch.summary, previous.patch.mode);
		const revised = this.proposePatch({
			patch: combined,
			source: input.source,
			sourceDiscoveryIds: previous.source_discovery_ids,
		});
		this.proposals.put(safeId(proposalId), {
			...previous,
			status: "superseded",
			superseded_at: new Date().toISOString(),
			superseded_by: revised.proposal_id,
		});
		return revised;
	}

	activate(proposalId: string): GoalTopicPlan {
		const proposal = this.readProposal(proposalId);
		if (proposal.status === "activated") {
			const plan = this.readRevision(proposal.candidate_plan.revision);
			this.resolveDiscoveriesCoveredByTopic(proposal, plan.revision);
			return plan;
		}
		if (proposal.status !== "proposed") throw new Error(`Goal Topic Plan Proposal '${proposalId}' is not activatable`);
		const active = this.readActive();
		if ((active?.revision ?? null) !== proposal.base_revision) {
			throw new Error(`Goal Topic Plan Proposal '${proposalId}' is stale`);
		}
		const document = assignGoalTopicDocumentIds(
			goalTopicDocumentFromPlan(proposal.candidate_plan),
			this.knownTopicIds(active),
		);
		const confirmed = this.history.confirm(document, this.history.latest()?.version ?? proposal.base_revision, proposalId);
		const plan = goalTopicPlanFromDocument(this.goalId, confirmed.plan, confirmed.version);
		this.revisions.put(safeId(plan.revision), plan);
		writeJsonAtomic(join(this.root, "active.json"), { schema_version: 1, revision: plan.revision }, { mode: 0o600 });
		this.proposals.put(safeId(proposalId), {
			...proposal,
			status: "activated",
			activated_at: new Date().toISOString(),
			confirmed_version: confirmed.version,
			candidate_plan: plan,
		});
		this.history.materializeCurrent(join(this.dataDir, this.goalId), confirmed);
		this.resolveDiscoveriesCoveredByTopic(proposal, plan.revision);
		for (const stale of this.listProposals().filter((candidate) => candidate.status === "proposed" && candidate.proposal_id !== proposalId)) {
			this.proposals.put(safeId(stale.proposal_id), {
				...stale,
				status: "superseded",
				superseded_at: new Date().toISOString(),
				superseded_by: proposalId,
			});
		}
		return plan;
	}

	private knownTopicIds(active?: GoalTopicPlan): Set<string> {
		return new Set([
			...(active?.topics.map((topic) => topic.id) ?? []),
			...this.history.list().flatMap((entry) => entry.plan.topics.map((topic) => topic.id)),
		]);
	}

	readHistory(): GoalTopicPlanHistoryEntry[] {
		return this.history.list();
	}

	writeHistorySnapshot(path: string): void {
		this.history.writeSnapshot(path);
	}

	private recoverConfirmedProposal(entry: GoalTopicPlanHistoryEntry, plan: GoalTopicPlan): void {
		if (!entry.proposal_id) return;
		const proposal = this.proposals.get(safeId(entry.proposal_id));
		if (!proposal || proposal.status !== "proposed") return;
		this.proposals.put(safeId(entry.proposal_id), {
			...proposal,
			status: "activated",
			activated_at: entry.confirmed_at,
			confirmed_version: entry.version,
			candidate_plan: plan,
		});
	}

	recordReframe(proposalId: string, reframe: NonNullable<GoalTopicPlanProposal["reframe"]>): void {
		const proposal = this.readProposal(proposalId);
		if (proposal.status !== "activated") throw new Error("Cannot reframe Wiki for an inactive Goal Topic Plan Proposal");
		this.proposals.put(safeId(proposalId), { ...proposal, reframe });
	}

	submitDiscovery(candidate: DiscoveryCandidate): DiscoveryCandidate {
		const plan = this.readRevision(candidate.topic_plan_revision);
		const value = validateDiscoveryCandidate(candidate, plan);
		if (value.status !== "open") throw new Error("A new Discovery Candidate must be open");
		const path = join(this.root, "discoveries", `${safeId(value.id)}.json`);
		if (existsSync(path)) return validateDiscoveryCandidate(readRecord<DiscoveryCandidate>(path)!, plan);
		const ignoredDuplicate = this.listDiscoveries(["closed"])
			.find((existing) => existing.resolution?.kind === "ignored" && sameDiscovery(existing, value));
		if (ignoredDuplicate) return ignoredDuplicate;
		if (existsSync(path)) throw new Error(`Goal Topic Plan record already exists: ${path}`);
		writeJsonAtomic(path, value, { mode: 0o600 });
		return value;
	}

	readDiscovery(candidateId: string): DiscoveryCandidate {
		const value = readRecord<DiscoveryCandidate>(join(this.root, "discoveries", `${safeId(candidateId)}.json`))!;
		return validateDiscoveryCandidate(value, this.readRevision(value.topic_plan_revision));
	}

	listDiscoveries(statuses?: readonly DiscoveryCandidate["status"][]): DiscoveryCandidate[] {
		const accepted = statuses ? new Set(statuses) : undefined;
		return this.discoveries.list()
			.filter((candidate) => !accepted || accepted.has(candidate.status))
			.sort((left, right) => right.created_at.localeCompare(left.created_at));
	}

	readDiscoveryInbox(): DiscoveryInboxItem[] {
		return this.readActive() ? this.listDiscoveries(["open"]) : [];
	}

	ignoreDiscovery(candidateId: string, now = new Date()): DiscoveryCandidate {
		const candidate = this.readDiscovery(candidateId);
		if (candidate.status !== "open") throw new Error(`Discovery Candidate '${candidateId}' is already closed`);
		const resolvedAt = now.toISOString();
		const updated = validateDiscoveryCandidate({
			...candidate,
			status: "closed",
			updated_at: resolvedAt,
			resolution: { kind: "ignored", resolved_by: "user", resolved_at: resolvedAt },
		}, this.readRevision(candidate.topic_plan_revision));
		writeJsonAtomic(join(this.root, "discoveries", `${safeId(candidateId)}.json`), updated, { mode: 0o600 });
		return updated;
	}

	reopenDiscovery(candidateId: string): DiscoveryCandidate {
		const candidate = this.readDiscovery(candidateId);
		if (candidate.status !== "closed" || candidate.resolution?.kind !== "ignored") {
			throw new Error(`Discovery Candidate '${candidateId}' cannot be reopened`);
		}
		const { resolution: _resolution, updated_at: _updatedAt, ...open } = candidate;
		const updated = validateDiscoveryCandidate({ ...open, status: "open" }, this.readRevision(candidate.topic_plan_revision));
		writeJsonAtomic(join(this.root, "discoveries", `${safeId(candidateId)}.json`), updated, { mode: 0o600 });
		return updated;
	}

	private resolveDiscoveriesCoveredByTopic(proposal: GoalTopicPlanProposal, topicPlanRevision: string): void {
		for (const candidateId of proposal.source_discovery_ids ?? []) {
			const candidate = this.readDiscovery(candidateId);
			if (candidate.status === "closed") continue;
			const resolvedAt = new Date().toISOString();
			const updated = validateDiscoveryCandidate({
				...candidate,
				status: "closed",
				updated_at: resolvedAt,
				resolution: {
					kind: "covered_by_topic",
					resolved_by: "runtime",
					resolved_at: resolvedAt,
					proposal_id: proposal.proposal_id,
					topic_plan_revision: topicPlanRevision,
				},
			}, this.readRevision(candidate.topic_plan_revision));
			writeJsonAtomic(join(this.root, "discoveries", `${safeId(candidateId)}.json`), updated, { mode: 0o600 });
		}
	}

	private supersedeProposal(proposal: GoalTopicPlanProposal, successorId: string): void {
		this.proposals.put(safeId(proposal.proposal_id), {
			...proposal,
			status: "superseded",
			superseded_at: new Date().toISOString(),
			superseded_by: successorId,
		});
	}
}

function sameDiscovery(left: DiscoveryCandidate, right: DiscoveryCandidate): boolean {
	return left.finding.trim() === right.finding.trim()
		&& isDeepStrictEqual(left.evidence, right.evidence);
}

function squashTopicPatch(
	base: GoalTopicPlan | undefined,
	candidate: GoalTopicPlan,
	summary: string,
	mode?: GoalTopicPatch["mode"],
): GoalTopicPatch {
	if (mode === "replace") {
		return validateGoalTopicPatch({
			schema_version: 1,
			base_revision: base?.revision ?? null,
			summary,
			mode: "replace",
			operations: candidate.topics.map((topic) => ({ op: "add", topic: structuredClone(topic) })),
		});
	}
	const before = new Map((base?.topics ?? []).map((topic) => [topic.id, topic]));
	const operations: GoalTopicPatch["operations"] = [];
	for (const topic of candidate.topics) {
		const previous = before.get(topic.id);
		if (!previous) {
			operations.push({ op: "add", topic: structuredClone(topic) });
			continue;
		}
		const set: Extract<GoalTopicPatch["operations"][number], { op: "update" }>["set"] = {};
		for (const key of ["title", "intent", "questions", "include", "exclude"] as const) {
			if (!isDeepStrictEqual(previous[key], topic[key])) set[key] = structuredClone(topic[key]) as never;
		}
		if (Object.keys(set).length > 0) operations.push({ op: "update", topic_id: topic.id, set });
	}
	for (const topicId of before.keys()) {
		if (!candidate.topics.some((topic) => topic.id === topicId)) operations.push({ op: "remove", topic_id: topicId });
	}
	return validateGoalTopicPatch({
		schema_version: 1,
		base_revision: base?.revision ?? null,
		summary,
		operations,
	});
}

export function applyGoalTopicPatch(
	goalId: string,
	active: GoalTopicPlan | undefined,
	patch: GoalTopicPatch,
	revision: string,
): GoalTopicPlan {
	validateGoalTopicPatch(patch);
	if ((active?.revision ?? null) !== patch.base_revision) throw new Error("Goal Topic Patch base revision does not match");
	const topics = new Map(patch.mode === "replace"
		? []
		: (active?.topics ?? []).map((topic) => [topic.id, structuredClone(topic)]));
	for (const operation of patch.operations) {
		if (operation.op === "add") {
			const topic: GoalTopic = {
				...structuredClone(operation.topic),
				id: operation.topic.id ?? `topic_draft_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
			};
			if (topics.has(topic.id)) throw new Error(`Goal Topic '${topic.id}' already exists`);
			topics.set(topic.id, topic);
			continue;
		}
		const topic = topics.get(operation.topic_id);
		if (!topic) throw new Error(`Goal Topic '${operation.topic_id}' does not exist`);
		if (operation.op === "remove") {
			topics.delete(topic.id);
			continue;
		}
		const next: GoalTopic = { ...topic, ...operation.set };
		topics.set(topic.id, next);
	}
	return validateGoalTopicPlan({
		schema_version: 1,
		goal_id: goalId,
		revision,
		status: "active",
		topics: [...topics.values()],
	});
}

function describeTopicPatch(active: GoalTopicPlan | undefined, patch: GoalTopicPatch): string[] {
	if (patch.mode === "replace") return [`更新完整 Topic Plan（${patch.operations.length} 个关注方向）`];
	const titles = new Map([
		...(active?.topics.map((topic) => [topic.id, topic.title] as const) ?? []),
		...patch.operations.flatMap((operation) => operation.op === "add" ? [[operation.topic.id, operation.topic.title] as const] : []),
	]);
	return patch.operations.map((operation) => {
		if (operation.op === "add") return `新增 Topic：${operation.topic.title}`;
		const title = titles.get(operation.topic_id) ?? operation.topic_id;
		if (operation.op === "remove") return `移除 Topic：${title}`;
		const changes = Object.entries(operation.set).map(([field, value]) => `${field} -> ${Array.isArray(value) ? value.join("、") || "空" : value ?? "无"}`);
		return `更新 Topic：${title}（${changes.join("；")}）`;
	});
}

function readRecord<T>(path: string, required = true): T | undefined {
	if (!existsSync(path)) {
		if (required) throw new Error(`Missing Goal Topic Plan record: ${path}`);
		return undefined;
	}
	return JSON.parse(readFileSync(path, "utf-8")) as T;
}


function safeId(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) throw new Error(`Invalid Goal Topic Plan id '${value}'`);
	return value;
}

function validateProposal(value: GoalTopicPlanProposal | undefined, goalId: string, proposalId: string): GoalTopicPlanProposal {
	const unknown = value && Object.keys(value).find((field) => !PROPOSAL_FIELDS.has(field));
	if (unknown) throw new Error(`Goal Topic Plan Proposal contains unknown field '${unknown}'`);
	if (!value || value.schema_version !== 1 || value.proposal_id !== proposalId || value.goal_id !== goalId
		|| !["proposed", "activated", "superseded"].includes(value.status) || !Number.isFinite(Date.parse(value.created_at))
		|| value.source !== "main_agent"
		|| !Array.isArray(value.diff) || value.diff.some((line) => typeof line !== "string" || !line.trim())
		|| value.base_revision !== value.patch?.base_revision) throw new Error("Goal Topic Plan Proposal is invalid");
	if ((value.draft_sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(value.draft_sha256))
		|| (value.confirmed_version !== undefined && !/^[a-f0-9]{64}$/u.test(value.confirmed_version))
		|| (value.source_discovery_ids !== undefined && (!Array.isArray(value.source_discovery_ids)
			|| value.source_discovery_ids.some((id) => typeof id !== "string" || !id.trim())))) {
		throw new Error("Goal Topic Plan Proposal confirmation metadata is invalid");
	}
	validateGoalTopicPatch(value.patch);
	validateGoalTopicPlan(value.candidate_plan);
	if (value.candidate_plan.goal_id !== goalId) throw new Error("Goal Topic Plan Proposal belongs to another Goal");
	if (value.status === "activated" && (!value.activated_at || !Number.isFinite(Date.parse(value.activated_at)))) {
		throw new Error("Activated Goal Topic Plan Proposal lacks activated_at");
	}
	if (value.status === "superseded" && (!value.superseded_at || !Number.isFinite(Date.parse(value.superseded_at)) || !value.superseded_by)) {
		throw new Error("Superseded Goal Topic Plan Proposal lacks successor metadata");
	}
	if (value.reframe && (!["running", "succeeded", "failed", "no_wiki"].includes(value.reframe.status)
		|| !Number.isFinite(Date.parse(value.reframe.updated_at)))) throw new Error("Goal Topic Plan Proposal reframe is invalid");
	return value;
}
