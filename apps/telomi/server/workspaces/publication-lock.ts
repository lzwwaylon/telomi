import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { serverRuntimeDirForGoal } from "./server-runtime-paths.js";
import { readJson } from "../lib/fs.js";

const publicationQueues = new Map<string, Promise<void>>();

export class GoalWorkspacePublicationLock {
	readonly root: string;
	readonly lockPath: string;

	constructor(
		readonly goalId: string,
		dataDir: string,
	) {
		this.root = join(serverRuntimeDirForGoal(goalId, dataDir), "locks");
		this.lockPath = join(this.root, "workspace-publication.lock");
		mkdirSync(this.root, { recursive: true });
	}

	async withLock<T>(owner: string, operation: () => Promise<T> | T): Promise<T> {
		const key = this.lockPath;
		const previous = publicationQueues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		const queued = previous.then(() => current);
		publicationQueues.set(key, queued);
		await previous;

		const operationId = `${safeOwner(owner)}_${randomUUID()}`;
		try {
			this.acquire(owner, operationId);
		} catch (error) {
			release();
			if (publicationQueues.get(key) === queued) publicationQueues.delete(key);
			throw error;
		}
		try {
			return await operation();
		} finally {
			this.release(operationId);
			release();
			if (publicationQueues.get(key) === queued) publicationQueues.delete(key);
		}
	}

	private acquire(owner: string, operationId: string): void {
		const record = {
			schemaVersion: 1,
			goalId: this.goalId,
			owner,
			operationId,
			ownerPid: process.pid,
			createdAt: new Date().toISOString(),
		};
		try {
			writeFileSync(this.lockPath, `${JSON.stringify(record, null, 2)}\n`, {
				encoding: "utf-8",
				flag: "wx",
				mode: 0o600,
			});
			return;
		} catch (error) {
			if (!existsSync(this.lockPath)) throw error;
		}

		const existing = readJson<Record<string, unknown>>(this.lockPath);
		const ownerPid = typeof existing.ownerPid === "number" ? existing.ownerPid : undefined;
		if (ownerPid !== undefined && processIsAlive(ownerPid)) {
			throw new Error(
				`Goal Workspace publication lock is held by process ${ownerPid} for operation ${String(existing.operationId ?? "unknown")}`,
			);
		}

		const recoveredPath = join(
			this.root,
			`recovered-workspace-publication-${Date.now()}-${randomUUID().slice(0, 8)}.json`,
		);
		renameSync(this.lockPath, recoveredPath);
		writeFileSync(join(this.root, "recovery-events.jsonl"), `${JSON.stringify({
			schemaVersion: 1,
			eventId: `recovery_${randomUUID()}`,
			goalId: this.goalId,
			owner,
			operationId,
			recoveredLockPath: recoveredPath,
			previousOwner: existing.owner ?? null,
			previousOwnerPid: ownerPid ?? null,
			createdAt: new Date().toISOString(),
		})}\n`, { encoding: "utf-8", flag: "a", mode: 0o600 });
		writeFileSync(this.lockPath, `${JSON.stringify(record, null, 2)}\n`, {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
	}

	private release(operationId: string): void {
		if (!existsSync(this.lockPath)) {
			throw new Error(`Goal Workspace publication lock disappeared for operation ${operationId}`);
		}
		const existing = readJson<Record<string, unknown>>(this.lockPath);
		if (existing.operationId !== operationId) {
			throw new Error(`Goal Workspace publication lock ownership changed for operation ${operationId}`);
		}
		unlinkSync(this.lockPath);
	}
}


function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function safeOwner(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 80)
		|| "publication";
}
