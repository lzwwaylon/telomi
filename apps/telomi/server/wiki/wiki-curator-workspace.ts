import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { hashJson, sha256 } from "../lib/hash.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { toErrorMessage } from "../lib/values.js";
import { curatorRelationInput, validateCuratorRelations, validateCuratorWorksetResult } from "./wiki-shard-merge.js";

interface CuratorIndexRow {
	ref: string;
	shard_id: string;
	kind: "concept" | "entity";
	title: string;
	description: string;
}

interface CuratorIndex {
	incoming_pages: CuratorIndexRow[];
	suggested_groups: Array<{ group_id: string; members: string[] }>;
	topic_plan: unknown;
	language: string;
}

export interface CuratorWorkspacePlan {
	groups: Array<{ group_id: string; members: string[] }>;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/u;

export function prepareCuratorWorkspace(root: string, childContract: string): CuratorWorkspacePlan {
	const input = readCuratorJson<CuratorIndex>(join(root, "input", "index.json"), "input/index.json");
	const main = readCuratorJson<CuratorIndexRow[]>(join(root, "input", "main-index.json"), "input/main-index.json");
	const plan = validatePlan(readCuratorJson<CuratorWorkspacePlan>(join(root, "work", "plan.json"), "work/plan.json"), input, main);
	const assignmentsRoot = join(root, "work", "assignments");
	rmSync(assignmentsRoot, { recursive: true, force: true });
	mkdirSync(assignmentsRoot, { recursive: true });
	writeFileSync(join(root, "work", "child-contract.md"), childContract);
	const rows = new Map([...main, ...input.incoming_pages].map((row) => [row.ref, row]));
	for (const group of plan.groups) writeJsonAtomic(join(assignmentsRoot, `${group.group_id}.json`), {
		group,
		rows: group.members.map((ref) => rows.get(ref)),
		topic_plan: input.topic_plan,
		language: input.language,
		pages_path: "input/pages.json",
		entries_path: "input/notes.json",
		output_path: `work/groups/${group.group_id}/result.json`,
	});
	return plan;
}

export function prepareCuratorRelationWorkspace(root: string, relationContract: string): number {
	const { owned_pages, catalog, concepts, topic_plan, suggested_relations } = curatorRelationInput(root);
	writeJsonAtomic(join(root, "work", "relation-concepts.json"), concepts);
	writeFileSync(join(root, "work", "relation-contract.md"), relationContract);
	const assignment = {
		owned_pages,
		topic_plan,
		concepts_path: "work/relation-concepts.json",
		entries_path: "input/notes.json",
		catalog,
		suggested_relations,
		language: readCuratorJson<CuratorIndex>(join(root, "input", "index.json")).language,
		output_path: "work/relations/result.json",
	};
	const digest = hashJson({ assignment, concepts, relationContract, notes: readCuratorJson<unknown>(join(root, "input", "notes.json")) });
	const digestPath = join(root, "work", "relations", "assignment-digest.txt");
	if (!existsSync(digestPath) || readFileSync(digestPath, "utf-8").trim() !== digest) {
		rmSync(join(root, "work", "relations", "result.json"), { force: true });
	}
	writeJsonAtomic(join(root, "work", "relation-assignment.json"), assignment);
	mkdirSync(dirname(digestPath), { recursive: true });
	writeFileSync(digestPath, `${digest}\n`);
	if (owned_pages.length === 0 && concepts.length < 2) {
		writeJsonAtomic(join(root, "work", "relations", "result.json"), { concept_merges: [], owned_refs: [], relations: [] });
	}
	return owned_pages.length;
}

export function curatorRelationsMissing(root: string): boolean {
	return !existsSync(join(root, "work", "relations", "result.json"));
}

export function stageCuratorRelations(root: string): void {
	const resultFile = "work/relations/result.json";
	const result = validateCuratorRelations(root, readCuratorJson<unknown>(join(root, resultFile), resultFile));
	writeJsonAtomic(join(root, "state", "relations.json"), result);
}

/** A Workset counts as delivered only once its child submitted it and Runtime accepted it. */
export function missingCuratorWorkspaceResults(root: string): string[] {
	const plan = readCuratorJson<CuratorWorkspacePlan>(join(root, "work", "plan.json"), "work/plan.json");
	return plan.groups.flatMap((group) => unacceptedWorksetReason(root, group.group_id) ? [group.group_id] : []);
}

function worksetResultPath(root: string, groupId: string): string {
	return join(root, "work", "groups", groupId, "result.json");
}

function worksetAcceptedPath(root: string, groupId: string): string {
	return join(root, "work", "groups", groupId, ".accepted");
}

/**
 * Acceptance is pinned to the exact bytes Runtime validated. A repair round rewrites `result.json`
 * in place, so a marker that only recorded "this group passed once" would still be standing over
 * content nobody checked; the MAIN-discard rule lives in the submit Tool alone, and that is the one
 * it would let through. Returns why the Workset is undelivered, or undefined when it is.
 */
function unacceptedWorksetReason(root: string, groupId: string): string | undefined {
	const resultPath = worksetResultPath(root, groupId);
	if (!existsSync(resultPath)) return "has no result.json";
	if (!existsSync(worksetAcceptedPath(root, groupId))) return "was never submitted with submit_workset";
	const marker = JSON.parse(readFileSync(worksetAcceptedPath(root, groupId), "utf-8")) as { sha256?: unknown };
	return marker.sha256 === sha256(readFileSync(resultPath))
		? undefined
		: "changed after it was submitted; call submit_workset again";
}

const SubmitWorksetParams = Type.Object({ group_id: Type.String() }, { additionalProperties: false });

/**
 * Lets a Workset child validate its own result while it still holds the context that produced it.
 * The post-hoc repair rounds spawn a fresh child that knows only the rejection, which is why a
 * judgement like "this MAIN Page may not be discarded" used to burn the whole budget unrepaired.
 */
export function createCuratorWorksetTools(root: string): ToolDefinition[] {
	return [{
		name: "submit_workset",
		label: "submit_workset",
		description: "Validate and submit this Workset's result.json after writing it. Repair the same file and retry if validation fails.",
		parameters: SubmitWorksetParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: { group_id: string }, signal) {
			signal?.throwIfAborted();
			const groupId = params.group_id;
			if (!SAFE_ID.test(groupId)) throw new Error(`group_id '${groupId}' is not a Workset id`);
			const accepted = worksetAcceptedPath(root, groupId);
			// Drop acceptance first: a resubmission that fails must not leave the previous pass standing.
			rmSync(accepted, { force: true });
			validateCuratorWorksetResult(root, groupId);
			writeJsonAtomic(accepted, { accepted: true, sha256: sha256(readFileSync(worksetResultPath(root, groupId))) });
			return {
				content: [{ type: "text", text: `Workset ${groupId} validated and submitted` }],
				details: { group_id: groupId, output_path: `work/groups/${groupId}/result.json` },
			};
		},
	}];
}

export function stageCuratorWorkspaceResults(root: string): CuratorWorkspacePlan {
	const plan = prepareCuratorWorkspace(root, readFileSync(join(root, "work", "child-contract.md"), "utf-8"));
	const stateRoot = join(root, "state");
	rmSync(stateRoot, { recursive: true, force: true });
	mkdirSync(join(stateRoot, "groups"), { recursive: true });
	writeJsonAtomic(join(stateRoot, "plan.json"), plan);
	// Report every unusable result at once: one repair round costs one of three attempts, so stopping
	// at the first Workset spends the whole budget one Workset at a time.
	const violations: string[] = [];
	for (const group of plan.groups) {
		const path = join(root, "work", "groups", group.group_id, "result.json");
		const file = `work/groups/${group.group_id}/result.json`;
		try {
			if (!existsSync(path)) throw curatorViolation("worksets", file, "$", "required file is missing");
			const result = readCuratorJson<Record<string, unknown>>(path, file);
			if (result.group_id !== group.group_id) throw curatorViolation("worksets", file, "group_id", `must equal '${group.group_id}', received '${String(result.group_id)}'`);
			// Aggregation is the last gate and does not re-run the group-local submit rules, so an
			// unsubmitted or since-edited result is rejected here rather than reaching the Edition.
			// Checked after parsing: a corrupt file is better reported as corrupt than as unsubmitted.
			const unaccepted = unacceptedWorksetReason(root, group.group_id);
			if (unaccepted) throw curatorViolation("worksets", file, "$", unaccepted);
			writeJsonAtomic(join(stateRoot, "groups", `${group.group_id}.json`), result);
		} catch (error) {
			violations.push(toErrorMessage(error));
		}
	}
	if (violations.length) throw new Error(violations.join("\n"));
	return plan;
}

export function commitCuratorWorkspace(root: string): void {
	writeJsonAtomic(join(root, "state", "commit.json"), { accepted: true });
}

function validatePlan(plan: CuratorWorkspacePlan, input: CuratorIndex, main: CuratorIndexRow[]): CuratorWorkspacePlan {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw curatorViolation("plan", "input/index.json", "$", "must be an object");
	if (!Array.isArray(main)) throw curatorViolation("plan", "input/main-index.json", "$", "must be an array");
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw curatorViolation("plan", "work/plan.json", "$", "must be an object");
	if (!Array.isArray(input.incoming_pages)) throw curatorViolation("plan", "input/index.json", "incoming_pages", "must be an array");
	if (!Array.isArray(input.suggested_groups)) throw curatorViolation("plan", "input/index.json", "suggested_groups", "must be an array");
	if (!Array.isArray(plan.groups) || plan.groups.length === 0) throw curatorViolation("plan", "work/plan.json", "groups", "must contain at least one Workset");
	const incoming = new Set(input.incoming_pages.map((row) => row.ref));
	const known = new Set([...main.map((row) => row.ref), ...incoming]);
	const owners = new Map<string, string>();
	const groupIds = new Set<string>();
	for (const [index, group] of plan.groups.entries()) {
		const field = `groups[${index}]`;
		if (!group || typeof group !== "object") throw curatorViolation("plan", "work/plan.json", field, "must be an object");
		if (typeof group.group_id !== "string" || !SAFE_ID.test(group.group_id) || groupIds.has(group.group_id)) {
			throw curatorViolation("plan", "work/plan.json", `${field}.group_id`, `must be a unique safe ID, received '${String(group.group_id)}'`);
		}
		groupIds.add(group.group_id);
		if (!Array.isArray(group.members) || group.members.length === 0 || !group.members.some((ref) => incoming.has(ref))) {
			throw curatorViolation("plan", "work/plan.json", `${field}.members`, "must contain at least one incoming Page ref");
		}
		for (const [memberIndex, ref] of group.members.entries()) {
			if (typeof ref !== "string" || !known.has(ref)) throw curatorViolation("plan", "work/plan.json", `${field}.members[${memberIndex}]`, `references unknown Page '${String(ref)}'`);
			const owner = owners.get(ref);
			if (owner) throw curatorViolation("plan", "work/plan.json", `${field}.members[${memberIndex}]`, `Page '${ref}' is already assigned to Workset '${owner}'`);
			owners.set(ref, group.group_id);
		}
	}
	const missing = [...incoming].filter((ref) => !owners.has(ref)).sort();
	if (missing.length) throw curatorViolation("plan", "work/plan.json", "groups[].members", `must assign every incoming Page; missing ${missing.join(", ")}`);
	for (const suggestion of input.suggested_groups) {
		const suggestedOwners = new Set(suggestion.members.map((ref) => owners.get(ref)));
		if (suggestedOwners.size !== 1 || suggestedOwners.has(undefined)) {
			// State the facts the Agent needs to see the problem: which member sits where. No advice.
			const placement = suggestion.members.map((ref) => `${ref} ${owners.has(ref) ? `in group '${owners.get(ref)}'` : "in no group"}`).join(", ");
			throw curatorViolation("plan", "work/plan.json", "groups[].members", `suggested identity group '${suggestion.group_id}' is split: ${placement}`);
		}
	}
	return { groups: plan.groups.map((group) => ({ group_id: group.group_id, members: [...group.members] })) };
}

function readCuratorJson<T>(path: string, file = path): T {
	if (!existsSync(path)) throw curatorViolation("read", file, "$", "required file is missing");
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch (error) {
		throw curatorViolation("read", file, "$", `must be valid JSON: ${toErrorMessage(error)}`);
	}
}

function curatorViolation(stage: string, file: string, field: string, issue: string): Error {
	return new Error(`[wiki-curator:${stage}] file '${file}', field '${field}': ${issue}`);
}

