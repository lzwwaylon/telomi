import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	filterProcessedSources,
	scheduledSourceContentSha256,
	scheduledSourceIdentity,
} from "../../server/research/pipeline/source-version.js";
import { RUN_WORKFLOW_VERSION } from "../../server/research/run-state.js";
import { FIND_OUT_SOURCE_MANIFEST_SCHEMA_VERSION } from "../../server/research/pipeline/find-out-sources.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/index.js";
import { createResearchScheduleFromRun } from "../../server/research/schedules/create-from-run.js";
import { readProcessedResearchRun } from "../../server/research/schedules/source-processing.js";
import { ResearchScheduleStore } from "../../server/research/schedules/store.js";
import { ResearchScheduleReviewService } from "../../server/research/schedules/review-service.js";
import { ResearchScheduleScheduler } from "../../server/research/schedules/scheduler.js";
import { subscribe } from "../../server/events/event-bus.js";
import type { GoalService } from "../../server/goals/service.js";
import {
	parseCronSchedule,
	schedulePlanToCron,
} from "../../web/src/features/goals/GoalResearchSchedulePanel.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "research-schedules-"));
const goalId = "goal_test";
const baselineContentSha256 = scheduledSourceContentSha256([{
	path: "document.md",
	sha256: "a".repeat(64),
}]);
const baselineSource = {
	sourceIdentity: "source:baseline",
	contentSha256: baselineContentSha256,
};

function writeBaselineResumeRequest(goal: string, runId: string, reportContext: string): void {
	const runDir = join(serverRuntimeDirForGoal(goal, workspaceDir), "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "resume-request.json"), `${JSON.stringify({ reportContext })}\n`, "utf-8");
}

try {
	const unavailableWorkspace = join(workspaceDir, "not-a-directory");
	writeFileSync(unavailableWorkspace, "occupied");
	const resilientScheduler = new ResearchScheduleScheduler(
		unavailableWorkspace,
		{
			listGoals: () => [{ id: "goal_unavailable" }],
			isGoalActive: () => false,
		} as unknown as GoalService,
		new ResearchScheduleReviewService(unavailableWorkspace, async () => ({ decision: "no_change" })),
	);
	resilientScheduler.start();
	await assert.doesNotReject(resilientScheduler.tick());
	resilientScheduler.stop();

	for (const cron of [
		"*/10 * * * *",
		"15 * * * *",
		"30 9 * * *",
		"30 9 * * 1-5",
		"30 9 * * 3",
		"30 9 15 * *",
		"0 9 1,15 * *",
	]) {
		assert.equal(schedulePlanToCron(parseCronSchedule(cron)), cron,
			`the schedule editor must preserve ${cron}`);
	}
	assert.equal(filterProcessedSources([{
		id: "source-1",
		title: "Source",
		url: "https://example.com/source",
		providerId: "general_web",
		sourceIdentity: baselineSource.sourceIdentity,
		revisionSha256: baselineContentSha256,
		directoryPath: "/tmp/source-1",
		organizationKind: "ungrouped",
		members: [],
	}], [baselineSource]).length, 0);
	assert.equal(
		scheduledSourceIdentity("https://example.com/news?utm_source=daily#section"),
		scheduledSourceIdentity("https://example.com/news"),
		"tracking parameters must not change scheduled source identity",
	);
	assert.equal(filterProcessedSources([{
		id: "source-updated",
		title: "Updated source",
		url: "https://example.com/source",
		providerId: "general_web",
		sourceIdentity: baselineSource.sourceIdentity,
		revisionSha256: scheduledSourceContentSha256([{
			path: "document.md",
			sha256: "b".repeat(64),
		}]),
		directoryPath: "/tmp/source-updated",
		organizationKind: "ungrouped",
		members: [],
	}], [baselineSource]).length, 1,
	"the same canonical source must be incremental when its Source Bundle content changes");
	assert.equal(filterProcessedSources(["youtube", "github"].map((provider) => ({
		id: `source-${provider}`,
		title: "Source",
		url: "https://example.com/news",
		providerId: provider,
		sourceIdentity: scheduledSourceIdentity("https://example.com/news"),
		revisionSha256: baselineContentSha256,
		directoryPath: `/tmp/source-${provider}`,
		organizationKind: "ungrouped" as const,
		members: [],
	})), []).length, 1, "the same URL must appear only once within a scheduled Run");
	assert.throws(() => createResearchScheduleFromRun({
		workspaceDir,
		goalId,
		title: "Unsafe",
		monitoringScope: "Monitor changes.",
		sourceRunId: "../../outside",
		cron: "0 9 * * *",
		timeZone: "UTC",
	}), /sourceRunId is invalid/u);

	const store = new ResearchScheduleStore(goalId, workspaceDir);
	const baseline = "2026-01-01T01:00:00.000Z";
	const schedule = store.create({
		title: "Daily research",
		question: "What changed?",
		monitoringScope: "Monitor official product releases.",
		reportContext: "Write for the founding team tracking launch risk.",
		cron: "0 9 * * *",
		timeZone: "Asia/Singapore",
		initializedFromRunId: "run-baseline",
		coveredThrough: baseline,
		sources: [baselineSource],
		now: new Date("2026-01-01T02:00:00.000Z"),
	});
	assert.equal(schedule.monitoringScope, "Monitor official product releases.");
	assert.equal(schedule.reportContext, "Write for the founding team tracking launch risk.",
		"a Research Schedule must own its Report Context");
	assert.equal(schedule.lastReviewedAt, schedule.createdAt,
		"a new Research Schedule is last reviewed at its creation time");
	assert.equal(schedule.lastReviewedUserMessageCount, 0);
	assert.equal(schedule.nextRunAt, "2026-01-02T01:00:00.000Z");
	assert.equal(
		store.update(schedule.id, { monitoringScope: "Monitor official releases and changelogs." })
			.monitoringScope,
		"Monitor official releases and changelogs.",
	);
	assert.equal(
		store.update(schedule.id, { reportContext: "Write for the operations team." }).reportContext,
		"Write for the operations team.",
	);
	store.update(schedule.id, { reportContext: "Write for the founding team tracking launch risk." });
	assert.throws(() => store.update(schedule.id, { timeZone: "Mars/Olympus" }), /Invalid time zone/u);

	const first = store.requestRunNow(schedule.id, new Date("2026-01-01T03:00:00.000Z"));
	assert.throws(() => store.requestRunNow(schedule.id), /active Run/u);
	const firstClaim = store.claimNext(new Date("2026-01-01T03:00:01.000Z"));
	assert.equal(firstClaim?.run.id, first.id);
	assert.deepEqual(firstClaim?.processedSources, [{
		sourceIdentity: baselineSource.sourceIdentity,
		contentSha256: baselineSource.contentSha256,
	}]);
	// A running occurrence names its Research Run straight away. The Activity projection drops its
	// own placeholder once an occurrence points at a Run, so recording the link only at completion
	// left the placeholder sitting beside the live Run for the whole of it.
	store.linkResearchRun(first.id, "2026-01-01T03-00-02.000Z");
	assert.equal(store.get(schedule.id)?.runs.find((run) => run.id === first.id)?.researchRunId, "2026-01-01T03-00-02.000Z");
	store.fail(first.id, "Provider unavailable", new Date("2026-01-01T03:01:00.000Z"));
	assert.throws(() => store.linkResearchRun(first.id, "2026-01-01T03-00-02.000Z"), /running/u,
		"a settled occurrence no longer takes a Run id");
	assert.equal(store.get(schedule.id)?.coveredThrough, baseline,
		"a failed Run must not advance coveredThrough");

	const second = store.requestRunNow(schedule.id, new Date("2026-01-01T04:00:00.000Z"));
	store.claimNext(new Date("2026-01-01T04:00:01.000Z"));
	const increment = {
		sourceIdentity: "source:increment",
		contentSha256: scheduledSourceContentSha256([{
			path: "document.md",
			sha256: "c".repeat(64),
		}]),
	};
	const updatedBaseline = {
		...baselineSource,
		contentSha256: scheduledSourceContentSha256([{
			path: "document.md",
			sha256: "d".repeat(64),
		}]),
	};
	store.complete({
		runId: second.id,
		status: "skipped_no_qualifying_evidence",
		researchRunId: "run-increment",
		discoveredSources: 1,
		incrementalSources: 1,
		cornellNotes: 0,
		sources: [increment, updatedBaseline],
		now: new Date("2026-01-01T04:02:00.000Z"),
	});
	assert.equal(store.get(schedule.id)?.coveredThrough, second.windowEnd);
	const third = store.requestRunNow(schedule.id, new Date("2026-01-01T05:00:00.000Z"));
	const thirdClaim = store.claimNext(new Date("2026-01-01T05:00:01.000Z"));
	assert.equal(thirdClaim?.processedSources.length, 2,
		"completed Source revisions must be retained");
	assert.equal(
		thirdClaim?.processedSources.find((source) => source.sourceIdentity === baselineSource.sourceIdentity)
			?.contentSha256,
		updatedBaseline.contentSha256,
		"completing a Run must replace the stored fingerprint for an updated canonical source",
	);
	assert.equal(store.recoverInterrupted(new Date("2026-01-01T05:01:00.000Z")), 1);
	assert.equal(store.get(schedule.id)?.runs.find((run) => run.id === third.id)?.status, "failed");
	assert.equal(store.get(schedule.id)?.coveredThrough, second.windowEnd,
		"restart recovery must not advance coveredThrough");
	store.close();

	const dueStore = new ResearchScheduleStore(goalId, workspaceDir);
	const db = new DatabaseSync(dueStore.databasePath);
	db.prepare(`
		UPDATE research_schedules SET next_run_at='2026-01-02T01:00:00.000Z'
		WHERE id=?
	`).run(schedule.id);
	db.close();
	const due = dueStore.claimNext(new Date("2026-01-05T12:00:00.000Z"));
	assert.equal(due?.run.scheduledFor, "2026-01-05T01:00:00.000Z",
		"missed intervals must coalesce to the latest due occurrence");
	assert.equal(dueStore.get(schedule.id)?.nextRunAt, "2026-01-06T01:00:00.000Z");
	dueStore.close();

	const reopenedStore = new ResearchScheduleStore(goalId, workspaceDir);
	const currentDb = new DatabaseSync(reopenedStore.databasePath);
	for (const column of ["report_context", "last_reviewed_at", "last_reviewed_user_message_count"]) {
		assert.throws(
			() => currentDb.prepare(`UPDATE research_schedules SET ${column}=NULL WHERE id=?`).run(schedule.id),
			/NOT NULL constraint failed/u,
		);
	}
	currentDb.close();
	assert.equal(reopenedStore.get(schedule.id)?.reportContext, schedule.reportContext);
	assert.equal(reopenedStore.get(schedule.id)?.lastReviewedAt, schedule.createdAt);
	assert.equal(reopenedStore.get(schedule.id)?.lastReviewedUserMessageCount, 0);
	reopenedStore.close();

	const occurrenceGoalId = "goal_occurrence_parameters";
	const occurrenceStore = new ResearchScheduleStore(occurrenceGoalId, workspaceDir);
	writeBaselineResumeRequest(occurrenceGoalId, "run-occurrence-baseline", "Stale baseline Report Context.");
	const occurrenceSchedule = occurrenceStore.create({
		title: "Occurrence parameters",
		question: "What changed?",
		monitoringScope: "Monitor the confirmed scope.",
		reportContext: "Write under the confirmed Report Context.",
		cron: "0 9 * * *",
		timeZone: "UTC",
		initializedFromRunId: "run-occurrence-baseline",
		coveredThrough: "2026-01-01T00:00:00.000Z",
		sources: [],
		now: new Date("2026-01-01T00:00:00.000Z"),
	});
	occurrenceStore.requestRunNow(occurrenceSchedule.id, new Date("2026-01-01T01:00:00.000Z"));
	occurrenceStore.close();
	const scheduledRequests: Array<{ question: string; reportContext: string; monitoringScope: string }> = [];
	const occurrenceScheduler = new ResearchScheduleScheduler(workspaceDir, {
		listGoals: () => [{ id: occurrenceGoalId }],
		isGoalActive: () => false,
		runScheduledResearch: (request: {
			question: string;
			reportContext: string;
			context: { monitoringScope: string };
		}) => {
			scheduledRequests.push({
				question: request.question,
				reportContext: request.reportContext,
				monitoringScope: request.context.monitoringScope,
			});
			throw new Error("stop after capturing the occurrence parameters");
		},
	} as unknown as GoalService,
	new ResearchScheduleReviewService(workspaceDir, async () => ({ decision: "no_change" })));
	// The scheduler hands the occurrence its parameters before its first await,
	// so the capture is complete once the tick returns.
	await occurrenceScheduler.tick(new Date("2026-01-01T01:00:01.000Z"));
	assert.deepEqual(scheduledRequests, [{
		question: "Monitor the confirmed scope.",
		reportContext: "Write under the confirmed Report Context.",
		monitoringScope: "Monitor the confirmed scope.",
	}], "a Scheduled Research Run must use the Schedule's own parameters, not the baseline Run's");

	const artifactRef = (relative_path: string) => ({
		relative_path,
		sha256: "d".repeat(64),
		byte_length: 1,
	});
	const runState = (input: {
		runId: string;
		goalId: string;
		status: string;
		sourceBundles?: string[];
		findOutSources?: string[];
		cornellNoteSnapshots?: string[];
		cornellNoteFailureManifests?: string[];
		skipReason?: string;
	}) => ({
		schema_version: 2,
		workflow_id: "research-run",
		workflow_version: RUN_WORKFLOW_VERSION,
		run_id: input.runId,
		goal_id: input.goalId,
		question: "What changed?",
		language: "en",
		status: input.status,
		state_revision: 1,
		pins: {
			harness_snapshot: "harness",
			workspace_content_hash: "a".repeat(64),
			knowledge_memory_hash: "knowledge",
			run_context_snapshot: "1".repeat(64),
			pipeline: "pipeline",
			prompt_bundle: "prompt",
			schema_bundle: "schema",
			model_policy: "model",
			skill_bundle: "skill",
			tool_schema: "tool",
		},
		source_bundles: (input.sourceBundles ?? []).map(artifactRef),
		find_out_sources: (input.findOutSources ?? []).map(artifactRef),
		search_execution_records: [],
		cornell_note_snapshots: (input.cornellNoteSnapshots ?? []).map(artifactRef),
		...(input.cornellNoteFailureManifests
			? { cornell_note_failure_manifests: input.cornellNoteFailureManifests.map(artifactRef) }
			: {}),
		writer_outputs: [],
		accepted_chapters: [],
		...(input.status === "published" ? { canonical_report: artifactRef("report/final.md") } : {}),
		...(input.skipReason ? { skip_reason: input.skipReason } : {}),
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cost_usd: 0,
			model_calls: 0,
			agent_stages: 0,
			search_attempts: 0,
		},
		started_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T01:00:00.000Z",
		finished_at: "2026-01-01T01:00:00.000Z",
	});
	const organizedGoalId = "goal_organized_baseline";
	const organizedRunId = "run-organized-published";
	const organizedGoalDir = join(workspaceDir, organizedGoalId);
	const organizedWikiRunDir = join(organizedGoalDir, "wiki", "runs", organizedRunId);
	const organizedControlRunDir = join(
		serverRuntimeDirForGoal(organizedGoalId, workspaceDir),
		"runs",
		organizedRunId,
	);
	const organizedBundlePath = "artifacts/source-bundles/bundle-1";
	const findOutPath = "artifacts/find-out-sources/sequence-1";
	const organizedEvidencePath = "artifacts/cornell-notes/snapshot-seed.json";
	const logicalSourceId = "source:logical-project";
	const logicalRevision = "f".repeat(64);
	mkdirSync(join(organizedWikiRunDir, organizedBundlePath), { recursive: true });
	mkdirSync(join(organizedWikiRunDir, findOutPath), { recursive: true });
	mkdirSync(join(organizedWikiRunDir, "artifacts", "cornell-notes"), { recursive: true });
	mkdirSync(organizedControlRunDir, { recursive: true });
	writeFileSync(join(organizedWikiRunDir, "README.md"), [
		`# Run ${organizedRunId}`,
		"",
		`Goal: ${organizedGoalId}`,
		"",
	].join("\n"), "utf-8");
	writeFileSync(join(organizedWikiRunDir, organizedBundlePath, "source-index.json"), `${JSON.stringify({
		schema_version: 1,
		provider_id: "github",
		sources: [{
			candidate_id: "github:project",
			source_id: "source:provider-project",
			url: "https://github.com/example/project",
			files: [{ path: "README.md", sha256: "e".repeat(64) }],
		}],
	}, null, 2)}\n`, "utf-8");
	// Pinned, not read from the pipeline: a fixture that shares the constant can never
	// fail when producer and consumer drift apart, which is what hid this mismatch.
	assert.equal(FIND_OUT_SOURCE_MANIFEST_SCHEMA_VERSION, 3, "the Find Out Source manifest version changed");
	writeFileSync(join(organizedWikiRunDir, findOutPath, "manifest.json"), `${JSON.stringify({
		schema_version: 3,
		sequence: 1,
		sources: [{
			source_id: logicalSourceId,
			title: "Project paper and implementation",
			path: "sources/source-logical-project",
			organization_kind: "cross_provider",
			organization_reason: "Same project.",
			members: [{
				candidate_id: "github:project",
				source_id: "source:provider-project",
				provider_id: "github",
				title: "Project",
				canonical_locator: "https://github.com/example/project",
				path: "members/github/project",
				summary: "Implementation",
			}],
			revision_sha256: logicalRevision,
		}],
	}, null, 2)}\n`, "utf-8");
	writeFileSync(join(organizedWikiRunDir, organizedEvidencePath), `${JSON.stringify({
		schema_version: 1,
		notes: [{ note: { source_id: logicalSourceId } }],
	}, null, 2)}\n`, "utf-8");
	writeFileSync(join(organizedControlRunDir, "run-state.json"), `${JSON.stringify(runState({
		runId: organizedRunId,
		goalId: organizedGoalId,
		status: "published",
		sourceBundles: [organizedBundlePath],
		findOutSources: [findOutPath],
		cornellNoteSnapshots: [organizedEvidencePath],
	}), null, 2)}\n`, "utf-8");
	const organizedBaseline = readProcessedResearchRun({
		goalDir: organizedGoalDir,
		controlRunDir: organizedControlRunDir,
		runId: organizedRunId,
	});
	assert.deepEqual(organizedBaseline.sources, [{
		sourceIdentity: logicalSourceId,
		contentSha256: logicalRevision,
	}], "a Schedule baseline must use the logical Find Out Sources with Cornell Notes");

	const activateTopicPlan = (goal: string) => {
		const topicPlan = new GoalTopicPlanStore(goal, workspaceDir);
		topicPlan.activate(topicPlan.proposePatch({
			source: "main_agent",
			patch: {
				schema_version: 1,
				base_revision: null,
				summary: "Baseline Topic",
				operations: [{
					op: "add",
					topic: {
						id: "releases",
						title: "Releases",
						intent: "Track releases",
						questions: [],
						include: [],
						exclude: [],
					},
				}],
			},
		}).proposal_id);
	};
	activateTopicPlan(organizedGoalId);
	writeBaselineResumeRequest(
		organizedGoalId,
		organizedRunId,
		"Write for the launch review board.",
	);
	assert.equal(createResearchScheduleFromRun({
		workspaceDir,
		goalId: organizedGoalId,
		title: "Copied from the baseline",
		monitoringScope: "Monitor the project.",
		sourceRunId: organizedRunId,
		cron: "0 9 * * *",
		timeZone: "UTC",
	}).reportContext, "Write for the launch review board.",
	"creating a Research Schedule must copy the baseline Run's Report Context onto it");
	assert.deepEqual(
		((): unknown[] => {
			const store = new ResearchScheduleStore(organizedGoalId, workspaceDir);
			try {
				return store.list()[0]!.sourceGaps;
			} finally {
				store.close();
			}
		})(),
		[],
		"a Run whose every Source has a Cornell Note leaves no Source gap behind",
	);

	// A Research Run may publish with Cornell Note gaps it recorded itself. Those Sources stay out
	// of the Schedule's processed set so a later occurrence reads them again, and the gap is kept.
	const gapNoteSha = (index: number) => index.toString(16).padStart(64, "0");
	const writeRunFixture = (input: {
		goalId: string;
		runId: string;
		sources: string[];
		revisionOf?: (sourceId: string) => string;
		notedSourceIds: string[];
		failureManifests?: unknown[];
		status?: string;
	}) => {
		const goalDir = join(workspaceDir, input.goalId);
		const wikiRunDir = join(goalDir, "wiki", "runs", input.runId);
		const controlRunDir = join(
			serverRuntimeDirForGoal(input.goalId, workspaceDir),
			"runs",
			input.runId,
		);
		const evidencePath = "artifacts/cornell-notes/snapshot-1.json";
		const revisionOf = input.revisionOf
			?? ((sourceId: string) => gapNoteSha(input.sources.indexOf(sourceId) + 1));
		mkdirSync(join(wikiRunDir, findOutPath), { recursive: true });
		mkdirSync(join(wikiRunDir, "artifacts", "cornell-notes"), { recursive: true });
		mkdirSync(controlRunDir, { recursive: true });
		writeFileSync(join(wikiRunDir, findOutPath, "manifest.json"), `${JSON.stringify({
			schema_version: FIND_OUT_SOURCE_MANIFEST_SCHEMA_VERSION,
			sequence: 1,
			sources: input.sources.map((sourceId) => ({
				source_id: sourceId,
				title: sourceId,
				path: `sources/${sourceId}`,
				organization_kind: "ungrouped",
				members: [{
					candidate_id: sourceId,
					source_id: sourceId,
					provider_id: "general_web",
					title: sourceId,
					canonical_locator: `https://example.com/${sourceId}`,
					path: `members/${sourceId}`,
					summary: "Member",
				}],
				revision_sha256: revisionOf(sourceId),
			})),
		}, null, 2)}\n`, "utf-8");
		writeFileSync(join(wikiRunDir, evidencePath), `${JSON.stringify({
			schema_version: 1,
			notes: input.notedSourceIds.map((sourceId) => ({ note: { source_id: sourceId } })),
		}, null, 2)}\n`, "utf-8");
		const failurePaths = (input.failureManifests ?? []).map((manifest, index) => {
			const path = `artifacts/cornell-notes/failures-${index + 1}.json`;
			writeFileSync(join(wikiRunDir, path), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
			return path;
		});
		writeFileSync(join(controlRunDir, "run-state.json"), `${JSON.stringify(runState({
			runId: input.runId,
			goalId: input.goalId,
			status: input.status ?? "published",
			findOutSources: [findOutPath],
			cornellNoteSnapshots: [evidencePath],
			...(failurePaths.length ? { cornellNoteFailureManifests: failurePaths } : {}),
		}), null, 2)}\n`, "utf-8");
		writeBaselineResumeRequest(input.goalId, input.runId, "Write for the launch review board.");
		return { goalDir, controlRunDir };
	};
	const noteFailure = (runId: string, sourceIds: string[]) => ({
		schema_version: 1,
		run_id: runId,
		sequence: 1,
		failures: sourceIds.map((sourceId) => ({
			source_id: sourceId,
			title: sourceId,
			canonical_locator: `https://example.com/${sourceId}`,
			failure_class: "agent_stage_failed",
			message: "Agent is already processing.",
		})),
	});

	const partialGoalId = "goal_partial_baseline";
	const partialRunId = "run-partial-baseline";
	const partialSources = Array.from({ length: 47 }, (_, index) => `source:partial-${index + 1}`);
	const failedSource = partialSources.at(-1)!;
	const recoveredSource = partialSources.at(-2)!;
	const partialRun = writeRunFixture({
		goalId: partialGoalId,
		runId: partialRunId,
		sources: partialSources,
		notedSourceIds: partialSources.filter((sourceId) => sourceId !== failedSource),
		// The first attempt at the second-to-last Source failed and a later one produced its Note:
		// the Note wins, so only the Source that never got one is a gap.
		failureManifests: [
			noteFailure(partialRunId, [recoveredSource]),
			noteFailure(partialRunId, [failedSource]),
		],
	});
	const partialBaseline = readProcessedResearchRun({
		goalDir: partialRun.goalDir,
		controlRunDir: partialRun.controlRunDir,
		runId: partialRunId,
	});
	assert.equal(partialBaseline.sources.length, 46,
		"a recorded Cornell Note failure must not disqualify the 46 Sources that were read");
	assert.deepEqual(partialBaseline.unprocessedSources.map((source) => source.sourceIdentity),
		[failedSource],
		"only the Source with a recorded and unrecovered Note failure is left unprocessed");
	assert.ok(partialBaseline.sources.some((source) => source.sourceIdentity === recoveredSource),
		"a Cornell Note produced after an earlier recorded failure still counts as read");

	activateTopicPlan(partialGoalId);
	const partialSchedule = createResearchScheduleFromRun({
		workspaceDir,
		goalId: partialGoalId,
		title: "Weekly open TTS models",
		monitoringScope: "Monitor newly published open source TTS models.",
		sourceRunId: partialRunId,
		cron: "0 9 * * 1",
		timeZone: "Asia/Singapore",
	});
	const reopenedPartial = new ResearchScheduleStore(partialGoalId, workspaceDir);
	assert.deepEqual(
		reopenedPartial.get(partialSchedule.id)?.sourceGaps.map((gap) => ({
			sourceIdentity: gap.sourceIdentity,
			runId: gap.runId,
		})),
		[{ sourceIdentity: failedSource, runId: partialRunId }],
		"the baseline's Cornell Note gap must survive the store that recorded it",
	);
	const partialOccurrence = reopenedPartial.requestRunNow(partialSchedule.id);
	reopenedPartial.close();

	const occurrenceRunId = "run-partial-occurrence";
	const newSource = "source:partial-48";
	// The occurrence retries the gap Source and fails it again, and reads one new Source.
	writeRunFixture({
		goalId: partialGoalId,
		runId: occurrenceRunId,
		sources: [failedSource, newSource],
		revisionOf: (sourceId) => (sourceId === failedSource ? gapNoteSha(47) : gapNoteSha(48)),
		notedSourceIds: [newSource],
		failureManifests: [noteFailure(occurrenceRunId, [failedSource])],
	});
	let claimedProcessed: Array<{ sourceIdentity: string }> = [];
	const partialScheduler = new ResearchScheduleScheduler(workspaceDir, {
		listGoals: () => [{ id: partialGoalId }],
		isGoalActive: () => false,
		runScheduledResearch: async (request: {
			context: { processedSources: Array<{ sourceIdentity: string }> };
		}) => {
			claimedProcessed = request.context.processedSources;
			return { runId: occurrenceRunId, status: "published" };
		},
	} as unknown as GoalService,
	new ResearchScheduleReviewService(workspaceDir, async () => ({ decision: "no_change" })));
	const partialRunOf = (runId: string) => {
		const store = new ResearchScheduleStore(partialGoalId, workspaceDir);
		try {
			return store.get(partialSchedule.id)!.runs.find((run) => run.id === runId);
		} finally {
			store.close();
		}
	};
	await partialScheduler.tick();
	for (let attempt = 0; attempt < 200 && partialRunOf(partialOccurrence.id)?.status === "running"; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(partialRunOf(partialOccurrence.id)?.status, "published");
	assert.equal(claimedProcessed.length, 46);
	assert.ok(!claimedProcessed.some((source) => source.sourceIdentity === failedSource),
		"a Source left unprocessed by the baseline must be offered to the next occurrence again");
	const afterOccurrence = new ResearchScheduleStore(partialGoalId, workspaceDir);
	assert.deepEqual(
		afterOccurrence.get(partialSchedule.id)?.sourceGaps.map((gap) => ({
			sourceIdentity: gap.sourceIdentity,
			runId: gap.runId,
		})),
		[{ sourceIdentity: failedSource, runId: occurrenceRunId }],
		"a published occurrence records its own Cornell Note gaps",
	);
	afterOccurrence.close();

	// A gap is only resolved by a Run that actually reads that exact Source revision: neither an
	// already processed older revision nor a later Run reading a different one is coverage for it.
	const revisionGoalId = "goal_revision_gaps";
	const revisionStore = new ResearchScheduleStore(revisionGoalId, workspaceDir);
	const revisionSource = { sourceIdentity: "source:revised", contentSha256: gapNoteSha(1) };
	const revisionSchedule = revisionStore.create({
		title: "Revision gaps",
		question: "What changed?",
		monitoringScope: "Monitor the Source.",
		reportContext: "Write for the review board.",
		cron: "0 9 * * *",
		timeZone: "UTC",
		initializedFromRunId: "run-revision-baseline",
		coveredThrough: "2026-01-01T00:00:00.000Z",
		sources: [revisionSource],
		now: new Date("2026-01-01T00:00:00.000Z"),
	});
	const completeRevision = (input: {
		researchRunId: string;
		sources: Array<typeof revisionSource>;
		sourceGaps: Array<typeof revisionSource>;
		now: string;
	}) => {
		const run = revisionStore.requestRunNow(revisionSchedule.id, new Date(input.now));
		revisionStore.claimNext(new Date(input.now));
		revisionStore.complete({
			runId: run.id,
			status: "published",
			researchRunId: input.researchRunId,
			discoveredSources: 1,
			incrementalSources: 1,
			cornellNotes: input.sources.length,
			sources: input.sources,
			sourceGaps: input.sourceGaps,
			now: new Date(input.now),
		});
	};
	const failedRevision = { ...revisionSource, contentSha256: gapNoteSha(2) };
	completeRevision({
		researchRunId: "run-revision-failed",
		sources: [],
		sourceGaps: [failedRevision],
		now: "2026-01-02T00:00:00.000Z",
	});
	revisionStore.close();
	const reopenedRevision = new ResearchScheduleStore(revisionGoalId, workspaceDir);
	assert.deepEqual(
		reopenedRevision.get(revisionSchedule.id)?.sourceGaps.map((gap) => gap.contentSha256),
		[failedRevision.contentSha256],
		"an already processed older revision must not cancel a newer revision's Cornell Note gap",
	);
	const revisionClaim = reopenedRevision.requestRunNow(
		revisionSchedule.id,
		new Date("2026-01-03T00:00:00.000Z"),
	);
	assert.deepEqual(
		reopenedRevision.claimNext(new Date("2026-01-03T00:00:00.000Z"))?.processedSources,
		[revisionSource],
		"the processed set still holds the revision that was actually read",
	);
	const laterRevision = { ...revisionSource, contentSha256: gapNoteSha(3) };
	reopenedRevision.complete({
		runId: revisionClaim.id,
		status: "published",
		researchRunId: "run-revision-moved-on",
		discoveredSources: 1,
		incrementalSources: 1,
		cornellNotes: 1,
		sources: [laterRevision],
		now: new Date("2026-01-03T00:01:00.000Z"),
	});
	assert.deepEqual(
		reopenedRevision.get(revisionSchedule.id)?.sourceGaps.map((gap) => gap.contentSha256),
		[failedRevision.contentSha256],
		"reading a different revision of the Source does not prove the failed revision was read",
	);
	const recoveryRun = reopenedRevision.requestRunNow(
		revisionSchedule.id,
		new Date("2026-01-04T00:00:00.000Z"),
	);
	reopenedRevision.claimNext(new Date("2026-01-04T00:00:00.000Z"));
	reopenedRevision.complete({
		runId: recoveryRun.id,
		status: "published",
		researchRunId: "run-revision-recovered",
		discoveredSources: 1,
		incrementalSources: 1,
		cornellNotes: 1,
		sources: [failedRevision],
		now: new Date("2026-01-04T00:01:00.000Z"),
	});
	assert.deepEqual(reopenedRevision.get(revisionSchedule.id)?.sourceGaps, [],
		"reading the revision that failed resolves its gap");
	reopenedRevision.close();

	// An unrecorded gap is still a broken Run, and the error has to say what is missing.
	const unrecordedGoalId = "goal_unrecorded_gap";
	const unrecordedRunId = "run-unrecorded-gap";
	const unrecordedRun = writeRunFixture({
		goalId: unrecordedGoalId,
		runId: unrecordedRunId,
		sources: ["source:read", "source:silent"],
		notedSourceIds: ["source:read"],
	});
	assert.throws(() => readProcessedResearchRun({
		goalDir: unrecordedRun.goalDir,
		controlRunDir: unrecordedRun.controlRunDir,
		runId: unrecordedRunId,
	}), /produced 2 Sources, and 1 of them have neither a Cornell Note nor a recorded Note failure: source:silent/u,
	"an unrecorded Cornell Note gap must report the totals and the Sources it is missing");

	// A failure manifest belonging to another Run may not excuse this Run's missing Notes.
	const foreignGoalId = "goal_foreign_manifest";
	const foreignRunId = "run-foreign-manifest";
	const foreignRun = writeRunFixture({
		goalId: foreignGoalId,
		runId: foreignRunId,
		sources: ["source:read", "source:silent"],
		notedSourceIds: ["source:read"],
		failureManifests: [noteFailure("run-somewhere-else", ["source:silent"])],
	});
	assert.throws(() => readProcessedResearchRun({
		goalDir: foreignRun.goalDir,
		controlRunDir: foreignRun.controlRunDir,
		runId: foreignRunId,
	}), /failure manifest 'artifacts\/cornell-notes\/failures-1.json' is invalid/u);

	// A malformed failure manifest is a broken Run, not a licence to drop Sources.
	const malformedGoalId = "goal_malformed_manifest";
	const malformedRunId = "run-malformed-manifest";
	const malformedRun = writeRunFixture({
		goalId: malformedGoalId,
		runId: malformedRunId,
		sources: ["source:read", "source:silent"],
		notedSourceIds: ["source:read"],
		failureManifests: [{
			schema_version: 1,
			run_id: malformedRunId,
			sequence: 1,
			failures: [{ title: "No source_id", canonical_locator: "https://example.com", message: "x" }],
		}],
	});
	assert.throws(() => readProcessedResearchRun({
		goalDir: malformedRun.goalDir,
		controlRunDir: malformedRun.controlRunDir,
		runId: malformedRunId,
	}), /failure manifest 'artifacts\/cornell-notes\/failures-1.json' has an invalid failure/u);

	// Every Source recorded as failed: the reader reports it, and creation rejects it clearly.
	const emptyGoalId = "goal_empty_baseline";
	const emptyRunId = "run-empty-baseline";
	writeRunFixture({
		goalId: emptyGoalId,
		runId: emptyRunId,
		sources: ["source:one", "source:two"],
		notedSourceIds: [],
		failureManifests: [noteFailure(emptyRunId, ["source:one", "source:two"])],
	});
	activateTopicPlan(emptyGoalId);
	assert.throws(() => createResearchScheduleFromRun({
		workspaceDir,
		goalId: emptyGoalId,
		title: "Nothing to monitor",
		monitoringScope: "Monitor the project.",
		sourceRunId: emptyRunId,
		cron: "0 9 * * *",
		timeZone: "UTC",
	}), /has a Cornell Note for none of its 2 Sources/u,
	"a baseline with no readable Source cannot start a Research Schedule");

	// An occurrence that found no new Source keeps reporting nothing at all.
	const skippedGoalId = "goal_skipped_increment";
	const skippedRunId = "run-skipped-increment";
	const skippedControlRunDir = join(
		serverRuntimeDirForGoal(skippedGoalId, workspaceDir),
		"runs",
		skippedRunId,
	);
	mkdirSync(skippedControlRunDir, { recursive: true });
	writeFileSync(join(skippedControlRunDir, "run-state.json"), `${JSON.stringify(runState({
		runId: skippedRunId,
		goalId: skippedGoalId,
		status: "skipped",
		skipReason: "no_source_increment",
	}), null, 2)}\n`, "utf-8");
	assert.deepEqual(readProcessedResearchRun({
		goalDir: join(workspaceDir, skippedGoalId),
		controlRunDir: skippedControlRunDir,
		runId: skippedRunId,
	}), {
		runId: skippedRunId,
		question: "What changed?",
		startedAt: "2026-01-01T00:00:00.000Z",
		status: "skipped",
		sources: [],
		unprocessedSources: [],
		discoveredSources: 0,
		cornellNotes: 0,
	});

	// Runtime triggers Research Schedule Reviews on its existing tick.
	const triggerGoalId = "goal_review_trigger";
	const triggerGoalDir = join(workspaceDir, triggerGoalId);
	mkdirSync(triggerGoalDir, { recursive: true });
	const writeUserMessages = (count: number) => {
		writeFileSync(join(triggerGoalDir, "context.jsonl"), Array.from(
			{ length: count },
			(_, index) => JSON.stringify({
				type: "message",
				id: `m-${index}`,
				message: { role: index % 2 === 0 ? "user" : "assistant", content: [] },
			}),
		).join("\n"), "utf-8");
	};
	const triggerStore = new ResearchScheduleStore(triggerGoalId, workspaceDir);
	const createTriggerSchedule = (title: string) => triggerStore.create({
		title,
		question: "What changed?",
		monitoringScope: "Monitor the confirmed scope.",
		reportContext: "Write under the confirmed Report Context.",
		cron: "0 9 * * *",
		timeZone: "UTC",
		initializedFromRunId: "run-trigger-baseline",
		coveredThrough: "2026-01-01T00:00:00.000Z",
		sources: [],
		now: new Date("2026-01-01T00:00:00.000Z"),
	});
	const activeSchedule = createTriggerSchedule("Reviewed on the tick");
	const pausedSchedule = triggerStore.pause(createTriggerSchedule("Paused").id);
	const archivedSchedule = triggerStore.archive(createTriggerSchedule("Archived").id);
	triggerStore.close();

	const reviewReasons: string[] = [];
	const unsubscribeReviews = subscribe((event) => {
		if (event.type === "research/schedules:changed" && event.goalId === triggerGoalId
			&& String(event.reason).startsWith("reviewed_")) {
			reviewReasons.push(String(event.reason));
		}
	});
	let reviewerOutput: () => Promise<unknown> = async () => ({ decision: "no_change" });
	const reviewedSchedules: string[] = [];
	const triggerScheduler = new ResearchScheduleScheduler(
		workspaceDir,
		{
			listGoals: () => [{ id: triggerGoalId }],
			isGoalActive: () => false,
		} as unknown as GoalService,
		new ResearchScheduleReviewService(workspaceDir, async (input) => {
			reviewedSchedules.push(input.schedule.id);
			return reviewerOutput();
		}),
	);
	const reviewsOf = (scheduleId: string) => {
		const store = new ResearchScheduleStore(triggerGoalId, workspaceDir);
		try {
			return store.listReviews(scheduleId);
		} finally {
			store.close();
		}
	};
	const proposalsOf = (scheduleId: string) => {
		const store = new ResearchScheduleStore(triggerGoalId, workspaceDir);
		try {
			return store.listProposals(scheduleId);
		} finally {
			store.close();
		}
	};
	const settle = async (until: () => boolean) => {
		for (let attempt = 0; attempt < 200 && !until(); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	const tickUntil = async (now: string, until: () => boolean) => {
		await triggerScheduler.tick(new Date(now));
		await settle(until);
	};
	/** A tick that must not start a Review: settle long enough that one would have shown up. */
	const tickQuietly = async (now: string) => {
		await triggerScheduler.tick(new Date(now));
		await new Promise((resolve) => setTimeout(resolve, 50));
	};

	writeUserMessages(4);
	await tickQuietly("2026-01-02T00:00:00.000Z");
	assert.deepEqual(reviewedSchedules, [],
		"below both thresholds no Research Schedule is reviewed");
	assert.deepEqual(reviewReasons, []);

	await tickUntil("2026-01-08T00:00:01.000Z", () => reviewsOf(activeSchedule.id).length === 1);
	assert.deepEqual(reviewedSchedules, [activeSchedule.id],
		"more than 7 days since the last Review triggers one, and only for the active Schedule");
	assert.equal(reviewsOf(activeSchedule.id)[0]?.status, "no_change");
	assert.deepEqual(reviewReasons, ["reviewed_no_change"]);
	const afterElapsed = (() => {
		const store = new ResearchScheduleStore(triggerGoalId, workspaceDir);
		try {
			return store.get(activeSchedule.id)!;
		} finally {
			store.close();
		}
	})();
	assert.equal(afterElapsed.lastReviewedUserMessageCount, 2,
		"a Review records the user-message cursor it counted from");
	assert.equal(afterElapsed.monitoringScope, activeSchedule.monitoringScope,
		"a no_change Review leaves the Schedule's parameters untouched");

	// The same tick again: bookkeeping advanced, so nothing is due.
	await tickQuietly("2026-01-08T00:00:02.000Z");
	assert.equal(reviewedSchedules.length, 1, "a Review is not repeated until the trigger fires again");

	// More than 10 new user messages in the Goal triggers the next Review.
	writeUserMessages(30);
	reviewerOutput = async () => ({
		decision: "propose",
		monitoringScope: "Monitor the confirmed scope and its security advisories.",
		reportContext: "Write under the confirmed Report Context.",
		summary: "Widen the scope to security advisories.",
		rationale: "The user keeps asking about advisories.",
		evidence: ["memory:m-1"],
	});
	await tickUntil("2026-01-08T00:00:03.000Z", () => reviewsOf(activeSchedule.id).length === 2);
	assert.equal(reviewedSchedules.length, 2,
		"more than 10 new user messages triggers a Review before the 7 days are up");
	assert.equal(reviewsOf(activeSchedule.id).length, 2);
	assert.equal(reviewsOf(activeSchedule.id)[0]?.status, "proposed");
	assert.deepEqual(proposalsOf(activeSchedule.id).map((proposal) => proposal.status), ["proposed"]);

	// A second Proposal supersedes the first, so the user only ever faces one open suggestion.
	writeUserMessages(54);
	await tickUntil("2026-01-08T00:00:03.500Z", () => reviewsOf(activeSchedule.id).length === 3);
	assert.equal(reviewsOf(activeSchedule.id)[0]?.status, "proposed");
	assert.deepEqual(
		proposalsOf(activeSchedule.id).map((proposal) => proposal.status).sort(),
		["proposed", "superseded"],
		"a Review triggered on the tick supersedes the Proposal still open on the Schedule",
	);

	// A failing Reviewer is recorded and not retried on the next tick.
	writeUserMessages(80);
	reviewerOutput = async () => { throw new Error("memory service unavailable"); };
	await tickUntil("2026-01-08T00:00:04.000Z", () => reviewsOf(activeSchedule.id).length === 4);
	assert.equal(reviewsOf(activeSchedule.id)[0]?.status, "failed");
	assert.match(reviewsOf(activeSchedule.id)[0]?.reason ?? "", /memory service unavailable/u);
	await tickQuietly("2026-01-08T00:00:05.000Z");
	assert.equal(reviewsOf(activeSchedule.id).length, 4,
		"a failed Review is not retried until the trigger fires again");
	assert.deepEqual(reviewReasons, [
		"reviewed_no_change",
		"reviewed_proposed",
		"reviewed_proposed",
		"reviewed_failed",
	]);

	assert.deepEqual(reviewsOf(pausedSchedule.id), [], "a paused Research Schedule is never reviewed");
	assert.deepEqual(reviewsOf(archivedSchedule.id), [],
		"an archived Research Schedule is never reviewed");

	// One Reviewer per Schedule: a tick never starts a second Review while one runs.
	let releaseReviewer: () => void = () => undefined;
	reviewerOutput = async () => {
		await new Promise<void>((resolve) => { releaseReviewer = resolve; });
		return { decision: "no_change" };
	};
	writeUserMessages(200);
	await triggerScheduler.tick(new Date("2026-01-08T00:00:06.000Z"));
	await settle(() => reviewedSchedules.length === 5);
	await triggerScheduler.tick(new Date("2026-01-08T00:00:07.000Z"));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(reviewedSchedules.length, 5,
		"a tick does not start a second Review while one is already running");
	releaseReviewer();
	await settle(() => reviewsOf(activeSchedule.id).length === 5);
	assert.equal(reviewsOf(activeSchedule.id).length, 5);

	// A half-written transcript line must not stop the trigger: the Reviewer still runs and the
	// Review is still recorded, so a live Main Agent conversation cannot wedge the tick.
	reviewerOutput = async () => ({ decision: "no_change" });
	writeUserMessages(240);
	appendFileSync(join(triggerGoalDir, "context.jsonl"), '\n{"type":"message","mess', "utf-8");
	await tickUntil("2026-01-08T00:00:08.000Z", () => reviewsOf(activeSchedule.id).length === 6);
	assert.equal(reviewsOf(activeSchedule.id).length, 6,
		"an unreadable transcript line must not stop the Review trigger");
	assert.equal(reviewsOf(activeSchedule.id)[0]?.status, "no_change");
	unsubscribeReviews();

	console.log("research schedule tests passed");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}
