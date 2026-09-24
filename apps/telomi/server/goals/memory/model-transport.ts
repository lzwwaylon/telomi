import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { observeModelOutcome } from "../../agent-runtime/model-config/model-verdicts.js";
import { MEMORY_API_PATHS, memoryClientProvider, memoryConnection, MEMORY_ROLES, type ResolvedMemoryModels } from "./model-settings.js";

/** Hindsight keeps its clients; only authorization is resolved again for each outgoing request. */
export class MemoryModelTransport {
	private server?: Server;
	private origin = "";
	private readonly generations = new Map<string, ResolvedMemoryModels>();
	readonly token = randomUUID();

	async register(models: ResolvedMemoryModels): Promise<{ id: string; env: NodeJS.ProcessEnv }> {
		if (!this.server) {
			this.server = createServer((request, response) => {
				const abort = new AbortController();
				response.once("close", () => { if (!response.writableFinished) abort.abort(); });
				void (async () => {
					if (request.headers.authorization !== `Bearer ${this.token}` && request.headers["api-key"] !== this.token && request.headers["x-api-key"] !== this.token) {
						response.writeHead(401).end(); return;
					}
					const match = /^\/([^/]+)\/(llm|retain|reflect|consolidation)\/(chat\/completions|v1\/messages|responses)$/u.exec(request.url ?? "");
					const config = match && this.generations.get(match[1]);
					if (!match || !config || request.method !== "POST") { response.writeHead(404).end(); return; }
					const selection = config[match[2] as typeof MEMORY_ROLES[number]].model;
					if (!selection) throw new Error("Missing Memory model");
					const chunks: Buffer[] = [];
					let bytes = 0;
					for await (const chunk of request) {
						bytes += chunk.length;
						if (bytes > 64 * 1024 * 1024) { response.writeHead(413).end(); return; }
						chunks.push(Buffer.from(chunk));
					}
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
					const { model, headers, assertCurrent } = await memoryConnection(selection);
					// Hindsight picked its client when this generation started; a later API change needs a new generation.
					if (MEMORY_API_PATHS[model.api] !== match[3]) {
						response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: `Memory connection now uses ${model.api}; apply Memory settings again` }));
						return;
					}
					for (const name of ["anthropic-version", "anthropic-beta"]) {
						const value = request.headers[name];
						if (typeof value === "string" && !(name in headers)) headers[name] = value;
					}
					body.model = model.id;
					assertCurrent();
					const upstream = await fetch(`${model.baseUrl.replace(/\/+$/u, "")}/${match[3]}`, {
						method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: abort.signal,
					});
					if (!upstream.ok) {
						// The Provider's own explanation reaches the inbox; Hindsight still gets only the status.
						const detail = (await upstream.text().catch(() => "")).slice(0, 2_000);
						observeModelOutcome(selection, `${upstream.status}: ${detail || "status code (no body)"}`);
						response.writeHead(upstream.status, { "content-type": "application/json" }).end(JSON.stringify({ error: `Memory upstream returned HTTP ${upstream.status}` }));
						return;
					}
					observeModelOutcome(selection);
					response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
					if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>), response);
					else response.end();
				})().catch(() => { if (!response.headersSent) response.writeHead(502); response.end('{"error":"Memory connection request failed"}'); });
			});
			await new Promise<void>((resolve, reject) => {
				this.server!.once("error", reject);
				this.server!.listen(0, "127.0.0.1", resolve);
			});
			const address = this.server.address();
			if (!address || typeof address === "string") throw new Error("Memory transport did not bind");
			this.origin = `http://127.0.0.1:${address.port}`;
		}
		const id = randomUUID();
		this.generations.set(id, models);
		const env: NodeJS.ProcessEnv = {};
		for (const role of MEMORY_ROLES) {
			const prefix = `HINDSIGHT_API_${role === "llm" ? "" : `${role.toUpperCase()}_`}LLM_`;
			env[`${prefix}PROVIDER`] = await memoryClientProvider(models[role].model!);
			env[`${prefix}MODEL`] = models[role].model!.slice(models[role].model!.indexOf("/") + 1);
			env[`${prefix}BASE_URL`] = `${this.origin}/${id}/${role}`;
			env[`${prefix}API_KEY`] = this.token;
			env[`${prefix}REASONING_EFFORT`] = models[role].reasoningEffort === "off" ? "none" : models[role].reasoningEffort;
		}
		return { id, env };
	}

	retainOnly(id?: string): void {
		for (const key of this.generations.keys()) if (key !== id) this.generations.delete(key);
	}

	async close(): Promise<void> {
		if (this.server) await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
		this.server = undefined;
		this.generations.clear();
	}
}
