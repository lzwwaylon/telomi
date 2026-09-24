/**
 * A custom or local connection definition follows the same save-for-later and apply rules as every
 * other part of the configuration.
 *
 * The upstream here is a controlled endpoint, so the assertions are about observable behavior: a
 * prepared definition is invisible to the model list consumers resolve from, a rejected candidate
 * never reaches the active `models.json`, a keyless local endpoint is accepted, and applying makes
 * the definition selectable.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "telomi-custom-connection-"));
const agentDir = join(root, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
const modelsPath = join(agentDir, "models.json");
const pendingModelsPath = join(agentDir, "models-pending.json");
process.env.PI_CODING_AGENT_DIR = agentDir;

/** Accepts one key; the keyless endpoint ignores authorization, the way a local service does. */
const acceptedKey = "connection-key";
let duringValidation: (() => Promise<void>) | null = null;
const upstream = createServer((request, response) => {
	const authorization = request.headers.authorization ?? "";
	const keyless = request.url?.startsWith("/keyless") ?? false;
	request.resume();
	request.on("end", async () => {
		const hook = duringValidation;
		duringValidation = null;
		if (hook) await hook();
		const authorized = keyless || authorization === `Bearer ${acceptedKey}`;
		if (!authorized) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "connection refused the credential" } }));
			return;
		}
		const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
			id: "probe", object: "chat.completion.chunk", created: 1, model: "local-1",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(chunk({ role: "assistant", content: "OK" }, null));
		response.write(chunk({}, "stop"));
		response.write("data: [DONE]\n\n");
		response.end();
	});
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
const upstreamPort = (upstream.address() as AddressInfo).port;
const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
const keylessBaseUrl = `http://127.0.0.1:${upstreamPort}/keyless/v1`;

const { mountCustomProvidersApi } = await import("../../server/providers/api.js");
const { listSelectableModels } = await import("../../server/providers/config-api.js");

const app = express();
app.use(express.json());
mountCustomProvidersApi(app);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const port = (server.address() as AddressInfo).port;

interface ProviderSummary { id: string; baseUrl: string; hasApiKey: boolean; models: Array<{ id: string }> }
interface ProvidersResponse {
	error?: string;
	providers?: ProviderSummary[];
	pending?: ProviderSummary[];
	provider?: ProviderSummary;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: ProvidersResponse }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: response.status, json: await response.json() as ProvidersResponse };
}

const activeProviders = (): Record<string, unknown> => {
	if (!existsSync(modelsPath)) return {};
	return (JSON.parse(readFileSync(modelsPath, "utf8")) as { providers?: Record<string, unknown> }).providers ?? {};
};
const selectable = async (): Promise<string[]> =>
	(await listSelectableModels()).map((model) => `${model.provider}/${model.id}`);

try {
	// Save for later prepares the definition and leaves consumers on what they had.
	const prepared = await call("PUT", "/api/custom-providers/telomi-local", {
		mode: "pending",
		baseUrl,
		api: "openai-completions",
		apiKey: "wrong-key",
		models: [{ id: "local-1", name: "Local One" }],
	});
	assert.equal(prepared.status, 200);
	assert.deepEqual(Object.keys(activeProviders()), [], "a prepared connection is not active");
	assert.ok(existsSync(pendingModelsPath), "the prepared definition is stored apart from the active one");
	const listed = await call("GET", "/api/custom-providers");
	assert.deepEqual(listed.json.providers, []);
	assert.deepEqual(listed.json.pending?.map((entry) => entry.id), ["telomi-local"]);
	assert.ok(!(await selectable()).includes("telomi-local/local-1"), "consumers cannot resolve a prepared model");

	// The endpoint rejects the prepared credential, so nothing reaches the active definition. No
	// model was chosen for the probe, so the endpoint's listing is what refuses the credential.
	const rejected = await call("PUT", "/api/custom-providers/telomi-local", {});
	assert.equal(rejected.status, 422);
	assert.match(rejected.json.error ?? "", /rejected the credential/u);
	assert.deepEqual(Object.keys(activeProviders()), [], "a rejected connection is never activated");
	assert.deepEqual(
		(await call("GET", "/api/custom-providers")).json.pending?.map((entry) => entry.id),
		["telomi-local"],
		"the prepared definition is kept for a correction",
	);

	// Correcting the prepared definition and applying it activates it for consumers.
	await call("PUT", "/api/custom-providers/telomi-local", {
		mode: "pending",
		baseUrl,
		api: "openai-completions",
		apiKey: acceptedKey,
		models: [{ id: "local-1", name: "Local One" }],
	});
	const applied = await call("PUT", "/api/custom-providers/telomi-local", {});
	assert.equal(applied.status, 200);
	assert.deepEqual(Object.keys(activeProviders()), ["telomi-local"]);
	assert.ok((await selectable()).includes("telomi-local/local-1"), "an applied model is selectable");
	assert.deepEqual((await call("GET", "/api/custom-providers")).json.pending, [], "the consumed draft is cleared");

	// A Runner keeps its registry for its whole life. This is the reload the Main Agent performs at
	// its next turn: a Runtime created before the activation resolves the model only afterwards.
	const runtimeFromBeforeActivation = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath,
	});
	assert.equal(runtimeFromBeforeActivation.getModel("telomi-later", "later-1"), undefined);
	await call("PUT", "/api/custom-providers/telomi-later", {
		baseUrl,
		api: "openai-completions",
		apiKey: acceptedKey,
		models: [{ id: "later-1", name: "Later One" }],
	});
	assert.equal(
		runtimeFromBeforeActivation.getModel("telomi-later", "later-1"),
		undefined,
		"an existing registry does not see the activation by itself",
	);
	await runtimeFromBeforeActivation.refresh({ allowNetwork: false });
	assert.ok(
		runtimeFromBeforeActivation.getModel("telomi-later", "later-1"),
		"reloading the catalog resolves a connection activated after startup",
	);

	// A local endpoint that needs no credential is a valid connection, not a missing one.
	const keyless = await call("PUT", "/api/custom-providers/telomi-keyless", {
		baseUrl: keylessBaseUrl,
		api: "openai-completions",
		models: [{ id: "local-1", name: "Local One" }, { id: "kokoro", capabilities: ["tts"] }, { id: "bge-m3", capabilities: ["embedding"] }],
	});
	assert.equal(keyless.status, 200, keyless.json.error ?? "");
	assert.equal(keyless.json.provider?.hasApiKey, false);
	assert.ok((await selectable()).includes("telomi-keyless/local-1"));
	assert.ok(!(await selectable()).some((id) => id === "telomi-keyless/kokoro" || id === "telomi-keyless/bge-m3"), "speech and embedding models of a connection are never LLM choices");

	// Editing a connection without retyping its key keeps the key, and what was validated is
	// exactly what becomes active.
	const edited = await call("PUT", "/api/custom-providers/telomi-local", {
		baseUrl,
		api: "openai-completions",
		models: [{ id: "local-1", name: "Renamed One" }],
	});
	assert.equal(edited.status, 200, edited.json.error ?? "");
	assert.equal((await runtimeFromBeforeActivation.getAuth("telomi-local"))?.auth.apiKey, acceptedKey);
	assert.equal((activeProviders()["telomi-local"] as { apiKey?: string }).apiKey, undefined, "active keys have one native authority");

	// A definition that the endpoint rejects does not replace a connection that works.
	const brokenReplacement = await call("PUT", "/api/custom-providers/telomi-local", {
		baseUrl,
		api: "openai-completions",
		apiKey: "rotated-to-a-typo",
		models: [{ id: "local-1", name: "Local One" }],
	});
	assert.equal(brokenReplacement.status, 422);
	assert.equal((await runtimeFromBeforeActivation.getAuth("telomi-local"))?.auth.apiKey, acceptedKey, "the working connection is preserved");

	// Preparing an edit of a connection in use starts from what it is today, so a form that cannot
	// show the stored key does not drop it, and discarding the draft leaves the connection alone.
	await call("PUT", "/api/custom-providers/telomi-local", {
		mode: "pending",
		baseUrl,
		api: "openai-completions",
		models: [{ id: "local-1", name: "Prepared rename" }],
	});
	assert.equal(
		(await call("GET", "/api/custom-providers")).json.pending?.[0]?.hasApiKey,
		true,
		"a prepared edit keeps the credential the connection already uses",
	);
	assert.equal((await call("DELETE", "/api/custom-providers/telomi-local/pending")).status, 200);
	assert.deepEqual((await call("GET", "/api/custom-providers")).json.pending, []);
	assert.equal(
		(await runtimeFromBeforeActivation.getAuth("telomi-local"))?.auth.apiKey,
		acceptedKey,
		"discarding a draft never removes the connection in use",
	);

	// Deleting a connection leaves no prepared copy behind.
	await call("PUT", "/api/custom-providers/telomi-local", {
		mode: "pending",
		baseUrl,
		api: "openai-completions",
		models: [{ id: "local-1" }],
	});
	assert.equal((await call("DELETE", "/api/custom-providers/telomi-local")).status, 200);
	assert.ok(!("telomi-local" in activeProviders()));
	assert.equal(await runtimeFromBeforeActivation.getAuth("telomi-local"), undefined, "deleting a connection removes its native credential");
	assert.deepEqual((await call("GET", "/api/custom-providers")).json.pending, []);

	// A deletion completed while a replacement is still being checked must remain deleted.
	const deleteRacePath = "/api/custom-providers/delete-race";
	const deleteRaceDefinition = {
		baseUrl, api: "openai-completions", apiKey: acceptedKey,
		models: [{ id: "before-delete" }],
	};
	assert.equal((await call("PUT", deleteRacePath, deleteRaceDefinition)).status, 200);
	let deletionStatus: number | undefined;
	duringValidation = async () => {
		deletionStatus = (await call("DELETE", deleteRacePath)).status;
	};
	const deletedDuringValidation = await call("PUT", deleteRacePath, {
		...deleteRaceDefinition, models: [{ id: "replacement-after-delete" }],
	});
	assert.equal(deletionStatus, 200);
	assert.equal(deletedDuringValidation.status, 409, "a completed deletion supersedes an older validation");
	assert.ok(!(await call("GET", "/api/custom-providers")).json.providers?.some((entry) => entry.id === "delete-race"));

	// Applying a prepared definition cannot discard a newer draft saved during validation.
	const draftRacePath = "/api/custom-providers/draft-race";
	assert.equal((await call("PUT", draftRacePath, deleteRaceDefinition)).status, 200);
	assert.equal((await call("PUT", draftRacePath, {
		...deleteRaceDefinition, mode: "pending", models: [{ id: "first-draft" }],
	})).status, 200);
	let newerDraftStatus: number | undefined;
	duringValidation = async () => {
		newerDraftStatus = (await call("PUT", draftRacePath, {
			...deleteRaceDefinition, mode: "pending", models: [{ id: "newer-draft" }],
		})).status;
	};
	assert.equal((await call("PUT", draftRacePath, {})).status, 200);
	assert.equal(newerDraftStatus, 200);
	const pendingAfterApply = (await call("GET", "/api/custom-providers")).json.pending;
	assert.equal(
		pendingAfterApply?.find((entry) => entry.id === "draft-race")?.models[0]?.id,
		"newer-draft",
		"only the consumed draft is discarded after applying",
	);
	assert.equal((await call("DELETE", "/api/custom-providers/telomi-keyless")).status, 200);
	const recreated = await call("PUT", "/api/custom-providers/telomi-keyless", {
		baseUrl: keylessBaseUrl, api: "openai-completions", models: [{ id: "local-1" }],
	});
	assert.equal(recreated.status, 200, "an explicitly reapplied local connection can be validated after deletion");

	console.log("Custom and local connection save for later, validation and activation passed");
} finally {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
	rmSync(root, { recursive: true, force: true });
}
