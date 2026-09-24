import type { ResearchProviderRequest } from "../../../providers/search-types.js";

const ARXIV_MAX_RESULTS = 50;
const ARXIV_MAX_START = 10_000_000;
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[A-Za-z][A-Za-z0-9.-]*\/\d{7})(?:v\d+)?$/u;

export const ARXIV_OPERATIONS = ["query", "categories", "paper_front", "download_pdf"] as const;
export type ArxivOperation = typeof ARXIV_OPERATIONS[number];

export type ArxivSortBy = "relevance" | "lastUpdatedDate" | "submittedDate";
export type ArxivSortOrder = "ascending" | "descending";
export type ArxivHttpMethod = "auto" | "get" | "post";

export interface ArxivQueryParameters {
	search_query?: string;
	id_list?: string[];
	start?: number;
	max_results?: number;
	sortBy?: ArxivSortBy;
	sortOrder?: ArxivSortOrder;
	http_method?: ArxivHttpMethod;
}

export interface ArxivDownloadPdfParameters {
	arxiv_id: string;
}

export interface ArxivPaperFrontParameters extends ArxivDownloadPdfParameters {
	max_bytes?: number;
}

export interface ArxivCategoriesParameters {
	search?: string | string[];
	start?: number;
	max_results?: number;
}

export function canonicalArxivQuery(parameters: ArxivQueryParameters): string {
	const values = new URLSearchParams();
	if (parameters.search_query) values.set("search_query", parameters.search_query);
	if (parameters.id_list?.length) values.set("id_list", parameters.id_list.join(","));
	if (parameters.start !== undefined) values.set("start", String(parameters.start));
	if (parameters.max_results !== undefined) values.set("max_results", String(parameters.max_results));
	if (parameters.sortBy) values.set("sortBy", parameters.sortBy);
	if (parameters.sortOrder) values.set("sortOrder", parameters.sortOrder);
	return values.toString();
}

export function parseArxivProviderRequest(
	request: ResearchProviderRequest | undefined,
): ArxivQueryParameters | ArxivDownloadPdfParameters | ArxivPaperFrontParameters | ArxivCategoriesParameters {
	if (!request) throw new Error("arXiv Provider requests require an explicit operation");
	if (request.operation === "paper_front") {
		const row = request.parameters;
		if (Object.keys(row).some((key) => key !== "arxiv_id" && key !== "max_bytes")) {
			throw new Error("Unsupported arXiv paper_front parameter");
		}
		if (typeof row.arxiv_id !== "string" || !ARXIV_ID.test(row.arxiv_id)) {
			throw new Error("arXiv arxiv_id must be an exact identifier");
		}
		const maxBytes = optionalInteger(row.max_bytes, "paper_front max_bytes", 1_024, 50 * 1024 * 1024);
		return { arxiv_id: row.arxiv_id, ...(maxBytes !== undefined ? { max_bytes: maxBytes } : {}) };
	}
	if (request.operation === "download_pdf") {
		const row = request.parameters;
		if (Object.keys(row).some((key) => key !== "arxiv_id")) {
			throw new Error("Unsupported arXiv download_pdf parameter");
		}
		if (typeof row.arxiv_id !== "string" || !ARXIV_ID.test(row.arxiv_id)) {
			throw new Error("arXiv arxiv_id must be an exact identifier");
		}
		return { arxiv_id: row.arxiv_id };
	}
	if (request.operation === "categories") {
		const row = request.parameters;
		if (Object.keys(row).some((key) => key !== "search" && key !== "start" && key !== "max_results")) {
			throw new Error("Unsupported arXiv categories parameter");
		}
		const search = optionalStringList(row.search, "category search", 20, 200);
		const start = optionalInteger(row.start, "category start", 0, 500);
		const maxResults = optionalInteger(row.max_results, "category max_results", 1, 100);
		return {
			...(search.length > 0 ? { search } : {}),
			...(start !== undefined ? { start } : {}),
			...(maxResults !== undefined ? { max_results: maxResults } : {}),
		};
	}
	if (request.operation !== "query") {
		throw new Error(`arXiv Provider operation must be one of ${ARXIV_OPERATIONS.join(", ")}, received '${request.operation}'`);
	}
	return validateArxivQueryParameters(request.parameters);
}

export function validateArxivQueryParameters(value: unknown): ArxivQueryParameters {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("arXiv query parameters must be an object");
	}
	const row = value as Record<string, unknown>;
	const allowed = new Set(["search_query", "id_list", "start", "max_results", "sortBy", "sortOrder", "http_method"]);
	for (const key of Object.keys(row)) {
		if (!allowed.has(key)) throw new Error(`Unsupported arXiv API parameter '${key}'`);
	}
	const searchQuery = optionalString(row.search_query, "search_query", 20_000);
	const idList = parseIdList(row.id_list);
	if (!searchQuery && idList.length === 0) throw new Error("arXiv query requires search_query, id_list, or both");
	const start = optionalInteger(row.start, "start", 0, ARXIV_MAX_START);
	const maxResults = optionalInteger(row.max_results, "max_results", 1, ARXIV_MAX_RESULTS);
	const sortBy = optionalEnum(row.sortBy, "sortBy", ["relevance", "lastUpdatedDate", "submittedDate"] as const);
	const sortOrder = optionalEnum(row.sortOrder, "sortOrder", ["ascending", "descending"] as const);
	const httpMethod = optionalEnum(row.http_method, "http_method", ["auto", "get", "post"] as const);
	return {
		...(searchQuery ? { search_query: searchQuery } : {}),
		...(idList.length > 0 ? { id_list: idList } : {}),
		...(start !== undefined ? { start } : {}),
		...(maxResults !== undefined ? { max_results: maxResults } : {}),
		...(sortBy ? { sortBy } : {}),
		...(sortOrder ? { sortOrder } : {}),
		...(httpMethod ? { http_method: httpMethod } : {}),
	};
}

function optionalString(value: unknown, label: string, limit: number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > limit) {
		throw new Error(`arXiv ${label} must be a non-empty string up to ${limit} characters`);
	}
	return value.trim();
}

function optionalStringList(value: unknown, label: string, countLimit: number, lengthLimit: number): string[] {
	if (value === undefined || value === null || value === "") return [];
	const values = typeof value === "string" ? [value] : value;
	if (!Array.isArray(values) || values.length > countLimit) {
		throw new Error(`arXiv ${label} must contain at most ${countLimit} text values`);
	}
	const normalized: string[] = [];
	for (const item of values) {
		if (typeof item !== "string" || !item.trim() || item.length > lengthLimit) {
			throw new Error(`arXiv ${label} values must be non-empty strings up to ${lengthLimit} characters`);
		}
		if (!normalized.includes(item.trim())) normalized.push(item.trim());
	}
	return normalized;
}

function optionalInteger(
	value: unknown,
	label: string,
	minimum: number,
	maximum: number,
): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`arXiv ${label} must be an integer from ${minimum} to ${maximum}`);
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
		throw new Error(`arXiv ${label} must be one of ${values.join(", ")}`);
	}
	return value as T[number];
}

function parseIdList(value: unknown): string[] {
	if (value === undefined || value === null || value === "") return [];
	const rows = typeof value === "string"
		? value.split(",")
		: Array.isArray(value) ? value : undefined;
	if (!rows || !rows.every((item) => typeof item === "string")) {
		throw new Error("arXiv id_list must be a string or string array");
	}
	const ids = rows.map((item) => item.trim()).filter(Boolean);
	if (ids.length > 10_000) throw new Error("arXiv id_list exceeds 10000 identifiers");
	if (ids.some((id) => id.length > 200)) throw new Error("arXiv id_list contains an oversized identifier");
	return [...new Set(ids)];
}
