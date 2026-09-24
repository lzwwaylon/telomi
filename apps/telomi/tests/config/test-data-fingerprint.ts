import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { dataDirectoryEntries, dataFingerprint } from "../../server/config/data-fingerprint.js";

function scratch(context: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "telomi-fingerprint-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function write(root: string, path: string, content: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}

async function fakeMemory(context: { after(fn: () => void): void }, banks: () => unknown[]): Promise<string> {
	const server: Server = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		res.end(req.url === "/v1/default/banks" ? JSON.stringify({ banks: banks() }) : "{}");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	context.after(() => server.close());
	const { port } = server.address() as { port: number };
	return `http://127.0.0.1:${port}/v1/default`;
}

test("state a running installation changes by itself is left out; everything else counts", (context) => {
	const root = scratch(context);
	for (const path of ["goals.json", "format.json", "goal_a/wiki/page.md", "goal_a/context.jsonl", ".pi/agent/settings.json", "unknown/new-state.json",
		"browser-profile/Default/Cookies", "user-memory/postgres/PG_VERSION", ".pi/runtime/harness/goal_a/trace.jsonl",
		"goal_a/.pi/runtime/cache/x", ".pi/agent/source-status.json"]) write(root, path, "x");
	assert.deepEqual(dataDirectoryEntries(root).map((entry) => entry.split("\t")[0]),
		[".pi/agent/settings.json", "format.json", "goal_a/context.jsonl", "goal_a/wiki/page.md", "goals.json", "unknown/new-state.json"]);
});

test("the synced model catalog does not count; connections and chosen models do", (context) => {
	const root = scratch(context);
	const models = (providers: Record<string, unknown>) => write(root, ".pi/agent/models.json", JSON.stringify({ providers }));
	const entries = () => dataDirectoryEntries(root).join("\n");
	models({ router: { baseUrl: "https://a", models: [{ id: "m1" }] }, mine: { baseUrl: "https://b", userSelectedModels: true, models: [{ id: "x" }] } });
	const before = entries();
	models({ router: { baseUrl: "https://a", models: [{ id: "m1" }, { id: "m2", name: "new" }] }, mine: { baseUrl: "https://b", userSelectedModels: true, models: [{ id: "x", name: "renamed" }] } });
	assert.equal(entries(), before, "catalog growth and refreshed metadata are not a change");
	models({ router: { baseUrl: "https://changed", models: [{ id: "m1" }] }, mine: { baseUrl: "https://b", userSelectedModels: true, models: [{ id: "x" }] } });
	assert.notEqual(entries(), before, "a connection change counts");
	models({ router: { baseUrl: "https://a", models: [{ id: "m1" }] }, mine: { baseUrl: "https://b", userSelectedModels: true, models: [{ id: "x" }, { id: "y" }] } });
	assert.notEqual(entries(), before, "a model the user chose counts");
});

test("the fingerprint follows User Memory content and is unknown without it", async (context) => {
	const root = scratch(context);
	write(root, "goals.json", "[]");
	let facts = 4;
	const url = await fakeMemory(context, () => [{ bank_id: "user", updated_at: "t0", fact_count: facts, last_write_at: `w${facts}` }]);
	const first = await dataFingerprint(root, { HINDSIGHT_URL: url });
	assert.ok(first);
	assert.equal(await dataFingerprint(root, { HINDSIGHT_URL: url }), first, "stable while nothing changes");
	facts = 5;
	assert.notEqual(await dataFingerprint(root, { HINDSIGHT_URL: url }), first, "a stored fact counts");
	facts = 4;
	write(root, "goal_a/wiki/page.md", "new page");
	assert.notEqual(await dataFingerprint(root, { HINDSIGHT_URL: url }), first, "a Wiki page counts");
	assert.equal(await dataFingerprint(root, { HINDSIGHT_URL: "http://127.0.0.1:1/v1/default" }), undefined);
});

test("refreshed tokens and account usage records do not count; entered credentials do", (context) => {
	const root = scratch(context);
	const entries = () => dataDirectoryEntries(root).join("\n");
	const auth = (codexAccess: string, apiKey: string) => write(root, ".pi/agent/auth.json", JSON.stringify({
		codex: { type: "oauth", access: codexAccess, refresh: `r-${codexAccess}`, expires: codexAccess.length, accountId: "acct" },
		deepseek: { type: "api_key", key: apiKey },
	}));
	const accounts = (lastUsedAt: number, status: string, ids: string[]) => write(root, ".pi/agent/accounts/codex.json", JSON.stringify({
		version: 1,
		accounts: ids.map((id) => ({ id, label: id, createdAt: 1, status, lastUsedAt, credential: { type: "oauth", access: `a${lastUsedAt}`, refresh: "r", expires: lastUsedAt } })),
		chainOrder: ids,
		activeId: ids[0],
	}));
	auth("a1", "k1");
	accounts(1, "active", ["one"]);
	const before = entries();
	auth("a2", "k1");
	accounts(2, "cooling-down", ["one"]);
	assert.equal(entries(), before, "token refresh and usage records are not a change");
	auth("a2", "k2");
	assert.notEqual(entries(), before, "a new API key counts");
	auth("a1", "k1");
	accounts(1, "active", ["one", "two"]);
	assert.notEqual(entries(), before, "an added account counts");
	write(root, ".pi/agent/accounts/codex.json", "{ torn write");
	assert.match(entries(), /accounts\/codex\.json\t\d+\t/u, "an unparsable file still counts, by size and time");
});
