import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import express from "express";
import { mountOAuthApi } from "../../server/accounts/oauth-api.js";

type OAuthEvent = { id: number; type: string };

async function readEvents(response: Response, count: number): Promise<OAuthEvent[]> {
	assert.ok(response.body);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const events: OAuthEvent[] = [];
	let buffer = "";
	try {
		while (events.length < count) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const frames = buffer.split("\n\n");
			buffer = frames.pop() ?? "";
			for (const frame of frames) {
				const id = frame.match(/^id: (\d+)$/mu)?.[1];
				const data = frame.match(/^data: (.+)$/mu)?.[1];
				if (!data) continue;
				assert.ok(id, `SSE data frame is missing an id: ${frame}`);
				events.push({ id: Number(id), ...JSON.parse(data) });
				if (events.length === count) break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return events;
}

test("OAuth SSE resumes after the acknowledged event and closes every response on terminal", async () => {
	const nativeFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/api/accounts/deviceauth/usercode")) {
			return Response.json({ device_auth_id: "device-1", user_code: "CODE-1", interval: 1 });
		}
		if (url.endsWith("/api/accounts/deviceauth/token")) {
			return new Response("", { status: 403 });
		}
		return nativeFetch(input, init);
	};

	const app = express();
	app.use(express.json());
	mountOAuthApi(app);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	let sessionId = "";

	try {
		const started = await nativeFetch(`${baseUrl}/api/auth/openai-codex/device/start`, {
			method: "POST",
		});
		assert.equal(started.status, 200);
		sessionId = String((await started.json()).sessionId);

		const initialAbort = new AbortController();
		const initial = await nativeFetch(`${baseUrl}/api/auth/oauth/${sessionId}/events`, {
			signal: initialAbort.signal,
		});
		assert.deepEqual((await readEvents(initial, 2)).map((event) => event.id), [1, 2]);
		initialAbort.abort();

		const resumedByHeader = await nativeFetch(`${baseUrl}/api/auth/oauth/${sessionId}/events`, {
			headers: { "Last-Event-ID": "1" },
		});
		assert.deepEqual((await readEvents(resumedByHeader, 1)).map((event) => event.id), [2]);

		const resumedByCursor = await nativeFetch(`${baseUrl}/api/auth/oauth/${sessionId}/events?cursor=2`);
		const terminalPromise = readEvents(resumedByCursor, 2);
		const aborted = await nativeFetch(`${baseUrl}/api/auth/oauth/${sessionId}/abort`, { method: "POST" });
		assert.equal(aborted.status, 200);
		const terminalEvents = await terminalPromise;
		assert.equal(terminalEvents.at(-1)?.type, "aborted");
		assert.ok(terminalEvents.every((event, index) => index === 0 || event.id > terminalEvents[index - 1].id));

		const reader = resumedByHeader.body!.getReader();
		let ended = false;
		for (let attempt = 0; attempt < 4 && !ended; attempt += 1) {
			ended = (await reader.read()).done;
		}
		assert.equal(ended, true, "terminal event must end every connected response");
	} finally {
		if (sessionId) {
			await nativeFetch(`${baseUrl}/api/auth/oauth/${sessionId}/abort`, { method: "POST" }).catch(() => undefined);
		}
		globalThis.fetch = nativeFetch;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("OAuth dialog deduplicates resumed events and exposes recoverable connection errors", () => {
	const source = readFileSync(
		new URL("../../web/src/features/settings/OAuthLoginDialog.tsx", import.meta.url),
		"utf8",
	);
	assert.match(source, /event\.lastEventId/u);
	assert.match(source, /sequence <= lastSequenceRef\.current/u);
	assert.match(source, /Connection interrupted\. Retrying automatically/u);
	assert.match(source, /phase === "running" && errorText/u);
});

test("OAuth prompt accepts an empty answer as the select prompt's default option", async () => {
	const app = express();
	app.use(express.json());
	mountOAuthApi(app);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	let sessionId = "";

	try {
		const started = await fetch(`${baseUrl}/api/auth/openai-codex/oauth/start`, { method: "POST" });
		assert.equal(started.status, 200);
		sessionId = String((await started.json()).sessionId);

		const [prompt] = await readEvents(await fetch(`${baseUrl}/api/auth/oauth/${sessionId}/events`), 1) as Array<
			OAuthEvent & { promptId?: string; kind?: string; placeholder?: string; allowEmpty?: boolean; options?: { id: string; label: string }[] }
		>;
		assert.equal(prompt.type, "prompt");
		assert.equal(prompt.placeholder, "browser");
		assert.equal(prompt.allowEmpty, true);
		// The dialog renders a select prompt from its structured options rather than parsing the message.
		assert.equal(prompt.kind, "select");
		assert.deepEqual(prompt.options?.map((option) => option.id), ["browser", "device_code"]);

		const answered = await fetch(`${baseUrl}/api/auth/oauth/${sessionId}/input`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ promptId: prompt.promptId, value: "" }),
		});
		assert.equal(answered.status, 200);

		const [next] = await readEvents(await fetch(`${baseUrl}/api/auth/oauth/${sessionId}/events?cursor=1`), 1) as Array<
			OAuthEvent & { message?: string }
		>;
		assert.doesNotMatch(next.message ?? "", /Unknown OpenAI Codex login method/u);
	} finally {
		if (sessionId) {
			await fetch(`${baseUrl}/api/auth/oauth/${sessionId}/abort`, { method: "POST" }).catch(() => undefined);
		}
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
