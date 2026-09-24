import { Router } from "express";
import { statSync } from "fs";
import { join } from "path";
import type { TodayRollup } from "../../shared/types.js";
import type { GoalService } from "../goals/service.js";
import { isUserFacingArtifact, scanGoalProductArtifactsToday } from "../media/product-artifacts.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CACHE_TTL_MS = 30_000;

interface DayBounds {
	iso: string;
	lowerBound: number;
	upperBound: number;
}

function parseDateParam(raw: unknown): DayBounds | null {
	let target: Date;
	if (raw === undefined || raw === null || raw === "") {
		target = new Date();
	} else {
		if (typeof raw !== "string" || !DATE_RE.test(raw)) return null;
		const [yStr, mStr, dStr] = raw.split("-");
		const y = Number(yStr);
		const m = Number(mStr);
		const d = Number(dStr);
		if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
		target = new Date(y, m - 1, d);
		if (
			target.getFullYear() !== y ||
			target.getMonth() !== m - 1 ||
			target.getDate() !== d
		) {
			return null;
		}
	}
	const start = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 0, 0, 0, 0);
	const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
	const iso = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
	return { iso, lowerBound: start.getTime(), upperBound: end.getTime() };
}

async function countArtifactsForDay(
	workspaceDir: string,
	goalId: string,
	lower: number,
	upper: number,
): Promise<number> {
	try {
		const entries = await scanGoalProductArtifactsToday(workspaceDir, goalId, lower, upper);
		return entries.filter((entry) => isUserFacingArtifact(entry.name, entry.source)).length;
	} catch {
		return 0;
	}
}

function isLiveOnDay(
	workspaceDir: string,
	goalId: string,
	updatedAt: string,
	liveCutoffMs: number,
): boolean {
	let lastActivityMs = Date.parse(updatedAt);
	if (!Number.isFinite(lastActivityMs)) lastActivityMs = 0;
	try {
		const ctx = statSync(join(workspaceDir, goalId, "context.jsonl"));
		if (ctx.mtimeMs > lastActivityMs) lastActivityMs = ctx.mtimeMs;
	} catch {
		// no context.jsonl yet — keep updatedAt
	}
	return lastActivityMs >= liveCutoffMs;
}

interface CacheEntry {
	value: TodayRollup;
	expiresAt: number;
}

export interface TodayRouterHandle {
	router: Router;
	/**
	 * Drop the cached rollup for every date. Call this whenever goal CRUD
	 * (create/delete/rename) mutates the underlying set so the next
	 * `GET /api/today` does not serve a stale `liveGoals` count from the 30s
	 * TTL window.
	 */
	invalidate: () => void;
}

export function createTodayRouter(workspaceDir: string, goals: GoalService): TodayRouterHandle {
	const router = Router();
	const cache = new Map<string, CacheEntry>();

	router.get("/api/today", async (req, res) => {
		const parsed = parseDateParam(req.query.date);
		if (!parsed) {
			res.status(400).json({ error: "date must be YYYY-MM-DD" });
			return;
		}
		const { iso, lowerBound, upperBound } = parsed;

		const cached = cache.get(iso);
		const now = Date.now();
		if (cached && cached.expiresAt > now) {
			res.json(cached.value);
			return;
		}

		const goalSummaries = goals.listGoals();

		// liveGoals 用 24h 滚动窗口对齐 GoalSummary.fresh(P0.1 口径),仅 today 生效;
		// 历史 date 仍按那一天的 midnight 切。
		const isToday = upperBound > now;
		const liveCutoffMs = isToday ? now - 24 * 60 * 60 * 1000 : lowerBound;

		const perGoal = await Promise.all(
			goalSummaries.map(async (goal) => {
				const live = isLiveOnDay(workspaceDir, goal.id, goal.updatedAt, liveCutoffMs) ? 1 : 0;

				let products = 0;
				try {
					products = await countArtifactsForDay(workspaceDir, goal.id, lowerBound, upperBound);
				} catch {
					products = 0;
				}

				return { live, products };
			}),
		);

		const rollup: TodayRollup = {
			date: iso,
			liveGoals: perGoal.reduce((acc, x) => acc + x.live, 0),
			productsToday: perGoal.reduce((acc, x) => acc + x.products, 0),
		};

		cache.set(iso, { value: rollup, expiresAt: now + CACHE_TTL_MS });
		res.json(rollup);
	});

	return {
		router,
		invalidate: () => {
			cache.clear();
		},
	};
}
