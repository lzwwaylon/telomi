import { existsSync, rmSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Express } from "express";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { EMBEDDING_CONSUMERS, HINDSIGHT_LOCAL_CONNECTION, type EmbeddingConfiguration, type EmbeddingConsumer, type EmbeddingConsumerStatus, type EmbeddingEstimate, type EmbeddingProgress, type EmbeddingResponse, type EmbeddingSelection } from "../../shared/embedding-configuration.js";
import { loadSettings, saveSettings } from "../config/settings.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { readStoredCredentials } from "../accounts/stored-credentials.js";
import { anonymousConnectionApiKey, loadCustomProviders } from "../providers/custom-models.js";
import { builtinConnectionEntry, connectionApiKey } from "../providers/builtin-connections.js";
import { readJson, writeJsonAtomic } from "../lib/fs.js";
import { embedTexts, embeddingIdentity } from "./client.js";
import { estimateWikiWork, pruneWikiIndexes, rebuildWikiIndexes, type WikiEmbeddingRuntime } from "./wiki-migration.js";

const consumerIds = EMBEDDING_CONSUMERS;
// The model the User Memory service can run itself, offered as a choice for Memory, never preselected.
// Multilingual on purpose: memories are written in the user's language, and an English-only
// model ranked unrelated Chinese facts above the user's own stated preferences. 384 dimensions,
// no query prefix, about 50 languages, runs locally without any external service.
export const DEFAULT_MEMORY_LOCAL_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
const PGVECTOR_INDEX_LIMIT = 2000;

export interface EmbeddingExecution extends EmbeddingSelection { baseUrl: string; source: "default" | "override" }

function endpoint(value: string): string {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid embedding connection endpoint");
	return url.toString().replace(/\/+$/u, "");
}

/** The embeddings endpoint a connection serves from; empty for local or unknown connections. */
export function embeddingEndpointFor(connection: string): string {
	if (connection === HINDSIGHT_LOCAL_CONNECTION) return "";
	const entry = loadCustomProviders().providers?.[connection];
	if (entry) { try { return endpoint(entry.baseUrl); } catch { return ""; } }
	return builtinConnectionEntry(connection)?.baseUrl ?? "";
}

/** What the user selected; nothing is chosen on their behalf. */
export function activeEmbedding(settings = loadSettings()): EmbeddingConfiguration {
	return settings.embedding ?? {};
}

/** The model an index embeds with, or `undefined` while the user has not chosen one. */
export function resolveEmbedding(consumer: EmbeddingConsumer, config?: EmbeddingConfiguration): EmbeddingExecution | undefined {
	config ??= activeEmbedding();
	const selected = config[consumer] ?? config.default;
	return selected && { ...selected, baseUrl: embeddingEndpointFor(selected.connection), source: config[consumer] ? "override" : "default" };
}

/** The connection's API key, honoring credential deletion. Audio-only connections cannot embed. */
export async function embeddingApiKey(connection: string): Promise<string> {
	if (isProviderCredentialDeleted(connection)) throw new Error(`Embedding connection '${connection}' credential was deleted`);
	const entry = loadCustomProviders().providers?.[connection];
	if (entry?.capability && entry.capability !== "embedding") throw new Error("Audio service connections cannot embed");
	const credentials = readStoredCredentials(resolveAgentPath("auth.json"));
	const stored = connectionApiKey(connection, credentials);
	if (credentials[connection] && !stored) throw new Error("Embedding connections require API key authentication");
	if (stored) return stored;
	const runtime = await ModelRuntime.create({ authPath: resolveAgentPath("auth.json"), modelsPath: resolveAgentPath("models.json") });
	const auth = await runtime.getAuth(connection).catch(() => undefined);
	const key = auth?.auth.apiKey || entry?.apiKey || anonymousConnectionApiKey(connection);
	if (!key) throw new Error(`Embedding connection '${connection}' has no API key`);
	return key;
}

function readState(): MigrationState | undefined {
	const path = resolveAgentPath("embedding-migration.json");
	return existsSync(path) ? readJson<MigrationState>(path) : undefined;
}
function writeState(state: MigrationState | undefined): void {
	const path = resolveAgentPath("embedding-migration.json");
	if (state) writeJsonAtomic(path, state); else rmSync(path, { force: true });
}

interface MigrationState {
	from: EmbeddingConfiguration;
	target: EmbeddingConfiguration;
	startedAt: string;
	consumers: Partial<Record<EmbeddingConsumer, { status: "rebuilding" | "failed"; progress?: EmbeddingProgress; estimate?: EmbeddingEstimate; error?: string }>>;
}

/** The Wiki index runtime for a selection; `undefined` degrades search to keyword and graph as before. */
export async function wikiEmbeddingRuntime(selection?: EmbeddingExecution, fetchImpl?: typeof fetch): Promise<WikiEmbeddingRuntime | undefined> {
	const selected = selection ?? resolveEmbedding("wiki");
	if (!selected?.baseUrl) return undefined;
	let apiKey: string;
	try { apiKey = await embeddingApiKey(selected.connection); } catch { return undefined; }
	return { identity: embeddingIdentity(selected), connection: selected.connection, model: selected.model, dimensions: selected.dimensions, baseUrl: selected.baseUrl, apiKey, fetchImpl };
}

export interface MemoryEmbeddingMigrator {
	estimate(target: EmbeddingExecution): Promise<EmbeddingEstimate>;
	/** Builds replacement vectors while the current service keeps serving; resumable. */
	prepare(target: EmbeddingExecution, onProgress: (progress: EmbeddingProgress) => void, signal: AbortSignal): Promise<void>;
	/** Drains the service, swaps vectors, then runs `commit` before restarting with the target selection. */
	cutover(target: EmbeddingExecution, commit: () => void): Promise<void>;
	abort(target: EmbeddingExecution): Promise<void>;
}
export interface EmbeddingApiDependencies {
	wikiGoalDirs: () => string[];
	memory?: MemoryEmbeddingMigrator;
	fetchImpl?: typeof fetch;
}

let phase: EmbeddingResponse["status"] = "active";
let failure: string | undefined;
let job: { controller: AbortController; done: Promise<void> } | undefined;
let dependencies: EmbeddingApiDependencies | undefined;

function parse(value: unknown): EmbeddingConfiguration {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid embedding configuration");
	const body = value as Record<string, unknown>;
	const selection = (raw: unknown): EmbeddingSelection => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid embedding selection");
		const item = raw as Record<string, unknown>;
		if (typeof item.connection !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/u.test(item.connection) || typeof item.model !== "string" || !item.model.trim() || item.model.length > 300) throw new Error("Invalid embedding selection");
		const result: EmbeddingSelection = { connection: item.connection, model: item.model.trim() };
		if (item.dimensions != null && item.dimensions !== "") {
			if (typeof item.dimensions !== "number" || !Number.isInteger(item.dimensions) || item.dimensions < 1 || item.dimensions > 4096) throw new Error("Embedding dimensions must be an integer from 1 to 4096");
			result.dimensions = item.dimensions;
		}
		return result;
	};
	const result: EmbeddingConfiguration = {};
	if (body.default != null) result.default = selection(body.default);
	for (const id of consumerIds) if (body[id] != null) result[id] = selection(body[id]);
	return result;
}

function changedConsumers(draft: EmbeddingConfiguration, active: EmbeddingConfiguration): EmbeddingConsumer[] {
	return consumerIds.filter((id) => !isDeepStrictEqual(draft[id] ?? draft.default, active[id] ?? active.default));
}

async function validate(draft: EmbeddingConfiguration, active: EmbeddingConfiguration, fetchImpl?: typeof fetch): Promise<void> {
	for (const id of changedConsumers(draft, active)) {
		const selected = resolveEmbedding(id, draft);
		if (!selected) throw new Error(`${id}: choose an embedding model`);
		if (id === "wiki" && selected.connection === HINDSIGHT_LOCAL_CONNECTION) throw new Error("wiki: the User Memory local model cannot serve Wiki search; select a connection");
		if (id === "memory" && selected.dimensions && selected.dimensions > PGVECTOR_INDEX_LIMIT) throw new Error(`memory: embedding dimensions above ${PGVECTOR_INDEX_LIMIT} exceed the memory index limit`);
		if (selected.connection === HINDSIGHT_LOCAL_CONNECTION) continue;
		if (!selected.baseUrl) throw new Error(`${id}: embedding connection '${selected.connection}' is unknown`);
		const apiKey = await embeddingApiKey(selected.connection).catch((error: Error) => { throw new Error(`${id}: ${error.message}`); });
		const [vector] = await embedTexts({ baseUrl: selected.baseUrl, apiKey, connection: selected.connection, model: selected.model, dimensions: selected.dimensions, fetchImpl }, ["connection check"], "search_query", AbortSignal.timeout(45_000))
			.catch((error: Error) => { throw new Error(`${id}: Embedding connection validation failed (${error.message})`); });
		if (id === "memory" && vector!.length > PGVECTOR_INDEX_LIMIT) throw new Error(`memory: the model returns ${vector!.length} dimensions, above the memory index limit of ${PGVECTOR_INDEX_LIMIT}`);
	}
}

function update(id: EmbeddingConsumer, patch: Partial<NonNullable<MigrationState["consumers"][EmbeddingConsumer]>>): void {
	const state = readState();
	if (!state?.consumers[id]) return;
	state.consumers[id] = { ...state.consumers[id]!, ...patch };
	writeState(state);
}

function commit(state: MigrationState): void {
	const current = loadSettings();
	if (!isDeepStrictEqual(activeEmbedding(current), state.from)) throw new Error("Embedding settings changed during the rebuild; it was not activated");
	current.embedding = state.target;
	if (isDeepStrictEqual(current.pendingEmbedding, state.target)) delete current.pendingEmbedding;
	saveSettings(current);
}

async function runMigration(state: MigrationState, deps: EmbeddingApiDependencies, signal: AbortSignal): Promise<void> {
	const wikiTarget = state.consumers.wiki ? resolveEmbedding("wiki", state.target) : undefined;
	const memoryTarget = state.consumers.memory ? resolveEmbedding("memory", state.target) : undefined;
	let memoryPrepared = false; // prepare was attempted; a partial shadow column must be dropped on failure
	let failed: EmbeddingConsumer = "wiki";
	try {
		let wikiRuntime: WikiEmbeddingRuntime | undefined;
		if (wikiTarget) {
			wikiRuntime = await wikiEmbeddingRuntime(wikiTarget, deps.fetchImpl);
			if (!wikiRuntime) throw new Error("embedding connection unavailable");
			update("wiki", { estimate: await estimateWikiWork(deps.wikiGoalDirs(), wikiRuntime) });
			await rebuildWikiIndexes(deps.wikiGoalDirs(), wikiRuntime, (progress) => update("wiki", { progress }), signal);
		}
		if (memoryTarget) {
			failed = "memory";
			if (!deps.memory) throw new Error("User Memory migration is unavailable in this process");
			update("memory", { estimate: await deps.memory.estimate(memoryTarget) });
			memoryPrepared = true;
			await deps.memory.prepare(memoryTarget, (progress) => update("memory", { progress }), signal);
		}
		signal.throwIfAborted();
		// Pages published during the rebuild join the replacement index before it serves.
		if (wikiRuntime) { failed = "wiki"; await rebuildWikiIndexes(deps.wikiGoalDirs(), wikiRuntime, (progress) => update("wiki", { progress }), signal); }
		if (memoryTarget) { failed = "memory"; await deps.memory!.cutover(memoryTarget, () => commit(state)); }
		else commit(state);
		writeState(undefined);
		phase = "active"; failure = undefined;
		if (wikiRuntime) await pruneWikiIndexes(deps.wikiGoalDirs(), [wikiRuntime.identity]).catch(() => undefined);
	} catch (error) {
		if (signal.aborted) return;
		const message = error instanceof Error ? error.message : "Embedding rebuild failed";
		update(failed, { status: "failed", error: message });
		// Consumers still marked "rebuilding" would keep the page busy, reject the next apply with
		// 409 and restart the whole migration on the next launch, although nothing is running.
		for (const id of consumerIds) if (id !== failed && readState()?.consumers[id]?.status === "rebuilding") update(id, { status: "failed", error: `${failed} failed; this index was not rebuilt` });
		phase = "failed";
		failure = `${failed}: ${message}; previous embedding configuration remains active`;
		if (memoryPrepared && memoryTarget && !isDeepStrictEqual(loadSettings().embedding, state.target)) await deps.memory?.abort(memoryTarget).catch(() => undefined);
	}
}

function start(state: MigrationState, deps: EmbeddingApiDependencies): void {
	const controller = new AbortController();
	phase = "rebuilding"; failure = undefined;
	job = { controller, done: runMigration(state, deps, controller.signal).finally(() => { if (job?.controller === controller) job = undefined; }) };
}

/** Continue a rebuild interrupted by a restart: the old index kept serving, so resuming is safe. */
export function resumeEmbeddingMigration(deps: EmbeddingApiDependencies): void {
	dependencies = deps;
	const state = readState();
	if (!state || job) return;
	if (Object.values(state.consumers).some((consumer) => consumer.status === "rebuilding")) start(state, deps);
	else { phase = "failed"; failure = Object.entries(state.consumers).filter(([, consumer]) => consumer.status === "failed").map(([id, consumer]) => `${id}: ${consumer.error}`).join("; ") || undefined; }
}

export async function stopEmbeddingMigration(): Promise<void> {
	job?.controller.abort();
	await job?.done.catch(() => undefined);
}

/** Test hook: wait for the running rebuild to settle. */
export async function settleEmbeddingMigration(): Promise<void> { await job?.done; }

export async function describeEmbedding(): Promise<EmbeddingResponse> {
	const settings = loadSettings();
	const active = activeEmbedding(settings);
	const state = readState();
	const effective = {} as EmbeddingResponse["effective"];
	const sources = {} as EmbeddingResponse["sources"];
	const consumers: EmbeddingConsumerStatus[] = [];
	for (const id of consumerIds) {
		const serving = resolveEmbedding(id, active);
		const migration = state?.consumers[id];
		if (!serving) {
			effective[id] = null; sources[id] = null;
			consumers.push({ id, status: migration?.status ?? "unconfigured", serving: null, ...(migration?.progress ? { progress: migration.progress } : {}), ...(migration?.estimate ? { estimate: migration.estimate } : {}), ...(migration?.error ? { error: migration.error } : {}) });
			continue;
		}
		const { source, ...selection } = serving;
		effective[id] = selection; sources[id] = source;
		let status: EmbeddingConsumerStatus["status"] = migration ? migration.status : "active";
		if (!migration && serving.connection !== HINDSIGHT_LOCAL_CONNECTION) {
			if (!serving.baseUrl) status = "unavailable";
			else await embeddingApiKey(serving.connection).catch(() => { status = "unavailable"; });
		}
		consumers.push({ id, status, serving: { connection: serving.connection, model: serving.model, ...(serving.dimensions ? { dimensions: serving.dimensions } : {}) }, ...(migration?.progress ? { progress: migration.progress } : {}), ...(migration?.estimate ? { estimate: migration.estimate } : {}), ...(migration?.error ? { error: migration.error } : {}) });
	}
	return { active, pending: settings.pendingEmbedding ?? null, target: state?.target ?? null, effective, sources, consumers,
		status: phase === "active" ? settings.pendingEmbedding ? "saved" : "active" : phase, ...(failure ? { error: failure } : {}) };
}

export function mountEmbeddingApi(app: Express, deps: EmbeddingApiDependencies): void {
	dependencies = deps;
	app.get("/api/embedding-config", async (_req, res) => {
		try { res.json(await describeEmbedding()); } catch { res.status(500).json({ error: "Could not read embedding configuration" }); }
	});
	app.post("/api/embedding-config/pending", async (req, res) => {
		try {
			const settings = loadSettings();
			settings.pendingEmbedding = parse(req.body);
			saveSettings(settings);
			// A new draft supersedes an earlier failed rebuild report.
			if (phase === "failed") { phase = "active"; failure = undefined; writeState(undefined); }
			res.json(await describeEmbedding());
		}
		catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid embedding configuration" }); }
	});
	app.delete("/api/embedding-config/pending", async (_req, res) => {
		if (phase === "validating" || phase === "rebuilding") { res.status(409).json({ error: "Embedding configuration is already rebuilding" }); return; }
		const settings = loadSettings();
		delete settings.pendingEmbedding;
		saveSettings(settings);
		// Discarding the draft also dismisses the failed attempt that produced it.
		if (phase === "failed") { phase = "active"; failure = undefined; writeState(undefined); }
		res.json(await describeEmbedding());
	});
	app.post("/api/embedding-config/apply", async (req, res) => {
		if (phase === "validating" || phase === "rebuilding") { res.status(409).json({ error: "Embedding configuration is already rebuilding" }); return; }
		try {
			const before = loadSettings();
			const active = activeEmbedding(before);
			const draft = parse(req.body && Object.keys(req.body).length ? req.body : before.pendingEmbedding);
			// The draft stays saved until it is active, so a rejected or failed rebuild can be retried or discarded.
			before.pendingEmbedding = draft;
			saveSettings(before);
			phase = "validating"; failure = undefined;
			await validate(draft, active, deps.fetchImpl);
			const changed = changedConsumers(draft, active);
			if (!changed.length) {
				const current = loadSettings();
				current.embedding = draft;
				if (isDeepStrictEqual(current.pendingEmbedding, draft)) delete current.pendingEmbedding;
				saveSettings(current); writeState(undefined); phase = "active";
			} else {
				const state: MigrationState = { from: active, target: draft, startedAt: new Date().toISOString(), consumers: Object.fromEntries(changed.map((id) => [id, { status: "rebuilding" }])) };
				writeState(state);
				start(state, dependencies ?? deps);
			}
			res.json(await describeEmbedding());
		} catch (error) {
			phase = "failed";
			failure = `${error instanceof Error ? error.message : "Embedding validation failed"}; previous embedding configuration remains active`;
			res.status(422).json({ ...await describeEmbedding(), error: failure });
		}
	});
}
