import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GoalActivityItem } from "../../shared/types.js";

export type { GoalActivityItem, GoalActivityStatus } from "../../shared/types.js";

type ChangeEvent = { type: "changed"; goalId: string; item: GoalActivityItem };
type Listener = (event: ChangeEvent) => void;

interface ActivityLogRecord {
	version: 1;
	at: string;
	item: GoalActivityItem;
}

export class PodcastActivityStore {
	private readonly listeners = new Set<Listener>();
	private readonly items = new Map<string, GoalActivityItem>();

	constructor(
		private readonly opts: {
			logPath?: string;
			capPerGoal?: number;
			replayLimit?: number;
		} = {},
	) {
		this.replay();
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(goalId: string): GoalActivityItem[] {
		return [...this.items.values()]
			.filter((item) => item.goalId === goalId)
			.sort(activitySort)
			.slice(0, this.opts.capPerGoal ?? 80);
	}

	purgeGoal(goalId: string): void {
		for (const [id, item] of this.items) {
			if (item.goalId === goalId) this.items.delete(id);
		}

		const logPath = this.opts.logPath;
		if (!logPath || !existsSync(logPath)) return;
		try {
			const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
			const retained = lines.filter((line) => {
				try {
					return (JSON.parse(line) as Partial<ActivityLogRecord>).item?.goalId !== goalId;
				} catch {
					return true;
				}
			});
			writeFileSync(logPath, retained.length ? `${retained.join("\n")}\n` : "", "utf-8");
		} catch {
			/* activity cleanup must not make Goal deletion fail */
		}
	}

	record(item: Omit<GoalActivityItem, "updatedAt"> & { updatedAt?: number }): GoalActivityItem {
		const now = Date.now();
		const prev = this.items.get(item.id);
		const active = item.status === "queued" || item.status === "running";
		const next: GoalActivityItem = {
			...prev,
			...item,
			updatedAt: item.updatedAt ?? now,
			startedAt: item.startedAt ?? prev?.startedAt ?? (item.status === "running" ? now : undefined),
			finishedAt: item.finishedAt ?? prev?.finishedAt ?? (active ? undefined : now),
		};
		this.items.set(next.id, next);
		this.trim(next.goalId);
		this.append(next);
		this.emit({ type: "changed", goalId: next.goalId, item: next });
		return next;
	}

	private trim(goalId: string): void {
		const items = this.list(goalId);
		const cap = this.opts.capPerGoal ?? 80;
		if (items.length <= cap) return;
		const keep = new Set(items.slice(0, cap).map((item) => item.id));
		for (const item of this.items.values()) {
			if (item.goalId === goalId && !keep.has(item.id)) this.items.delete(item.id);
		}
	}

	private replay(): void {
		const logPath = this.opts.logPath;
		if (!logPath || !existsSync(logPath)) return;
		let raw = "";
		try {
			raw = readFileSync(logPath, "utf-8");
		} catch {
			return;
		}
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);
		const replayLimit = this.opts.replayLimit ?? 2_000;
		for (const line of lines.slice(-replayLimit)) {
			try {
				const parsed = JSON.parse(line) as Partial<ActivityLogRecord>;
				const item = parsed.item;
				if (
					!item
					|| typeof item.id !== "string"
					|| typeof item.goalId !== "string"
					|| item.kind !== "podcast"
				) continue;
				this.items.set(item.id, item);
			} catch {
				/* ignore corrupt log lines */
			}
		}
		this.markReplayedRunningItemsStale();
	}

	private markReplayedRunningItemsStale(): void {
		const now = Date.now();
		for (const item of [...this.items.values()]) {
			if (item.status !== "running") continue;
			const next: GoalActivityItem = {
				...item,
				status: "stale",
				detail: item.detail
					? `${item.detail} | 服务重启，后台任务状态已失效`
					: "服务重启，后台任务状态已失效",
				updatedAt: now,
				finishedAt: item.finishedAt ?? now,
			};
			this.items.set(next.id, next);
			this.append(next);
		}
	}

	private append(item: GoalActivityItem): void {
		const logPath = this.opts.logPath;
		if (!logPath) return;
		try {
			const dir = dirname(logPath);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			const record: ActivityLogRecord = {
				version: 1,
				at: new Date(item.updatedAt).toISOString(),
				item,
			};
			appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
		} catch {
			/* activity logging must not break background agents */
		}
	}

	private emit(event: ChangeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* activity observers must not break background agents */
			}
		}
	}
}

export function activitySort(a: GoalActivityItem, b: GoalActivityItem): number {
	const ar = a.status === "running" ? 2 : a.status === "queued" ? 1 : 0;
	const br = b.status === "running" ? 2 : b.status === "queued" ? 1 : 0;
	if (ar !== br) return br - ar;
	const at = a.updatedAt || a.startedAt || a.finishedAt || 0;
	const bt = b.updatedAt || b.startedAt || b.finishedAt || 0;
	return bt - at;
}
