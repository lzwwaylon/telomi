/**
 * 正式 Capture 的 Case 保留策略（计划 §9.1）。
 *
 * 只清理正式实例自己 Capture 的 Case：`node-evaluation/cases/<caseId>` 目录，
 * 位于 Capture 拥有的 Run 根下（见 `capturedCaseRunRoots()`）。Candidate Replay
 * Run、导入的 Bundle、Capability Snapshot、Material Cache 和任何产品 Run、
 * 产品 Artifact 都不属于这里，也永远不会被删除 - Case 目录之外的路径根本不会
 * 进入删除集合。
 *
 * 语义固定为：
 * - 超过保留期的 Case 先删；随后按容量上限从最旧开始删，直到回到上限之内。
 * - 未进入终态的 Run 和刚落盘的 Case 一律跳过，产品仍在写的证据不会被移走。
 * - 删除先原子 rename 到 `.trash`，再递归删除；进程在中途退出时，下一次 Sweep
 *   会先清空 `.trash`，因此不会留下半个 Case 目录被当成可回放 Case。
 * - Sweep 对产品完全 fail-open：任何一个 Case 出错只写警告计数，不抛给调用方。
 *
 * Evolution Run 记录按同一保留期压缩：终态且超过保留期、自身 Evolution Case 已被清理的
 * Run 只留下 `current.json`、`request.json` 和 Apply Receipt，它的 Evidence、Round、
 * Replay Evidence 和 Replay 用的 Node Backtest Run 一并删除。留下的记录仍是 Browser
 * Trigger 的游标，所以已消费的执行不会被再次计数。
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { TERMINAL_RUN_STATUSES } from "../research/run-state.js";
import { WIKI_UPDATE_JOB_FILE } from "../wiki/wiki-update-job.js";
import { capturedCaseRunRoots, nodeBacktestRunsDirectory } from "./node-backtest.js";
import { APPLY_RECEIPT_FILE, TERMINAL_RUN_STATUSES as TERMINAL_EVOLUTION_STATUSES, type EvolutionRun } from "../evolution/service.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { caseExporting } from "./case-export-lock.js";
import { toErrorMessage } from "../lib/values.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CASE_RETENTION_DAYS = 30;
export const DEFAULT_CASE_RETENTION_BYTES = 50 * 1024 ** 3;
/** 无状态文件的 Run 类型（Main Agent、Podcast）靠这个静默期避免删到在写的 Case。 */
const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const WARNING_LIMIT = 20;
const TRASH_DIRECTORY = ".trash";

export interface CaseRetentionPolicy {
	/** 保留期。超过即删，与容量无关。 */
	maxAgeMs: number;
	/** 全部正式 Capture Case 的容量上限。超过则从最旧开始删。 */
	maxBytes: number;
	/** 比它更新的 Case 任何情况下都不删。 */
	minAgeMs: number;
}

export interface CaseRetentionReport {
	scanned: number;
	retained: number;
	retainedBytes: number;
	deletedByAge: number;
	deletedBySize: number;
	reclaimedBytes: number;
	/** 属于未进入终态的 Run，跳过。 */
	protectedActive: number;
	/** 落盘时间在静默期内，跳过。 */
	protectedRecent: number;
	/** Bundle export currently reads this Case. */
	protectedExporting: number;
	/** Settled Evolution Runs reduced to their record in this sweep. */
	compactedEvolutionRuns: number;
	dryRun: boolean;
	warnings: string[];
}

export interface CaseRetentionStatus {
	enabled: boolean;
	maxAgeDays: number;
	maxBytes: number;
	lastSweepAt?: string;
	cases: number;
	bytes: number;
	deletedByAge: number;
	deletedBySize: number;
	protectedActive: number;
	protectedExporting: number;
	warnings: string[];
}

export interface CaseRetentionSweeper {
	/** Runs one sweep now, synchronously. Never throws. */
	sweep(): CaseRetentionReport;
	/** Resolves after every scheduled sweep settles. Tests await it; production ignores it. */
	idle(): Promise<void>;
	stop(): void;
}

export function resolveCaseRetentionPolicy(env: NodeJS.ProcessEnv = process.env): CaseRetentionPolicy {
	return {
		maxAgeMs: positive(env.TELOMI_EVAL_CASE_RETENTION_DAYS, DEFAULT_CASE_RETENTION_DAYS) * DAY_MS,
		maxBytes: positive(env.TELOMI_EVAL_CASE_RETENTION_GB, DEFAULT_CASE_RETENTION_BYTES / 1024 ** 3) * 1024 ** 3,
		minAgeMs: DEFAULT_MIN_AGE_MS,
	};
}

/**
 * 未进入终态的 Run。有状态文件的 Run 类型按状态判断；没有状态文件的靠 Case
 * 静默期兜底。读不出来的状态一律当成仍在运行，宁可留着。
 */
export function productionRunActive(runDirectory: string): boolean {
	const research = runStatus(join(runDirectory, "run-state.json"));
	if (research !== undefined && !(TERMINAL_RUN_STATUSES as readonly string[]).includes(research)) return true;
	const wiki = runStatus(join(runDirectory, WIKI_UPDATE_JOB_FILE));
	return wiki !== undefined && !["succeeded", "partial", "failed", "cancelled"].includes(wiki);
}

interface CapturedCase {
	caseId: string;
	caseDirectory: string;
	evaluationDirectory: string;
	capturedAtMs: number;
	bytes: number;
}

export function sweepCapturedCases(options: {
	workspaceDir: string;
	goalIds: readonly string[];
	policy?: Partial<CaseRetentionPolicy>;
	/** Test seam: fixes "now" so age boundaries are exact. */
	now?: number;
	/** Test seam: reports what would be deleted and touches no file. */
	dryRun?: boolean;
	/** Test seam: decides whether a Run may still write to its Cases. */
	isRunActive?: (runDirectory: string) => boolean;
}): CaseRetentionReport {
	const policy = { ...resolveCaseRetentionPolicy(), ...options.policy };
	const now = options.now ?? Date.now();
	const isRunActive = options.isRunActive ?? productionRunActive;
	const report: CaseRetentionReport = {
		scanned: 0, retained: 0, retainedBytes: 0, deletedByAge: 0, deletedBySize: 0, reclaimedBytes: 0,
		protectedActive: 0, protectedRecent: 0, protectedExporting: 0, compactedEvolutionRuns: 0,
		dryRun: options.dryRun === true, warnings: [],
	};
	const sweepable: CapturedCase[] = [];

	for (const goalId of options.goalIds) {
		for (const root of capturedCaseRunRoots(options.workspaceDir, goalId)) {
			for (const runDirectory of subdirectories(root)) {
				const evaluationDirectory = join(runDirectory, "node-evaluation");
				const casesDirectory = join(evaluationDirectory, "cases");
				if (!existsSync(evaluationDirectory)) continue;
				// 先收尾上一次可能被进程退出打断的删除，再决定这一轮删什么。
				purgeTrash(evaluationDirectory, report);
				if (!existsSync(casesDirectory)) continue;
				const active = protectOnError(() => isRunActive(runDirectory), report, runDirectory);
				for (const caseDirectory of subdirectories(casesDirectory)) {
					report.scanned += 1;
					const measured = measureCase(caseDirectory, report);
					if (!measured) continue;
					report.retainedBytes += measured.bytes;
					if (caseExporting(caseDirectory)) {
						report.protectedExporting += 1;
						continue;
					}
					if (active) {
						report.protectedActive += 1;
						continue;
					}
					if (now - measured.capturedAtMs < policy.minAgeMs) {
						report.protectedRecent += 1;
						continue;
					}
					sweepable.push({ ...measured, caseId: basenameOf(caseDirectory), caseDirectory, evaluationDirectory });
				}
			}
		}
	}

	// 最旧优先，同刻按路径定序，因此同一份磁盘状态每次都得到同一个删除集合。
	sweepable.sort((left, right) => left.capturedAtMs - right.capturedAtMs
		|| left.caseDirectory.localeCompare(right.caseDirectory));

	const remaining: CapturedCase[] = [];
	for (const item of sweepable) {
		if (now - item.capturedAtMs > policy.maxAgeMs && removeCase(item, report)) report.deletedByAge += 1;
		else remaining.push(item);
	}
	for (const item of remaining) {
		if (report.retainedBytes <= policy.maxBytes) break;
		if (removeCase(item, report)) report.deletedBySize += 1;
	}
	if (report.retainedBytes > policy.maxBytes) {
		// 保护活跃 Run 和静默期内的 Case 优先于容量上限，因此上限可能到不了。
		// 这属于需要人看的健康状态，不能当成完成。
		warn(report, `size cap not reached: ${report.retainedBytes - policy.maxBytes} bytes above the `
			+ `${policy.maxBytes} byte cap remain in ${report.protectedActive} active and `
			+ `${report.protectedRecent} recent and ${report.protectedExporting} exporting Cases`);
	}
	report.retained = report.scanned - report.deletedByAge - report.deletedBySize;
	for (const goalId of options.goalIds) compactEvolutionRuns(options.workspaceDir, goalId, now - policy.maxAgeMs, report);
	return report;
}

const EVOLUTION_RECORD_ENTRIES = new Set(["current.json", "request.json", APPLY_RECEIPT_FILE, "node-evaluation"]);

function compactEvolutionRuns(workspaceDir: string, goalId: string, cutoffMs: number, report: CaseRetentionReport): void {
	const backtests = nodeBacktestRunsDirectory(workspaceDir, goalId);
	for (const runDirectory of subdirectories(join(serverRuntimeDirForGoal(goalId, workspaceDir), "evolution", "runs"))) {
		try {
			const run = JSON.parse(readFileSync(join(runDirectory, "current.json"), "utf-8")) as EvolutionRun;
			if (!TERMINAL_EVOLUTION_STATUSES.includes(run.status) || !(Date.parse(run.updatedAt) < cutoffMs)) continue;
			// Its own Evolution Case may still be retained or exporting, and it can reference this directory.
			if (subdirectories(join(runDirectory, "node-evaluation", "cases")).length > 0) continue;
			const bulky = readdirSync(runDirectory).filter((name) => !EVOLUTION_RECORD_ENTRIES.has(name));
			const replays = (run.innerLoop?.rounds ?? []).map((round) => round.replayRunId)
				.filter((id) => id && existsSync(join(backtests, id)) && !backtestActive(join(backtests, id)));
			if (bulky.length === 0 && replays.length === 0) continue;
			for (const name of bulky) report.reclaimedBytes += pathBytes(join(runDirectory, name));
			for (const id of replays) report.reclaimedBytes += pathBytes(join(backtests, id));
			report.compactedEvolutionRuns += 1;
			if (report.dryRun) continue;
			for (const name of bulky) rmSync(join(runDirectory, name), { recursive: true, force: true });
			for (const id of replays) rmSync(join(backtests, id), { recursive: true, force: true });
		} catch (error) {
			warn(report, `skipped Evolution Run '${runDirectory}': ${describe(error)}`);
		}
	}
}

function backtestActive(directory: string): boolean {
	const status = runStatus(join(directory, "run.json"));
	return status === "queued" || status === "running" || status === "unreadable";
}

function pathBytes(path: string): number {
	return lstatSync(path).isDirectory() ? directoryBytes(path) : lstatSync(path).size;
}

/**
 * 启动时扫一次，之后按固定间隔重扫。Sweep 完全由磁盘状态推导，没有游标，
 * 因此重启后从当前状态继续，不会重复或漏掉已经删过的 Case。
 *
 * 首次 Sweep 排在启动关键路径之外：递归统计一个 50 GB 的 Case store 是同步 IO，
 * 放在 `listen()` 里会把 Operations Listener 和产品端口的绑定一起拖住。
 */
export function startCaseRetention(options: {
	workspaceDir: string;
	listGoalIds: () => string[];
	policy?: Partial<CaseRetentionPolicy>;
	intervalMs?: number;
}): CaseRetentionSweeper {
	const policy = { ...resolveCaseRetentionPolicy(), ...options.policy };
	status = { ...emptyStatus(), enabled: true, maxAgeDays: policy.maxAgeMs / DAY_MS, maxBytes: policy.maxBytes };
	const sweep = (): CaseRetentionReport => {
		let report: CaseRetentionReport;
		try {
			report = sweepCapturedCases({ workspaceDir: options.workspaceDir, goalIds: options.listGoalIds(), policy });
		} catch (error) {
			// Fail-open：保留策略是后台维护，出错只记录，不影响任何产品路径。
			report = { scanned: 0, retained: 0, retainedBytes: status.bytes, deletedByAge: 0, deletedBySize: 0,
				reclaimedBytes: 0, protectedActive: 0, protectedRecent: 0, protectedExporting: 0,
				compactedEvolutionRuns: 0, dryRun: false,
				warnings: [`case retention sweep failed: ${describe(error)}`] };
		}
		status = {
			...status,
			lastSweepAt: new Date().toISOString(),
			cases: report.retained,
			bytes: report.retainedBytes,
			deletedByAge: status.deletedByAge + report.deletedByAge,
			deletedBySize: status.deletedBySize + report.deletedBySize,
			protectedActive: report.protectedActive,
			protectedExporting: report.protectedExporting,
			warnings: [...status.warnings, ...report.warnings].slice(-WARNING_LIMIT),
		};
		for (const warning of report.warnings) console.warn(`[telomi][case-retention] ${warning}`);
		return report;
	};
	// 串行排队：两次 Sweep 不会重叠，`idle()` 因此能确定性地等到全部结束。
	let pending = Promise.resolve();
	const schedule = (): void => {
		pending = pending.then(() => new Promise<void>((resolve) => setImmediate(() => {
			sweep();
			resolve();
		})));
	};
	schedule();
	const timer = setInterval(schedule, options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
	timer.unref();
	return { sweep, idle: () => pending, stop: () => clearInterval(timer) };
}

let status: CaseRetentionStatus = emptyStatus();

/** Operations Status 的 Capture 健康字段之一；关闭 Capture 时是全零。 */
export function caseRetentionStatus(): CaseRetentionStatus {
	return { ...status, warnings: [...status.warnings] };
}

/** Test seam: drops the accumulated counters and warnings. */
export function resetCaseRetentionForTest(): void {
	status = emptyStatus();
}

function emptyStatus(): CaseRetentionStatus {
	return {
		enabled: false,
		maxAgeDays: DEFAULT_CASE_RETENTION_DAYS,
		maxBytes: DEFAULT_CASE_RETENTION_BYTES,
		cases: 0,
		bytes: 0,
		deletedByAge: 0,
		deletedBySize: 0,
		protectedActive: 0,
		protectedExporting: 0,
		warnings: [],
	};
}

/** `undefined` 表示这个 Run 类型没有状态文件；读不出来的状态当成非终态。 */
function runStatus(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return String((JSON.parse(readFileSync(path, "utf-8")) as { status?: unknown }).status ?? "unknown");
	} catch {
		return "unreadable";
	}
}

function measureCase(caseDirectory: string, report: CaseRetentionReport): { capturedAtMs: number; bytes: number } | undefined {
	try {
		return { capturedAtMs: capturedAtMs(caseDirectory), bytes: directoryBytes(caseDirectory) };
	} catch (error) {
		warn(report, `skipped unreadable Case '${caseDirectory}': ${describe(error)}`);
		return undefined;
	}
}

/**
 * Manifest 是 Capture 的最后一次写入，因此它的 `capturedAt` 就是 Case 的年龄。
 * 还没有 Manifest 的目录说明 Capture 仍在进行或半途崩溃，用目录 mtime 兜底，
 * 静默期和 Run 状态负责保护仍在写的那一个。
 */
function capturedAtMs(caseDirectory: string): number {
	const manifestPath = join(caseDirectory, "manifest.json");
	if (existsSync(manifestPath)) {
		const capturedAt = (JSON.parse(readFileSync(manifestPath, "utf-8")) as { capturedAt?: unknown }).capturedAt;
		const parsed = typeof capturedAt === "string" ? Date.parse(capturedAt) : Number.NaN;
		if (Number.isFinite(parsed)) return parsed;
	}
	return lstatSync(caseDirectory).mtimeMs;
}

/** Symlink 只算自身，不跟随，因此统计和删除都停在 Case 目录里。 */
function directoryBytes(directory: string): number {
	let total = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) total += directoryBytes(path);
		else total += lstatSync(path).size;
	}
	return total;
}

function removeCase(item: CapturedCase, report: CaseRetentionReport): boolean {
	report.retainedBytes -= item.bytes;
	report.reclaimedBytes += item.bytes;
	if (report.dryRun) return true;
	try {
		const trash = join(item.evaluationDirectory, TRASH_DIRECTORY);
		mkdirSync(trash, { recursive: true });
		const staged = join(trash, `${item.caseId}.${randomUUID()}`);
		// rename 让 Case 一步离开索引；之后即使删除被打断，也不会留下半个可读 Case。
		renameSync(item.caseDirectory, staged);
		rmSync(staged, { recursive: true, force: true });
		// 删干净后不留空目录；还有暂存项时 rmdir 失败，下一轮 purge 会收尾。
		try {
			rmdirSync(trash);
		} catch { /* another staged Case is still being removed */ }
		return true;
	} catch (error) {
		report.retainedBytes += item.bytes;
		report.reclaimedBytes -= item.bytes;
		warn(report, `failed to delete Case '${item.caseDirectory}': ${describe(error)}`);
		return false;
	}
}

function purgeTrash(evaluationDirectory: string, report: CaseRetentionReport): void {
	const trash = join(evaluationDirectory, TRASH_DIRECTORY);
	if (!existsSync(trash)) return;
	try {
		rmSync(trash, { recursive: true, force: true });
	} catch (error) {
		warn(report, `failed to purge '${trash}': ${describe(error)}`);
	}
}

function protectOnError(active: () => boolean, report: CaseRetentionReport, runDirectory: string): boolean {
	try {
		return active();
	} catch (error) {
		warn(report, `treating Run '${runDirectory}' as active: ${describe(error)}`);
		return true;
	}
}

function subdirectories(root: string): string[] {
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name))
			.sort();
	} catch {
		return [];
	}
}

function basenameOf(path: string): string {
	return path.split(/[/\\]/u).at(-1)!;
}

function warn(report: CaseRetentionReport, message: string): void {
	if (report.warnings.length < WARNING_LIMIT) report.warnings.push(message);
}

function describe(error: unknown): string {
	return (toErrorMessage(error)).slice(0, 500);
}

function positive(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
