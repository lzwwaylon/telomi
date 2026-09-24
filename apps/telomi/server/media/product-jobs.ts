import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JsonDocumentStore } from "../lib/json-document-store.js";
import { runtimeStateDir } from "../workspaces/goal-runtime-paths.js";

export interface MediaProductJob {
	jobId: string;
	goalId: string;
	cardId: string;
	status: "running" | "failed" | "done";
	startedAt: number;
	updatedAt: number;
	error?: string;
}

/** One document per attempt, with the latest attempt projected onto each card. */
export class MediaProductJobs {
	private readonly latest = new Map<string, MediaProductJob>();

	constructor(private readonly workspaceDir: string) {
		if (!existsSync(workspaceDir)) return;
		for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const jobs = this.store(entry.name).list().filter((value): value is MediaProductJob => {
				if (!value || typeof value !== "object") return false;
				const job = value as MediaProductJob;
				return job.goalId === entry.name && typeof job.jobId === "string"
					&& /^job_[a-zA-Z0-9_-]+$/u.test(job.jobId)
					&& typeof job.cardId === "string" && Boolean(job.cardId)
					&& ["running", "failed", "done"].includes(job.status)
					&& Number.isFinite(job.startedAt) && Number.isFinite(job.updatedAt)
					&& (job.error === undefined || typeof job.error === "string");
			}).sort((a, b) => a.startedAt - b.startedAt);
			for (const job of jobs) {
				if (job.status === "running") {
					this.save({ ...job, status: "failed", error: "服务重启中断了媒体生成。为避免重复付费，未自动重试；请手动重新生成。" });
				} else {
					this.latest.set(this.key(job.goalId, job.cardId), job);
				}
			}
		}
	}

	get(goalId: string, cardId: string): MediaProductJob | undefined {
		return this.latest.get(this.key(goalId, cardId));
	}

	save(job: MediaProductJob): void {
		const updated = { ...job, updatedAt: Date.now() };
		this.store(job.goalId).put(job.jobId, updated);
		this.latest.set(this.key(job.goalId, job.cardId), updated);
	}

	private key(goalId: string, cardId: string): string {
		return JSON.stringify([goalId, cardId]);
	}

	private store(goalId: string): JsonDocumentStore<unknown> {
		return new JsonDocumentStore(join(runtimeStateDir(join(this.workspaceDir, goalId)), "media-products", "jobs"));
	}
}
