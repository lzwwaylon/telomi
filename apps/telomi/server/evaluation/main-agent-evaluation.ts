import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { UsageSummary } from "../../shared/types.js";
import type { WorkspaceSnapshotRecord } from "../observability/run-records.js";
import type { MainTerminalDetails } from "../main-agent/tools/terminal-action.js";
import type { AttachmentCaseDescriptor } from "../main-agent/attachment-utils.js";
import {
	beginNodeEvaluationCase,
	finishNodeEvaluationCase,
} from "../agent-runtime/node-evaluation.js";
import {
	RunArtifactStore,
} from "../agent-runtime/artifact-store.js";
import type { AgentStageRequest, ValidatedStageArtifact } from "../agent-runtime/agent-stage-runtime.js";

export function captureMainAgentNodeEvaluation(input: {
	runId: string;
	runDirectory: string;
	question: string;
	systemPrompt: string;
	actualModel: string;
	thinkingLevel: ThinkingLevel;
	contextBefore?: Buffer;
	sessionPath: string;
	terminal: MainTerminalDetails;
	toolCounts: Record<string, number>;
	usage?: UsageSummary;
	workspace?: WorkspaceSnapshotRecord;
	logicalWorkspacePath: string;
	capabilitySnapshotId?: string;
	/** This turn's attachments; their bytes are already in the logical workspace under `attachments/`. */
	attachments?: AttachmentCaseDescriptor[];
}): void {
	const logicalWorkspace = JSON.parse(readFileSync(`${input.logicalWorkspacePath}.json`, "utf-8")) as unknown;
	const store = new RunArtifactStore(input.runDirectory);
	const output = store.publishText(`${JSON.stringify({
		userResponse: input.terminal.userResponse,
		trace: input.terminal.trace,
	}, null, 2)}\n`, "node-evaluation/main-agent-observed.json");
	const contextPath = join(input.runDirectory, "node-evaluation", "main-agent-context-before.jsonl");
	if (input.contextBefore) {
		writeFileSync(contextPath, input.contextBefore, { flag: "wx", mode: 0o600 });
	}
	const workDirectory = join(input.runDirectory, "node-evaluation", "main-agent-work");
	const request: AgentStageRequest<unknown> = {
		runId: input.runId,
		stageId: "main-agent",
		attemptId: "1",
		role: "main-agent",
		promptConfig: {
			domain: "main",
			id: "router",
			sandboxRole: "main.router",
		} as unknown as NonNullable<AgentStageRequest<unknown>["promptConfig"]>,
		recordKind: "main",
		evaluation: {
			agentId: "main-agent",
			recipe: { id: "main-agent", version: 1 },
			recipeInput: {
				thinkingLevel: input.thinkingLevel,
				logicalWorkspace,
				...(input.attachments?.length ? { attachments: input.attachments } : {}),
			},
			inputRelativePath: relative(input.runDirectory, input.logicalWorkspacePath).split(sep).join("/"),
			inputGuestPath: "/",
			harnessMounts: [],
			liveExternalState: false,
		},
		session: { key: "main-agent", policy: "continue" },
		modelPolicy: { preferred: [input.actualModel] },
		systemPrompt: input.systemPrompt,
		userPrompt: input.question,
		workDirectory,
		readonlyMounts: [],
		controlDirectory: input.runDirectory,
		recordDirectory: input.runDirectory,
		artifactStore: store,
		output: {
			kind: "route_decision",
			publishRelativePath: output.relativePath,
			validate: () => ({}),
		},
		signal: new AbortController().signal,
	};
	try {
		const draft = beginNodeEvaluationCase({
			request,
			recordDirectory: input.runDirectory,
			promptConfig: request.promptConfig!,
			sessionContextFile: existsSync(contextPath) ? contextPath : join(input.runDirectory, ".missing-context"),
			composedSystemPrompt: input.systemPrompt,
			actualModel: input.actualModel,
			...(input.capabilitySnapshotId ? { capabilitySnapshotId: input.capabilitySnapshotId } : {}),
		});
		if (!draft) throw new Error("Main Agent Node Evaluation draft was not created");
		const usage = input.usage;
		const result: ValidatedStageArtifact<unknown> = {
			value: input.terminal,
			artifact: output,
			submissionCount: 1,
			validationErrors: [],
			session: { id: input.runId, mode: "continued" },
			turns: usage?.assistantMessageCount ?? 1,
			toolCalls: Object.values(input.toolCounts).reduce((sum, count) => sum + count, 0),
			toolCounts: input.toolCounts,
			usage: {
				inputTokens: usage?.input ?? 0,
				outputTokens: usage?.output ?? 0,
				costUsd: usage?.cost.total ?? 0,
				calls: usage?.assistantMessageCount ?? 1,
			},
			sessionPath: input.sessionPath,
		};
		const captured = finishNodeEvaluationCase(draft, {
			status: "succeeded",
			workDirectory,
			result,
			validationErrors: [],
			...(input.workspace ? { workspace: input.workspace } : {}),
		});
		if (captured.status !== "captured") throw new Error(captured.reason);
	} finally {
		rmSync(contextPath, { force: true });
		rmSync(workDirectory, { recursive: true, force: true });
	}
}
