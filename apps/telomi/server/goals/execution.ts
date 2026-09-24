import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AttachmentPayload, GoalEventEnvelope, GoalSnapshot, GoalSummary, GoalTurnContext, PromptInput } from "../../shared/types.js";
import type { OutputLanguage } from "../../shared/languages.js";
import type { ScheduledResearchContext } from "../research/scheduled-research-context.js";
import type { ResearchRunResult } from "../research/execute-run.js";

/** Session capabilities used by Goals and its API consumers. */
export interface GoalSession {
	getSnapshot(): GoalSnapshot;
	getPreview(): string;
	getMainWorkspaceDirectories?(): { workDirectory: string; artifactsDirectory: string } | undefined;
	/** Display-only attachment records: the names the user gave the files stored for this Goal. */
	listAttachments?(): AttachmentPayload[];
	isRunning(): boolean;
	start(input: PromptInput, profile?: "voice", context?: GoalTurnContext): void;
	steer(input: string): Promise<void>;
	abort(): void;
	dispose(): void;
	updateConfig(config: { modelId?: string; thinkingLevel?: ThinkingLevel }): void;
	/** Reload the model catalog so a connection activated since startup becomes resolvable. */
	refreshModelCatalog(): Promise<void>;
	setTitle(title: string): void;
	setDescription(description: string): void;
	appendExternalAssistantMessage(text: string, mainRoute?: Record<string, unknown>): Promise<void>;
	/** Records a Goal lifecycle event in the session; false when the same event is already there. */
	recordEvent(text: string): Promise<boolean>;
	subscribe(listener: (event: GoalEventEnvelope) => void): () => void;
	projectUserMemory(): Promise<void>;
}

export interface GoalScheduledResearchRequest {
	goalId: string;
	title: string;
	question: string;
	reportContext: string;
	context: ScheduledResearchContext;
	signal?: AbortSignal;
	/** The Research Run id, as soon as it exists, so the occurrence can point at it while it runs. */
	onRunReserved?: (runId: string) => void;
}

/** The application supplies initialized sessions and the Run tool entry points. */
export interface GoalExecution {
	resumeWikiUpdate(input: {
		workspaceDir: string;
		goalId: string;
		goalDir: string;
		runId: string;
		env: Record<string, string>;
	}): Promise<{ pageCount: number }>;
	createRunner(input: {
		workspaceDir: string;
		goal: GoalSummary;
		goalDir: string;
		onSnapshot: (snapshot: GoalSnapshot) => void;
		getExtraEnv: () => Record<string, string>;
		getDiscoveryEnabled: () => boolean;
		getOutputLanguage: () => OutputLanguage;
	}): Promise<GoalSession>;
	/** Persist the Run checkpoint synchronously before yielding during initialization. */
	executeResearchRun(input: {
		workspaceDir: string;
		goal: GoalSummary;
		getExtraEnv: () => Record<string, string>;
		request: GoalScheduledResearchRequest;
	}): Promise<ResearchRunResult>;
	/** Claim the persisted resume checkpoint synchronously before yielding. */
	resumeResearchRun(input: {
		workspaceDir: string;
		goal: GoalSummary;
		getExtraEnv: () => Record<string, string>;
		runId: string;
	}): Promise<ResearchRunResult>;
}
