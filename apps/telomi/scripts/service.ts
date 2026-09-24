// `npm run service`: keep this installation running under launchd (macOS), optionally upgrading it
// when idle and snapshotting it daily. Jobs are LaunchAgents of the signed-in user, labelled after the
// checkout (`serviceLabel`), so several checkouts never share one. `npm run upgrade` finds the
// server job and stops and starts Telomi through it. See docs/upgrading.md.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applicationRoot } from "../server/config/data-dir.js";
import { stopManagedBrowser, stopMemoryDatabase } from "../server/config/data-layout.js";
import { managedBrowserPaths } from "./chrome-debug.js";
import { installation, launchAgentPath, serviceLabel, UpgradeError, type Installation } from "./upgrade.js";

export const JOBS = ["server", "auto-upgrade", "snapshot"] as const;
export type Job = typeof JOBS[number];

/** How often the auto-upgrade job asks whether there is a new version and Telomi is idle. */
export const AUTO_UPGRADE_INTERVAL_S = 15 * 60;
/** Local time of the daily snapshot; launchd runs a missed one after the Mac wakes. */
export const SNAPSHOT_TIME = { Hour: 4, Minute: 30 } as const;

export interface InstallOptions {
	node: string;
	/** `""` follows the latest Release; a ref follows that branch, tag or commit. */
	autoUpgrade?: string;
	dailySnapshot: boolean;
}

export type Command =
	| { action: "install"; options: InstallOptions }
	| { action: "uninstall" | "start" | "stop" | "restart" | "status" };

const USAGE = "Usage: npm run service -- install [--node <path>] [--auto-upgrade[=<ref>]] [--daily-snapshot] | uninstall | start | stop | restart | status";

export function parseCommand(argv: string[], defaultNode = process.execPath): Command {
	const [action, ...rest] = argv;
	if (action === "install") {
		const options: InstallOptions = { node: defaultNode, dailySnapshot: false };
		for (let index = 0; index < rest.length; index++) {
			const arg = rest[index]!;
			if (arg === "--node") options.node = rest[++index] ?? "";
			else if (arg.startsWith("--node=")) options.node = arg.slice("--node=".length);
			else if (arg === "--auto-upgrade") options.autoUpgrade = "";
			else if (arg.startsWith("--auto-upgrade=")) options.autoUpgrade = arg.slice("--auto-upgrade=".length);
			else if (arg === "--daily-snapshot") options.dailySnapshot = true;
			else throw new UpgradeError(`Unknown argument ${arg}. ${USAGE}`);
		}
		if (!options.node) throw new UpgradeError("--node needs a path");
		return { action, options };
	}
	if (action && ["uninstall", "start", "stop", "restart", "status"].includes(action) && rest.length === 0) {
		return { action: action as Exclude<Command["action"], "install"> };
	}
	throw new UpgradeError(USAGE);
}

/** A launchd job as the object `plutil` turns into a property list. */
export type JobDefinition = Record<string, unknown> & { Label: string };

function logPath(label: string, home: string): string {
	return join(home, "Library", "Logs", "Telomi", `${label}.log`);
}

/**
 * The jobs to install. Every job runs `node` itself, not a shell or npm: macOS attributes a job's
 * file access (including its children, such as PostgreSQL) to the program launchd starts, so that is
 * the binary a privacy grant for an external volume must name.
 */
export function jobDefinitions(install: Pick<Installation, "repoRoot">, options: InstallOptions, env: { PATH?: string; HOME?: string } = process.env): JobDefinition[] {
	const home = env.HOME || homedir();
	const base = serviceLabel(install.repoRoot);
	const appRoot = join(install.repoRoot, "apps", "telomi");
	// npm and the tools setup installs come from the chosen Node first; the installing shell's PATH
	// provides git, uv and the rest. The repository's own node_modules/.bin must not leak in.
	const path = [dirname(options.node), ...(env.PATH ?? "").split(delimiter).filter((entry) => entry && !entry.includes("node_modules"))];
	const common = (job: Job) => ({
		Label: `${base}.${job}`,
		// TELOMI_OUTPUT_LOG lets the job's own process keep the log bounded (server/config/output-log.ts).
		EnvironmentVariables: { PATH: [...new Set(path)].join(delimiter), TELOMI_OUTPUT_LOG: logPath(`${base}.${job}`, home) },
		StandardOutPath: logPath(`${base}.${job}`, home),
		StandardErrorPath: logPath(`${base}.${job}`, home),
	});
	const upgrade = (...args: string[]) => [options.node, "--import", "tsx", join(appRoot, "scripts", "upgrade.ts"), ...args];
	const jobs: JobDefinition[] = [{
		...common("server"),
		ProgramArguments: [options.node, "--import", "tsx", "server/index.ts"],
		WorkingDirectory: appRoot,
		RunAtLoad: true,
		KeepAlive: true,
	}];
	if (options.autoUpgrade !== undefined) {
		jobs.push({
			...common("auto-upgrade"),
			// A followed branch moves on every merge; only commits whose checks passed are installed.
			ProgramArguments: upgrade("--if-idle", ...(options.autoUpgrade ? ["--ref", options.autoUpgrade, "--require-checks"] : [])),
			WorkingDirectory: install.repoRoot,
			StartInterval: AUTO_UPGRADE_INTERVAL_S,
		});
	}
	if (options.dailySnapshot) {
		jobs.push({
			...common("snapshot"),
			ProgramArguments: upgrade("--snapshot-only", "--if-idle"),
			WorkingDirectory: install.repoRoot,
			StartCalendarInterval: SNAPSHOT_TIME,
		});
	}
	return jobs;
}

/** Whether `codesign` output describes a stable identity; ad-hoc and unsigned binaries lose privacy grants when replaced. */
export function signedByDeveloper(codesignOutput: string): boolean {
	return /^TeamIdentifier=(?!not set)\S+/mu.test(codesignOutput) && !/Signature=adhoc/u.test(codesignOutput);
}

function onExternalVolume(path: string): boolean {
	return realpathSync(path).startsWith("/Volumes/");
}

const uid = () => process.getuid?.() ?? 0;
const target = (label: string) => `gui/${uid()}/${label}`;

function launchctl(...args: string[]): { ok: boolean; output: string } {
	const result = spawnSync("launchctl", args, { encoding: "utf8" });
	return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

function labels(install: Installation): Record<Job, string> {
	const base = serviceLabel(install.repoRoot);
	return Object.fromEntries(JOBS.map((job) => [job, `${base}.${job}`])) as Record<Job, string>;
}

function installedJobs(install: Installation): Job[] {
	const all = labels(install);
	return JOBS.filter((job) => existsSync(launchAgentPath(all[job])));
}

function bootstrap(label: string): void {
	launchctl("enable", target(label));
	const loaded = launchctl("bootstrap", `gui/${uid()}`, launchAgentPath(label));
	if (!loaded.ok && !launchctl("print", target(label)).ok) throw new UpgradeError(`launchctl bootstrap ${label} failed: ${loaded.output}`);
}

function checkNode(node: string): string {
	if (!existsSync(node)) throw new UpgradeError(`${node} does not exist`);
	const version = spawnSync(node, ["-v"], { encoding: "utf8" }).stdout?.trim() ?? "";
	if (!/^v24\./u.test(version)) throw new UpgradeError(`${node} is ${version || "not a working Node"}; Telomi needs Node 24`);
	return version;
}

/** The managed browser and the memory database can outlive the server; stopping Telomi stops them too. */
async function stopRuntime(inst: Installation): Promise<void> {
	await stopManagedBrowser(managedBrowserPaths(inst.dataDir));
	stopMemoryDatabase(inst.env);
}

async function install(inst: Installation, options: InstallOptions): Promise<void> {
	if (process.platform !== "darwin") throw new UpgradeError("npm run service supports macOS (launchd) only");
	const node = resolve(options.node);
	const version = checkNode(node);
	await uninstall(inst, { quiet: true });
	const jobs = jobDefinitions(inst, { ...options, node });
	for (const job of jobs) {
		mkdirSync(dirname(String(job.StandardOutPath)), { recursive: true });
		const plist = launchAgentPath(job.Label);
		mkdirSync(dirname(plist), { recursive: true });
		const converted = spawnSync("plutil", ["-convert", "xml1", "-o", plist, "-"], { input: JSON.stringify(job), encoding: "utf8" });
		if (converted.status !== 0) throw new UpgradeError(`plutil could not write ${plist}: ${converted.stderr.trim()}`);
		bootstrap(job.Label);
		console.log(`[service] installed ${job.Label}`);
	}
	console.log(`[service] node ${version} at ${node}; logs in ${dirname(String(jobs[0]!.StandardOutPath))}`);
	if ([inst.repoRoot, inst.dataDir].some(onExternalVolume)) {
		const real = realpathSync(node);
		const codesign = spawnSync("codesign", ["-dv", real], { encoding: "utf8" });
		if (!signedByDeveloper(`${codesign.stdout}${codesign.stderr}`)) {
			console.warn(`[service] WARNING: ${real} is not signed by a developer (ad-hoc or unsigned, as Homebrew builds are).`
				+ " macOS drops a privacy grant for it whenever it is replaced, for example by an upgrade, and the service then stops working."
				+ " Prefer the signed installer from nodejs.org and pass its binary with --node.");
		}
		console.warn(`[service] This installation is on an external volume. If macOS has not allowed ${real} to use it, the jobs fail with`
			+ " \"Operation not permitted\" or wait without output (`npm run service -- status` reports it): add that file under System Settings >"
			+ " Privacy & Security > Full Disk Access.");
	}
}

async function uninstall(inst: Installation, { quiet = false } = {}): Promise<void> {
	const wasInstalled = installedJobs(inst).includes("server");
	for (const label of Object.values(labels(inst))) {
		launchctl("bootout", target(label));
		launchctl("enable", target(label));
		const plist = launchAgentPath(label);
		if (!existsSync(plist)) continue;
		rmSync(plist);
		if (!quiet) console.log(`[service] removed ${label}`);
	}
	if (wasInstalled) await stopRuntime(inst);
}

/** Stops every job and keeps it stopped across logins; the scheduled jobs would otherwise start Telomi again. */
async function stop(inst: Installation): Promise<void> {
	for (const job of installedJobs(inst)) {
		const label = labels(inst)[job];
		launchctl("bootout", target(label));
		launchctl("disable", target(label));
		console.log(`[service] stopped ${label}`);
	}
	await stopRuntime(inst);
}

function start(inst: Installation): void {
	for (const job of installedJobs(inst)) {
		bootstrap(labels(inst)[job]);
		console.log(`[service] started ${labels(inst)[job]}`);
	}
}

function tail(path: string, bytes = 64 * 1024): string {
	if (!existsSync(path)) return "";
	const size = statSync(path).size;
	return readFileSync(path).subarray(Math.max(0, size - bytes)).toString("utf8");
}

function status(inst: Installation): void {
	const jobs = installedJobs(inst);
	if (jobs.length === 0) {
		console.log("[service] not installed for this checkout; run npm run service -- install");
		return;
	}
	const disabled = launchctl("print-disabled", `gui/${uid()}`).output;
	for (const job of jobs) {
		const label = labels(inst)[job];
		const printed = launchctl("print", target(label));
		const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, "mu").exec(printed.output)?.[1];
		const state = !printed.ok ? (disabled.includes(`"${label}" => disabled`) ? "stopped" : "not loaded")
			: [field("state"), field("pid") && `pid ${field("pid")}`, field("last exit code") && `last exit ${field("last exit code")}`].filter(Boolean).join(", ");
		console.log(`[service] ${job}: ${state}`);
		const log = tail(logPath(label, homedir()));
		if (log.includes("Operation not permitted")) {
			const node = (JSON.parse(plistJson(label)) as { ProgramArguments: string[] }).ProgramArguments[0]!;
			console.log(`[service]   its log reports "Operation not permitted": macOS has not allowed ${realpathSync(node)} to use the volume (Privacy & Security > Full Disk Access)`);
		}
		if (job === "auto-upgrade") {
			const last = log.split("\n").filter((line) => line.startsWith("[upgrade]")).at(-1);
			if (last) console.log(`[service]   last: ${last}`);
		}
	}
	const commit = spawnSync("git", ["describe", "--tags", "--always", "--dirty"], { cwd: inst.repoRoot, encoding: "utf8" }).stdout.trim();
	console.log(`[service] code: ${commit}`);
	const busy = join(inst.backupDir, "upgrade-state.json");
	if (existsSync(busy)) {
		const since = (JSON.parse(readFileSync(busy, "utf8")) as { busySince?: string }).busySince;
		if (since) console.log(`[service] automatic upgrades have found Telomi busy since ${since}`);
	}
}

function plistJson(label: string): string {
	return spawnSync("plutil", ["-convert", "json", "-o", "-", launchAgentPath(label)], { encoding: "utf8" }).stdout;
}

/** Unloading a job kills its program: never while it is halfway through changing the installation. */
function assertNoUpgradeRunning(inst: Installation): void {
	const lock = join(inst.backupDir, ".upgrade.lock");
	if (!existsSync(lock)) return;
	const pid = Number(readFileSync(lock, "utf8"));
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return;
	}
	throw new UpgradeError(`an upgrade (pid ${pid}) is changing this installation; try again when it has finished`);
}

export async function main(argv: string[], inst = installation()): Promise<number> {
	const command = parseCommand(argv);
	if (["install", "uninstall", "stop"].includes(command.action)) assertNoUpgradeRunning(inst);
	if (command.action === "install") await install(inst, command.options);
	else if (command.action === "uninstall") await uninstall(inst);
	else if (command.action === "stop") await stop(inst);
	else if (command.action === "start") start(inst);
	else if (command.action === "restart") {
		const restarted = launchctl("kickstart", "-k", target(labels(inst).server));
		if (!restarted.ok) throw new UpgradeError(`the server job is not running (${restarted.output}); use npm run service -- start`);
		console.log(`[service] restarted ${labels(inst).server}`);
	} else status(inst);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	Promise.resolve().then(() => main(process.argv.slice(2), installation(applicationRoot))).then((code) => { process.exitCode = code; }, (error: unknown) => {
		console.error(`[service] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
