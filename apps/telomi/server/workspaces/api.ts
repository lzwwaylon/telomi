import { Router } from "express";
import { existsSync, statSync, openSync, readSync, closeSync, promises as fsp } from "fs";
import { extname, join, basename } from "path";

import { basenameNoExt, isFileNameSegment } from "../lib/paths.js";
import { listFilesRecursive } from "../lib/fs.js";
import { clipSummary, toErrorMessage } from "../lib/values.js";
import type { GoalService } from "../goals/service.js";
import { openMainAgentFiles } from "./main-agent-files.js";
import { attachmentDisplayPaths, isParserInternalFile, workspaceDisplayPath } from "./workspace-display.js";

const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "aac", "aiff"]);

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
			if (
				/^[-*+>]\s+/.test(trimmed) ||
				/^\d+\.\s+/.test(trimmed) ||
				/^```/.test(trimmed) ||
				/^\|/.test(trimmed)
			) {
				if (inSummary) break;
				continue;
			}
			inSummary = true;
			paraLines.push(trimmed);
			if (paraLines.join(" ").length >= SUMMARY_LIMIT * 2) break;
		}
		const summary = paraLines.length ? clipSummary(paraLines.join(" ")) : undefined;
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

const MIME_BY_EXT: Record<string, string> = {
	html: "text/html; charset=utf-8",
	htm: "text/html; charset=utf-8",
	svg: "image/svg+xml",
	md: "text/markdown; charset=utf-8",
	markdown: "text/markdown; charset=utf-8",
	txt: "text/plain; charset=utf-8",
	log: "text/plain; charset=utf-8",
	json: "application/json; charset=utf-8",
	jsonl: "application/x-ndjson; charset=utf-8",
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
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	ogg: "audio/ogg",
	flac: "audio/flac",
	aac: "audio/aac",
	aiff: "audio/aiff",
};

function mimeFor(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

interface WorkspaceFile {
	path: string;
	/** Label path when the guest path carries a storage key; absent when the path is already the user's own name. */
	displayPath?: string;
	size: number;
	modifiedAt: string;
	mtimeMs: number;
	title?: string;
	summary?: string;
}

async function projectWorkspaceFiles(
	view: ReturnType<typeof openMainAgentFiles>,
	goalDir: string,
	recordedNames: Map<string, string>,
): Promise<WorkspaceFile[]> {
	const out: WorkspaceFile[] = [];
	for (const mount of view.mounts) {
		let paths: string[];
		try { paths = listFilesRecursive(mount.hostPath); } catch { continue; }
		for (const relativePath of paths) {
			try {
				const file = view.resolve(`${mount.guestPath}/${relativePath}`);
				if (file.kind !== "file") continue;
				if (isParserInternalFile(file.path)) continue;
				const stat = await fsp.lstat(file.absolutePath);
				if (!stat.isFile() || stat.nlink !== 1) continue;
				const name = basename(relativePath);
				const head = readHeadMeta(file.absolutePath, name);
				out.push({ path: file.path, displayPath: workspaceDisplayPath(goalDir, file.path, recordedNames),
					size: stat.size, modifiedAt: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs,
					title: head.title ?? basenameNoExt(name), summary: head.summary });
			} catch { /* Files can disappear while Main Agent edits its workspace. */ }
		}
	}
	if (view.virtualFile) {
		const { path, content, modifiedAt } = view.virtualFile;
		out.push({ path, size: Buffer.byteLength(content), modifiedAt, mtimeMs: Date.parse(modifiedAt), title: basenameNoExt(path) });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function createWorkspaceRouter(workspaceDir: string, goals: GoalService): Router {
	const router = Router();

	router.use("/api/goals/:goalId/workspace", (req, res, next) => {
		if (!isFileNameSegment(req.params.goalId)) return res.status(400).json({ error: "Invalid Goal id" });
		if (!goals.getGoal(req.params.goalId)) return res.status(404).json({ error: "Goal not found" });
		next();
	});
	const goalDirOf = (goalId: string) => join(workspaceDir, goalId);
	const openView = (goalId: string) => openMainAgentFiles(goalDirOf(goalId), goals.getMainWorkspaceDirectories(goalId));

	router.get("/api/goals/:goalId/workspace/list", async (req, res) => {
		let view: ReturnType<typeof openMainAgentFiles> | undefined;
		try {
			view = openView(req.params.goalId);
			const recordedNames = attachmentDisplayPaths(goals.listAttachments(req.params.goalId));
			res.json({ files: await projectWorkspaceFiles(view, goalDirOf(req.params.goalId), recordedNames), truncated: false });
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		} finally { view?.close(); }
	});

	router.get("/api/goals/:goalId/workspace/blob", (req, res) => {
		const path = String(req.query.path ?? "");
		if (!path) return res.status(400).json({ error: "path query parameter required" });
		let abs: string;
		let view: ReturnType<typeof openMainAgentFiles> | undefined;
		try {
			view = openView(req.params.goalId);
			const file = view.resolve(path);
			res.setHeader("X-Workspace-Path", encodeURI(file.path));
			if (file.kind === "virtual") {
				res.setHeader("Cache-Control", "no-cache");
				return res.type(mimeFor(file.path)).send(file.content);
			}
			abs = file.absolutePath;
		} catch (err) {
			return res.status((err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400).json({ error: toErrorMessage(err) });
		} finally { view?.close(); }
		const base = basename(abs);
		if (!existsSync(abs)) return res.status(404).json({ error: `file ${path} not found` });
		let stat;
		try {
			stat = statSync(abs);
		} catch (err) {
			return res.status(500).json({ error: toErrorMessage(err) });
		}
		if (!stat.isFile() || stat.nlink !== 1) return res.status(400).json({ error: `path ${path} is not a regular file` });
		res.setHeader("Content-Type", mimeFor(abs));
		res.setHeader("Cache-Control", "no-cache");
		const ext = base.split(".").pop()?.toLowerCase() ?? "";
		if (AUDIO_EXTS.has(ext)) res.setHeader("Accept-Ranges", "bytes");
		res.sendFile(abs);
	});

	// Citation slices use the exact same guest-visible path boundary as full files.
	router.get("/api/goals/:goalId/workspace/file-slice", async (req, res) => {
		const path = String(req.query.path ?? "");
		if (!path) return res.status(400).json({ error: "path query parameter required" });
		const startRaw = Number(req.query.start);
		const endRaw = req.query.end != null ? Number(req.query.end) : NaN;
		if (!Number.isFinite(startRaw) || startRaw < 1) {
			return res.status(400).json({ error: "start must be a positive 1-based line number" });
		}
		const start = Math.floor(startRaw);
		const end =
			Number.isFinite(endRaw) && endRaw >= start ? Math.floor(endRaw) : start;

		let file: ReturnType<ReturnType<typeof openMainAgentFiles>["resolve"]>;
		let view: ReturnType<typeof openMainAgentFiles> | undefined;
		try {
			view = openView(req.params.goalId);
			file = view.resolve(path);
			res.setHeader("X-Workspace-Path", encodeURI(file.path));
		} catch (err) {
			return res.status((err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400).json({ error: toErrorMessage(err) });
		} finally { view?.close(); }
		const MAX_BYTES = 4 * 1024 * 1024;
		const MAX_LINES = 60;
		const CONTEXT_PADDING = 2;
		let text: string;
		try {
			if (file.kind === "virtual") text = file.content;
			else {
				const stat = statSync(file.absolutePath);
				if (!stat.isFile() || stat.nlink !== 1) return res.status(400).json({ error: `path ${path} is not a regular file` });
				if (stat.size > MAX_BYTES) return res.status(413).json({ error: `file ${path} too large for slice preview` });
				text = await fsp.readFile(file.absolutePath, "utf8");
			}
		} catch (err) {
			return res.status((err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500).json({ error: toErrorMessage(err) });
		}
		const lines = text.split(/\r?\n/);
		const totalLines = lines.length;
		const padStart = Math.max(1, start - CONTEXT_PADDING);
		const padEnd = Math.min(totalLines, end + CONTEXT_PADDING);
		const requested = padEnd - padStart + 1;
		// Trim to MAX_LINES, biased to keep the highlighted range visible.
		let outStart = padStart;
		let outEnd = padEnd;
		if (requested > MAX_LINES) {
			const center = Math.floor((start + end) / 2);
			outStart = Math.max(1, center - Math.floor(MAX_LINES / 2));
			outEnd = Math.min(totalLines, outStart + MAX_LINES - 1);
			outStart = Math.max(1, outEnd - MAX_LINES + 1);
		}
		const slice = lines.slice(outStart - 1, outEnd).map((text, i) => ({
			n: outStart + i,
			text,
		}));
		const ext = file.path.split(".").pop()?.toLowerCase() ?? "";
		res.setHeader("Cache-Control", "no-cache");
		res.json({
			path: file.path,
			lang: ext,
			start,
			end,
			sliceStart: outStart,
			sliceEnd: outEnd,
			totalLines,
			truncated: requested > MAX_LINES,
			lines: slice,
		});
	});

	return router;
}
