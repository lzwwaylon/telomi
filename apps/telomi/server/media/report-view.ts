import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
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
		.sort()
		.flatMap((runId) => {
			const reportFile = join(runsDir, runId, "report", "final.md");
			if (!existsSync(reportFile) || !lstatSync(reportFile).isFile()) return [];
			// The report card falls back to the same generic title.
			const title = extractMarkdownTitle(readFileSync(reportFile, "utf-8")) ?? "研究报告";
			const base = [localDate(runId), readableTitle(title) || runId].filter(Boolean).join(" ");
			const name = taken.has(base) ? `${base} ${runId}` : base;
			taken.add(name);
			const artifactName = `wiki/runs/${runId}/report/final.md`;
			const cardId = cardIdFromArtifactName(artifactName)!;
			const podcastDir = publishedPodcastDir(goalDir, cardId);
			const podcastFile = podcastDir ? join(podcastDir, "transcript.md") : undefined;
			return [{
				runId, title, name, artifactName, cardId, reportFile,
				...(podcastFile && existsSync(podcastFile) ? { podcastFile } : {}),
			}];
		});
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

/** Run ids are UTC timestamps (`2026-09-25T04-31-51.639Z`); the name uses the user's local date. */
function localDate(runId: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?Z/u.exec(runId);
	if (!match) return "";
	const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[5] ?? ""}Z`);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function readableTitle(title: string): string {
	return title.replace(/[\u0000-\u001f\u007f/\\]+/gu, " ").replace(/\s+/gu, " ").trim().replace(/^\.+/u, "").slice(0, 80).trim();
}
