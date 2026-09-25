import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import express from "express";
import { HindsightClient } from "pi-user-memory";

import { createUserMemoryRouter } from "../../server/goals/memory/memory-api.ts";
import {
	completeUserMemoryMigrations,
	removeTopicPlanCopiesFromUserMemory,
	scopeUserMemoryToGoals,
} from "../../server/goals/memory/user-memory-migrations.ts";
import { ResearchScheduleStore } from "../../server/research/schedules/store.ts";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.ts";
import { USER_MEMORY_UNAVAILABLE, type UserMemoryResponse } from "../../shared/user-memory.ts";

interface FakeDocument { id: string; created_at: string; tags: string[]; original_text: string; document_metadata?: Record<string, string> }
interface FakeUnit { id: string; text: string; fact_type: string; state: "valid" | "invalidated"; document_id: string | null; tags: string[]; edited_at: string | null }

/** Hindsight's document and memory-unit curation endpoints, with its `any_strict` tag filter. */
async function fakeHindsight(documents: FakeDocument[], units: FakeUnit[]) {
	const requests: string[] = [];
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => { requests.push(`${req.method} ${req.path}`); next(); });
	const tagged = (tags: string[], wanted: string[]) => wanted.length === 0 || wanted.some((tag) => tags.includes(tag));
	const wantedTags = (query: express.Request["query"]) => ([] as string[]).concat((query.tags as string | string[] | undefined) ?? []);
	app.get("/banks/:bank/documents", (req, res) => {
		const idPart = typeof req.query.q === "string" ? req.query.q.toLowerCase() : "";
		const items = documents.filter((document) => tagged(document.tags, wantedTags(req.query)) && document.id.toLowerCase().includes(idPart))
			.map(({ original_text: _text, ...document }) => document);
		res.json({ items, total: items.length, limit: 100, offset: 0 });
	});
	app.get("/banks/:bank/documents/:id", (req, res) => {
		const document = documents.find((item) => item.id === req.params.id);
		if (!document) res.status(404).json({ detail: "Document not found" });
		else res.json(document);
	});
	app.patch("/banks/:bank/documents/:id", (req, res) => {
		const document = documents.find((item) => item.id === req.params.id)!;
		document.tags = req.body.tags;
		for (const unit of units) if (unit.document_id === document.id) unit.tags = req.body.tags;
		res.json({ success: true });
	});
	app.delete("/banks/:bank/documents/:id", (req, res) => {
		documents.splice(documents.findIndex((item) => item.id === req.params.id), 1);
		units.splice(0, units.length, ...units.filter((unit) => unit.document_id !== req.params.id));
		res.json({ success: true });
	});
	app.get("/banks/:bank/memories/list", (req, res) => {
		const items = units.filter((unit) => unit.state === req.query.state && tagged(unit.tags, wantedTags(req.query)));
		res.json({ items, total: items.length, limit: 100, offset: 0 });
	});
	app.get("/banks/:bank/memories/:id", (req, res) => {
		const unit = units.find((item) => item.id === req.params.id);
		if (!unit) res.status(400).json({ detail: "not a valid UUID" });
		else res.json(unit);
	});
	app.patch("/banks/:bank/memories/:id", (req, res) => {
		const unit = units.find((item) => item.id === req.params.id)!;
		if (req.body.state) unit.state = req.body.state;
		if (req.body.text) { unit.text = req.body.text; unit.edited_at = "2026-09-25T10:00:00Z"; }
		res.json(unit);
	});
	const server = app.listen(0);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function unit(id: string, documentId: string | null, tags: string[], text: string, extra: Partial<FakeUnit> = {}): FakeUnit {
	return { id, text, fact_type: "world", state: "valid", document_id: documentId, tags, edited_at: null, ...extra };
}

async function serve(router: express.Router) {
	const app = express();
	app.use(express.json());
	app.use(router);
	const server = app.listen(0);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = async (method: string, path: string, body?: unknown) => {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: { "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, body: await response.json() as Record<string, unknown> };
	};
	return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the Memory page lists, curates and scopes Episodes through Hindsight only", async (context) => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-user-memory-api-"));
	const schedules = new ResearchScheduleStore("goal_a", workspaceDir);
	const schedule = schedules.create({
		title: "Weekly TTS releases",
		question: "What changed?",
		monitoringScope: "Official releases.",
		reportContext: "For me.",
		cron: "0 9 * * 1",
		timeZone: "UTC",
		initializedFromRunId: "run-baseline",
		coveredThrough: "2026-09-01T00:00:00.000Z",
		sources: [],
		now: new Date("2026-09-01T00:00:00.000Z"),
	});
	const { proposalId } = schedules.recordReview({
		id: "review-1",
		scheduleId: schedule.id,
		startedAt: "2026-09-01T12:00:00.000Z",
		outcome: {
			decision: "propose",
			monitoringScope: "Official releases and benchmarks.",
			reportContext: "For me.",
			summary: "Add benchmark results to the scope.",
			rationale: "Benchmarks keep coming up.",
			evidence: ["memory:m-1"],
		},
		userMessageCount: 0,
	});
	schedules.rejectProposal(schedule.id, proposalId!, "Benchmarks are too noisy.");
	schedules.close();
	const documents: FakeDocument[] = [
		{ id: "pi-task-own", created_at: "2026-09-02T00:00:00Z", tags: ["goal:goal_a"], original_text: "Explain with PyTorch.", document_metadata: { source: "task_history" } },
		{ id: "pi-task-shared", created_at: "2026-09-03T00:00:00Z", tags: ["goal:goal_b", "scope:global"], original_text: "Keep it short." },
		{ id: "pi-task-other", created_at: "2026-09-04T00:00:00Z", tags: ["goal:goal_b"], original_text: "Goal B only." },
		{ id: "pi-task-orphan", created_at: "2026-09-01T00:00:00Z", tags: ["scope:global"], original_text: "From a deleted Goal." },
		{
			id: `pi-schedule-proposal-${proposalId}`, created_at: "2026-09-01T12:00:00Z", tags: ["goal:goal_a"],
			original_text: "The user rejected a Research Schedule Proposal on the Research Schedule \"Weekly TTS releases\".",
			document_metadata: { source: "research_schedule_proposal", source_id: proposalId!, schedule_id: schedule.id },
		},
		{
			id: "pi-schedule-proposal-gone", created_at: "2026-09-01T06:00:00Z", tags: ["goal:goal_a"], original_text: "Built for extraction.",
			document_metadata: { source: "research_schedule_proposal", source_id: "gone", schedule_id: "schedule_gone" },
		},
	];
	const units: FakeUnit[] = [
		unit("fact-own", "pi-task-own", ["goal:goal_a"], "User explains with PyTorch. | Involving: user | why"),
		unit("fact-retired", "pi-task-own", ["goal:goal_a"], "Old wording", { state: "invalidated" }),
		unit("observation-own", null, ["goal:goal_a"], "Derived", { fact_type: "observation" }),
		unit("fact-shared", "pi-task-shared", ["goal:goal_b", "scope:global"], "User wants brevity."),
		unit("fact-other", "pi-task-other", ["goal:goal_b"], "Goal B fact."),
	];
	const hindsight = await fakeHindsight(documents, units);
	context.after(() => hindsight.close());
	// One message Hindsight has not accepted yet: the projection ledger does not list it.
	const history = join(serverRuntimeDirForGoal("goal_a", workspaceDir), "history");
	mkdirSync(history, { recursive: true });
	writeFileSync(join(history, "user_tasks.jsonl"), `${JSON.stringify({
		version: 1, type: "task_history", taskId: "pending", source: "user_message", goalId: "goal_a",
		createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z", originalQuestion: "Remember this too.",
		normalizedInput: "Remember this too.", labels: {},
		message: { role: "user", conversationId: "goal_a", userMessageId: "pending" },
	})}\n`);
	let streaming = true;
	const goals = {
		getGoal: (id: string) => ["goal_a", "goal_b"].includes(id)
			? { id, title: id === "goal_a" ? "Goal A" : "Goal B", isStreaming: id === "goal_a" && streaming }
			: undefined,
	} as never;
	const api = await serve(createUserMemoryRouter(workspaceDir, goals, new HindsightClient(hindsight.url, "bank")));
	context.after(() => api.close());

	const list = async () => (await api.call("GET", "/api/goals/goal_a/memory")).body as unknown as UserMemoryResponse;
	let memory = await list();
	assert.deepEqual(memory.goal.map((episode) => [episode.documentId, episode.status]), [
		["pi-task-pending", "waiting"],
		["pi-task-own", "retained"],
		[`pi-schedule-proposal-${proposalId}`, "retained"],
		["pi-schedule-proposal-gone", "retained"],
	], "this Goal's Episodes, newest first, with the unaccepted message still waiting on the running turn");
	assert.deepEqual(memory.global.map((episode) => [episode.documentId, episode.goalTitle ?? null]), [
		["pi-task-shared", "Goal B"],
		["pi-task-orphan", null],
	], "global Episodes from every Goal, and never another Goal's own");
	const own = memory.goal[1]!;
	assert.equal(own.text, "Explain with PyTorch.");
	assert.equal(own.source, "message");
	const rejected = memory.goal[2]!;
	assert.equal(rejected.source, "schedule_proposal");
	assert.equal(rejected.text, "", "Telomi's extraction text is never shown as the user's words");
	assert.deepEqual(rejected.scheduleProposal, {
		scheduleTitle: "Weekly TTS releases",
		summary: "Add benchmark results to the scope.",
		reason: "Benchmarks are too noisy.",
	}, "a rejected Proposal is read from its Schedule");
	assert.equal(memory.goal[3]!.text, "");
	assert.equal(memory.goal[3]!.scheduleProposal, undefined, "a Proposal whose Schedule is gone shows no details");
	assert.deepEqual(own.facts.map((fact) => [fact.text, fact.invalidated]), [
		["User explains with PyTorch.", false],
		["Old wording", true],
	], "facts show the statement only, observations are left out");
	streaming = false;
	assert.equal((await list()).goal[0]!.status, "failed", "an unaccepted message with no turn running has failed to retain");

	const edited = await api.call("PATCH", "/api/goals/goal_a/memory/facts/fact-own", { text: "  User explains with the PyTorch pipeline.  " });
	assert.equal(edited.status, 200);
	assert.equal(units[0]!.text, "User explains with the PyTorch pipeline. | Involving: user | why", "an edit keeps Hindsight's detail");
	assert.equal(edited.body.editedAt, "2026-09-25T10:00:00Z");
	assert.equal((await api.call("PATCH", "/api/goals/goal_a/memory/facts/fact-own", { invalidated: true })).status, 200);
	assert.equal(units[0]!.state, "invalidated");
	assert.equal((await api.call("PATCH", "/api/goals/goal_a/memory/facts/fact-own", { invalidated: false })).status, 200);
	assert.equal(units[0]!.state, "valid");
	assert.equal((await api.call("PATCH", "/api/goals/goal_a/memory/facts/fact-own", { text: " " })).status, 400);
	assert.equal((await api.call("PATCH", "/api/goals/goal_a/memory/facts/fact-own", { text: "x", invalidated: true })).status, 400);
	assert.equal((await api.call("PATCH", "/api/goals/goal_a/memory/facts/observation-own", { invalidated: true })).status, 404,
		"observations are derived and cannot be curated");
	assert.equal((await api.call("PATCH", "/api/goals/goal_a/memory/facts/fact-other", { invalidated: true })).status, 404,
		"another Goal's memory is out of reach");
	assert.equal(units[4]!.state, "valid");

	assert.equal((await api.call("PUT", "/api/goals/goal_a/memory/episodes/pi-task-own/scope", { global: true })).status, 200);
	assert.deepEqual(documents[0]!.tags, ["goal:goal_a", "scope:global"]);
	assert.deepEqual(units[0]!.tags, ["goal:goal_a", "scope:global"], "Hindsight propagates the tags to the facts");
	assert.equal((await api.call("PUT", "/api/goals/goal_a/memory/episodes/pi-task-shared/scope", { global: false })).status, 200,
		"a global Episode is managed from any Goal");
	assert.deepEqual(documents[1]!.tags, ["goal:goal_b"]);
	assert.equal((await api.call("PUT", "/api/goals/goal_a/memory/episodes/pi-task-orphan/scope", { global: false })).status, 409,
		"an Episode without a Goal can only stay global");
	assert.equal((await api.call("PUT", "/api/goals/goal_a/memory/episodes/pi-task-other/scope", { global: true })).status, 404);
	assert.equal((await api.call("PUT", "/api/goals/goal_a/memory/episodes/pi-task-own/scope", { global: "yes" })).status, 400);

	assert.equal((await api.call("DELETE", "/api/goals/goal_a/memory/episodes/pi-task-other")).status, 404);
	assert.equal((await api.call("DELETE", "/api/goals/goal_a/memory/episodes/pi-task-own")).status, 200);
	assert.ok(!documents.some((document) => document.id === "pi-task-own"));
	assert.ok(!units.some((item) => item.document_id === "pi-task-own"), "deleting an Episode removes its facts");
	assert.equal((await api.call("GET", "/api/goals/goal_unknown/memory")).status, 404);
	assert.ok(!hindsight.requests.some((request) => request.startsWith("DELETE /banks/bank") && !request.includes("/documents/")),
		"no route reaches a bank-level delete or clear");
	memory = await list();
	assert.ok(!memory.goal.some((episode) => episode.documentId === "pi-task-own"));
});

test("the Memory page reports User Memory as unavailable while it is down", async (context) => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-user-memory-down-"));
	const goals = { getGoal: () => ({ id: "goal_a", title: "A", isStreaming: false }) } as never;
	const api = await serve(createUserMemoryRouter(workspaceDir, goals, new HindsightClient("http://127.0.0.1:9/v1/default", "bank")));
	context.after(() => api.close());
	const response = await api.call("GET", "/api/goals/goal_a/memory");
	assert.equal(response.status, 503);
	assert.equal(response.body.error, USER_MEMORY_UNAVAILABLE);
});

test("deferred User Memory migrations run once each, in order, and survive a failure", async (context) => {
	const dataDir = mkdtempSync(join(tmpdir(), "telomi-memory-migrations-"));
	const documents: FakeDocument[] = [
		{ id: "pi-task-a", created_at: "", tags: ["goal:goal_a", "scope:global"], original_text: "" },
		{ id: "pi-turn-b", created_at: "", tags: ["goal:goal_b", "scope:global"], original_text: "" },
		{ id: "pi-turn-plain", created_at: "", tags: ["scope:global"], original_text: "" },
		{ id: "pi-topic-plan-goal_a-r1", created_at: "", tags: ["goal:goal_a"], original_text: "" },
		{ id: "pi-topic-plan-goal_a-r2", created_at: "", tags: ["goal:goal_a"], original_text: "" },
		{ id: "pi-topic-plan-goal_gone-r1", created_at: "", tags: [], original_text: "" },
		{ id: "pi-task-mentions-pi-topic-plan-", created_at: "", tags: ["goal:goal_a"], original_text: "" },
	];
	const units = [unit("fact-plan", "pi-topic-plan-goal_a-r1", ["goal:goal_a"], "User focuses on TTS.")];
	const hindsight = await fakeHindsight(documents, units);
	context.after(() => hindsight.close());
	const client = new HindsightClient(hindsight.url, "bank");

	await completeUserMemoryMigrations(client, dataDir);
	assert.equal(hindsight.requests.length, 0, "without the data-format steps nothing is touched");

	scopeUserMemoryToGoals.run(dataDir);
	removeTopicPlanCopiesFromUserMemory.run(dataDir);
	await assert.rejects(completeUserMemoryMigrations(new HindsightClient("http://127.0.0.1:9/v1/default", "bank"), dataDir));
	const markers = ["goal-scope-pending", "topic-plan-copies-pending"].map((name) => join(dataDir, "user-memory", name));
	assert.ok(markers.every((marker) => existsSync(marker)), "a failed attempt leaves the work for the next one");

	await completeUserMemoryMigrations(client, dataDir);
	assert.deepEqual(documents.map((document) => [document.id, document.tags]), [
		["pi-task-a", ["goal:goal_a"]],
		["pi-turn-b", ["goal:goal_b"]],
		["pi-turn-plain", ["scope:global"]],
		["pi-task-mentions-pi-topic-plan-", ["goal:goal_a"]],
	], "user messages of a Goal lose the automatic tag, a plain Pi session keeps it, and every Topic Plan copy is gone");
	assert.equal(units.length, 0, "a Topic Plan copy's facts go with it");
	assert.ok(markers.every((marker) => !existsSync(marker)));

	// The user makes an Episode global afterwards; running again must not undo that.
	documents[0]!.tags = ["goal:goal_a", "scope:global"];
	const before = hindsight.requests.length;
	await completeUserMemoryMigrations(client, dataDir);
	assert.deepEqual(documents[0]!.tags, ["goal:goal_a", "scope:global"]);
	assert.equal(hindsight.requests.length, before, "finished migrations never run again");
});
