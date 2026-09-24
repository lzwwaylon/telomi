import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	HindsightClient,
	resolvePiUserMemoryConfig,
	type PiUserMemoryConfig,
	type RetainInput,
} from "pi-user-memory";

import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import { readUserTaskHistory } from "../../observability/task-history.js";
import { ResearchScheduleStore } from "../../research/schedules/store.js";
import { GoalTopicPlanStore } from "../topic-plan/index.js";

interface ProjectionRecord {
	documentId: string;
	sourceId: string;
	acceptedAt: string;
}

export class UserMemoryProjector {
	private readonly client: HindsightClient;
	private readonly ledgerPath: string;
	private serial: Promise<void> = Promise.resolve();

	constructor(
		private readonly workspaceDir: string,
		private readonly goalId: string,
		config: PiUserMemoryConfig = {},
	) {
		const resolved = resolvePiUserMemoryConfig({ ...config, goalId });
		this.client = new HindsightClient(resolved.baseUrl, resolved.bankId);
		this.ledgerPath = join(
			serverRuntimeDirForGoal(goalId, workspaceDir),
			"memory",
			"hindsight-projection.jsonl",
		);
	}

	sync(sourceId?: string): Promise<void> {
		// Current turns must not wait behind retries for other pending projection records. Stable document IDs keep this idempotent.
		if (sourceId) return this.run(sourceId);
		const run = this.serial.then(() => this.run(sourceId));
		this.serial = run.catch(() => undefined);
		return run;
	}

	private async run(sourceId?: string): Promise<void> {
		const accepted = this.acceptedDocumentIds();
		for (const item of this.items()) {
			if ((sourceId && item.sourceId !== sourceId) || accepted.has(item.input.documentId)) continue;
			await this.client.retain(item.input);
			appendProjectionRecord(this.ledgerPath, {
				documentId: item.input.documentId,
				sourceId: item.sourceId,
				acceptedAt: new Date().toISOString(),
			});
			accepted.add(item.input.documentId);
		}
	}

	private items(): Array<{ sourceId: string; input: RetainInput }> {
		const goalTag = `goal:${this.goalId}`;
		const tasks = readUserTaskHistory(serverRuntimeDirForGoal(this.goalId, this.workspaceDir))
			.filter((record) => record.goalId === this.goalId && record.source === "user_message" && record.message?.role === "user")
			.filter((record) => record.originalQuestion.trim() && record.originalQuestion !== "(attachment-only user message)")
			.map((record) => ({
				sourceId: record.taskId,
				input: {
					documentId: `pi-task-${record.taskId}`,
					occurredAt: record.createdAt,
					content: record.originalQuestion,
					context: [
						"Raw Memory Episode from a direct Telomi user message.",
						`Goal scope: ${this.goalId}.`,
						"Extract durable user facts only. Treat one-turn formatting and task instructions as episode context unless the user explicitly requests future reuse.",
					].join(" "),
					// A user's own words are user-level: recall in any Goal admits `scope:global`, and
					// without it a preference stated in one Goal was never recalled in another.
					tags: [goalTag, "scope:global"],
					metadata: {
						source: "task_history",
						source_id: record.taskId,
						goal_id: this.goalId,
						durability: "episode",
					},
					observationScopes: [[goalTag]],
					async: false,
				},
			}));
		return [...tasks, ...this.topicPlanItem(goalTag), ...this.rejectedProposalItems(goalTag)].sort((left, right) =>
			left.input.occurredAt.localeCompare(right.input.occurredAt) || left.input.documentId.localeCompare(right.input.documentId));
	}

	private topicPlanItem(goalTag: string): Array<{ sourceId: string; input: RetainInput }> {
		const store = new GoalTopicPlanStore(this.goalId, this.workspaceDir);
		const plan = store.readActive();
		if (!plan) return [];
		const confirmedAt = store.readHistory().find((entry) => entry.version === plan.revision)?.confirmed_at;
		if (!confirmedAt) return [];
		const sourceId = `topic-plan:${plan.revision}`;
		return [{
			sourceId,
			input: {
				documentId: `pi-topic-plan-${this.goalId}-${plan.revision}`,
				occurredAt: confirmedAt,
				content: [
					"User-confirmed long-term Goal focus:",
					...plan.topics.flatMap((topic) => [
						`Topic: ${topic.title}`,
						`Intent: ${topic.intent}`,
						...(topic.include.length ? [`Include: ${topic.include.join("; ")}`] : []),
						...(topic.exclude.length ? [`Exclude: ${topic.exclude.join("; ")}`] : []),
					]),
				].join("\n"),
				context: "User-confirmed durable Goal Understanding. Extract the user's long-term focus and exclusions as durable facts.",
				tags: [goalTag],
				metadata: {
					source: "topic_plan",
					goal_id: this.goalId,
					topic_plan_revision: plan.revision,
					durability: "durable",
					memory_kind: "goal_understanding",
				},
				observationScopes: [[goalTag]],
				async: false,
			},
		}];
	}

	/**
	 * 用户拒绝过的 Research Schedule Proposal 及其理由。它记录的是一次已经发生的判断，
	 * 不是一条禁令：Main Agent 和后续 Review 由此知道用户当时不要什么、为什么。
	 */
	private rejectedProposalItems(goalTag: string): Array<{ sourceId: string; input: RetainInput }> {
		// Goals that never created a Research Schedule have nothing here, and asking must not
		// bring a Schedule database into existence on every turn's projection.
		if (!existsSync(join(serverRuntimeDirForGoal(this.goalId, this.workspaceDir), "research/schedules.sqlite"))) {
			return [];
		}
		const store = new ResearchScheduleStore(this.goalId, this.workspaceDir);
		try {
			return store.list().flatMap((schedule) => store.listProposals(schedule.id)
				.filter((proposal) => proposal.status === "rejected" && proposal.resolvedAt)
				.map((proposal) => ({
					sourceId: `schedule-proposal:${proposal.id}`,
					input: {
						documentId: `pi-schedule-proposal-${proposal.id}`,
						occurredAt: proposal.resolvedAt!,
						content: [
							`The user rejected a Research Schedule Proposal on the Research Schedule "${schedule.title}".`,
							`Recurring question: ${schedule.question}`,
							`Proposal summary: ${proposal.summary}`,
							`Kept monitoring scope: ${proposal.previousMonitoringScope}`,
							`Rejected monitoring scope: ${proposal.monitoringScope}`,
							`Kept Report Context: ${proposal.previousReportContext}`,
							`Rejected Report Context: ${proposal.reportContext}`,
							proposal.rejectionReason
								? `The user's reason: ${proposal.rejectionReason}`
								: "The user gave no reason.",
						].join("\n"),
						context: [
							"Raw Memory Episode from one user decision on a Research Schedule Proposal.",
							`Goal scope: ${this.goalId}.`,
							"Extract what this user did not want and why as a Goal Preference.",
							"It is one decision on one wording, not a standing ban on the underlying idea.",
						].join(" "),
						tags: [goalTag],
						metadata: {
							source: "research_schedule_proposal",
							source_id: proposal.id,
							goal_id: this.goalId,
							schedule_id: schedule.id,
							durability: "episode",
							memory_kind: "goal_preference",
						},
						observationScopes: [[goalTag]],
						async: false,
					},
				})));
		} finally {
			store.close();
		}
	}

	private acceptedDocumentIds(): Set<string> {
		if (!existsSync(this.ledgerPath)) return new Set();
		return new Set(readFileSync(this.ledgerPath, "utf-8").split(/\r?\n/u).flatMap((line, index) => {
			if (!line.trim()) return [];
			const value = JSON.parse(line) as Partial<ProjectionRecord>;
			if (typeof value.documentId !== "string" || typeof value.sourceId !== "string") {
				throw new Error(`Hindsight projection ledger is invalid at line ${index + 1}`);
			}
			return [value.documentId];
		}));
	}
}

function appendProjectionRecord(path: string, record: ProjectionRecord): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// ponytail: one GoalRunner serializes this per-Goal ledger; add a file lock if Goal ownership becomes multi-process.
	appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
}

export async function deleteGoalUserMemory(goalId: string, config: PiUserMemoryConfig = {}): Promise<number> {
	const resolved = resolvePiUserMemoryConfig({ ...config, goalId });
	return new HindsightClient(resolved.baseUrl, resolved.bankId).deleteDocumentsByTag(`goal:${goalId}`);
}
