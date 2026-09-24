import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { publish } from "../../events/event-bus.js";
import { createResearchScheduleFromRun } from "../../research/schedules/create-from-run.js";
import { ResearchScheduleStore } from "../../research/schedules/store.js";
import type { ResearchSchedule, ResearchScheduleSourceGap } from "../../research/schedules/types.js";

/** Enough gaps to act on. The exact count is always stated, so a long tail stays honest. */
const LISTED_GAPS = 20;

const schema = Type.Object({
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("list"),
		Type.Literal("get"),
		Type.Literal("pause"),
		Type.Literal("resume"),
		Type.Literal("update_schedule"),
		Type.Literal("archive"),
	]),
	scheduleId: Type.Optional(Type.String()),
	sourceRunId: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	monitoringScope: Type.Optional(Type.String()),
	cron: Type.Optional(Type.String()),
	timeZone: Type.Optional(Type.String()),
}, { additionalProperties: false });

export function createResearchScheduleTool(opts: {
	goalId: string;
	workspaceDir: string;
}): AgentTool<typeof schema> {
	return {
		name: "research_schedule",
		label: "research_schedule",
		description: "Manage Goal-scoped recurring Research Runs from an existing published baseline. For a fresh recurring request, use research with its schedule input so the first report becomes the baseline. Occurrences run only when the Runtime reaches the cron time; only the user can trigger an immediate run from the UI.",
		parameters: schema,
		execute: async (_toolCallId, args) => {
			if (args.action === "create") {
				const schedule = createResearchScheduleFromRun({
					workspaceDir: opts.workspaceDir,
					goalId: opts.goalId,
					title: required(args.title, "title"),
					monitoringScope: required(args.monitoringScope, "monitoringScope"),
					sourceRunId: required(args.sourceRunId, "sourceRunId"),
					cron: required(args.cron, "cron"),
					timeZone: required(args.timeZone, "timeZone"),
				});
				changed(opts.goalId, schedule.id, "created");
				return result(
					`Created Research Schedule '${schedule.title}'.\n${describe(schedule)}`,
					{ schedule },
				);
			}
			const store = new ResearchScheduleStore(opts.goalId, opts.workspaceDir);
			try {
				if (args.action === "list") {
					const schedules = store.list();
					return result(
						schedules.length > 0
							? schedules.map((schedule) =>
								`${schedule.id} | ${schedule.status} | ${schedule.title} | ${schedule.cron} ${schedule.timeZone}`
								+ ` | next ${schedule.nextRunAt ?? "none"} | ${countGaps(schedule.sourceGaps)}`,
							).join("\n")
							: "No Research Schedules.",
						{ schedules },
					);
				}
				const scheduleId = required(args.scheduleId, "scheduleId");
				if (args.action === "get") {
					const schedule = store.get(scheduleId);
					if (!schedule) throw new Error(`Unknown Research Schedule: ${scheduleId}`);
					return result(describe(schedule), { schedule });
				}
				const value = args.action === "pause"
					? { schedule: store.pause(scheduleId) }
					: args.action === "resume"
						? { schedule: store.resume(scheduleId) }
						: args.action === "archive"
							? { schedule: store.archive(scheduleId) }
							: {
								schedule: store.update(scheduleId, {
									...(args.title === undefined ? {} : { title: required(args.title, "title") }),
									...(args.monitoringScope === undefined
										? {}
										: { monitoringScope: required(args.monitoringScope, "monitoringScope") }),
									...(args.cron === undefined ? {} : { cron: required(args.cron, "cron") }),
									...(args.timeZone === undefined ? {} : { timeZone: required(args.timeZone, "timeZone") }),
								}),
							};
				changed(opts.goalId, scheduleId, args.action);
				return result(
					`Research Schedule ${args.action} completed.\n${describe(value.schedule)}`,
					value,
				);
			} finally {
				store.close();
			}
		},
	};
}

/**
 * The Schedule facts the Main Agent may state, in the Tool's own text. `details` carries the whole
 * Schedule for the UI, and the model never sees it: anything it has to tell the user about a
 * Schedule, its cadence or its Cornell Note gaps has to be here.
 */
function describe(schedule: ResearchSchedule): string {
	return [
		`${schedule.id} | ${schedule.status} | ${schedule.title}`,
		`Cadence: ${schedule.cron} (${schedule.timeZone}); next occurrence ${schedule.nextRunAt ?? "none while it is not active"}`,
		`Baseline: Research Run ${schedule.initializedFromRunId}, covered through ${schedule.coveredThrough}`,
		...describeGaps(schedule.sourceGaps),
	].join("\n");
}

/**
 * Sources the baseline or a later occurrence published without a Cornell Note. They are outside the
 * processed set, so a later occurrence that rediscovers one is free to read it; nothing re-fetches
 * them on its own, and the Schedule's window and Source filter still decide what gets searched.
 */
function describeGaps(gaps: readonly ResearchScheduleSourceGap[]): string[] {
	if (gaps.length === 0) return ["Source gaps: none; every Source of this Schedule has a Cornell Note."];
	const listed = gaps.slice(0, LISTED_GAPS).map((gap) =>
		`  ${gap.sourceIdentity} revision ${gap.contentSha256} (Research Run ${gap.runId})`);
	if (gaps.length > listed.length) listed.push(`  and ${gaps.length - listed.length} more`);
	return [
		`Source gaps: ${countGaps(gaps)}, published without a Cornell Note and not read since.`
		+ " An occurrence may read one again if it rediscovers it; none of them is retried on its own.",
		...listed,
	];
}

function countGaps(gaps: readonly ResearchScheduleSourceGap[]): string {
	return `${gaps.length} Source ${gaps.length === 1 ? "gap" : "gaps"}`;
}

function result(text: string, details: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function required(value: string | undefined, name: string): string {
	const clean = value?.trim();
	if (!clean) throw new Error(`research_schedule ${name} is required`);
	return clean;
}

function changed(goalId: string, scheduleId: string, reason: string): void {
	publish({
		type: "research/schedules:changed",
		goalId,
		scheduleId,
		reason,
		ts: new Date().toISOString(),
	});
}
