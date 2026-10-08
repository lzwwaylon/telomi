import { resolveGoalOutputLanguage, type OutputLanguage } from "../../../shared/languages.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import { GoalTopicPlanStore } from "../../goals/topic-plan/index.js";
import { RunArtifactStore, type RunArtifactRef } from "../../agent-runtime/artifact-store.js";
import { startWikiUpdateActivity } from "../../wiki/update-runner.js";
import { registerSavedInvestigationCues, startGoalCueWikiUpdates, listDeliveredInvestigationReviews } from "../../research/cue-wiki-trigger.js";
import { getCueWikiQueueStatus } from "../../research/cue-wiki-queue.js";
import { createGoalNoteSnapshot } from "../../research/cue-note-snapshot.js";
import { sha256 } from "../../lib/hash.js";
import type { WikiMainSessionContext } from '../wiki-context.js';

const schema = Type.Object({
	source_run_id: Type.Optional(Type.String({ minLength: 1,
		description: "Optional historical Research Run id. Omit to refresh saved investigation Cues or rebuild from the Goal's complete Cornell evidence corpus." })),
	reason: Type.String({ minLength: 1, description: "The explanation for starting this maintenance operation; the action is always a Wiki update." }),
	rebuild: Type.Boolean({ description: "True only when the user explicitly asks to rebuild or regenerate the Wiki from scratch." }),
	reconsider: Type.Optional(Type.Boolean({ description: "True only when the user explicitly requests review, cleanup or correction of existing Wiki content. Reconsiders the complete saved Goal evidence with the latest delivered reviews and this maintenance reason; retained Sources and immutable Wiki history remain intact. Omit source_run_id for this operation." })),
}, { additionalProperties: false });

export function createWikiUpdateTool(options: {
	goalId: string;
	goalDir: string;
	workspaceDir: string;
	goalTitle?: string;
	goalDescription?: string;
	getGoalTitle?: () => string;
	getGoalDescription?: () => string;
	getOutputLanguage?: () => OutputLanguage;
	getEnv: () => Record<string, string | undefined>;
	deferCueWikiUpdates?: boolean;
	getMainSession?: () => WikiMainSessionContext;
}, startUpdate = startWikiUpdateActivity): AgentTool<typeof schema> {
	return {
		name: "wiki_update",
		label: "wiki_update",
		description: "Start Wiki maintenance when the user requests a refresh, retry or correction. For read-only Wiki Topic discovery and searches, use investigate. The reason carries the user's maintenance intent and exclusions faithfully. Set rebuild=true only for a requested rebuild; use reconsider=true for an explicit request to reassess existing Wiki content from the complete saved Goal evidence. source_run_id selects one historical Research Run and cannot be combined with reconsider. Returns immediately with the update state and Activity id when available.",
		parameters: schema,
		execute: async (_toolCallId, input) => {
			const runtimeDir = serverRuntimeDirForGoal(options.goalId, options.workspaceDir);
			const reason = input.reason.trim();
			if (!reason) throw new Error("wiki_update reason is required");
			if (input.reconsider && input.source_run_id) throw new Error("Wiki reconsideration uses the complete Goal corpus; omit source_run_id");
			const rebuild = input.rebuild || input.reconsider === true;
			if (options.deferCueWikiUpdates) return {
				content: [{ type: "text" as const, text: "Wiki maintenance is deferred to the separate Wiki compilation Replay." }],
				details: { action: "deferred" },
			};
			const goalText = {
				title: options.getGoalTitle?.() ?? options.goalTitle ?? options.goalId,
				description: options.getGoalDescription?.() ?? options.goalDescription ?? "",
			};
			const goalContext = {
				...goalText,
				language: resolveGoalOutputLanguage(options.getOutputLanguage?.() ?? "auto", goalText),
			};
			const target = { workspaceDir: options.workspaceDir, goalId: options.goalId, goalDir: options.goalDir };
			const mainSession = options.getMainSession?.();
			if (!input.source_run_id && !rebuild) {
				registerSavedInvestigationCues(target);
				const status = getCueWikiQueueStatus(target);
				if (status.pendingCount) {
					const { receipt } = startGoalCueWikiUpdates({ ...target, goalContext,
						curationInstructions: reason, ...(mainSession ? { mainSession } : {}), env: { ...process.env, ...options.getEnv() }, retry: true });
					return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }],
						 details: { ...receipt, action: receipt.status === "running" ? "started" : "pending" } };
				}
				if (existsSync(join(runtimeDir, "cue-wiki-queue.json"))) return {
					content: [{ type: "text" as const, text: "Saved Cue maintenance has no pending evidence." }],
					details: { ...status, action: "reused" },
				};
			}
			if (!input.source_run_id && rebuild) {
				const snapshot = createGoalNoteSnapshot({ goalDir: options.goalDir, snapshotId: "goal-note-corpus" });
				if (!snapshot.notes.some(record => record.note.sections.length)) throw new Error("This Goal has no validated Cornell evidence to rebuild Wiki");
				const text = `${JSON.stringify(snapshot, null, 2)}\n`;
				const sourceRunDirectory = join(options.goalDir, "wiki", "cue-batches", `corpus-${sha256(text)}`);
				const store = new RunArtifactStore(sourceRunDirectory);
				const path = "artifacts/input/notes.json";
				const artifact = existsSync(join(sourceRunDirectory, path)) ? store.describeFile(path) : store.publishText(text, path);
				if (artifact.sha256 !== sha256(text)) throw new Error("Goal Cornell corpus snapshot changed");
				const started = startUpdate({ ...target, goal: [goalContext.title, goalContext.description].filter(Boolean).join("\n\n"),
					goalContext, topicPlan: new GoalTopicPlanStore(options.goalId, options.workspaceDir).requireResearchReady(),
					curationReviews: listDeliveredInvestigationReviews(target),
					...(mainSession ? { mainSession } : {}),
					sourceRunDirectory, sourceNotes: { relative_path: artifact.relativePath, sha256: artifact.sha256, byte_length: artifact.byteLength },
					trigger: { kind: "agent", agent_name: "main_agent" }, reason, rebuild: true, env: { ...process.env, ...options.getEnv() } });
				if (!started.reused) void started.execution.catch(() => undefined);
				return { content: [{ type: "text" as const, text: `Wiki Update Activity started: ${started.wikiUpdateId}` }],
					details: { wikiUpdateId: started.wikiUpdateId, action: started.reused ? "reused" : "started" } };
			}
			const sourceRunId = input.source_run_id ? safeId(input.source_run_id) : latestResearchRunId(runtimeDir, options.goalId);
			const state = readPublishedRunInput(join(runtimeDir, "runs", sourceRunId));
			if (state.goalId !== options.goalId || state.runId !== sourceRunId) throw new Error(`Unknown Research Run: ${sourceRunId}`);
			const sourceNotes = state.sourceNotes.at(-1);
			if (!sourceNotes) throw new Error(`Research Run '${sourceRunId}' has no Cornell Notes checkpoint`);
			const started = startUpdate({
				workspaceDir: options.workspaceDir,
				goalId: options.goalId,
				goalDir: options.goalDir,
				goal: [goalContext.title, goalContext.description, state.question].filter(Boolean).join("\n\n"),
				goalContext,
				topicPlan: new GoalTopicPlanStore(options.goalId, options.workspaceDir).requireResearchReady(),
				sourceRunId,
				sourceRunDirectory: join(options.goalDir, "wiki", "runs", sourceRunId),
				sourceNotes,
				curationReviews: listDeliveredInvestigationReviews(target),
				...(mainSession ? { mainSession } : {}),
				trigger: { kind: "agent", agent_name: "main_agent" },
				reason,
				rebuild,
				env: options.getEnv(),
			});
			// Runtime persists the failed Activity; observe its rejection without delaying this start receipt.
			if (!started.reused) void started.execution.catch(() => undefined);
			return {
				content: [{
					type: "text" as const,
					text: started.reused
						? `Wiki Update Activity reused: ${started.wikiUpdateId} (${started.status})`
						: `Wiki Update Activity started: ${started.wikiUpdateId}`,
				}],
				details: { wikiUpdateId: started.wikiUpdateId, sourceRunId,
					action: started.reused ? "reused" : "started",
					...(started.reused ? { status: started.status } : {}) },
			};
		},
	};
}

function latestResearchRunId(runtimeDir: string, goalId: string): string {
	const candidates = readdirSync(join(runtimeDir, "runs"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => right.localeCompare(left));
	for (const runId of candidates) {
		try {
			const state = readPublishedRunInput(join(runtimeDir, "runs", runId));
			if (state.goalId === goalId && state.sourceNotes.length > 0) return runId;
		} catch {
			// Ignore directories that are not complete Research Run checkpoints.
		}
	}
	throw new Error("This Goal has no Research Run with a Cornell Notes checkpoint");
}

function readPublishedRunInput(controlDirectory: string): {
	goalId: string;
	runId: string;
	question: string;
	sourceNotes: RunArtifactRef[];
} {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(join(controlDirectory, "run-state.json"), "utf-8"));
	} catch {
		throw new Error("Unknown Research Run");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Research Run state is invalid");
	const state = value as Record<string, unknown>;
	if (
			typeof state.goal_id !== "string"
			|| typeof state.run_id !== "string"
			|| typeof state.question !== "string"
			|| !Array.isArray(state.note_snapshots)
	) throw new Error("Research Run state has no Wiki input");
	const sourceNotes = state.note_snapshots.filter((candidate): candidate is RunArtifactRef => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
		const artifact = candidate as Record<string, unknown>;
		return typeof artifact.relative_path === "string"
			&& typeof artifact.sha256 === "string"
			&& typeof artifact.byte_length === "number";
	});
	return {
		goalId: state.goal_id,
		runId: state.run_id,
		question: state.question,
		sourceNotes,
	};
}

function safeId(value: string): string {
	const clean = value.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(clean)) throw new Error("Invalid Research Run id");
	return clean;
}
