import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256 } from "../lib/hash.js";

export interface EvaluationVersionSnapshot {
	schema_version: 1;
	captured_at: string;
	telomi_repository: string;
	telomi_commit: string;
	telomi_branch: string;
	telomi_dirty: boolean;
	telomi_patch_sha256?: string;
	telomi_status_sha256?: string;
	runtime_instance_id?: string;
	runtime_started_at?: string;
	runtime_loaded_telomi_commit?: string;
	runtime_loaded_telomi_dirty?: boolean;
	runtime_loaded_telomi_patch_sha256?: string;
	runtime_loaded_telomi_status_sha256?: string;
	package_lock_sha256?: string;
	node_version: string;
	pi_runtime_version?: string;
	workspace_content_hash?: string;
	knowledge_memory_hash?: string;
	harness_commit?: string;
	harness_snapshot_hash?: string;
	model_policy_hash?: string;
	evidence_schema_version: 1;
}

export interface CaptureVersionSnapshotOptions {
	repositoryCwd: string;
	workspaceContentHash?: string;
	knowledgeMemoryHash?: string;
	harnessCommit?: string;
	harnessSnapshotHash?: string;
	modelPolicyHash?: string;
	capturedAt?: string;
}

interface RepositoryIdentity {
	repository: string;
	commit: string;
	branch: string;
	status: string;
	dirtyPatchIdentity: string;
}

interface RuntimeProcessIdentity {
	runtime_instance_id: string;
	runtime_started_at: string;
	runtime_loaded_telomi_commit: string;
	runtime_loaded_telomi_dirty: boolean;
	runtime_loaded_telomi_patch_sha256?: string;
	runtime_loaded_telomi_status_sha256?: string;
}

let runtimeProcessIdentity: RuntimeProcessIdentity | undefined;

export function initializeEvaluationRuntimeProcessIdentity(
	repositoryCwd: string,
	startedAt = new Date().toISOString(),
): RuntimeProcessIdentity {
	if (runtimeProcessIdentity) return runtimeProcessIdentity;
	const loaded = captureRepositoryIdentity(repositoryCwd);
	runtimeProcessIdentity = {
		runtime_instance_id: randomUUID(),
		runtime_started_at: startedAt,
		runtime_loaded_telomi_commit: loaded.commit,
		runtime_loaded_telomi_dirty: Boolean(loaded.status),
		...(loaded.dirtyPatchIdentity ? { runtime_loaded_telomi_patch_sha256: sha256(loaded.dirtyPatchIdentity) } : {}),
		...(loaded.status ? { runtime_loaded_telomi_status_sha256: sha256(loaded.status) } : {}),
	};
	return runtimeProcessIdentity;
}

export function captureEvaluationVersionSnapshot(
	options: CaptureVersionSnapshotOptions,
): EvaluationVersionSnapshot {
	const current = captureRepositoryIdentity(options.repositoryCwd);
	const { repository, commit, branch, status, dirtyPatchIdentity } = current;
	const packageLockPath = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]
		.map((name) => join(repository, name))
		.find((path) => existsSync(path));
	const packageJsonPath = join(repository, "apps", "telomi", "package.json");
	let piRuntimeVersion: string | undefined;
	if (existsSync(packageJsonPath)) {
		try {
			const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
				dependencies?: Record<string, string>;
			};
			piRuntimeVersion = parsed.dependencies?.["@earendil-works/pi-coding-agent"];
		} catch {
			// A malformed package file is represented by the missing optional version.
		}
	}
	return {
		schema_version: 1,
		captured_at: options.capturedAt ?? new Date().toISOString(),
		telomi_repository: basename(repository),
		telomi_commit: commit,
		telomi_branch: branch,
		telomi_dirty: Boolean(status),
		...(dirtyPatchIdentity ? { telomi_patch_sha256: sha256(dirtyPatchIdentity) } : {}),
		...(status ? { telomi_status_sha256: sha256(status) } : {}),
		...(runtimeProcessIdentity ?? {}),
		...(packageLockPath ? { package_lock_sha256: sha256(readFileSync(packageLockPath)) } : {}),
		node_version: process.version,
		...(piRuntimeVersion ? { pi_runtime_version: piRuntimeVersion } : {}),
		...(options.workspaceContentHash ? { workspace_content_hash: options.workspaceContentHash } : {}),
		...(options.knowledgeMemoryHash ? { knowledge_memory_hash: options.knowledgeMemoryHash } : {}),
		...(options.harnessCommit ? { harness_commit: options.harnessCommit } : {}),
		...(options.harnessSnapshotHash ? { harness_snapshot_hash: options.harnessSnapshotHash } : {}),
		...(options.modelPolicyHash ? { model_policy_hash: options.modelPolicyHash } : {}),
		evidence_schema_version: 1,
	};
}

function captureRepositoryIdentity(repositoryCwd: string): RepositoryIdentity {
	const repository = git(repositoryCwd, ["rev-parse", "--show-toplevel"]);
	const commit = git(repository, ["rev-parse", "HEAD"]);
	const branch = git(repository, ["branch", "--show-current"]) || "detached";
	const status = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const diff = git(repository, ["diff", "--binary", "HEAD"]);
	const untrackedFiles = gitRaw(repository, ["ls-files", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right));
	const dirtyPatchIdentity = [
		diff,
		...untrackedFiles.map((path) => untrackedIdentity(repository, path)),
	].filter(Boolean).join("\n");
	return { repository, commit, branch, status, dirtyPatchIdentity };
}

function git(cwd: string, args: string[]): string {
	return gitRaw(cwd, args).trim();
}

function untrackedIdentity(repository: string, path: string): string {
	const absolutePath = join(repository, path);
	if (!existsSync(absolutePath)) return `untracked-missing\0${path}`;
	const stat = lstatSync(absolutePath);
	if (stat.isFile()) return `untracked-file\0${path}\0${sha256(readFileSync(absolutePath))}`;
	if (stat.isSymbolicLink()) return `untracked-symlink\0${path}\0${stat.size}`;
	if (stat.isDirectory()) {
		try {
			const commit = git(absolutePath, ["rev-parse", "HEAD"]);
			const status = git(absolutePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
			const diff = git(absolutePath, ["diff", "--binary", "HEAD"]);
			return `untracked-repository\0${path}\0${commit}\0${sha256(status)}\0${sha256(diff)}`;
		} catch {
			return `untracked-directory\0${path}\0${stat.size}\0${stat.mtimeMs}`;
		}
	}
	return `untracked-other\0${path}\0${stat.mode}\0${stat.size}`;
}

function gitRaw(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(`Unable to capture Telomi version: git ${args[0]} failed: ${(result.error?.message || result.stderr || "unknown error").trim()}`);
	}
	return result.stdout;
}
