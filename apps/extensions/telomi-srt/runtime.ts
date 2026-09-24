import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandboxExecutionSpec } from "./sandbox-spec.js";
import { runtimeTools } from "./runtime-tools.js";

export interface SrtPolicy {
	filesystem: {
		denyRead: string[];
		allowRead: string[];
		allowWrite: string[];
		denyWrite: string[];
	};
	network: {
		allowedDomains: string[];
		deniedDomains: string[];
		strictAllowlist: true;
		allowLocalBinding?: boolean;
		allowUnixSockets?: string[];
	};
}

export interface SrtSpawnOptions {
	command: string;
	args?: readonly string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	policy: SrtPolicy;
	stdio?: "pipe" | "inherit" | ["ignore" | "pipe" | "inherit", "pipe" | "inherit", "pipe" | "inherit"];
}

export interface SrtExecOptions {
	command: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	policy: SrtPolicy;
	signal?: AbortSignal;
	timeoutSeconds?: number;
	onData?: (chunk: Buffer) => void;
}

const RUNNER = fileURLToPath(new URL("./srt-runner.mjs", import.meta.url));
// SRT runs apply-seccomp as stage 2, from inside the sandbox, so its own install
// directory has to stay readable there. npm hoists that package to wherever the
// workspace layout puts it, so resolve it instead of assuming it sits under this
// extension: when it was hoisted to the repo root, the grant below silently
// stopped covering it and every Linux sandbox died with "apply-seccomp: not found".
const SANDBOX_RUNTIME = dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime/package.json")));
const POLICY_ENV = "TELOMI_SRT_POLICY_B64";
const TARGET_ENV = "TELOMI_SRT_TARGET_B64";

export function spawnSrt(options: SrtSpawnOptions): ChildProcess {
	const policy = validatePolicy(options.policy);
	policy.filesystem.allowRead = [...new Set([...policy.filesystem.allowRead, dirname(RUNNER)])];
	const targetEnv = {
		...options.env,
		NODE_USE_ENV_PROXY: "1",
		PRIME_AGENT_TELEMETRY: "0",
	};
	return spawn(process.execPath, [RUNNER], {
		cwd: resolve(options.cwd),
		env: {
			...process.env,
			...targetEnv,
			[POLICY_ENV]: Buffer.from(JSON.stringify(policy), "utf8").toString("base64url"),
			[TARGET_ENV]: Buffer.from(JSON.stringify({
				command: options.command,
				args: options.args ?? [],
				env: targetEnv,
			}), "utf8").toString("base64url"),
		},
		stdio: options.stdio ?? "pipe",
	});
}

export async function execSrt(options: SrtExecOptions): Promise<{ exitCode: number }> {
	if (options.signal?.aborted) throw new Error("aborted");
	const child = spawnSrt({
		command: "/bin/sh",
		args: ["-c", options.command],
		cwd: options.cwd,
		env: options.env,
		policy: options.policy,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const onAbort = () => child.kill("SIGTERM");
	options.signal?.addEventListener("abort", onAbort, { once: true });
	child.stdout?.on("data", (chunk: Buffer) => options.onData?.(chunk));
	child.stderr?.on("data", (chunk: Buffer) => options.onData?.(chunk));
	let timedOut = false;
	const timer = options.timeoutSeconds && options.timeoutSeconds > 0
		? setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, options.timeoutSeconds * 1_000)
		: undefined;
	try {
		const exitCode = await new Promise<number>((resolveExit, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => resolveExit(code ?? 1));
		});
		if (options.signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${options.timeoutSeconds}`);
		return { exitCode };
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export function policyFromSpec(spec: SandboxExecutionSpec): SrtPolicy {
	const mounts = spec.mounts.map((mount) => ({ ...mount, hostPath: canonical(mount.hostPath) }));
	const writableRoots = mounts.filter((mount) => mount.access === "read-write").map((mount) => mount.hostPath);
	const denyRead: string[] = [];
	for (const mount of mounts) {
		for (const shadow of mount.shadowPaths ?? []) {
			const hidden = canonical(resolve(mount.hostPath, shadow.replace(/^\/+/, "")));
			// A logical shadow cannot revoke another mount's explicit host grant (/work
			// is also beneath /artifacts). File tools still enforce the guest shadow.
			if (!mounts.some((other) => other.hostPath === hidden)) denyRead.push(hidden);
		}
	}
	return validatePolicy({
		filesystem: {
			denyRead,
			allowRead: mounts.map((mount) => mount.hostPath),
			allowWrite: writableRoots,
			// Writes are denied by default. Only readonly subtrees inside a writable
			// grant need an explicit deny; denying an ancestor would also deny /work.
			denyWrite: mounts.filter((mount) => mount.access === "read-only"
				&& writableRoots.some((root) => isInside(root, mount.hostPath))).map((mount) => mount.hostPath),
		},
		network: {
			allowedDomains: spec.network.mode === "allow"
				? ["*"]
				: spec.network.mode === "http-allowlist"
					? [...(spec.network.allowedHosts ?? [])]
					: [],
			deniedDomains: [],
			strictAllowlist: true,
		},
	});
}

export function validatePolicy(policy: SrtPolicy): SrtPolicy {
	const paths = (values: readonly string[]) => [...new Set(values.map(canonical))];
	const domains = (values: readonly string[]) => [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
	if (!policy?.filesystem || !policy.network) throw new Error("SRT policy is required");
	const runtimePaths = runtimeReadPaths();
	return {
		filesystem: {
			// SRT reads are otherwise allowed everywhere. Both Pi and Prime must start closed.
			denyRead: paths(["/", ...policy.filesystem.denyRead]),
			allowRead: paths([...runtimePaths, ...policy.filesystem.allowRead]),
			allowWrite: paths(policy.filesystem.allowWrite),
			denyWrite: paths([...runtimePaths, ...policy.filesystem.denyWrite]),
		},
		network: {
			allowedDomains: domains(policy.network.allowedDomains),
			deniedDomains: domains(policy.network.deniedDomains),
			strictAllowlist: true,
			...(policy.network.allowLocalBinding ? { allowLocalBinding: true } : {}),
			...(policy.network.allowUnixSockets?.length
				? { allowUnixSockets: paths(policy.network.allowUnixSockets) }
				: {}),
		},
	};
}

/** OS tools/libraries plus the actual Node launcher, never its whole installation prefix. */
function runtimeReadPaths(): string[] {
	const report = process.report.getReport() as { sharedObjects?: string[] };
	return [
		process.execPath,
		...runtimeTools().readPaths,
		fileURLToPath(new URL("./srt-target.mjs", import.meta.url)),
		SANDBOX_RUNTIME,
		...(report.sharedObjects ?? []).map((path) => /(?:\.dylib|\.so(?:\.\d+)*)$/u.test(path) ? dirname(path) : path),
		"/bin", "/usr/bin", "/usr/lib", "/usr/lib64", "/lib", "/lib64",
		"/usr/share/locale", "/usr/share/zoneinfo",
		"/etc/ld.so.cache", "/etc/localtime", "/etc/hosts", "/etc/resolv.conf", "/etc/nsswitch.conf",
		"/etc/ssl/certs", "/etc/ssl/cert.pem", "/etc/ssl/openssl.cnf", "/dev/null", "/dev/urandom", "/dev/random",
		...(process.platform === "darwin" ? [
			"/System/Library", "/Library/Apple/System/Library", "/private/var/select",
			// dyld reads the Homebrew opt symlinks before opening the granted Cellar libraries.
			"/opt/homebrew/opt", "/usr/local/opt",
			"/opt/homebrew/etc/openssl@3/openssl.cnf", "/usr/local/etc/openssl@3/openssl.cnf",
		] : []),
	].filter(existsSync);
}

export function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonical(value: string): string {
	const absolute = resolve(value);
	try {
		return realpathSync(absolute);
	} catch {
		const parent = dirname(absolute);
		try {
			return resolve(realpathSync(parent), absolute.slice(parent.length + 1));
		} catch {
			return absolute;
		}
	}
}
