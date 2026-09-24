import type { ResearchProviderRequest } from "../../../providers/search-types.js";

const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 4_096;
const PAPER_ID = /^(?:\d{4}\.\d{4,5}|[A-Za-z][A-Za-z0-9.-]*\/\d{7})(?:v\d+)?$/u;
const REPO_ID = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/u;
const HUB_SORT_VALUES = [
	"created_at", "downloads", "last_modified", "likes", "trending_score",
] as const;
// Hugging Face Spaces do not support downloads sorting. Keep this separate from model/dataset sorts.
const SPACE_SORT_VALUES = ["created_at", "last_modified", "likes", "trending_score"] as const;
const BASE_MODEL_RELATION_VALUES = ["base", "adapter", "finetune", "quantized", "merge"] as const;
const MODEL_TAG_TYPE_VALUES = ["pipeline_tag", "library", "language", "license", "other"] as const;

export const HUGGINGFACE_OPERATIONS = [
	"papers_list",
	"papers_search",
	"papers_info",
	"papers_preview",
	"papers_download",
	"models_info",
	"models_card",
	"model_tags",
	"models_list",
	"datasets_info",
	"datasets_leaderboard",
	"datasets_list",
	"spaces_list",
] as const;

export type HuggingFaceOperation = typeof HUGGINGFACE_OPERATIONS[number];

export type HuggingFaceHubSort =
	| "created_at"
	| "downloads"
	| "last_modified"
	| "likes"
	| "trending_score";

export type HuggingFaceSpaceSort = Exclude<HuggingFaceHubSort, "downloads">;

export interface HuggingFacePapersListParameters {
	date?: string;
	week?: string;
	month?: string;
	submitter?: string;
	sort?: "published_at" | "trending";
	page?: number;
	limit?: number;
}

export interface HuggingFacePapersSearchParameters {
	query?: string;
	limit?: number;
}

export interface HuggingFacePapersInfoParameters {
	paper_id: string;
}

export interface HuggingFaceHubInfoParameters {
	repo_id: string;
	revision?: string;
}

export interface HuggingFaceDatasetLeaderboardParameters {
	dataset_id: string;
	limit?: number;
}

export interface HuggingFaceModelTagsParameters {
	tag_type?: typeof MODEL_TAG_TYPE_VALUES[number];
	search?: string;
	limit?: number;
}

export interface HuggingFaceHubListParameters<Sort extends HuggingFaceHubSort = HuggingFaceHubSort> {
	search?: string;
	author?: string;
	filters?: string[];
	sort?: Sort;
	limit?: number;
	cursor?: string;
}

export interface HuggingFaceModelsListParameters extends HuggingFaceHubListParameters {
	apps?: string[];
	gated?: boolean;
	inference?: "warm";
	inference_provider?: string | string[];
	pipeline_tag?: string;
	trained_datasets?: string[];
	num_parameters?: string;
	base_model_relation?: typeof BASE_MODEL_RELATION_VALUES[number];
}

export interface HuggingFaceDatasetsListParameters extends HuggingFaceHubListParameters {
	gated?: boolean;
}

export interface HuggingFaceSpacesListParameters extends HuggingFaceHubListParameters<HuggingFaceSpaceSort> {
	datasets?: string[];
	models?: string[];
	linked?: boolean;
}

export interface HuggingFaceParametersByOperation {
	papers_list: HuggingFacePapersListParameters;
	papers_search: HuggingFacePapersSearchParameters;
	papers_info: HuggingFacePapersInfoParameters;
	papers_preview: HuggingFacePapersInfoParameters;
	papers_download: HuggingFacePapersInfoParameters;
	models_info: HuggingFaceHubInfoParameters;
	models_card: HuggingFaceHubInfoParameters;
	model_tags: HuggingFaceModelTagsParameters;
	models_list: HuggingFaceModelsListParameters;
	datasets_info: HuggingFaceHubInfoParameters;
	datasets_leaderboard: HuggingFaceDatasetLeaderboardParameters;
	datasets_list: HuggingFaceDatasetsListParameters;
	spaces_list: HuggingFaceSpacesListParameters;
}

export type ParsedHuggingFaceProviderRequest = {
	[K in HuggingFaceOperation]: {
		operation: K;
		parameters: HuggingFaceParametersByOperation[K];
	};
}[HuggingFaceOperation];

export function parseHuggingFaceProviderRequest(
	request: ResearchProviderRequest | undefined,
	requestQuery: string,
	requestMaxResults: number,
): ParsedHuggingFaceProviderRequest {
	if (!request) throw new Error("Hugging Face Provider requests require an explicit operation");
	const operation = parseOperation(request.operation);
	const input = objectValue(request.parameters, "Hugging Face parameters");
	const defaultLimit = Math.min(requireInteger(requestMaxResults, "max_results", 1, MAX_PAGE_SIZE), MAX_PAGE_SIZE);
	if (operation === "papers_list") {
		const row = strictObject(input, [
			"date", "week", "month", "submitter", "sort", "page", "limit",
		], operation);
		const date = optionalPattern(row.date, "date", /^\d{4}-\d{2}-\d{2}$/u, "YYYY-MM-DD");
		const week = optionalPattern(row.week, "week", /^\d{4}-W\d{2}$/u, "YYYY-Www");
		const month = optionalPattern(row.month, "month", /^\d{4}-\d{2}$/u, "YYYY-MM");
		if ([date, week, month].filter(Boolean).length > 1) {
			throw new Error("Hugging Face date, week, and month are mutually exclusive");
		}
		return {
			operation,
			parameters: {
				...(date ? { date } : {}),
				...(week ? { week } : {}),
				...(month ? { month } : {}),
				...optionalTextProperty(row.submitter, "submitter", 256),
				...optionalEnumProperty(row.sort, "sort", ["published_at", "trending"] as const),
				...(row.page === undefined ? {} : { page: requireInteger(row.page, "page", 0, 1_000_000) }),
				limit: optionalInteger(row.limit, "limit", 1, MAX_PAGE_SIZE) ?? defaultLimit,
			},
		};
	}
	if (operation === "papers_search") {
		const row = strictObject(input, ["query", "limit"], operation);
		const query = optionalText(row.query, "query", 2_000) ?? requireText(requestQuery, "query", 2_000);
		return {
			operation,
			parameters: {
				query,
				limit: optionalInteger(row.limit, "limit", 1, MAX_PAGE_SIZE) ?? defaultLimit,
			},
		};
	}
	if (operation === "papers_info" || operation === "papers_preview" || operation === "papers_download") {
		const row = strictObject(input, ["paper_id"], operation);
		const paperId = requireText(row.paper_id, "paper_id", 128);
		if (!PAPER_ID.test(paperId)) throw new Error("Hugging Face paper_id must be a valid arXiv identifier");
		return { operation, parameters: { paper_id: paperId } };
	}
	if (operation === "models_info" || operation === "models_card" || operation === "datasets_info") {
		const row = strictObject(input, ["repo_id", "revision"], operation);
		return {
			operation,
			parameters: {
				repo_id: requireRepoId(row.repo_id, "repo_id"),
				...optionalTextProperty(row.revision, "revision", 256),
			},
		};
	}
	if (operation === "datasets_leaderboard") {
		const row = strictObject(input, ["dataset_id", "limit"], operation);
		return {
			operation,
			parameters: {
				dataset_id: requireRepoId(row.dataset_id, "dataset_id"),
				limit: optionalInteger(row.limit, "limit", 1, MAX_PAGE_SIZE) ?? defaultLimit,
			},
		};
	}
	if (operation === "model_tags") {
		const row = strictObject(input, ["tag_type", "search", "limit"], operation);
		const tagType = optionalEnum(row.tag_type, "tag_type", MODEL_TAG_TYPE_VALUES);
		return {
			operation,
			parameters: {
				...(tagType ? { tag_type: tagType } : {}),
				...optionalTextProperty(row.search, "search", 256),
				limit: optionalInteger(row.limit, "limit", 1, MAX_PAGE_SIZE) ?? defaultLimit,
			},
		};
	}
	if (operation === "models_list") {
		const row = strictObject(input, [
			"search", "author", "filters", "sort", "limit", "cursor", "apps", "gated",
			"inference", "inference_provider", "pipeline_tag", "trained_datasets", "num_parameters",
			"base_model_relation",
		], operation);
		const base = parseHubList(row, defaultLimit, HUB_SORT_VALUES, "models_list sort");
		const inference = optionalEnum(row.inference, "inference", ["warm"] as const);
		const inferenceProvider = optionalStringOrArray(row.inference_provider, "inference_provider", 20);
		const baseModelRelation = optionalEnum(
			row.base_model_relation,
			"base_model_relation",
			BASE_MODEL_RELATION_VALUES,
		);
		if (inference && inferenceProvider !== undefined) {
			throw new Error("Hugging Face inference and inference_provider cannot be combined");
		}
		return {
			operation,
			parameters: {
				...base,
				...optionalTextArrayProperty(row.apps, "apps", 20),
				...optionalBooleanProperty(row.gated, "gated"),
				...(inference ? { inference } : {}),
				...(inferenceProvider !== undefined ? { inference_provider: inferenceProvider } : {}),
				...optionalTextProperty(row.pipeline_tag, "pipeline_tag", 256),
				...optionalTextArrayProperty(row.trained_datasets, "trained_datasets", 20),
				...optionalTextProperty(row.num_parameters, "num_parameters", 128),
				...(baseModelRelation ? { base_model_relation: baseModelRelation } : {}),
			},
		};
	}
	if (operation === "datasets_list") {
		const row = strictObject(input, [
			"search", "author", "filters", "sort", "limit", "cursor", "gated",
		], operation);
		return {
			operation,
			parameters: {
				...parseHubList(row, defaultLimit, HUB_SORT_VALUES, "datasets_list sort"),
				...optionalBooleanProperty(row.gated, "gated"),
			},
		};
	}
	const row = strictObject(input, [
		"search", "author", "filters", "sort", "limit", "cursor", "datasets", "models", "linked",
	], operation);
	return {
		operation,
		parameters: {
			...parseHubList(row, defaultLimit, SPACE_SORT_VALUES, "spaces_list sort"),
			...optionalTextArrayProperty(row.datasets, "datasets", 20),
			...optionalTextArrayProperty(row.models, "models", 20),
			...optionalBooleanProperty(row.linked, "linked"),
		},
	};
}

export function canonicalHuggingFaceQuery(request: ParsedHuggingFaceProviderRequest): string {
	return `huggingface:${request.operation}:${JSON.stringify(request.parameters)}`;
}

export function huggingFaceOperationMaterializesWorkspace(operation: string | undefined): boolean {
	return operation === "models_card" || operation === "papers_download";
}

function parseHubList<const SortValues extends readonly HuggingFaceHubSort[]>(
	row: Record<string, unknown>,
	defaultLimit: number,
	sortValues: SortValues,
	sortLabel: string,
): HuggingFaceHubListParameters<SortValues[number]> {
	const sort = optionalEnum(row.sort, sortLabel, sortValues);
	return {
		...optionalTextProperty(row.search, "search", 2_000),
		...optionalTextProperty(row.author, "author", 256),
		...optionalTextArrayProperty(row.filters, "filters", 50),
		...(sort ? { sort } : {}),
		limit: optionalInteger(row.limit, "limit", 1, MAX_PAGE_SIZE) ?? defaultLimit,
		...optionalTextProperty(row.cursor, "cursor", MAX_CURSOR_LENGTH),
	};
}

function parseOperation(value: string): HuggingFaceOperation {
	if (!HUGGINGFACE_OPERATIONS.includes(value as HuggingFaceOperation)) {
		throw new Error(`Unsupported Hugging Face operation '${value}'`);
	}
	return value as HuggingFaceOperation;
}

function strictObject(
	value: Record<string, unknown>,
	allowedKeys: string[],
	operation: HuggingFaceOperation,
): Record<string, unknown> {
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`Unsupported Hugging Face ${operation} parameter '${key}'`);
	}
	return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string, maxLength: number): string {
	const parsed = optionalText(value, label, maxLength);
	if (!parsed) throw new Error(`Hugging Face ${label} is required`);
	return parsed;
}

function requireRepoId(value: unknown, label: string): string {
	const parsed = requireText(value, label, 96);
	const parts = parsed.split("/");
	if (
		!REPO_ID.test(parsed)
		|| parts.some((part) => part.startsWith("-") || part.startsWith(".")
			|| part.endsWith("-") || part.endsWith("."))
		|| parsed.includes("--")
		|| parsed.includes("..")
	) {
		throw new Error(`Hugging Face ${label} must be a valid repository ID`);
	}
	return parsed;
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
		throw new Error(`Hugging Face ${label} must be a non-empty string up to ${maxLength} characters`);
	}
	return value.trim();
}

function optionalPattern(
	value: unknown,
	label: string,
	pattern: RegExp,
	format: string,
): string | undefined {
	const parsed = optionalText(value, label, 32);
	if (parsed && !pattern.test(parsed)) throw new Error(`Hugging Face ${label} must use ${format}`);
	return parsed;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	const parsed = optionalInteger(value, label, minimum, maximum);
	if (parsed === undefined) throw new Error(`Hugging Face ${label} is required`);
	return parsed;
}

function optionalInteger(
	value: unknown,
	label: string,
	minimum: number,
	maximum: number,
): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`Hugging Face ${label} must be an integer from ${minimum} to ${maximum}`);
	}
	return Number(value);
}

function optionalEnum<const T extends readonly string[]>(
	value: unknown,
	label: string,
	values: T,
): T[number] | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !values.includes(value)) {
		throw new Error(`Hugging Face ${label} must be one of ${values.join(", ")}`);
	}
	return value as T[number];
}

function optionalStringOrArray(
	value: unknown,
	label: string,
	maxItems: number,
): string | string[] | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "string") return requireText(value, label, 256);
	return parseTextArray(value, label, maxItems);
}

function parseTextArray(value: unknown, label: string, maxItems: number): string[] {
	if (!Array.isArray(value) || value.length > maxItems) {
		throw new Error(`Hugging Face ${label} must be an array with at most ${maxItems} items`);
	}
	const rows = value.map((item) => requireText(item, label, 256));
	return [...new Set(rows)];
}

function optionalTextProperty(
	value: unknown,
	label: string,
	maxLength: number,
): Record<string, string> {
	const parsed = optionalText(value, label, maxLength);
	return parsed === undefined ? {} : { [label]: parsed };
}

function optionalTextArrayProperty(
	value: unknown,
	label: string,
	maxItems: number,
): Record<string, string[]> {
	if (value === undefined || value === null) return {};
	return { [label]: parseTextArray(value, label, maxItems) };
}

function optionalBooleanProperty(
	value: unknown,
	label: string,
): Record<string, boolean> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "boolean") throw new Error(`Hugging Face ${label} must be a boolean`);
	return { [label]: value };
}

function optionalEnumProperty<const T extends readonly string[]>(
	value: unknown,
	label: string,
	values: T,
): Record<string, T[number]> {
	const parsed = optionalEnum(value, label, values);
	return parsed === undefined ? {} : { [label]: parsed };
}
