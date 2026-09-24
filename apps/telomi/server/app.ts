import express from "express";
import cors from "cors";
import { randomBytes } from "node:crypto";
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { runtimeControlRoot } from "./workspaces/server-runtime-paths.js";
import type { AppEvent } from "../shared/events/app-events.js";
import type { GoalEventEnvelope, CreateGoalRequest, GoalSummary, SendMessageRequest, UpdateGoalConfigRequest } from "../shared/types.js";
import { isOutputLanguage, resolveOutputLanguage } from "../shared/languages.js";
import { GoalService } from "./goals/service.js";
import { GoalRunner } from "./main-agent/runner.js";
import { executeResearchRun, resumeResearchRun } from "./research/execute-run.js";
import type { PodcastGenerationDispatchHandler } from "./main-agent/tools/generate-podcast.js";
import * as log from "./lib/log.js";
import { resolveDataDir } from "./config/data-dir.js";
import { resolveAgentDir } from "./config/agent-directory.js";
import { isAllowedBrowserOrigin, resolveOperationsMode, resolveOperationsPort, resolveServerHost } from "./config/network.js";
import { startCustomProvidersSync } from "./providers/sync.js";
import { browserHostEndpoint, ensureBrowserReady } from "./providers/browser/startup.js";
import { BrowserSessionRegistry } from "./providers/browser/session-registry.js";
import { createBrowserToolRouter } from "./providers/browser/tool-router.js";
import { attachBrowserObservationServer, createBrowserObservationRouter } from "./providers/browser/observation-server.js";
import { attachBrowserLoginServer } from "./providers/browser/login-stream.js";
import { createArtifactsRouter } from "./media/artifacts-api.js";
import { createWorkspaceRouter } from "./workspaces/api.js";
import { createWikiRouter } from "./wiki/api.js";
import { createPodcastsRouter } from "./media/podcast/api.js";
import { cardIdFromArtifactName, createMediaProductsRouter, createPodcastGenerator } from "./media/products-api.js";
import { resolvePodcastGenerationBrief } from "./media/podcast/preferences.js";
import { createVoiceRouter } from "./voice/api.js";
import { createLiveKitGoalBridgeRouter } from "./voice/livekit-goal-bridge.js";
import { createLiveKitTokenRouter } from "./voice/livekit-token-api.js";
import { getAudioLocalRuntimeManager } from "./audio/local-runtime.js";
import { listManagedAudioConnection } from "./audio/managed-connection.js";
import { publish, subscribe } from "./events/event-bus.js";
import { createTodayRouter } from "./app/today-api.js";
import { FileIngestService } from "./ingestion/service.js";
import { openSse, type SseConnection } from "./events/sse.js";
import { listSelectableModels, mountProviderConfigApi } from "./providers/config-api.js";
import { mountCapabilityAlertsApi } from "./providers/capability-alerts.js";
import { setModelVerdictListener } from "./agent-runtime/model-config/model-verdicts.js";
import { mountAudioConfigApi } from "./voice/config-api.js";
import { mountAuthApi } from "./accounts/auth-api.js";
import { mountConnectionsApi } from "./providers/connections-api.js";
import { mountCustomProvidersApi } from "./providers/api.js";
import { mountOllamaApi } from "./providers/ollama-api.js";
import { mountOAuthApi } from "./accounts/oauth-api.js";
import { mountAccountsApi } from "./accounts/accounts-api.js";
import { loadAllAccountManagers, loadedAccountSnapshots } from "./accounts/manager.js";
import { codexUsageMonitor } from "./accounts/codex/usage-monitor.js";
import { buildToolIconManifest } from "./tool-icons/index.js";
import { PodcastActivityStore } from "./events/activity-store.js";
import { loadProjectEnvironment } from "./config/environment.js";
import { ensureHindsightBankId } from "./config/settings.js";
import { applyCredentialTombstones } from "./config/credential-tombstones.js";
import { clearAmbientTaskModelOverrides } from "./config/task-model-environment.js";
import {
	applySearchCredentialEnvironment,
	importLegacySearchCredentials,
} from "./providers/search-credentials.js";
import { mountSearchCredentialsApi } from "./providers/search-credentials-api.js";
import { BROWSER_SETTLE_RETRY_MS, mountSourcesApi } from "./providers/sources-api.js";
import { getSourceStatusMonitor, setSourceStatusChangeListener } from "./providers/source-status.js";
import { discoverLocalProviderEnvironment, waitForBrowserCookies } from "./config/local-credentials.js";
import { getResearchSourceServiceClient, getResearchSourceServiceManager } from "./providers/source-service-client.js";
import { getHindsightRuntimeManager } from "./goals/memory/hindsight-runtime.js";
import { mountEmbeddingApi, resumeEmbeddingMigration, stopEmbeddingMigration } from "./embedding/configuration.js";
import { hindsightEmbeddingMigrator } from "./embedding/memory-migration.js";
import { initializeEvaluationRuntimeProcessIdentity } from "./observability/version-snapshot.js";
import { createResearchSchedulesRouter } from "./research/schedules/api.js";
import { ResearchScheduleReviewService } from "./research/schedules/review-service.js";
import { ResearchScheduleScheduler } from "./research/schedules/scheduler.js";
import { createActivityProjection } from "./app/activity-projection.js";
import { createTraceRouter } from "./observability/trace-api.js";
import { createPromptRegistryRouter } from "./agent-runtime/prompt-registry-api.js";
import { PromptRegistry } from "./agent-runtime/prompt-registry.js";
import { GoalTopicPlanActivation, GoalTopicPlanStore, createTopicPlanRouter } from "./goals/topic-plan/index.js";
import { createAvatarRouter } from "./goals/avatar/api.js";
import { buildTopicPlanConfirmedEvent } from "./main-agent/topic-readiness-guard.js";
import { listWikiEditions } from "./wiki/editions.js";
import { resumeWikiUpdate } from "./wiki/update-runner.js";
import { createContentSearchRouter } from "./search/content-search.js";
import { toErrorMessage } from "./lib/values.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
loadProjectEnvironment(rootDir);
initializeEvaluationRuntimeProcessIdentity(rootDir);

const agentBrowserConfigPath = join(rootDir, "agent-browser.json");
if (!process.env.AGENT_BROWSER_CONFIG && existsSync(agentBrowserConfigPath)) {
	process.env.AGENT_BROWSER_CONFIG = agentBrowserConfigPath;
}

const workspaceDir = resolveDataDir();
process.env.TELOMI_DATA_DIR = workspaceDir;
const agentDir = resolveAgentDir();
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PRIME_AGENT_CODING_AGENT_DIR ||= agentDir;
ensureHindsightBankId();
// Unified settings own Provider credentials. Adopt a search key that only existed in the
// environment once, derive the variables the Source Service authenticates with from the managed
// store, and only then let the recorded deletions strip what must stay deleted. All of it runs
// after the environment files load and before the Source Service or any other consumer starts.
const importedSearchCredentials = importLegacySearchCredentials();
if (importedSearchCredentials.length > 0) {
	console.log(`[telomi] search credentials imported from the environment: ${importedSearchCredentials.join(", ")}`);
}
applySearchCredentialEnvironment();
const suppressedCredentialEnv = applyCredentialTombstones();
if (suppressedCredentialEnv.length > 0) {
	console.log(`[telomi] deleted Provider credentials suppress: ${suppressedCredentialEnv.join(", ")}`);
}
clearAmbientTaskModelOverrides();
const port = Number(process.env.PORT || 8787);
const host = resolveServerHost();
const operationsMode = resolveOperationsMode();
const evalInstance = operationsMode === "eval";
if (evalInstance) console.log("[telomi] eval instance mode enabled; isolated background job ownership");
const discoveredCredentials = await discoverLocalProviderEnvironment(rootDir);
if (discoveredCredentials.length > 0) {
	console.log(`[telomi] local credentials discovered: ${discoveredCredentials.join(", ")}`);
}
// Install lifecycle handling before the first managed service can be spawned.
let startupComplete = false;
let shutdownPromise: Promise<void> | undefined;
// Stay subscribed: node --watch forwards the process-group signal again, and the
// default action would kill the server before it reaps detached services.
process.on("SIGINT", (signal) => void shutdown(signal));
process.on("SIGTERM", (signal) => void shutdown(signal));
try {
	await ensureBrowserReady();
	await getResearchSourceServiceManager().ensureReady();
} catch (error) {
	await getResearchSourceServiceManager().close();
	throw error;
}
try {
	await getHindsightRuntimeManager().ensureReady();
} catch (error) {
	if (shutdownPromise) await shutdownPromise;
	else console.warn(`[memory] Service unavailable (${error instanceof Error ? error.message : String(error)}); model and service settings remain available for recovery`);
}

// Per-provider multi-account fallback. Loads every accounts/<provider>.json in the project
// agent directory and mirrors each active credential into auth.json so any later-forked CLI
// subprocess starts on the active account.
await loadAllAccountManagers();
if (!evalInstance) codexUsageMonitor.start();


let podcastGenerationHandler: PodcastGenerationDispatchHandler | undefined;
const goals = new GoalService(workspaceDir, {
	resumeWikiUpdate,
	async createRunner({ workspaceDir, goal, goalDir, onSnapshot, getExtraEnv, getDiscoveryEnabled, getOutputLanguage }) {
		const runner = new GoalRunner(
			workspaceDir, goal.id, goal.title, goalDir, onSnapshot, goal.description,
			getExtraEnv, undefined, () => podcastGenerationHandler, getDiscoveryEnabled, getOutputLanguage,
			fileIngestService,
		);
		try {
			await runner.init();
			await runner.bindExtensions();
		} catch (error) {
			runner.dispose();
			throw error;
		}
		log.logInfo(`[${goal.id}] DIAG tools=${JSON.stringify((runner as any).agent.state.tools.map((t: any) => t.name))}`);
		return runner;
	},
	executeResearchRun({ workspaceDir, goal, getExtraEnv, request }) {
		return executeResearchRun({
			goalDir: join(workspaceDir, goal.id),
			goalId: goal.id,
			goalTitle: goal.title,
			goalDescription: goal.description,
			workspaceDir,
			extraEnv: getExtraEnv(),
			discoveryEnabled: goal.discoveryEnabled,
			outputLanguage: goal.outputLanguage,
			taskSource: "scheduled_research",
			scheduledResearch: request.context,
			reason: `Scheduled Research occurrence ${request.context.occurrenceId}`,
			question: request.question,
			reportContext: request.reportContext,
			reportTitle: request.title,
			...(request.signal ? { signal: request.signal } : {}),
			...(request.onRunReserved ? { onRunReserved: request.onRunReserved } : {}),
		});
	},
	resumeResearchRun({ workspaceDir, goal, getExtraEnv, runId }) {
		return resumeResearchRun({
			goalDir: join(workspaceDir, goal.id),
			goalId: goal.id,
			workspaceDir,
			extraEnv: getExtraEnv(),
			runId,
		});
	},
});
const promptRegistry = new PromptRegistry({ dataRoot: workspaceDir });
// Every instance captures Cases; its role controls only the separate Operations Listener write access.
const operations = await (async () => {
	const { createOperationsRuntime } = await import("./evaluation/operations-runtime.js");
	const runtime = createOperationsRuntime({
		mode: operationsMode,
		port: resolveOperationsPort(port),
		workspaceDir,
		goals,
	});
	const [
		{ EvolutionService }, { createEvolutionTargets },
		{ createEvolutionRouter }, { installBrowserEvolutionTrigger }, { evolutionCaseCapture },
	] = await Promise.all([
		import("./evolution/service.js"),
		import("./evolution/targets.js"),
		import("./evolution/api.js"),
		import("./evolution/lifecycle.js"),
		import("./evaluation/evolution-replay.js"),
	]);
	const listGoalIds = () => goals.listGoals().map((goal) => goal.id);
	const evolution = new EvolutionService({
		workspaceDir,
		listGoalIds,
		targets: createEvolutionTargets({ workspaceDir, nodeBacktests: runtime.nodeBacktests }),
		// 每个终态 Browser Evolution Run 捕获成一个 evolution Case，供评估环境外层回放和人工评测。
		onRunSettled: evolutionCaseCapture({ nodeBacktests: runtime.nodeBacktests }),
	});
	// 三个已结算的 Browser Provider child execution 自动触发一次 Browser Evolution。
	const evolutionLifecycle = installBrowserEvolutionTrigger({
		workspaceDir, nodeBacktests: runtime.nodeBacktests, evolution, listGoalIds,
	});
	return { runtime, evolution, evolutionLifecycle, evolutionRouter: createEvolutionRouter(goals, evolution) };
})();

const podcastActivities = new PodcastActivityStore({
	logPath: join(runtimeControlRoot(workspaceDir), "activity", "events.jsonl"),
	capPerGoal: 120,
	replayLimit: 5_000,
});
const topicPlanActivation = new GoalTopicPlanActivation({
	workspaceDir,
	recordConfirmation: async ({ goalId, revision, proposalId }) =>
		await goals.recordGoalEvent(goalId, buildTopicPlanConfirmedEvent(revision, proposalId)) ? "recorded" : "duplicate",
	projectUserMemory: async (goalId) => {
		const goal = goals.getGoal(goalId);
		if (goal) await (await goals.getRunner(goal)).projectUserMemory();
	},
	goalEnv: (goalId) => ({ ...process.env, ...goals.getGoalEnvSnapshot(goalId) }),
});
// One Review service for both entry points, so "one Reviewer per Schedule" also holds between
// a Review the scheduler triggers and one the user asks for.
const resolveGoalOutputLanguage = (goalId: string, text: string) => resolveOutputLanguage(
	goals.getGoal(goalId)?.outputLanguage ?? "auto",
	text,
);
const researchScheduleReviews = new ResearchScheduleReviewService(
	workspaceDir, undefined, undefined, resolveGoalOutputLanguage,
);
const researchScheduleScheduler = new ResearchScheduleScheduler(
	workspaceDir,
	goals,
	researchScheduleReviews,
);

const browserSessions = new BrowserSessionRegistry({
	dataRoot: workspaceDir,
	// Resolve through the package so a hoisted install (npm workspaces put it in the repository
	// root, not apps/telomi/node_modules) still finds the executable.
	agentBrowserBin: fileURLToPath(import.meta.resolve("agent-browser/bin/agent-browser.js")),
	onEvent: (evt) => {
		if (evt.kind === "release") console.log(`[telomi][providers/browser] detached "${evt.sessionId}" (${evt.reason}, ${evt.outcome})`);
		else if (evt.kind === "sweep" && evt.reclaimed > 0) console.log(`[telomi][providers/browser] sweep reclaimed ${evt.reclaimed}`);
		else if (evt.kind === "error") console.warn(`[telomi][providers/browser] ${evt.message}`);
	},
});
const browserToolToken = randomBytes(32).toString("base64url");
process.env.TELOMI_BROWSER_TOOL_URL = `http://127.0.0.1:${port}/_runtime/browser-tool`;
process.env.TELOMI_BROWSER_TOOL_TOKEN = browserToolToken;
if (!evalInstance) {
	void browserSessions.sweep("crash-backstop")
		.catch((error) => console.warn(`[telomi][providers/browser] boot sweep failed: ${toErrorMessage(error)}`));
	browserSessions.startSweep();
}
console.log(
	`[telomi][providers/browser] namespace=${browserSessions.config.namespace} cdp=${browserSessions.config.cdpUrl} max=${browserSessions.config.maxConcurrentWorkspaces} idle=${Math.round(browserSessions.config.idleTimeoutMs / 60000)}min runDir=${browserSessions.config.runDir}`,
);

const customProvidersSync = startCustomProvidersSync({
	onEvent: (evt) => {
		switch (evt.kind) {
			case "provider-synced":
				if (evt.added.length > 0) {
					console.log(
						`[telomi][providers/sync] ${evt.provider} added=${evt.added.length} (${evt.added.join(", ")}) total=${evt.total}`,
					);
				}
				break;
			case "provider-skipped":
				console.warn(`[telomi][providers/sync] skipped ${evt.provider}: ${evt.reason}`);
				break;
			case "provider-error":
				console.warn(`[telomi][providers/sync] error ${evt.provider}: ${evt.error}`);
				break;
			case "tick-end":
				if (evt.changed > 0) {
					console.log(
						`[telomi][providers/sync] tick-end changed=${evt.changed} durationMs=${evt.durationMs}`,
					);
				}
				break;
		}
	},
});
// Replay owns explicit requests, not autonomous writes to shared provider configuration.
if (evalInstance) customProvidersSync.stop();
console.log(
	`[telomi][providers/sync] enabled=${customProvidersSync.config.enabled} interval=${Math.round(
		customProvidersSync.config.intervalMs / (60 * 60 * 1000),
	)}h initialDelay=${Math.round(customProvidersSync.config.initialDelayMs / 60000)}min`,
);

// Explicit annotation: the runner factory above closes over this service, so inference would cycle.
const fileIngestService: FileIngestService = new FileIngestService({
	workspaceDir,
	listGoalIds: () => goals.listGoals().map((goal) => goal.id),
	onEvent: (evt) => {
		if (evt.type === "queued" || evt.type === "started" || evt.type === "finished") {
			console.log(`[telomi][ingestion] ${evt.type} goal=${evt.goalId ?? "-"} job=${evt.jobId ?? "-"}${evt.message ? ` | ${evt.message}` : ""}`);
		} else if (evt.type === "failed" || evt.type === "error") {
			console.warn(`[telomi][ingestion] ${evt.type} goal=${evt.goalId ?? "-"} job=${evt.jobId ?? "-"}${evt.message ? ` | ${evt.message}` : ""}`);
		} else if (evt.type === "retry" || evt.type === "resume") {
			console.log(`[telomi][ingestion] ${evt.type}${evt.goalId ? ` goal=${evt.goalId}` : ""}${evt.jobId ? ` job=${evt.jobId}` : ""}${evt.message ? ` | ${evt.message}` : ""}`);
		}
	},
});
// Ingestion parses chat document attachments only. An eval instance replays explicit
// requests, so recovering previously queued jobs is the background work to suppress.
fileIngestService.start({ resumeQueued: !evalInstance });
console.log(
	`[telomi][ingestion] resumeQueued=${!evalInstance} concurrency=${fileIngestService.config.concurrency} maxBytes=${fileIngestService.config.maxBytes} timeoutMs=${fileIngestService.config.requestTimeoutMs}`,
);

const app = express();
app.use(cors({ origin: (origin, callback) => callback(null, isAllowedBrowserOrigin(origin, port)) }));
app.use(express.json({ limit: "50mb" }));
app.use(createBrowserToolRouter(browserSessions, browserToolToken));
app.use(createBrowserObservationRouter(browserSessions, (goalId) => Boolean(goals.getGoal(goalId))));
const audioLocalRuntime = getAudioLocalRuntimeManager();
audioLocalRuntime.onReady((baseUrl) => listManagedAudioConnection(baseUrl).catch((error: unknown) => {
	console.warn(`[audio] could not list the local runtime's models: ${toErrorMessage(error)}`);
}));
// A local runtime already running from before this start is listed without waiting for a settings visit.
void audioLocalRuntime.refresh().catch(() => undefined);
const activityProjection = createActivityProjection({
	workspaceDir,
	listGoalIds: () => goals.listGoals().map((goal) => goal.id),
	listPodcastActivities: (goalId) => podcastActivities.list(goalId),
	readTopicPlanGeneration: (goalId) => goals.getTopicPlanGeneration(goalId),
});

app.use(createArtifactsRouter(workspaceDir, goals));
app.use(createContentSearchRouter(workspaceDir, goals));
app.use(createAvatarRouter({
	goals,
	onGoalUpdated: (goal) => publish({ type: "updated", goal }),
}));
app.use(createTopicPlanRouter({
	getGoal: (goalId) => goals.getGoal(goalId),
	activation: topicPlanActivation,
}));
app.use(createResearchSchedulesRouter(workspaceDir, goals, researchScheduleReviews));
app.use(createWorkspaceRouter(workspaceDir, goals));
app.use(createWikiRouter(workspaceDir, goals));
if (operations) app.use(operations.evolutionRouter);
app.use(createPromptRegistryRouter(promptRegistry));
app.use(createTraceRouter(workspaceDir, goals));
app.use(createPodcastsRouter(workspaceDir, goals));
const podcastGenerator = createPodcastGenerator(workspaceDir, {
	resolveOutputLanguage: resolveGoalOutputLanguage,
	resolveGenerationBrief: (goalId, generationInstruction) => {
		goals.loadCredentialsFromDisk(goalId);
		const env = { ...process.env, ...goals.getGoalEnvSnapshot(goalId) };
		return resolvePodcastGenerationBrief({
			goalId,
			generationInstruction,
			memory: { baseUrl: env.HINDSIGHT_URL, bankId: env.HINDSIGHT_BANK_ID },
		});
	},
}, {
	onActivity: (item) => podcastActivities.record(item),
});
podcastGenerationHandler = ({ goalId, artifactName, generationInstruction }) => {
	const relativeName = artifactName.replace(/^\/?artifacts\//u, "");
	const cardId = cardIdFromArtifactName(relativeName);
	if (!cardId) throw new Error("generate_podcast requires an existing Markdown artifact name");
	const job = podcastGenerator.start({ goalId, cardId, generationInstruction });
	return { jobId: job.jobId, cardId };
};
app.use(createMediaProductsRouter(workspaceDir, goals, podcastGenerator));
app.use(createVoiceRouter(goals, workspaceDir, audioLocalRuntime));
app.use(createLiveKitTokenRouter(goals));
app.use(createLiveKitGoalBridgeRouter(goals));
const today = createTodayRouter(workspaceDir, goals);
app.use(today.router);
mountProviderConfigApi(app, { mainAgent: goals, memory: getHindsightRuntimeManager() });
mountCapabilityAlertsApi(app, { mainAgent: goals, memory: getHindsightRuntimeManager(), sources: getSourceStatusMonitor() });
const embeddingDependencies = {
	wikiGoalDirs: () => goals.listGoals().map((goal) => join(workspaceDir, goal.id)),
	memory: hindsightEmbeddingMigrator(getHindsightRuntimeManager()),
};
mountEmbeddingApi(app, embeddingDependencies);
// A rebuild interrupted by the last shutdown continues; its old index kept serving meanwhile.
resumeEmbeddingMigration(embeddingDependencies);
mountAudioConfigApi(app, audioLocalRuntime);
mountAuthApi(app);
mountConnectionsApi(app);
mountSearchCredentialsApi(app, { sourceService: getResearchSourceServiceClient(), statuses: getSourceStatusMonitor() });
mountSourcesApi(app, { monitor: getSourceStatusMonitor(), liveBrowserSessions: () => browserSessions.liveSessions() });
mountCustomProvidersApi(app);
mountOllamaApi(app);
mountOAuthApi(app);

const appEventClients = new Set<SseConnection>();

function broadcastAppEvent(payload: AppEvent): void {
	for (const client of appEventClients) {
		client.send(payload);
	}
}

mountAccountsApi(app, (provider, state) => publish({
	type: "account:changed",
	scope: "global",
	provider,
	state,
}));

subscribe((event) => {
	broadcastAppEvent(event);
});
setSourceStatusChangeListener((change) => publish({ type: "source-status:changed", ...change }));
setModelVerdictListener(() => publish({ type: "capability-alerts:changed", ts: new Date().toISOString() }));
podcastActivities.subscribe((event) => publish({
	type: "activity-projection:changed",
	goalId: event.goalId,
}));

app.get("/api/events", async (req, res) => {
	try {
		const goalId = typeof req.query.goalId === "string" ? req.query.goalId.trim() : "";
		const goal = goalId ? goals.getGoal(goalId) : undefined;
		const runner = goal ? await goals.getRunner(goal) : undefined;
		const stream = openSse(req, res);
		let pending: GoalEventEnvelope["state"] | undefined;
		let flush: ReturnType<typeof setTimeout> | undefined;
		const unsubscribeGoal = runner?.subscribe((payload: GoalEventEnvelope) => {
			pending = payload.state;
			if (flush) return;
			flush = setTimeout(() => {
				flush = undefined;
				if (!pending) return;
				stream.send({ type: "goal-session:snapshot", goalId: pending.goalId, state: pending } satisfies AppEvent);
				pending = undefined;
			}, 25);
		});
		appEventClients.add(stream);
		stream.onClose(() => {
			appEventClients.delete(stream);
			if (flush) clearTimeout(flush);
			unsubscribeGoal?.();
		});
		stream.send({
			type: "snapshot",
			goals: goals.listGoals(),
			accounts: loadedAccountSnapshots(),
		} satisfies AppEvent);
		if (runner) {
			const state = runner.getSnapshot();
			stream.send({ type: "goal-session:snapshot", goalId: state.goalId, state } satisfies AppEvent);
		}
	} catch (error) {
		res.status(500).json({ error: toErrorMessage(error) });
	}
});

app.get("/api/tool-icons", (_req, res) => {
	try {
		res.json(buildToolIconManifest());
	} catch (err) {
		res.status(500).json({ error: toErrorMessage(err) });
	}
});

app.get("/api/health", (_req, res) => {
	res.json({
		ok: true,
		sandbox: "srt",
		workspaceDir,
	});
});

app.post("/api/admin/providers/sync/run-now", async (_req, res) => {
	if (!customProvidersSync.config.enabled) {
		res.status(409).json({ ok: false, error: "providers/sync disabled" });
		return;
	}
	try {
		await customProvidersSync.runNow();
		res.status(202).json({ ok: true });
	} catch (err) {
		console.warn("[telomi][providers/sync] run-now error:", err);
		res.status(500).json({ ok: false, error: toErrorMessage(err) });
	}
});

app.get("/api/admin/providers/sync/status", (_req, res) => {
	const cfg = customProvidersSync.config;
	res.json({
		ok: true,
		config: {
			enabled: cfg.enabled,
			intervalMs: cfg.intervalMs,
			initialDelayMs: cfg.initialDelayMs,
		},
	});
});

function cleanNullableText(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}


app.get("/api/events/activity-projection/summary", (_req, res) => {
	res.json(activityProjection.getGlobalSummary());
});

app.get("/api/goals/:goalId/events/activity-projection", (req, res) => {
	const goal = goals.getGoal(req.params.goalId);
	if (!goal) {
		res.status(404).json({ error: "Unknown goal" });
		return;
	}
	try {
		res.json(activityProjection.getGoal(goal.id, cleanNullableText(req.query.cursor) ?? undefined));
	} catch (error) {
		res.status(400).json({ error: toErrorMessage(error) });
	}
});

app.get("/api/goals/:goalId/events/activity-projection/output/:outputRef", (req, res) => {
	const goal = goals.getGoal(req.params.goalId);
	if (!goal) {
		res.status(404).json({ error: "Unknown goal" });
		return;
	}
	try {
		const line = typeof req.query.line === "string" ? req.query.line : undefined;
		const output = activityProjection.readOutput(goal.id, req.params.outputRef, { line });
		if (!output) {
			res.status(404).json({ error: "Unknown Activity output" });
			return;
		}
		res.json(output);
	} catch (error) {
		res.status(400).json({ error: toErrorMessage(error) });
	}
});

app.get("/api/goals/:goalId/topic-plan", (req, res) => {
	const goal = goals.getGoal(req.params.goalId);
	if (!goal) return void res.status(404).json({ error: "Unknown goal" });
	try {
		const store = new GoalTopicPlanStore(goal.id, workspaceDir);
		const active = store.readActive() ?? null;
		const wikiRevisions = new Set(listWikiEditions(workspaceDir, goal.id).map((edition) => edition.revision));
		res.json({
			active,
			proposal: store.listProposals().find((proposal) => proposal.status === "proposed") ?? null,
			history: store.readHistory().reverse().map((entry) => ({
				revision: entry.version,
				confirmedAt: entry.confirmed_at,
				active: entry.version === active?.revision,
				wikiAvailable: wikiRevisions.has(entry.version),
				plan: store.readRevision(entry.version),
			})),
		});
	} catch (error) {
		res.status(500).json({ error: toErrorMessage(error) });
	}
});

app.get("/api/goals/:goalId/discoveries", (req, res) => {
	const goal = goals.getGoal(req.params.goalId);
	if (!goal) return void res.status(404).json({ error: "Unknown goal" });
	try {
		const requested = cleanNullableText(req.query.status)?.split(",").map((value) => value.trim()).filter(Boolean);
		const valid = new Set(["open", "closed"]);
		if (requested?.some((status) => !valid.has(status))) throw new Error("Invalid Discovery status filter");
		const store = new GoalTopicPlanStore(goal.id, workspaceDir);
		res.json(requested
			? store.listDiscoveries(requested as Array<"open" | "closed">)
			: store.readDiscoveryInbox());
	} catch (error) {
		res.status(400).json({ error: toErrorMessage(error) });
	}
});

app.get("/api/goals/:goalId/discoveries/:candidateId", (req, res) => {
	const goal = goals.getGoal(req.params.goalId);
	if (!goal) return void res.status(404).json({ error: "Unknown goal" });
	try {
		res.json(new GoalTopicPlanStore(goal.id, workspaceDir).readDiscovery(req.params.candidateId));
	} catch (error) {
		res.status(404).json({ error: toErrorMessage(error) });
	}
});

app.post("/api/goals/:goalId/discoveries/:candidateId/ignore", (req, res) => {
	const goal = goals.getGoal(req.params.goalId);
	if (!goal) return void res.status(404).json({ error: "Unknown goal" });
	try {
		const candidate = new GoalTopicPlanStore(goal.id, workspaceDir).ignoreDiscovery(req.params.candidateId);
		publish({ type: "discovery:changed", goalId: goal.id, candidateId: candidate.id, status: candidate.status, ts: new Date().toISOString() });
		res.json(candidate);
	} catch (error) {
		res.status(409).json({ error: toErrorMessage(error) });
	}
});

app.post("/api/goals/:goalId/discoveries/:candidateId/reopen", (req, res) => {
	const goal = goals.getGoal(req.params.goalId);
	if (!goal) return void res.status(404).json({ error: "Unknown goal" });
	try {
		const candidate = new GoalTopicPlanStore(goal.id, workspaceDir).reopenDiscovery(req.params.candidateId);
		publish({ type: "discovery:changed", goalId: goal.id, candidateId: candidate.id, status: candidate.status, ts: new Date().toISOString() });
		res.json(candidate);
	} catch (error) {
		res.status(409).json({ error: toErrorMessage(error) });
	}
});

app.post("/api/goals/:goalId/wiki-updates/:runId/resume", (req, res) => {
	try {
		goals.startWikiUpdateResume(req.params.goalId, req.params.runId);
		res.status(202).json({ accepted: true, goalId: req.params.goalId, runId: req.params.runId });
	} catch (error) {
		const message = toErrorMessage(error);
		const status = message.startsWith("Unknown goal") || message === "Unknown Wiki update" ? 404 : 409;
		res.status(status).json({ error: message });
	}
});

app.post("/api/goals/:goalId/research-runs/:runId/resume", (req, res) => {
	try {
		goals.startResearchRunResume(req.params.goalId, req.params.runId);
		res.status(202).json({ accepted: true, goalId: req.params.goalId, runId: req.params.runId });
	} catch (error) {
		const message = toErrorMessage(error);
		const status = message.startsWith("Unknown goal") || message === "Unknown Research Run" ? 404 : 409;
		res.status(status).json({ error: message });
	}
});

app.get("/api/goals", (_req, res) => {
	res.json({ goals: goals.listGoals() });
});

app.get("/api/models", async (_req, res) => {
	res.json({ models: await listSelectableModels() });
});

app.post("/api/goals", (req, res) => {
	const body = (req.body || {}) as CreateGoalRequest;
	if (body.outputLanguage !== undefined && !isOutputLanguage(body.outputLanguage)) {
		res.status(400).json({ error: "outputLanguage must be auto, zh-CN, or en" });
		return;
	}
	const goal = goals.createGoal({ title: body.title, description: body.description, outputLanguage: body.outputLanguage });
	// Drop the today rollup cache so the freshly added goal is reflected in
	// `liveGoals` / banner counts immediately rather than waiting for the
	// 30s TTL.
	today.invalidate();
	publish({ type: "created", goal });
	res.status(201).json({ goal });
});

app.delete("/api/goals/:goalId", async (req, res) => {
	try {
		await goals.deleteGoal(req.params.goalId);
		podcastActivities.purgeGoal(req.params.goalId);
		today.invalidate();
		publish({ type: "deleted", id: req.params.goalId });
		res.json({ ok: true });
	} catch (error) {
		const message = toErrorMessage(error);
		const status = message.includes("running")
			? 409
			: message.includes("Unknown goal")
				? 404
				: 500;
		res.status(status).json({ error: message });
	}
});

app.get("/api/goals/:goalId/state", async (req, res) => {
	try {
		res.json({ state: await goals.getSnapshot(req.params.goalId) });
	} catch (error) {
		res.status(404).json({ error: toErrorMessage(error) });
	}
});

app.patch("/api/goals/:goalId/config", async (req, res) => {
	const body = (req.body || {}) as UpdateGoalConfigRequest;
	if (
		body.modelId === undefined &&
		body.thinkingLevel === undefined &&
		typeof body.title !== "string" &&
		typeof body.description !== "string" &&
		typeof body.discoveryEnabled !== "boolean" &&
		body.outputLanguage === undefined
	) {
		res.status(400).json({ error: "modelId, thinkingLevel, title, description, discoveryEnabled, or outputLanguage is required" });
		return;
	}
	if (body.outputLanguage !== undefined && !isOutputLanguage(body.outputLanguage)) {
		res.status(400).json({ error: "outputLanguage must be auto, zh-CN, or en" });
		return;
	}

	try {
		let summary: GoalSummary | undefined;
		if (typeof body.title === "string") {
			summary = goals.renameGoal(req.params.goalId, body.title);
		}
		if (typeof body.description === "string") {
			summary = goals.updateGoalDescription(req.params.goalId, body.description);
		}
		if (typeof body.discoveryEnabled === "boolean") {
			summary = goals.updateGoalDiscovery(req.params.goalId, body.discoveryEnabled);
		}
		if (body.outputLanguage !== undefined) {
			summary = goals.updateGoalOutputLanguage(req.params.goalId, body.outputLanguage);
		}
		if (body.modelId !== undefined || body.thinkingLevel !== undefined) {
			await goals.updateGoalConfig(req.params.goalId, {
				...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
				...(body.thinkingLevel !== undefined ? { thinkingLevel: body.thinkingLevel } : {}),
			});
			summary = goals.listGoals().find((g) => g.id === req.params.goalId) ?? summary;
		}
		if (summary) publish({ type: "updated", goal: summary });
		res.json({ ok: true, state: await goals.getSnapshot(req.params.goalId), goal: summary });
	} catch (error) {
		const message = toErrorMessage(error);
		res.status(404).json({ error: message });
	}
});

app.post("/api/goals/:goalId/messages", async (req, res) => {
	const body = (req.body || {}) as SendMessageRequest;
	const content = body.content?.trim() || "";
	const attachments = body.attachments || [];
	const discoveryCandidateId = body.context?.discoveryCandidateId?.trim();
	const topicId = body.context?.topicId?.trim();
	if (!content && attachments.length === 0) {
		res.status(400).json({ error: "content or attachments are required" });
		return;
	}
	if (body.context !== undefined && (!body.context || typeof body.context !== "object"
		|| (body.context.discoveryCandidateId !== undefined && !discoveryCandidateId)
		|| (body.context.topicId !== undefined && !topicId))) {
		res.status(400).json({ error: "Invalid message context" });
		return;
	}

	try {
		if (discoveryCandidateId) {
			const candidate = new GoalTopicPlanStore(req.params.goalId, workspaceDir).readDiscovery(discoveryCandidateId);
			if (candidate.status !== "open") throw new Error("Discovery Candidate is already closed");
		}
		if (topicId) {
			const active = new GoalTopicPlanStore(req.params.goalId, workspaceDir).readActive();
			if (!active?.topics.some((topic) => topic.id === topicId)) throw new Error("Unknown active Topic");
		}
		const result = await goals.startRun(
			req.params.goalId,
			attachments.length > 0
				? {
						role: "user-with-attachments",
						content,
						attachments,
					}
				: content,
			undefined,
			discoveryCandidateId || topicId ? {
				...(discoveryCandidateId ? { discoveryCandidateId } : {}),
				...(topicId ? { topicId } : {}),
			} : undefined,
		);
		res.status(202).json({ ok: true, ...result });
	} catch (error) {
		const message = toErrorMessage(error);
		const status = message.includes("already running") ? 409 : 404;
		res.status(status).json({ error: message });
	}
});

app.post("/api/goals/:goalId/abort", async (req, res) => {
	try {
		await goals.abort(req.params.goalId);
		res.json({ ok: true, state: await goals.getSnapshot(req.params.goalId) });
	} catch (error) {
		const message = toErrorMessage(error);
		res.status(404).json({ error: message });
	}
});

app.use("/api", (_req, res) => {
	res.status(404).json({ error: "API route not found" });
});

// Operations lives on its own loopback Listener. Keep the SPA fallback from making an absent
// Operations endpoint look successful on the product port.
app.use("/operations", (_req, res) => {
	res.status(404).json({ error: "Operations route not found on product listener" });
});

const distDir = [join(rootDir, "dist"), join(rootDir, "web", "dist")].find((candidate) => existsSync(candidate));
if (distDir) {
	app.use(express.static(distDir));
	app.get("*", (_req, res) => {
		res.sendFile(join(distDir, "index.html"));
	});
}

// Operations 先绑定，产品 Listener 与其 WebSocket upgrade handler 之间不留窗口。
if (operations) await operations.runtime.listen();
const httpServer = app.listen(port, host, () => {
	console.log(`Telomi server listening on http://${host}:${port}`);
	if (!evalInstance) researchScheduleScheduler.start();
});
// Source logins and keys are checked once the server is up and once a day after that; a
// research run re-checks before it starts, so this is what the settings page shows in between.
if (!evalInstance) {
	const verifySources = (options?: { settleRetryMs?: number }) => getSourceStatusMonitor().verifyAll(options).catch((error) => {
		console.error(`[telomi] source verification failed: ${toErrorMessage(error)}`);
	});
	// A freshly launched browser host answers with a partial cookie set and then rotates its
	// sessions for a moment; wait for it and allow one late re-check, so the first pass does not
	// report every login as missing.
	void waitForBrowserCookies(browserHostEndpoint().href).then(() => verifySources({ settleRetryMs: BROWSER_SETTLE_RETRY_MS }));
	setInterval(() => void verifySources(), 24 * 60 * 60_000).unref();
}
const browserObservationServer = attachBrowserObservationServer(
	httpServer,
	browserSessions,
	(goalId) => Boolean(goals.getGoal(goalId)),
);
const browserLoginServer = attachBrowserLoginServer(httpServer, {
	cdpUrl: () => browserHostEndpoint().href,
	sourceVerified: (sourceId) => getSourceStatusMonitor().status(sourceId)?.state === "ok",
});
// 报告生产链路只由调用方取消和 Runtime Gate 结束。不要在 HTTP 入口重新添加
// request 或 headers wall-clock timeout，否则慢请求会被截断而后台继续孤儿化执行。
httpServer.requestTimeout = 0;
httpServer.headersTimeout = 0;

startupComplete = true;
function shutdown(signal: NodeJS.Signals): Promise<void> {
	return shutdownPromise ??= performShutdown(signal);
}
async function performShutdown(signal: NodeJS.Signals): Promise<void> {
	console.log(`[telomi] received ${signal}, shutting down`);
	if (!startupComplete) {
		await getResearchSourceServiceManager().close();
		await getHindsightRuntimeManager().close();
		process.exit(0);
	}
	await browserSessions.shutdownAll("shutdown").catch((error) => {
		console.error(`[telomi] failed to release browser sessions: ${toErrorMessage(error)}`);
	});
	codexUsageMonitor.stop();
	researchScheduleScheduler.stop();
	fileIngestService.stop();
	operations?.evolutionLifecycle.stop();
	operations?.evolution.stop();
	operations?.runtime.close();
	browserObservationServer.close();
	browserLoginServer.close();
	httpServer.close();
	await stopEmbeddingMigration().catch((error) => {
		console.error(`[telomi] failed to pause embedding rebuild: ${toErrorMessage(error)}`);
	});
	await audioLocalRuntime.close().catch((error) => {
		console.error(`[telomi] failed to stop local audio runtime: ${toErrorMessage(error)}`);
	});
	await getResearchSourceServiceManager().close().catch((error) => {
		console.error(`[telomi] failed to stop research source service: ${toErrorMessage(error)}`);
	});
	await getHindsightRuntimeManager().close().catch((error) => {
		console.error(`[telomi] failed to stop Hindsight: ${toErrorMessage(error)}`);
	});
	process.exit(0);
}
