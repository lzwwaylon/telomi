import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cron } from "croner";

import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import type { ScheduleReviewOutput } from "./review-contract.js";
import type {
	ClaimedResearchScheduleRun,
	ResearchSchedule,
	ResearchScheduleProposal,
	ResearchScheduleProposalStatus,
	ResearchScheduleReview,
	ResearchScheduleReviewStatus,
	ResearchScheduleRun,
	ResearchScheduleRunStatus,
	ResearchScheduleSource,
	ResearchScheduleSourceGap,
	ResearchScheduleStatus,
} from "./types.js";

/** 一次 Reviewer 执行的结果：契约接受的决定，或者带原因的失败。 */
export type ResearchScheduleReviewOutcome =
	| ScheduleReviewOutput
	| { decision: "failed"; reason: string };

type SqlValue = null | number | bigint | string | Uint8Array;
type SqlRow = Record<string, SqlValue>;

export class ResearchScheduleStore {
	readonly databasePath: string;
	private readonly db: DatabaseSync;

	constructor(
		readonly goalId: string,
		workspaceDir?: string,
	) {
		this.databasePath = join(
			serverRuntimeDirForGoal(goalId, workspaceDir),
			"research/schedules.sqlite",
		);
		mkdirSync(dirname(this.databasePath), { recursive: true });
		this.db = new DatabaseSync(this.databasePath, { timeout: 10_000 });
		this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
		this.initialize();
	}

	close(): void {
		this.db.close();
	}

	create(input: {
		title: string;
		question: string;
		monitoringScope: string;
		reportContext: string;
		cron: string;
		timeZone: string;
		initializedFromRunId: string;
		coveredThrough: string;
		sources: ResearchScheduleSource[];
		sourceGaps?: ResearchScheduleSource[];
		now?: Date;
	}): ResearchSchedule {
		const title = required(input.title, "title");
		const question = required(input.question, "question");
		const monitoringScope = required(input.monitoringScope, "monitoringScope");
		const reportContext = required(input.reportContext, "reportContext");
		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const cron = validateCron(input.cron, input.timeZone);
		const id = `schedule_${randomUUID()}`;
		const nextRunAt = nextCronRun(cron, input.timeZone, now);
		this.transaction(() => {
			this.db.prepare(`
				INSERT INTO research_schedules (
					id, goal_id, title, question, monitoring_scope, report_context, cron, timezone, status,
					initialized_from_run_id, covered_through, next_run_at, created_at, updated_at,
					last_reviewed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
			`).run(
				id,
				this.goalId,
				title,
				question,
				monitoringScope,
				reportContext,
				cron,
				input.timeZone,
				required(input.initializedFromRunId, "initializedFromRunId"),
				validInstant(input.coveredThrough, "coveredThrough"),
				nextRunAt,
				nowIso,
				nowIso,
				nowIso,
			);
			const insert = this.db.prepare(`
				INSERT OR IGNORE INTO research_schedule_sources (
					schedule_id, source_identity, content_sha256, first_run_id, processed_at
				) VALUES (?, ?, ?, ?, ?)
			`);
			for (const source of input.sources) {
				insert.run(
					id,
					source.sourceIdentity,
					validSha256(source.contentSha256, "contentSha256"),
					input.initializedFromRunId,
					nowIso,
				);
			}
			this.recordSourceGaps(id, {
				processed: input.sources,
				gaps: input.sourceGaps ?? [],
				runId: input.initializedFromRunId,
				now: nowIso,
			});
		});
		return this.getRequired(id);
	}

	list(): ResearchSchedule[] {
		return (this.db.prepare(`
			SELECT * FROM research_schedules ORDER BY
				CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
				created_at DESC
		`).all() as SqlRow[]).map((row) => this.toSchedule(row));
	}

	listRuns(): ResearchScheduleRun[] {
		return (this.db.prepare(`
			SELECT research_schedule_runs.*
			FROM research_schedule_runs
			INNER JOIN research_schedules
				ON research_schedules.id = research_schedule_runs.schedule_id
			WHERE research_schedules.goal_id=?
			ORDER BY scheduled_for DESC, research_schedule_runs.id DESC
		`).all(this.goalId) as SqlRow[]).map((row) => this.toRun(row));
	}

	get(id: string): ResearchSchedule | undefined {
		const row = this.db.prepare(
			"SELECT * FROM research_schedules WHERE id=? AND goal_id=?",
		).get(id, this.goalId) as SqlRow | undefined;
		return row ? this.toSchedule(row) : undefined;
	}

	pause(id: string, now = new Date()): ResearchSchedule {
		const schedule = this.getRequired(id);
		if (schedule.status === "archived") throw new Error("Archived Research Schedule cannot be paused");
		if (schedule.status === "paused") return schedule;
		this.db.prepare(`
			UPDATE research_schedules
			SET status='paused', next_run_at=NULL, updated_at=?
			WHERE id=?
		`).run(now.toISOString(), id);
		return this.getRequired(id);
	}

	resume(id: string, now = new Date()): ResearchSchedule {
		const schedule = this.getRequired(id);
		if (schedule.status === "archived") throw new Error("Archived Research Schedule cannot be resumed");
		if (schedule.status === "active") return schedule;
		this.db.prepare(`
			UPDATE research_schedules
			SET status='active', next_run_at=?, updated_at=?
			WHERE id=?
		`).run(nextCronRun(schedule.cron, schedule.timeZone, now), now.toISOString(), id);
		return this.getRequired(id);
	}

	update(
		id: string,
		patch: {
			title?: string;
			monitoringScope?: string;
			reportContext?: string;
			cron?: string;
			timeZone?: string;
		},
		now = new Date(),
	): ResearchSchedule {
		const schedule = this.getRequired(id);
		if (schedule.status === "archived") throw new Error("Archived Research Schedule cannot be updated");
		const title = patch.title === undefined ? schedule.title : required(patch.title, "title");
		const monitoringScope = patch.monitoringScope === undefined
			? schedule.monitoringScope
			: required(patch.monitoringScope, "monitoringScope");
		const reportContext = patch.reportContext === undefined
			? schedule.reportContext
			: required(patch.reportContext, "reportContext");
		const timeZone = patch.timeZone ?? schedule.timeZone;
		const cron = validateCron(patch.cron ?? schedule.cron, timeZone);
		const nextRunAt = schedule.status === "active"
			? nextCronRun(cron, timeZone, now)
			: null;
		this.db.prepare(`
			UPDATE research_schedules
			SET title=?, monitoring_scope=?, report_context=?, cron=?, timezone=?,
				next_run_at=?, updated_at=?
			WHERE id=?
		`).run(title, monitoringScope, reportContext, cron, timeZone, nextRunAt, now.toISOString(), id);
		return this.getRequired(id);
	}

	archive(id: string, now = new Date()): ResearchSchedule {
		const schedule = this.getRequired(id);
		if (schedule.runs.some((run) => run.status === "scheduled" || run.status === "running")) {
			throw new Error("Research Schedule cannot be archived while a Run is pending");
		}
		this.db.prepare(`
			UPDATE research_schedules
			SET status='archived', next_run_at=NULL, updated_at=?
			WHERE id=?
		`).run(now.toISOString(), id);
		return this.getRequired(id);
	}

	requestRunNow(id: string, now = new Date()): ResearchScheduleRun {
		const schedule = this.getRequired(id);
		if (schedule.status === "archived") throw new Error("Archived Research Schedule cannot run");
		if (schedule.runs.some((run) => run.status === "scheduled" || run.status === "running")) {
			throw new Error("Research Schedule already has an active Run");
		}
		return this.insertOccurrence(schedule, now.toISOString(), now.toISOString());
	}

	claimNext(now = new Date()): ClaimedResearchScheduleRun | undefined {
		const nowIso = now.toISOString();
		return this.transaction(() => {
			const active = this.db.prepare(`
				SELECT 1 FROM research_schedule_runs
				WHERE status='running' LIMIT 1
			`).get();
			if (active) return undefined;
			let runRow = this.db.prepare(`
				SELECT r.* FROM research_schedule_runs r
				JOIN research_schedules s ON s.id=r.schedule_id
				WHERE r.status='scheduled' AND s.status!='archived'
				ORDER BY r.created_at ASC LIMIT 1
			`).get() as SqlRow | undefined;
			if (!runRow) {
				const scheduleRow = this.db.prepare(`
					SELECT * FROM research_schedules
					WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at<=?
					AND NOT EXISTS (
						SELECT 1 FROM research_schedule_runs r
						WHERE r.schedule_id=research_schedules.id
						AND r.status IN ('scheduled', 'running')
					)
					ORDER BY next_run_at ASC LIMIT 1
				`).get(nowIso) as SqlRow | undefined;
				if (!scheduleRow) return undefined;
				const schedule = this.toSchedule(scheduleRow);
				let scheduledFor = new Date(schedule.nextRunAt!);
				let nextRunAt = nextCronRun(schedule.cron, schedule.timeZone, scheduledFor);
				while (Date.parse(nextRunAt) <= now.getTime()) {
					scheduledFor = new Date(nextRunAt);
					nextRunAt = nextCronRun(schedule.cron, schedule.timeZone, scheduledFor);
				}
				const inserted = this.insertOccurrence(
					schedule,
					scheduledFor.toISOString(),
					nowIso,
				);
				this.db.prepare(`
					UPDATE research_schedules SET next_run_at=?, updated_at=? WHERE id=?
				`).run(nextRunAt, nowIso, schedule.id);
				runRow = this.db.prepare(
					"SELECT * FROM research_schedule_runs WHERE id=?",
				).get(inserted.id) as SqlRow;
			}
			this.db.prepare(`
				UPDATE research_schedule_runs
				SET status='running', started_at=?
				WHERE id=? AND status='scheduled'
			`).run(nowIso, String(runRow.id));
			const run = this.toRun({
				...runRow,
				status: "running",
				started_at: nowIso,
			});
			return {
				schedule: this.getRequired(run.scheduleId),
				run,
				processedSources: this.processedSources(run.scheduleId),
			};
		});
	}

	/**
	 * Points a running occurrence at the Research Run carrying it out. The Activity projection drops
	 * its own placeholder once the occurrence names a Run, so recording this only at completion left
	 * the placeholder beside the live Run for the whole of it.
	 */
	linkResearchRun(runId: string, researchRunId: string): void {
		this.transaction(() => {
			const run = this.getRunRequired(runId);
			if (run.status !== "running") throw new Error("Only a running Research Schedule Run can name its Research Run");
			this.db.prepare("UPDATE research_schedule_runs SET research_run_id=? WHERE id=?").run(researchRunId, runId);
		});
	}

	complete(args: {
		runId: string;
		status: Extract<
			ResearchScheduleRunStatus,
			"published" | "skipped_no_source_increment" | "skipped_no_qualifying_evidence"
		>;
		researchRunId: string;
		reportPath?: string;
		discoveredSources: number;
		incrementalSources: number;
		cornellNotes: number;
		sources: ResearchScheduleSource[];
		sourceGaps?: ResearchScheduleSource[];
		now?: Date;
	}): ResearchScheduleRun {
		const now = (args.now ?? new Date()).toISOString();
		this.transaction(() => {
			const run = this.getRunRequired(args.runId);
			if (run.status !== "running") throw new Error("Only a running Research Schedule Run can complete");
			this.db.prepare(`
				UPDATE research_schedule_runs SET
					status=?, research_run_id=?, report_path=?, discovered_sources=?,
					incremental_sources=?, note_count=?, finished_at=?
				WHERE id=?
			`).run(
				args.status,
				args.researchRunId,
				args.reportPath ?? null,
				args.discoveredSources,
				args.incrementalSources,
				args.cornellNotes,
				now,
				args.runId,
			);
			const insert = this.db.prepare(`
				INSERT INTO research_schedule_sources (
					schedule_id, source_identity, content_sha256, first_run_id, processed_at
				) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(schedule_id, source_identity) DO UPDATE SET
					content_sha256=excluded.content_sha256,
					processed_at=excluded.processed_at
			`);
			for (const source of args.sources) {
				insert.run(
					run.scheduleId,
					source.sourceIdentity,
					validSha256(source.contentSha256, "contentSha256"),
					args.researchRunId,
					now,
				);
			}
			this.recordSourceGaps(run.scheduleId, {
				processed: args.sources,
				gaps: args.sourceGaps ?? [],
				runId: args.researchRunId,
				now,
			});
			this.db.prepare(`
				UPDATE research_schedules
				SET covered_through=?, updated_at=?
				WHERE id=?
			`).run(run.windowEnd, now, run.scheduleId);
		});
		return this.getRunRequired(args.runId);
	}

	fail(runId: string, error: string, now = new Date()): ResearchScheduleRun {
		const result = this.db.prepare(`
			UPDATE research_schedule_runs SET status='failed', error=?, finished_at=?
			WHERE id=? AND status='running'
		`).run(required(error, "error"), now.toISOString(), runId);
		if (Number(result.changes) !== 1) throw new Error("Only a running Research Schedule Run can fail");
		return this.getRunRequired(runId);
	}

	recoverInterrupted(now = new Date()): number {
		const result = this.db.prepare(`
			UPDATE research_schedule_runs
			SET status='failed', error='Server restarted while this Research Run was active', finished_at=?
			WHERE status='running'
		`).run(now.toISOString());
		return Number(result.changes);
	}

	/**
	 * 记录一次 Research Schedule Review。`propose` 会把该 Schedule 上仍然打开的
	 * Proposal 标记为 superseded，用户因此永远只面对一个待确认的建议。
	 */
	recordReview(input: {
		id: string;
		scheduleId: string;
		startedAt: string;
		traceRef?: string;
		outcome: ResearchScheduleReviewOutcome;
		/** User messages the Goal held when this Review started, the next Review's counting baseline. */
		userMessageCount: number;
		now?: Date;
	}): ResearchScheduleReview {
		const schedule = this.getRequired(input.scheduleId);
		const now = (input.now ?? new Date()).toISOString();
		const { outcome } = input;
		return this.transaction(() => {
			let proposalId: string | undefined;
			if (outcome.decision === "propose") {
				this.db.prepare(`
					UPDATE research_schedule_proposals
					SET status='superseded', resolved_at=?
					WHERE schedule_id=? AND status='proposed'
				`).run(now, schedule.id);
				proposalId = `proposal_${randomUUID()}`;
				this.db.prepare(`
					INSERT INTO research_schedule_proposals (
						id, schedule_id, review_id, status, previous_monitoring_scope, previous_report_context,
						monitoring_scope, report_context, summary, rationale, evidence, created_at
					) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?)
				`).run(
					proposalId,
					schedule.id,
					input.id,
					schedule.monitoringScope,
					schedule.reportContext,
					outcome.monitoringScope,
					outcome.reportContext,
					outcome.summary,
					outcome.rationale,
					JSON.stringify(outcome.evidence),
					now,
				);
			}
			const reason = outcome.decision === "failed"
				? required(outcome.reason, "reason")
				: outcome.decision === "no_change"
					? outcome.rationale?.trim() || null
					: null;
			this.db.prepare(`
				INSERT INTO research_schedule_reviews (
					id, schedule_id, status, reason, proposal_id, trace_ref, started_at, finished_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				input.id,
				schedule.id,
				outcome.decision === "propose" ? "proposed" : outcome.decision,
				reason,
				proposalId ?? null,
				input.traceRef ?? null,
				validInstant(input.startedAt, "startedAt"),
				now,
			);
			// Bookkeeping advances on every outcome, `failed` included: a Review is retried only when
			// the trigger fires again, so a broken Reviewer cannot burn model budget in a loop.
			this.db.prepare(`
				UPDATE research_schedules
				SET last_reviewed_at=?, last_reviewed_user_message_count=?
				WHERE id=?
			`).run(
				now,
				input.userMessageCount,
				schedule.id,
			);
			return this.reviewRequired(input.id);
		});
	}

	/**
	 * 用户确认一个 Research Schedule Proposal，可以带上自己改写的文本。确认只覆盖 Schedule 的
	 * 两个参数并推进 updatedAt：cadence、时区、标题和下一次触发时间都不动，已经开始的 occurrence
	 * 保留自己冻结的参数。Proposal 记录保留 Reviewer 原本提出的文本，状态区分是否经过编辑。
	 */
	confirmProposal(
		scheduleId: string,
		proposalId: string,
		edits: { monitoringScope?: string; reportContext?: string } = {},
		now = new Date(),
	): { schedule: ResearchSchedule; proposal: ResearchScheduleProposal } {
		return this.transaction(() => {
			const { schedule, proposal } = this.openProposal(scheduleId, proposalId, "confirmed");
			if (schedule.status === "archived") {
				throw new Error("Archived Research Schedule cannot be updated");
			}
			const monitoringScope = edits.monitoringScope === undefined
				? proposal.monitoringScope
				: required(edits.monitoringScope, "monitoringScope");
			const reportContext = edits.reportContext === undefined
				? proposal.reportContext
				: required(edits.reportContext, "reportContext");
			const edited = monitoringScope !== proposal.monitoringScope
				|| reportContext !== proposal.reportContext;
			const nowIso = now.toISOString();
			this.db.prepare(`
				UPDATE research_schedules
				SET monitoring_scope=?, report_context=?, updated_at=?
				WHERE id=?
			`).run(monitoringScope, reportContext, nowIso, proposal.scheduleId);
			this.db.prepare(`
				UPDATE research_schedule_proposals SET status=?, resolved_at=? WHERE id=?
			`).run(edited ? "confirmed_with_edits" : "confirmed_as_is", nowIso, proposal.id);
			return {
				schedule: this.getRequired(proposal.scheduleId),
				proposal: this.proposalRequired(proposal.id),
			};
		});
	}

	/** 用户拒绝一个 Proposal，可以留下理由。Schedule 的参数一个字都不动。 */
	rejectProposal(
		scheduleId: string,
		proposalId: string,
		reason?: string,
		now = new Date(),
	): { schedule: ResearchSchedule; proposal: ResearchScheduleProposal } {
		return this.transaction(() => {
			const { schedule, proposal } = this.openProposal(scheduleId, proposalId, "rejected");
			this.db.prepare(`
				UPDATE research_schedule_proposals
				SET status='rejected', resolved_at=?, rejection_reason=?
				WHERE id=?
			`).run(now.toISOString(), reason?.trim() || null, proposal.id);
			return { schedule, proposal: this.proposalRequired(proposal.id) };
		});
	}

	listReviews(scheduleId: string): ResearchScheduleReview[] {
		return (this.db.prepare(`
			SELECT * FROM research_schedule_reviews WHERE schedule_id=?
			ORDER BY finished_at DESC, id DESC
		`).all(this.getRequired(scheduleId).id) as SqlRow[]).map((row) => toReview(row));
	}

	listProposals(scheduleId: string): ResearchScheduleProposal[] {
		return (this.db.prepare(`
			SELECT * FROM research_schedule_proposals WHERE schedule_id=?
			ORDER BY created_at DESC, id DESC
		`).all(this.getRequired(scheduleId).id) as SqlRow[]).map((row) => toProposal(row));
	}

	/** 只有仍然打开的 Proposal 可以被确认或拒绝；已经结束的转换是无效转换。 */
	private openProposal(
		scheduleId: string,
		proposalId: string,
		action: "confirmed" | "rejected",
	): { schedule: ResearchSchedule; proposal: ResearchScheduleProposal } {
		const schedule = this.getRequired(scheduleId);
		const proposal = this.proposalRequired(proposalId);
		if (proposal.scheduleId !== schedule.id) {
			throw new Error(`Unknown Research Schedule Proposal: ${proposalId}`);
		}
		if (proposal.status !== "proposed") {
			throw new Error(
				`A ${proposal.status} Research Schedule Proposal cannot be ${action}`,
			);
		}
		return { schedule, proposal };
	}

	private proposalRequired(id: string): ResearchScheduleProposal {
		const row = this.db.prepare("SELECT * FROM research_schedule_proposals WHERE id=?")
			.get(id) as SqlRow | undefined;
		if (!row) throw new Error(`Unknown Research Schedule Proposal: ${id}`);
		return toProposal(row);
	}

	private reviewRequired(id: string): ResearchScheduleReview {
		const row = this.db.prepare("SELECT * FROM research_schedule_reviews WHERE id=?")
			.get(id) as SqlRow | undefined;
		if (!row) throw new Error(`Unknown Research Schedule Review: ${id}`);
		return toReview(row);
	}

	/**
	 * 记录这次 Run 没能读出 Cornell Note 的 Source revision，并清掉这次 Run 真的读出来的那一条缺口。
	 * 解除缺口要求 identity 和 revision 都对上：revision hash 没有先后之分，读到另一个 revision 不能
	 * 证明失败的那一份被读过。因此某个 Source 最近一次没读出来的 revision 会一直留着，直到它本身被读出。
	 */
	private recordSourceGaps(
		scheduleId: string,
		input: {
			processed: readonly ResearchScheduleSource[];
			gaps: readonly ResearchScheduleSource[];
			runId: string;
			now: string;
		},
	): void {
		const resolve = this.db.prepare(`
			DELETE FROM research_schedule_source_gaps
			WHERE schedule_id=? AND source_identity=? AND content_sha256=?
		`);
		for (const source of input.processed) {
			resolve.run(scheduleId, source.sourceIdentity, source.contentSha256);
		}
		const insert = this.db.prepare(`
			INSERT OR REPLACE INTO research_schedule_source_gaps (
				schedule_id, source_identity, content_sha256, run_id, recorded_at
			) VALUES (?, ?, ?, ?, ?)
		`);
		for (const gap of input.gaps) {
			insert.run(
				scheduleId,
				gap.sourceIdentity,
				validSha256(gap.contentSha256, "contentSha256"),
				input.runId,
				input.now,
			);
		}
	}

	private sourceGaps(scheduleId: string): ResearchScheduleSourceGap[] {
		return (this.db.prepare(`
			SELECT source_identity, content_sha256, run_id, recorded_at
			FROM research_schedule_source_gaps
			WHERE schedule_id=?
			ORDER BY recorded_at, source_identity
		`).all(scheduleId) as SqlRow[]).map((row) => ({
			sourceIdentity: String(row.source_identity),
			contentSha256: String(row.content_sha256),
			runId: String(row.run_id),
			recordedAt: String(row.recorded_at),
		}));
	}

	private processedSources(scheduleId: string) {
		return (this.db.prepare(`
			SELECT source_identity, content_sha256
			FROM research_schedule_sources
			WHERE schedule_id=?
			ORDER BY processed_at, source_identity
		`).all(scheduleId) as SqlRow[]).map((row) => ({
			sourceIdentity: String(row.source_identity),
			contentSha256: validSha256(String(row.content_sha256), "contentSha256"),
		}));
	}

	private insertOccurrence(
		schedule: ResearchSchedule,
		scheduledFor: string,
		createdAt: string,
	): ResearchScheduleRun {
		const id = `occurrence_${randomUUID()}`;
		this.db.prepare(`
			INSERT INTO research_schedule_runs (
				id, schedule_id, scheduled_for, window_start, window_end, status, created_at
			) VALUES (?, ?, ?, ?, ?, 'scheduled', ?)
		`).run(
			id,
			schedule.id,
			scheduledFor,
			schedule.coveredThrough,
			scheduledFor,
			createdAt,
		);
		return this.getRunRequired(id);
	}

	private getRequired(id: string): ResearchSchedule {
		const schedule = this.get(id);
		if (!schedule) throw new Error(`Unknown Research Schedule: ${id}`);
		return schedule;
	}

	private getRunRequired(id: string): ResearchScheduleRun {
		const row = this.db.prepare(
			"SELECT * FROM research_schedule_runs WHERE id=?",
		).get(id) as SqlRow | undefined;
		if (!row) throw new Error(`Unknown Research Schedule Run: ${id}`);
		return this.toRun(row);
	}

	private toSchedule(row: SqlRow): ResearchSchedule {
		const id = String(row.id);
		return {
			id,
			goalId: String(row.goal_id),
			title: String(row.title),
			question: String(row.question),
			monitoringScope: String(row.monitoring_scope),
			reportContext: String(row.report_context),
			cron: String(row.cron),
			timeZone: String(row.timezone),
			status: String(row.status) as ResearchScheduleStatus,
			initializedFromRunId: String(row.initialized_from_run_id),
			coveredThrough: String(row.covered_through),
			...(row.next_run_at ? { nextRunAt: String(row.next_run_at) } : {}),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
			lastReviewedAt: String(row.last_reviewed_at),
			lastReviewedUserMessageCount: Number(row.last_reviewed_user_message_count),
			...this.lastReviewOf(id),
			...this.openProposalOf(id),
			sourceGaps: this.sourceGaps(id),
			runs: (this.db.prepare(`
				SELECT * FROM research_schedule_runs
				WHERE schedule_id=? ORDER BY scheduled_for DESC LIMIT 20
			`).all(id) as SqlRow[]).map((run) => this.toRun(run)),
		};
	}

	private lastReviewOf(scheduleId: string): { lastReview?: ResearchScheduleReview } {
		const row = this.db.prepare(`
			SELECT * FROM research_schedule_reviews WHERE schedule_id=?
			ORDER BY finished_at DESC, id DESC LIMIT 1
		`).get(scheduleId) as SqlRow | undefined;
		return row ? { lastReview: toReview(row) } : {};
	}

	private openProposalOf(scheduleId: string): { openProposal?: ResearchScheduleProposal } {
		const row = this.db.prepare(`
			SELECT * FROM research_schedule_proposals WHERE schedule_id=? AND status='proposed'
		`).get(scheduleId) as SqlRow | undefined;
		return row ? { openProposal: toProposal(row) } : {};
	}

	private toRun(row: SqlRow): ResearchScheduleRun {
		return {
			id: String(row.id),
			scheduleId: String(row.schedule_id),
			scheduledFor: String(row.scheduled_for),
			windowStart: String(row.window_start),
			windowEnd: String(row.window_end),
			status: String(row.status) as ResearchScheduleRunStatus,
			...(row.research_run_id ? { researchRunId: String(row.research_run_id) } : {}),
			...(row.report_path ? { reportPath: String(row.report_path) } : {}),
			...(row.error ? { error: String(row.error) } : {}),
			discoveredSources: Number(row.discovered_sources),
			incrementalSources: Number(row.incremental_sources),
			cornellNotes: Number(row.note_count),
			...(row.started_at ? { startedAt: String(row.started_at) } : {}),
			...(row.finished_at ? { finishedAt: String(row.finished_at) } : {}),
			createdAt: String(row.created_at),
		};
	}

	private transaction<T>(work: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = work();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private initialize(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS research_schedules (
					id TEXT PRIMARY KEY,
					goal_id TEXT NOT NULL,
					title TEXT NOT NULL,
					question TEXT NOT NULL,
					monitoring_scope TEXT NOT NULL,
					report_context TEXT NOT NULL,
				cron TEXT NOT NULL,
				timezone TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'archived')),
				initialized_from_run_id TEXT NOT NULL,
				covered_through TEXT NOT NULL,
				next_run_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				last_reviewed_at TEXT NOT NULL,
				last_reviewed_user_message_count INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS research_schedule_runs (
				id TEXT PRIMARY KEY,
				schedule_id TEXT NOT NULL REFERENCES research_schedules(id),
				scheduled_for TEXT NOT NULL,
				window_start TEXT NOT NULL,
				window_end TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN (
					'scheduled', 'running', 'published',
					'skipped_no_source_increment', 'skipped_no_qualifying_evidence',
					'failed', 'cancelled'
				)),
				research_run_id TEXT,
				report_path TEXT,
				error TEXT,
				discovered_sources INTEGER NOT NULL DEFAULT 0,
				incremental_sources INTEGER NOT NULL DEFAULT 0,
				note_count INTEGER NOT NULL DEFAULT 0,
				started_at TEXT,
				finished_at TEXT,
				created_at TEXT NOT NULL,
				UNIQUE(schedule_id, scheduled_for)
			);
			CREATE TABLE IF NOT EXISTS research_schedule_sources (
				schedule_id TEXT NOT NULL REFERENCES research_schedules(id),
				source_identity TEXT NOT NULL,
				content_sha256 TEXT NOT NULL,
				first_run_id TEXT NOT NULL,
				processed_at TEXT NOT NULL,
				PRIMARY KEY(schedule_id, source_identity)
			);
			CREATE TABLE IF NOT EXISTS research_schedule_source_gaps (
				schedule_id TEXT NOT NULL REFERENCES research_schedules(id),
				source_identity TEXT NOT NULL,
				content_sha256 TEXT NOT NULL,
				run_id TEXT NOT NULL,
				recorded_at TEXT NOT NULL,
				PRIMARY KEY(schedule_id, source_identity)
			);
			CREATE TABLE IF NOT EXISTS research_schedule_reviews (
				id TEXT PRIMARY KEY,
				schedule_id TEXT NOT NULL REFERENCES research_schedules(id),
				status TEXT NOT NULL CHECK(status IN ('no_change', 'proposed', 'failed')),
				reason TEXT,
				proposal_id TEXT,
				trace_ref TEXT,
				started_at TEXT NOT NULL,
				finished_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS research_schedule_proposals (
				id TEXT PRIMARY KEY,
				schedule_id TEXT NOT NULL REFERENCES research_schedules(id),
				review_id TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN (
					'proposed', 'confirmed_as_is', 'confirmed_with_edits', 'rejected', 'superseded'
				)),
				previous_monitoring_scope TEXT NOT NULL,
				previous_report_context TEXT NOT NULL,
				monitoring_scope TEXT NOT NULL,
				report_context TEXT NOT NULL,
				summary TEXT NOT NULL,
				rationale TEXT NOT NULL,
				evidence TEXT NOT NULL,
				created_at TEXT NOT NULL,
				resolved_at TEXT,
				rejection_reason TEXT
			);
			CREATE INDEX IF NOT EXISTS research_schedule_review_recent
				ON research_schedule_reviews(schedule_id, finished_at);
			CREATE UNIQUE INDEX IF NOT EXISTS research_schedule_one_open_proposal
				ON research_schedule_proposals(schedule_id)
				WHERE status='proposed';
			CREATE INDEX IF NOT EXISTS research_schedule_due
				ON research_schedules(status, next_run_at);
			CREATE INDEX IF NOT EXISTS research_schedule_run_status
				ON research_schedule_runs(status, created_at);
			CREATE UNIQUE INDEX IF NOT EXISTS research_schedule_one_active_run
				ON research_schedule_runs(schedule_id)
				WHERE status IN ('scheduled', 'running');
		`);
	}
}

function toReview(row: SqlRow): ResearchScheduleReview {
	return {
		id: String(row.id),
		scheduleId: String(row.schedule_id),
		status: String(row.status) as ResearchScheduleReviewStatus,
		...(row.reason ? { reason: String(row.reason) } : {}),
		...(row.proposal_id ? { proposalId: String(row.proposal_id) } : {}),
		...(row.trace_ref ? { traceRef: String(row.trace_ref) } : {}),
		startedAt: String(row.started_at),
		finishedAt: String(row.finished_at),
	};
}

function toProposal(row: SqlRow): ResearchScheduleProposal {
	return {
		id: String(row.id),
		scheduleId: String(row.schedule_id),
		reviewId: String(row.review_id),
		status: String(row.status) as ResearchScheduleProposalStatus,
		previousMonitoringScope: String(row.previous_monitoring_scope),
		previousReportContext: String(row.previous_report_context),
		monitoringScope: String(row.monitoring_scope),
		reportContext: String(row.report_context),
		summary: String(row.summary),
		rationale: String(row.rationale),
		evidence: JSON.parse(String(row.evidence)) as string[],
		createdAt: String(row.created_at),
		...(row.resolved_at ? { resolvedAt: String(row.resolved_at) } : {}),
		...(row.rejection_reason ? { rejectionReason: String(row.rejection_reason) } : {}),
	};
}

export function validateCron(cron: string, timeZone: string): string {
	const value = required(cron, "cron");
	try {
		new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
	} catch {
		throw new Error(`Invalid time zone: ${timeZone}`);
	}
	const schedule = new Cron(value, { timezone: timeZone });
	try {
		if (!schedule.nextRun()) throw new Error("Cron has no next Run");
	} finally {
		schedule.stop();
	}
	return value;
}

function nextCronRun(cron: string, timeZone: string, after: Date): string {
	const schedule = new Cron(cron, { timezone: timeZone });
	try {
		const next = schedule.nextRun(after);
		if (!next) throw new Error("Cron has no next Run");
		return next.toISOString();
	} finally {
		schedule.stop();
	}
}

function required(value: string, name: string): string {
	const clean = value.trim();
	if (!clean) throw new Error(`${name} cannot be empty`);
	return clean;
}

function validInstant(value: string, name: string): string {
	if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
	return new Date(value).toISOString();
}

function validSha256(value: string, name: string): string {
	if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
	return value;
}
