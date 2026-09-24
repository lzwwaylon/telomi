import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, sep } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import type {
	AgentStageRequest,
	AgentStageRole,
	AgentStageRunner,
	StageArtifactKind,
} from "./agent-stage-runtime.js";
import {
	frozenInteractionLedger,
	readNodeEvaluationFile,
	resolveNodeEvaluationMounts,
	restoreNodeEvaluationSession,
	type NodeReplayRecipe,
	type NodeEvaluationInteraction,
} from "./node-evaluation.js";
import { isInsideRoot } from "../lib/paths.js";

export const RECORDED_STAGE_AGENT_IDS = ["cornell-note", "report-writer"] as const;
export const RECORDED_STAGE_RECIPE_VERSIONS = {
	"cornell-note": 3,
	"report-writer": 2,
} as const;

export const recordedStageReplayRecipes: readonly NodeReplayRecipe[] = RECORDED_STAGE_AGENT_IDS.map(
	(agentId) => createRecordedStageReplayRecipe(agentId, recipeVersion(agentId)),
);

/** Optional Cornell observer: product execution supplies context, Capture owns the Replay contract. */
export function withCornellNoteCapture(
	runner: AgentStageRunner,
	context: Record<string, unknown>,
	skills: readonly { hostPath: string; workspaceRelativePath: string }[],
): AgentStageRunner {
	return {
		runStage: <T>(request: AgentStageRequest<T>) => runner.runStage({
			...request,
			evaluation: {
				agentId: "cornell-note",
				recipe: { id: "cornell-note", version: RECORDED_STAGE_RECIPE_VERSIONS["cornell-note"] },
				recipeInput: context,
				inputGuestPath: "/source",
				harnessMounts: skills.map((skill) => ({
					guestPath: request.readonlyMounts.find((mount) => mount.hostPath === skill.hostPath)!.guestPath,
					workspaceRelativePath: skill.workspaceRelativePath,
				})),
				writableGuestPaths: [],
				liveExternalState: false,
			},
		}),
	};
}

export function withResearchNodeEvaluationCapture(
	runner: AgentStageRunner,
	harnessWorkspaceDirectory: string,
): AgentStageRunner {
	return {
		runStage: <T>(request: AgentStageRequest<T>) => {
			if (request.evaluation || (request.recordKind ?? "research") !== "research") {
				return runner.runStage(request);
			}
			const agentId = agentIdForRole(request.role);
			if (!agentId) return runner.runStage(request);
			const harnessMounts = request.readonlyMounts.flatMap((mount) => {
				const workspaceRelativePath = relativeInside(harnessWorkspaceDirectory, mount.hostPath);
				return workspaceRelativePath
					? [{ guestPath: mount.guestPath, workspaceRelativePath }]
					: [];
			});
			const harnessGuests = new Set(harnessMounts.map((mount) => mount.guestPath));
			const inputGuestPath = request.readonlyMounts.find((mount) => !harnessGuests.has(mount.guestPath))?.guestPath;
			return runner.runStage({
				...request,
				evaluation: {
					agentId,
					recipe: { id: agentId, version: recipeVersion(agentId) },
					recipeInput: {},
					...(inputGuestPath ? { inputGuestPath } : {}),
					harnessMounts,
					liveExternalState: false,
				},
			});
		},
	};
}

function createRecordedStageReplayRecipe(
	agentId: typeof RECORDED_STAGE_AGENT_IDS[number],
	version: number,
): NodeReplayRecipe {
	return {
		identity: { id: agentId, version },
		async replay({
			casePath,
			value,
			sourceRunDirectory,
			harnessWorkspaceDirectory,
			recordDirectory,
			workDirectory,
			artifactStore,
			runner,
			candidateCase,
			signal,
		}) {
			if (value.agentId !== agentId) throw new Error(`Node Case belongs to Agent '${value.agentId}'`);
			if (!value.request.modelPolicy) throw new Error(`Node Case '${value.caseId}' has no replayable historical model policy`);
			restoreNodeEvaluationSession(casePath, value, recordDirectory);
			const output = value.request.outputContract;
			const inputGuestPath = value.mounts.find((mount) => mount.kind === "run")?.guestPath;
			const interactionReplay = createInteractionReplay(casePath, value.request.interactions);
			const stage = await runner.runStage({
				runId: candidateCase?.sourceRunId ?? value.runId,
				stageId: value.nodeId,
				attemptId: value.attemptId,
				role: value.role,
				promptConfig: value.request.promptConfig as NonNullable<AgentStageRequest<unknown>["promptConfig"]>,
				recordDirectory,
				recordKind: candidateCase ? "research" : "evaluation",
				session: value.request.session,
				modelPolicy: value.request.modelPolicy,
				systemPrompt: readNodeEvaluationFile(casePath, value.request.systemPrompt),
				userPrompt: readNodeEvaluationFile(casePath, value.request.userPrompt),
				workDirectory,
				readonlyMounts: resolveNodeEvaluationMounts(
					casePath,
					value,
					sourceRunDirectory,
					harnessWorkspaceDirectory,
				),
				controlDirectory: recordDirectory,
				artifactStore,
				evaluation: {
					agentId: value.agentId,
					recipe: value.recipe,
					recipeInput: value.recipeInput,
					...(candidateCase ? { capabilitySnapshotId: candidateCase.capabilitySnapshotId } : {}),
					...(inputGuestPath ? { inputGuestPath } : {}),
					harnessMounts: value.mounts.flatMap((mount) => mount.kind === "harness"
						? [{ guestPath: mount.guestPath, workspaceRelativePath: mount.workspaceRelativePath }]
						: []),
					...(value.writableMounts?.length
						? { writableGuestPaths: value.writableMounts.map((mount) => mount.guestPath) }
						: {}),
					liveExternalState: value.liveExternalState,
				},
				output: {
					kind: output.kind,
					publishRelativePath: output.publishRelativePath,
					...(output.entryRelativePath ? { entryRelativePath: output.entryRelativePath } : {}),
					...(output.rootRelativePath ? { rootRelativePath: output.rootRelativePath } : {}),
					...(output.guestEntryPath ? { guestEntryPath: output.guestEntryPath } : {}),
					validate: ({ entryPath }) => validateRecordedOutput(output.kind, entryPath),
				},
				...(value.request.executionProfile ? { executionProfile: value.request.executionProfile } : {}),
				...(interactionReplay.tools.length > 0 ? { additionalTools: interactionReplay.tools } : {}),
				signal,
			});
			return {
				caseId: value.caseId,
				agentId: value.agentId,
				artifact: stage.artifact,
				usage: stage.usage,
				turns: stage.turns,
				toolCalls: stage.toolCalls,
			};
		},
	};
}

function recipeVersion(agentId: typeof RECORDED_STAGE_AGENT_IDS[number]): number {
	return RECORDED_STAGE_RECIPE_VERSIONS[agentId];
}

function createInteractionReplay(
	casePath: string,
	ref: Parameters<typeof readNodeEvaluationFile>[1] | undefined,
): { tools: AgentTool[] } {
	if (!ref) return { tools: [] };
	const interactions = JSON.parse(readNodeEvaluationFile(casePath, ref)) as NodeEvaluationInteraction[];
	const answer = frozenInteractionLedger(interactions);
	const toolFixtures = interactions.filter((item) => item.kind === "tool");
	const tools = [...new Map(toolFixtures.map((fixture) => [fixture.name, fixture])).values()].map((fixture): AgentTool => ({
		name: fixture.name,
		label: fixture.label,
		description: fixture.description,
		parameters: Type.Any(),
		execute: async (_toolCallId, args) => answer(fixture.name, args) as never,
	}));
	return { tools };
}

function validateRecordedOutput(kind: StageArtifactKind, entryPath: string): unknown {
	const content = readFileSync(entryPath, "utf-8");
	if (kind === "chapter" || kind === "stage_report") {
		if (!content.trim()) throw new Error("Stage output must not be empty");
		return content;
	}
	return JSON.parse(content) as unknown;
}

function agentIdForRole(role: AgentStageRole): typeof RECORDED_STAGE_AGENT_IDS[number] | undefined {
	const ids: Record<string, typeof RECORDED_STAGE_AGENT_IDS[number]> = {
		cornell_note: "cornell-note",
		report_writer: "report-writer",
	};
	return ids[role];
}

function relativeInside(root: string, path: string): string | undefined {
	if (!existsSync(root) || !existsSync(path)) return undefined;
	const realRoot = realpathSync(root);
	const realPath = realpathSync(path);
	if (realPath === realRoot || !isInsideRoot(realRoot, realPath)) return undefined;
	return relative(realRoot, realPath).split(sep).join("/");
}
