import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ResearchNodeError } from "../../../../agent-runtime/retry-policy.js";

const DEFAULT_STDOUT_LIMIT = 8 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 256 * 1024;
const KILL_GRACE_MS = 2_000;
const PROJECT_YT_DLP = fileURLToPath(new URL(
	"../../../../../services/research-source-service/.venv/bin/yt-dlp",
	import.meta.url,
));

export interface YtDlpRunOptions {
	cwd?: string;
	signal?: AbortSignal;
	maxStdoutBytes?: number;
	maxStderrBytes?: number;
	acceptPartialOutput?: boolean;
}

export interface YtDlpRunResult {
	stdout: string;
	stderr: string;
}

export class ControlledYtDlpRunner {
	private versionPromise: Promise<string> | undefined;

	constructor(
		readonly binary = process.env.PI_YOUTUBE_YTDLP_BINARY?.trim() || PROJECT_YT_DLP,
	) {}

	async version(signal?: AbortSignal): Promise<string> {
		this.versionPromise ??= this.run(["--version"], {
			signal,
			maxStdoutBytes: 64 * 1024,
			maxStderrBytes: 64 * 1024,
		}).then((result) => {
			const version = result.stdout.trim().split(/\s+/u)[0];
			if (!version) throw new ResearchNodeError(
				"yt-dlp returned an empty version",
				"validation",
				false,
				{ code: "youtube_ytdlp_invalid_version" },
			);
			return version;
		}).catch((error) => {
			this.versionPromise = undefined;
			throw error;
		});
		return await this.versionPromise;
	}

	async run(args: string[], options: YtDlpRunOptions = {}): Promise<YtDlpRunResult> {
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
			throw new ResearchNodeError(
				"yt-dlp arguments are invalid",
				"validation",
				false,
				{ code: "youtube_ytdlp_invalid_arguments" },
			);
		}
		const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_STDOUT_LIMIT;
		const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STDERR_LIMIT;
		return await new Promise<YtDlpRunResult>((resolve, reject) => {
			let settled = false;
			let stdoutBytes = 0;
			let stderrBytes = 0;
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			const child = spawn(this.binary, ["--ignore-config", ...args], {
				cwd: options.cwd,
				env: sanitizedEnvironment(),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const terminate = () => {
				if (child.exitCode !== null || child.killed) return;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (child.exitCode === null) child.kill("SIGKILL");
				}, KILL_GRACE_MS);
			};
			const finishError = (error: ResearchNodeError) => {
				if (settled) return;
				settled = true;
				terminate();
				cleanupRequest();
				reject(error);
			};
			const onAbort = () => finishError(new ResearchNodeError(
				"yt-dlp request was cancelled",
				"cancelled",
				false,
				{ code: "youtube_ytdlp_cancelled" },
			));
			// yt-dlp inherits caller cancellation. Do not add a wall-clock timeout:
			// full feed enumeration and media acquisition can legitimately run long.
			const cleanupRequest = () => {
				options.signal?.removeEventListener("abort", onAbort);
			};
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > maxStdoutBytes) {
					finishError(new ResearchNodeError(
						`yt-dlp stdout exceeded ${maxStdoutBytes} bytes`,
						"budget",
						false,
						{ code: "youtube_ytdlp_stdout_limit" },
					));
					return;
				}
				stdout.push(chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderrBytes > maxStderrBytes) {
					finishError(new ResearchNodeError(
						`yt-dlp stderr exceeded ${maxStderrBytes} bytes`,
						"budget",
						false,
						{ code: "youtube_ytdlp_stderr_limit" },
					));
					return;
				}
				stderr.push(chunk);
			});
			child.once("error", (error: NodeJS.ErrnoException) => {
				const missing = error.code === "ENOENT";
				finishError(new ResearchNodeError(
					missing
						? `yt-dlp is not installed or PI_YOUTUBE_YTDLP_BINARY is invalid: ${this.binary}`
						: `yt-dlp failed to start: ${error.message}`,
					missing ? "permanent" : "provider",
					!missing,
					{
						code: missing ? "youtube_ytdlp_missing" : "youtube_ytdlp_spawn_failed",
						cause: error,
					},
				));
			});
			child.once("close", (code, signal) => {
				if (killTimer) clearTimeout(killTimer);
				if (settled) return;
				settled = true;
				cleanupRequest();
				const stdoutText = Buffer.concat(stdout).toString("utf-8");
				const stderrText = Buffer.concat(stderr).toString("utf-8");
				if (code === 0 || (options.acceptPartialOutput && stdoutText.trim())) {
					resolve({ stdout: stdoutText, stderr: stderrText });
					return;
				}
				reject(classifyYtDlpExit(code, signal, stderrText || stdoutText));
			});
		});
	}
}

function classifyYtDlpExit(
	code: number | null,
	signal: NodeJS.Signals | null,
	output: string,
): ResearchNodeError {
	const diagnostic = output.trim().slice(-4_000) || `exit=${code ?? "null"} signal=${signal ?? "none"}`;
	const lower = diagnostic.toLowerCase();
	if (/unsupported url|invalid url|video id/u.test(lower)) {
		return new ResearchNodeError(
			`yt-dlp rejected the YouTube URL: ${diagnostic}`,
			"validation",
			false,
			{ code: "youtube_ytdlp_invalid_url" },
		);
	}
	if (/too many requests|http error 429|rate.?limit/u.test(lower)) {
		return new ResearchNodeError(
			`yt-dlp was rate limited: ${diagnostic}`,
			"rate_limit",
			true,
			{ code: "youtube_ytdlp_rate_limited" },
		);
	}
	if (/requested format is not available/u.test(lower)) {
		return new ResearchNodeError(
			`yt-dlp could not access a media format for this YouTube resource: ${diagnostic}`,
			"provider",
			false,
			{
				code: "youtube_ytdlp_format_unavailable",
				details: { circuit_scope: "request" },
			},
		);
	}
	if (/private video|members-only|video unavailable|this video is unavailable|has been removed|not available in your country|copyright/u.test(lower)) {
		return new ResearchNodeError(
			`yt-dlp cannot access this YouTube resource: ${diagnostic}`,
			"permanent",
			false,
			{
				code: "youtube_resource_unavailable",
				details: { circuit_scope: "request" },
			},
		);
	}
	if (/sign in|login|cookies/u.test(lower)) {
		return new ResearchNodeError(
			`yt-dlp requires account authorization: ${diagnostic}`,
			"permanent",
			false,
			{ code: "youtube_ytdlp_authorization_required" },
		);
	}
	return new ResearchNodeError(
		`yt-dlp failed: ${diagnostic}`,
		"provider",
		true,
		{ code: "youtube_ytdlp_failed" },
	);
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
	const allowed = [
		"PATH",
		"HOME",
		"TMPDIR",
		"TMP",
		"TEMP",
		"LANG",
		"LC_ALL",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
		"http_proxy",
		"https_proxy",
		"no_proxy",
	] as const;
	const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8" };
	for (const key of allowed) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	return env;
}
