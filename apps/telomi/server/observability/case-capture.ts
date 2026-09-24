/**
 * Case Capture 的组合缝。
 *
 * 依赖方向固定为 `CaseCapture -> 产品执行结果`：正常 Research、Wiki、Podcast 和
 * Main Agent 只调用这里的可选 Hook，不 import Evaluation 实现。Capture 与 Eval Instance
 * 两种角色都由组合根 `server/evaluation/operations-runtime.ts` 安装真实实现，因此产品
 * 实例始终写 Evaluation Case。只有没有组合 Evaluation 的进程（例如单元测试）没有 Hook，
 * 那时调用方走原本的产品路径。
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

let installed: CaseCaptureHooks | undefined;
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
export function installCaseCapture(hooks: CaseCaptureHooks): () => void {
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

/** `undefined` where Evaluation is not composed: the caller runs its plain product path and writes no Case. */
export function caseCapture(): CaseCaptureHooks | undefined {
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
