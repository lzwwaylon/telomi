import { sha256 } from "../../lib/hash.js";
import { randomUUID } from "node:crypto";

import type { GoalTopic, GoalTopicPatch, GoalTopicPlan } from "./contracts.js";

export const TOPIC_PLAN_DOCUMENT_PATH = "artifacts/main/topic-plan.json";
export const TOPIC_PLAN_SANDBOX_PATH = "topic-plan.json";

export interface GoalTopicDocumentTopic {
	id?: string;
	title: string;
	intent: string;
	questions?: string[];
	include?: string[];
	exclude?: string[];
}

export interface GoalTopicDocument {
	topics: GoalTopicDocumentTopic[];
}

export interface ConfirmedGoalTopicDocument extends GoalTopicDocument {
	topics: Array<GoalTopicDocumentTopic & { id: string }>;
}

const TOPIC_ID = /^[a-z0-9][a-z0-9_-]*$/u;

export function parseGoalTopicDocument(text: string, allowEmpty = false): GoalTopicDocument {
	return validateGoalTopicDocument(JSON.parse(text) as GoalTopicDocument, allowEmpty);
}

export function validateGoalTopicDocument(value: GoalTopicDocument, allowEmpty = false): GoalTopicDocument {
	if (!value || typeof value !== "object" || !Array.isArray(value.topics)
		|| (!allowEmpty && value.topics.length === 0)) throw new Error("Topic Plan document requires at least one Topic");
	if (Object.keys(value).some((key) => key !== "topics")) {
		throw new Error("Topic Plan document contains an unknown field");
	}
	const titles = new Set<string>();
	const ids = new Set<string>();
	for (const topic of value.topics) {
		if (topic && typeof topic === "object" && Object.keys(topic).some((key) => ![
			"id", "title", "intent", "questions", "include", "exclude",
		].includes(key))) throw new Error(`Topic Plan document Topic '${topic.title ?? "unknown"}' contains an unknown field`);
		if (!topic || (topic.id !== undefined && !TOPIC_ID.test(topic.id)) || !text(topic.title) || !text(topic.intent)
			|| !optionalStrings(topic.questions) || !optionalStrings(topic.include) || !optionalStrings(topic.exclude)) {
			throw new Error(`Topic Plan document Topic '${topic?.title ?? "unknown"}' is invalid`);
		}
		if (titles.has(topic.title.trim())) throw new Error(`Topic Plan document title '${topic.title}' is duplicated`);
		if (topic.id && ids.has(topic.id)) throw new Error(`Topic Plan document id '${topic.id}' is duplicated`);
		titles.add(topic.title.trim());
		if (topic.id) ids.add(topic.id);
	}
	return normalizeGoalTopicDocument(value);
}

export function validateConfirmedGoalTopicDocument(value: GoalTopicDocument): ConfirmedGoalTopicDocument {
	const document = validateGoalTopicDocument(value);
	if (document.topics.some((topic) => !topic.id)) throw new Error("Confirmed Topic Plan requires Runtime-owned Topic IDs");
	return document as ConfirmedGoalTopicDocument;
}

export function goalTopicDocumentFromPlan(plan?: GoalTopicPlan): GoalTopicDocument {
	if (!plan) return { topics: [] };
	const topics = plan.topics.map(toDocumentTopic);
	return normalizeGoalTopicDocument({ topics });
}

export function stringifyGoalTopicDocument(document: GoalTopicDocument): string {
	return `${JSON.stringify(normalizeGoalTopicDocument(document), null, 2)}\n`;
}

export function hashGoalTopicDocument(document: GoalTopicDocument): string {
	return sha256(stringifyGoalTopicDocument(document));
}

export function goalTopicPlanFromDocument(
	goalId: string,
	document: GoalTopicDocument,
	revision: string,
): GoalTopicPlan {
	const normalized = validateConfirmedGoalTopicDocument(document);
	return {
		schema_version: 1,
		goal_id: goalId,
		revision,
		status: "active",
		topics: normalized.topics.map(toRuntimeTopic),
	};
}

export function goalTopicDocumentToPatch(
	active: GoalTopicPlan | undefined,
	document: GoalTopicDocument,
	summary: string,
): GoalTopicPatch {
	const normalized = validateGoalTopicDocument(document);
	if (stringifyGoalTopicDocument(goalTopicDocumentFromPlan(active)) === stringifyGoalTopicDocument(normalized)) {
		return { schema_version: 1, base_revision: active?.revision ?? null, summary, operations: [], mode: "replace" };
	}
	return {
		schema_version: 1,
		base_revision: active?.revision ?? null,
		summary: summary.trim() || "更新 Topic Plan",
		operations: normalized.topics.map((topic, index) => ({ op: "add" as const, topic: toRuntimeTopic(topic, index) })),
		mode: "replace",
	};
}

function normalizeGoalTopicDocument(value: GoalTopicDocument): GoalTopicDocument {
	const topics = value.topics.map((topic) => ({
		...(topic.id ? { id: topic.id } : {}),
		title: topic.title.trim(),
		intent: topic.intent.trim(),
		...(topic.questions?.length ? { questions: unique(topic.questions) } : {}),
		...(topic.include?.length ? { include: unique(topic.include) } : {}),
		...(topic.exclude?.length ? { exclude: unique(topic.exclude) } : {}),
	}));
	return { topics };
}

function toDocumentTopic(topic: GoalTopic): GoalTopicDocumentTopic {
	return {
		id: topic.id,
		title: topic.title,
		intent: topic.intent,
		...(topic.questions.length ? { questions: [...topic.questions] } : {}),
		...(topic.include.length ? { include: [...topic.include] } : {}),
		...(topic.exclude.length ? { exclude: [...topic.exclude] } : {}),
	};
}

function toRuntimeTopic(topic: GoalTopicDocumentTopic, index: number): GoalTopic {
	const id = topic.id ?? `topic_draft_${sha256(JSON.stringify({ index, topic })).slice(0, 20)}`;
	return {
		id,
		title: topic.title,
		intent: topic.intent,
		questions: topic.questions ?? [],
		include: topic.include ?? [],
		exclude: topic.exclude ?? [],
	};
}

export function assignGoalTopicDocumentIds(
	document: GoalTopicDocument,
	reusableIds: ReadonlySet<string>,
): ConfirmedGoalTopicDocument {
	const normalized = validateGoalTopicDocument(document);
	const assigned = new Set<string>();
	return {
		topics: normalized.topics.map((topic) => {
			const id = topic.id && reusableIds.has(topic.id) ? topic.id : nextTopicId(reusableIds, assigned);
			assigned.add(id);
			return { ...topic, id };
		}),
	};
}

function nextTopicId(reusableIds: ReadonlySet<string>, assigned: ReadonlySet<string>): string {
	for (;;) {
		const id = `topic_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
		if (!reusableIds.has(id) && !assigned.has(id)) return id;
	}
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()))];
}

function text(value: unknown): value is string {
	return typeof value === "string" && Boolean(value.trim());
}

function optionalStrings(value: unknown): value is string[] | undefined {
	return value === undefined || (Array.isArray(value) && value.every(text));
}
