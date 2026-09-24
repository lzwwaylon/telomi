import { readFileSync } from "node:fs";

import { ReportRunService } from "./service.js";
import type { RunStateV2 } from "../run-state.js";
import type { ResolvedOutputLanguage } from "../../../shared/languages.js";

export interface ReportOnlyResult {
	runId: string;
	reportRef: string;
	reportPath: string;
	content: string;
	usage: RunStateV2["usage"];
}

export class ReportOnlyRuntime {
	private readonly runs: ReportRunService;

	constructor(workspaceDir: string) {
		this.runs = new ReportRunService(workspaceDir);
	}

	async generate(goalId: string, request: { reportContext: string; title?: string; outputLanguage?: ResolvedOutputLanguage }, signal?: AbortSignal): Promise<ReportOnlyResult> {
		const queued = this.runs.enqueueLatest(goalId, {
			reportContext: request.reportContext,
			...(request.title ? { reportTitle: request.title } : {}),
			...(request.outputLanguage ? { outputLanguage: request.outputLanguage } : {}),
		}, signal);
		const completed = await this.runs.wait(goalId, queued.id);
		if (completed.status !== "completed" || !completed.result) {
			throw new Error(completed.error || "Report-only Run failed without an error message");
		}
		const reportPath = this.runs.file(goalId, completed.id, completed.result.reportRef);
		return {
			runId: completed.id,
			reportRef: completed.result.reportRef,
			reportPath,
			content: readFileSync(reportPath, "utf-8").trim(),
			usage: completed.result.usage,
		};
	}
}
