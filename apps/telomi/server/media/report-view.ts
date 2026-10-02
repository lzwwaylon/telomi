import { validateInvestigationResult, validateCanonicalMarkdown } from "../citations/contracts.js";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../lib/values.js";


import { cardIdFromArtifactName, extractMarkdownTitle, publishedPodcastDir } from "./product-artifacts.js";

/** The guest directory where Main Agent and the file browser see published reports. */
export const REPORTS_GUEST_PATH = "/reports";

export interface PublishedReportEntry {
	runId: string;
	title: string;
	/** `<local date> <title>`: what `ls /reports` shows. */
	name: string;
	/** Canonical artifact name; the report card and its Podcast are keyed by it. */
	artifactName: string;
	cardId: string;
	reportFile: string;
	/** Stable publication time, including reports whose Run id is an opaque investigation identity. */
	publishedAt?: string;
	/** The published Podcast transcript, when the report has one. */
	podcastFile?: string;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Published reports, oldest first. An earlier report keeps its name when a later one repeats it. */
export function listPublishedReports(goalDir: string): PublishedReportEntry[] {
	const runsDir = join(goalDir, "wiki", "runs");
	if (!existsSync(runsDir)) return [];
	const taken = new Set<string>();
	return readdirSync(runsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && RUN_ID.test(entry.name))
		.map((entry) => entry.name)
		.flatMap((runId) => {
			const reportFile = join(runsDir, runId, "report", "final.md");
			if (!existsSync(reportFile) || !lstatSync(reportFile).isFile()) return [];
			const metadata = publishedInvestigationReportMetadata(goalDir, runId);
			const publishedAt = metadata?.publishedAt ?? runTimestamp(runId);
			// The report card falls back to the same generic title.
			const title = extractMarkdownTitle(readFileSync(reportFile, "utf-8")) ?? "研究报告";
			const artifactName = `wiki/runs/${runId}/report/final.md`;
			const cardId = cardIdFromArtifactName(artifactName)!;
			const podcastDir = publishedPodcastDir(goalDir, cardId);
			const podcastFile = podcastDir ? join(podcastDir, "transcript.md") : undefined;
			return [{
				runId, title, artifactName, cardId, reportFile, ...(publishedAt ? { publishedAt } : {}),
				...(podcastFile && existsSync(podcastFile) ? { podcastFile } : {}),
			}];
		})
		.sort((left, right) => (left.publishedAt ?? left.runId).localeCompare(right.publishedAt ?? right.runId)
			|| left.runId.localeCompare(right.runId))
		.map((report) => {
			const base = [localDate(report.publishedAt ?? report.runId), readableTitle(report.title) || report.runId].filter(Boolean).join(" ");
			const name = taken.has(base) ? `${base} ${report.runId}` : base;
			taken.add(name);
			return { ...report, name };
		});
}

/** A completed investigation report owns its metadata; it does not claim full Research Run state. */
export function publishedInvestigationReportMetadata(goalDir: string, runId: string): { publishedAt: string; question: string } | undefined {
	const id = /^investigation-([a-f0-9]{24})$/u.exec(runId)?.[1];
	if (!id) return undefined;
	try {
		const root = join(goalDir, "wiki", "runs", runId, "report");
		if (!["final.json", "final.md"].every((file) => lstatSync(join(root, file)).isFile())) return undefined;
		const value: unknown = JSON.parse(readFileSync(join(root, "final.json"), "utf-8"));
		if (!isRecord(value) || typeof value.publishedAt !== "string" || !Number.isFinite(Date.parse(value.publishedAt))
			|| new Date(value.publishedAt).toISOString() !== value.publishedAt || typeof value.markdown !== "string"
			|| value.markdown !== readFileSync(join(root, "final.md"), "utf-8") || !isRecord(value.investigation)
			|| typeof value.investigation.question !== "string" || !value.investigation.question.trim() || !Array.isArray(value.citations)) return undefined;
		validateCanonicalMarkdown(value.markdown);
		const result = validateInvestigationResult(value.investigation, id, value.investigation.question);
		const refs: string[] = [];
		for (const citation of value.citations) {
			if (!isRecord(citation) || !Array.isArray(citation.refs) || !citation.refs.length
				|| citation.refs.some((ref) => typeof ref !== "string")) return undefined;
			refs.push(...citation.refs as string[]);
		}
		if (new Set(refs).size !== refs.length || JSON.stringify(refs.sort()) !== JSON.stringify([...result.citation_refs].sort())) return undefined;
		return { publishedAt: value.publishedAt, question: result.question };
	} catch { return undefined; }
}

/** The report a `/reports/<name>` path points into, whether it names the directory or a file in it. */
export function publishedReportForPath(goalDir: string, path: string): PublishedReportEntry | undefined {
	const name = new RegExp(`^${REPORTS_GUEST_PATH}/([^/]+)(?:/[^/]*)?/?$`, "u").exec(path.trim())?.[1];
	return name ? listPublishedReports(goalDir).find((report) => report.name === name) : undefined;
}

/** Where a published report appears to Main Agent; `/reports` itself when the run has no report. */
export function publishedReportGuestPath(goalDir: string, runId: string): string {
	const report = listPublishedReports(goalDir).find((entry) => entry.runId === runId);
	return report ? `${REPORTS_GUEST_PATH}/${report.name}/report.md` : REPORTS_GUEST_PATH;
}

/**
 * Brings `<goal>/reports` in line with the published reports and Podcasts, so one `ls` shows
 * every report by date and title. The directory is derived: files that no longer have a source
 * are removed, and a copy is rewritten only when its source changed.
 */
export function syncPublishedReportView(goalDir: string): string {
	const root = join(goalDir, "reports");
	mkdirSync(root, { recursive: true });
	if (!lstatSync(root).isDirectory()) throw new Error(`Published report view must be a directory: ${root}`);
	const wanted = new Map<string, string>();
	for (const report of listPublishedReports(goalDir)) {
		wanted.set(join(report.name, "report.md"), report.reportFile);
		if (report.podcastFile) wanted.set(join(report.name, "podcast.md"), report.podcastFile);
	}
	for (const directory of readdirSync(root)) {
		const dir = join(root, directory);
		if (!lstatSync(dir).isDirectory()) {
			rmSync(dir, { force: true });
			continue;
		}
		for (const file of readdirSync(dir)) {
			if (!wanted.has(join(directory, file))) rmSync(join(dir, file), { recursive: true, force: true });
		}
		if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
	}
	for (const [relative, source] of wanted) {
		const target = join(root, relative);
		const from = statSync(source);
		const current = existsSync(target) ? statSync(target) : undefined;
		if (current?.size === from.size && current.mtimeMs === from.mtimeMs) continue;
		mkdirSync(dirname(target), { recursive: true });
		// Synchronous from start to end, so two callers in the server process never interleave here.
		const temporary = `${target}.tmp`;
		copyFileSync(source, temporary);
		utimesSync(temporary, from.atime, from.mtime);
		renameSync(temporary, target);
	}
	return root;
}

function runTimestamp(runId: string): string | undefined {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?Z/u.exec(runId);
	if (!match) return undefined;
	const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[5] ?? ""}Z`);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Timestamp Run ids and investigation publication metadata use the same user-local report date. */
function localDate(value: string): string {
	if (!/^\d{4}-\d{2}-\d{2}T/u.test(value)) return "";
	const date = new Date(runTimestamp(value) ?? value);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function readableTitle(title: string): string {
	return title.replace(/[\u0000-\u001f\u007f/\\]+/gu, " ").replace(/\s+/gu, " ").trim().replace(/^\.+/u, "").slice(0, 80).trim();
}
