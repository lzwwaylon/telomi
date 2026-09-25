import type { ResolvedOutputLanguage } from "../../../shared/languages.js";

/** Runtime-written chat replies use the language of the report they announce. */
export function reportPublishedResponse(language: ResolvedOutputLanguage): string {
	return language === "zh-CN"
		? "报告已生成，可以通过报告卡片查看。"
		: "The report is ready. Open it from the report card.";
}

/** The reply for a Scheduled Research occurrence that found nothing worth a report. */
export function researchSkippedResponse(language: ResolvedOutputLanguage): string {
	return language === "zh-CN"
		? "本次调研没有发现值得发布的新证据，未生成报告。"
		: "This research found no new evidence worth publishing, so no report was generated.";
}

export function scheduleCreatedResponse(language: ResolvedOutputLanguage, title: string): string {
	return language === "zh-CN" ? `定时调研已创建：${title}` : `Scheduled research created: ${title}`;
}

/** Where the published report lives, carried on the reply the user reads; the chat report card renders from it. */
export interface ReportReference {
	runId: string;
	title: string;
}

export function reportReference(
	runId: string | undefined,
	stableFinalReportPath: unknown,
	title: unknown,
): ReportReference | undefined {
	const id = runId?.trim();
	const path = typeof stableFinalReportPath === "string" ? stableFinalReportPath.trim() : "";
	if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || path !== `/workspace/wiki/runs/${id}/report/final.md`) {
		return undefined;
	}
	return {
		runId: id,
		title: typeof title === "string" && title.trim() ? title.trim() : "研究报告",
	};
}

export function reportTitle(markdown: string, fallbackTitle?: string): string {
	return /^#\s+(.+)$/mu.exec(markdown)?.[1]?.trim() || fallbackTitle?.trim() || "研究报告";
}

/** The receipt the Main Agent keeps in its session; `reportPath` is where the report appears under `/reports`. */
export function reportReceiptText(title: string, reportPath: string, warning?: string): string {
	return [
		"Report published.",
		`Title: ${title}`,
		`Report: ${reportPath} (read it only when the user asks about its contents)`,
		warning ? `Warning: ${warning}` : "",
	].filter(Boolean).join("\n");
}
