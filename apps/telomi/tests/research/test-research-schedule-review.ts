import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import type { GoalService } from "../../server/goals/service.js";
import { UserMemoryProjector } from "../../server/goals/memory/user-memory-projector.js";
import { createResearchSchedulesRouter } from "../../server/research/schedules/api.js";
import { parseScheduleReviewOutput } from "../../server/research/schedules/review-contract.js";
import { ResearchScheduleReviewService } from "../../server/research/schedules/review-service.js";
import { scheduleReviewRoot, type ScheduleReviewer } from "../../server/research/schedules/reviewer.js";
import { ResearchScheduleStore } from "../../server/research/schedules/store.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "research-schedule-review-"));
const goalId = "goal_review";
const current = {
	monitoringScope: "Monitor official product releases.",
	reportContext: "Write for the founding team tracking launch risk.",
};
const revised = {
	monitoringScope: "Monitor official releases and their security advisories.",
	reportContext: "Write for the founding team tracking launch and security risk.",
};

interface ScheduleBody {
	title: string;
	monitoringScope: string;
	reportContext: string;
	cron: string;
	timeZone: string;
	nextRunAt?: string;
	updatedAt: string;
	openProposal?: { id: string; status: string };
}

interface ProposalBody {
	id: string;
	status: string;
	monitoringScope: string;
	reportContext: string;
	rejectionReason?: string;
}

function proposalOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		decision: "propose",
		...revised,
		summary: "Widen the scope to security advisories.",
		rationale: "The user now asks about advisories in every conversation.",
		evidence: ["memory:m-1", "wiki:P12"],
		...overrides,
	};
}

function createSchedule(store: ResearchScheduleStore, title: string) {
	return store.create({
		title,
		question: "What changed?",
		...current,
		cron: "0 9 * * *",
		timeZone: "UTC",
		initializedFromRunId: "run-baseline",
		coveredThrough: "2026-01-01T00:00:00.000Z",
		sources: [],
		now: new Date("2026-01-01T00:00:00.000Z"),
	});
}

try {
	// Contract: the Reviewer output fails closed before it can reach a user.
	assert.deepEqual(parseScheduleReviewOutput({ decision: "no_change" }, current), { decision: "no_change" });
	assert.deepEqual(
		parseScheduleReviewOutput({ decision: "no_change", rationale: "Still accurate." }, current),
		{ decision: "no_change", rationale: "Still accurate." },
	);
	assert.deepEqual(parseScheduleReviewOutput(proposalOutput(), current), {
		decision: "propose",
		...revised,
		summary: "Widen the scope to security advisories.",
		rationale: "The user now asks about advisories in every conversation.",
		evidence: ["memory:m-1", "wiki:P12"],
	});
	assert.throws(() => parseScheduleReviewOutput({ decision: "maybe" }, current), /decision must be/u);
	assert.throws(() => parseScheduleReviewOutput("no_change", current), /must be a JSON object/u);
	assert.throws(
		() => parseScheduleReviewOutput(proposalOutput({ summary: undefined }), current),
		/summary must be a non-empty string/u,
	);
	assert.throws(
		() => parseScheduleReviewOutput(proposalOutput({ evidence: [] }), current),
		/evidence must list/u,
	);
	assert.throws(
		() => parseScheduleReviewOutput(proposalOutput({ ...current }), current),
		/must change its monitoringScope or its reportContext/u,
		"a Proposal identical to the confirmed Schedule is a Contract violation",
	);
	assert.doesNotThrow(() => parseScheduleReviewOutput(
		proposalOutput({ monitoringScope: current.monitoringScope }),
		current,
	), "changing only the Report Context is a valid Proposal");
	assert.throws(
		() => parseScheduleReviewOutput(proposalOutput({ cron: "0 8 * * *" }), current),
		/unknown fields: cron/u,
		"cadence is outside the Reviewer's authority",
	);
	assert.throws(
		() => parseScheduleReviewOutput({ decision: "no_change", title: "Renamed" }, current),
		/unknown fields: title/u,
	);

	// Service seam: a fake Reviewer, real store, real records.
	let output: unknown = { decision: "no_change", rationale: "The scope still matches." };
	let seen: unknown = null;
	const reviewer: ScheduleReviewer = async (input) => {
		// A real Reviewer leaves its staged execution directory behind as the Review's Trace.
		mkdirSync(scheduleReviewRoot(input.goalId, input.workspaceDir, input.reviewId), { recursive: true });
		seen = input.previousReview as unknown;
		if (typeof output === "function") return (output as () => unknown)();
		return output;
	};
	const service = new ResearchScheduleReviewService(workspaceDir, reviewer);
	const store = new ResearchScheduleStore(goalId, workspaceDir);
	const schedule = createSchedule(store, "Daily research");
	store.close();

	const noChange = await service.review(goalId, schedule.id);
	assert.equal(noChange.status, "no_change");
	assert.equal(noChange.reason, "The scope still matches.");
	assert.ok(noChange.traceRef?.includes(noChange.id),
		"every Reviewer execution records where its Trace lives");
	assert.equal(seen, null, "the first Review has no previous Review to learn from");
	const afterNoChange = new ResearchScheduleStore(goalId, workspaceDir);
	assert.deepEqual({
		monitoringScope: afterNoChange.get(schedule.id)?.monitoringScope,
		reportContext: afterNoChange.get(schedule.id)?.reportContext,
	}, current, "a no_change Review leaves the Schedule untouched");
	assert.equal(afterNoChange.get(schedule.id)?.lastReview?.id, noChange.id);
	assert.notEqual(afterNoChange.get(schedule.id)?.lastReviewedAt, schedule.lastReviewedAt);
	assert.equal(afterNoChange.listProposals(schedule.id).length, 0);
	afterNoChange.close();

	output = proposalOutput();
	const proposed = await service.review(goalId, schedule.id);
	assert.equal(proposed.status, "proposed");
	const afterPropose = new ResearchScheduleStore(goalId, workspaceDir);
	const firstProposal = afterPropose.listProposals(schedule.id)[0]!;
	assert.equal(firstProposal.status, "proposed");
	assert.equal(firstProposal.reviewId, proposed.id);
	assert.equal(proposed.proposalId, firstProposal.id);
	assert.deepEqual({
		monitoringScope: firstProposal.monitoringScope,
		reportContext: firstProposal.reportContext,
	}, revised);
	assert.deepEqual({
		previousMonitoringScope: firstProposal.previousMonitoringScope,
		previousReportContext: firstProposal.previousReportContext,
	}, {
		previousMonitoringScope: current.monitoringScope,
		previousReportContext: current.reportContext,
	});
	assert.deepEqual({
		monitoringScope: afterPropose.get(schedule.id)?.monitoringScope,
		reportContext: afterPropose.get(schedule.id)?.reportContext,
	}, current, "a Proposal never applies itself");
	afterPropose.close();

	output = proposalOutput({ summary: "A second, better idea." });
	const superseding = await service.review(goalId, schedule.id);
	assert.equal(superseding.status, "proposed");
	const afterSupersede = new ResearchScheduleStore(goalId, workspaceDir);
	const proposals = afterSupersede.listProposals(schedule.id);
	assert.equal(proposals.length, 2);
	assert.equal(proposals.filter((proposal) => proposal.status === "proposed").length, 1,
		"a newer Proposal supersedes the open one");
	assert.equal(proposals.find((proposal) => proposal.id === firstProposal.id)?.status, "superseded");
	assert.equal(afterSupersede.listReviews(schedule.id).length, 3, "every Review is retained");
	afterSupersede.close();
	assert.deepEqual(
		(seen as unknown as { review: { id: string }; proposal: { id: string } }).review.id,
		proposed.id,
		"the Reviewer receives the previous Review as history",
	);
	assert.equal((seen as unknown as { proposal: { summary: string } }).proposal.summary,
		"Widen the scope to security advisories.");

	output = () => { throw new Error("memory service unavailable"); };
	const failed = await service.review(goalId, schedule.id);
	assert.equal(failed.status, "failed");
	assert.equal(failed.reason, "memory service unavailable");
	const afterFailure = new ResearchScheduleStore(goalId, workspaceDir);
	assert.equal(afterFailure.listReviews(schedule.id).length, 4);
	assert.equal(afterFailure.listProposals(schedule.id).length, 2, "a failed Review produces no Proposal");
	afterFailure.close();

	output = proposalOutput({ cron: "0 8 * * *" });
	const violation = await service.review(goalId, schedule.id);
	assert.equal(violation.status, "failed");
	assert.match(violation.reason ?? "", /unknown fields: cron/u);

	// The Goal's resolved output language reaches the Reviewer as a structured input, resolved against the Report Context.
	let reviewedLanguage: unknown;
	let resolvedFrom: unknown;
	const localized = new ResearchScheduleReviewService(workspaceDir, async (input) => {
		reviewedLanguage = input.language;
		return { decision: "no_change", rationale: "Still holds." };
	}, undefined, (resolvedGoalId, text) => {
		resolvedFrom = [resolvedGoalId, text];
		return "zh-CN";
	});
	await localized.review(goalId, schedule.id);
	assert.equal(reviewedLanguage, "zh-CN");
	assert.deepEqual(resolvedFrom, [goalId, schedule.reportContext]);

	const timing = new ResearchScheduleReviewService(workspaceDir, async (input) => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		input.signal.throwIfAborted();
		return { decision: "no_change" };
	}, 10);
	const timedOut = await timing.review(goalId, schedule.id);
	assert.equal(timedOut.status, "failed");
	assert.match(timedOut.reason ?? "", /timed out/u);

	let release: () => void = () => undefined;
	const blocking = new ResearchScheduleReviewService(workspaceDir, async () => {
		await new Promise<void>((resolve) => { release = resolve; });
		return { decision: "no_change" };
	});
	const inFlight = blocking.review(goalId, schedule.id);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await assert.rejects(blocking.review(goalId, schedule.id), /already running/u,
		"at most one Reviewer runs per Research Schedule");
	release();
	await inFlight;
	const afterRelease = blocking.review(goalId, schedule.id);
	await new Promise((resolve) => setTimeout(resolve, 0));
	release();
	assert.equal((await afterRelease).status, "no_change",
		"a finished Review releases the Schedule for the next one");

	const pausedStore = new ResearchScheduleStore(goalId, workspaceDir);
	const paused = createSchedule(pausedStore, "Paused research");
	pausedStore.pause(paused.id);
	const archived = createSchedule(pausedStore, "Archived research");
	pausedStore.archive(archived.id);
	pausedStore.close();
	await assert.rejects(service.review(goalId, paused.id), /paused Research Schedule cannot be reviewed/u);
	await assert.rejects(service.review(goalId, archived.id), /archived Research Schedule cannot be reviewed/u);
	await assert.rejects(service.review(goalId, "schedule_missing"), /Unknown Research Schedule/u);

	// Router seam. Rejections reach the User Memory Service through the existing projection,
	// so a fake Hindsight bank stands in for the service and the ledger shows what was accepted.
	const retained: Array<{ document_id: string; content: string; metadata?: Record<string, string> }> = [];
	const hindsightApp = express();
	hindsightApp.use(express.json());
	hindsightApp.post("/banks/:bankId/memories", (req, res) => {
		retained.push(...((req.body as { items: typeof retained }).items ?? []));
		res.json({ accepted: true });
	});
	const hindsightServer = hindsightApp.listen(0);
	await new Promise<void>((resolve, reject) => {
		hindsightServer.once("listening", resolve);
		hindsightServer.once("error", reject);
	});
	const projector = new UserMemoryProjector(workspaceDir, goalId, {
		baseUrl: `http://127.0.0.1:${(hindsightServer.address() as AddressInfo).port}`,
		bankId: "test-bank",
	});
	// The router projects without making the user wait for it, so the test waits for the
	// projection itself rather than for a number of ticks.
	let projectionSettled: (error?: unknown) => void = () => undefined;
	const goals = {
		getGoal: (id: string) => id === goalId ? { id, title: "Review" } : undefined,
		getRunner: async () => ({
			projectUserMemory: () => {
				const run = projector.sync();
				// A failed projection fails the waiting assertion with its own error instead of an empty bank.
				void run.then(() => projectionSettled(), (error: unknown) => projectionSettled(error ?? new Error("projection failed")));
				return run;
			},
		}),
	} as unknown as GoalService;
	const nextProjection = (): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			projectionSettled = (error) => error === undefined ? resolve() : reject(error);
		});
	const projectionLedger = (): string[] => {
		const path = join(serverRuntimeDirForGoal(goalId, workspaceDir), "memory", "hindsight-projection.jsonl");
		try {
			return readFileSync(path, "utf-8").split("\n").filter(Boolean)
				.map((line) => (JSON.parse(line) as { documentId: string }).documentId);
		} catch {
			return [];
		}
	};
	const app = express();
	app.use(express.json());
	app.use(createResearchSchedulesRouter(workspaceDir, goals, service));
	const server = app.listen(0);
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	const port = (server.address() as AddressInfo).port;
	const url = (path: string) => `http://127.0.0.1:${port}/api/goals/${goalId}/research/schedules${path}`;
	try {
		output = { decision: "no_change", rationale: "Nothing moved." };
		const response = await fetch(url(`/${schedule.id}/review`), { method: "POST" });
		assert.equal(response.status, 200);
		const body = await response.json() as { review: { status: string } };
		assert.equal(body.review.status, "no_change");

		const history = await (await fetch(url(`/${schedule.id}/reviews`))).json() as {
			reviews: Array<{ status: string }>;
			proposals: Array<{ status: string }>;
		};
		const stored = new ResearchScheduleStore(goalId, workspaceDir);
		assert.deepEqual(history.reviews.map((review) => review.status),
			stored.listReviews(schedule.id).map((review) => review.status),
			"the router lists exactly the retained Reviews of this Schedule");
		assert.deepEqual(history.proposals.map((proposal) => proposal.status),
			stored.listProposals(schedule.id).map((proposal) => proposal.status));
		stored.close();
		assert.equal(history.proposals.length, 2);
		assert.equal(history.reviews[0]?.status, "no_change", "Reviews are listed newest first");

		const pausedResponse = await fetch(url(`/${paused.id}/review`), { method: "POST" });
		assert.equal(pausedResponse.status, 409);
		const missing = await fetch(url("/schedule_missing/review"), { method: "POST" });
		assert.equal(missing.status, 404);
		const unknownGoal = await fetch(
			`http://127.0.0.1:${port}/api/goals/goal_unknown/research/schedules/${schedule.id}/review`,
			{ method: "POST" },
		);
		assert.equal(unknownGoal.status, 404);

		// Confirmation and rejection are deterministic: no model call, no cadence change.
		const post = (path: string, body?: unknown) => fetch(url(path), {
			method: "POST",
			...(body === undefined ? {} : {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		});
		const scheduleNow = async (): Promise<ScheduleBody> =>
			((await (await fetch(url(`/${schedule.id}`))).json()) as { schedule: ScheduleBody }).schedule;
		const proposalNow = async (id: string): Promise<ProposalBody> => {
			const body = await (await fetch(url(`/${schedule.id}/reviews`))).json() as {
				proposals: ProposalBody[];
			};
			const found = body.proposals.find((proposal) => proposal.id === id);
			assert.ok(found, `the Proposal ${id} is retained`);
			return found;
		};
		const proposeAgain = async (
			monitoringScope: string,
			reportContext: string,
		): Promise<string> => {
			output = proposalOutput({ monitoringScope, reportContext });
			const review = await service.review(goalId, schedule.id);
			assert.equal(review.status, "proposed");
			return review.proposalId!;
		};

		const before = await scheduleNow();
		const open = before.openProposal;
		assert.ok(open, "a Schedule with an open Proposal carries it for the panel to mark");
		assert.equal(open.status, "proposed");

		// An occurrence claimed before the confirmation froze the parameters it will run with.
		const claiming = new ResearchScheduleStore(goalId, workspaceDir);
		claiming.requestRunNow(schedule.id);
		const frozen = claiming.claimNext()!;
		claiming.close();
		assert.deepEqual({
			monitoringScope: frozen.schedule.monitoringScope,
			reportContext: frozen.schedule.reportContext,
		}, current);

		const confirmed = await post(`/${schedule.id}/proposals/${open.id}/confirm`);
		assert.equal(confirmed.status, 200);
		const afterConfirm = (await confirmed.json() as { schedule: ScheduleBody; proposal: ProposalBody });
		assert.equal(afterConfirm.proposal.status, "confirmed_as_is");
		assert.deepEqual({
			monitoringScope: afterConfirm.schedule.monitoringScope,
			reportContext: afterConfirm.schedule.reportContext,
		}, revised, "confirming overwrites the Schedule's two parameters");
		assert.deepEqual({
			title: afterConfirm.schedule.title,
			cron: afterConfirm.schedule.cron,
			timeZone: afterConfirm.schedule.timeZone,
			nextRunAt: afterConfirm.schedule.nextRunAt,
		}, {
			title: before.title,
			cron: before.cron,
			timeZone: before.timeZone,
			nextRunAt: before.nextRunAt,
		}, "a Proposal never touches cadence, time zone or title");
		assert.notEqual(afterConfirm.schedule.updatedAt, before.updatedAt);
		assert.equal(afterConfirm.schedule.openProposal, undefined,
			"a resolved Proposal no longer marks the Schedule");

		const stillRunning = new ResearchScheduleStore(goalId, workspaceDir);
		const occurrence = stillRunning.get(schedule.id)?.runs.find((run) => run.id === frozen.run.id);
		stillRunning.close();
		assert.equal(occurrence?.status, "running",
			"confirming a Proposal leaves an occurrence that already started alone");
		assert.deepEqual({
			monitoringScope: frozen.schedule.monitoringScope,
			reportContext: frozen.schedule.reportContext,
		}, current, "the started occurrence keeps its frozen parameters");

		assert.equal((await post(`/${schedule.id}/proposals/${open.id}/confirm`)).status, 409,
			"a confirmed Proposal cannot be confirmed twice");
		assert.equal((await post(`/${schedule.id}/proposals/${open.id}/reject`)).status, 409);
		assert.equal((await post(`/${schedule.id}/proposals/${firstProposal.id}/confirm`)).status, 409,
			"a superseded Proposal cannot be confirmed");
		assert.equal((await post(`/${schedule.id}/proposals/proposal_missing/confirm`)).status, 404);
		assert.equal(
			(await post(`/${schedule.id}/proposals/${open.id}/confirm`, { cron: "0 8 * * *" })).status,
			400,
			"cadence is not an editable field of a Proposal",
		);

		const edited = {
			monitoringScope: "Monitor releases, advisories and their mitigations.",
			reportContext: "Write for the founding team, lead with mitigations.",
		};
		const withEditsId = await proposeAgain(
			"Monitor releases and advisories weekly.",
			"Write for the founding team and the on-call engineer.",
		);
		const withEdits = await post(`/${schedule.id}/proposals/${withEditsId}/confirm`, edited);
		assert.equal(withEdits.status, 200);
		const afterEdits = await withEdits.json() as { schedule: ScheduleBody; proposal: ProposalBody };
		assert.equal(afterEdits.proposal.status, "confirmed_with_edits");
		assert.deepEqual({
			monitoringScope: afterEdits.schedule.monitoringScope,
			reportContext: afterEdits.schedule.reportContext,
		}, edited, "the user's own wording is what the Schedule keeps");
		assert.equal(afterEdits.proposal.monitoringScope, "Monitor releases and advisories weekly.",
			"the Proposal record still shows what the Reviewer proposed");

		const rejectedId = await proposeAgain("Monitor only advisories.", "Write a one-page digest.");
		let projected = nextProjection();
		const rejected = await post(`/${schedule.id}/proposals/${rejectedId}/reject`, {
			reason: "Advisories alone are too narrow.",
		});
		assert.equal(rejected.status, 200);
		const afterReject = await rejected.json() as { schedule: ScheduleBody; proposal: ProposalBody };
		assert.equal(afterReject.proposal.status, "rejected");
		assert.equal(afterReject.proposal.rejectionReason, "Advisories alone are too narrow.");
		assert.deepEqual({
			monitoringScope: afterReject.schedule.monitoringScope,
			reportContext: afterReject.schedule.reportContext,
		}, edited, "rejecting leaves the Schedule exactly as it was");
		assert.equal((await proposalNow(rejectedId)).status, "rejected");

		// The rejection and its reason become long-term user memory the Main Agent can recall.
		await projected;
		const episode = retained.find((item) => item.document_id === `pi-schedule-proposal-${rejectedId}`);
		assert.ok(episode, "rejecting a Proposal projects it into the User Memory Service");
		assert.match(episode.content, /Advisories alone are too narrow\./u, "the reason is projected");
		assert.match(episode.content, /Rejected monitoring scope: Monitor only advisories\./u,
			"the rejected values are projected");
		assert.match(episode.content, /Kept monitoring scope: Monitor releases, advisories and their mitigations\./u,
			"the kept values are projected, so the reason can be read against them");
		assert.equal(episode.metadata?.schedule_id, schedule.id, "the projection names its Schedule");
		assert.ok(projectionLedger().includes(`pi-schedule-proposal-${rejectedId}`),
			"the projection ledger records the accepted entry");
		assert.equal(
			retained.filter((item) => item.document_id === `pi-schedule-proposal-${rejectedId}`).length,
			1,
		);
		assert.equal(
			retained.find((item) => item.document_id === `pi-schedule-proposal-${withEditsId}`),
			undefined,
			"a confirmed Proposal is not a rejection and is not projected",
		);

		// The next Review of this Schedule is given the rejection as history.
		output = { decision: "no_change", rationale: "Still accurate." };
		await service.review(goalId, schedule.id);
		const carried = (seen as unknown as { proposal: ProposalBody }).proposal;
		assert.equal(carried.status, "rejected");
		assert.equal(carried.rejectionReason, "Advisories alone are too narrow.",
			"Reviewer input preparation carries the previous rejection and its reason");

		const silentId = await proposeAgain("Monitor releases only.", "Write for the whole company.");
		projected = nextProjection();
		const silent = await post(`/${schedule.id}/proposals/${silentId}/reject`);
		assert.equal(silent.status, 200);
		const silentProposal = await proposalNow(silentId);
		assert.equal(silentProposal.status, "rejected");
		assert.equal(silentProposal.rejectionReason, undefined, "a reason is optional");
		await projected;
		assert.match(
			retained.find((item) => item.document_id === `pi-schedule-proposal-${silentId}`)?.content ?? "",
			/gave no reason/u,
			"a rejection without a reason is still projected",
		);
		assert.equal((await scheduleNow()).openProposal, undefined);

		// An archived Schedule is done taking revisions, however its Proposal ended up open.
		const archiving = new ResearchScheduleStore(goalId, workspaceDir);
		const retired = createSchedule(archiving, "Retired research");
		const retiredProposalId = archiving.recordReview({
			id: `review_retired`,
			scheduleId: retired.id,
			startedAt: new Date().toISOString(),
			userMessageCount: 0,
			outcome: parseScheduleReviewOutput(proposalOutput(), current),
		}).proposalId!;
		archiving.archive(retired.id);
		archiving.close();
		assert.equal(
			(await post(`/${retired.id}/proposals/${retiredProposalId}/confirm`)).status,
			409,
		);

		let releaseRouter: () => void = () => undefined;
		const slow = new ResearchScheduleReviewService(workspaceDir, async () => {
			await new Promise<void>((resolve) => { releaseRouter = resolve; });
			return { decision: "no_change" };
		});
		const slowApp = express();
		slowApp.use(createResearchSchedulesRouter(workspaceDir, goals, slow));
		const slowServer = slowApp.listen(0);
		await new Promise<void>((resolve, reject) => {
			slowServer.once("listening", resolve);
			slowServer.once("error", reject);
		});
		const slowPort = (slowServer.address() as AddressInfo).port;
		const slowUrl = `http://127.0.0.1:${slowPort}/api/goals/${goalId}/research/schedules/${schedule.id}/review`;
		try {
			const first = fetch(slowUrl, { method: "POST" });
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal((await fetch(slowUrl, { method: "POST" })).status, 409,
				"a second Review of the same Schedule is refused while one runs");
			releaseRouter();
			assert.equal((await first).status, 200);
		} finally {
			await new Promise<void>((resolve) => { slowServer.close(() => resolve()); });
		}
	} finally {
		await new Promise<void>((resolve) => { server.close(() => resolve()); });
		await new Promise<void>((resolve) => { hindsightServer.close(() => resolve()); });
	}

	console.log("Research Schedule Reviews run on demand, fail closed and record Proposals");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}
