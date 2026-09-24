import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, apiClient } from "../../web/src/shared/lib/api-client.js";

test("API failures retain status and diagnostics with a consistent error message", async () => {
	const data = { error: "Runtime could not start", stage: "failed" };
	for (const [body, message] of [
		[JSON.stringify(data), data.error],
		["<html>Bad Gateway</html>", "HTTP 502"],
		[JSON.stringify({ error: { detail: "not a message" } }), "HTTP 502"],
	] as const) {
		await assert.rejects(apiClient.get("/api/settings", {
			fetcher: async () => new Response(body, { status: 502 }),
		}), (error: unknown) => {
			assert.ok(error instanceof ApiError);
			assert.equal(error.status, 502);
			assert.equal(error.message, message);
			if (message === data.error) assert.deepEqual(error.data, data);
			return true;
		});
	}
});

test("API methods preserve URLs, JSON, upload headers, and empty responses", async () => {
	const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
	const fetcher: typeof fetch = async (input, init) => {
		calls.push({ input, init });
		return init?.method === "DELETE"
			? new Response(null, { status: 204 })
			: Response.json({ saved: true });
	};
	assert.deepEqual(await apiClient.get("api/settings?panel=voice", { fetcher }), { saved: true });
	await apiClient.post("/api/settings", { enabled: true }, { fetcher });
	await apiClient.put("/api/settings", { enabled: false }, { fetcher });
	await apiClient.patch("/api/settings", { enabled: true }, { fetcher });
	assert.equal(await apiClient.delete("/api/settings", { fetcher }), undefined);
	assert.equal(calls[0].input, "/api/settings?panel=voice");
	assert.deepEqual(calls.map(({ init }) => init?.method), ["GET", "POST", "PUT", "PATCH", "DELETE"]);
	assert.equal(calls[0].init?.body, undefined);
	assert.equal(calls[1].init?.body, '{"enabled":true}');
	assert.equal(new Headers(calls[1].init?.headers).get("Content-Type"), "application/json");
	const audio = new Blob(["audio"], { type: "audio/wav" });
	const controller = new AbortController();
	await apiClient.put("/api/uploads/audio", audio, {
		fetcher,
		headers: { "Content-Type": "audio/wav", "X-File-Name": "reference.wav" },
		signal: controller.signal,
	});
	assert.equal(calls[5].init?.body, audio);
	assert.equal(calls[5].init?.signal, controller.signal);
	assert.equal(new Headers(calls[5].init?.headers).get("X-File-Name"), "reference.wav");
	assert.equal(new Headers(calls[5].init?.headers).get("Content-Type"), "audio/wav");
});

test("API errors normalize transport and parsing failures and preserve page fallbacks", async () => {
	const offline = new TypeError("Failed to fetch");
	await assert.rejects(apiClient.get("/api/settings", {
		fetcher: async () => { throw offline; },
	}), (error: unknown) => {
		assert.ok(error instanceof ApiError);
		assert.equal(error.status, 0);
		assert.equal(error.cause, offline);
		assert.equal(error.message, "Failed to fetch");
		return true;
	});
	await assert.rejects(apiClient.get("/api/settings", {
		fetcher: async () => new Response("not json"),
	}), { name: "ApiError", status: 200, message: "Invalid JSON response" });
	await assert.rejects(apiClient.get("/api/settings", {
		fetcher: async () => new Response("", { status: 503 }),
		fallbackMessage: "Could not load settings",
	}), { name: "ApiError", status: 503, message: "Could not load settings" });
	await assert.rejects(apiClient.post("/api/voice/glossary", {}, {
		fetcher: async () => Response.json({ error: "  " }, { status: 502 }),
		fallbackMessage: (status) => `Glossary save failed with HTTP ${status}`,
	}), { name: "ApiError", status: 502, message: "Glossary save failed with HTTP 502" });
});

test("raw API responses preserve binary uploads, request options, and unread streams", async () => {
	const controller = new AbortController();
	const audio = new Blob([new Uint8Array([0, 128, 255])], { type: "audio/webm" });
	const headers = new Headers({ "Content-Type": "audio/webm", "X-Microphone-Id": "mic-1" });
	const init: RequestInit = {
		method: "POST", body: audio, headers, signal: controller.signal,
		credentials: "include", cache: "no-store", redirect: "error",
	};
	let streamController!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({ start(value) { streamController = value; } });
	const response = new Response(stream, { headers: { "Content-Type": "application/octet-stream" } });
	const result = await apiClient.response("/api/goals/goal-one/voice/transcribe?sessionId=one%20two", {
		...init,
		fetcher: async (input, options) => {
			assert.equal(input, "/api/goals/goal-one/voice/transcribe?sessionId=one%20two");
			assert.deepEqual(options, init);
			assert.equal(options?.body, audio);
			assert.equal(options?.signal, controller.signal);
			return response;
		},
	});
	assert.equal(result, response);
	assert.equal(result.bodyUsed, false);
	assert.equal(result.body?.locked, false);
	streamController.enqueue(new Uint8Array([0, 128, 255]));
	streamController.close();
	assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([0, 128, 255]));
});

test("raw API transport preserves URL inputs, HTTP bodies, and native rejection identity", async () => {
	for (const input of ["relative/file", new URL("https://example.com/artifact"), new Request("https://example.com/source")]) {
		const response = await apiClient.response(input, {
			fetcher: async (actual) => {
				assert.equal(actual, input);
				return new Response("upstream unavailable", { status: 503 });
			},
		});
		assert.equal(response.status, 503);
		assert.equal(await response.text(), "upstream unavailable");
	}
	for (const error of [new DOMException("Cancelled", "AbortError"), new TypeError("Failed to fetch")]) {
		await assert.rejects(apiClient.response("/api/search", {
			fetcher: async () => { throw error; },
		}), (actual: unknown) => actual === error);
	}
});

test("JSON requests preserve native cancellation and endpoint-specific HTTP diagnostics", async () => {
	const controller = new AbortController();
	const aborted = new DOMException("Search superseded", "AbortError");
	controller.abort(aborted);
	await assert.rejects(apiClient.get("/api/search?q=old", {
		signal: controller.signal,
		fetcher: async (_input, init) => { throw init?.signal?.reason; },
	}), (error: unknown) => error === aborted);

	await assert.rejects(apiClient.post("/api/media/generate", undefined, {
		fetcher: async () => new Response('{"error":"busy"}', { status: 409 }),
		errorMessage: (status, body) => `generate ${status}: ${body}`,
	}), { name: "ApiError", status: 409, message: 'generate 409: {"error":"busy"}', data: { error: "busy" } });
});
