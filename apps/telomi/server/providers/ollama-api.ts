import type { Express, Request, Response } from "express";
import type { ConnectionCapability } from "../../shared/connections.js";
import { toErrorMessage } from "../lib/values.js";
import { OLLAMA_EMBEDDING_SUGGESTIONS } from "../../shared/ollama.js";
export { looksLikeOllama } from "../../shared/ollama.js";

/**
 * Ollama as a local model source. Its OpenAI-compatible listing says nothing about what a model
 * does, so discovery reads the native API: `/api/tags` for what is installed and `/api/show` for
 * each model's capabilities. Pulling a model is a long download the page watches as a job.
 */

export interface OllamaModel {
	id: string;
	capabilities: ConnectionCapability[];
	/** Bytes on disk, as Ollama reports them. */
	size: number;
	family?: string;
}

export interface OllamaPullJob {
	status: "pulling" | "done" | "failed";
	/** Ollama's own phase line, e.g. "pulling manifest" or "verifying sha256 digest". */
	detail: string;
	completed: number;
	total: number;
	error?: string;
}

const MODEL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;

/** The native API root: the connection's base URL without an OpenAI `/v1` suffix. */
export function ollamaRoot(baseUrl: string): string {
	const url = new URL(baseUrl.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Ollama address must be an http(s) URL");
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/+$/u, "");
}

async function parseOllamaResponse<T>(response: globalThis.Response, what: string): Promise<T> {
	if (!response.ok) throw new Error(`Ollama ${what} answered HTTP ${response.status}`);
	return await response.json() as T;
}

export async function listOllamaModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<OllamaModel[]> {
	const root = ollamaRoot(baseUrl);
	const tags = await parseOllamaResponse<{ models?: Array<{ name?: string; size?: number; details?: { family?: string } }> }>(
		await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(10_000) }), "listing");
	const installed = (tags.models ?? []).filter((model): model is { name: string; size?: number; details?: { family?: string } } => typeof model.name === "string");
	return Promise.all(installed.map(async (model) => {
		const shown = await parseOllamaResponse<{ capabilities?: string[] }>(
			await fetchImpl(`${root}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: model.name }), signal: AbortSignal.timeout(10_000) }),
			`show ${model.name}`).catch(() => ({ capabilities: [] as string[] }));
		const native = shown.capabilities ?? [];
		const capabilities: ConnectionCapability[] = native.includes("embedding") ? ["embedding"] : native.includes("completion") ? ["chat"] : [];
		return { id: model.name, capabilities, size: model.size ?? 0, ...(model.details?.family ? { family: model.details.family } : {}) };
	}));
}

/** One watcher per model per server; asking again while a pull runs joins the running one. */
const pulls = new Map<string, OllamaPullJob>();

export function pullJobKey(baseUrl: string, model: string): string {
	return `${ollamaRoot(baseUrl)}#${model}`;
}

export function pullJob(key: string): OllamaPullJob | undefined {
	return pulls.get(key);
}

export function startOllamaPull(baseUrl: string, model: string, fetchImpl: typeof fetch = fetch): string {
	if (!MODEL_NAME.test(model)) throw new Error("invalid Ollama model name");
	const key = pullJobKey(baseUrl, model);
	if (pulls.get(key)?.status === "pulling") return key;
	const job: OllamaPullJob = { status: "pulling", detail: "starting", completed: 0, total: 0 };
	pulls.set(key, job);
	void (async () => {
		try {
			const response = await fetchImpl(`${ollamaRoot(baseUrl)}/api/pull`, {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: true }),
			});
			if (!response.ok || !response.body) throw new Error(`Ollama pull answered HTTP ${response.status}`);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffered = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true });
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					const event = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
					if (event.error) throw new Error(event.error);
					if (event.status) job.detail = event.status;
					if (typeof event.total === "number") { job.total = event.total; job.completed = event.completed ?? 0; }
				}
			}
			job.status = "done";
			job.detail = "success";
			job.completed = job.total;
		} catch (error) {
			job.status = "failed";
			job.error = toErrorMessage(error);
		}
	})();
	return key;
}

export interface OllamaLibraryModel {
	name: string;
	description: string;
	/** Parameter-size tags the library offers, e.g. `0.6b`; pulled as `name:size`. */
	sizes: string[];
}

const LIBRARY_URL = "https://ollama.com/search";
const LIBRARY_TTL_MS = 60 * 60 * 1000;
const CAPABILITY_CHIPS = new Set(["embedding", "vision", "tools", "thinking", "cloud", "audio"]);
const library = new Map<ConnectionCapability, { at: number; models: OllamaLibraryModel[] }>();

/** ollama.com has no JSON catalog; its search page lists what can be pulled, with a category filter for embeddings. */
export function parseOllamaLibrary(html: string, capability: ConnectionCapability): OllamaLibraryModel[] {
	const models: OllamaLibraryModel[] = [];
	for (const block of html.split(/<li\b/u).slice(1)) {
		const name = /href="\/library\/([^"/]+)"/u.exec(block)?.[1];
		if (!name) continue;
		const description = /<p class="max-w-lg[^"]*">([^<]*)<\/p>/u.exec(block)?.[1]?.trim() ?? "";
		const chips = [...block.matchAll(/<span\s+class="inline-flex[^"]*text-xs[^"]*">([^<]+)<\/span>/gu)].map((match) => match[1]!.trim().toLowerCase());
		const isEmbedding = chips.includes("embedding");
		if (capability === "embedding" ? !isEmbedding : isEmbedding) continue;
		models.push({ name, description, sizes: chips.filter((chip) => !CAPABILITY_CHIPS.has(chip) && /^\d+(?:\.\d+)?[bm]$/u.test(chip)) });
	}
	return models;
}

/**
 * What ollama.com offers for a capability, cached for an hour. Offline, a short built-in list
 * keeps the download field useful.
 */
export async function ollamaLibrary(capability: ConnectionCapability, fetchImpl: typeof fetch = fetch): Promise<OllamaLibraryModel[]> {
	const cached = library.get(capability);
	if (cached && Date.now() - cached.at < LIBRARY_TTL_MS) return cached.models;
	try {
		const url = capability === "embedding" ? `${LIBRARY_URL}?c=embedding` : LIBRARY_URL;
		const html = await (await fetchImpl(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(10_000) })).text();
		const models = parseOllamaLibrary(html, capability);
		if (models.length === 0) throw new Error("ollama.com listed nothing");
		library.set(capability, { at: Date.now(), models });
		return models;
	} catch {
		return cached?.models ?? (capability === "embedding" ? OLLAMA_EMBEDDING_SUGGESTIONS.map((name) => ({ name: name.split(":")[0]!, description: "", sizes: [] })) : []);
	}
}

export function mountOllamaApi(app: Express, fetchImpl: typeof fetch = fetch): void {
	app.get("/api/ollama/library", async (req: Request, res: Response) => {
		const capability = req.query.capability === "chat" ? "chat" : "embedding";
		res.json({ models: await ollamaLibrary(capability, fetchImpl) });
	});
	app.post("/api/ollama/models", async (req: Request, res: Response) => {
		const baseUrl = typeof req.body?.baseUrl === "string" ? req.body.baseUrl : "";
		try {
			res.json({ models: await listOllamaModels(baseUrl, fetchImpl) });
		} catch (error) {
			res.status(502).json({ error: toErrorMessage(error) });
		}
	});
	app.post("/api/ollama/pull", (req: Request, res: Response) => {
		const baseUrl = typeof req.body?.baseUrl === "string" ? req.body.baseUrl : "";
		const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
		try {
			const key = startOllamaPull(baseUrl, model, fetchImpl);
			res.json({ job: key, ...pulls.get(key) });
		} catch (error) {
			res.status(400).json({ error: toErrorMessage(error) });
		}
	});
	app.get("/api/ollama/pull", (req: Request, res: Response) => {
		const job = typeof req.query.job === "string" ? pulls.get(req.query.job) : undefined;
		if (!job) { res.status(404).json({ error: "unknown pull" }); return; }
		res.json({ job: req.query.job, ...job });
	});
}
