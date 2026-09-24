import { stripMarkdownForPill } from "../../shared/strip-markdown.js";
import { reportReference, type ReportReference } from "../research/reports/delivery.js";
import { projectAgentsDir } from "../workspaces/goal-runtime-paths.js";
import { createSha256 } from "../lib/hash.js";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "fs";
import { mkdir } from "fs/promises";
import { basename, dirname, join, relative } from "path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { refreshConnectionRuntime } from "../providers/custom-models.js";
import {
	AgentSession,
	convertToLlm,
	DefaultResourceLoader,
	loadSkillsFromDir,
	type LoadExtensionsResult,
	ModelRegistry,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolveAgentDir, resolveAgentPath } from "../config/agent-directory.js";
import { collectAttachments, sessionEntryAttachments } from "./session-attachments.js";

// ResourceExtensionPaths isn't re-exported from the package root; derive it
// from the interface itself so we don't reach into deep package internals.
type ResourceExtensionPaths = Parameters<ResourceLoader["extendResources"]>[0];
import { buildMainAgentPrompt } from "./system-prompts.js";
import type {
	AttachmentPayload,
	GoalEventEnvelope,
	GoalSnapshot,
	GoalTurnContext,
	PromptInput,
	ResearchAgentOutput,
	UsageSummary,
	UserMessageWithAttachmentsPayload,
} from "../../shared/types.js";
import {
	convertAttachmentMessageToLlm,
	isAttachmentPrompt,
	attachmentCaseDescriptors,
	persistAttachments,
	parseDocumentAttachmentsForTurn,
	type AttachmentCaseDescriptor,
	type IngestAttachmentDocument,
} from "./attachment-utils.js";
import type { FileIngestService } from "../ingestion/service.js";
import { createMainAgentSettingsManager } from "./context.js";
import * as log from "../lib/log.js";
import type { ExtraEnvGetter } from "./extra-env.js";
import { createMainAgentTools } from "./tools/index.js";
import {
	createAssistantReplyDetails,
	parseMainTerminalDetails,
	type MainTerminalDetails,
} from "./tools/terminal-action.js";
import {
	createMainAgentSandbox,
	createMainAgentSandboxProxyTools,
	snapshotMainAgentLogicalWorkspace,
} from "./main-agent-sandbox.js";
import {
	MainWorkspaceRuntime,
	type MainWorkspaceSession,
} from "./main-workspace-runtime.js";
import type { SrtAgentSandbox } from "../agent-runtime/srt-agent-sandbox.js";
import { streamWithAccountFallback } from "../accounts/stream-fallback.js";
import { lastAssistantModel, type ModelSwitch } from "../../shared/model-switch.js";
import { resolveLLMConfig } from "../agent-runtime/model-config/resolve.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import {
	inferTaskHistoryLabels,
	type TaskHistoryRecord,
	upsertUserTaskHistory,
	type TaskHistoryAttachment,
} from "../observability/task-history.js";
import { loadAgentPromptConfig } from "../agent-runtime/prompt-registry.js";
import { appendNodeExecutionRecord, type WorkspaceSnapshotRecord } from "../observability/run-records.js";
import { caseCapture, recordCaseCaptureFailure } from "../observability/case-capture.js";
import { emptyWorkspaceSnapshot, snapshotWorkspaceTree } from "../agent-runtime/workspace-snapshot.js";
import { registerPiUserMemory } from "pi-user-memory";
import { UserMemoryProjector } from "../goals/memory/user-memory-projector.js";
import type { PodcastGenerationDispatchHandler } from "./tools/generate-podcast.js";
import {
	GoalTopicPlanStore,
} from "../goals/topic-plan/index.js";
import { publish } from "../events/event-bus.js";
import { registerTopicReadinessGuard } from "./topic-readiness-guard.js";
import { MainWikiCitationSession, registerMainWikiCitationCompiler } from "./wiki-citations.js";
import { isInsideRoot } from "../lib/paths.js";
import { toErrorMessage } from "../lib/values.js";

const RESEARCH_TOOL_NAMES = new Set(["research", "generate_report"]);

type GoalEventListener = (event: GoalEventEnvelope) => void;

interface ResearchActivityEvent {
	nodeId: string;
	status: string;
	visit: number;
	attempt: number;
	timestamp: number;
	detail?: string;
	error?: string;
}

interface ResearchToolActivity {
	runId?: string;
	events: ResearchActivityEvent[];
	outputs: ResearchAgentOutput[];
}

/**
 * Wire format for `modelId` on the chat config endpoint and snapshots.
 * `<provider>/<modelId>` disambiguates models that exist under multiple
 * providers (a built-in Provider and a custom endpoint can expose the same id).
 */
function parseCompoundModelId(value: string): { provider: string; modelId: string } {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) throw new Error("modelId must use provider/model format");
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function compoundModelId(model: { provider: string; id: string } | undefined | null): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}

function linkProjectAgentsDir(goalDir: string): void {
	const source = projectAgentsDir(process.cwd());
	if (!existsSync(source)) return;
	const target = projectAgentsDir(goalDir);
	if (existsSync(target) || lstatExists(target)) return;
	mkdirSync(dirname(target), { recursive: true });
	try {
		symlinkSync(source, target, "dir");
	} catch (err) {
		log.logInfo(`[${goalDir}] failed to symlink project agents: ${(err as Error).message}`);
	}
}

function lstatExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The Pi session is the model context as it is; Telomi only adapts its own roles.
 * Mom-specific roles are handled here; everything else must go through the
 * standard convertToLlm so compactionSummary/branchSummary become user
 * messages. Dropping them sent an empty `input` to the provider on the
 * auto-retry right after compaction (Codex 400 missing_required_parameter).
 */
export function convertMainAgentMessagesToLlm(messages: any[]) {
	const prepared = messages
		.filter((message) => message.role !== "artifact")
		.map((message) =>
			message.role === "user-with-attachments"
				? convertAttachmentMessageToLlm(message as UserMessageWithAttachmentsPayload)
				: message,
		);
	return convertToLlm(prepared);
}

function visibleToolMessage(message: any): any | undefined {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const content = message.content.filter((block: any) =>
		block?.type === "toolCall");
	return content.length ? { ...message, content } : undefined;
}

function extractAssistantText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content.trim();
	if (Array.isArray(message.content)) {
		return message.content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n")
			.trim();
	}
	return "";
}

function isSilentCompletionText(text: string): boolean {
	return text.trim() === "[SILENT]" || text.trim().startsWith("[SILENT]");
}

function isEventUserMessage(message: any): boolean {
	if (!message || (message.role !== "user" && message.role !== "user-with-attachments")) return false;
	if (typeof message.content === "string") return isEventText(message.content);
	if (Array.isArray(message.content)) {
		const text = message.content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n")
			.trim();
		return isEventText(text);
	}
	return false;
}

function isEventText(value: string): boolean {
	const text = value.trim();
	return text.startsWith("[EVENT:") || text.startsWith("[EVENT] [EVENT:");
}

function extractMessageText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content.trim();
	if (Array.isArray(message.content)) {
		return message.content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n")
			.trim();
	}
	return "";
}

/**
 * Chat projection of the session. Assistant messages stream and stay in full: their thinking,
 * intermediate text and Tool calls are the turn's activity, the last text is its reply.
 * Goal lifecycle events and `[SILENT]` replies to them never appear in chat; while a turn
 * answering an event is live (`liveTurnStart`) only its Tool calls show, so a reply that ends
 * up `[SILENT]` never flashes through.
 */
export function getVisibleMessages(messages: any[], liveTurnStart?: number): any[] {
	const hiddenIndexes = new Set<number>();

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		if (!isSilentCompletionText(extractAssistantText(message))) continue;

		let startIndex = -1;
		for (let j = i - 1; j >= 0; j--) {
			if (isEventUserMessage(messages[j])) {
				startIndex = j;
				break;
			}
			if (messages[j]?.role === "user" || messages[j]?.role === "user-with-attachments") {
				break;
			}
		}

		if (startIndex === -1) {
			hiddenIndexes.add(i);
			continue;
		}

		for (let j = startIndex; j <= i; j++) {
			hiddenIndexes.add(j);
		}
	}

	const liveTurnAnswersEvent = liveTurnStart !== undefined && isEventUserMessage(
		messages.slice(liveTurnStart).find((message) => message?.role === "user" || message?.role === "user-with-attachments"),
	);

	return messages.flatMap((message, index) => {
		if (hiddenIndexes.has(index) || isEventUserMessage(message)) return [];
		if (liveTurnAnswersEvent && message?.role === "assistant" && index >= (liveTurnStart as number)) {
			return visibleToolMessage(message) ?? [];
		}
		return [message];
	});
}

function createEmptyUsageSummary(): UsageSummary {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		assistantMessageCount: 0,
	};
}

function createTerminalAssistantMessage(
	text: string,
	mainRoute?: Record<string, unknown>,
	citationMessageId?: string,
): any {
	return {
		role: "assistant",
		...(mainRoute ? { mainRoute } : {}),
		...(citationMessageId ? { citationMessageId } : {}),
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function terminalReportReference(terminal: MainTerminalDetails): ReportReference | undefined {
	return reportReference(terminal.trace.selectedRunId, terminal.stableFinalReportPath, terminal.reportTitle);
}

function lastAssistantMessage(messages: any[], fromIndex: number): any | undefined {
	for (let index = messages.length - 1; index >= fromIndex; index -= 1) {
		if (messages[index]?.role === "assistant" && extractAssistantText(messages[index])) return messages[index];
	}
	return undefined;
}

function countAssistantTools(messages: any[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const message of messages) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
			counts[part.name] = (counts[part.name] ?? 0) + 1;
		}
	}
	return counts;
}

function summarizeAssistantUsage(messages: any[]): UsageSummary | undefined {
	const summary = createEmptyUsageSummary();

	for (const message of messages) {
		if (message?.role !== "assistant" || !message.usage) continue;
		const usage = message.usage as Usage;
		summary.input += usage.input;
		summary.output += usage.output;
		summary.cacheRead += usage.cacheRead;
		summary.cacheWrite += usage.cacheWrite;
		summary.totalTokens += usage.totalTokens;
		summary.cost.input += usage.cost.input;
		summary.cost.output += usage.cost.output;
		summary.cost.cacheRead += usage.cost.cacheRead;
		summary.cost.cacheWrite += usage.cost.cacheWrite;
		summary.cost.total += usage.cost.total;
		summary.assistantMessageCount += 1;
	}

	return summary.assistantMessageCount > 0 ? summary : undefined;
}

function getPreview(messages: any[]): string {
	const last = messages
		.slice()
		.reverse()
		.find((message) => message.role === "assistant" || message.role === "user" || message.role === "user-with-attachments");
	if (!last) return "";

	const text = typeof last.content === "string" ? last.content : Array.isArray(last.content)
		? last.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
		: "";
	const preview = Array.from(stripMarkdownForPill(text));
	return preview.slice(0, 120).join("") + (preview.length > 120 ? "…" : "");
}

/**
 * Wraps DefaultResourceLoader so telomi can:
 * - Delegate resource loading to the SDK while disabling automatically discovered
 *   extensions, prompts, and themes for this dispatcher session.
 * - Keep the system prompt fully dynamic. It reads GoalRunner
 *   state on every rebuild so setDescription() takes
 *   effect on the next prompt without a reload.
 * - Suppress AGENTS.md auto-injection. The base system prompt controls which
 *   goal/workspace files are read for each task, so we avoid duplicating those
 *   files in the system prompt header.
 *
 * DefaultResourceLoader's systemPromptOverride is reload-cached, which would
 * silently freeze the description into the prompt; bypassing it via dedicated
 * dynamic getters preserves the prior "always-fresh" behavior.
 */
class MainAgentResourceLoader implements ResourceLoader {
	constructor(
		private readonly inner: DefaultResourceLoader,
		private readonly dynamicSystemPrompt: () => string,
		private readonly capabilityRoot: () => string,
	) {}

	getExtensions(): LoadExtensionsResult {
		return this.inner.getExtensions();
	}
	getSkills() {
		return loadMainAgentSkillsForSandbox(this.capabilityRoot());
	}
	getPrompts() {
		return { prompts: [], diagnostics: [] };
	}
	getThemes() {
		return { themes: [], diagnostics: [] };
	}
	getAgentsFiles() {
		return { agentsFiles: [] };
	}
	getSystemPrompt(): string | undefined {
		return this.dynamicSystemPrompt();
	}
	getSystemPromptSource(): undefined {
		return undefined;
	}
	getAppendSystemPrompt(): string[] {
		return [];
	}
	getAppendSystemPromptSources(): [] {
		return [];
	}
	extendResources(paths: ResourceExtensionPaths): void {
		this.inner.extendResources(paths);
	}
	async reload(): Promise<void> {
		await this.inner.reload();
	}
}

export function loadMainAgentSkillsForSandbox(goalDir: string) {
	const root = join(goalDir, "skills", "main-agent");
	const loaded = loadSkillsFromDir({ dir: root, source: "goal-harness" });
	if (!existsSync(root)) return loaded;
	const realRoot = realpathSync(root);
	return {
		diagnostics: loaded.diagnostics,
		skills: loaded.skills.map((skill) => {
			const realFile = realpathSync(skill.filePath);
			const rel = relative(realRoot, realFile);
			if (!isInsideRoot(realRoot, realFile, { rejectDotPrefix: true, allowRoot: false }) || lstatSync(skill.filePath).isSymbolicLink()) {
				throw new Error(`Main Agent Skill escapes its Goal Harness root: ${skill.filePath}`);
			}
			return {
				...skill,
				filePath: `/capabilities/skills/${rel.split(/[/\\]+/u).join("/")}`,
				baseDir: "/capabilities/skills",
			};
		}),
	};
}

export class GoalRunner {
	private readonly listeners = new Set<GoalEventListener>();
	private agent!: Agent;
	private session!: AgentSession;
	private sessionManager!: SessionManager;
	private modelRegistry!: ModelRegistry;
	private modelRuntime!: ModelRuntime;
	private workspacePath!: string;
	private resourceLoader!: MainAgentResourceLoader;
	private running = false;
	private stopState: "idle" | "stopping" = "idle";
	private statusMessage?: string;
	private lastRunUsage?: UsageSummary;
	private description: string;
	// P3 pulseLine: human-readable description of what the agent is currently
	// doing, surfaced to the web UI's PulseBand component via GoalSnapshot.
	private pulseLine: string | null = null;
	private turnFallbackChain: ReadonlyArray<string> = [];
	private turnModelSwitches: ModelSwitch[] = [];
	private pulseLastEmittedAt = 0;
	private activeOriginalQuestion?: string;
	private activeTurnContext?: GoalTurnContext;
	private readonly partialToolResults = new Map<string, { toolName: string; result: any }>();
	private readonly researchToolActivity = new Map<string, ResearchToolActivity>();
	private mainWorkspaceRuntime!: MainWorkspaceRuntime;
	private activeMainWorkspaceSession?: MainWorkspaceSession;
	private activeMainSandbox?: SrtAgentSandbox;
	private activeTurnMessageStart?: number;
	/** Goal events that arrived while a turn was running; appended to the session when it ends. */
	private readonly pendingEvents: string[] = [];
	private lastTerminalDetails?: MainTerminalDetails;
	private lastNodeWorkspace?: WorkspaceSnapshotRecord;
	private userMemoryProjector?: UserMemoryProjector;
	private mainWikiCitations!: MainWikiCitationSession;
	constructor(
		private readonly workspaceDir: string,
		private readonly goalId: string,
		private title: string,
		private readonly goalDir: string,
		private readonly onSnapshot: (snapshot: GoalSnapshot) => void,
		description = "",
		// Lazily resolved on every bash spawn so restored goal-scoped environment
		// values take effect without restarting the runner. GoalService owns them.
		private readonly getExtraEnv?: ExtraEnvGetter,
		private readonly nodeBacktestOverride?: {
			systemPrompt?: string;
			userPrompt?: string;
		},
		private readonly getPodcastGenerationHandler?: () => PodcastGenerationDispatchHandler | undefined,
		private readonly getDiscoveryEnabled: () => boolean = () => true,
		private readonly getOutputLanguage: () => import("../../shared/languages.js").OutputLanguage = () => "auto",
		// Document attachments are parsed before the turn starts. Absent (Node Backtest,
		// prompt dumps) the hand-off says so in the notice instead of pretending to parse.
		private readonly fileIngestService?: FileIngestService,
	) {
		this.description = description;
	}

	private ingestAttachmentDocument(): IngestAttachmentDocument | undefined {
		const service = this.fileIngestService;
		if (!service) return undefined;
		return async ({ absPath, title }) => {
			const job = await service.enqueue(this.goalId, {
				inputPath: absPath,
				title,
				requestedBy: "main-agent-attachment",
			});
			// A cache hit is already terminal; otherwise wait out the single-parse budget.
			return service.waitForJob(this.goalId, job.id);
		};
	}

	/**
	 * Async two-step initialization: ResourceLoader.reload() must complete
	 * before AgentSession is constructed, because AgentSession's constructor
	 * calls getExtensions() to build its ExtensionRunner. If we constructed
	 * AgentSession first, bundled extension tools would be empty and unavailable.
	 * GoalService awaits init() before
	 * exposing the runner via getRunner(), so external callers never see a
	 * partially-initialized instance.
	 */
	async init(): Promise<void> {
		const modelRuntime = await ModelRuntime.create({
			authPath: resolveAgentPath("auth.json"),
			modelsPath: resolveAgentPath("models.json"),
		});
		this.modelRuntime = modelRuntime;
		await refreshConnectionRuntime(modelRuntime);
		this.mainWorkspaceRuntime = new MainWorkspaceRuntime(this.goalDir, this.goalId, this.workspaceDir);
		this.mainWikiCitations = new MainWikiCitationSession({
			goalDir: this.goalDir,
			goalId: this.goalId,
			workspaceDir: this.workspaceDir,
		});
		this.workspacePath = this.workspaceDir;
		const availableTools = [
			...createMainAgentTools(
			this.goalDir,
			() => collectAttachments(this.agent.state.messages as any[]),
			{
				goalId: this.goalId,
				workspaceDir: this.workspaceDir,
				title: this.title,
				description: this.description,
				getGoalTitle: () => this.title,
				getGoalDescription: () => this.description,
				getDiscoveryEnabled: this.getDiscoveryEnabled,
				getOutputLanguage: this.getOutputLanguage,
				getExtraEnv: this.getExtraEnv,
				getOriginalQuestion: () => this.activeOriginalQuestion,
				wikiTools: this.mainWikiCitations.tools,
				generatePodcast: async (request) => {
					const handler = this.getPodcastGenerationHandler?.();
					if (!handler) throw new Error("Podcast generation is not configured");
					return handler(request);
				},
			},
			),
			...createMainAgentSandboxProxyTools(() => this.activeMainSandbox),
		];
		const promptConfig = loadAgentPromptConfig("main", "router");
		const promptSandbox = promptConfig.sandbox;
		if (!promptSandbox || promptSandbox.role !== "main.router") {
			throw new Error("Main Agent Prompt config has an invalid sandbox role");
		}
		const availableToolNames = availableTools.map((tool) => tool.name);
		const unavailableTools = promptSandbox.tools.filter((name) => !availableToolNames.includes(name));
		if (unavailableTools.length > 0) {
			throw new Error(
				`Main Agent Prompt config declares unavailable tools: ${unavailableTools.join(",")}`,
			);
		}
		const tools = availableTools.filter((tool) => promptSandbox.tools.includes(tool.name));
		// Initial systemPrompt is a placeholder - AgentSession's constructor calls
		// _refreshToolRegistry → setActiveToolsByName → _rebuildSystemPrompt, which
		// pulls through buildSystemPrompt() via the ResourceLoader below and
		// overwrites agent.state.systemPrompt before the first prompt() runs.
		const initialSystemPrompt = this.nodeBacktestOverride?.systemPrompt ?? buildMainAgentPrompt(
			this.workspacePath,
			this.goalId,
			this.title,
			this.description,
			this.getOutputLanguage(),
		);
		// ModelRegistry merges built-in providers (from pi-ai) with custom providers
		// declared in the project's `.pi/agent/models.json`, so model
		// lookup + auth resolution Just Works for any provider the user configured.
		this.modelRegistry = new ModelRegistry(modelRuntime);

		this.agent = new Agent({
			initialState: {
				systemPrompt: initialSystemPrompt,
				// The owner (GoalService for chats, the replay recipe for a Node Backtest) applies the
				// user's selection through updateConfig() before the first turn; there is no built-in
				// model to fall back to, and a turn without one fails in run().
				model: undefined as unknown as Model<any>,
				thinkingLevel: "off",
				tools,
			},
			convertToLlm: convertMainAgentMessagesToLlm,
			// Mirror pi-coding-agent/sdk.js: resolve {apiKey, headers} per-request
			// via ModelRegistry so custom providers' apiKey/authHeader from
			// models.json flow through transparently.
			streamFn: (m, context, options) => streamWithAccountFallback({
				model: m,
				context,
				options,
				modelRegistry: this.modelRegistry,
				// The chain is read once per turn: a turn keeps the fallback choices it started with.
				providerFallbackModels: this.turnFallbackChain,
				onSwitch: (event) => this.turnModelSwitches.push(event),
			}),
		});

		const contextFile = join(this.goalDir, "context.jsonl");
		this.sessionManager = SessionManager.open(contextFile, this.goalDir, this.goalDir);
		const settingsManager = createMainAgentSettingsManager(this.workspaceDir);
		const memoryEnv = { ...process.env, ...this.getExtraEnv?.() };
		this.userMemoryProjector = new UserMemoryProjector(this.workspaceDir, this.goalId, {
			baseUrl: memoryEnv.HINDSIGHT_URL,
			bankId: memoryEnv.HINDSIGHT_BANK_ID,
		});
		void this.syncUserMemory();
		// Keep the user-facing Main Agent small. Specialized behavior is exposed
		// through Goal Harness skills and controlled Tools.
		const innerLoader = new DefaultResourceLoader({
			cwd: this.goalDir,
			agentDir: resolveAgentDir(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [
				(pi) => registerMainWikiCitationCompiler(pi, this.mainWikiCitations),
				(pi) => registerTopicReadinessGuard(
					pi,
					this.workspaceDir,
					this.goalId,
					() => this.activeTurnContext?.discoveryCandidateId,
					() => this.activeTurnContext?.topicId,
				),
				(pi) => registerPiUserMemory(pi, {
					baseUrl: memoryEnv.HINDSIGHT_URL,
					bankId: memoryEnv.HINDSIGHT_BANK_ID,
					goalId: this.goalId,
					retainTurns: false,
				}),
			],
		});
		// Wrap so the system prompt stays dynamic.
		// DefaultResourceLoader's *Override hooks are reload-cached, which would
		// freeze `this.description` into the prompt and break setDescription()
		// taking effect on the next prompt.
			this.resourceLoader = new MainAgentResourceLoader(
				innerLoader,
				() => this.nodeBacktestOverride?.systemPrompt ?? buildMainAgentPrompt(
						this.workspacePath,
						this.goalId,
						this.title,
						this.description,
						this.getOutputLanguage(),
					),
				() => this.activeMainWorkspaceSession?.sandboxDir ?? this.goalDir,
			);
		// Must complete before AgentSession construction - see method-level docstring.
		await this.resourceLoader.reload();

		this.session = new AgentSession({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager,
			cwd: "/work",
			modelRuntime,
			resourceLoader: this.resourceLoader,
			baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
		});

		// Model and thinking level are not restored from the session log. The owner of the
		// Runner applies the effective configuration through updateConfig() before the next
		// turn: GoalService resolves inheritance or the chat's explicit override, and a Node
		// Backtest applies the model its Case recorded. Restoring here would let an old
		// session record silently outrank a configuration the user has since changed.
		const loaded = this.sessionManager.buildSessionContext();
		if (loaded.messages.length > 0) {
			this.agent.state.messages = loaded.messages;
		}

		this.session.subscribe(async (event) => {
			if (event?.type === "message_start" && event.message?.role === "user") {
				const originalQuestion = extractMessageText(event.message).trim();
				if (originalQuestion) {
					this.activeOriginalQuestion = originalQuestion;
				}
			}
			this.updatePartialToolResultFromEvent(event);
			this.updatePulseLineFromEvent(event);
			const snapshot = this.getSnapshot();
			this.onSnapshot(snapshot);
			this.emit({ type: "agent-event", event, state: snapshot });
		});
	}

	// Update the pulseLine cache based on the agent event stream. Called from
	// session.subscribe so we observe the canonical pi-agent-core lifecycle:
	//   - agent_start             → "正在思考……"
	//   - tool_execution_start    → "正在执行 ${toolName}"
	//   - agent_end               → null (cleared)
	//   - compaction_start        → "正在自动压缩上下文……" (auto) / "正在压缩上下文……" (manual)
	//   - compaction_end          → restore "正在思考……" if still streaming, else null
	// Throttled: if the new pulseLine matches the previous one and we emitted
	// within the last 500ms, skip the update so rapid same-tool bursts don't
	// spam the SSE channel. Distinct transitions always pass through.
	private updatePulseLineFromEvent(event: any): void {
		if (!event || typeof event.type !== "string") return;
		let next: string | null = this.pulseLine;
		switch (event.type) {
			case "agent_start": {
				next = "正在思考……";
				break;
			}
			case "agent_end": {
				next = null;
				break;
			}
			case "compaction_start": {
				// Auto-compaction (context overflow) fires with a non-"manual" reason;
				// surface it so the goal's live status shows what's happening instead of
				// looking stalled while the summary model call runs.
				next = event?.reason === "manual" ? "正在压缩上下文……" : "正在自动压缩上下文……";
				break;
			}
			case "compaction_end": {
				// Auto-compaction happens mid-turn; the agent keeps working afterwards,
				// so restore the thinking indicator rather than blanking it.
				next = this.agent.state.isStreaming ? "正在思考……" : null;
				break;
			}
			case "tool_execution_start": {
				const toolName = typeof event.toolName === "string" ? event.toolName : "";
				if (toolName) {
					next = `正在执行 ${toolName}`;
				}
				break;
			}
			case "tool_execution_update": {
				if (!RESEARCH_TOOL_NAMES.has(event.toolName)) return;
				const text = Array.isArray(event.partialResult?.content)
					? event.partialResult.content
							.filter((item: any) => item?.type === "text" && typeof item.text === "string")
							.map((item: any) => item.text.trim())
							.filter(Boolean)
							.join(" ")
					: "";
				if (text) next = text.slice(0, 240);
				break;
			}
			case "tool_execution_end": {
				next = this.agent.state.isStreaming ? "正在思考……" : null;
				break;
			}
			default:
				return;
		}

		const now = Date.now();
		const same = next === this.pulseLine;
		if (same && now - this.pulseLastEmittedAt < 500) {
			return;
		}
		this.pulseLine = next;
		this.pulseLastEmittedAt = now;
	}

	private updatePartialToolResultFromEvent(event: any): void {
		if (!event || typeof event.type !== "string") return;
		if (event.type === "tool_execution_update" && typeof event.toolCallId === "string" && event.partialResult) {
			let result = event.partialResult;
			if (RESEARCH_TOOL_NAMES.has(event.toolName)) {
				const details = result.details && typeof result.details === "object"
					? result.details as Record<string, unknown>
					: {};
				const activity = this.researchToolActivity.get(event.toolCallId) ?? { events: [], outputs: [] };
				let activityChanged = false;
				if (typeof details.runId === "string") activity.runId = details.runId;
				const node = details.node && typeof details.node === "object"
					? details.node as Record<string, unknown>
					: undefined;
				if (node && typeof node.nodeId === "string" && typeof node.status === "string") {
					activity.events.push({
						nodeId: node.nodeId,
						status: node.status,
						visit: typeof node.visit === "number" ? node.visit : 1,
						attempt: typeof node.attempt === "number" ? node.attempt : 1,
						timestamp: Date.now(),
						...(typeof node.detail === "string" ? { detail: node.detail } : {}),
						...(typeof node.error === "string" ? { error: node.error } : {}),
					});
					activityChanged = true;
				}
				const agentOutput = details.agentOutput && typeof details.agentOutput === "object"
					? details.agentOutput as Record<string, unknown>
					: undefined;
				if (
					agentOutput
					&& typeof agentOutput.stageId === "string"
					&& typeof agentOutput.attemptId === "string"
					&& typeof agentOutput.role === "string"
					&& (agentOutput.status === "running" || agentOutput.status === "succeeded" || agentOutput.status === "failed")
					&& (agentOutput.kind === "status" || agentOutput.kind === "text" || agentOutput.kind === "tool")
					&& typeof agentOutput.updatedAt === "number"
				) {
					const next: ResearchAgentOutput = {
						stageId: agentOutput.stageId,
						attemptId: agentOutput.attemptId,
						role: agentOutput.role,
						status: agentOutput.status,
						kind: agentOutput.kind,
						updatedAt: agentOutput.updatedAt,
						...(typeof agentOutput.text === "string" ? { text: agentOutput.text } : {}),
						...(typeof agentOutput.toolName === "string" ? { toolName: agentOutput.toolName } : {}),
					};
					const existing = activity.outputs.findIndex((item) =>
						item.stageId === next.stageId && item.attemptId === next.attemptId);
					if (existing >= 0) activity.outputs[existing] = next;
					else activity.outputs.push(next);
					activityChanged = true;
				}
				if (activityChanged) {
					this.researchToolActivity.set(event.toolCallId, activity);
					result = {
						...result,
						details: {
							...details,
							researchActivity: activity.events,
							agentOutputs: activity.outputs,
						},
					};
				}
			}
			this.partialToolResults.set(event.toolCallId, {
				toolName: typeof event.toolName === "string" ? event.toolName : "tool",
				result,
			});
			return;
		}
		if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
			this.partialToolResults.delete(event.toolCallId);
			this.researchToolActivity.delete(event.toolCallId);
		}
		if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
			this.partialToolResults.delete(event.toolCallId);
			this.researchToolActivity.delete(event.toolCallId);
		}
		if (event.type === "agent_end") {
			this.partialToolResults.clear();
			this.researchToolActivity.clear();
		}
	}

	// Fires session_start for the AgentSession lifecycle.
	async bindExtensions(): Promise<void> {
		const unsupported = (name: string) => async () => {
			throw new Error(`${name} is not supported in Telomi goals`);
		};
		await this.session.bindExtensions({
			uiContext: this.createGoalUIContext(),
			commandContextActions: {
				waitForIdle: () => this.agent.waitForIdle(),
				newSession: unsupported("newSession"),
				fork: unsupported("fork"),
				navigateTree: unsupported("navigateTree"),
				switchSession: unsupported("switchSession"),
				reload: unsupported("reload"),
			},
			onError: (err) => {
				log.logWarning(
					`Extension error in ${this.goalId}`,
					`${err.extensionPath} @ ${err.event}: ${err.error}`,
				);
			},
		});
	}

	// Minimal uiContext for telomi: forwards `notify` to an assistant-style
	// goal message (so /cron-list etc produce output the web UI renders) and
	// routes setStatus to the goal snapshot. Interactive methods
	// (select/confirm/input/editor) are not supported.
	private createGoalUIContext(): any {
		// notify() from slash commands pushes an assistant message into agent state
		// so the web UI renders it; it is not persisted to the session.
		const emitNotification = (message: string) => {
			// usage must be present (with zeros) so that pi-coding-agent's
			// _checkCompaction -> calculateContextTokens doesn't crash on a
			// synthetic notify message when a later sendUserMessage runs.
			const assistantMessage: any = {
				role: "assistant",
				content: [{ type: "text", text: message }],
				timestamp: Date.now(),
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			(this.agent.state.messages as any[]).push(assistantMessage);
			try {
				this.sessionManager.appendMessage(assistantMessage);
			} catch (err) {
				log.logWarning(
					`notify appendMessage failed for ${this.goalId}`,
					toErrorMessage(err),
				);
			}
			const snapshot = this.getSnapshot();
			this.onSnapshot(snapshot);
			this.emit({ type: "snapshot", state: snapshot });
		};

		return {
			notify: (message: string) => emitNotification(message),
			// hermes TUI status-bar slot per extension (memory/skills/etc. each call
			// setStatus with their own `name`). Web UI has no status bar, and
			// folding all of them into one string clobbered the runner-managed
			// statusMessage ("Stopping..." / "Stopped"), so route extension setStatus
			// to a noop instead of overwriting lifecycle status.
			setStatus: () => undefined,
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			custom: async () => undefined,
			onTerminalInput: () => () => undefined,
			setWorkingMessage: () => undefined,
			setHiddenThinkingLabel: () => undefined,
			setWidget: () => undefined,
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: () => undefined,
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
			editor: async () => undefined,
			setEditorComponent: () => undefined,
			get theme() {
				const passthrough = (_name: string, text: string) => text;
				return {
					fg: passthrough,
					bg: passthrough,
					style: passthrough,
				};
			},
		};
	}

	getSnapshot(): GoalSnapshot {
		// Merge in the in-flight partial assistant message so the web UI can
		// render token-by-token streaming. pi-agent-core only pushes the message
		// onto state.messages at message_end, so without this the UI sees the new
		// turn appear in one go after streaming finishes.
		const baseMessages = this.agent.state.messages as any[];
		const streamingMessage = (this.agent.state as { streamingMessage?: any }).streamingMessage;
		const partialToolMessages = Array.from(this.partialToolResults, ([toolCallId, partial]) => ({
			role: "toolResult",
			toolCallId,
			toolName: partial.toolName,
			content: Array.isArray(partial.result?.content) ? partial.result.content : [],
			details: partial.result?.details,
			isError: false,
			timestamp: Date.now(),
		}));
		const sourceMessages = [
			...baseMessages,
			...(streamingMessage ? [streamingMessage] : []),
			...partialToolMessages,
		];
		return {
			goalId: this.goalId,
			title: this.title,
			description: this.description,
			messages: getVisibleMessages(sourceMessages, this.activeTurnMessageStart),
			isStreaming: this.agent.state.isStreaming || this.running,
			pendingToolCalls: Array.from(this.agent.state.pendingToolCalls ?? []),
			errorMessage: this.agent.state.errorMessage,
			statusMessage: this.statusMessage,
			stopState: this.stopState,
			lastRunUsage: this.lastRunUsage,
			modelId: compoundModelId(this.agent.state.model),
			thinkingLevel: this.agent.state.thinkingLevel,
			...(this.turnModelSwitches.length ? { modelSwitches: this.turnModelSwitches } : {}),
			pulseLine: this.pulseLine ?? undefined,
		};
	}

	getLastTerminalDetails(): MainTerminalDetails | undefined {
		return this.lastTerminalDetails ? {
			...this.lastTerminalDetails,
			trace: { ...this.lastTerminalDetails.trace },
		} : undefined;
	}

	getLastNodeWorkspaceSnapshot(): WorkspaceSnapshotRecord | undefined {
		return this.lastNodeWorkspace ? {
			...this.lastNodeWorkspace,
			exclude: [...this.lastNodeWorkspace.exclude],
			...(this.lastNodeWorkspace.warnings ? { warnings: [...this.lastNodeWorkspace.warnings] } : {}),
		} : undefined;
	}

	/**
	 * Attachment records of this Session: what the user actually named the files stored on disk.
	 * Read from the stored entries, not the model context, so Compaction cannot drop a name whose
	 * file is still on disk.
	 */
	listAttachments(): AttachmentPayload[] {
		return sessionEntryAttachments(this.sessionManager.getEntries());
	}

	getMainWorkspaceDirectories(): { workDirectory: string; artifactsDirectory: string } | undefined {
		const session = this.activeMainWorkspaceSession;
		return session ? { workDirectory: session.workDirectory, artifactsDirectory: join(session.sandboxDir, "artifacts") } : undefined;
	}

	getPreview(): string {
		return getPreview(getVisibleMessages(this.agent.state.messages as any[], this.activeTurnMessageStart));
	}

	async appendExternalAssistantMessage(
		text: string,
		mainRoute?: Record<string, unknown>,
	): Promise<void> {
		if (this.isRunning()) {
			throw new Error("Cannot append a resumed Research result during another Goal run");
		}
		const message = createTerminalAssistantMessage(text, mainRoute);
		(this.agent.state.messages as any[]).push(message);
		this.sessionManager.appendMessage(message);
		const snapshot = this.getSnapshot();
		this.onSnapshot(snapshot);
		this.emit({ type: "snapshot", state: snapshot });
	}

	isRunning(): boolean {
		return this.running || this.agent.state.isStreaming;
	}

	subscribe(listener: GoalEventListener): () => void {
		this.listeners.add(listener);
		try {
			listener({ type: "snapshot", state: this.getSnapshot() });
		} catch (error) {
			this.listeners.delete(listener);
			throw error;
		}
		return () => this.listeners.delete(listener);
	}

	start(input: PromptInput, profile?: "voice", context?: GoalTurnContext): void {
		if (this.isRunning()) {
			throw new Error("Goal is already running");
		}

		this.running = true;
		this.activeTurnContext = context;
		this.stopState = "idle";
		this.statusMessage = undefined;
		void this.run(input, profile)
			.catch((error) => {
				const message = toErrorMessage(error);
				log.logWarning(`[${this.goalId}] runner failed`, message);
				(this.agent.state as typeof this.agent.state & { errorMessage?: string }).errorMessage = message;
			})
			.finally(() => this.finishRun());
	}

	async steer(input: string): Promise<void> {
		const text = input.trim();
		if (!text) throw new Error("Steering input is required");
		if (!this.isRunning()) throw new Error("Goal is not running");
		const taskId = this.recordInbound(text);
		await this.session.prompt(text, {
			streamingBehavior: "steer",
			source: "interactive",
		});
		await this.syncUserMemory(taskId);
		void this.syncUserMemory();
	}

	private finishRun(): void {
		if (this.stopState === "stopping") {
			const lastAssistant = [...(this.agent.state.messages as any[])]
				.reverse()
				.find((message) => message?.role === "assistant");
			if (lastAssistant?.stopReason === "aborted") {
				this.statusMessage = "Stopped";
				// turn-adapter renders the in-stream "aborted" indicator from
				// the assistant message itself; clear the duplicate that
				// pi-agent-core mirrored onto state.errorMessage so DebugPanel
				// doesn't paint a second copy of the same AbortError text.
				(this.agent.state as { errorMessage?: string }).errorMessage = undefined;
			} else {
				this.statusMessage = undefined;
			}
			this.stopState = "idle";
		}

		this.running = false;
		// Defensive: agent_end normally clears pulseLine, but if the run threw
		// before agent_end fired we'd leak the last activity into the snapshot.
		this.pulseLine = null;
		this.pulseLastEmittedAt = Date.now();
		const snapshot = this.getSnapshot();
		this.onSnapshot(snapshot);
		this.emit({ type: "snapshot", state: snapshot });
	}

	abort(): void {
		if (!this.isRunning()) return;
		this.stopState = "stopping";
		this.statusMessage = "Stopping...";
		const snapshot = this.getSnapshot();
		this.onSnapshot(snapshot);
		this.emit({ type: "snapshot", state: snapshot });
		this.session.abort();
	}

	/**
	 * Re-read the connection catalog. A Runner keeps its registry for its whole life, so a
	 * connection the user activated afterwards would otherwise stay unresolvable until restart.
	 * Local only: this reloads models.json and rebuilds providers, it does not poll Providers.
	 *
	 * The resolved model is replaced as well, because an edit that keeps the same Provider and
	 * model id still changes where requests go; keeping the old object would send the next turn to
	 * the endpoint the user just replaced.
	 */
	async refreshModelCatalog(): Promise<void> {
		await refreshConnectionRuntime(this.modelRuntime);
		// A turn that started while the catalog was reloading keeps every selection it began with,
		// including the endpoint behind its model; it adopts the new one at its next turn.
		if (this.isRunning()) return;
		const current = this.agent.state.model;
		if (!current) return;
		const reresolved = this.modelRegistry.find(current.provider, current.id);
		if (reresolved) this.agent.state.model = reresolved;
	}

	updateConfig(config: { modelId?: string; thinkingLevel?: ThinkingLevel }): void {
		let changed = false;

		if (config.modelId) {
			const { provider, modelId } = parseCompoundModelId(config.modelId);
			const current = this.agent.state.model;
			const isSame = current && current.provider === provider && current.id === modelId;
			if (!isSame) {
				const nextModel = this.modelRegistry.find(provider, modelId);
				if (!nextModel) {
					throw new Error(`Unsupported model: ${config.modelId}`);
				}
				this.agent.state.model = nextModel;
				this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
				changed = true;
			}
		}

		if (config.thinkingLevel && config.thinkingLevel !== this.agent.state.thinkingLevel) {
			this.agent.state.thinkingLevel = config.thinkingLevel;
			this.sessionManager.appendThinkingLevelChange(config.thinkingLevel);
			changed = true;
		}

		if (changed) {
			this.statusMessage = undefined;
			const snapshot = this.getSnapshot();
			this.onSnapshot(snapshot);
			this.emit({ type: "snapshot", state: snapshot });
		}
	}

	setTitle(title: string): void {
		this.title = title;
		const snapshot = this.getSnapshot();
		this.emit({ type: "snapshot", state: snapshot });
	}

	// Hot-update the goal description. The next prompt rebuild (triggered by
	// setActiveToolsByName at the top of run()) will re-read `this.description`
	// via the ResourceLoader closure, so subsequent turns see the updated ## Goal
	// block without needing to restart the runner.
	setDescription(description: string): void {
		this.description = description;
		const snapshot = this.getSnapshot();
		this.emit({ type: "snapshot", state: snapshot });
	}

	dispose(): void {
		this.listeners.clear();
		// Fire session_shutdown so the session can release resources.
		// Best-effort - fire-and-forget to keep dispose() sync.
		const runner = this.session?.extensionRunner;
		if (runner) {
			Promise.resolve(runner.emit({ type: "session_shutdown", reason: "quit" })).catch((err: unknown) => {
				log.logWarning(
					`session_shutdown emit failed for ${this.goalId}`,
					toErrorMessage(err),
				);
			});
		}
		this.agent?.abort();
		this.session?.dispose();
	}

	private async syncUserMemory(sourceId?: string): Promise<void> {
		try {
			await this.userMemoryProjector?.sync(sourceId);
		} catch (error) {
			log.logWarning(
				`User memory projection failed for ${this.goalId}`,
				toErrorMessage(error),
			);
		}
	}

	projectUserMemory(): Promise<void> {
		return this.syncUserMemory();
	}

	private async run(input: PromptInput, profile?: "voice"): Promise<void> {
		this.turnFallbackChain = resolveLLMConfig({ envOverride: {} }).fallbackChain;
		this.turnModelSwitches = [];
		const phaseDebug = process.env.TELOMI_RUN_PHASE_DEBUG === "1";
		const phase = (name: string) => {
			if (phaseDebug) log.logInfo(`[${this.goalId}] run phase: ${name}`);
		};
		phase("start");
		this.lastTerminalDetails = undefined;
		this.lastNodeWorkspace = emptyWorkspaceSnapshot();
		await mkdir(this.goalDir, { recursive: true });
		for (const dir of ["attachments", "artifacts"]) {
			if (!existsSync(join(this.goalDir, dir))) mkdirSync(join(this.goalDir, dir), { recursive: true });
			}
			linkProjectAgentsDir(this.goalDir);
			await snapshotWorkspaceTree(this.lastNodeWorkspace, "input", this.goalDir);
			let messageCountBeforeRun = this.agent.state.messages.length;
			let workspaceSession: MainWorkspaceSession | undefined;
			let logicalWorkspacePath: string | undefined;
			let attachmentDescriptors: AttachmentCaseDescriptor[] | undefined;
			let published = false;
			let terminal: MainTerminalDetails | undefined;
			let routeTraceRecorded = false;
			let sessionRecorded = false;
			let mainAgentNodeRecorded = false;
			const contextPath = join(this.goalDir, "context.jsonl");
			const contextBefore = existsSync(contextPath) ? readFileSync(contextPath) : undefined;
			const originalThinkingLevel = this.agent.state.thinkingLevel;
			const voiceThinkingLevel =
				profile === "voice" &&
				this.session.getAvailableThinkingLevels().includes("low")
					? "low"
					: undefined;
			if (voiceThinkingLevel) {
				this.agent.state.thinkingLevel = voiceThinkingLevel;
			}
			try {
				(this.agent.state as typeof this.agent.state & { errorMessage?: string }).errorMessage = undefined;
				this.statusMessage = undefined;
				const activeModel = compoundModelId(this.agent.state.model);
				if (!activeModel) throw new Error("No model is configured for this Goal; choose a global default model in Settings");
				messageCountBeforeRun = this.agent.state.messages.length;
				this.activeTurnMessageStart = messageCountBeforeRun;
				const overriddenInput = this.nodeBacktestOverride?.userPrompt;
				if (overriddenInput && typeof input !== "string") {
					throw new Error("Main Agent Node Backtest does not support attachment input overrides");
				}
				const effectiveInput: PromptInput = overriddenInput ?? input;
				this.activeOriginalQuestion = (typeof effectiveInput === "string" ? effectiveInput : effectiveInput.content || "").trim() || "(attachment-only user message)";
				phase("log-inbound:start");
				const userTaskId = this.recordInbound(effectiveInput);
				phase("log-inbound:done");

				// Attachments land before the logical workspace snapshot, so the Case input tree carries
				// this turn's originals; the hand-off (parsing, notice) runs after it, so a Candidate
				// Replay regenerates that part with its own code instead of inheriting the observed one.
				let savedAttachmentPaths: string[] = [];
				if (isAttachmentPrompt(effectiveInput)) {
					phase("attachment-persist:start");
					savedAttachmentPaths = await persistAttachments(this.goalDir, effectiveInput.attachments);
					attachmentDescriptors = attachmentCaseDescriptors(effectiveInput.attachments);
					phase("attachment-persist:done");
				}

				phase("main-workspace:start");
				workspaceSession = this.mainWorkspaceRuntime.prepare({ conversationId: this.goalId });
				this.activeMainWorkspaceSession = workspaceSession;
				this.activeMainSandbox = createMainAgentSandbox(this.goalDir, workspaceSession);
				logicalWorkspacePath = join(workspaceSession.runDirectory, "node-evaluation", "main-agent-logical-workspace");
				snapshotMainAgentLogicalWorkspace(this.goalDir, workspaceSession, logicalWorkspacePath);
				this.mainWikiCitations.beginTurn();
				phase("main-workspace:ready");

				// Rebuild after preparing the isolated Main Workspace so Prompt,
				// Skills, Tools, and SRT mounts share one immutable snapshot.
				phase("rebuild-system-prompt:start");
				this.session.setActiveToolsByName(this.session.getActiveToolNames());
				phase("rebuild-system-prompt:done");

				let attachmentMessage: UserMessageWithAttachmentsPayload | undefined;
				if (isAttachmentPrompt(effectiveInput)) {
					phase("attachment-prompt:start");
					// The turn must not start before parsing reaches a terminal state or times out.
					await parseDocumentAttachmentsForTurn(
						effectiveInput.attachments,
						savedAttachmentPaths,
						this.ingestAttachmentDocument(),
					);
					attachmentMessage = {
						...effectiveInput,
						content: effectiveInput.content || "",
						timestamp: effectiveInput.timestamp ?? Date.now(),
					};
					this.sessionManager.appendMessage(attachmentMessage as any);
				}

				if (attachmentMessage) {
					phase("agent-prompt:start");
					await this.agent.prompt(attachmentMessage as any);
					phase("agent-prompt:done");
				} else {
					phase("session-prompt:start");
					await this.session.prompt(typeof effectiveInput === "string" ? effectiveInput : effectiveInput.content || "");
					phase("session-prompt:done");
				}
				await this.syncUserMemory(userTaskId);
				void this.syncUserMemory();

			terminal = this.terminalActionSince(messageCountBeforeRun);
			if (!terminal) {
				throw new Error("Main Agent completed without a terminal Tool result or assistant reply");
			}
			this.lastTerminalDetails = terminal;
			const mainSessionArtifact = this.mainWorkspaceRuntime.writeRunMessages(
				workspaceSession.id,
				(this.agent.state.messages as any[]).slice(messageCountBeforeRun),
			);
			sessionRecorded = true;
			await this.activeMainSandbox.close();
			this.activeMainSandbox = undefined;
			this.mainWorkspaceRuntime.writeRunRecord(workspaceSession.id, "route-trace.json", {
				schemaVersion: 1,
				goalId: this.goalId,
				conversationId: workspaceSession.conversationId,
				mainWorkspaceSessionId: workspaceSession.id,
				baseRevision: workspaceSession.baseRevision,
				capabilityRevision: workspaceSession.capabilityRevision,
				status: "selected",
				trace: terminal.trace,
				sessionRef: basename(mainSessionArtifact.path),
				createdAt: new Date().toISOString(),
			});
			routeTraceRecorded = true;
			const publication = await this.mainWorkspaceRuntime.publish(workspaceSession.id);
			published = true;
			this.activeMainWorkspaceSession = undefined;
			if (publication.status === "published" && publication.topicPlanDraft) {
				const document = publication.topicPlanDraft;
				const topicPlans = new GoalTopicPlanStore(this.goalId, this.workspaceDir);
				const synced = topicPlans.syncDocument({
					document,
					source: "main_agent",
					summary: topicPlans.readActive() ? "更新 Topic Plan" : "创建 Topic Plan",
					sourceDiscoveryIds: this.activeTurnContext?.discoveryCandidateId
						? [this.activeTurnContext.discoveryCandidateId]
						: undefined,
				});
				if (synced.changed) publish({
					type: "topic-plan:changed",
					goalId: this.goalId,
					proposalId: synced.proposal?.proposal_id ?? "topic-plan:no-change",
					status: "proposed",
					ts: new Date().toISOString(),
				});
			}
			this.mainWorkspaceRuntime.writeRunRecord(workspaceSession.id, "publication.json", {
				schemaVersion: 1,
				status: publication.status,
				...(publication.status === "published"
					? {
							baseRevision: publication.baseRevision,
							publishedRevision: publication.publishedRevision,
							changedFiles: publication.changedFiles,
						}
					: { baseRevision: publication.baseRevision, changedFiles: [] }),
				createdAt: new Date().toISOString(),
			});
			await snapshotWorkspaceTree(this.lastNodeWorkspace, "output", this.goalDir);
			const mainAgentFinishedAt = new Date().toISOString();
			appendNodeExecutionRecord(workspaceSession.runDirectory, "main", {
				node_id: "main-agent",
				node_type: "agent",
				agent: "main-agent",
				execution_id: workspaceSession.id,
				attempt: 1,
				status: "succeeded",
				group_id: null,
				depends_on: [],
				input: {
					goal_id: this.goalId,
					conversation_id: workspaceSession.conversationId,
					question: this.activeOriginalQuestion,
					base_revision: workspaceSession.baseRevision,
					capability_revision: workspaceSession.capabilityRevision,
				},
				output: {
					model: lastAssistantModel(this.agent.state.messages as ReadonlyArray<{ role?: string; provider?: string; model?: string }>, compoundModelId(this.agent.state.model) ?? ""),
					...(this.turnModelSwitches.length ? { model_switches: this.turnModelSwitches } : {}),
					terminal_action: terminal.action,
					reason_code: terminal.trace.reasonCode,
					route_ref: "route-trace.json",
					publication_ref: "publication.json",
					publication_status: publication.status,
					...(terminal.trace.selectedRunId ? { research_run_id: terminal.trace.selectedRunId } : {}),
				},
				time: {
					started_at: workspaceSession.createdAt,
					finished_at: mainAgentFinishedAt,
					duration_ms: Math.max(0, Date.parse(mainAgentFinishedAt) - Date.parse(workspaceSession.createdAt)),
				},
				trace_ref: basename(mainSessionArtifact.path),
				workspace: this.lastNodeWorkspace,
			});
			mainAgentNodeRecorded = true;

			const report = terminalReportReference(terminal);
			const mainRoute = {
				trace: terminal.trace,
				publication: {
					status: publication.status,
					changedFiles: publication.changedFiles,
					...(publication.status === "published"
						? {
								publishedRevision: publication.publishedRevision,
							}
						: {}),
				},
				...(report ? { report } : {}),
			};
			const modelReply = terminal.action === "assistant_reply"
				? lastAssistantMessage(this.agent.state.messages as any[], messageCountBeforeRun)
				: undefined;
			if (modelReply) {
				// The model's own final text is the reply; annotating it keeps the session free of a duplicate.
				modelReply.mainRoute = mainRoute;
			} else {
				// A terminal Tool answered through its result; the reply the user reads is composed here.
				const assistantMessage = createTerminalAssistantMessage(terminal.userResponse.trim(), mainRoute,
					typeof terminal.citationMessageId === "string" ? terminal.citationMessageId : undefined);
				(this.agent.state.messages as any[]).push(assistantMessage);
				this.sessionManager.appendMessage(assistantMessage);
			}

			const runMessages = (this.agent.state.messages as any[]).slice(messageCountBeforeRun);
			this.lastRunUsage = summarizeAssistantUsage(runMessages);
			try {
				caseCapture()?.mainAgent({
					runId: workspaceSession.id,
					runDirectory: workspaceSession.runDirectory,
					question: this.activeOriginalQuestion,
					systemPrompt: this.session.systemPrompt ?? this.agent.state.systemPrompt ?? "",
					actualModel: activeModel,
					thinkingLevel: this.agent.state.thinkingLevel,
					...(contextBefore ? { contextBefore } : {}),
					sessionPath: mainSessionArtifact.path,
					terminal,
					toolCounts: countAssistantTools(runMessages),
					...(this.lastRunUsage ? { usage: this.lastRunUsage } : {}),
					workspace: this.lastNodeWorkspace,
					logicalWorkspacePath: logicalWorkspacePath!,
					...(attachmentDescriptors ? { attachments: attachmentDescriptors } : {}),
				});
			} catch (error) {
				// fail-open：产品回复已经完成，Capture 失败只记录结构化警告和 Operations Status。
				recordCaseCaptureFailure("main-agent", error);
				log.logWarning(
					`Main Agent Node Evaluation capture failed for ${workspaceSession.id}`,
					toErrorMessage(error),
				);
			}
		} catch (error) {
			await snapshotWorkspaceTree(this.lastNodeWorkspace, "output", this.goalDir);
			if (workspaceSession) {
				if (!sessionRecorded) {
					this.mainWorkspaceRuntime.writeRunMessages(
						workspaceSession.id,
						(this.agent.state.messages as any[]).slice(messageCountBeforeRun),
					);
					sessionRecorded = true;
				}
				if (!mainAgentNodeRecorded) {
					const finishedAt = new Date().toISOString();
					try {
						appendNodeExecutionRecord(workspaceSession.runDirectory, "main", {
							node_id: "main-agent",
							node_type: "agent",
							agent: "main-agent",
							execution_id: workspaceSession.id,
							attempt: 1,
							status: "failed",
							group_id: null,
							depends_on: [],
							input: {
								goal_id: this.goalId,
								conversation_id: workspaceSession.conversationId,
								question: this.activeOriginalQuestion,
								base_revision: workspaceSession.baseRevision,
								capability_revision: workspaceSession.capabilityRevision,
							},
							output: {
								...(terminal ? { terminal_action: terminal.action, reason_code: terminal.trace.reasonCode } : {}),
								error: toErrorMessage(error),
							},
							time: {
								started_at: workspaceSession.createdAt,
								finished_at: finishedAt,
								duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(workspaceSession.createdAt)),
							},
							trace_ref: "main-agent.jsonl",
							workspace: this.lastNodeWorkspace,
						});
					} catch (traceError) {
						log.logWarning(
							`Main Agent trace failed for ${this.goalId}`,
							toErrorMessage(traceError),
						);
					}
				}
				this.mainWorkspaceRuntime.writeRunRecord(
					workspaceSession.id,
					routeTraceRecorded ? "failure.json" : "route-trace.json",
					{
						schemaVersion: 1,
						goalId: this.goalId,
						conversationId: workspaceSession.conversationId,
						mainWorkspaceSessionId: workspaceSession.id,
						baseRevision: workspaceSession.baseRevision,
						capabilityRevision: workspaceSession.capabilityRevision,
						status: "failed",
						...(terminal ? { trace: terminal.trace } : {}),
						sessionRef: "main-agent.jsonl",
						error: (toErrorMessage(error)).slice(0, 4_000),
						createdAt: new Date().toISOString(),
					},
				);
			}
			throw error;
		} finally {
			if (this.activeMainSandbox) {
				await this.activeMainSandbox.close().catch(() => undefined);
				this.activeMainSandbox = undefined;
			}
			if (workspaceSession && !published) {
				await this.mainWorkspaceRuntime.abort(workspaceSession.id).catch(() => undefined);
			}
			this.activeMainWorkspaceSession = undefined;
			this.activeTurnMessageStart = undefined;
			for (const text of this.pendingEvents.splice(0)) this.appendEventMessage(text);
			this.activeOriginalQuestion = undefined;
			this.activeTurnContext = undefined;
			if (
				voiceThinkingLevel &&
				this.agent.state.thinkingLevel === voiceThinkingLevel
			) {
				this.agent.state.thinkingLevel = originalThinkingLevel;
			}
		}
	}

	private terminalActionSince(messageIndex: number): MainTerminalDetails | undefined {
		const turnMessages = (this.agent.state.messages as any[]).slice(messageIndex);
		const terminals = turnMessages
			.filter((message) => message?.role === "toolResult" && message.isError !== true)
			.map((message) => parseMainTerminalDetails(message.details))
			.filter((value): value is MainTerminalDetails => value !== undefined);
		if (terminals.length > 1) {
			throw new Error("Main Agent failed closed: multiple terminal actions were executed in one turn");
		}
		if (terminals[0]) return terminals[0];
		for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
			const message = turnMessages[index];
			if (message?.role !== "assistant") continue;
			const text = extractAssistantText(message);
			if (text) return {
				...createAssistantReplyDetails(text),
				...(typeof message.citationMessageId === "string" ? { citationMessageId: message.citationMessageId } : {}),
			};
		}
		return undefined;
	}

	/**
	 * Records a Goal lifecycle event (`[EVENT:...]`) in the session so the next turn sees it.
	 * The event text is its identity: an event already in the session is not recorded twice.
	 * During a turn the event waits until the turn ends, so it never lands between a Tool
	 * call and its result. Returns whether this call recorded it.
	 */
	async recordEvent(text: string): Promise<boolean> {
		if (!isEventText(text)) throw new Error("recordEvent expects an [EVENT:...] message");
		const known = (this.agent.state.messages as any[]).some((message) =>
			(message?.role === "user") && extractMessageText(message) === text.trim());
		if (known || this.pendingEvents.includes(text)) return false;
		if (this.isRunning()) this.pendingEvents.push(text);
		else this.appendEventMessage(text);
		return true;
	}

	private appendEventMessage(text: string): void {
		const message = { role: "user", content: [{ type: "text", text: text.trim() }], timestamp: Date.now() };
		(this.agent.state.messages as any[]).push(message);
		this.sessionManager.appendMessage(message as any);
	}

	/** Registers a user turn in Task History; lifecycle events are not user tasks. */
	private recordInbound(input: PromptInput): string | undefined {
		const text = typeof input === "string" ? input : input.content || "";
		if (isEventText(text)) return undefined;
		const taskAttachments: TaskHistoryAttachment[] | undefined = isAttachmentPrompt(input)
			? input.attachments.map((att) => ({
					fileName: att.fileName,
					mimeType: att.mimeType,
					size: att.size,
					type: att.type,
				}))
			: undefined;
		const timestampMs = isAttachmentPrompt(input) && typeof input.timestamp === "number" ? input.timestamp : Date.now();
		return this.recordUserTaskHistory(text, taskAttachments, timestampMs);
	}

	private recordUserTaskHistory(
		text: string,
		attachments?: TaskHistoryAttachment[],
		timestampMs = Date.now(),
	): string | undefined {
		const originalQuestion = text.trim() || "(attachment-only user message)";
		const taskId = this.userMessageTaskId(originalQuestion, timestampMs);
		const createdAt = new Date(timestampMs).toISOString();
		const record: TaskHistoryRecord = {
			version: 1,
			type: "task_history",
			taskId,
			source: "user_message",
			goalId: this.goalId,
			createdAt,
			updatedAt: createdAt,
			originalQuestion,
			normalizedInput: this.normalizedTaskInput(originalQuestion, attachments),
			message: {
				conversationId: this.goalId,
				userMessageId: taskId,
				role: "user",
				...(attachments?.length ? { attachments } : {}),
			},
			workspace: {
				goalDir: this.goalDir,
			},
			labels: inferTaskHistoryLabels(originalQuestion),
		};
		try {
			upsertUserTaskHistory(serverRuntimeDirForGoal(this.goalId, this.workspaceDir), record);
			return taskId;
		} catch (err) {
			log.logWarning(
				`Failed to record task history for ${this.goalId}`,
				toErrorMessage(err),
			);
			return undefined;
		}
	}

	private userMessageTaskId(text: string, timestampMs: number): string {
		const hash = createSha256()
			.update(this.goalId)
			.update("\0")
			.update(String(timestampMs))
			.update("\0")
			.update(text)
			.digest("hex")
			.slice(0, 12);
		return `user_${timestampMs.toString(36)}_${hash}`;
	}

	private normalizedTaskInput(text: string, attachments?: TaskHistoryAttachment[]): string {
		if (!attachments?.length) return text;
		return [
			text,
			"",
			"Attachments:",
			...attachments.map((attachment) => `- ${attachment.fileName} (${attachment.mimeType})`),
		].join("\n");
	}

	private emit(payload: GoalEventEnvelope): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(payload);
			} catch (error) {
				log.logWarning(
					`Goal event listener failed for ${this.goalId}`,
					toErrorMessage(error),
				);
			}
		}
	}
}
