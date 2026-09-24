import { Router } from "express";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, promises as fsp, readFileSync, statSync, writeFileSync } from "fs";
import { extname, join, basename } from "path";
import type { GoalService } from "../goals/service.js";
import { probeDurationSec } from "../audio/ffmpeg.js";
import { daemonRunDir, runIdNow } from "../workspaces/goal-runtime-paths.js";
import type { GoalActivityItem } from "../events/activity-store.js";
import { publish } from "../events/event-bus.js";
import { resolveProductArtifactPath } from "./product-artifacts.js";
import { MediaProductJobs, type MediaProductJob } from "./product-jobs.js";
import type { MediaProductStatus } from "../../shared/types.js";
import {
	extractMarkdownTitle,
	generateSingleNarratorPodcast,
	publishPodcastBundle,
} from "./podcast/runtime.js";
import {
	resolvePodcastGenerationBrief,
	type PodcastGenerationBrief,
} from "./podcast/preferences.js";
import type { ResolvedOutputLanguage } from "../../shared/languages.js";
import { clipSummary, toErrorMessage } from "../lib/values.js";

export type { MediaProductStatus } from "../../shared/types.js";

interface MediaMeta {
	generatedAt: string;
	bytes: number;
	provider: string;
	model?: string;
	voice: string;
	durationSec?: number;
	sourceMtimeMs: number;
	/** Free-form payload. Passed through to the `/status` response under
	 * `meta.extra` so MediaCard callers can render card-specific UI without a
	 * second fetch. */
	extra?: Record<string, unknown>;
}

interface SseEvent {
	type: "status";
	cardId: string;
	status?: MediaProductStatus;
	jobId?: string;
	error?: string;
	bytes?: number;
	durationSec?: number;
	generatedAt?: string;
	mediaUrl?: string;
	extra?: Record<string, unknown>;
	/** Free-form human-readable progress message while `status === "running"`. */
	progress?: string;
	ts: string;
}

function productsDir(workspaceDir: string, goalId: string, cardId: string): string {
	return join(workspaceDir, goalId, ".media-products", cardId);
}

function safeCardId(raw: string): string | null {
	if (!raw) return null;
	if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) return null;
	return raw;
}

function cleanString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

const PATH_CARD_ID_PREFIX = "path_";

function sourceNameFromCardId(cardId: string): string | null {
	if (cardId.startsWith(PATH_CARD_ID_PREFIX)) {
		const encoded = cardId.slice(PATH_CARD_ID_PREFIX.length);
		try {
			const decoded = Buffer.from(encoded, "base64url").toString("utf8");
			if (!decoded || decoded.includes("\\") || decoded.split("/").includes("..")) return null;
			return `${decoded}.md`;
		} catch {
			return null;
		}
	}
	return `${cardId}.md`;
}

function resolveMarkdownSource(
	workspaceDir: string,
	goalId: string,
	cardId: string,
): { abs: string; mtimeMs: number } | null {
	const sourceName = sourceNameFromCardId(cardId);
	if (!sourceName) return null;
	let abs: string;
	try {
		abs = resolveProductArtifactPath(workspaceDir, goalId, sourceName);
	} catch {
		return null;
	}
	if (!existsSync(abs)) return null;
	try {
		const stat = statSync(abs);
		if (!stat.isFile()) return null;
		return { abs, mtimeMs: stat.mtimeMs };
	} catch {
		return null;
	}
}

function readMeta(workspaceDir: string, goalId: string, cardId: string): MediaMeta | null {
	const metaPath = join(productsDir(workspaceDir, goalId, cardId), "podcast-ai.meta.json");
	if (!existsSync(metaPath)) return null;
	try {
		const raw = readFileSync(metaPath, "utf-8");
		const parsed = JSON.parse(raw) as MediaMeta;
		return parsed;
	} catch {
		return null;
	}
}

const PODCAST_EPISODE_EXTS = ["mp3", "wav", "aiff", "m4a"] as const;
const PODCAST_EPISODE_MIME: Record<string, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	aiff: "audio/aiff",
	m4a: "audio/mp4",
};

/** Resolve the rendered episode under podcasts/<slug>/. The server pipeline
 * writes episode.mp3; digest-clipper may use other containers. This is the
 * single source of truth. There is no .media-products mirror copy. */
function resolvePodcastEpisode(
	workspaceDir: string,
	goalId: string,
	slug: string,
): { abs: string; ext: string } | null {
	const dir = join(workspaceDir, goalId, "podcasts", slug);
	for (const ext of PODCAST_EPISODE_EXTS) {
		const abs = join(dir, `episode.${ext}`);
		if (existsSync(abs)) return { abs, ext };
	}
	return null;
}

/** Card to podcast slug. The pointer metadata is authoritative. */
function podcastSlugForCard(workspaceDir: string, goalId: string, cardId: string): string | null {
	const rawSlug = readMeta(workspaceDir, goalId, cardId)?.extra?.slug;
	return typeof rawSlug === "string" && rawSlug ? rawSlug : null;
}

function mediaUrlFor(goalId: string, cardId: string): string {
	return `/api/goals/${encodeURIComponent(goalId)}/media-products/${encodeURIComponent(cardId)}/media`;
}

function broadcast(goalId: string, cardId: string, event: SseEvent): void {
	if (event.status) {
		publish({
			...event,
			type: "media-product:status",
			goalId,
			cardId,
			status: event.status,
		});
	}
}

function statusEvent(
	goalId: string,
	cardId: string,
	status: MediaProductStatus,
	extra: Partial<SseEvent> = {},
): SseEvent {
	const base: SseEvent = {
		type: "status",
		cardId,
		status,
		ts: new Date().toISOString(),
		...extra,
	};
	if (status === "done") base.mediaUrl = mediaUrlFor(goalId, cardId);
	return base;
}

function currentStatus(
	jobStore: MediaProductJobs,
	workspaceDir: string,
	goalId: string,
	cardId: string,
): {
	status: MediaProductStatus;
	jobId?: string;
	mediaUrl?: string;
	error?: string;
	bytes?: number;
	durationSec?: number;
	generatedAt?: string;
	extra?: Record<string, unknown>;
} {
	const job = jobStore.get(goalId, cardId);
	if (job && job.status === "running") {
		return { status: "running", jobId: job.jobId };
	}
	if (job && job.status === "failed") {
		return { status: "failed", jobId: job.jobId, error: job.error };
	}
	const meta = readMeta(workspaceDir, goalId, cardId);
	if (meta) {
		const rawSlug = meta.extra?.slug;
		const slug = typeof rawSlug === "string" && rawSlug ? rawSlug : sanitizePodcastSlug(cardId);
		const episode = resolvePodcastEpisode(workspaceDir, goalId, slug);
		if (episode) {
			if (meta.durationSec === undefined) {
				const probed = probeDurationSec(episode.abs);
				if (probed !== undefined) meta.durationSec = probed;
			}
			return {
				status: "done",
				mediaUrl: mediaUrlFor(goalId, cardId),
				bytes: meta.bytes,
				durationSec: meta.durationSec,
				generatedAt: meta.generatedAt,
				extra: {
					...meta.extra,
					provider: meta.provider,
					...(meta.model ? { model: meta.model } : {}),
					voice: meta.voice,
				},
			};
		}
	}
	return { status: "idle" };
}

/* ------------------------------------------------------------------ */
/* podcast-ai                                                         */
/* ------------------------------------------------------------------ */

export interface PodcastAiConfig {
	resolveGenerationBrief?: (
		goalId: string,
		generationInstruction?: string,
	) => Promise<PodcastGenerationBrief>;
	resolveOutputLanguage?: (goalId: string, sourceText: string) => ResolvedOutputLanguage;
}

export interface MediaProductsActivityHooks {
	onActivity?: (item: Omit<GoalActivityItem, "updatedAt"> & { updatedAt?: number }) => void;
}

/** podcast slug regex (matches `media/podcast/api.ts` SLUG_RE). cardId can drift
 * outside this range (e.g. contain underscores in mid-position is fine, but
 * a leading underscore or non-ASCII trips it). Sanitize defensively. */
const PODCAST_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const PODCAST_SLUG_FALLBACK_PREFIX = "podcast-ai-";

function sanitizePodcastSlug(cardId: string): string {
	let slug = cardId
		.normalize("NFKD")
		.replace(/[^\x00-\x7F]/g, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^[^a-zA-Z0-9]+/, "")
		.replace(/-+/g, "-")
		.slice(0, 60);
	if (!slug || !PODCAST_SLUG_RE.test(slug)) {
		// Reasonable fallback: timestamp suffix keeps it unique-ish.
		const stamp = Date.now().toString(36);
		slug = `${PODCAST_SLUG_FALLBACK_PREFIX}${stamp}`;
	}
	return slug;
}

async function runPodcastAiJob(
	jobStore: MediaProductJobs,
	workspaceDir: string,
	goalId: string,
	cardId: string,
	job: MediaProductJob,
	cfg: PodcastAiConfig,
	hooks: MediaProductsActivityHooks = {},
	generationInstruction?: string,
): Promise<void> {
	const activityId = `${goalId}:podcast:${job.jobId}`;
	// The one user-facing name of this job, read from the source report once it is loaded. The cardId
	// addresses the source and stays internal, so a record made before the report is read has no name.
	let sourceTitle: string | undefined;
	const record = (
		action: string,
		status: GoalActivityItem["status"],
		detail?: string,
		extra?: Partial<Pick<GoalActivityItem, "finishedAt">>,
	) => {
		hooks.onActivity?.({
			id: activityId,
			goalId,
			kind: "podcast",
			agent: "Podcast AI",
			action,
			status,
			runId: job.jobId,
			detail,
			...(sourceTitle ? { sourceTitle } : {}),
			startedAt: job.startedAt,
			...extra,
		});
	};
	const fail = (reason: string) => {
		jobStore.save({ ...job, status: "failed", error: reason });
		record("生成播客失败", "error", reason, { finishedAt: Date.now() });
		broadcast(goalId, cardId, statusEvent(goalId, cardId, "failed", {
			jobId: job.jobId,
			error: reason,
		}));
	};

	const source = resolveMarkdownSource(workspaceDir, goalId, cardId);
	if (!source) {
		fail(`markdown source not found: artifacts/${cardId}.md`);
		return;
	}

	let sourceText: string;
	try {
		sourceText = await fsp.readFile(source.abs, "utf-8");
	} catch (err) {
		fail(toErrorMessage(err));
		return;
	}
	sourceTitle = clipSummary(extractMarkdownTitle(sourceText) ?? "") || undefined;

	const goalDir = join(workspaceDir, goalId);
	const slug = sanitizePodcastSlug(cardId);
	const podcastDir = join(goalDir, "podcasts", slug);
	const episodePath = join(podcastDir, "episode.mp3");
	const sessionDir = daemonRunDir(goalDir, "podcast-ai", runIdNow());
	mkdirSync(sessionDir, { recursive: true });

	let lastProgress = "初始化";
	record("初始化播客生成", "running");
	broadcast(goalId, cardId, statusEvent(goalId, cardId, "running", {
		jobId: job.jobId,
		progress: lastProgress,
	}));
	const emitProgress = (next: string) => {
		if (next === lastProgress) return;
		lastProgress = next;
		record(`播客生成：${next}`, "running");
		broadcast(goalId, cardId, statusEvent(goalId, cardId, "running", {
			jobId: job.jobId,
			progress: next,
		}));
	};

	let generated: Awaited<ReturnType<typeof generateSingleNarratorPodcast>>;
	try {
		emitProgress("整理播客偏好");
		const generationBrief = await (cfg.resolveGenerationBrief
			? cfg.resolveGenerationBrief(goalId, generationInstruction)
			: resolvePodcastGenerationBrief({ goalId, generationInstruction }));
		writeFileSync(
			join(sessionDir, "podcast-generation-brief.json"),
			`${JSON.stringify(generationBrief, null, 2)}\n`,
			"utf-8",
		);
		generated = await generateSingleNarratorPodcast({
			cardId,
			slug,
			sourceText,
			language: cfg.resolveOutputLanguage?.(goalId, sourceText),
			sessionDir,
			generationBrief,
			emitProgress,
			observe: (line) => console.log(`[telomi][podcast-ai] ${line}`),
			signal: new AbortController().signal,
			skillWorkspaceDirectory: goalDir,
		});
		emitProgress("发布播客");
		await publishPodcastBundle(generated.stagingDir, podcastDir, job.jobId);
		if (!existsSync(episodePath) || statSync(episodePath).size <= 0) {
			throw new Error(`Podcast publication produced no episode at ${episodePath}`);
		}
		emitProgress("完成");
	} catch (err) {
		fail(toErrorMessage(err));
		return;
	}

	const outDir = productsDir(workspaceDir, goalId, cardId);
	mkdirSync(outDir, { recursive: true });
	const meta: MediaMeta = {
		generatedAt: new Date().toISOString(),
		bytes: generated.bytes,
		provider: generated.provider,
		...(generated.model ? { model: generated.model } : {}),
		voice: generated.voice ?? "",
		durationSec: generated.durationSec ?? probeDurationSec(episodePath),
		sourceMtimeMs: source.mtimeMs,
		extra: {
			slug,
			podcastDir: `podcasts/${slug}`,
			title: generated.title,
			writingMode: generated.writingMode,
			scriptModel: generated.scriptModel,
			sectionCount: generated.sectionCount,
			blockCount: generated.blockCount,
			sourceRef: { type: "media-card", ref: cardId },
		},
	};
	writeFileSync(
		join(outDir, "podcast-ai.meta.json"),
		`${JSON.stringify(meta, null, 2)}\n`,
		"utf-8",
	);

	jobStore.save({ ...job, status: "done" });
	// The report title travels as `sourceTitle` for every record of this job; the generation facts
	// stay in `podcast-ai.meta.json`, so `detail` keeps carrying diagnostics only.
	record("播客生成完成", "done", undefined, { finishedAt: Date.now() });
	broadcast(goalId, cardId, statusEvent(goalId, cardId, "done", {
		jobId: job.jobId,
		bytes: meta.bytes,
		durationSec: meta.durationSec,
		generatedAt: meta.generatedAt,
		extra: meta.extra,
	}));
}

function resolveGoalId(goals: GoalService, raw: string): string | null {
	const goal = goals.getGoal(raw);
	return goal ? goal.id : null;
}

export function createPodcastGenerator(
	workspaceDir: string,
	cfg?: PodcastAiConfig,
	hooks: MediaProductsActivityHooks = {},
) {
	const jobStore = new MediaProductJobs(workspaceDir);
	return {
		status: (goalId: string, cardId: string) => currentStatus(jobStore, workspaceDir, goalId, cardId),
		available: Boolean(cfg),
		start(input: { goalId: string; cardId: string; generationInstruction?: string }): MediaProductJob {
			if (!cfg) throw new Error("podcast-ai is not available");
			const goalId = input.goalId.trim();
			const cardId = safeCardId(input.cardId);
			if (!goalId || !cardId) throw new Error("Podcast generation target is invalid");
			if (!resolveMarkdownSource(workspaceDir, goalId, cardId)) {
				throw new Error(`artifacts/${cardId}.md not found`);
			}
			const generationInstruction = input.generationInstruction?.trim();
			if (generationInstruction && generationInstruction.length > 2_000) {
				throw new Error("Podcast generation instruction is too long");
			}
			const existing = jobStore.get(goalId, cardId);
			if (existing?.status === "running") return existing;
			const job: MediaProductJob = {
				jobId: `job_${randomUUID()}`,
				goalId,
				cardId,
				updatedAt: Date.now(),
				status: "running",
				startedAt: Math.max(Date.now(), (existing?.startedAt ?? 0) + 1),
			};
			jobStore.save(job);
			broadcast(goalId, cardId, statusEvent(goalId, cardId, "running", { jobId: job.jobId }));
			void runPodcastAiJob(jobStore, workspaceDir, goalId, cardId, job, cfg, hooks, generationInstruction).catch((error) => {
				const reason = toErrorMessage(error);
				jobStore.save({ ...job, status: "failed", error: reason });
				hooks.onActivity?.({
					id: `${goalId}:podcast:${job.jobId}`,
					goalId,
					kind: "podcast",
					agent: "Podcast AI",
					action: "生成播客失败",
					status: "error",
					runId: job.jobId,
					detail: reason,
					startedAt: job.startedAt,
					finishedAt: Date.now(),
				});
				broadcast(goalId, cardId, statusEvent(goalId, cardId, "failed", {
					jobId: job.jobId,
					error: reason,
				}));
			});
			return job;
		},
	};
}

export function createMediaProductsRouter(
	workspaceDir: string,
	goals: GoalService,
	podcastGenerator: ReturnType<typeof createPodcastGenerator>,
): Router {
	const router = Router();

	router.get("/api/goals/:goalId/media-products/:cardId/status", (req, res) => {
		const goalId = resolveGoalId(goals, req.params.goalId);
		if (!goalId) return res.status(404).json({ error: "goal not found" });
		const cardId = safeCardId(req.params.cardId);
		if (!cardId) return res.status(400).json({ error: "invalid cardId" });
		const source = resolveMarkdownSource(workspaceDir, goalId, cardId);
		if (!source) return res.status(404).json({ error: `artifacts/${cardId}.md not found` });
		const podcast = {
			...podcastGenerator.status(goalId, cardId),
			implemented: podcastGenerator.available,
		};
		res.json({ cardId, sourceMtimeMs: source.mtimeMs, podcast });
	});

	router.post("/api/goals/:goalId/media-products/:cardId/generate", (req, res) => {
		const goalId = resolveGoalId(goals, req.params.goalId);
		if (!goalId) return res.status(404).json({ error: "goal not found" });
		const cardId = safeCardId(req.params.cardId);
		if (!cardId) return res.status(400).json({ error: "invalid cardId" });
		if (!podcastGenerator.available) return res.status(503).json({ error: "podcast generation is unavailable" });
		try {
			const job = podcastGenerator.start({
				goalId,
				cardId,
				generationInstruction: cleanString(req.body?.instruction),
			});
			return res.json({ jobId: job.jobId, status: "running" });
		} catch (error) {
			return res.status(400).json({ error: toErrorMessage(error) });
		}
	});

	router.get("/api/goals/:goalId/media-products/:cardId/media", (req, res) => {
		const goalId = resolveGoalId(goals, req.params.goalId);
		if (!goalId) return res.status(404).json({ error: "goal not found" });
		const cardId = safeCardId(req.params.cardId);
		if (!cardId) return res.status(400).json({ error: "invalid cardId" });
		const slug = podcastSlugForCard(workspaceDir, goalId, cardId);
		if (!slug) return res.status(404).json({ error: `media metadata missing for ${cardId}` });
		const episode = resolvePodcastEpisode(workspaceDir, goalId, slug);
		if (!episode) return res.status(404).json({ error: `media not ready for ${cardId}` });

		res.setHeader("Content-Type", PODCAST_EPISODE_MIME[episode.ext] ?? "audio/mpeg");
		res.setHeader("Accept-Ranges", "bytes");
		res.setHeader("Cache-Control", "no-cache");
		res.sendFile(episode.abs);
	});

	return router;
}

// Surfacing the basename-no-ext helper since the frontend computes the same
// mapping from `.md` artifact filename. Keep both sides on the same rule:
// take the filename, strip a single trailing `.md` extension.
export function cardIdFromArtifactName(name: string): string | null {
	if (extname(name).toLowerCase() !== ".md") return null;
	const normalized = name.replace(/\\/g, "/");
	const withoutExt = normalized.slice(0, -".md".length);
	if (!withoutExt.includes("/")) return basename(name, ".md");
	return `${PATH_CARD_ID_PREFIX}${Buffer.from(withoutExt, "utf8").toString("base64url")}`;
}
