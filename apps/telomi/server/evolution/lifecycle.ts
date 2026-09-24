/**
 * Evolution lifecycle wiring.
 *
 * Installed by the Evaluation composition root, which every product instance runs, so both the
 * Capture and the Eval Instance role have this listener. Evolution needs captured Cases; a process
 * that does not compose Evaluation has no listener and counts nothing.
 */
import { installResearchRunSettled } from "../observability/case-capture.js";
import type { NodeBacktestService } from "../evaluation/node-backtest.js";
import type { EvolutionService } from "./service.js";
import { BrowserEvolutionTrigger } from "./browser-trigger.js";
import { BROWSER_EVOLUTION_TARGET_ID } from "./targets.js";
import { toErrorMessage } from "../lib/values.js";

export interface BrowserEvolutionLifecycle {
	/** Resolves after every scheduled sweep settles. Tests await it; production ignores it. */
	idle(): Promise<void>;
	stop(): void;
}

export function installBrowserEvolutionTrigger(options: {
	workspaceDir: string;
	nodeBacktests: Pick<NodeBacktestService, "listCases" | "listCaseFilePaths">;
	evolution: Pick<EvolutionService, "list" | "start" | "onSettled">;
	listGoalIds: () => string[];
}): BrowserEvolutionLifecycle {
	const trigger = new BrowserEvolutionTrigger(options);
	let pending = Promise.resolve();

	// Off the Run's critical path: the product result is already durable, and one Goal scan
	// must never delay the final state write.
	const sweep = (goalIds: () => string[]) => {
		pending = pending.then(() => new Promise<void>((resolve) => setImmediate(() => {
			for (const goalId of goalIds()) {
				try {
					trigger.observe(goalId);
				} catch (error) {
					console.warn(`[telomi][evolution] Browser trigger skipped goal '${goalId}': `
						+ (toErrorMessage(error)));
				}
			}
			resolve();
		})));
	};

	const stopResearchListener = installResearchRunSettled((goalId) => sweep(() => [goalId]));
	const stopEvolutionListener = options.evolution.onSettled((run) => {
		if (run.targetId === BROWSER_EVOLUTION_TARGET_ID) sweep(() => [run.goalId]);
	});
	// A crash between a settled Run and its sweep would otherwise strand a full batch, so
	// startup re-derives every Goal from the same on-disk cursor.
	sweep(options.listGoalIds);
	return {
		idle: () => pending,
		stop: () => {
			stopResearchListener();
			stopEvolutionListener();
		},
	};
}
