import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { ResearchNodeError } from "../agent-runtime/retry-policy.js";
import { sha256 } from "../lib/hash.js";
import type { ProviderSearchOutcome, ResearchSearchRequest, ResearchSearchResult } from "./search-types.js";

export const PROVIDER_CALLS_FILE = "provider-calls.jsonl";

/** Run, node and attempt identity that a Provider caller attaches to every search it makes. */
export interface ProviderCallRecorder {
	runDir: string;
	nodeId: string;
	attemptId: string;
	subExecutionId?: string;
}

/** One line of `<runDir>/provider-calls.jsonl`. */
export interface ProviderCallRecord {
	seq: number;
	node_id: string;
	attempt_id: string;
	sub_execution_id?: string;
	provider: string;
	at: string;
	latency_ms: number;
	request: {
		query: string;
		purpose: string;
		criterion_ids: string[];
		temporal_range?: { start_date: string; end_date: string };
		provider_request?: { operation: string; parameters: Record<string, unknown> };
		max_results: number;
	};
	/** What the Provider Runtime spent on this call; absent in records written before it was recorded. */
	execution?: {
		attempts: number;
		queue_wait_ms: number;
		interval_wait_ms: number;
		rate_limit_wait_ms: number;
	};
	response: {
		status: "ok" | "error" | "empty";
		cache: "hit" | "miss";
		doc_ids: string[];
		/** Provider-native dates as reported at `at`; evaluation reads these, never the Agent's own notes. */
		docs: ProviderCallDoc[];
		material_sha256: string[];
		error?: string;
		error_code?: string;
		/** Why the Provider Child stopped calling this Provider, when this call ended that way. */
		termination_reason?: string;
	};
}

export interface ProviderCallDoc {
	id: string;
	url: string;
	title: string;
	/** First publication or creation time. */
	published_at?: string;
	/** Last change the Provider reports: arXiv version, Hub lastModified, GitHub push. */
	updated_at?: string;
}

export function providerCallsPath(runDir: string): string {
	return join(runDir, PROVIDER_CALLS_FILE);
}

export function readProviderCallRecords(runDir: string): ProviderCallRecord[] {
	const path = providerCallsPath(runDir);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as ProviderCallRecord);
}

export function recordProviderCall(recorder: ProviderCallRecorder, input: {
	provider: string;
	request: ResearchSearchRequest;
	startedAt: number;
	outcome?: ProviderSearchOutcome;
	error?: unknown;
	execution?: ProviderSearchOutcome["execution"];
}): ProviderCallRecord {
	const path = providerCallsPath(recorder.runDir);
	mkdirSync(dirname(path), { recursive: true });
	const seq = existsSync(path) ? readFileSync(path, "utf-8").split(/\r?\n/u).filter(Boolean).length + 1 : 1;
	const results = input.outcome?.results ?? [];
	const execution = input.outcome?.execution ?? input.execution;
	const failure = input.error instanceof ResearchNodeError ? input.error : undefined;
	const record: ProviderCallRecord = {
		seq,
		node_id: recorder.nodeId,
		attempt_id: recorder.attemptId,
		...(recorder.subExecutionId ? { sub_execution_id: recorder.subExecutionId } : {}),
		provider: input.provider,
		at: new Date(input.startedAt).toISOString(),
		latency_ms: Math.max(0, Date.now() - input.startedAt),
		request: {
			query: input.request.query,
			purpose: input.request.purpose,
			criterion_ids: [...input.request.criterionIds],
			...(input.request.temporalRange ? {
				temporal_range: {
					start_date: input.request.temporalRange.startDate,
					end_date: input.request.temporalRange.endDate,
				},
			} : {}),
			...(input.request.providerRequest ? {
				provider_request: {
					operation: input.request.providerRequest.operation,
					parameters: input.request.providerRequest.parameters,
				},
			} : {}),
			max_results: input.request.maxResults,
		},
		...(execution ? {
			execution: {
				attempts: execution.attempts,
				queue_wait_ms: execution.queueWaitMs,
				interval_wait_ms: execution.intervalWaitMs,
				rate_limit_wait_ms: execution.rateLimitWaitMs,
			},
		} : {}),
		response: input.outcome
			? {
				status: results.length > 0 ? "ok" : "empty",
				cache: input.outcome.cache.status === "hit" ? "hit" : "miss",
				doc_ids: results.map((result) => result.id),
				docs: results.map(providerCallDoc),
				material_sha256: results.flatMap((result) => {
					const material = materialPath(result, input.request.workspaceDir);
					return material ? [sha256(readFileSync(material))] : [];
				}),
			}
			: {
				status: "error",
				cache: "miss",
				doc_ids: [],
				docs: [],
				material_sha256: [],
				error: input.error instanceof Error ? input.error.message : String(input.error),
				...(failure?.code ? { error_code: failure.code } : {}),
				...(failure?.code === "source_unavailable" && typeof failure.details?.reason === "string"
					? { termination_reason: failure.details.reason } : {}),
			},
	};
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
	return record;
}

function providerCallDoc(result: ResearchSearchResult): ProviderCallDoc {
	const metadata = result.metadata ?? {};
	const date = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === "string" && value.trim() !== "");
	const publishedAt = date(result.publishedAt, metadata.created_at);
	const updatedAt = date(metadata.pushed_at, metadata.updated_at, metadata.last_modified);
	return {
		id: result.id,
		url: result.url,
		title: result.title,
		...(publishedAt ? { published_at: publishedAt } : {}),
		...(updatedAt ? { updated_at: updatedAt } : {}),
	};
}

/** Providers report materialized files as `artifact_path` (relative to the workspace) or an absolute `provider_artifact_path`. */
function materialPath(result: ResearchSearchResult, workspaceDir: string): string | undefined {
	const metadata = result.metadata ?? {};
	for (const candidate of [metadata.provider_artifact_path, metadata.artifact_path]) {
		if (typeof candidate !== "string" || !candidate) continue;
		const path = isAbsolute(candidate) ? candidate : join(workspaceDir, candidate);
		if (existsSync(path) && lstatSync(path).isFile()) return path;
	}
	return undefined;
}
