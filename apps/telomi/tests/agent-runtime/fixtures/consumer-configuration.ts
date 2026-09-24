/**
 * Configuration API and a local upstream for production consumers of the native Prime transport.
 * Each test file that spawns real consumer Workers owns one harness; the files split by consumer
 * so their process boots run in parallel instead of one long sequence.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

export interface SeenRequest { model: string; reasoning_effort?: string; path: string; key: string }

export async function startConsumerConfiguration() {
	const root = mkdtempSync(join(tmpdir(), "telomi-consumer-config-"));
	const canonical = join(root, "canonical");
	mkdirSync(canonical);
	process.env.PI_CODING_AGENT_DIR = canonical;
	const seen: SeenRequest[] = [];
	const serverErrors: unknown[] = [];
	const control: { checkingConnection: boolean; replyOnce: boolean; duringRequest: (() => Promise<void>) | undefined } = {
		checkingConnection: false, replyOnce: false, duringRequest: undefined,
	};
	const upstream = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			const reply = () => {
				const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
					id: "probe", object: "chat.completion.chunk", created: 1, model: JSON.parse(body).model,
					choices: [{ index: 0, delta, finish_reason }],
				})}\n\n`;
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
			};
			if (control.checkingConnection) { reply(); return; }
			const successful = control.replyOnce;
			control.replyOnce = false;
			seen.push({ ...JSON.parse(body), path: req.url, key: req.headers.authorization });
			void (async () => {
				await control.duringRequest?.();
				if (successful) { reply(); return; }
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "controlled local transport stop", type: "invalid_request_error" } }));
			})().catch((error) => {
				serverErrors.push(error);
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "controlled local transport stop" } }));
			});
		});
	});
	await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
	const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
	writeFileSync(join(canonical, "auth.json"), "{}");
	const providerDefinition = {
		baseUrl: upstreamUrl, api: "openai-completions", apiKey: "local-test",
		models: ["first", "second", "child"].map((id) => ({ id, name: id, reasoning: true, contextWindow: 200000 })),
	};
	writeFileSync(join(canonical, "models.json"), JSON.stringify({ providers: { "consumer-test": providerDefinition } }));
	const { mountCustomProvidersApi } = await import("../../../server/providers/api.js");
	const { mountProviderConfigApi } = await import("../../../server/providers/config-api.js");
	const app = express();
	app.use(express.json());
	mountCustomProvidersApi(app);
	mountProviderConfigApi(app, { mainAgent: { describeMainAgentConfiguration: () => ({
		inheritedModel: "consumer-test/first", inheritedSource: "settings", inheritedThinkingLevel: "low",
		overrides: [], pendingGoalIds: [],
	}) } });
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((done) => server.once("listening", done));
	const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	async function configure(body: unknown) {
		const response = await fetch(`${api}/api/provider-config`, { method: "PATCH",
			headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal(response.status, 200, await response.text());
	}
	async function apply(model: string, thinking: string) {
		const response = await fetch(`${api}/api/provider-config/apply`, { method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ defaultProvider: "consumer-test", defaultModel: model, defaultThinkingLevel: thinking }) });
		assert.equal(response.status, 200, await response.text());
	}
	/** The status the configuration API reports for the primeRoot consumer. */
	async function primeRootStatus(): Promise<string> {
		const config = await (await fetch(`${api}/api/provider-config`)).json();
		return config.consumers.find((entry: { id: string }) => entry.id === "primeRoot").status;
	}
	/** Replaces the connection; the connectivity probe is answered without being recorded. */
	async function replaceConnection(definition: Record<string, unknown>) {
		control.checkingConnection = true;
		try {
			const response = await fetch(`${api}/api/custom-providers/consumer-test`, { method: "PUT",
				headers: { "content-type": "application/json" }, body: JSON.stringify({ ...providerDefinition, ...definition }) });
			assert.equal(response.status, 200, await response.text());
		} finally { control.checkingConnection = false; }
	}
	const env = { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: canonical,
		PRIME_AGENT_MODULE: new URL("./prime-consumer-transport.ts", import.meta.url).href };
	const selected = (cwd: string) => JSON.parse(readFileSync(join(root, cwd, "consumer-selection.json"), "utf8"));
	async function stopped(execute: () => Promise<unknown>, model: string, thinking: string, error = /controlled local transport stop/) {
		const before = seen.length;
		await assert.rejects(execute, error);
		if (serverErrors.length) throw serverErrors.shift();
		assert.ok(seen.length > before, "production consumer must reach native transport");
		assert.ok(seen.slice(before).every((request) => request.model === model && request.reasoning_effort === thinking));
	}
	async function close() {
		server.closeAllConnections(); upstream.closeAllConnections();
		await Promise.all([new Promise<void>((done) => server.close(() => done())), new Promise<void>((done) => upstream.close(() => done()))]);
		rmSync(root, { recursive: true, force: true });
	}
	return {
		root, api, env, seen, control, upstreamUrl, providerDefinition, signal: new AbortController().signal,
		configure, apply, primeRootStatus, replaceConnection, selected, stopped, close,
	};
}
