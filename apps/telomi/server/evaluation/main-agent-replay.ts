import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { GoalSnapshot, PromptInput } from "../../shared/types.js";
import { GoalRunner } from "../main-agent/runner.js";
import { attachmentPayloadsFromCase, type AttachmentCaseDescriptor } from "../main-agent/attachment-utils.js";
import { FileIngestService } from "../ingestion/service.js";
import { captureMainAgentNodeEvaluation } from "./main-agent-evaluation.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { sha256 } from "../lib/hash.js";
import { getResearchSourceServiceClient } from "../providers/source-service-client.js";
import {
	goalTopicDocumentFromPlan,
	GoalTopicPlanHistory,
	GoalTopicPlanStore,
	parseGoalTopicDocument,
	stringifyGoalTopicDocument,
	TOPIC_PLAN_DOCUMENT_PATH,
} from "../goals/topic-plan/index.js";
import {
	readNodeEvaluationFile,
	type NodeEvaluationCase,
	type NodeReplayRecipe,
} from "../agent-runtime/node-evaluation.js";

/** One Replay Goal id per execution, so concurrent or repeated Replays never share Goal state. */
function mainAgentReplayGoalId(recordDirectory: string): string {
	return `main-agent-backtest-${sha256(recordDirectory).slice(0, 16)}`;
}

export function createMainAgentReplayRecipe(): NodeReplayRecipe {
	return {
		identity: { id: "main-agent", version: 1 },
		async replay(input) {
			if (input.value.agentId !== "main-agent") {
				throw new Error(`Node Case belongs to Agent '${input.value.agentId}'`);
			}
			return replayMainAgentCase(input, mainAgentReplayGoalId(input.recordDirectory));
		},
	};
}

async function replayMainAgentCase(
	{
		casePath,
		value,
		sourceRunDirectory,
		harnessWorkspaceDirectory,
		recordDirectory,
		artifactStore,
		candidateCase,
		promptOverride,
		signal,
	}: Parameters<NodeReplayRecipe["replay"]>[0],
	goalId: string,
): ReturnType<NodeReplayRecipe["replay"]> {
		const workspaceDirectory = join(recordDirectory, "main-runtime");
		const goalDirectory = await prepareMainAgentReplayGoalWorkspace({
			value,
			casePath,
			sourceRunDirectory,
			harnessWorkspaceDirectory,
			workspaceDirectory,
			goalId,
		});
		const contextBefore = value.request.session.contextBefore;
		const contextBeforeBytes = contextBefore
			? Buffer.from(readNodeEvaluationFile(casePath, contextBefore))
			: undefined;
		if (contextBefore) {
			writeFileSync(
				join(goalDirectory, "context.jsonl"),
				contextBeforeBytes!,
				{ mode: 0o600 },
			);
		}
		const recipeInput = mainAgentRecipeInput(value.recipeInput);
		const systemPrompt = promptOverride?.systemPrompt
			?? readNodeEvaluationFile(casePath, value.request.composedSystemPrompt);
		const userPrompt = promptOverride?.userPrompt
			?? readNodeEvaluationFile(casePath, value.request.userPrompt);
		// An attachment turn replays the whole hand-off: the originals come back from the Case input
		// tree (the logical workspace beside the manifest, laid out by guest path), and the
		// Candidate's own Runtime persists, routes and parses them again.
		const turnInput: PromptInput = recipeInput.attachments
			? {
				role: "user-with-attachments",
				content: userPrompt,
				attachments: attachmentPayloadsFromCase(join(dirname(casePath), "input"), recipeInput.attachments),
			}
			: userPrompt;
		const fileIngestService = recipeInput.attachments
			? new FileIngestService({ workspaceDir: workspaceDirectory, listGoalIds: () => [goalId] })
			: undefined;
		fileIngestService?.start({ resumeQueued: false });
		let latest: GoalSnapshot | undefined;
		const runner = new GoalRunner(
			workspaceDirectory,
			goalId,
			"Main Agent Backtest",
			goalDirectory,
			(snapshot) => { latest = snapshot; },
			"Main Agent Node Backtest",
			undefined,
			{ systemPrompt, ...(promptOverride?.userPrompt ? { userPrompt: promptOverride.userPrompt } : {}) },
			undefined,
			undefined,
			undefined,
			fileIngestService,
		);
		let nativeRunDirectory: string | undefined;
		try {
			let terminal;
			let nativeMessages: GoalSnapshot["messages"] = [];
			try {
				await runner.init();
				await runner.bindExtensions();
				runner.updateConfig({
					modelId: value.request.actualModel,
					thinkingLevel: recipeInput.thinkingLevel,
				});
				await runMainAgent(runner, turnInput, signal);
				latest = runner.getSnapshot();
				if (latest.errorMessage) throw new Error(latest.errorMessage);
				terminal = runner.getLastTerminalDetails();
				if (!terminal) throw new Error("Main Agent Node Backtest completed without terminal details");
				nativeRunDirectory = resolveMainAgentRunDirectory(workspaceDirectory, goalId);
				nativeMessages = readJsonLines(join(nativeRunDirectory, "main-agent.jsonl"));
			} finally {
				fileIngestService?.stop();
				runner.dispose();
				// A failed turn still leaves its native Run (Trace, Session, hand-off notice) behind;
				// keep it beside the failure record instead of deleting it with the workspace.
				if (!nativeRunDirectory) {
					try { nativeRunDirectory = resolveMainAgentRunDirectory(workspaceDirectory, goalId); } catch { /* no native Run was started */ }
				}
				if (nativeRunDirectory && existsSync(nativeRunDirectory)) {
					renameSync(nativeRunDirectory, join(recordDirectory, "main-agent-trace"));
				}
			}
			const artifact = artifactStore.publishText(`${JSON.stringify({
				userResponse: terminal.userResponse,
				trace: terminal.trace,
			}, null, 2)}\n`, "artifacts/main-agent/result.json");
			const toolCalls = countToolCalls(nativeMessages);
			if (candidateCase) {
				const workspace = runner.getLastNodeWorkspaceSnapshot();
				if (!workspace) throw new Error("Main Agent Candidate Replay completed without workspace snapshots");
				captureMainAgentNodeEvaluation({
					runId: candidateCase.sourceRunId,
					runDirectory: recordDirectory,
					question: userPrompt,
					systemPrompt,
					actualModel: value.request.actualModel,
					thinkingLevel: recipeInput.thinkingLevel,
					...(contextBeforeBytes ? { contextBefore: contextBeforeBytes } : {}),
					sessionPath: join(recordDirectory, "main-agent-trace", "main-agent.jsonl"),
					terminal,
					toolCounts: { all: toolCalls },
					...(latest.lastRunUsage ? { usage: latest.lastRunUsage } : {}),
					workspace,
					logicalWorkspacePath: join(recordDirectory, "main-agent-trace", "node-evaluation", "main-agent-logical-workspace"),
					capabilitySnapshotId: candidateCase.capabilitySnapshotId,
					...(recipeInput.attachments ? { attachments: recipeInput.attachments } : {}),
				});
			}
			return {
				caseId: value.caseId,
				agentId: value.agentId,
				artifact,
				usage: {
					inputTokens: latest.lastRunUsage?.input ?? 0,
					outputTokens: latest.lastRunUsage?.output ?? 0,
					costUsd: latest.lastRunUsage?.cost.total ?? 0,
					calls: latest.lastRunUsage?.assistantMessageCount ?? 0,
				},
				turns: latest.lastRunUsage?.assistantMessageCount ?? 0,
				toolCalls,
			};
		} finally {
			// The nested Replay workspace is disposable and never the product workspace.
			rmSync(workspaceDirectory, { recursive: true, force: true });
		}
}

export async function prepareMainAgentReplayGoalWorkspace(input: {
	value: NodeEvaluationCase;
	casePath: string;
	sourceRunDirectory: string;
	harnessWorkspaceDirectory: string;
	workspaceDirectory: string;
	goalId: string;
}): Promise<string> {
	const goalDirectory = join(input.workspaceDirectory, input.goalId);
	rmSync(input.workspaceDirectory, { recursive: true, force: true });
	mkdirSync(goalDirectory, { recursive: true });
	const bundledInput = join(input.sourceRunDirectory, "workspace", "input");
	if (existsSync(bundledInput)) {
		cpSync(bundledInput, goalDirectory, { recursive: true, force: true });
	} else if (input.value.workspace?.input_tree_sha) {
		await getResearchSourceServiceClient().restoreTree(input.value.workspace.input_tree_sha, goalDirectory);
	}
	cpSync(input.harnessWorkspaceDirectory, goalDirectory, { recursive: true, force: true });
	restoreReplayTopicPlan({
		caseInputDirectory: join(dirname(input.casePath), "input"),
		goalDirectory,
		workspaceDirectory: input.workspaceDirectory,
		goalId: input.goalId,
	});
	return goalDirectory;
}

/**
 * A Goal's confirmed Topic Plan lives in the server Runtime store, outside the Goal directory a
 * Case freezes, so a Replay would otherwise start from an empty plan and ask the user to confirm a
 * Topic Plan the Case shows as already confirmed. Rebuild the store from the Case's own frozen
 * logical workspace, and fail explicitly when a historical Case cannot supply that state.
 */
function restoreReplayTopicPlan(input: {
	caseInputDirectory: string;
	goalDirectory: string;
	workspaceDirectory: string;
	goalId: string;
}): void {
	const frozenPlanPath = join(input.caseInputDirectory, "work", "topic-plan.json");
	const frozenPlan = existsSync(frozenPlanPath) ? readFileSync(frozenPlanPath, "utf-8") : undefined;
	const confirmedDocument = join(input.goalDirectory, TOPIC_PLAN_DOCUMENT_PATH);
	if (frozenPlan === undefined && !existsSync(confirmedDocument)) return;
	const snapshotPath = join(input.caseInputDirectory, "history", "topic-plan.jsonl");
	const snapshot = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf-8").trim() : "";
	if (!snapshot) {
		const confirmed = existsSync(confirmedDocument) ? readFileSync(confirmedDocument, "utf-8") : undefined;
		if (existsSync(snapshotPath) && confirmed === undefined) {
			// Capture wrote an empty history: the Goal had no confirmed plan yet, so the frozen work
			// document is the pending draft the Agent saw (a fresh Goal's first turns). Restore it as
			// the same pending Proposal so the Candidate sees the draft instead of an empty plan.
			const draft = frozenPlan === undefined ? undefined : parseGoalTopicDocument(frozenPlan, true);
			if (draft && draft.topics.length > 0) {
				new GoalTopicPlanStore(input.goalId, input.workspaceDirectory).syncDocument({
					document: draft,
					source: "main_agent",
					summary: "Replay restores the pending Topic Plan draft the Case froze",
				});
			}
			return;
		}
		if (existsSync(snapshotPath) && [frozenPlan, confirmed].every((document) =>
			document === undefined || parseGoalTopicDocument(document, true).topics.length === 0)) return;
		throw new Error("Node Case froze a Topic Plan context without the Topic Plan history that restores it");
	}
	new GoalTopicPlanHistory(input.goalId, input.workspaceDirectory).restoreSnapshot(snapshot);
	const active = new GoalTopicPlanStore(input.goalId, input.workspaceDirectory).readActive();
	if (!active) throw new Error("Restored Topic Plan history produced no confirmed Topic Plan");
	const restored = stringifyGoalTopicDocument(goalTopicDocumentFromPlan(active));
	if (frozenPlan !== undefined && restored !== frozenPlan) {
		throw new Error("Node Case froze a Topic Plan its history cannot reproduce, so the Case lacks the Replay evidence for it");
	}
}

function runMainAgent(runner: GoalRunner, prompt: PromptInput, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let started = false;
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			unsubscribe();
			if (error) reject(error);
			else resolve();
		};
		const abort = () => {
			runner.abort();
			finish(new Error("Main Agent Node Backtest cancelled"));
		};
		const unsubscribe = runner.subscribe((event) => {
			if (!started || event.type !== "snapshot" || event.state.isStreaming) return;
			finish(event.state.errorMessage ? new Error(event.state.errorMessage) : undefined);
		});
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		started = true;
		runner.start(prompt);
	});
}

function mainAgentRecipeInput(value: unknown): { thinkingLevel: ThinkingLevel; attachments?: AttachmentCaseDescriptor[] } {
	const record = value as { thinkingLevel?: unknown; attachments?: unknown } | undefined;
	const thinkingLevel = record?.thinkingLevel;
	if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(thinkingLevel))) {
		throw new Error("Main Agent Node Case has an invalid thinking level");
	}
	const attachments = record?.attachments;
	if (attachments !== undefined) {
		if (!Array.isArray(attachments) || !attachments.every((item) => item && typeof item === "object"
			&& typeof (item as AttachmentCaseDescriptor).id === "string" && typeof (item as AttachmentCaseDescriptor).fileName === "string"
			&& ["image", "document"].includes(String((item as AttachmentCaseDescriptor).type)))) {
			throw new Error("Main Agent Node Case has invalid attachment descriptors");
		}
	}
	return {
		thinkingLevel: thinkingLevel as ThinkingLevel,
		...(Array.isArray(attachments) && attachments.length ? { attachments: attachments as AttachmentCaseDescriptor[] } : {}),
	};
}

function countToolCalls(messages: GoalSnapshot["messages"]): number {
	return messages.reduce((total, message) => total + (
		message.role === "assistant" && Array.isArray(message.content)
			? message.content.filter((item) => item.type === "toolCall").length
			: 0
	), 0);
}

function resolveMainAgentRunDirectory(workspaceDirectory: string, goalId: string): string {
	const runsRoot = join(serverRuntimeDirForGoal(goalId, workspaceDirectory), "main-agent", "runs");
	const runs = readdirSync(runsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	if (runs.length !== 1) throw new Error(`Main Agent Node Backtest expected one native Run, received ${runs.length}`);
	return join(runsRoot, runs[0]!.name);
}

function readJsonLines(path: string): GoalSnapshot["messages"] {
	return readFileSync(path, "utf-8").split(/\r?\n/u).filter(Boolean)
		.map((line) => JSON.parse(line) as GoalSnapshot["messages"][number]);
}
