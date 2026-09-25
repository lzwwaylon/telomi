import { Router } from "express";
import { existsSync, openSync, readSync, closeSync } from "fs";
import { extname } from "path";

import { basenameNoExt } from "../lib/paths.js";
import { clipSummary, toErrorMessage } from "../lib/values.js";
import type { GoalService } from "../goals/service.js";
import type { ArtifactFeedItem } from "../../shared/types.js";
import {
	cardIdFromArtifactName,
	isUserFacingArtifact,
	goalRoot,
	resolveProductArtifactPath,
	scanGoalProductArtifacts,
	scanGoalProductArtifactsToday,
} from "./product-artifacts.js";
import { publishedReportForPath, REPORTS_GUEST_PATH } from "./report-view.js";
import { resolveCitationSourcePreview, resolveMessageCitationSourcePreview, resolveReportCoverAsset, type ReportCoverAsset } from "../citations/preview.js";

const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac", "aiff"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParam(raw: unknown): { iso: string; lowerBound: number; upperBound: number } | null {
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
		// Construct in server local TZ
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

const HEAD_BYTES = 4096;
const SUMMARY_LIMIT = 80;

interface HeadMeta {
	title?: string;
	summary?: string;
}

function readHeadMeta(absPath: string, name: string): HeadMeta {
	const ext = extname(name).toLowerCase();
	if (ext !== ".md" && ext !== ".markdown") return {};
	let fd: number | null = null;
	try {
		fd = openSync(absPath, "r");
		const buf = Buffer.alloc(HEAD_BYTES);
		const bytes = readSync(fd, buf, 0, HEAD_BYTES, 0);
		const text = buf.subarray(0, bytes).toString("utf8");
		const lines = text.split(/\r?\n/);
		let title: string | undefined;
		const paraLines: string[] = [];
		let titleIdx = -1;
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!title && /^#\s+/.test(trimmed)) {
				title = trimmed.replace(/^#\s+/, "").trim();
				titleIdx = i;
				break;
			}
		}
		const startIdx = titleIdx >= 0 ? titleIdx + 1 : 0;
		let inSummary = false;
		for (let i = startIdx; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed === "") {
				if (inSummary) break;
				continue;
			}
			if (/^#{1,6}\s+/.test(trimmed)) {
				if (inSummary) break;
				continue;
			}
			if (/^[-*+>]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed) || /^```/.test(trimmed) || /^\|/.test(trimmed)) {
				if (inSummary) break;
				continue;
			}
			inSummary = true;
			paraLines.push(trimmed);
			if (paraLines.join(" ").length >= SUMMARY_LIMIT * 2) break;
		}
		// Card ledes are plain text: drop bold/italic/code markers the report writer uses inline.
		const summary = paraLines.length ? clipSummary(paraLines.join(" ").replace(/\*\*|__|`/g, "")) : undefined;
		return { title, summary };
	} catch {
		return {};
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
	}
}

// Cover resolution walks citation json, source manifests and notes; the list is polled, so memoize per file version.
const coverCache = new Map<string, ReportCoverAsset | null>();
function cachedCover(absPath: string, name: string, mtimeMs: number): ReportCoverAsset | undefined {
	const ext = extname(name).toLowerCase();
	if (ext !== ".md" && ext !== ".markdown") return undefined;
	const key = `${absPath}:${mtimeMs}`;
	if (!coverCache.has(key)) coverCache.set(key, resolveReportCoverAsset(absPath));
	return coverCache.get(key) ?? undefined;
}

const MIME_BY_EXT: Record<string, string> = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	svg: "image/svg+xml",
	md: "text/markdown; charset=utf-8",
	markdown: "text/markdown; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	log: "text/plain; charset=utf-8",
	json: "application/json; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	tsv: "text/tab-separated-values; charset=utf-8",
	mmd: "text/plain; charset=utf-8",
	mermaid: "text/plain; charset=utf-8",
	diff: "text/x-diff; charset=utf-8",
	patch: "text/x-diff; charset=utf-8",
	pdf: "application/pdf",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.ms-excel",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	ico: "image/x-icon",
};

function mimeFor(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

const PER_GOAL_LIMIT = 3;

export function createArtifactsRouter(workspaceDir: string, goals: GoalService): Router {
	const router = Router();

	router.get(["/api/artifacts/today", "/api/artifacts/recent"], async (req, res) => {
		const parsed = /\/recent\/?$/i.test(req.path)
			? { iso: undefined, lowerBound: -Infinity, upperBound: Infinity }
			: parseDateParam(req.query.date);
		if (!parsed) {
			res.status(400).json({ error: "date must be YYYY-MM-DD" });
			return;
		}
		const { iso, lowerBound, upperBound } = parsed;

		const goalSummaries = goals.listGoals();
		const perGoalResults = await Promise.all(
			goalSummaries.map(async (goal) => {
				try {
					const entries = await scanGoalProductArtifactsToday(workspaceDir, goal.id, lowerBound, upperBound);
					const productEntries = entries.filter((e) => isUserFacingArtifact(e.name, e.source));
					productEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
					return productEntries.slice(0, PER_GOAL_LIMIT).map<ArtifactFeedItem>((e) => ({
						goalId: goal.id,
						goalTitle: goal.title,
						name: e.name,
						size: e.size,
						modifiedAt: new Date(e.mtimeMs).toISOString(),
						...readHeadMeta(resolveProductArtifactPath(workspaceDir, goal.id, e.name), e.name),
					}));
				} catch {
					return [] as ArtifactFeedItem[];
				}
			}),
		);

		const items = perGoalResults
			.flat()
			.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

		res.json({ date: iso, items });
	});

	router.get("/api/goals/:goalId/artifacts/list", (req, res) => {
		try {
			const files = scanGoalProductArtifacts(workspaceDir, req.params.goalId)
				.map((e) => {
					const abs = resolveProductArtifactPath(workspaceDir, req.params.goalId, e.name);
					const head = readHeadMeta(abs, e.name);
					const title = head.title ?? basenameNoExt(e.name);
					return {
						name: e.name,
						size: e.size,
						modifiedAt: new Date(e.mtimeMs).toISOString(),
						title,
						summary: head.summary,
						product: isUserFacingArtifact(e.name, e.source),
						cardId: cardIdFromArtifactName(e.name) ?? undefined,
						cover: cachedCover(abs, e.name, e.mtimeMs),
					};
				})
				.sort((a, b) => a.name.localeCompare(b.name));
			res.json({ files });
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	router.get("/api/goals/:goalId/artifacts/citations/preview", (req, res) => {
		const name = String(req.query.name ?? "");
		const messageId = String(req.query.messageId ?? "");
		const url = String(req.query.url ?? "");
		const number = req.query.number === undefined ? undefined : Number(req.query.number);
		if ((!name && !messageId) || !url) return res.status(400).json({ error: "name or messageId, and url query parameters required" });
		if (number !== undefined && (!Number.isInteger(number) || number < 1)) {
			return res.status(400).json({ error: "number must be a positive integer" });
		}
		try {
			if (!goals.getGoal(req.params.goalId)) return res.status(404).json({ error: "goal not found" });
			if (messageId) {
				const preview = resolveMessageCitationSourcePreview(goalRoot(workspaceDir, req.params.goalId), messageId, url, number);
				return preview ? res.json(preview) : res.status(404).json({ error: "citation preview not found" });
			}
			// A report opened from `/reports` cites through its published run, where the citation records live.
			const reportPath = name.startsWith(`${REPORTS_GUEST_PATH}/`)
				? publishedReportForPath(goalRoot(workspaceDir, req.params.goalId), name)?.reportFile ?? ""
				: resolveProductArtifactPath(workspaceDir, req.params.goalId, name);
			if (!existsSync(reportPath)) return res.status(404).json({ error: `artifact ${name} not found` });
			const preview = resolveCitationSourcePreview(reportPath, url, number);
			return preview ? res.json(preview) : res.status(404).json({ error: "citation preview not found" });
		} catch (err) {
			return res.status(400).json({ error: toErrorMessage(err) });
		}
	});

	router.get("/api/goals/:goalId/artifacts/blob", (req, res) => {
		const name = String(req.query.name ?? "");
		if (!name) return res.status(400).json({ error: "name query parameter required" });
		let abs: string;
		try {
			abs = resolveProductArtifactPath(workspaceDir, req.params.goalId, name);
		} catch (err) {
			return res.status(400).json({ error: toErrorMessage(err) });
		}
		if (!existsSync(abs)) return res.status(404).json({ error: `artifact ${name} not found` });
		res.setHeader("Content-Type", mimeFor(name));
		res.setHeader("Cache-Control", "no-cache");
		const ext = name.split(".").pop()?.toLowerCase() ?? "";
		if (AUDIO_EXTS.has(ext)) res.setHeader("Accept-Ranges", "bytes");
		res.sendFile(abs);
	});

	return router;
}
