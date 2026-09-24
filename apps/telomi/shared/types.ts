import type { ConnectionCapability } from "./connections.js";
import type { ModelSwitch } from "./model-switch.js";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { OutputLanguage } from "./languages.js";
import type { GoalAvatar } from "./avatar.js";

export type MediaProductStatus = "idle" | "running" | "done" | "failed";

export type CustomProviderApiKind = "openai-completions" | "openai-responses";

/** A manual pin: the connection serves this one capability and lists only that capability's models. */
export type CustomProviderCapability = "audio-generation" | "audio-recognition" | "embedding";

/** The capability a pin selects models for; audio pins keep their historical names. */
export function pinnedCapability(capability: CustomProviderCapability | undefined): ConnectionCapability | undefined {
	return capability === "audio-generation" ? "tts" : capability === "audio-recognition" ? "stt" : capability;
}

export interface CustomProviderModel {
	id: string;
	name?: string;
	/** What discovery classified this model as; absent entries classify by id when read. */
	capabilities?: ConnectionCapability[];
	supportedVoices?: string[];
	[k: string]: unknown;
}

export interface CustomProviderSummary {
	capability?: CustomProviderCapability;
	id: string;
	baseUrl: string;
	api: CustomProviderApiKind;
	apiKeyHint: string | null;
	hasApiKey: boolean;
	compat: { supportsDeveloperRole?: boolean; supportsReasoningEffort?: boolean } | null;
	models: CustomProviderModel[];
}

export type ToolIconManifestEntry = {
	id: string;
	displayName: string;
	iconDataUrl: string;
};

export type ToolIconManifest = {
	version: number;
	commands: Record<string, ToolIconManifestEntry>;
};

export type ProviderAccountStatus = "ok" | "expired" | "rate-limited" | "auth-error" | "unknown";

export type ProviderErrorClass = "auth" | "quota" | "transient" | "permanent";

export interface ProviderAccountSummary {
	id: string;
	label: string;
	type: "oauth" | "api_key";
	accountId?: string;
	maskedToken?: string;
	createdAt: number;
	lastUsedAt?: number;
	lastErrorAt?: number;
	lastErrorMessage?: string;
	lastErrorClass?: ProviderErrorClass;
	status: ProviderAccountStatus;
	cooldownUntil?: number;
	isActive: boolean;
	chainPosition: number;
}

export interface CodexUsageWindow {
	usedPercent: number;
	windowDurationMins: number | null;
	resetsAt: number | null;
}

export interface CodexUsageTokenSummary {
	lifetimeTokens: number | null;
	peakDailyTokens: number | null;
	longestRunningTurnSec: number | null;
	currentStreakDays: number | null;
	longestStreakDays: number | null;
}

export interface CodexUsageSnapshot {
	status: "idle" | "loading" | "ok" | "error" | "unsupported";
	checkedAt?: number;
	accountId?: string;
	planType?: string | null;
	primary?: CodexUsageWindow | null;
	secondary?: CodexUsageWindow | null;
	rateLimitReachedType?: string | null;
	resetCreditsAvailable?: number | null;
	tokenSummary?: CodexUsageTokenSummary;
	error?: string;
}

export interface ProviderAccountsState {
	accounts: ProviderAccountSummary[];
	chainOrder: string[];
	activeId: string | null;
	usage?: CodexUsageSnapshot;
}

export type GoalActivityStatus = "queued" | "running" | "done" | "error" | "skipped" | "stale";

export interface GoalActivityItem {
	id: string;
	goalId: string;
	kind: "podcast";
	agent: string;
	action: string;
	status: GoalActivityStatus;
	runId?: string;
	idx?: number;
	detail?: string;
	/** Title the source report wrote for itself. Content the UI may show next to localized chrome,
	 * never an addressing identifier such as a cardId or an artifact path. */
	sourceTitle?: string;
	jsonlPath?: string;
	inputPath?: string;
	outputPath?: string;
	hasOutput?: boolean;
	hasMeta?: boolean;
	startedAt?: number;
	updatedAt: number;
	finishedAt?: number;
}

export type AttachmentParseStatus = "parsed" | "pending" | "failed";

export interface AttachmentPayload {
	id: string;
	type: "image" | "document";
	fileName: string;
	mimeType: string;
	size: number;
	content: string;
	extractedText?: string;
	preview?: string;
	/** Set on every file picked from one folder; files sharing it are stored under one directory. */
	folderId?: string;
	/** Path inside the picked folder, including the folder name as its first segment. */
	relativePath?: string;
	/** Set by the Runtime before the turn on parseable documents; the chat shows it on the file chip. */
	parseStatus?: AttachmentParseStatus;
	parseError?: string;
}

export interface UserMessageWithAttachmentsPayload {
	role: "user-with-attachments";
	content: string;
	attachments: AttachmentPayload[];
	timestamp?: number;
}

export type PromptInput = string | UserMessageWithAttachmentsPayload;

export interface GoalTurnContext {
	discoveryCandidateId?: string;
	topicId?: string;
}

export type StopState = "idle" | "stopping";

export interface UsageSummary extends Usage {
	assistantMessageCount: number;
}

export interface GoalSummary {
	id: string;
	title: string;
	description: string;
	createdAt: string;
	updatedAt: string;
	preview: string;
	messageCount: number;
	isStreaming: boolean;
	lastActivityAt: string;
	fresh: boolean;
	pulseLine: string | null;
	avatar: GoalAvatar;
	discoveryEnabled: boolean;
	outputLanguage: OutputLanguage;
}

export type GoalListEvent =
	| { type: "snapshot"; goals: GoalSummary[] }
	| { type: "created"; goal: GoalSummary }
	| { type: "updated"; goal: GoalSummary }
	| { type: "deleted"; id: string };

export interface ResearchAgentOutput {
	stageId: string;
	attemptId: string;
	role: string;
	status: "running" | "succeeded" | "failed";
	kind: "status" | "text" | "tool";
	updatedAt: number;
	text?: string;
	toolName?: string;
}

export interface GoalSnapshot {
	goalId: string;
	title: string;
	description: string;
	messages: AgentMessage[];
	isStreaming: boolean;
	pendingToolCalls: string[];
	errorMessage?: string;
	statusMessage?: string;
	stopState: StopState;
	lastRunUsage?: UsageSummary;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	/** Account failovers and explicit model fallbacks the current or last turn needed, in order. */
	modelSwitches?: ModelSwitch[];
	// 当前 agent 活动的人话描述,runner 维护,P3 用
	pulseLine?: string;
}

export interface CreateGoalRequest {
	title?: string;
	description?: string;
	outputLanguage?: OutputLanguage;
}

export interface SendMessageRequest {
	content?: string;
	attachments?: AttachmentPayload[];
	context?: GoalTurnContext;
}

export interface SendMessageResult {
	queued: boolean;
	queuePosition: number;
}

export interface UpdateGoalConfigRequest {
	/** `null` restores inheritance of the capability default. */
	modelId?: string | null;
	thinkingLevel?: ThinkingLevel | null;
	title?: string;
	description?: string;
	discoveryEnabled?: boolean;
	outputLanguage?: OutputLanguage;
}

export interface GoalEventEnvelope {
	type: "snapshot" | "agent-event";
	state: GoalSnapshot;
	event?: unknown;
}

export interface ArtifactFeedItem {
	goalId: string;
	goalTitle: string;
	name: string;
	size: number;
	modifiedAt: string;
	title?: string;
	summary?: string;
}

export interface ArtifactFeedResponse {
	items: ArtifactFeedItem[];
}

export interface TodayRollup {
	date: string;
	liveGoals: number;
	productsToday: number;
}

export interface PodcastTranscriptSection {
	id: string;
	title: string;
	startSec: number;
	endSec: number;
}

export interface PodcastTranscriptBlock {
	id: string;
	sectionId: string;
	text: string;
	startSec: number;
	endSec: number;
}

export interface PodcastTranscriptResponse {
	version: 1;
	slug: string;
	title: string;
	language: string;
	durationSec: number;
	sections: PodcastTranscriptSection[];
	blocks: PodcastTranscriptBlock[];
}
