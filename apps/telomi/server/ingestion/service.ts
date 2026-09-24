import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	} from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { JsonDocumentStore } from "../lib/json-document-store.js";
import { sha256 } from "../lib/hash.js";
import { envNumber } from "../lib/env.js";
import { sanitizeFileName } from "../lib/paths.js";

import {
	fileIngestCacheEntryDir,
	fileIngestJobsDir,
} from "../workspaces/goal-runtime-paths.js";
import { convertLocalDocument, type LocalDocumentConverters } from "../research/documents/local-document.js";
import type {
	FileIngestJob,
	FileIngestRequest,
	FileIngestResult,
	FileIngestServiceEvent,
} from "./types.js";
import { writeFileAtomic, writeJsonAtomic } from "../lib/fs.js";
import { publishParsedDocuments } from "./parsed-documents.js";
import { toErrorMessage } from "../lib/values.js";

interface QueueRef {
	goalId: string;
	jobId: string;
}

export interface FileIngestServiceOptions extends LocalDocumentConverters {
	workspaceDir: string;
	listGoalIds: () => string[];
	concurrency?: number;
	maxBytes?: number;
	requestTimeoutMs?: number;
	onEvent?: (event: FileIngestServiceEvent) => void;
}

const STATE_VERSION = 1 as const;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;



function isTerminal(job: FileIngestJob): boolean {
	return job.status === "done" || job.status === "error";
}

function parseJob(value: unknown): FileIngestJob | null {
	try {
		const parsed = value as Partial<FileIngestJob>;
		if (!parsed || parsed.version !== STATE_VERSION || typeof parsed.id !== "string") return null;
		if (typeof parsed.goalId !== "string" || typeof parsed.inputPath !== "string") return null;
		if (parsed.kind !== "local") return null;
		if (typeof parsed.absInputPath !== "string" || !isAbsolute(parsed.absInputPath)) return null;
		if (typeof parsed.cacheKey !== "string" || !/^[a-f0-9]{64}$/u.test(parsed.cacheKey)) return null;
		if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt))) return null;
		if (typeof parsed.updatedAt !== "string" || !Number.isFinite(Date.parse(parsed.updatedAt))) return null;
		if (typeof parsed.attempts !== "number" || !Number.isInteger(parsed.attempts) || parsed.attempts < 0) return null;
		if (typeof parsed.maxAttempts !== "number" || !Number.isInteger(parsed.maxAttempts) || parsed.maxAttempts < 1) return null;
		if (parsed.status !== "queued" && parsed.status !== "running" && parsed.status !== "done" && parsed.status !== "error") return null;
		return {
			version: STATE_VERSION,
			id: parsed.id,
			goalId: parsed.goalId,
			kind: "local",
			inputPath: parsed.inputPath,
			absInputPath: parsed.absInputPath,
			key: typeof parsed.key === "string" ? parsed.key : undefined,
			source: typeof parsed.source === "string" ? parsed.source : undefined,
			title: typeof parsed.title === "string" ? parsed.title : undefined,
			requestedBy: typeof parsed.requestedBy === "string" ? parsed.requestedBy : undefined,
			cacheKey: parsed.cacheKey,
			status: parsed.status,
			createdAt: parsed.createdAt,
			updatedAt: parsed.updatedAt,
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
			finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : undefined,
			attempts: parsed.attempts,
			maxAttempts: parsed.maxAttempts,
			error: typeof parsed.error === "string" ? parsed.error : undefined,
			result: parsed.result as FileIngestResult | undefined,
		};
	} catch {
		return null;
	}
}

function resolveInputPath(input: string): { absPath: string; stats: Stats } {
	if (typeof input !== "string" || input.trim().length === 0) {
		throw new Error("inputPath is required");
	}
	if (!isAbsolute(input)) {
		throw new Error(`inputPath must be an absolute path: ${input}`);
	}
	const absPath = normalize(resolve(input));
	let stats: Stats;
	try {
		stats = statSync(absPath);
	} catch (err) {
		throw new Error(`inputPath not readable: ${absPath} (${toErrorMessage(err)})`);
	}
	if (!stats.isFile()) {
		throw new Error(`inputPath is not a regular file: ${absPath}`);
	}
	return { absPath, stats };
}

export class FileIngestService {
	private readonly opts: Required<Omit<FileIngestServiceOptions,
		"onEvent" | "documentParser" | "transcribeAudio" | "prepareAudio">>;
	private readonly listeners = new Set<(event: FileIngestServiceEvent) => void>();
	private readonly queue: QueueRef[] = [];
	private readonly active = new Map<string, Promise<void>>();
	private readonly converters: LocalDocumentConverters;
	private readonly waiters = new Set<() => void>();
	private stopped = true;

	constructor(opts: FileIngestServiceOptions) {
		const concurrency = envNumber("TELOMI_FILE_INGEST_CONCURRENCY", DEFAULT_CONCURRENCY);
		const maxBytes = envNumber("TELOMI_FILE_INGEST_MAX_BYTES", DEFAULT_MAX_BYTES);
		const requestTimeoutMs = envNumber("TELOMI_FILE_INGEST_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
		this.opts = {
			workspaceDir: opts.workspaceDir,
			listGoalIds: opts.listGoalIds,
			concurrency: opts.concurrency ?? (concurrency > 0 ? Math.floor(concurrency) : DEFAULT_CONCURRENCY),
			maxBytes: opts.maxBytes ?? (maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES),
			requestTimeoutMs: opts.requestTimeoutMs ?? (requestTimeoutMs > 0 ? Math.floor(requestTimeoutMs) : DEFAULT_TIMEOUT_MS),
		};
		this.converters = {
			documentParser: opts.documentParser,
			transcribeAudio: opts.transcribeAudio,
			prepareAudio: opts.prepareAudio,
		};
		if (opts.onEvent) this.listeners.add(opts.onEvent);
	}

	get config(): Readonly<typeof this.opts> {
		return this.opts;
	}

	subscribe(listener: (event: FileIngestServiceEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	start({ resumeQueued = true }: { resumeQueued?: boolean } = {}): void {
		this.stopped = false;
		const resumed = resumeQueued ? this.resumeQueuedJobs() : 0;
		if (resumed > 0) this.emit({ type: "resume", message: `resumed ${resumed} ingestion jobs` });
		this.pump();
	}

	stop(): void {
		this.stopped = true;
		// Release waiters rather than leaving them pending until their own timeout.
		for (const release of [...this.waiters]) release();
	}

	/**
	 * Resolve once the job reaches a terminal state (done/error). A cache hit resolves
	 * immediately. On timeout or on stop the job is returned in its current non-terminal
	 * state, so callers can tell "not finished" apart from "failed"; an unknown job is null.
	 * Wakeups come from this process's own queue events, so a job finished by another
	 * process resolves only when the timeout re-reads it from disk.
	 */
	async waitForJob(goalId: string, jobId: string, timeoutMs = this.opts.requestTimeoutMs): Promise<FileIngestJob | null> {
		const job = this.readJob(goalId, jobId);
		if (!job || isTerminal(job)) return job;
		return new Promise<FileIngestJob | null>((resolve) => {
			const release = () => {
				clearTimeout(timer);
				unsubscribe();
				this.waiters.delete(release);
				resolve(this.readJob(goalId, jobId));
			};
			const timer = setTimeout(release, Math.max(0, timeoutMs));
			const unsubscribe = this.subscribe((event) => {
				if (event.goalId !== goalId || event.jobId !== jobId) return;
				const current = this.readJob(goalId, jobId);
				if (current && isTerminal(current)) release();
			});
			this.waiters.add(release);
		});
	}

	async enqueue(goalId: string, req: FileIngestRequest): Promise<FileIngestJob> {
		const { absPath, stats } = resolveInputPath(req.inputPath);
		if (stats.size > this.opts.maxBytes) {
			throw new Error(`file too large: bytes=${stats.size} max=${this.opts.maxBytes}`);
		}
		const goalDir = this.goalDir(goalId);
		if (!existsSync(goalDir)) throw new Error(`goal not found: ${goalId}`);

		const cacheKey = sha256(`${absPath}:${stats.mtimeMs}:${stats.size}`);
		const existing = req.force ? null : this.resultFromCache(goalId, cacheKey);
		// A cache hit skips performIngest, so the mount mirror is refreshed here too.
		if (existing) publishParsedDocuments(goalDir, existing);
		const now = new Date().toISOString();
		const job: FileIngestJob = {
			version: STATE_VERSION,
			id: `ing_${now.replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`,
			goalId,
			kind: "local",
			inputPath: req.inputPath,
			absInputPath: absPath,
			key: req.key?.trim() || undefined,
			source: req.source?.trim() || undefined,
			title: req.title?.trim() || undefined,
			requestedBy: req.requestedBy?.trim() || undefined,
			cacheKey,
			status: existing ? "done" : "queued",
			createdAt: now,
			updatedAt: now,
			finishedAt: existing ? now : undefined,
			attempts: 0,
			maxAttempts: 2,
			result: existing ?? undefined,
		};
		this.saveJob(job);
		if (!existing) {
			this.queue.push({ goalId, jobId: job.id });
			this.emit({ type: "queued", goalId, jobId: job.id, message: absPath });
			this.pump();
		}
		return job;
	}

	readJob(goalId: string, jobId: string): FileIngestJob | null {
		try {
			return parseJob(this.jobStore(goalId).get(jobId));
		} catch {
			return null;
		}
	}

	listJobs(goalId: string, limit = 50): FileIngestJob[] {
		let jobs: unknown[];
		try {
			jobs = this.jobStore(goalId).list();
		} catch {
			return [];
		}
		return jobs.map(parseJob)
			.filter((job): job is FileIngestJob => !!job)
			.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
			.slice(0, Math.max(1, limit));
	}

	private jobStore(goalId: string): JsonDocumentStore<unknown> {
		// Validate after reading so one corrupt job does not hide the remaining queue.
		return new JsonDocumentStore(fileIngestJobsDir(this.goalDir(goalId)));
	}

	private goalDir(goalId: string): string {
		return join(this.opts.workspaceDir, goalId);
	}

	private emit(event: FileIngestServiceEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* observers must not break ingest */
			}
		}
	}

	private saveJob(job: FileIngestJob): void {
		this.jobStore(job.goalId).put(job.id, job);
	}

	private resumeQueuedJobs(): number {
		let count = 0;
		for (const goalId of this.opts.listGoalIds()) {
			for (const job of this.listJobs(goalId, 500)) {
				if (job.status !== "queued" && job.status !== "running") continue;
				const next = job.status === "running"
					// running 被 server 重启打断:processRef 进场时已 attempts+1,但这次尝试没真正用完,
					// 归还一次,否则反复重启会很快耗尽 maxAttempts 把可恢复的 job 误判成 error。
					? { ...job, status: "queued" as const, attempts: Math.max(0, job.attempts - 1), updatedAt: new Date().toISOString(), error: "requeued after server restart (attempt refunded)" }
					: job;
				if (next !== job) this.saveJob(next);
				this.queue.push({ goalId, jobId: job.id });
				count += 1;
			}
		}
		return count;
	}

	private pump(): void {
		if (this.stopped) return;
		while (this.active.size < this.opts.concurrency && this.queue.length > 0) {
			const ref = this.queue.shift()!;
			const activeKey = `${ref.goalId}:${ref.jobId}`;
			if (this.active.has(activeKey)) continue;
			const promise = this.processRef(ref)
				.catch((err) => {
					this.emit({
						type: "error",
						goalId: ref.goalId,
						jobId: ref.jobId,
						message: toErrorMessage(err),
					});
				})
				.finally(() => {
					this.active.delete(activeKey);
					this.pump();
				});
			this.active.set(activeKey, promise);
		}
	}

	private async processRef(ref: QueueRef): Promise<void> {
		let job = this.readJob(ref.goalId, ref.jobId);
		if (!job || job.status !== "queued") return;
		const startedAt = new Date().toISOString();
		job = {
			...job,
			status: "running",
			attempts: job.attempts + 1,
			startedAt,
			updatedAt: startedAt,
			error: undefined,
		};
		this.saveJob(job);
		this.emit({ type: "started", goalId: job.goalId, jobId: job.id, message: job.absInputPath });

		try {
			const result = await this.performIngest(job);
			const finishedAt = new Date().toISOString();
			this.saveJob({
				...job,
				status: "done",
				result,
				finishedAt,
				updatedAt: finishedAt,
				error: undefined,
			});
			this.emit({ type: "finished", goalId: job.goalId, jobId: job.id, message: result.parsedStatus });
		} catch (err) {
			const message = toErrorMessage(err);
			const finishedAt = new Date().toISOString();
			if (job.attempts < job.maxAttempts) {
				this.saveJob({
					...job,
					status: "queued",
					finishedAt,
					updatedAt: finishedAt,
					error: message,
				});
				this.queue.push(ref);
				this.emit({ type: "retry", goalId: job.goalId, jobId: job.id, message });
				return;
			}
			this.saveJob({
				...job,
				status: "error",
				finishedAt,
				updatedAt: finishedAt,
				error: message,
			});
			this.emit({ type: "failed", goalId: job.goalId, jobId: job.id, message });
		}
	}

	private resultFromCache(goalId: string, cacheKey: string): FileIngestResult | null {
		const metadataPath = join(fileIngestCacheEntryDir(this.goalDir(goalId), cacheKey), "metadata.json");
		try {
			const parsed = JSON.parse(readFileSync(metadataPath, "utf-8")) as { result?: FileIngestResult };
			return parsed.result ?? null;
		} catch {
			return null;
		}
	}

	private async performIngest(job: FileIngestJob): Promise<FileIngestResult> {
		const cacheDir = fileIngestCacheEntryDir(this.goalDir(job.goalId), job.cacheKey);
		const rawDir = join(cacheDir, "raw");
		const parsedDir = join(cacheDir, "parsed");
		mkdirSync(rawDir, { recursive: true });
		mkdirSync(parsedDir, { recursive: true });

		const stats = statSync(job.absInputPath);
		if (!stats.isFile()) throw new Error(`inputPath is not a regular file: ${job.absInputPath}`);
		if (stats.size > this.opts.maxBytes) {
			throw new Error(`file too large: bytes=${stats.size} max=${this.opts.maxBytes}`);
		}

		const originalName = sanitizeFileName(job.absInputPath).slice(0, 80);
		const rawPath = join(rawDir, originalName || "original");
		copyFileSync(job.absInputPath, rawPath);

		const metadataPath = join(cacheDir, "metadata.json");
		const { parsed, markdown, contentType, transcriptionMetadata } = await convertLocalDocument({
			inputPath: rawPath,
			// A display name, not the deeply nested execution path. The full
			// source path remains in the job; inputPath locates the bytes.
			sourceName: originalName,
			title: job.title,
			signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
		}, this.converters);
		const parsedPath = join(parsedDir, "document.canonical.json");
		const markdownPath = join(parsedDir, "document.md");
		const parserMetadataPath = join(parsedDir, "parser.metadata.json");
		writeFileAtomic(parsedPath, `${JSON.stringify(parsed.document)}\n`);
		writeFileAtomic(parserMetadataPath, `${JSON.stringify(parsed.manifest, null, 2)}\n`);
		if (!existsSync(parsedPath) || statSync(parsedPath).size === 0) {
			throw new Error(`parser ${parsed.manifest.parser} did not write canonical JSON output`);
		}
		writeFileAtomic(markdownPath, `${markdown.trim()}\n`);

		const result: FileIngestResult = {
			cacheKey: job.cacheKey,
			cacheDir,
			rawPath,
			metadataPath,
			parsedPath,
			markdownPath,
			structuredPath: parsedPath,
			structuredFormat: "canonical-document-v1",
			contentType,
			byteLength: stats.size,
			parser: parsed.manifest.parser,
			parsedStatus: "parsed",
			parseMetadata: {
				...parsed.manifest.parse_metadata,
				...transcriptionMetadata,
				documentParsingJobId: parsed.manifest.document_id,
				documentParsingCacheKey: parsed.manifest.document_id,
				documentParsingCacheHit: false,
				documentParsingMetadataPath: parserMetadataPath,
			},
		};
		writeJsonAtomic(metadataPath, {
			version: 1,
			inputPath: job.inputPath,
			absInputPath: job.absInputPath,
			title: job.title,
			source: job.source,
			key: job.key,
			ingestedAt: new Date().toISOString(),
			originalFilename: originalName || null,
			mtimeMs: stats.mtimeMs,
			parseProvider: parsed.manifest.parser,
			parseMetadata: result.parseMetadata,
			result,
		});
		publishParsedDocuments(this.goalDir(job.goalId), result);
		return result;
	}
}
