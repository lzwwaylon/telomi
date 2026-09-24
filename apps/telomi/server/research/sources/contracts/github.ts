import type { ResearchProviderRequest } from "../../../providers/search-types.js";

const MAX_RESULTS = 100;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const TOPIC = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,49})$/u;

export const GITHUB_OPERATIONS = [
	"search_topics",
	"search_repositories",
	"get_repository",
	"search_code",
	"search_issues",
	"get_issue",
	"clone_repository",
	"download_release",
	"download_file",
] as const;

export type GitHubOperation = typeof GITHUB_OPERATIONS[number];

export interface GitHubParametersByOperation {
	search_topics: { query: string; curated_only: boolean; limit: number };
	search_repositories: {
		query: string;
		topics?: string[];
		language?: string;
		min_stars?: number;
		created_after?: string;
		created_before?: string;
		pushed_after?: string;
		sort?: "stars" | "updated" | "forks";
		order?: "desc" | "asc";
		limit: number;
	};
	get_repository: { repository: string };
	search_code: { query: string; repository?: string; limit: number };
	search_issues: {
		query: string;
		repository?: string;
		state: "open" | "closed" | "all";
		match?: "title" | "body" | "comments";
		limit: number;
	};
	get_issue: { repository: string; number: number };
	clone_repository: { repository: string; ref?: string; full_history: boolean };
	download_release: {
		repository: string;
		tag?: string;
		patterns?: string[];
		archive?: "zip" | "tar.gz";
	};
	download_file: { repository: string; path: string; ref?: string };
}

export type ParsedGitHubProviderRequest = {
	[K in GitHubOperation]: {
		operation: K;
		parameters: GitHubParametersByOperation[K];
	};
}[GitHubOperation];

export function parseGitHubProviderRequest(
	request: ResearchProviderRequest | undefined,
	requestQuery: string,
	requestMaxResults: number,
): ParsedGitHubProviderRequest {
	if (!request) throw new Error("GitHub Provider requests require an explicit operation");
	if (!GITHUB_OPERATIONS.includes(request.operation as GitHubOperation)) {
		throw new Error(`Unsupported GitHub operation '${request.operation}'`);
	}
	const operation = request.operation as GitHubOperation;
	const row = strictObject(request.parameters, allowedKeys(operation), operation);
	const defaultLimit = Math.min(integer(requestMaxResults, "max_results", 1, MAX_RESULTS), MAX_RESULTS);

	if (operation === "search_topics") {
		return {
			operation,
			parameters: {
				query: optionalText(row.query, "query", 2_000) ?? text(requestQuery, "query", 2_000),
				curated_only: optionalBoolean(row.curated_only, "curated_only") ?? false,
				limit: optionalInteger(row.limit, "limit", 1, MAX_RESULTS) ?? defaultLimit,
			},
		};
	}
	if (operation === "search_repositories") {
		const topics = optionalTextArray(row.topics, "topics", 20, 50)?.map(topic);
		const query = row.query === undefined
			? text(requestQuery, "query", 2_000)
			: possiblyEmptyText(row.query, "query", 2_000);
		if (!query && !topics?.length) throw new Error("GitHub query may be empty only when topics are provided");
		const createdAfter = row.created_after === undefined ? undefined : dateText(row.created_after, "created_after");
		const createdBefore = row.created_before === undefined ? undefined : dateText(row.created_before, "created_before");
		if (createdAfter && createdBefore && createdAfter > createdBefore) {
			throw new Error("GitHub created_after must not be later than created_before");
		}
		return {
			operation,
			parameters: {
				query,
				...(topics?.length ? { topics } : {}),
				...(row.language === undefined ? {} : { language: text(row.language, "language", 100) }),
				...(row.min_stars === undefined ? {} : {
					min_stars: integer(row.min_stars, "min_stars", 0, Number.MAX_SAFE_INTEGER),
				}),
				...(createdAfter ? { created_after: createdAfter } : {}),
				...(createdBefore ? { created_before: createdBefore } : {}),
				...(row.pushed_after === undefined ? {} : {
					pushed_after: dateText(row.pushed_after, "pushed_after"),
				}),
				...(row.sort === undefined ? {} : {
					sort: requiredEnum(row.sort, "sort", ["stars", "updated", "forks"] as const),
				}),
				...(row.order === undefined ? {} : {
					order: requiredEnum(row.order, "order", ["desc", "asc"] as const),
				}),
				limit: optionalInteger(row.limit, "limit", 1, MAX_RESULTS) ?? defaultLimit,
			},
		};
	}
	if (operation === "get_repository") {
		return { operation, parameters: { repository: repository(row.repository) } };
	}
	if (operation === "search_code") {
		return {
			operation,
			parameters: {
				query: optionalText(row.query, "query", 2_000) ?? text(requestQuery, "query", 2_000),
				...(row.repository === undefined ? {} : { repository: repository(row.repository) }),
				limit: optionalInteger(row.limit, "limit", 1, MAX_RESULTS) ?? defaultLimit,
			},
		};
	}
	if (operation === "search_issues") {
		return {
			operation,
			parameters: {
				query: optionalText(row.query, "query", 2_000) ?? text(requestQuery, "query", 2_000),
				...(row.repository === undefined ? {} : { repository: repository(row.repository) }),
				state: optionalEnum(row.state, "state", ["open", "closed", "all"] as const) ?? "all",
				...(row.match === undefined ? {} : {
					match: requiredEnum(row.match, "match", ["title", "body", "comments"] as const),
				}),
				limit: optionalInteger(row.limit, "limit", 1, MAX_RESULTS) ?? defaultLimit,
			},
		};
	}
	if (operation === "get_issue") {
		return {
			operation,
			parameters: {
				repository: repository(row.repository),
				number: integer(row.number, "number", 1, Number.MAX_SAFE_INTEGER),
			},
		};
	}
	if (operation === "clone_repository") {
		return {
			operation,
			parameters: {
				repository: repository(row.repository),
				...(row.ref === undefined ? {} : { ref: ref(row.ref, "ref") }),
				full_history: optionalBoolean(row.full_history, "full_history") ?? false,
			},
		};
	}
	if (operation === "download_release") {
		const tag = row.tag === undefined ? undefined : ref(row.tag, "tag");
		const patterns = optionalTextArray(row.patterns, "patterns", 20, 256);
		const archive = row.archive === undefined
			? undefined
			: requiredEnum(row.archive, "archive", ["zip", "tar.gz"] as const);
		if (!tag && !patterns?.length && !archive) {
			throw new Error("GitHub download_release requires tag, patterns, or archive");
		}
		return {
			operation,
			parameters: {
				repository: repository(row.repository),
				...(tag ? { tag } : {}),
				...(patterns?.length ? { patterns } : {}),
				...(archive ? { archive } : {}),
			},
		};
	}
	return {
		operation,
		parameters: {
			repository: repository(row.repository),
			path: repositoryPath(row.path),
			...(row.ref === undefined ? {} : { ref: ref(row.ref, "ref") }),
		},
	};
}

export function canonicalGitHubQuery(request: ParsedGitHubProviderRequest): string {
	return `github:${request.operation}:${JSON.stringify(request.parameters)}`;
}

export function githubOperationMaterializesWorkspace(operation: string | undefined): boolean {
	return operation === "clone_repository" || operation === "download_release" || operation === "download_file";
}

function allowedKeys(operation: GitHubOperation): string[] {
	switch (operation) {
		case "search_topics": return ["query", "curated_only", "limit"];
		case "search_repositories": return [
			"query", "topics", "language", "min_stars", "created_after", "created_before",
			"pushed_after", "sort", "order", "limit",
		];
		case "get_repository": return ["repository"];
		case "search_code": return ["query", "repository", "limit"];
		case "search_issues": return ["query", "repository", "state", "match", "limit"];
		case "get_issue": return ["repository", "number"];
		case "clone_repository": return ["repository", "ref", "full_history"];
		case "download_release": return ["repository", "tag", "patterns", "archive"];
		case "download_file": return ["repository", "path", "ref"];
	}
}

function strictObject(
	value: unknown,
	allowedKeys: string[],
	operation: GitHubOperation,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("GitHub parameters must be an object");
	}
	const row = value as Record<string, unknown>;
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(row)) {
		if (!allowed.has(key)) throw new Error(`Unsupported GitHub ${operation} parameter '${key}'`);
	}
	return row;
}

function repository(value: unknown): string {
	const result = text(value, "repository", 140);
	if (!REPOSITORY.test(result)) throw new Error("GitHub repository must use OWNER/REPO form");
	return result;
}

function repositoryPath(value: unknown): string {
	const result = text(value, "path", 4_096);
	if (result.startsWith("/") || result.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error("GitHub path must be a safe relative repository path");
	}
	return result;
}

function ref(value: unknown, name: string): string {
	const result = text(value, name, 255);
	if (result.startsWith("-") || /[\u0000-\u001f\u007f]/u.test(result)) {
		throw new Error(`GitHub ${name} is invalid`);
	}
	return result;
}

function text(value: unknown, name: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
		throw new Error(`GitHub ${name} must be a non-empty string up to ${maxLength} characters`);
	}
	return value.trim();
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
	return value === undefined ? undefined : text(value, name, maxLength);
}

function possiblyEmptyText(value: unknown, name: string, maxLength: number): string {
	if (typeof value !== "string" || value.length > maxLength) {
		throw new Error(`GitHub ${name} must be a string up to ${maxLength} characters`);
	}
	return value.trim();
}

function topic(value: string): string {
	if (!TOPIC.test(value)) throw new Error("GitHub topic must contain only letters, numbers, and hyphens");
	return value;
}

function dateText(value: unknown, name: string): string {
	const result = text(value, name, 10);
	const parsed = new Date(`${result}T00:00:00Z`);
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(result) || Number.isNaN(parsed.valueOf())
		|| parsed.toISOString().slice(0, 10) !== result) {
		throw new Error(`GitHub ${name} must use YYYY-MM-DD`);
	}
	return result;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`GitHub ${name} must be an integer between ${minimum} and ${maximum}`);
	}
	return Number(value);
}

function optionalInteger(
	value: unknown,
	name: string,
	minimum: number,
	maximum: number,
): number | undefined {
	return value === undefined ? undefined : integer(value, name, minimum, maximum);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`GitHub ${name} must be a boolean`);
	return value;
}

function requiredEnum<const T extends readonly string[]>(
	value: unknown,
	name: string,
	values: T,
): T[number] {
	if (typeof value !== "string" || !values.includes(value)) {
		throw new Error(`GitHub ${name} must be one of ${values.join(", ")}`);
	}
	return value as T[number];
}

function optionalEnum<const T extends readonly string[]>(
	value: unknown,
	name: string,
	values: T,
): T[number] | undefined {
	return value === undefined ? undefined : requiredEnum(value, name, values);
}

function optionalTextArray(
	value: unknown,
	name: string,
	maxItems: number,
	maxLength: number,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > maxItems) {
		throw new Error(`GitHub ${name} must be an array with at most ${maxItems} items`);
	}
	return [...new Set(value.map((item) => text(item, name, maxLength)))];
}
