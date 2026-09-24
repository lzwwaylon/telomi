/**
 * Evaluation 组合根。每个产品实例启动时都被 `server/app.ts` 动态 import，因此
 * Replay Recipe 和 NodeBacktestService 在所有实例上都存在，Evolution 依赖它们。
 * 实例角色决定安装哪些 Case Capture Hook、是否绑定 Operations Listener 及其写权限、
 * Bundle Exchange Root 和 Case 保留策略：
 *
 * - off（默认）：只捕获 Evolution 消费的 Prime Search Case，不绑定 Listener。
 * - capture：全部节点 Capture，只读 Listener。
 * - eval：全部节点 Capture，完整 Replay Listener，不跑保留策略。
 *
 * Operations HTTP 使用独立 Express app 和独立 Listener，固定绑定 127.0.0.1，
 * 不读取 TELOMI_HOST，也不会被产品反向代理转发。
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { OPERATIONS_HOST, type OperationsMode } from "../config/network.js";
import { installCaseCapture } from "../observability/case-capture.js";
import type { GoalService } from "../goals/service.js";
import { createOperationsRouter } from "./api.js";
import { ensureOperationsExchangeRoot, resolveOperationsExchangeRoot } from "./exchange-root.js";
import { startCaseRetention, type CaseRetentionSweeper } from "./case-retention.js";
import { NodeBacktestService } from "./node-backtest.js";
import { createMainAgentReplayRecipe } from "./main-agent-replay.js";
import { evolutionReplayRecipe } from "./evolution-replay.js";
import { liveProviderChildReplayRecipe } from "./provider-child-replay.js";
import { livePrimeSearchReplayRecipe } from "./prime-search-replay.js";
import { podcastWriterReplayRecipe } from "./podcast-replay.js";
import { scheduleReviewerReplayRecipe, runScheduleReviewNodeEvaluation } from "./schedule-review-replay.js";
import { wikiCuratorReplayRecipe, wikiShardReplayRecipe } from "./wiki-replay.js";
import {
	recordedStageReplayRecipes,
	withResearchNodeEvaluationCapture,
	withCornellNoteCapture,
} from "../agent-runtime/recorded-stage-replay.js";
import { withPrimeSearchNodeEvaluationCapture } from "./prime-search-replay.js";
import { runWikiCuratorNodeEvaluation, runWikiShardNodeEvaluation } from "./wiki-replay.js";
import { runPodcastWriterNodeEvaluation } from "./podcast-replay.js";
import { captureMainAgentNodeEvaluation } from "./main-agent-evaluation.js";
import { OPERATIONS_PROTOCOL_VERSION, OPERATIONS_SCHEMA_HASH } from "./operations-contract.js";
import { producesBrowserEvolutionEvidence } from "../evolution/targets.js";

export interface OperationsRuntime {
	readonly mode: OperationsMode;
	readonly nodeBacktests: NodeBacktestService;
	/** Only directory a Bundle tar may be imported from. */
	readonly exchangeRoot: string;
	/** Bound address; undefined before `start()` resolves and always in the default role. */
	address(): AddressInfo | undefined;
	/** Starts the Replay queue and Case retention, and binds the loopback Listener outside the default role. */
	start(): Promise<void>;
	close(): void;
}

export function createOperationsRuntime(options: {
	mode: OperationsMode;
	port: number;
	workspaceDir: string;
	goals: Pick<GoalService, "listGoals" | "getGoal" | "ensureImportedGoal">;
}): OperationsRuntime {
	// 产品节点通过 server/observability/case-capture.ts 找到这些 Hook；缺省的节点不写 Case。
	const uninstallCaseCapture = installCaseCapture(options.mode === "off" ? {
		primeSearchBatch: (executor, captureOptions) => withPrimeSearchNodeEvaluationCapture(executor, {
			...captureOptions,
			keep: producesBrowserEvolutionEvidence,
		}),
	} : {
		researchStages: withResearchNodeEvaluationCapture,
		cornellNote: withCornellNoteCapture,
		primeSearchBatch: withPrimeSearchNodeEvaluationCapture,
		wikiShard: runWikiShardNodeEvaluation,
		wikiCurator: runWikiCuratorNodeEvaluation,
		podcastWriter: runPodcastWriterNodeEvaluation,
		scheduleReviewer: runScheduleReviewNodeEvaluation,
		mainAgent: captureMainAgentNodeEvaluation,
	});

	const nodeBacktests = new NodeBacktestService({
		workspaceDir: options.workspaceDir,
		listGoalIds: () => options.goals.listGoals().map((goal) => goal.id),
		recipes: [
			createMainAgentReplayRecipe(),
			livePrimeSearchReplayRecipe,
			liveProviderChildReplayRecipe,
			podcastWriterReplayRecipe,
			scheduleReviewerReplayRecipe,
			wikiShardReplayRecipe,
			wikiCuratorReplayRecipe,
			evolutionReplayRecipe,
			...recordedStageReplayRecipes,
		],
	});

	// Import 只存在于 Eval 模式，但 Root 在两种模式下都固定下来，Status 和日志因此
	// 永远指向同一个位置。
	const exchangeRoot = resolveOperationsExchangeRoot(options.workspaceDir);
	if (options.mode === "eval") ensureOperationsExchangeRoot(exchangeRoot);

	let server: Server | undefined;
	let retention: CaseRetentionSweeper | undefined;
	return {
		mode: options.mode,
		nodeBacktests,
		exchangeRoot,
		address: () => {
			const bound = server?.address();
			return bound && typeof bound === "object" ? bound : undefined;
		},
		start: () => new Promise<void>((resolve, reject) => {
			nodeBacktests.start();
			// 保留策略属于产品实例。Candidate 实例可能挂着同一个 workspace，
			// 它绝不能删除正式 Capture 的 Case。
			if (options.mode !== "eval") {
				retention = startCaseRetention({
					workspaceDir: options.workspaceDir,
					listGoalIds: () => options.goals.listGoals().map((goal) => goal.id),
				});
			}
			const mode = options.mode;
			if (mode === "off") {
				resolve();
				return;
			}
			const app = express();
			app.use(express.json({ limit: "50mb" }));
			app.use(createOperationsRouter(options.goals, nodeBacktests, mode, exchangeRoot));
			app.use((_req, res) => void res.status(404).json({ error: "Operations route not found" }));
			server = app.listen(options.port, OPERATIONS_HOST, () => {
				const bound = server?.address();
				console.log(
					`[telomi][operations] ${options.mode} listener on `
					+ `http://${OPERATIONS_HOST}:${bound && typeof bound === "object" ? bound.port : options.port}/operations/v1`
					+ ` protocolVersion=${OPERATIONS_PROTOCOL_VERSION} schemaHash=${OPERATIONS_SCHEMA_HASH.slice(0, 12)}`,
				);
				resolve();
			});
			// Replay 和 Bundle Export 都可能长时间运行，和产品端口一样不设 wall-clock 上限。
			server.requestTimeout = 0;
			server.headersTimeout = 0;
			server.once("error", reject);
		}),
		close: () => {
			retention?.stop();
			nodeBacktests.stop();
			server?.close();
			uninstallCaseCapture();
		},
	};
}
