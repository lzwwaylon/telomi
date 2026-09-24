import { apiClient } from "@/shared/lib/api-client";
import { ArrowUpRight, Database, GitBranch, Sparkles } from "lucide-react";
import { DocumentIcon as FileText, SearchIcon as Search } from "@/shared/ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";

import { wikiSearchSnippetParts, splitSearchHighlights } from "@/features/wiki/wiki-model";
import { uiText } from "@/app/ui-text";

type SearchSource = "keyword" | "embedding" | "graph";

interface SearchResult {
	path: string;
	title: string;
	type: string;
	snippet: string;
	sources: SearchSource[];
	graphRelatedTo?: string[];
	knowledgeContext: { linkCount: number };
}

interface IndexCoverage {
	status: "ready" | "partial" | "pending" | "unavailable";
	indexedPages: number;
	totalPages: number;
	refreshing: boolean;
	error?: string;
}

interface SearchResponse {
	mode: "hybrid" | "keyword_graph";
	tokenHits: number;
	vectorHits: number;
	graphHits: number;
	elapsedMs: number;
	index?: IndexCoverage;
	results: SearchResult[];
}

const SOURCE_LABEL = { keyword: "common.keyword", embedding: "common.embedding", graph: "common.graph" } as const;

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeResponse(value: unknown): SearchResponse {
	if (!value || typeof value !== "object") throw new Error(uiText("wiki.searchview.wikiSearchReturnedAnInvalidResponse"));
	const row = value as Record<string, unknown>;
	const results = Array.isArray(row.results) ? row.results.flatMap((item): SearchResult[] => {
		if (!item || typeof item !== "object") return [];
		const result = item as Record<string, unknown>;
		if (typeof result.path !== "string" || typeof result.title !== "string") return [];
		const context = result.knowledgeContext && typeof result.knowledgeContext === "object"
			? result.knowledgeContext as Record<string, unknown> : {};
		const sources = Array.isArray(result.sources)
			? result.sources.filter((source): source is SearchSource => source === "keyword" || source === "embedding" || source === "graph") : [];
		return [{
			path: result.path,
			title: result.title,
			type: typeof result.type === "string" ? result.type : "Reference",
			snippet: typeof result.snippet === "string" ? result.snippet : "",
			sources,
			...(Array.isArray(result.graphRelatedTo) ? { graphRelatedTo: result.graphRelatedTo.filter((path): path is string => typeof path === "string") } : {}),
			knowledgeContext: {
				linkCount: number(context.linkCount),
			},
		}];
	}) : [];
	const index = normalizeIndex(row.index);
	return {
		mode: row.mode === "keyword_graph" ? "keyword_graph" : "hybrid",
		tokenHits: number(row.tokenHits),
		vectorHits: number(row.vectorHits),
		graphHits: number(row.graphHits),
		elapsedMs: number(row.elapsedMs),
		...(index ? { index } : {}),
		results,
	};
}

function normalizeIndex(value: unknown): IndexCoverage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const row = value as Record<string, unknown>;
	const status = row.status === "ready" || row.status === "partial" || row.status === "pending" || row.status === "unavailable" ? row.status : undefined;
	if (!status) return undefined;
	return {
		status,
		indexedPages: number(row.indexedPages),
		totalPages: number(row.totalPages),
		refreshing: row.refreshing === true,
		...(typeof row.error === "string" ? { error: row.error } : {}),
	};
}

/** Why semantic signals are missing or partial; the index refreshes after each Wiki publication, not during search. */
function retrievalNotice(data: SearchResponse): string | null {
	const index = data.index;
	if (index?.status === "pending" || index?.status === "partial") {
		const pages = { indexed: index.indexedPages, total: index.totalPages };
		const coverage = uiText(index.status === "pending" ? "wiki.searchview.indexPending" : "wiki.searchview.indexPartial", pages);
		const refresh = index.refreshing ? uiText("wiki.searchview.indexRefreshing")
			: index.error ? uiText("wiki.searchview.indexRetrying", { error: index.error }) : "";
		return refresh ? `${coverage} ${refresh}` : coverage;
	}
	return data.mode === "keyword_graph" ? uiText("wiki.searchview.embeddingWasUnavailableHybridUsedKeywordAndGraphSignals") : null;
}

function Highlight({ text, query }: { text: string; query: string }) {
	return <>{splitSearchHighlights(text, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text)}</>;
}

export function WikiSearchView({ goalId, topicId, revision, query, onOpenPage, titleFor }: { query: string; goalId: string; topicId?: string; revision?: string | null; onOpenPage: (path: string, evidenceIndex?: number) => void; titleFor?: (path: string) => string | undefined }) {
	const [submittedQuery, setSubmittedQuery] = useState("");
	const [data, setData] = useState<SearchResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const requestRef = useRef<AbortController | null>(null);

	const runSearch = useCallback(async (query: string) => {
		const trimmed = query.trim();
		if (!trimmed) return;
		requestRef.current?.abort();
		const controller = new AbortController();
		requestRef.current = controller;
		setSubmittedQuery(trimmed);
		setLoading(true);
		setError(null);
		try {
			const params = new URLSearchParams({ q: trimmed, limit: "20" });
			if (topicId) params.set("topic", topicId);
			if (revision) params.set("revision", revision);
			const body = await apiClient.get(`/api/goals/${encodeURIComponent(goalId)}/wiki/search?${params}`, {
				signal: controller.signal, headers: { Accept: "application/json" },
			});
			setData(normalizeResponse(body));
		} catch (reason) {
			if (controller.signal.aborted) return;
			setData(null);
			setError(reason instanceof Error ? reason.message : uiText("wiki.searchview.wikiSearchFailed"));
		} finally {
			if (!controller.signal.aborted) setLoading(false);
		}
	}, [goalId, revision, topicId]);

	useEffect(() => {
		setData(null);
		setSubmittedQuery("");
		setError(null);
		setLoading(false);
		void runSearch(query);
		return () => requestRef.current?.abort();
	}, [query, runSearch]);

	return (
		<main className="wiki-search-page" data-testid="wiki-search-page">
			<section className="wiki-search-hero">
				<h1>{uiText("wiki.searchview.searchTheKnowledgeBase")}</h1>
				<p>{uiText("wiki.searchview.hybridRetrievalExplainer")}</p>
			</section>

			{error ? <div className="wiki-search-error" role="alert"><strong>{uiText("wiki.searchview.searchUnavailable")}</strong><span>{error}</span><button type="button" onClick={() => void runSearch(submittedQuery || query)}>{uiText("media.retry")}</button></div> : null}
			{!data && !loading && !error ? <div className="wiki-search-empty"><Sparkles aria-hidden /><h2>{uiText("wiki.searchview.startSearching")}</h2></div> : null}
			{loading ? <div className="wiki-search-loading" role="status"><span /><p>{uiText("wiki.searchview.queryingLancedbAndRankingMatches")}</p></div> : null}
			{data && !loading ? (
				<section className="wiki-search-results" aria-live="polite">
					<header className="wiki-search-summary">
						<div><span>{uiText("wiki.searchview.resultsFor")}</span><h2>“{submittedQuery}”</h2></div>
						<dl>
							<div><dt>{uiText("wiki.searchview.returned")}</dt><dd>{data.results.length}</dd></div>
							<div><dt>{uiText("common.keyword")}</dt><dd>{data.tokenHits}</dd></div>
							<div><dt>{uiText("common.embedding")}</dt><dd>{data.vectorHits}</dd></div>
							<div><dt>{uiText("common.graph")}</dt><dd>{data.graphHits}</dd></div>
							<div><dt>{uiText("wiki.searchview.time")}</dt><dd>{data.elapsedMs} ms</dd></div>
						</dl>
					</header>
					{retrievalNotice(data) ? <p className="wiki-search-degraded">{retrievalNotice(data)}</p> : null}
					<div className="wiki-result-list">
						{data.results.map((result, index) => (
							<article className="wiki-result-card" key={result.path}>
								<div className="wiki-result-rank">{String(index + 1).padStart(2, "0")}</div>
								<div className="wiki-result-body">
									<div className="wiki-result-meta"><span className="wiki-result-type"><FileText aria-hidden />{result.type}</span>{result.sources.map((source) => <span className={`wiki-source-badge ${source}`} key={source}>{source === "embedding" ? <Database aria-hidden /> : source === "graph" ? <GitBranch aria-hidden /> : <Search aria-hidden />}{uiText(SOURCE_LABEL[source])}</span>)}</div>
									<button type="button" className="wiki-result-title" onClick={() => onOpenPage(result.path.replace(/^wiki\//u, ""))}><span><Highlight text={result.title} query={submittedQuery} /></span><ArrowUpRight aria-hidden /></button>
									<p>{wikiSearchSnippetParts(result.snippet || uiText("wiki.searchview.noMatchingExcerptAvailable")).map((part, index) =>
										part.evidenceIndex ? <span key={index}><button type="button" className="wiki-search-citation" onClick={() => onOpenPage(result.path.replace(/^wiki\//u, ""), part.evidenceIndex)}>{part.text}</button> </span>
											: <span key={index}><Highlight text={part.text} query={submittedQuery} /> </span>)}</p>
									<div className="wiki-result-signals">
										{result.graphRelatedTo?.length ? <span><small>{uiText("wiki.searchview.graphLinks")}</small><strong className="wiki-result-related">{result.graphRelatedTo.map((path) => <button type="button" key={path} onClick={() => onOpenPage(path.replace(/^wiki\//u, ""))}>{titleFor?.(path.replace(/^wiki\//u, "")) ?? path.replace(/^wiki\//u, "").replace(/\.md$/iu, "")}</button>)}</strong></span> : null}
										<span><small>{uiText("wiki.searchview.pageLinks")}</small><strong>{result.knowledgeContext.linkCount}</strong></span>
									</div>
								</div>
							</article>
						))}
						{data.results.length === 0 ? <div className="wiki-search-empty"><Search aria-hidden /><h2>{uiText("wiki.searchview.noMatches")}</h2><p>{uiText("wiki.searchview.tryAnotherTerm")}</p></div> : null}
					</div>
				</section>
			) : null}
		</main>
	);
}
