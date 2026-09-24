/**
 * Case Capture 的组合缝。
 *
 * 依赖方向固定为 `CaseCapture -> 产品执行结果`：正常 Research、Wiki、Podcast 和
 * Main Agent 只调用这里的可选 Hook，不 import Evaluation 实现。组合根
 * `server/evaluation/operations-runtime.ts` 按实例角色决定安装哪些 Hook：Capture 与
 * Eval Instance 安装全部节点，默认角色只安装 Evolution 消费的 Prime Search。每个 Hook
 * 各自可缺省；缺省的节点（以及没有组合 Evaluation 的进程，例如单元测试）走原本的
 * 产品路径，不写 Case。
 *
 * Hook 的签名用 `typeof` 绑定到真实实现，只做 type-only import，运行时不加载
 * Evaluation 代码，也不需要在这里重复声明一遍参数类型。
 */
import type { withResearchNodeEvaluationCapture, withCornellNoteCapture } from "../agent-runtime/recorded-stage-replay.js";
import type { withPrimeSearchNodeEvaluationCapture } from "../evaluation/prime-search-replay.js";
import type { runWikiCuratorNodeEvaluation, runWikiShardNodeEvaluation } from "../evaluation/wiki-replay.js";
import type { runPodcastWriterNodeEvaluation } from "../evaluation/podcast-replay.js";
import type { runScheduleReviewNodeEvaluation } from "../evaluation/schedule-review-replay.js";
import type { captureMainAgentNodeEvaluation } from "../evaluation/main-agent-evaluation.js";
import { toErrorMessage } from "../lib/values.js";

export interface CaseCaptureHooks {
	researchStages: typeof withResearchNodeEvaluationCapture;
	cornellNote: typeof withCornellNoteCapture;
	primeSearchBatch: typeof withPrimeSearchNodeEvaluationCapture;
	wikiShard: typeof runWikiShardNodeEvaluation;
	wikiCurator: typeof runWikiCuratorNodeEvaluation;
	podcastWriter: typeof runPodcastWriterNodeEvaluation;
	scheduleReviewer: typeof runScheduleReviewNodeEvaluation;
	mainAgent: typeof captureMainAgentNodeEvaluation;
}

export interface CaseCaptureFailure {
	node: string;
	reason: string;
	at: string;
}

export interface CaseCaptureHealth {
	enabled: boolean;
	failures: number;
	/** Most recent failures, newest last. Bounded so a broken disk cannot grow the process. */
	recent: CaseCaptureFailure[];
}

const RECENT_FAILURE_LIMIT = 20;

let installed: Partial<CaseCaptureHooks> | undefined;
let researchRunSettled: ResearchRunSettledHook | undefined;
let failures = 0;
const recent: CaseCaptureFailure[] = [];

/**
 * Notified once per Research Run, after its terminal state is durably on disk and every
 * node of that Run has finished capturing its Case. Evolution uses it to count settled
 * Provider executions; the product path only announces and never learns the consumer.
 */
export type ResearchRunSettledHook = (goalId: string, runId: string) => void;

/** Composition root only. Product modules must not call this. */
export function installCaseCapture(hooks: Partial<CaseCaptureHooks>): () => void {
	installed = hooks;
	return () => {
		if (installed === hooks) installed = undefined;
	};
}

/** Composition root only. Absent only where Evaluation is not composed, so no Run lifecycle listener exists. */
export function installResearchRunSettled(hook: ResearchRunSettledHook): () => void {
	researchRunSettled = hook;
	return () => {
		if (researchRunSettled === hook) researchRunSettled = undefined;
	};
}

/**
 * Fail-open: the Run already reached its terminal state on disk, so a listener error
 * only records Capture health and never changes the user-visible result.
 */
export function notifyResearchRunSettled(goalId: string, runId: string): void {
	if (!researchRunSettled) return;
	try {
		researchRunSettled(goalId, runId);
	} catch (error) {
		recordCaseCaptureFailure("research-run-settled", error);
	}
}

/** A missing hook means the caller runs its plain product path and writes no Case for that node. */
export function caseCapture(): Partial<CaseCaptureHooks> | undefined {
	return installed;
}

/**
 * 正式 Capture 的 fail-open 记录点。产品结果已经成功，Capture 失败只写结构化
 * 警告和 Operations Status，不改变用户可见结果。
 */
export function recordCaseCaptureFailure(node: string, reason: unknown): void {
	failures += 1;
	const failure: CaseCaptureFailure = {
		node,
		reason: (toErrorMessage(reason)).slice(0, 2_000),
		at: new Date().toISOString(),
	};
	recent.push(failure);
	if (recent.length > RECENT_FAILURE_LIMIT) recent.shift();
	console.warn(`[telomi][case-capture] ${node} capture failed (product result unaffected): ${failure.reason}`);
}

export function caseCaptureHealth(): CaseCaptureHealth {
	return { enabled: installed !== undefined, failures, recent: [...recent] };
}

/** Test seam: drops the installed hooks and the failure history. */
export function resetCaseCaptureForTest(): void {
	installed = undefined;
	researchRunSettled = undefined;
	failures = 0;
	recent.length = 0;
}
