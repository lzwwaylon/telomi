import { resolveGoalOutputLanguage, type OutputLanguage } from "../../../shared/languages.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import { GoalTopicPlanStore } from "../../goals/topic-plan/index.js";
import type { RunArtifactRef } from "../../agent-runtime/artifact-store.js";
import { startWikiUpdateActivity } from "../../wiki/update-runner.js";

const schema = Type.Object({
	source_run_id: Type.Optional(Type.String({ minLength: 1,
		description: "Research Run id. Omit to use this Goal's latest Run with a Cornell Notes checkpoint." })),
	reason: Type.String({ minLength: 1 }),
	rebuild: Type.Boolean({ description: "True only when the user explicitly asks to rebuild or regenerate the Wiki from scratch." }),
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
}, startUpdate = startWikiUpdateActivity): AgentTool<typeof schema> {
	return {
		name: "wiki_update",
		label: "wiki_update",
		description: "Start an independent Goal Wiki update from a Research Run's validated Cornell Notes. Set rebuild=true for an explicit rebuild/regenerate request; false performs an incremental refresh. Returns immediately with a Wiki Update Activity id.",
		parameters: schema,
		execute: async (_toolCallId, input) => {
			const runtimeDir = serverRuntimeDirForGoal(options.goalId, options.workspaceDir);
			const sourceRunId = input.source_run_id
				? safeId(input.source_run_id)
				: latestResearchRunId(runtimeDir, options.goalId);
			const reason = input.reason.trim();
			if (!reason) throw new Error("wiki_update reason is required");
			const sourceControl = join(runtimeDir, "runs", sourceRunId);
			const state = readPublishedRunInput(sourceControl);
			if (state.goalId !== options.goalId || state.runId !== sourceRunId) {
				throw new Error(`Unknown Research Run: ${sourceRunId}`);
			}
			const cornellNotes = state.cornellNotes.at(-1);
			if (!cornellNotes) throw new Error(`Research Run '${sourceRunId}' has no Cornell Notes checkpoint`);
			const goalText = {
				title: options.getGoalTitle?.() ?? options.goalTitle ?? options.goalId,
				description: options.getGoalDescription?.() ?? options.goalDescription ?? "",
			};
			const goalContext = {
				...goalText,
				language: resolveGoalOutputLanguage(options.getOutputLanguage?.() ?? "auto", goalText),
			};
			const started = startUpdate({
				workspaceDir: options.workspaceDir,
				goalId: options.goalId,
				goalDir: options.goalDir,
				goal: [goalContext.title, goalContext.description, state.question].filter(Boolean).join("\n\n"),
				goalContext,
				topicPlan: new GoalTopicPlanStore(options.goalId, options.workspaceDir).requireResearchReady(),
				sourceRunId,
				sourceRunDirectory: join(options.goalDir, "wiki", "runs", sourceRunId),
				cornellNotes,
				trigger: { kind: "agent", agent_name: "main_agent" },
				reason,
				rebuild: input.rebuild,
				env: options.getEnv(),
			});
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
			if (state.goalId === goalId && state.cornellNotes.length > 0) return runId;
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
	cornellNotes: RunArtifactRef[];
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
			|| !Array.isArray(state.cornell_note_snapshots)
	) throw new Error("Research Run state has no Wiki input");
	const cornellNotes = state.cornell_note_snapshots.filter((candidate): candidate is RunArtifactRef => {
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
		cornellNotes,
	};
}

function safeId(value: string): string {
	const clean = value.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(clean)) throw new Error("Invalid Research Run id");
	return clean;
}
