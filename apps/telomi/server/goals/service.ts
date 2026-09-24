import { reportReference } from "../research/reports/delivery.js";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { rename, rm } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type {
	AttachmentPayload,
	GoalSnapshot,
	GoalSummary,
	GoalTurnContext,
	PromptInput,
	SendMessageResult,
} from "../../shared/types.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { goalCredentialsDir } from "../workspaces/goal-runtime-paths.js";
import { runtimeControlRoot, serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import * as log from "../lib/log.js";
import type { GoalExecution, GoalSession, GoalScheduledResearchRequest } from "./execution.js";
import { ensureGoalWorkspace } from "../workspaces/goal-project.js";
import { readSessionAttachments } from "../main-agent/session-attachments.js";
import {
	isThinkingLevel,
	resolveMainAgentModel,
	type EffectiveModelSelection,
} from "../agent-runtime/model-config/resolve.js";
import { publish } from "../events/event-bus.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { runRecordsDir } from "../observability/run-records.js";
import { resumeRunOutputLanguage } from "../research/execute-run.js";
import { canResumeRunState, hasActiveResearchRun, RunStateStore } from "../research/run-state.js";
import { hasActiveWikiUpdate, markInterruptedWikiUpdates } from "../wiki/update-runner.js";
import { connectionCatalogRevision } from "../providers/custom-models.js";
import { modelFailure, recordModelVerdict } from "../agent-runtime/model-config/model-verdicts.js";
import { GoalTopicPlanStore } from "./topic-plan/index.js";
import { deleteGoalUserMemory } from "./memory/user-memory-projector.js";
import { isGoalAvatar, nextGoalAvatar, type GoalAvatar } from "../../shared/avatar.js";
import { isOutputLanguage, resolveOutputLanguage, type OutputLanguage } from "../../shared/languages.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { toErrorMessage } from "../lib/values.js";

interface GoalRecord {
	id: string;
	title: string;
	description: string;
	createdAt: string;
	updatedAt: string;
	preview: string;
	messageCount: number;
	avatar: GoalAvatar;
	discoveryEnabled: boolean;
	outputLanguage: OutputLanguage;
	/**
	 * Explicit per-Goal model override. `null` or an absent field inherits the global default.
	 */
	modelOverride?: string | null;
	thinkingLevelOverride?: ThinkingLevel | null;
}

/** The automatic Topic Plan turn a Goal is preparing, or how it failed. */
export interface TopicPlanGeneration {
	startedAt: string;
	failedAt?: string;
	/** The Provider's rejection or the Runtime's reason the turn did not produce a draft. */
	error?: string;
}

/** Said wherever a turn cannot start because the user has not chosen a global default model. */
export const NO_DEFAULT_MODEL_ERROR = "No default model is configured; choose a global default model in Settings";

/**
 * How the last assistant turn ended, on the model that answered it. The message names its own
 * Provider and model, so a rejection recorded from an older session log stays with the model it
 * happened on rather than with whatever is selected now.
 */
function lastAssistantOutcome(messages: GoalSnapshot["messages"]): { model?: string; rejection?: string } | undefined {
	const last = [...messages].reverse().find((message) => message.role === "assistant") as
		{ provider?: string; model?: string; stopReason?: string; errorMessage?: string } | undefined;
	if (!last) return undefined;
	return {
		...(last.provider && last.model ? { model: `${last.provider}/${last.model}` } : {}),
		...(last.stopReason === "error" && last.errorMessage?.trim() ? { rejection: last.errorMessage.trim() } : {}),
	};
}

/** Just the configuration part of a Goal record, for comparing one decision with another. */
function overrideOf(record: GoalRecord): Pick<GoalRecord, "modelOverride" | "thinkingLevelOverride"> {
	return {
		...(record.modelOverride !== undefined ? { modelOverride: record.modelOverride } : {}),
		...(record.thinkingLevelOverride !== undefined ? { thinkingLevelOverride: record.thinkingLevelOverride } : {}),
	};
}

/** One Goal's model configuration as the unified settings entry point shows it. */
export interface GoalModelConfiguration {
	goalId: string;
	title: string;
	/** `provider/model`; `null` when no global default is configured and the Goal has no override. */
	effectiveModel: string | null;
	thinkingLevel: ThinkingLevel;
	source: EffectiveModelSelection["source"];
	/** The thinking level is overridden even when the model inherits the default. */
	thinkingLevelOverridden: boolean;
	/** The Goal chose its own model or thinking level instead of following the default. */
	overridden: boolean;
	/** The Goal is mid-turn on a different selection and adopts this one at its next turn. */
	pendingNextTurn: boolean;
}

/** What the unified settings entry point reports for the Main Agent consumer. */
export interface MainAgentConfiguration {
	inheritedModel: string | null;
	inheritedSource: EffectiveModelSelection["source"];
	inheritedThinkingLevel: ThinkingLevel;
	/** The Provider's last rejection of the inherited model, until a turn on it succeeds. */
	inheritedFailure: string | null;
	/** Goals that carry an explicit override. */
	overrides: GoalModelConfiguration[];
	/** Goals that are mid-turn and therefore adopt the change on their next turn. */
	pendingGoalIds: string[];
}

/** An avatar no other listed Goal wears; `after` walks on from a Goal's current one. */
function assignAvatar(records: readonly Pick<GoalRecord, "id" | "avatar">[], goalId: string, after?: GoalAvatar): GoalAvatar {
	return nextGoalAvatar(records.filter((record) => record.id !== goalId).map((record) => record.avatar), after);
}

export interface GoalScheduledResearchResult {
	runId: string;
	status: "published" | "skipped";
	skipReason?: "no_source_increment" | "no_qualifying_evidence";
	stableFinalReportPath?: string;
}

export interface GoalLifecycleFs {
	rename: typeof rename;
	remove: typeof rm;
}

interface PendingInput {
	input: PromptInput;
	profile?: "voice";
	context?: GoalTurnContext;
}

const defaultGoalLifecycleFs: GoalLifecycleFs = {
	rename,
	remove: rm,
};

export class GoalService {
	private readonly goalsFile: string;
	private readonly pendingUserMemoryDeletionsFile: string;
	private readonly runners = new Map<string, GoalSession>();
	private readonly initializingRunners = new Map<string, Promise<GoalSession>>();
	private readonly pendingInputs = new Map<string, PendingInput[]>();
	private readonly resumingWikiUpdates = new Set<string>();
	private readonly deletingGoals = new Set<string>();
	private readonly lastStreamingState = new Map<string, boolean>();
	private readonly topicPlanGenerations = new Map<string, TopicPlanGeneration>();
	private userMemoryDeletionFlush: Promise<void> = Promise.resolve();
	// Per-goal env vars restored from persisted credential files and injected
	// into the bash executor on every spawn.
	private readonly goalEnv = new Map<string, Map<string, string>>();
	/** The connection catalog each loaded Runner has already adopted. */
	private readonly appliedCatalogRevision = new Map<string, string>();
	/** One catalog reload at a time per Goal, so two boundaries cannot prepare the same Runner. */
	private readonly preparingRunners = new Map<string, Promise<void>>();
	private onRunnerCreated?: (goalId: string, runner: GoalSession) => void;
	private beforeRunnerCreate?: (goalId: string) => Promise<void> | void;

	constructor(
		private readonly workspaceDir: string,
		private readonly execution: GoalExecution,
		private readonly lifecycleFs: GoalLifecycleFs = defaultGoalLifecycleFs,
	) {
		this.goalsFile = join(this.workspaceDir, "goals.json");
		this.pendingUserMemoryDeletionsFile = join(runtimeControlRoot(this.workspaceDir), "user-memory-deletions.json");
		this.ensureWorkspace();
		this.migrateLegacyAvatars();
		this.reapGoalDeletionTombstones();
		for (const goal of this.readGoals()) {
			recoverInterruptedResearchRuns(this.workspaceDir, goal.id);
			recoverInterruptedWikiUpdates(this.workspaceDir, goal.id);
			recoverInterruptedTopicActivities(this.workspaceDir, goal.id);
		}
		void this.flushPendingUserMemoryDeletions();
	}

	/**
	 * 继续一个中断的 Wiki 更新。由用户在活动流里显式触发：Wiki 更新是后台维护，
	 * 重新跑一次要真实烧 token，该不该继续由用户决定，Runtime 不代劳。
	 */
	startWikiUpdateResume(goalId: string, runId: string): void {
		const goal = this.getGoal(goalId);
		if (!goal) throw new Error(`Unknown goal: ${goalId}`);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)) throw new Error("Invalid Research Run id");
		const key = `${goalId}:${runId}`;
		if (this.resumingWikiUpdates.has(key)) throw new Error("Wiki update is already running");
		this.loadCredentialsFromDisk(goalId);
		this.resumingWikiUpdates.add(key);
		publish({ type: "research-run:changed", goalId, runId, status: "resuming", ts: new Date().toISOString() });
		void (async () => {
			try {
				const execution = await this.execution.resumeWikiUpdate({
					workspaceDir: this.workspaceDir,
					goalId,
					goalDir: join(this.workspaceDir, goalId),
					runId,
					env: this.getGoalEnvSnapshot(goalId),
				});
				log.logInfo(`[${goalId}] resumed Wiki update '${runId}' (${execution.pageCount} pages)`);
			} catch (error) {
				log.logWarning(
					`[${goalId}] failed to resume Wiki update '${runId}'`,
					toErrorMessage(error),
				);
			} finally {
				this.resumingWikiUpdates.delete(key);
				publish({ type: "research-run:changed", goalId, runId, status: "settled", ts: new Date().toISOString() });
			}
		})();
	}

	setRunnerCreatedHook(hook: (goalId: string, runner: GoalSession) => void): void {
		this.onRunnerCreated = hook;
	}

	setBeforeRunnerCreateHook(hook: (goalId: string) => Promise<void> | void): void {
		this.beforeRunnerCreate = hook;
	}

	isGoalActive(goalId: string): boolean {
		return this.deletingGoals.has(goalId)
			|| this.initializingRunners.has(goalId)
			|| hasActiveResearchRun(runRecordsDir(this.workspaceDir, goalId))
			|| hasActiveWikiUpdate(this.workspaceDir, goalId)
			|| Boolean(this.runners.get(goalId)?.isRunning());
	}

	getTopicPlanGeneration(goalId: string): TopicPlanGeneration | undefined {
		return this.topicPlanGenerations.get(goalId);
	}

	startResearchRunResume(goalId: string, runId: string): void {
		const goal = this.getGoal(goalId);
		if (!goal) throw new Error(`Unknown goal: ${goalId}`);
		if (this.isGoalActive(goalId)) throw new Error("Goal already has an active Run");
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)) throw new Error("Invalid Research Run id");
		const runDir = join(runRecordsDir(this.workspaceDir, goalId), runId);
		const state = new RunStateStore(runDir).load();
		if (!state || state.goal_id !== goalId || state.run_id !== runId) throw new Error("Unknown Research Run");
		if (!canResumeRunState(state)) throw new Error("Research Run has no resumable checkpoint");
		if (!existsSync(join(runDir, "resume-request.json"))) {
			throw new Error("Research Run has no resume request");
		}

		this.loadCredentialsFromDisk(goalId);
		const chinese = (resumeRunOutputLanguage(runDir) ?? resolveOutputLanguage(goal.outputLanguage, state.question)) === "zh-CN";
		const notify = async (text: string) => {
			try {
				await this.appendExternalAssistantMessage(goalId, text, {
					executionKind: "research_runtime", runId, resumed: true,
				});
			} catch (error) {
				log.logWarning(`[${goalId}] failed to deliver Research resume notice '${runId}'`, toErrorMessage(error));
			}
		};
		void (async () => {
			try {
				// Claim synchronously and observe rejection before waiting for chat delivery.
				const execution = (async () => this.execution.resumeResearchRun({
					workspaceDir: this.workspaceDir,
					goal,
					getExtraEnv: () => this.getGoalEnvSnapshot(goalId),
					runId,
				}))().then((result) => ({ result }), (error: unknown) => ({ error }));
				publish({ type: "research-run:changed", goalId, runId, status: "resuming", ts: new Date().toISOString() });
				await notify(chinese
					? "正在继续运行研究，可在 Activity 中查看当前状态。"
					: "Research is resuming. You can follow its current status in Activity.");
				const outcome = await execution;
				if ("error" in outcome) {
					try { new RunStateStore(runDir).recoverInterrupted(); } catch { /* preserve the execution error */ }
					log.logWarning(`[${goalId}] failed to resume Research Run '${runId}'`, toErrorMessage(outcome.error));
					await notify(chinese
						? "本次继续运行未完成。请在 Activity 中查看原因和可用操作。"
						: "The resumed research did not complete. Check Activity for the reason and available actions.");
					return;
				}
				const { result } = outcome;
				// The receipt is the Main Agent's memory of the report; the user reads the same reply a terminal Tool composes.
				await this.recordGoalEvent(goalId, `[EVENT:research_run_resumed] ${result.receiptText}`);
				const report = reportReference(runId, result.stableFinalReportPath, result.reportTitle);
				await this.appendExternalAssistantMessage(goalId, result.userResponse, {
					executionKind: "research_runtime",
					runId,
					resumed: true,
					...(report ? { report } : {}),
				});
			} catch (error) {
				log.logWarning(`[${goalId}] failed to deliver Research resume result '${runId}'`, toErrorMessage(error));
			} finally {
				void this.drainPendingInputs(goalId);
				publish({ type: "research-run:changed", goalId, runId, status: "settled", ts: new Date().toISOString() });
			}
		})();
	}

	async runScheduledResearch(args: GoalScheduledResearchRequest): Promise<GoalScheduledResearchResult> {
		const goal = this.getGoal(args.goalId);
		if (!goal) throw new Error(`Unknown goal: ${args.goalId}`);
		if (this.isGoalActive(args.goalId)) throw new Error("Goal already has an active Run");
		this.loadCredentialsFromDisk(args.goalId);
		let result;
		try {
			result = await this.execution.executeResearchRun({
				workspaceDir: this.workspaceDir,
				goal,
				getExtraEnv: () => this.getGoalEnvSnapshot(args.goalId),
				request: args,
			});
		} finally {
			void this.drainPendingInputs(args.goalId);
		}
		const runId = result.runId;
		if (!runId) throw new Error("Scheduled Research executor did not return a Run id");
		if (result.status === "skipped") {
			const skipReason = result.skipReason;
			if (skipReason !== "no_source_increment" && skipReason !== "no_qualifying_evidence") {
				throw new Error("Scheduled Research executor returned an invalid skip reason");
			}
			return { runId, status: "skipped", skipReason };
		}
		if (!result.stableFinalReportPath) throw new Error("Scheduled Research executor did not publish a report");
		return { runId, status: "published", stableFinalReportPath: result.stableFinalReportPath };
	}

	listGoals(): GoalSummary[] {
		return this.readGoals()
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.map((record) => this.buildSummary(record, record.messageCount));
	}

	rerollGoalAvatar(goalId: string): GoalSummary {
		const records = this.readGoals();
		const record = records.find((entry) => entry.id === goalId);
		if (!record) throw new Error(`Unknown goal: ${goalId}`);
		record.avatar = assignAvatar(records, record.id, record.avatar);
		this.writeGoals(records);
		return this.buildSummary(record, record.messageCount);
	}

	createGoal(params: { title?: string; description?: string; outputLanguage?: OutputLanguage } = {}): GoalSummary {
		const records = this.readGoals();
		const id = `goal_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const now = new Date().toISOString();
		const description = (params.description ?? "").trim();
		const record: GoalRecord = {
			id,
			title: params.title?.trim() || `Goal ${records.length + 1}`,
			description,
			createdAt: now,
			updatedAt: now,
			preview: "",
			messageCount: 0,
			avatar: assignAvatar(records, id),
			discoveryEnabled: true,
			outputLanguage: params.outputLanguage ?? "auto",
		};
		records.push(record);
		this.writeGoals(records);

		const goalDir = join(this.workspaceDir, id);
		ensureGoalWorkspace({
			goalDir,
			goalId: id,
			title: record.title,
			description,
			createdAt: now,
		});
		this.startTopicDiscussion({ goalId: id, title: record.title, description, reason: "created" });

		return {
			...record,
			messageCount: 0,
			isStreaming: false,
			lastActivityAt: record.createdAt,
			fresh: true,
			pulseLine: null,
		};
	}

	ensureImportedGoal(id: string, title: string): GoalSummary {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) throw new Error("Imported Goal id is invalid");
		const existing = this.getGoal(id);
		if (existing) return existing;
		const records = this.readGoals();
		const now = new Date().toISOString();
		const record: GoalRecord = {
			id,
			title: title.trim() || `Goal ${records.length + 1}`,
			description: "",
			createdAt: now,
			updatedAt: now,
			preview: "",
			messageCount: 0,
			avatar: assignAvatar(records, id),
			discoveryEnabled: true,
			outputLanguage: "auto",
		};
		records.push(record);
		this.writeGoals(records);
		ensureGoalWorkspace({ goalDir: join(this.workspaceDir, id), goalId: id, title: record.title, description: "", createdAt: now });
		return this.buildSummary(record, 0);
	}

	getGoal(id: string): GoalSummary | undefined {
		const record = this.readGoals().find((entry) => entry.id === id);
		if (!record) return undefined;
		return this.buildSummary(record, record.messageCount);
	}

	getMainWorkspaceDirectories(goalId: string): { workDirectory: string; artifactsDirectory: string } | undefined {
		return this.runners.get(goalId)?.getMainWorkspaceDirectories?.();
	}

	/**
	 * Attachment records for display-only naming. A loaded Session already holds them; otherwise they
	 * are read from the Goal's own Session log, so a cold Goal names its files without being started.
	 */
	listAttachments(goalId: string): AttachmentPayload[] {
		const runner = this.runners.get(goalId);
		return runner?.listAttachments?.() ?? readSessionAttachments(join(this.workspaceDir, goalId));
	}

	async getSnapshot(id: string): Promise<GoalSnapshot> {
		const goal = this.getGoal(id);
		if (!goal) throw new Error(`Unknown goal: ${id}`);
		const runner = await this.getRunner(goal);
		return runner.getSnapshot();
	}

	async appendExternalAssistantMessage(
		goalId: string,
		text: string,
		mainRoute?: Record<string, unknown>,
	): Promise<number> {
		const goal = this.getGoal(goalId);
		if (!goal) throw new Error(`Unknown goal: ${goalId}`);
		const runner = await this.getRunner(goal);
		await runner.appendExternalAssistantMessage(text, mainRoute);
		return runner.getSnapshot().messages.length;
	}

	async recordGoalEvent(goalId: string, text: string): Promise<boolean> {
		const goal = this.getGoal(goalId);
		if (!goal) throw new Error(`Unknown goal: ${goalId}`);
		return (await this.getRunner(goal)).recordEvent(text);
	}

	/**
	 * The configuration a Goal's next turn will use: its explicit override, otherwise the
	 * inherited global default. The Goal's own session log is never consulted, so restoring
	 * inheritance really does follow later default changes.
	 */
	getGoalModelConfiguration(goalId: string): GoalModelConfiguration {
		const record = this.readGoals().find((entry) => entry.id === goalId);
		if (!record) throw new Error(`Unknown goal: ${goalId}`);
		return this.describeGoalRecord(record);
	}

	private describeGoalRecord(record: GoalRecord): GoalModelConfiguration {
		const selection = resolveMainAgentModel({
			model: record.modelOverride,
			thinkingLevel: record.thinkingLevelOverride,
		});
		const runner = this.runners.get(record.id);
		const overridden = Boolean(record.modelOverride) || Boolean(record.thinkingLevelOverride);
		return {
			goalId: record.id,
			title: record.title,
			effectiveModel: selection.model,
			thinkingLevel: selection.thinkingLevel,
			source: selection.source,
			thinkingLevelOverridden: Boolean(record.thinkingLevelOverride),
			overridden,
			// Only a Goal whose executing turn differs from its effective configuration is still
			// waiting; one already running this configuration has adopted it.
			pendingNextTurn: (runner?.isRunning() ?? false)
				&& (runner?.getSnapshot().modelId !== selection.model
					|| runner?.getSnapshot().thinkingLevel !== selection.thinkingLevel),
		};
	}

	/** The Main Agent's effective configuration and per-Goal overrides for the settings entry. */
	describeMainAgentConfiguration(): MainAgentConfiguration {
		const inherited = resolveMainAgentModel();
		const configurations = this.readGoals().map((record) => this.describeGoalRecord(record));
		return {
			inheritedModel: inherited.model,
			inheritedSource: inherited.source,
			inheritedThinkingLevel: inherited.thinkingLevel,
			inheritedFailure: (inherited.model && modelFailure(inherited.model)) || null,
			overrides: configurations.filter((entry) => entry.overridden),
			pendingGoalIds: configurations.filter((entry) => entry.pendingNextTurn).map((entry) => entry.goalId),
		};
	}

	/** What the Runner should run for this Goal right now. */
	private effectiveRunnerConfig(goalId: string): { modelId: string; thinkingLevel: ThinkingLevel } {
		const configuration = this.getGoalModelConfiguration(goalId);
		if (!configuration.effectiveModel) throw new Error(NO_DEFAULT_MODEL_ERROR);
		return {
			modelId: configuration.effectiveModel,
			thinkingLevel: configuration.thinkingLevel,
		};
	}

	/**
	 * Apply the effective configuration at an execution boundary.
	 *
	 * Returns nothing in the ordinary case, so starting a turn stays synchronous with the caller
	 * that decided to start it. It returns a promise only when the Runner's catalog has to be
	 * reloaded first, which is the one case where the caller has to wait and re-check.
	 *
	 * The catalog is reloaded whenever a connection has been activated since this Runner last
	 * adopted one, not only when a model id has become unknown: an edit that keeps the ids and
	 * moves the endpoint would otherwise keep serving the connection the Runner resolved at start.
	 */
	private applyEffectiveConfig(goalId: string, runner: GoalSession): void | Promise<void> {
		const revision = connectionCatalogRevision();
		if (this.appliedCatalogRevision.get(goalId) === revision) {
			try {
				// A selection the Runtime cannot serve fails here, where the user sees it. Silently
				// continuing on the previous model would make the reported effective model a lie.
				runner.updateConfig(this.effectiveRunnerConfig(goalId));
				return;
			} catch (error) {
				// The catalog looks current yet cannot serve this selection; reload once and let a
				// genuinely unavailable model still fail the turn.
				return this.serializedReload(goalId, runner, revision, error);
			}
		}
		return this.serializedReload(goalId, runner, revision);
	}

	/** Queue this reload behind any reload already preparing the same Runner. */
	private serializedReload(
		goalId: string,
		runner: GoalSession,
		revision: string,
		previousError?: unknown,
	): Promise<void> {
		const previous = this.preparingRunners.get(goalId) ?? Promise.resolve();
		const prepared = previous
			.catch(() => undefined)
			.then(() => this.reloadAndApply(goalId, runner, revision, previousError));
		this.preparingRunners.set(goalId, prepared.catch(() => undefined));
		return prepared;
	}

	/**
	 * Reload the Runner's catalog and then apply, re-reading the selection because it may have
	 * changed while the reload was in flight. A turn that started during the reload is left exactly
	 * as it is: reconfiguring it would change a Run that is already executing.
	 */
	private async reloadAndApply(
		goalId: string,
		runner: GoalSession,
		revision: string,
		previousError?: unknown,
	): Promise<void> {
		try {
			await runner.refreshModelCatalog();
		} catch (error) {
			throw previousError ?? error;
		}
		if (runner.isRunning()) return;
		try {
			runner.updateConfig(this.effectiveRunnerConfig(goalId));
			this.appliedCatalogRevision.set(goalId, revision);
		} catch (error) {
			throw previousError ?? error;
		}
	}

	async getRunner(goal: GoalSummary): Promise<GoalSession> {
		if (this.deletingGoals.has(goal.id)) {
			throw new Error("Goal is currently running or being deleted");
		}
		const existing = this.runners.get(goal.id);
		if (existing) return existing;
		const pending = this.initializingRunners.get(goal.id);
		if (pending) return pending;
		const initialization = this.createRunner(goal);
		this.initializingRunners.set(goal.id, initialization);
		try {
			return await initialization;
		} finally {
			this.initializingRunners.delete(goal.id);
		}
	}

	private async createRunner(goal: GoalSummary): Promise<GoalSession> {
		const goalDir = join(this.workspaceDir, goal.id);

		if (this.beforeRunnerCreate) {
			await this.beforeRunnerCreate(goal.id);
		}
		ensureGoalWorkspace({
			goalDir,
			goalId: goal.id,
			title: goal.title,
			description: goal.description,
			createdAt: goal.createdAt,
		});
		repairStaleDanglingToolCalls(goalDir, goal.id);

		// Restore persisted credentials before the runner spins up so the first
		// bash call in this session sees the saved env vars. Re-reading is idempotent.
		this.loadCredentialsFromDisk(goal.id);
		const runner = await this.execution.createRunner({
			workspaceDir: this.workspaceDir,
			goal,
			goalDir,
			onSnapshot: (snapshot) => this.updateFromSnapshot(snapshot),
			getExtraEnv: () => this.getGoalEnvSnapshot(goal.id),
			getDiscoveryEnabled: () => {
				const current = this.getGoal(goal.id);
				if (!current) throw new Error(`Unknown goal: ${goal.id}`);
				return current.discoveryEnabled;
			},
			getOutputLanguage: () => this.getGoal(goal.id)?.outputLanguage ?? "auto",
		});
		this.runners.set(goal.id, runner);
		// The Runner just built its registry from the catalog on disk.
		this.appliedCatalogRevision.set(goal.id, connectionCatalogRevision());
		await this.applyEffectiveConfig(goal.id, runner);
		this.updateFromSnapshot(runner.getSnapshot());
		this.onRunnerCreated?.(goal.id, runner);
		return runner;
	}

	async startRun(
		goalId: string,
		input: PromptInput,
		profile?: "voice",
		context?: GoalTurnContext,
	): Promise<SendMessageResult> {
		const goal = this.getGoal(goalId);
		if (!goal) throw new Error(`Unknown goal: ${goalId}`);
		const runner = await this.getRunner(goal);
		const queueInput = (): SendMessageResult => {
			const queue = this.pendingInputs.get(goalId) ?? [];
			queue.push({ input, profile, context });
			this.pendingInputs.set(goalId, queue);
			log.logInfo(`[${goalId}] startRun queued (runner busy); pending=${queue.length}`);
			return { queued: true, queuePosition: queue.length };
		};
		if (
			runner.isRunning()
			|| hasActiveResearchRun(runRecordsDir(this.workspaceDir, goalId))
		) return queueInput();
		// Turn boundary: adopt configuration changes made since the previous turn. Only a catalog
		// reload waits, and then the Runner is re-checked before starting.
		const reload = this.applyEffectiveConfig(goalId, runner);
		if (reload) {
			await reload;
			if (runner.isRunning()) return queueInput();
		}
		this.startSessionRun(goalId, runner, input, profile, context);
		return { queued: false, queuePosition: 0 };
	}

	private startSessionRun(goalId: string, runner: GoalSession, input: PromptInput, profile?: "voice", context?: GoalTurnContext): void {
		if (typeof input === "string" && /^\[EVENT:GOAL_(CREATED|UPDATED)\]/u.test(input)) {
			this.topicPlanGenerations.set(goalId, { startedAt: new Date().toISOString() });
		}
		try {
			runner.start(input, profile, context);
			this.recordRunStreaming(goalId, true, runner.getSnapshot());
		} catch (error) {
			this.topicPlanGenerations.delete(goalId);
			throw error;
		}
	}

	async startInteractiveRun(
		goalId: string,
		input: string,
		profile?: "voice",
	): Promise<SendMessageResult> {
		const goal = this.getGoal(goalId);
		if (!goal) throw new Error(`Unknown goal: ${goalId}`);
		const runner = await this.getRunner(goal);
		if (runner.isRunning()) {
			await runner.steer(input);
			return { queued: false, queuePosition: 0 };
		}
		return this.startRun(goalId, input, profile);
	}

	private async drainPendingInputs(goalId: string): Promise<void> {
		const queue = this.pendingInputs.get(goalId);
		if (!queue || queue.length === 0) return;
		const runner = this.runners.get(goalId);
		if (!runner || runner.isRunning()) return;
		if (hasActiveResearchRun(runRecordsDir(this.workspaceDir, goalId))) return;
		const goal = this.getGoal(goalId);
		if (!goal) return;
		const next = queue.shift();
		if (queue.length === 0) this.pendingInputs.delete(goalId);
		if (!next) return;
		log.logInfo(`[${goalId}] startRun draining queued prompt; remaining=${queue.length}`);
		try {
			const reload = this.applyEffectiveConfig(goalId, runner);
			if (reload) {
				await reload;
				if (runner.isRunning()) {
					queue.unshift(next);
					this.pendingInputs.set(goalId, queue);
					return;
				}
			}
			this.startSessionRun(goalId, runner, next.input, next.profile, next.context);
		} catch (err) {
			log.logWarning(
				`[${goalId}] failed to drain queued prompt`,
				toErrorMessage(err),
			);
		}
	}

	async abort(goalId: string): Promise<void> {
		const goal = this.getGoal(goalId);
		if (!goal) throw new Error(`Unknown goal: ${goalId}`);
		const runner = await this.getRunner(goal);
		runner.abort();
	}

	/**
	 * Record the Goal's own selection. `null` restores inheritance, so the next turn follows
	 * the global default again; a model or thinking level becomes a deliberate override.
	 */
	async updateGoalConfig(
		goalId: string,
		config: { modelId?: string | null; thinkingLevel?: ThinkingLevel | null },
	): Promise<void> {
		const goal = this.getGoal(goalId);
		if (!goal) throw new Error(`Unknown goal: ${goalId}`);
		const records = this.readGoals();
		const record = records.find((entry) => entry.id === goalId);
		if (!record) throw new Error(`Unknown goal: ${goalId}`);
		const previous = overrideOf(record);
		if (config.modelId !== undefined) record.modelOverride = config.modelId || null;
		if (config.thinkingLevel !== undefined) record.thinkingLevelOverride = config.thinkingLevel || null;
		const attempted = overrideOf(record);
		this.writeGoals(records);
		// A loaded and idle Runner adopts the choice immediately; an executing turn keeps its own
		// selections and picks this up at its next turn, and an unloaded Goal needs no Runner.
		const runner = this.runners.get(goalId);
		if (!runner || runner.isRunning()) return;
		try {
			await this.applyEffectiveConfig(goalId, runner);
		} catch (error) {
			// A selection the Runtime cannot serve must not be left behind as the Goal's choice.
			// Applying can wait for a catalog reload, so restore only while this call's own choice
			// is still the stored one: a newer decision made meanwhile is the user's latest word.
			const current = this.readGoals();
			const stored = current.find((entry) => entry.id === goalId);
			if (stored && isDeepStrictEqual(overrideOf(stored), attempted)) {
				delete stored.modelOverride;
				delete stored.thinkingLevelOverride;
				Object.assign(stored, previous);
				this.writeGoals(current);
			}
			throw error;
		}
	}

	renameGoal(goalId: string, title: string): GoalSummary {
		const clean = title.trim().slice(0, 80);
		if (!clean) throw new Error("title cannot be empty");
		const records = this.readGoals();
		const record = records.find((entry) => entry.id === goalId);
		if (!record) throw new Error(`Unknown goal: ${goalId}`);
		record.title = clean;
		record.updatedAt = new Date().toISOString();
		this.writeGoals(records);
		this.runners.get(goalId)?.setTitle(clean);
		this.startTopicDiscussion({ goalId, title: clean, description: record.description, reason: "goal_updated" });
		return this.buildSummary(record, record.messageCount);
	}

	updateGoalDescription(goalId: string, description: string): GoalSummary {
		const clean = description.trim();
		const records = this.readGoals();
		const record = records.find((entry) => entry.id === goalId);
		if (!record) throw new Error(`Unknown goal: ${goalId}`);
		record.description = clean;
		record.updatedAt = new Date().toISOString();
		this.writeGoals(records);

		this.runners.get(goalId)?.setDescription(clean);
		this.startTopicDiscussion({ goalId, title: record.title, description: clean, reason: "goal_updated" });
		return this.buildSummary(record, record.messageCount);
	}

	updateGoalDiscovery(goalId: string, enabled: boolean): GoalSummary {
		const records = this.readGoals();
		const record = records.find((entry) => entry.id === goalId);
		if (!record) throw new Error(`Unknown goal: ${goalId}`);
		record.discoveryEnabled = enabled;
		record.updatedAt = new Date().toISOString();
		this.writeGoals(records);
		return this.buildSummary(record, record.messageCount);
	}

	updateGoalOutputLanguage(goalId: string, outputLanguage: OutputLanguage): GoalSummary {
		const records = this.readGoals();
		const record = records.find((entry) => entry.id === goalId);
		if (!record) throw new Error(`Unknown goal: ${goalId}`);
		record.outputLanguage = outputLanguage;
		record.updatedAt = new Date().toISOString();
		this.writeGoals(records);
		return this.buildSummary(record, record.messageCount);
	}

	async deleteGoal(goalId: string): Promise<void> {
		const goal = this.getGoal(goalId);
		if (!goal) throw new Error(`Unknown goal: ${goalId}`);

		const runner = this.runners.get(goalId);
		if (this.isGoalActive(goalId)) {
			throw new Error("Goal is currently running");
		}

		let deletionCommitted = false;
		this.deletingGoals.add(goalId);
		try {
			runner?.dispose();
			this.runners.delete(goalId);
			this.appliedCatalogRevision.delete(goalId);
			const goalPath = join(this.workspaceDir, goalId);
			const harnessPath = serverRuntimeDirForGoal(goalId, this.workspaceDir);
			await terminateProcessesWithin([goalPath, harnessPath]);

			const deletionRoot = join(
				runtimeControlRoot(this.workspaceDir),
				"deleted-goals",
				`${goalId}-${randomUUID()}`,
			);
			mkdirSync(deletionRoot, { recursive: true });
			const staged: Array<{ source: string; destination: string }> = [];
			try {
				await this.stageGoalPath(goalPath, join(deletionRoot, "workspace"), staged);
				await this.stageGoalPath(
					harnessPath,
					join(deletionRoot, "harness"),
					staged,
				);
			} catch (error) {
				await this.rollbackStagedGoalPaths(staged);
				await this.removeDeletionRoot(deletionRoot);
				throw error;
			}

			try {
				this.enqueueUserMemoryDeletion(goalId);
				const records = this.readGoals().filter((entry) => entry.id !== goalId);
				this.writeGoals(records);
				this.goalEnv.delete(goalId);
				deletionCommitted = true;
			} catch (error) {
				this.removePendingUserMemoryDeletion(goalId);
				await this.rollbackStagedGoalPaths(staged);
				await this.removeDeletionRoot(deletionRoot);
				throw error;
			}

			await this.removeDeletionRoot(deletionRoot);
		} finally {
			this.deletingGoals.delete(goalId);
			if (deletionCommitted) await this.flushPendingUserMemoryDeletions();
		}
	}

	private enqueueUserMemoryDeletion(goalId: string): void {
		const pending = this.readPendingUserMemoryDeletions();
		if (pending.includes(goalId)) return;
		this.writePendingUserMemoryDeletions([...pending, goalId]);
	}

	private removePendingUserMemoryDeletion(goalId: string): void {
		this.writePendingUserMemoryDeletions(this.readPendingUserMemoryDeletions().filter((id) => id !== goalId));
	}

	private flushPendingUserMemoryDeletions(): Promise<void> {
		const run = this.userMemoryDeletionFlush.then(async () => {
			for (const goalId of this.readPendingUserMemoryDeletions()) {
				if (this.getGoal(goalId)) continue;
				try {
					await deleteGoalUserMemory(goalId);
					this.removePendingUserMemoryDeletion(goalId);
				} catch (error) {
					log.logWarning(
						`[${goalId}] Hindsight deletion deferred`,
						toErrorMessage(error),
					);
				}
			}
		});
		this.userMemoryDeletionFlush = run.catch(() => undefined);
		return run;
	}

	private readPendingUserMemoryDeletions(): string[] {
		if (!existsSync(this.pendingUserMemoryDeletionsFile)) return [];
		const value = JSON.parse(readFileSync(this.pendingUserMemoryDeletionsFile, "utf-8")) as unknown;
		if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
			throw new Error("user-memory-deletions.json must contain Goal ids");
		}
		return [...new Set(value)];
	}

	private writePendingUserMemoryDeletions(goalIds: string[]): void {
		mkdirSync(runtimeControlRoot(this.workspaceDir), { recursive: true, mode: 0o700 });
		writeJsonAtomic(this.pendingUserMemoryDeletionsFile, goalIds, { mode: 0o600 });
	}

	private async stageGoalPath(
		source: string,
		destination: string,
		staged: Array<{ source: string; destination: string }>,
	): Promise<void> {
		if (!existsSync(source)) return;
		await this.lifecycleFs.rename(source, destination);
		staged.push({ source, destination });
	}

	private async rollbackStagedGoalPaths(
		staged: Array<{ source: string; destination: string }>,
	): Promise<void> {
		for (const entry of [...staged].reverse()) {
			if (!existsSync(entry.destination) || existsSync(entry.source)) continue;
			await this.lifecycleFs.rename(entry.destination, entry.source);
		}
	}

	private async removeDeletionRoot(deletionRoot: string): Promise<void> {
		await this.lifecycleFs.remove(deletionRoot, { recursive: true, force: true });
	}

	private startTopicDiscussion(input: {
		goalId: string;
		title: string;
		description: string;
		reason: "created" | "goal_updated";
	}): void {
		const event = renderAgentPrompt("main", "router", "user", {
			goal_context_json: JSON.stringify({ title: input.title, description: input.description }),
		}, input.reason === "created" ? "goal-created-event" : "goal-updated-event").content;
		void this.startRun(input.goalId, event).catch((error) => {
			// The turn never started (no default model, unknown model); the user sees it in Activity.
			const now = new Date().toISOString();
			this.topicPlanGenerations.set(input.goalId, { startedAt: now, failedAt: now, error: toErrorMessage(error) });
			log.logWarning(
				`[${input.goalId}] Main Agent Topic discussion failed after Goal ${input.reason}`,
				toErrorMessage(error),
			);
		});
	}

	private reapGoalDeletionTombstones(): void {
		const root = join(runtimeControlRoot(this.workspaceDir), "deleted-goals");
		if (!existsSync(root)) return;
		for (const entry of readdirSync(root)) {
			const path = join(root, entry);
			rmSync(path, { recursive: true, force: true });
		}
	}

	/**
	 * Returns a plain object snapshot of the goal's extra env vars. Used by
	 * the executor's lazy ExtraEnvGetter on every bash spawn.
	 *
	 * Keep derived env minimal. Research execution is owned by the project-level
	 * runtime, so new Goals should not advertise per-goal uv/npm caches, venvs,
	 * node_modules, or other ad-hoc execution homes.
	 */
	getGoalEnvSnapshot(goalId: string): Record<string, string> {
		const map = this.goalEnv.get(goalId);
		const creds = map ? Object.fromEntries(map) : {};
		const harnessRuntimeDir = serverRuntimeDirForGoal(goalId, this.workspaceDir);
		return {
			...creds,
			HARNESS_RUNTIME_DIR: harnessRuntimeDir,
			HARNESS_TRACE_DIR: join(harnessRuntimeDir, "traces"),
			HARNESS_DATA_DIR: join(harnessRuntimeDir, "data"),
			HARNESS_REPORT_DIR: join(harnessRuntimeDir, "reports"),
		};
	}

	/**
	 * Set a restored credential env var for the goal.
	 */
	setGoalEnvVar(goalId: string, key: string, value: string): void {
		let map = this.goalEnv.get(goalId);
		if (!map) {
			map = new Map();
			this.goalEnv.set(goalId, map);
		}
		map.set(key, value);
	}

	/**
	 * Re-read every <goalDir>/.pi/credentials/*.json into the per-goal env
	 * map. Idempotent. Called before each goal runner starts so server restarts
	 * preserve the saved environment.
	 */
	loadCredentialsFromDisk(goalId: string): void {
		const dir = goalCredentialsDir(join(this.workspaceDir, goalId));
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".json")) continue;
			const abs = join(dir, name);
			const stat = statSync(abs);
			if (!stat.isFile()) continue;
			const parsed = JSON.parse(readFileSync(abs, "utf-8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${abs} must contain an object`);
			const record = parsed as { sourceSlug?: unknown; values?: unknown };
			if (typeof record.sourceSlug !== "string" || !record.sourceSlug.trim()) throw new Error(`${abs}.sourceSlug is required`);
			if (!record.values || typeof record.values !== "object" || Array.isArray(record.values)) throw new Error(`${abs}.values must contain an object`);
			for (const [key, value] of Object.entries(record.values)) {
				if (typeof value !== "string") throw new Error(`${abs}.values.${key} must be a string`);
				this.setGoalEnvVar(goalId, key, value);
			}
		}
	}

	/**
	 * What a finished turn says about its model: a Provider rejection stays on the model until a
	 * test or turn completes on it, and the automatic Topic Plan generation records its failure
	 * instead of vanishing from Activity.
	 */
	private recordTurnOutcome(goalId: string, snapshot: GoalSnapshot): void {
		const outcome = lastAssistantOutcome(snapshot.messages);
		const model = outcome?.model ?? snapshot.modelId;
		if (model && (outcome?.rejection || !snapshot.errorMessage)) recordModelVerdict(model, outcome?.rejection);
		const generation = this.topicPlanGenerations.get(goalId);
		if (!generation) return;
		const error = outcome?.rejection ?? snapshot.errorMessage;
		if (error) this.topicPlanGenerations.set(goalId, { ...generation, failedAt: new Date().toISOString(), error });
		else this.topicPlanGenerations.delete(goalId);
	}

	private updateFromSnapshot(snapshot: GoalSnapshot): void {
		const records = this.readGoals();
		const record = records.find((entry) => entry.id === snapshot.goalId);
		if (!record) return;

		const runner = this.runners.get(snapshot.goalId);
		record.updatedAt = new Date().toISOString();
		const nextPreview = runner?.getPreview() ?? "";
		if (nextPreview || snapshot.messages.length === 0) {
			record.preview = nextPreview;
		}
		record.messageCount = snapshot.messages.length;
		this.writeGoals(records);
		this.recordRunStreaming(snapshot.goalId, snapshot.isStreaming, snapshot);

		// Runner may have just transitioned from running → idle; drain any queued prompts
		// (e.g. sources/draft bootstrap that arrived while the agent was busy).
		void this.drainPendingInputs(snapshot.goalId);
	}

	private recordRunStreaming(goalId: string, isStreaming: boolean, snapshot: GoalSnapshot): void {
		if (!isStreaming) this.recordTurnOutcome(goalId, snapshot);
		const previous = this.lastStreamingState.get(goalId) ?? false;
		if (previous === isStreaming) return;
		this.lastStreamingState.set(goalId, isStreaming);
		const timestamp = new Date().toISOString();
		if (isStreaming) {
			publish({
				type: "goal:run-started",
				goalId,
				messageCount: snapshot.messages.length,
				timestamp,
			});
		} else {
			const completedEvent = {
				type: "goal:run-completed",
				goalId,
				messageCount: snapshot.messages.length,
				timestamp,
				errorMessage: snapshot.errorMessage,
			} as const;
			publish(completedEvent);
		}
		const summary = this.getGoal(goalId);
		if (summary) publish({ type: "updated", goal: summary });
	}

	private ensureWorkspace(): void {
		mkdirSync(this.workspaceDir, { recursive: true });
		if (!existsSync(this.goalsFile)) {
			writeFileSync(this.goalsFile, "[]\n", "utf-8");
		}
	}

	private readGoals(): GoalRecord[] {
		const value = JSON.parse(readFileSync(this.goalsFile, "utf-8")) as unknown;
		if (!Array.isArray(value)) throw new Error("goals.json must contain an array");
		const records = value.map((entry, index) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error(`goals.json[${index}] must contain an object`);
			}
			const record = entry as Record<string, unknown>;
			const allowed = new Set([
				"id", "title", "description", "createdAt", "updatedAt", "preview", "messageCount",
				"avatar", "discoveryEnabled", "outputLanguage",
				"modelOverride", "thinkingLevelOverride",
			]);
			const unknown = Object.keys(record).find((field) => !allowed.has(field));
			if (unknown) throw new Error(`goals.json[${index}] contains unknown field '${unknown}'`);
			for (const field of ["id", "title", "description", "createdAt", "updatedAt", "preview"] as const) {
				if (typeof record[field] !== "string") throw new Error(`goals.json[${index}].${field} must be a string`);
			}
			if (!Number.isInteger(record.messageCount) || Number(record.messageCount) < 0) {
				throw new Error(`goals.json[${index}].messageCount must be a non-negative integer`);
			}
			if (!isGoalAvatar(record.avatar)) throw new Error(`goals.json[${index}].avatar is invalid`);
			if (typeof record.discoveryEnabled !== "boolean") {
				throw new Error(`goals.json[${index}].discoveryEnabled must be a boolean`);
			}
			if (!isOutputLanguage(record.outputLanguage)) {
				throw new Error(`goals.json[${index}].outputLanguage is invalid`);
			}
			if (record.modelOverride !== undefined
				&& record.modelOverride !== null
				&& (typeof record.modelOverride !== "string" || !record.modelOverride.includes("/"))) {
				throw new Error(`goals.json[${index}].modelOverride must be a provider/model string or null`);
			}
			if (record.thinkingLevelOverride !== undefined
				&& record.thinkingLevelOverride !== null
				&& !isThinkingLevel(record.thinkingLevelOverride)) {
				throw new Error(`goals.json[${index}].thinkingLevelOverride is invalid`);
			}
			return record as unknown as GoalRecord;
		});
		return records;
	}

	/**
	 * Goals saved by retired avatar renderers carry either DiceBear `avatarStyle`/
	 * `avatarRevision` seeds or a retired part catalog. They receive a head, eye and
	 * colour once here, so `readGoals` can stay strict about the current record.
	 */
	private migrateLegacyAvatars(): void {
		const value = JSON.parse(readFileSync(this.goalsFile, "utf-8")) as unknown;
		if (!Array.isArray(value)) return;
		const records = value.filter((entry): entry is Record<string, unknown> =>
			!!entry && typeof entry === "object" && !Array.isArray(entry));
		const legacy = records.filter((record) => !isGoalAvatar(record.avatar));
		if (legacy.length === 0) return;
		const assigned: Pick<GoalRecord, "id" | "avatar">[] = records
			.filter((record) => isGoalAvatar(record.avatar))
			.map((record) => ({ id: String(record.id), avatar: record.avatar as GoalAvatar }));
		for (const record of legacy) {
			delete record.avatarStyle;
			delete record.avatarRevision;
			record.avatar = assignAvatar(assigned, String(record.id));
			assigned.push({ id: String(record.id), avatar: record.avatar as GoalAvatar });
		}
		writeFileSync(this.goalsFile, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	}

	private writeGoals(records: GoalRecord[]): void {
		writeFileSync(this.goalsFile, `${JSON.stringify(records, null, 2)}\n`, "utf-8");
	}

	private buildSummary(record: GoalRecord, messageCount: number): GoalSummary {
		const runner = this.runners.get(record.id);
		const isStreaming = runner?.isRunning() ?? false;

		// lastActivityAt = max(record.updatedAt, mtime(<workspaceDir>/<id>/context.jsonl))
		// Read mtime cheaply via statSync when context.jsonl exists.
		let lastActivityAt = record.updatedAt;
		const ctxPath = join(this.workspaceDir, record.id, "context.jsonl");
		if (existsSync(ctxPath)) {
			const mtimeIso = statSync(ctxPath).mtime.toISOString();
			if (mtimeIso > lastActivityAt) {
				lastActivityAt = mtimeIso;
			}
		}

		const ageMs = Date.now() - new Date(lastActivityAt).getTime();
		const fresh = ageMs < 24 * 3600 * 1000 && messageCount > 0;

		// Only sample pulse from an already-loaded runner; never spin one up here.
		const pulseLine = runner ? runner.getPreview() || null : null;

		// The override fields are configuration, not part of the shared Goal summary contract.
		const { modelOverride, thinkingLevelOverride, ...summary } = record;
		return {
			...summary,
			messageCount,
			isStreaming,
			lastActivityAt,
			fresh,
			pulseLine,
		};
	}

}

async function terminateProcessesWithin(roots: readonly string[]): Promise<void> {
	const normalizedRoots = roots.filter(existsSync).map((root) => realpathSync(root));
	if (normalizedRoots.length === 0) return;
	const running = processIdsWithCwdWithin(normalizedRoots);
	for (const pid of running) signalProcess(pid, "SIGTERM");
	if (running.length === 0) return;
	await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	for (const pid of processIdsWithCwdWithin(normalizedRoots)) signalProcess(pid, "SIGKILL");
}

function processIdsWithCwdWithin(roots: readonly string[]): number[] {
	const found = new Set<number>();
	if (process.platform === "linux") {
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/u.test(entry)) continue;
			const pid = Number(entry);
			try {
				if (pid !== process.pid && roots.some((root) => pathContains(root, readlinkSync(`/proc/${entry}/cwd`)))) found.add(pid);
			} catch {
				// The process may exit while /proc is being scanned.
			}
		}
		return [...found];
	}
	const result = spawnSync("lsof", ["-n", "-a", "-d", "cwd", "-Fpn"], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	let pid = 0;
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid !== process.pid && roots.some((root) => pathContains(root, line.slice(1)))) found.add(pid);
	}
	return [...found];
}

function pathContains(root: string, candidate: string): boolean {
	const path = relative(root, resolve(candidate));
	return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
	}
}

const STALE_DANGLING_TOOL_CALL_MS = 5 * 60_000;

function recoverInterruptedResearchRuns(workspaceDir: string, goalId: string): void {
	const root = runRecordsDir(workspaceDir, goalId);
	if (!existsSync(root)) return;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		try {
			if (!new RunStateStore(join(root, entry.name)).recoverInterrupted()) continue;
			log.logWarning(`[${goalId}] marked interrupted Research Run '${entry.name}' inactive`);
		} catch (error) {
			log.logWarning(
				`[${goalId}] failed to recover interrupted Research Run '${entry.name}'`,
				toErrorMessage(error),
			);
		}
	}
}

function recoverInterruptedWikiUpdates(workspaceDir: string, goalId: string): void {
	try {
		for (const runId of markInterruptedWikiUpdates(workspaceDir, goalId)) {
			log.logWarning(`[${goalId}] recovered interrupted Wiki update '${runId}' as resumable`);
		}
	} catch (error) {
		log.logWarning(
			`[${goalId}] failed to recover interrupted Wiki updates`,
			toErrorMessage(error),
		);
	}
}

function recoverInterruptedTopicActivities(workspaceDir: string, goalId: string): void {
	try {
		const recovered = new GoalTopicPlanStore(goalId, workspaceDir).markInterruptedActivities();
		for (const id of recovered.reframes) {
			log.logWarning(`[${goalId}] recovered interrupted Topic Activity '${id}' as failed`);
		}
	} catch (error) {
		log.logWarning(
			`[${goalId}] failed to recover interrupted Topic Activities`,
			toErrorMessage(error),
		);
	}
}

function repairStaleDanglingToolCalls(goalDir: string, goalId: string): void {
	const contextPath = join(goalDir, "context.jsonl");
	if (!existsSync(contextPath)) return;

	const entries = readFileSync(contextPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));

	const answered = new Set<string>();
	for (const entry of entries) {
		const msg = entry?.message;
		if (entry?.type === "message" && msg?.role === "toolResult" && typeof msg.toolCallId === "string") {
			answered.add(msg.toolCallId);
		}
	}

	const now = Date.now();
	let inserted = 0;
	const repaired: any[] = [];
	for (const entry of entries) {
		repaired.push(entry);
		const msg = entry?.message;
		if (entry?.type !== "message" || msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const entryMs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : 0;
		if (!entryMs || now - entryMs < STALE_DANGLING_TOOL_CALL_MS) continue;

		for (const block of msg.content) {
			if (block?.type !== "toolCall" || typeof block.id !== "string" || answered.has(block.id)) continue;
			const toolName = typeof block.name === "string" ? block.name : "tool";
			const timestampMs = Math.max(entryMs + inserted + 1, entryMs + 1);
			const timestamp = new Date(timestampMs).toISOString();
			repaired.push({
				type: "message",
				id: `recovered-${now.toString(36)}-${inserted.toString(36)}`,
				parentId: entry.id,
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: block.id,
					toolName,
					content: [
						{
							type: "text",
							text: `Interrupted ${toolName} call was recovered after server restart; the previous run did not finish and should be retried.`,
						},
					],
					isError: true,
					timestamp: timestampMs,
				},
			});
			answered.add(block.id);
			inserted += 1;
		}
	}

	if (inserted === 0) return;
	try {
		writeFileSync(contextPath, `${repaired.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
		log.logWarning(`[${goalId}] repaired ${inserted} stale dangling tool call(s) in context.jsonl`);
	} catch (err) {
		log.logWarning(
			`[${goalId}] failed to repair stale dangling tool calls`,
			toErrorMessage(err),
		);
	}
}
