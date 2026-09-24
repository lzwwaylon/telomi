import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import * as lancedb from "@lancedb/lancedb";
import * as arrow from "apache-arrow";

import { wikiSearchExcerpt } from "./evidence.js";
import { sha256 } from "../lib/hash.js";
import { toErrorMessage } from "../lib/values.js";
import { embedTexts } from "../embedding/client.js";
import { wikiEmbeddingRuntime } from "../embedding/configuration.js";
import type { WikiEmbeddingRuntime } from "../embedding/wiki-migration.js";
import { serverRuntimeDirForGoalDir } from "../workspaces/server-runtime-paths.js";
import { createWikiRuntime, type WikiGraph, type WikiNode } from "../wiki/model/index.js";

/** How much of the searched Wiki the Goal's embedding index serves right now. */
export interface WikiIndexCoverage {
	status: "ready" | "partial" | "pending" | "unavailable";
	indexedPages: number;
	totalPages: number;
	refreshing: boolean;
	error?: string;
}

type EmbeddingRuntimeFactory = () => Promise<WikiEmbeddingRuntime | undefined>;

interface IndexedChunk extends Record<string, unknown> {
	page_id: string;
	page_hash: string;
	model: string;
	chunk_index: number;
	chunk_text: string;
	heading_path: string;
	vector: number[];
}

interface IndexRefresh {
	running?: Promise<void>;
	superseded: boolean;
	failures: number;
	retryAt: number;
	error?: string;
	timer?: NodeJS.Timeout;
}

/** One Wiki root's chunks in memory: full-text indexed, with the cached vector of every chunk whose page is unchanged. */
interface SearchTable {
	name?: string;
	table?: lancedb.Table;
	vectorPages: ReadonlySet<string>;
}

interface ChunkRow {
	page_id: string;
	chunk_text: string;
}

const EMBEDDING_BATCH_SIZE = 16;
const CHUNK_TARGET_CHARS = 1_600;
const CHUNK_OVERLAP_CHARS = 200;
const SEARCH_CANDIDATE_CHUNKS = 60;
const SEARCH_TABLE_LIMIT = 16;
const REFRESH_RETRY_BASE_MS = 30_000;
const REFRESH_RETRY_MAX_MS = 30 * 60_000;
const indexWrites = new Map<string, Promise<void>>();
const refreshes = new Map<string, IndexRefresh>();
const searchTables = new Map<string, Promise<SearchTable>>();
let searchDatabase: Promise<lancedb.Connection> | undefined;
let reciprocalRankReranker: Promise<lancedb.rerankers.RRFReranker> | undefined;

/** The single embedding index a Goal keeps. It lives outside the Goal workspace, so workspace snapshots never copy it. */
export function wikiIndexPath(goalDir: string): string {
	return join(serverRuntimeDirForGoalDir(resolve(goalDir)), "wiki-index");
}

/**
 * Headless Wiki retrieval used by Pi agents and the Wiki page, read from one frozen Wiki root.
 *
 * Ranking is LanceDB's: BM25 full-text search and vector search over the root's chunks, fused by LanceDB's
 * reciprocal-rank reranker, followed by linked pages from the Wiki graph. Results carry their order and the
 * signals that found them, never a score. Only the published Wiki writes the vector index, after each
 * publication; search never embeds pages, so any root reuses the vectors of pages it shares with it.
 */
export class GoalWikiSearch {
	private readonly runtime;
	private readonly knowledgeRoot: string;

	constructor(
		knowledgeRoot: string,
		private readonly options: {
			goalDir?: string;
			/** Defaults to the unified embedding configuration for the Wiki consumer. */
			embedding?: EmbeddingRuntimeFactory;
		} = {},
	) {
		this.knowledgeRoot = resolve(knowledgeRoot);
		this.runtime = createWikiRuntime(knowledgeRoot, { goalDir: options.goalDir });
	}

	async search(query: string, topK = 10, signal?: AbortSignal, topicId?: string) {
		signal?.throwIfAborted();
		const startedAt = performance.now();
		if (!query.trim()) throw new Error("Wiki search query is required");
		const limit = Math.max(1, Math.min(20, topK));
		const fullGraph = await this.runtime.buildGraph();
		const topicNodeIds = topicId
			? new Set(fullGraph.nodes.filter((node) => node.topicRefs.includes(topicId)).map((node) => node.id))
			: undefined;
		const graph = topicNodeIds ? {
			...fullGraph,
			nodes: fullGraph.nodes.filter((node) => topicNodeIds.has(node.id)),
			edges: fullGraph.edges.filter((edge) => topicNodeIds.has(edge.source) && topicNodeIds.has(edge.target)),
		} : fullGraph;
		const runtime = await this.embeddingRuntime();
		const { table, vectorPages } = await this.searchTable(fullGraph.nodes, runtime);
		let index = this.coverage(graph.nodes, vectorPages, runtime);
		let queryVector: number[] | undefined;
		if (runtime && table && index.indexedPages > 0) {
			try {
				[queryVector] = await embedTexts(runtime, [query], "search_query", signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				console.warn("[wiki-search] query embedding unavailable; using full-text and graph:", error);
				index = { ...index, status: "unavailable", error: toErrorMessage(error) };
			}
		}
		const filter = topicNodeIds ? `page_id IN (${[...topicNodeIds].map(sqlString).join(", ") || "''"})` : undefined;
		const text = new lancedb.MatchQuery(query, "search_text");
		const read = (candidate: lancedb.Query | lancedb.VectorQuery) => (filter ? candidate.where(filter) : candidate)
			.select(["page_id", "chunk_text"]).limit(SEARCH_CANDIDATE_CHUNKS).toArray() as Promise<ChunkRow[]>;
		const keywordRows = table ? await read(table.query().fullTextSearch(text)) : [];
		const vectorRows = table && queryVector ? await read(table.query().nearestTo(queryVector).distanceType("cosine")) : [];
		const fusedRows = table && queryVector
			? await read(table.query().fullTextSearch(text).nearestTo(queryVector).distanceType("cosine").rerank(await rrfReranker()))
			: keywordRows;
		const keywordPages = new Set(keywordRows.map((row) => row.page_id));
		const vectorHitPages = new Set(vectorRows.map((row) => row.page_id));
		const bestChunk = new Map<string, string>();
		for (const row of fusedRows) if (!bestChunk.has(row.page_id)) bestChunk.set(row.page_id, row.chunk_text);
		const byId = new Map(graph.nodes.map((node) => [node.id, node]));
		const ranked = [...bestChunk.keys()].filter((id) => byId.has(id));
		const related = expandGraph(graph, ranked, graphQuota(limit, vectorHitPages.size));
		const selected = [
			...ranked.slice(0, Math.max(0, limit - related.length)).map((id) => ({ id, relatedTo: [] as string[] })),
			...related,
		];
		return {
			mode: queryVector ? "hybrid" as const : "keyword_graph" as const,
			tokenHits: keywordPages.size,
			vectorHits: vectorHitPages.size,
			graphHits: related.length,
			elapsedMs: Math.round(performance.now() - startedAt),
			index,
			results: selected.flatMap(({ id, relatedTo }) => {
				const node = byId.get(id);
				if (!node) return [];
				return [{
					path: `wiki/${node.id}.md`,
					title: node.title,
					type: node.type,
					snippet: wikiSearchExcerpt(node.body, query, { description: node.description || node.title, chunk: bestChunk.get(id) }),
					sources: [
						...(keywordPages.has(id) ? ["keyword" as const] : []),
						...(vectorHitPages.has(id) ? ["embedding" as const] : []),
						...(relatedTo.length > 0 ? ["graph" as const] : []),
					],
					...(relatedTo.length > 0 ? { graphRelatedTo: relatedTo } : {}),
					knowledgeContext: knowledgeContext(node),
				}];
			}),
		};
	}

	async readPage(path: string) {
		const page = await this.runtime.readPage(path.replace(/^wiki\//u, ""));
		return {
			...page,
			path: `wiki/${page.path}`,
			knowledgeContext: {
				outgoingLinks: page.links.map((id) => `wiki/${id}.md`),
				backlinks: page.backlinks.map((id) => `wiki/${id}.md`),
				linkCount: page.links.length + page.backlinks.length,
			},
		};
	}

	/** Full-text seeds and their direct graph neighbors. */
	async graphSearch(query: string, topK = 10) {
		const graph = await this.runtime.buildGraph();
		const { table } = await this.searchTable(graph.nodes, await this.embeddingRuntime());
		const rows = table && query.trim()
			? await table.query().fullTextSearch(new lancedb.MatchQuery(query, "search_text"))
				.select(["page_id"]).limit(SEARCH_CANDIDATE_CHUNKS).toArray() as Array<{ page_id: string }>
			: [];
		const byId = new Map(graph.nodes.map((node) => [node.id, node]));
		const seeds = [...new Set(rows.map((row) => row.page_id))]
			.flatMap((id) => byId.get(id) ?? [])
			.slice(0, Math.max(1, Math.min(20, topK)));
		const ids = new Set(seeds.map((node) => node.id));
		const edges = graph.edges.filter((edge) => ids.has(edge.source) || ids.has(edge.target));
		for (const edge of edges) {
			ids.add(edge.source);
			ids.add(edge.target);
		}
		return {
			query,
			seeds: seeds.map(summary),
			nodes: graph.nodes.filter((node) => ids.has(node.id)).map(summary),
			edges,
		};
	}

	/** Brings the Goal's index up to the published Wiki, embedding only pages whose content hash changed. */
	async refreshEmbeddings(signal?: AbortSignal, onProgress?: (added: number) => void, superseded?: () => boolean): Promise<void> {
		const goalDir = this.publishedGoalDir();
		const runtime = await this.embeddingRuntime();
		if (!runtime) return;
		const indexPath = wikiIndexPath(goalDir);
		await withIndexLock(`${indexPath}::${runtime.identity}`, async () => {
			const graph = await this.runtime.buildGraph();
			await synchronizeLanceIndex(indexPath, prepareNodes(graph.nodes), runtime, signal, onProgress, superseded);
		});
	}

	/** Chunks and characters the current selection still has to embed; the cost the page shows before a rebuild. */
	async estimateEmbeddingWork(): Promise<{ units: number; characters: number }> {
		const goalDir = this.publishedGoalDir();
		const runtime = await this.embeddingRuntime();
		if (!runtime) return { units: 0, characters: 0 };
		const graph = await this.runtime.buildGraph();
		const table = await openIndexTable(wikiIndexPath(goalDir), runtime.identity);
		const { pending } = await indexDelta(table, prepareNodes(graph.nodes));
		return { units: pending.length, characters: pending.reduce((sum, item) => sum + item.chunk.embeddingText.length, 0) };
	}

	/** Drop index tables for every identity not listed. Runs after a switch completes, when no rebuild is in flight. */
	async pruneIndexTables(retain: readonly string[]): Promise<void> {
		const indexPath = wikiIndexPath(this.publishedGoalDir());
		if (!existsSync(indexPath)) return;
		const db = await lancedb.connect(indexPath);
		for (const name of await db.tableNames()) {
			if (!retain.includes(await tableIdentity(db, name))) await db.dropTable(name);
		}
	}

	private embeddingRuntime(): Promise<WikiEmbeddingRuntime | undefined> {
		return this.options.embedding ? this.options.embedding() : wikiEmbeddingRuntime();
	}

	private publishedGoalDir(): string {
		const goalDir = this.options.goalDir;
		if (!goalDir || this.knowledgeRoot !== resolve(goalDir, "wiki", "knowledge")) {
			throw new Error("Only the published Goal Wiki maintains the embedding index");
		}
		return goalDir;
	}

	private coverage(nodes: readonly WikiNode[], vectorPages: ReadonlySet<string>, runtime?: WikiEmbeddingRuntime): WikiIndexCoverage {
		const goalDir = this.options.goalDir;
		if (!runtime || !goalDir) return { status: "unavailable", indexedPages: 0, totalPages: nodes.length, refreshing: false };
		const indexedPages = nodes.filter((node) => vectorPages.has(node.id)).length;
		if (indexedPages < nodes.length) void scheduleWikiIndexRefresh(goalDir, this.options.embedding ? { embedding: this.options.embedding } : {});
		const refresh = refreshes.get(resolve(goalDir));
		return {
			status: indexedPages === nodes.length ? "ready" : indexedPages === 0 ? "pending" : "partial",
			indexedPages,
			totalPages: nodes.length,
			refreshing: Boolean(refresh?.running),
			...(refresh?.error ? { error: refresh.error } : {}),
		};
	}

	/** Shared by every root with the same pages and index version, so a snapshot of the published Wiki reuses its table. */
	private async searchTable(nodes: readonly WikiNode[], runtime?: WikiEmbeddingRuntime): Promise<SearchTable> {
		const pages = prepareNodes(nodes);
		const goalDir = this.options.goalDir;
		const cache = runtime && goalDir ? await openIndexTable(wikiIndexPath(goalDir), runtime.identity) : undefined;
		const content = sha256([...pages].map(([id, page]) => `${id}\0${page.sha256}`).sort().join("\n"));
		const key = sha256([content, goalDir ?? "", runtime?.identity ?? "", cache ? await cache.version() : ""].join("\n"));
		const existing = searchTables.get(key);
		if (existing) {
			searchTables.delete(key);
			searchTables.set(key, existing);
			return existing;
		}
		const built = buildSearchTable(`search_${key.slice(0, 24)}`, pages, cache);
		searchTables.set(key, built);
		built.catch(() => searchTables.delete(key));
		for (const [staleKey, stale] of searchTables) {
			if (searchTables.size <= SEARCH_TABLE_LIMIT) break;
			searchTables.delete(staleKey);
			void stale.then(async ({ name }) => { if (name) await (await searchDatabase)?.dropTable(name); }).catch(() => undefined);
		}
		return built;
	}
}

/**
 * Refreshes a Goal's index in the background once its Wiki has changed. A request that arrives while a
 * refresh runs stops that refresh after its current batch and restarts it on the newest pages, so a burst
 * of publications embeds only the final content. Failures back off and retry; search keeps serving every
 * page whose vectors still match.
 */
export function scheduleWikiIndexRefresh(
	goalDir: string,
	options: { immediate?: boolean; embedding?: EmbeddingRuntimeFactory } = {},
): Promise<void> {
	const key = resolve(goalDir);
	const state = refreshes.get(key) ?? { superseded: false, failures: 0, retryAt: 0 };
	refreshes.set(key, state);
	if (state.running) {
		state.superseded = true;
		return state.running;
	}
	if (!options.immediate && Date.now() < state.retryAt) return Promise.resolve();
	clearTimeout(state.timer);
	const knowledgeRoot = join(key, "wiki", "knowledge");
	state.running = (async () => {
		do {
			state.superseded = false;
			if (!existsSync(knowledgeRoot)) return;
			try {
				await new GoalWikiSearch(knowledgeRoot, { goalDir: key, ...(options.embedding ? { embedding: options.embedding } : {}) })
					.refreshEmbeddings(undefined, undefined, () => state.superseded);
				state.failures = 0;
				state.retryAt = 0;
				delete state.error;
			} catch (error) {
				state.failures += 1;
				const delay = Math.min(REFRESH_RETRY_BASE_MS * 2 ** (state.failures - 1), REFRESH_RETRY_MAX_MS);
				state.retryAt = Date.now() + delay;
				state.error = toErrorMessage(error);
				state.timer = setTimeout(() => void scheduleWikiIndexRefresh(key, options.embedding ? { embedding: options.embedding } : {}), delay);
				state.timer.unref();
				console.warn(`[wiki-index] refresh failed; retrying in ${Math.round(delay / 1000)}s:`, error);
				return;
			}
		} while (state.superseded);
	})().finally(() => {
		state.running = undefined;
	});
	return state.running;
}

/** Builds the in-memory table a search runs against: every chunk's text, full-text indexed, plus cached vectors by content hash. */
async function buildSearchTable(name: string, pages: PreparedPages, cache?: lancedb.Table): Promise<SearchTable> {
	const hashes = [...new Set([...pages.values()].map((page) => page.sha256))];
	const cached = cache && hashes.length > 0
		? await cache.query().where(`page_hash IN (${hashes.map(sqlString).join(", ")})`)
			.select(["page_hash", "chunk_index", "vector"]).toArray() as Array<{ page_hash: string; chunk_index: number; vector: Iterable<number> }>
		: [];
	const vectors = new Map(cached.map((row) => [`${row.page_hash}\0${row.chunk_index}`, Array.from(row.vector)]));
	const dimensions = vectors.values().next().value?.length;
	const vectorPages = new Set<string>();
	const rows = [...pages].flatMap(([id, page]) => {
		const chunkVectors = page.chunks.map((chunk) => vectors.get(`${page.sha256}\0${chunk.index}`) ?? null);
		if (chunkVectors.every((vector) => vector)) vectorPages.add(id);
		return page.chunks.map((chunk, index) => ({
			page_id: id,
			chunk_text: chunk.text,
			search_text: chunk.embeddingText,
			...(dimensions ? { vector: chunkVectors[index] } : {}),
		}));
	});
	if (rows.length === 0) return { vectorPages };
	const schema = new arrow.Schema([
		new arrow.Field("page_id", new arrow.Utf8(), false),
		new arrow.Field("chunk_text", new arrow.Utf8(), false),
		new arrow.Field("search_text", new arrow.Utf8(), false),
		...(dimensions ? [new arrow.Field("vector", new arrow.FixedSizeList(dimensions, new arrow.Field("item", new arrow.Float32(), true)), true)] : []),
	]);
	const db = await (searchDatabase ??= lancedb.connect("memory://"));
	const table = await db.createTable(name, lancedb.makeArrowTable(rows, { schema }), { mode: "overwrite" });
	await table.createIndex("search_text", { config: lancedb.Index.fts({ baseTokenizer: "icu" }) });
	return { name, table, vectorPages };
}

function rrfReranker(): Promise<lancedb.rerankers.RRFReranker> {
	return reciprocalRankReranker ??= lancedb.rerankers.RRFReranker.create();
}

function chunkNode(node: WikiNode): Array<{ index: number; heading: string; text: string; embeddingText: string }> {
	const chunks: Array<{ heading: string; text: string }> = [];
	let heading = node.title;
	let buffer = "";
	const flush = () => {
		const text = buffer.trim();
		if (text) chunks.push({ heading, text });
		buffer = buffer.slice(Math.max(0, buffer.length - CHUNK_OVERLAP_CHARS));
	};
	for (const line of node.body.split("\n")) {
		const nextHeading = /^#{1,6}\s+(.+)$/u.exec(line)?.[1]?.trim();
		if (nextHeading && buffer.trim()) flush();
		if (nextHeading) heading = nextHeading;
		let remaining = line;
		do {
			const available = Math.max(1, CHUNK_TARGET_CHARS - buffer.length - 1);
			buffer += remaining.slice(0, available);
			remaining = remaining.slice(available);
			if (remaining.length > 0) flush();
		} while (remaining.length > 0);
		buffer += "\n";
	}
	if (buffer.trim()) chunks.push({ heading, text: buffer.trim() });
	if (chunks.length === 0) chunks.push({ heading: node.title, text: node.description || node.title });
	return chunks.map((chunk, index) => ({
		index,
		...chunk,
		embeddingText: `${node.title}\n${chunk.heading}\n${chunk.text}`,
	}));
}

function graphQuota(limit: number, vectorHits: number): number {
	if (limit < 2) return 0;
	const coverage = Math.min(vectorHits, limit) / limit;
	return Math.max(1, Math.min(limit - 1, Math.ceil(limit * (0.3 - 0.15 * coverage))));
}

/** Pages linked to the top ranked pages but not ranked themselves, weighted by how highly their neighbors ranked. */
function expandGraph(graph: WikiGraph, ranked: readonly string[], limit: number): Array<{ id: string; relatedTo: string[] }> {
	if (limit === 0 || ranked.length === 0) return [];
	const rankedIds = new Set(ranked);
	const candidates = new Map<string, { weight: number; relatedTo: Set<string> }>();
	for (const [rank, seed] of ranked.slice(0, 10).entries()) {
		for (const edge of graph.edges) {
			const neighbor = edge.source === seed ? edge.target : edge.target === seed ? edge.source : undefined;
			if (!neighbor || rankedIds.has(neighbor)) continue;
			const candidate = candidates.get(neighbor) ?? { weight: 0, relatedTo: new Set<string>() };
			candidate.weight += 1 / (rank + 1);
			candidate.relatedTo.add(seed);
			candidates.set(neighbor, candidate);
		}
	}
	return [...candidates]
		.sort((left, right) => right[1].weight - left[1].weight || left[0].localeCompare(right[0]))
		.slice(0, limit)
		.map(([id, value]) => ({ id, relatedTo: [...value.relatedTo].map((seed) => `wiki/${seed}.md`) }));
}

function knowledgeContext(node: WikiNode) {
	return {
		outgoingLinks: node.links.map((id) => `wiki/${id}.md`),
		backlinks: node.backlinks.map((id) => `wiki/${id}.md`),
		linkCount: node.links.length + node.backlinks.length,
	};
}

type PreparedPages = ReadonlyMap<string, { sha256: string; chunks: ReturnType<typeof chunkNode> }>;

/** Frontmatter such as Topic membership is not part of the hash: it does not change what a page embeds. */
function pageHash(node: WikiNode): string {
	return sha256(`${node.title}\n${node.description}\n${node.body}`);
}

function prepareNodes(nodes: readonly WikiNode[]): PreparedPages {
	return new Map(nodes.map((node) => [node.id, { sha256: pageHash(node), chunks: chunkNode(node) }]));
}

/** Each model identity owns one table, so a replacement builds beside the index that keeps serving. */
function tableName(identity: string): string {
	return `chunks_${sha256(identity).slice(0, 16)}`;
}

async function tableIdentity(db: lancedb.Connection, name: string): Promise<string> {
	const [row] = await (await db.openTable(name)).query().select(["model"]).limit(1).toArray() as Array<{ model: string }>;
	return row?.model ?? "";
}

async function tableFor(db: lancedb.Connection, identity: string): Promise<lancedb.Table | undefined> {
	const names = await db.tableNames();
	if (names.includes(tableName(identity))) return db.openTable(tableName(identity));
	return undefined;
}

async function openIndexTable(indexPath: string, identity: string): Promise<lancedb.Table | undefined> {
	return existsSync(indexPath) ? tableFor(await lancedb.connect(indexPath), identity) : undefined;
}

/** Pages the table no longer needs, and the chunks of pages it lacks or holds at another content hash. */
async function indexDelta(table: lancedb.Table | undefined, pages: PreparedPages) {
	const indexed = table
		? await table.query().select(["page_id", "page_hash"]).toArray() as Array<{ page_id: string; page_hash: string }>
		: [];
	const indexedHashes = new Map(indexed.map((row) => [row.page_id, row.page_hash]));
	const removed = [...indexedHashes.keys()].filter((id) => !pages.has(id));
	const changed = [...pages].filter(([id, page]) => indexedHashes.get(id) !== page.sha256);
	return { removed, pending: changed.flatMap(([id, page]) => page.chunks.map((chunk) => ({ id, pageHash: page.sha256, chunk }))) };
}

async function synchronizeLanceIndex(
	indexPath: string,
	pages: PreparedPages,
	runtime: WikiEmbeddingRuntime,
	signal?: AbortSignal,
	onProgress?: (added: number) => void,
	superseded?: () => boolean,
): Promise<void> {
	const db = await lancedb.connect(indexPath);
	let table = await tableFor(db, runtime.identity);
	const { removed, pending } = await indexDelta(table, pages);
	for (const id of removed) {
		if (table) await table.delete(`page_id = ${sqlString(id)}`);
	}
	const remaining = new Map<string, number>();
	for (const item of pending) remaining.set(item.id, (remaining.get(item.id) ?? 0) + 1);
	let held: IndexedChunk[] = [];
	for (let offset = 0; offset < pending.length; offset += EMBEDDING_BATCH_SIZE) {
		signal?.throwIfAborted();
		if (superseded?.()) return;
		const batch = pending.slice(offset, offset + EMBEDDING_BATCH_SIZE);
		const vectors = await embedTexts(runtime, batch.map((item) => item.chunk.embeddingText), "search_document", signal);
		for (const [index, item] of batch.entries()) {
			held.push({
				page_id: item.id,
				page_hash: item.pageHash,
				model: runtime.identity,
				chunk_index: item.chunk.index,
				chunk_text: item.chunk.text,
				heading_path: item.chunk.heading,
				vector: vectors[index]!,
			});
			remaining.set(item.id, remaining.get(item.id)! - 1);
		}
		// Only whole pages land, so an interrupted refresh resumes at page granularity instead of trusting a partial page.
		// A changed page keeps its previous vectors until then, which readers of older snapshots still match.
		const complete = held.filter((record) => remaining.get(record.page_id) === 0);
		if (complete.length > 0) {
			if (table) {
				for (const id of new Set(complete.map((record) => record.page_id))) await table.delete(`page_id = ${sqlString(id)}`);
				await table.add(complete);
			} else {
				table = await db.createTable(tableName(runtime.identity), lancedb.makeArrowTable(complete));
			}
			held = held.filter((record) => remaining.get(record.page_id) !== 0);
		}
		onProgress?.(batch.length);
	}
}

/** Keyed per index and identity: a replacement builds its own table without blocking searches on the serving one. */
async function withIndexLock(path: string, action: () => Promise<void>): Promise<void> {
	const previous = indexWrites.get(path) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(action);
	indexWrites.set(path, current);
	try {
		await current;
	} finally {
		if (indexWrites.get(path) === current) indexWrites.delete(path);
	}
}

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function summary(node: WikiNode) {
	return {
		id: node.id,
		label: node.title,
		type: node.type,
		path: `wiki/${node.id}.md`,
		outgoingLinks: node.links.map((id) => `wiki/${id}.md`),
		backlinks: node.backlinks.map((id) => `wiki/${id}.md`),
		linkCount: node.links.length + node.backlinks.length,
	};
}
