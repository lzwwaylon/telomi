import { spawn, type Serializable } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { isInsideRoot } from "../lib/paths.js";
import { isRecord } from "../lib/values.js";
import {
	PRIME_AUTO_REFINE_ENABLED,
	PRIME_CREDENTIAL_SOURCE_ENV,
	primeAgentDir,
	primeAgentModulePath,
	removeStagedPrimeCredentials,
	stagePrimeAgentDirectory,
} from "./prime-agent-paths.js";
import { primeKernelEnv, removeSrtTempDirectory } from "./prime-agent-srt.js";
import { observeModelFailureText } from "./model-config/model-verdicts.js";
import type { ResearchModelUsage } from "./model-usage.js";
import { ResearchNodeError } from "./retry-policy.js";

/**
 * 项目里启动 Prime Agent 子进程的唯一入口。它负责：短路径临时目录、Kernel 沙箱环境变量、
 * staged Agent Directory（Auto Refine 关闭、rlmMaxDepth 固定）、输出收集、退出码转错误、
 * usage 读取，以及 abort 时终止子进程。业务 Worker 自身的变量通过 `extraEnv` 传入。
 */
export interface PrimeWorkerLaunch {
	/** 用于错误文案，例如 "Prime Cornell Note"。 */
	name: string;
	/** Worker 脚本绝对路径，通过 tsx loader 执行。 */
	worker: string;
	/** Worker Workspace：Agent 的工作目录，也是唯一可写根。 */
	agentRoot: string;
	/** Runtime 私有目录：staged Agent Directory、沙箱 HOME 与 stdout/stderr 都写在这里。 */
	runtimeRoot: string;
	readonlyRoots?: readonly string[];
	/** 除 runtimeRoot 外额外对 Kernel 隐藏的目录。 */
	privateRoots?: readonly string[];
	/** Kernel 启动日志路径，默认 runtimeRoot/kernel-launches.jsonl。 */
	kernelLogPath?: string;
	/** stdout.txt / stderr.txt 的落盘目录，默认 runtimeRoot。 */
	logDirectory?: string;
	env?: NodeJS.ProcessEnv;
	extraEnv?: NodeJS.ProcessEnv;
	signal: AbortSignal;
	onStdoutLine?: (line: string) => void;
	/** 提供时以 IPC 通道启动；`stage_worker_failure` 由启动器自己处理，不会转发。 */
	onMessage?: (message: unknown, reply: (value: Serializable) => void) => void;
}

export interface PrimeWorkerOutcome {
	stdout: string;
	stderr: string;
	/** runtimeRoot/result.json 的内容；Worker 没写时为 undefined。 */
	result: Record<string, unknown> | undefined;
	/** result.usage 投影；没有 result 时为零。 */
	usage: ResearchModelUsage;
}

interface StageWorkerFailure {
	type: "stage_worker_failure";
	failure_class: "validation" | "provider";
	error: string;
}

const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));

export async function spawnPrimeWorker(launch: PrimeWorkerLaunch): Promise<PrimeWorkerOutcome> {
	if (launch.signal.aborted) throw new ResearchNodeError(`${launch.name} cancelled`, "cancelled", false);
	// staged 凭证与私有 Runtime 状态放在 Worker Workspace 之外，Logical Workspace 快照与 Agent 自身都碰不到它们。
	if (isInsideRoot(launch.agentRoot, launch.runtimeRoot)) {
		throw new Error(`${launch.name} runtime directory must not live inside the Worker Workspace: ${launch.runtimeRoot}`);
	}
	const env = launch.env ?? process.env;
	const agentDirectory = join(launch.runtimeRoot, "agent");
	const sandboxHome = join(launch.runtimeRoot, "home");
	const logDirectory = launch.logDirectory ?? launch.runtimeRoot;
	mkdirSync(launch.agentRoot, { recursive: true });
	mkdirSync(sandboxHome, { recursive: true });
	mkdirSync(logDirectory, { recursive: true });
	// Prime 的 Supervisor、Worker 和 IPython IPC 都要求短路径，所以不用 os.tmpdir()。
	const socketDirectory = mkdtempSync("/tmp/pi-srt-");
	const stdout = boundedOutput();
	const stderr = boundedOutput();
	let failure: StageWorkerFailure | undefined;
	try {
		stagePrimeAgentDirectory(agentDirectory, env);
		assertStagedAutoRefineDisabled(agentDirectory);
		// Every Worker runs under the tsx loader so a Worker in any module format can import the
		// Runtime's own modules by their `.js` specifier.
		const args = ["--import", TSX_LOADER, launch.worker];
		const child = spawn(process.execPath, args, {
			cwd: launch.agentRoot,
			env: {
				...primeKernelEnv({
					cwd: launch.agentRoot,
					readonlyRoots: launch.readonlyRoots ?? [],
					writableRoots: [launch.agentRoot],
					privateRoots: [launch.runtimeRoot, ...(launch.privateRoots ?? [])],
					logPath: launch.kernelLogPath ?? join(launch.runtimeRoot, "kernel-launches.jsonl"),
					env,
				}),
				HOME: sandboxHome,
				TMPDIR: socketDirectory,
				TMP: socketDirectory,
				TEMP: socketDirectory,
				PI_SKIP_VERSION_CHECK: "1",
				PRIME_AGENT_CODING_AGENT_DIR: agentDirectory,
				// The Worker reads its staged copy; this is how it notices an activated replacement.
				[PRIME_CREDENTIAL_SOURCE_ENV]: primeAgentDir(env),
				PRIME_AGENT_MODULE_PATH: primeAgentModulePath(env),
				...launch.extraEnv,
			},
			stdio: ["ignore", "pipe", "pipe", ...(launch.onMessage ? ["ipc" as const] : [])],
		});
		child.stdout!.on("data", stdout.push);
		child.stderr!.on("data", stderr.push);
		if (launch.onStdoutLine) createInterface({ input: child.stdout! }).on("line", launch.onStdoutLine);
		if (launch.onMessage) {
			const onMessage = launch.onMessage;
			child.on("message", (message: unknown) => {
				if (isStageWorkerFailure(message)) failure = message;
				else onMessage(message, (value) => child.send(value));
			});
		}
		const abort = () => child.kill("SIGTERM");
		launch.signal.addEventListener("abort", abort, { once: true });
		const ipcDisconnected = child.connected
			? new Promise<void>((resolveDisconnect) => child.once("disconnect", resolveDisconnect))
			: Promise.resolve();
		const exitCode = await new Promise<number>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolveExit(code ?? 1));
		}).finally(() => launch.signal.removeEventListener("abort", abort));
		await ipcDisconnected;
		writeFileSync(join(logDirectory, "stdout.txt"), stdout.buffer());
		writeFileSync(join(logDirectory, "stderr.txt"), stderr.buffer());
		if (launch.signal.aborted) throw new ResearchNodeError(`${launch.name} cancelled`, "cancelled", false);
		if (exitCode !== 0) {
			if (failure?.failure_class === "validation") throw new ResearchNodeError(failure.error, "validation", true);
			// The thrown message reaches the Activity a user reads, so it carries the reason and not
			// the crash dump around it. The untouched stderr stays in stderr.txt and the server log.
			if (!failure?.error) {
				console.warn(
					`[telomi][agent-runtime] ${launch.name} exited with code ${exitCode};`
					+ ` stderr saved to ${join(logDirectory, "stderr.txt")}\n`
					+ stderr.buffer().toString("utf-8").trim().slice(-4000),
				);
			}
			const reason = failure?.error || workerFailureReason(stderr.buffer().toString("utf-8"));
			// A model the Provider refused is reported to the user's inbox, whichever Worker hit it.
			observeModelFailureText(reason);
			throw new ResearchNodeError(
				reason ? `${launch.name} exited with code ${exitCode}: ${reason}` : `${launch.name} exited with code ${exitCode}`,
				"provider",
				true,
			);
		}
		const result = readWorkerResult(join(launch.runtimeRoot, "result.json"));
		return {
			stdout: stdout.buffer().toString("utf-8"),
			stderr: stderr.buffer().toString("utf-8"),
			result,
			usage: usageFromResult(result),
		};
	} finally {
		removeStagedPrimeCredentials(agentDirectory);
		removeSrtTempDirectory(socketDirectory);
	}
}

/**
 * What a Worker's stderr can tell the user when the Worker died without reporting a structured
 * failure. Node prints an uncaught exception as a source location, the offending source line, a
 * caret, the message, stack frames and its own version. Only the message says what went wrong; the
 * rest names files on the machine that ran it and would reach the Activity a user reads, so this
 * keeps the message and drops the frame around it. The untouched output stays in stderr.txt.
 *
 * Output that is not a Node crash dump, an upstream service error a Worker printed for example,
 * has no such frame and passes through whole.
 */
export function workerFailureReason(stderr: string, limit = 1000): string {
	const lines = stderr.trim().split("\n");
	// Everything before the thrown error is location noise Node prints to point at the source.
	// The prefix is optional so a bare `Error:` matches as well as `TypeError:` or `Foo.BarError:`;
	// requiring a leading character would consume the very word being looked for.
	const thrown = lines.findIndex((line) => /^[\w.$]*(?:Error|Exception)\b/u.test(line.trim()));
	return (thrown >= 0 ? lines.slice(thrown) : lines)
		.filter((line) => !/^\s+at\s/u.test(line)
			&& !/^Node\.js v/u.test(line)
			&& !/^\s*\^+\s*$/u.test(line)
			&& !/^\/\S*:\d+(?::\d+)?$/u.test(line.trim()))
		.join("\n")
		.trim()
		.slice(-limit);
}

/** Search Batch 的 SDK 事件流会把每个 text delta 都写到 stdout；只保留尾部，避免长时间采集时内存无界增长。 */
function boundedOutput(limit = 8 * 1024 * 1024) {
	const chunks: Buffer[] = [];
	let bytes = 0;
	return {
		push: (chunk: Buffer) => {
			chunks.push(chunk);
			bytes += chunk.length;
			while (bytes > limit && chunks.length > 1) bytes -= chunks.shift()!.length;
		},
		buffer: () => Buffer.concat(chunks),
	};
}

function assertStagedAutoRefineDisabled(agentDirectory: string): void {
	const settings = JSON.parse(readFileSync(join(agentDirectory, "settings.json"), "utf-8")) as { autoRefine?: { enabled?: unknown } };
	if (settings.autoRefine?.enabled !== PRIME_AUTO_REFINE_ENABLED) {
		throw new Error("Telomi Prime Auto Refine setting was not staged");
	}
}

function isStageWorkerFailure(value: unknown): value is StageWorkerFailure {
	return isRecord(value)
		&& value.type === "stage_worker_failure"
		&& (value.failure_class === "validation" || value.failure_class === "provider")
		&& typeof value.error === "string"
		&& Boolean(value.error.trim());
}

function readWorkerResult(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!isRecord(value)) throw new Error(`${path} is not a JSON object`);
	return value;
}

function usageFromResult(result: Record<string, unknown> | undefined): ResearchModelUsage {
	const usage = isRecord(result?.usage) ? result.usage : {};
	const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
	return {
		inputTokens: number(usage.input_tokens),
		outputTokens: number(usage.output_tokens),
		costUsd: number(usage.cost_usd),
		calls: number(usage.model_calls),
	};
}
