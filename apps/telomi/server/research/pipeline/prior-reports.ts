import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { StageInputView } from "./input-view.js";

/** One earlier published Canonical Report of the same Goal, exposed to the Report Writer as read-only context. */
export interface PriorReport {
	runId: string;
	publishedOn: string;
	title: string;
	question: string;
	fileName: string;
	absolutePath: string;
}

export const PRIOR_REPORTS_DIRECTORY = "prior-reports";

/**
 * Newest first. Only Runs whose control state says `published` and whose `report/final.md`
 * exists count; skipped, failed or in-flight Runs never appear.
 */
export function listPriorReports(input: {
	goalWorkspaceDirectory: string;
	controlRunsRoot: string;
	currentRunId: string;
}): PriorReport[] {
	const runsRoot = join(input.goalWorkspaceDirectory, "wiki", "runs");
	if (!existsSync(runsRoot)) return [];
	const reports: PriorReport[] = [];
	const usedNames = new Set<string>();
	for (const entry of readdirSync(runsRoot, { withFileTypes: true })
		.filter((item) => item.isDirectory() && item.name !== input.currentRunId)
		.sort((left, right) => right.name.localeCompare(left.name))) {
		const statePath = join(input.controlRunsRoot, entry.name, "run-state.json");
		const reportPath = join(runsRoot, entry.name, "report", "final.md");
		if (!existsSync(statePath) || !existsSync(reportPath)) continue;
		const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
			status?: unknown; question?: unknown; started_at?: unknown; finished_at?: unknown;
		};
		if (state.status !== "published") continue;
		const markdown = readFileSync(reportPath, "utf-8");
		const question = typeof state.question === "string" ? firstLine(state.question) : "";
		const title = markdown.match(/^#\s+(.+?)\s*$/mu)?.[1] ?? (question || entry.name);
		const publishedOn = String(state.finished_at ?? state.started_at ?? entry.name).slice(0, 10);
		const fileName = uniqueFileName(`${publishedOn}-${slug(title)}`, usedNames);
		reports.push({ runId: entry.name, publishedOn, title, question, fileName, absolutePath: reportPath });
	}
	return reports;
}

/** Copies the reports into the Writer input view and returns the index the prompt carries. Empty string when none exist. */
export function stagePriorReports(view: StageInputView, reports: readonly PriorReport[]): string {
	if (reports.length === 0) return "";
	for (const report of reports) view.copyFile(`${PRIOR_REPORTS_DIRECTORY}/${report.fileName}`, report.absolutePath);
	const index = renderPriorReportsIndex(reports);
	view.writeText(`${PRIOR_REPORTS_DIRECTORY}/index.md`, index);
	return index;
}

export function renderPriorReportsIndex(reports: readonly PriorReport[]): string {
	return [
		"| Published | Title | Research question | File |",
		"|---|---|---|---|",
		...reports.map((report) =>
			`| ${report.publishedOn} | ${cell(report.title)} | ${cell(report.question)} | ${PRIOR_REPORTS_DIRECTORY}/${report.fileName} |`),
		"",
	].join("\n");
}

function firstLine(value: string): string {
	return value.trim().split("\n")[0]!.trim();
}

function cell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll(/\s+/gu, " ").trim().slice(0, 160) || "-";
}

function slug(title: string): string {
	return title.replaceAll(/[\\/:*?"<>|\p{Cc}]+/gu, " ").replaceAll(/\s+/gu, "-").replaceAll(/^-+|-+$/gu, "").slice(0, 80) || "report";
}

function uniqueFileName(base: string, used: Set<string>): string {
	let name = `${base}.md`;
	for (let suffix = 2; used.has(name); suffix += 1) name = `${base}-${suffix}.md`;
	used.add(name);
	return name;
}
