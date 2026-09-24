import { existsSync, lstatSync, readdirSync, realpathSync, statSync, promises as fsp } from "fs";
import { basename, extname, join } from "path";
import { ensureWithinRoot, isInsideRoot } from "../lib/paths.js";


export type ProductArtifactSource = "artifacts" | "workspace-report";

export interface ScannedProductArtifact {
	name: string;
	size: number;
	mtimeMs: number;
	source: ProductArtifactSource;
}

const MAX_ARTIFACT_SCAN_DEPTH = 8;

const AUXILIARY_ARTIFACT_BASENAMES = new Set([
	"scratchpad.md",
	"search_manifest.md",
	"wide_research.md",
]);
const INTERNAL_ARTIFACT_PATHS = new Set(["main/topic-plan.json"]);

export function goalRoot(workspaceDir: string, goalId: string): string {
	return join(workspaceDir, goalId);
}

export function artifactsRoot(workspaceDir: string, goalId: string): string {
	return join(goalRoot(workspaceDir, goalId), "artifacts");
}

export function isUserFacingArtifact(name: string, source: ProductArtifactSource = "artifacts"): boolean {
	if (source === "workspace-report") return true;
	return !INTERNAL_ARTIFACT_PATHS.has(normalizeRelPath(name).toLowerCase())
		&& !AUXILIARY_ARTIFACT_BASENAMES.has(basename(name).toLowerCase());
}

function isMarkdown(name: string): boolean {
	const ext = extname(name).toLowerCase();
	return ext === ".md" || ext === ".markdown";
}

function normalizeRelPath(name: string): string {
	return name.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isWorkspaceRunReportPath(name: string): boolean {
	const normalized = normalizeRelPath(name);
	const parts = normalized.split("/");
	return parts.length === 5
		&& parts[0] === "wiki"
		&& parts[1] === "runs"
		&& parts[2].length > 0
		&& parts[3] === "report"
		&& isMarkdown(parts[4]);
}

function ensureSafeArtifactFile(root: string, candidate: string, label: string): string {
	const resolved = ensureWithinRoot(root, candidate, label);
	if (!existsSync(resolved)) return resolved;

	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`The ${label} must be a regular directory.`);
	}
	const targetStat = lstatSync(resolved);
	if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
		throw new Error(`Product Artifact '${candidate}' must be a regular file, not a symbolic link.`);
	}

	const realRoot = realpathSync(root);
	const realTarget = realpathSync(resolved);
	if (!isInsideRoot(realRoot, realTarget, { rejectDotPrefix: true, allowRoot: false })) {
		throw new Error(`Product Artifact '${candidate}' resolves outside the ${label}.`);
	}
	return resolved;
}

export function resolveProductArtifactPath(workspaceDir: string, goalId: string, name: string): string {
	const normalized = normalizeRelPath(name);
	if (isWorkspaceRunReportPath(normalized)) {
		const prefix = "wiki/runs/";
		return ensureSafeArtifactFile(
			join(goalRoot(workspaceDir, goalId), "wiki", "runs"),
			normalized.slice(prefix.length),
			"workspace runs root",
		);
	}
	return ensureSafeArtifactFile(artifactsRoot(workspaceDir, goalId), normalized, "artifacts root");
}

function scanArtifactDir(dir: string, prefix = "", depth = 0): ScannedProductArtifact[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: ScannedProductArtifact[] = [];
	for (const e of entries) {
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		const abs = join(dir, e.name);
		if (e.isDirectory()) {
			if (depth + 1 < MAX_ARTIFACT_SCAN_DEPTH) {
				out.push(...scanArtifactDir(abs, rel, depth + 1));
			}
			continue;
		}
		if (!e.isFile()) continue;
		try {
			const stat = statSync(abs);
			out.push({ name: rel, size: stat.size, mtimeMs: stat.mtimeMs, source: "artifacts" });
		} catch {
			// ignore individual file errors
		}
	}
	return out;
}

async function scanArtifactDirToday(
	dir: string,
	lowerBound: number,
	upperBound: number,
	prefix = "",
	depth = 0,
): Promise<ScannedProductArtifact[]> {
	let entries;
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: ScannedProductArtifact[] = [];
	for (const e of entries) {
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		const abs = join(dir, e.name);
		if (e.isDirectory()) {
			if (depth + 1 < MAX_ARTIFACT_SCAN_DEPTH) {
				out.push(...await scanArtifactDirToday(abs, lowerBound, upperBound, rel, depth + 1));
			}
			continue;
		}
		if (!e.isFile()) continue;
		try {
			const stat = await fsp.stat(abs);
			if (stat.mtimeMs >= lowerBound && stat.mtimeMs < upperBound) {
				out.push({ name: rel, size: stat.size, mtimeMs: stat.mtimeMs, source: "artifacts" });
			}
		} catch {
			// ignore individual file errors
		}
	}
	return out;
}

function scanWorkspaceReports(root: string): ScannedProductArtifact[] {
	const runsRoot = join(root, "wiki", "runs");
	let runs;
	try {
		runs = readdirSync(runsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: ScannedProductArtifact[] = [];
	for (const run of runs) {
		if (!run.isDirectory()) continue;
		const reportDir = join(runsRoot, run.name, "report");
		let reports;
		try {
			reports = readdirSync(reportDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const report of reports) {
			if (!report.isFile() || !isMarkdown(report.name)) continue;
			const abs = join(reportDir, report.name);
			try {
				const stat = statSync(abs);
				out.push({
					name: `wiki/runs/${run.name}/report/${report.name}`,
					size: stat.size,
					mtimeMs: stat.mtimeMs,
					source: "workspace-report",
				});
			} catch {
				// ignore individual file errors
			}
		}
	}
	return out;
}

async function scanWorkspaceReportsToday(
	root: string,
	lowerBound: number,
	upperBound: number,
): Promise<ScannedProductArtifact[]> {
	const runsRoot = join(root, "wiki", "runs");
	let runs;
	try {
		runs = await fsp.readdir(runsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: ScannedProductArtifact[] = [];
	for (const run of runs) {
		if (!run.isDirectory()) continue;
		const reportDir = join(runsRoot, run.name, "report");
		let reports;
		try {
			reports = await fsp.readdir(reportDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const report of reports) {
			if (!report.isFile() || !isMarkdown(report.name)) continue;
			const abs = join(reportDir, report.name);
			try {
				const stat = await fsp.stat(abs);
				if (stat.mtimeMs >= lowerBound && stat.mtimeMs < upperBound) {
					out.push({
						name: `wiki/runs/${run.name}/report/${report.name}`,
						size: stat.size,
						mtimeMs: stat.mtimeMs,
						source: "workspace-report",
					});
				}
			} catch {
				// ignore individual file errors
			}
		}
	}
	return out;
}

export function scanGoalProductArtifacts(workspaceDir: string, goalId: string): ScannedProductArtifact[] {
	const root = goalRoot(workspaceDir, goalId);
	return [
		...scanArtifactDir(artifactsRoot(workspaceDir, goalId)),
		...scanWorkspaceReports(root),
	];
}

export async function scanGoalProductArtifactsToday(
	workspaceDir: string,
	goalId: string,
	lowerBound: number,
	upperBound: number,
): Promise<ScannedProductArtifact[]> {
	const root = goalRoot(workspaceDir, goalId);
	const [artifacts, reports] = await Promise.all([
		scanArtifactDirToday(artifactsRoot(workspaceDir, goalId), lowerBound, upperBound),
		scanWorkspaceReportsToday(root, lowerBound, upperBound),
	]);
	return [...artifacts, ...reports];
}
