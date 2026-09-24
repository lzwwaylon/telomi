import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { ResearchNodeError } from "../../../../agent-runtime/retry-policy.js";
import { ControlledYtDlpRunner, type YtDlpRunResult } from "./ytdlp-runner.js";
import { isInsideRoot } from "../../../../lib/paths.js";
import { toErrorMessage } from "../../../../lib/values.js";

const CAPTION_MAX_BYTES = 20 * 1024 * 1024;
const AUDIO_MAX_BYTES = 512 * 1024 * 1024;

export interface YtDlpCaptionTrack {
	language: string;
	automatic: boolean;
	formats: string[];
}

export interface YtDlpChapter {
	title: string;
	startMs: number;
	endMs: number;
}

export interface YtDlpVideoInspection {
	videoId: string;
	title: string;
	channel?: string;
	channelId?: string;
	description?: string;
	durationSeconds?: number;
	timestamp?: number;
	originalLanguage?: string;
	webpageUrl: string;
	manualCaptions: YtDlpCaptionTrack[];
	automaticCaptions: YtDlpCaptionTrack[];
	chapters: YtDlpChapter[];
	raw: Record<string, unknown>;
	extractorVersion: string;
}

export interface MaterializedYouTubeAudio {
	path: string;
	bytes: number;
	cleanup(): void;
}

export interface YtDlpFeedVideo {
	videoId: string;
	title: string;
	url: string;
	channel?: string;
	channelId?: string;
	description?: string;
	durationSeconds?: number;
	timestamp?: number;
	timestampPrecision?: "approximate" | "exact";
	viewCount?: number;
	likeCount?: number;
	commentCount?: number;
	liveStatus?: string;
	thumbnailUrl?: string;
	extractorVersion: string;
}

export interface YtDlpAccountSubscription {
	channelId: string;
	title: string;
	url: string;
	handle?: string;
	extractorVersion: string;
}

export class YouTubeMediaExtractor {
	constructor(private readonly runner = new ControlledYtDlpRunner()) {}

	async version(signal?: AbortSignal): Promise<string> {
		return await this.runner.version(signal);
	}

	async inspectVideo(
		videoId: string,
		input: { signal?: AbortSignal } = {},
	): Promise<YtDlpVideoInspection> {
		const version = await this.runner.version(input.signal);
		const inspect = async (authenticated: boolean) => await this.runner.run([
			"--no-warnings",
			"--no-progress",
			"--no-playlist",
			"--skip-download",
			"--ignore-no-formats-error",
			"--dump-single-json",
			...(authenticated ? accountCredentialArguments() : []),
			videoUrl(videoId),
		], { signal: input.signal });
		let result: YtDlpRunResult;
		try {
			result = await inspect(false);
		} catch (error) {
			if (!requiresAccountCredentials(error)) throw error;
			result = await inspect(true);
		}
		let raw: Record<string, unknown>;
		try {
			const parsed = JSON.parse(result.stdout) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
			raw = parsed as Record<string, unknown>;
		} catch (error) {
			throw new ResearchNodeError(
				`yt-dlp returned invalid video JSON: ${toErrorMessage(error)}`,
				"validation",
				false,
				{ code: "youtube_ytdlp_invalid_json" },
			);
		}
		const id = stringValue(raw.id) ?? videoId;
		const manualCaptions = captionTracks(raw.subtitles, false);
		const automaticCaptions = captionTracks(raw.automatic_captions, true);
		const durationSeconds = numberValue(raw.duration);
		return {
			videoId: id,
			title: stringValue(raw.title) ?? id,
			...optionalProperty("channel", stringValue(raw.channel) ?? stringValue(raw.uploader)),
			...optionalProperty("channelId", stringValue(raw.channel_id) ?? stringValue(raw.uploader_id)),
			...optionalProperty("description", stringValue(raw.description)),
			...optionalProperty("durationSeconds", durationSeconds),
			...optionalProperty("timestamp", numberValue(raw.timestamp) ?? numberValue(raw.release_timestamp)),
			...optionalProperty(
				"originalLanguage",
				stringValue(raw.language) ?? originalCaptionLanguage(manualCaptions, automaticCaptions),
			),
			webpageUrl: stringValue(raw.webpage_url) ?? videoUrl(id),
			manualCaptions,
			automaticCaptions,
			chapters: chapterRows(raw.chapters, durationSeconds),
			raw,
			extractorVersion: version,
		};
	}

	async listAccountFeed(
		target: ":ytrec" | ":ytwatchlater" | ":ythis",
		input: { limit: number; signal?: AbortSignal },
	): Promise<YtDlpFeedVideo[]> {
		const version = await this.runner.version(input.signal);
		const result = await this.runner.run([
			"--no-warnings",
			"--no-progress",
			"--flat-playlist",
			"--playlist-end",
			String(Math.min(100, input.limit)),
			"--dump-json",
			...accountCredentialArguments(),
			target,
		], {
			signal: input.signal,
			maxStdoutBytes: 16 * 1024 * 1024,
			acceptPartialOutput: true,
		});
		return feedVideos(result.stdout, version, "feed").slice(0, input.limit);
	}

	async listAccountSubscriptions(input: {
		offset: number;
		limit: number;
		signal?: AbortSignal;
	}): Promise<YtDlpAccountSubscription[]> {
		const version = await this.runner.version(input.signal);
		const start = input.offset + 1;
		const end = input.offset + input.limit;
		const result = await this.runner.run([
			"--no-warnings",
			"--no-progress",
			"--flat-playlist",
			"--playlist-start",
			String(start),
			"--playlist-end",
			String(end),
			"--dump-json",
			...accountCredentialArguments(),
			"https://www.youtube.com/feed/channels",
		], {
			signal: input.signal,
			maxStdoutBytes: 16 * 1024 * 1024,
			acceptPartialOutput: true,
		});
		return parseJsonLines(result.stdout, "subscription").flatMap((row) => {
			const channelId = stringValue(row.channel_id) ?? stringValue(row.id);
			if (!channelId) return [];
			return [{
				channelId,
				title: stringValue(row.channel) ?? stringValue(row.title) ?? channelId,
				url: stringValue(row.webpage_url)
					?? stringValue(row.url)
					?? `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`,
				...optionalProperty(
					"handle",
					stringValue(row.uploader_id)?.startsWith("@")
						? stringValue(row.uploader_id)
						: undefined,
				),
				extractorVersion: version,
			}];
		});
	}

	async listSubscriptionUploads(input: {
		limit: number;
		candidateLimit?: number;
		publishedAfter?: string;
		signal?: AbortSignal;
	}): Promise<YtDlpFeedVideo[]> {
		const version = await this.runner.version(input.signal);
		const candidateLimit = Math.min(
			500,
			Math.max(input.limit, input.candidateLimit ?? input.limit),
		);
		const result = await this.runner.run([
			"--no-warnings",
			"--no-progress",
			"--playlist-end",
			String(candidateLimit),
			"--skip-download",
			"--ignore-errors",
			"--ignore-no-formats-error",
			"--print",
			"%(.{id,title,webpage_url,channel,channel_id,description,duration,timestamp,release_timestamp,live_status,view_count,like_count,comment_count,thumbnail,availability})j",
			...ytDlpDateBoundary(input.publishedAfter),
			...accountCredentialArguments(),
			":ytsubs",
		], {
			signal: input.signal,
			maxStdoutBytes: 32 * 1024 * 1024,
			maxStderrBytes: 2 * 1024 * 1024,
			acceptPartialOutput: true,
		});
		return feedVideos(result.stdout, version, "subscription upload");
	}

	async listVideos(
		target: string,
		input: {
			offset: number;
			limit: number;
			candidateLimit?: number;
			publishedAfter?: string;
			mode?: "summary" | "full";
			signal?: AbortSignal;
		},
	): Promise<YtDlpFeedVideo[]> {
		const version = await this.runner.version(input.signal);
		const start = input.offset + 1;
		const end = input.offset + Math.max(input.limit, input.candidateLimit ?? input.limit);
		const summary = input.mode === "summary";
		const result = await this.runner.run([
			"--no-warnings",
			"--no-progress",
			...(summary ? ["--flat-playlist", "--extractor-args", "youtubetab:approximate_date"] : []),
			"--playlist-start",
			String(start),
			"--playlist-end",
			String(Math.min(start + 499, end)),
			"--skip-download",
			"--ignore-errors",
			"--ignore-no-formats-error",
			"--print",
			"%(.{id,title,webpage_url,channel,channel_id,description,duration,timestamp,release_timestamp,live_status,view_count,like_count,comment_count,thumbnail,availability})j",
			...ytDlpDateBoundary(input.publishedAfter),
			target,
		], {
			signal: input.signal,
			maxStdoutBytes: 32 * 1024 * 1024,
			maxStderrBytes: 2 * 1024 * 1024,
			acceptPartialOutput: true,
		});
		return feedVideos(result.stdout, version, "video", summary ? "approximate" : "exact");
	}

	async materializeCaption(
		videoId: string,
		track: YtDlpCaptionTrack,
		input: { signal?: AbortSignal } = {},
	): Promise<{ content: string; bytes: number }> {
		const root = mkdtempSync(join(tmpdir(), "pi-youtube-caption-"));
		try {
			const output = join(root, "caption.%(ext)s");
			const download = async (authenticated: boolean) => await this.runner.run([
				"--no-warnings",
				"--no-progress",
				"--no-playlist",
				"--skip-download",
				track.automatic ? "--write-auto-subs" : "--write-subs",
				"--sub-langs",
				track.language,
				"--sub-format",
				"vtt/best",
				"--ignore-no-formats-error",
				"--output",
				output,
				...(authenticated ? accountCredentialArguments() : []),
				videoUrl(videoId),
			], { cwd: root, signal: input.signal, maxStdoutBytes: 512 * 1024 });
			try {
				await download(false);
			} catch (error) {
				if (!requiresAccountCredentials(error)) throw error;
				await download(true);
			}
			const files = safeRegularFiles(root)
				.filter((path) => /\.(?:vtt|srv3|ttml|json3)$/iu.test(path))
				.sort();
			const path = files[0];
			if (!path) {
				throw new ResearchNodeError(
					`yt-dlp did not materialize caption track '${track.language}'`,
					"provider",
					true,
					{
						code: "youtube_caption_materialization_failed",
						details: { circuit_scope: "request" },
					},
				);
			}
			const bytes = statSync(path).size;
			if (bytes > CAPTION_MAX_BYTES) {
				throw new ResearchNodeError(
					`YouTube caption exceeds ${CAPTION_MAX_BYTES} bytes`,
					"budget",
					false,
					{ code: "youtube_caption_size_limit" },
				);
			}
			return { content: readFileSync(path, "utf-8"), bytes };
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	async materializeAudio(
		inspection: YtDlpVideoInspection,
		input: {
			maxDurationSeconds: number;
			signal?: AbortSignal;
		},
	): Promise<MaterializedYouTubeAudio> {
		if (
			inspection.durationSeconds !== undefined
			&& inspection.durationSeconds > input.maxDurationSeconds
		) {
			throw new ResearchNodeError(
				`YouTube video duration ${inspection.durationSeconds}s exceeds ASR limit ${input.maxDurationSeconds}s`,
				"budget",
				false,
				{ code: "youtube_asr_duration_limit" },
			);
		}
		const root = mkdtempSync(join(tmpdir(), "pi-youtube-audio-"));
		try {
			const download = async (authenticated: boolean) => await this.runner.run([
				"--no-warnings",
				"--no-progress",
				"--no-playlist",
				"--max-filesize",
				String(AUDIO_MAX_BYTES),
				"-f",
				"bestaudio/best",
				"-x",
				"--audio-format",
				"mp3",
				"--audio-quality",
				"5",
				"--output",
				join(root, authenticated ? "audio-auth.%(ext)s" : "audio-public.%(ext)s"),
				...(authenticated ? accountCredentialArguments() : []),
				inspection.webpageUrl,
			], {
				cwd: root,
				signal: input.signal,
				maxStdoutBytes: 2 * 1024 * 1024,
			});
			try {
				await download(false);
			} catch (error) {
				if (!shouldRetryAudioWithCredentials(error)) throw error;
				await download(true);
			}
			const path = safeRegularFiles(root).find((candidate) => /\.(?:mp3|m4a|opus|ogg|wav)$/iu.test(candidate));
			if (!path) throw new ResearchNodeError(
				"yt-dlp did not materialize an audio file",
				"provider",
				false,
				{
					code: "youtube_audio_materialization_failed",
					details: { circuit_scope: "request" },
				},
			);
			const bytes = statSync(path).size;
			if (bytes > AUDIO_MAX_BYTES) throw new ResearchNodeError(
				`YouTube audio exceeds ${AUDIO_MAX_BYTES} bytes`,
				"budget",
				false,
				{ code: "youtube_audio_size_limit" },
			);
			let cleaned = false;
			return {
				path,
				bytes,
				cleanup() {
					if (cleaned) return;
					cleaned = true;
					rmSync(root, { recursive: true, force: true });
				},
			};
		} catch (error) {
			rmSync(root, { recursive: true, force: true });
			throw error;
		}
	}
}

function shouldRetryAudioWithCredentials(error: unknown): boolean {
	return requiresAccountCredentials(error);
}

function requiresAccountCredentials(error: unknown): boolean {
	return error instanceof ResearchNodeError && error.code === "youtube_ytdlp_authorization_required";
}

function captionTracks(value: unknown, automatic: boolean): YtDlpCaptionTrack[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const rows: YtDlpCaptionTrack[] = [];
	for (const [language, formats] of Object.entries(value)) {
		if (!Array.isArray(formats) || !language.trim() || language.trim().toLowerCase() === "live_chat") {
			continue;
		}
		const extensions = formats.flatMap((format) => {
			if (!format || typeof format !== "object" || Array.isArray(format)) return [];
			const extension = stringValue((format as Record<string, unknown>).ext);
			return extension ? [extension] : [];
		});
		rows.push({ language, automatic, formats: [...new Set(extensions)] });
	}
	return rows;
}

function chapterRows(value: unknown, durationSeconds: number | undefined): YtDlpChapter[] {
	if (!Array.isArray(value)) return [];
	const candidates = value.flatMap((chapter) => {
		if (!chapter || typeof chapter !== "object" || Array.isArray(chapter)) return [];
		const row = chapter as Record<string, unknown>;
		const title = stringValue(row.title);
		const startSeconds = numberValue(row.start_time);
		const endSeconds = numberValue(row.end_time);
		if (!title || startSeconds === undefined || startSeconds < 0) return [];
		return [{ title, startSeconds, endSeconds }];
	}).sort((left, right) => left.startSeconds - right.startSeconds);
	return candidates.flatMap((chapter, index) => {
		const nextStart = candidates[index + 1]?.startSeconds;
		const endSeconds = chapter.endSeconds !== undefined && chapter.endSeconds > chapter.startSeconds
			? chapter.endSeconds
			: nextStart !== undefined && nextStart > chapter.startSeconds
				? nextStart
				: durationSeconds !== undefined && durationSeconds > chapter.startSeconds
					? durationSeconds
					: undefined;
		if (endSeconds === undefined) return [];
		const boundedEnd = durationSeconds === undefined ? endSeconds : Math.min(endSeconds, durationSeconds);
		if (boundedEnd <= chapter.startSeconds) return [];
		return [{
			title: chapter.title,
			startMs: Math.round(chapter.startSeconds * 1_000),
			endMs: Math.round(boundedEnd * 1_000),
		}];
	});
}

function originalCaptionLanguage(
	manual: YtDlpCaptionTrack[],
	automatic: YtDlpCaptionTrack[],
): string | undefined {
	const explicitOriginal = [...manual, ...automatic]
		.find((track) => /-orig$/iu.test(track.language));
	if (explicitOriginal) return explicitOriginal.language.replace(/-orig$/iu, "");
	if (manual.length === 1) return manual[0]?.language;
	return undefined;
}

function safeRegularFiles(root: string): string[] {
	const realRoot = realpathSync(root);
	return readdirSync(root)
		.map((name) => join(root, basename(name)))
		.filter((path) => {
			if (!existsSync(path)) return false;
			const realPath = realpathSync(path);
			return realPath !== realRoot && isInsideRoot(realRoot, realPath) && statSync(realPath).isFile();
		})
		.map((path) => realpathSync(path));
}

function accountCredentialArguments(): string[] {
	const configuredFile = process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE?.trim();
	if (configuredFile) {
		if (!isAbsolute(configuredFile) || configuredFile.length > 4_096 || configuredFile.includes("\0")
			|| /[\r\n]/u.test(configuredFile)) {
			throw new ResearchNodeError(
				"YouTube yt-dlp Cookie file path is invalid",
				"validation",
				false,
				{ code: "youtube_cookie_file_invalid" },
			);
		}
		try {
			const path = realpathSync(configuredFile);
			const stats = statSync(path);
			if (!stats.isFile() || stats.size > 10 * 1024 * 1024 || (stats.mode & 0o077) !== 0) {
				throw new Error("Cookie file must be a regular file up to 10 MiB with mode 0600");
			}
			return ["--cookies", path];
		} catch (error) {
			throw new ResearchNodeError(
				`YouTube yt-dlp Cookie file cannot be used: ${toErrorMessage(error)}`,
				"validation",
				false,
				{ code: "youtube_cookie_file_invalid", cause: error instanceof Error ? error : undefined },
			);
		}
	}
	const profile = process.env.PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER?.trim();
	if (!profile) {
		throw new ResearchNodeError(
			"YouTube account operations require PI_YOUTUBE_YTDLP_COOKIE_FILE or PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER",
			"permanent",
			false,
			{ code: "youtube_account_credentials_required" },
		);
	}
	if (profile.length > 256 || profile.includes("\0") || /[\r\n]/u.test(profile)) {
		throw new ResearchNodeError(
			"YouTube yt-dlp cookie profile is invalid",
			"validation",
			false,
			{ code: "youtube_cookie_profile_invalid" },
		);
	}
	return ["--cookies-from-browser", profile];
}

function parseJsonLines(stdout: string, label: string): Record<string, unknown>[] {
	return stdout.split(/\r?\n/u).flatMap((line) => {
		if (!line.trim()) return [];
		try {
			const value = JSON.parse(line) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				throw new Error("line is not an object");
			}
			return [value as Record<string, unknown>];
		} catch (error) {
			throw new ResearchNodeError(
				`yt-dlp returned invalid ${label} JSON: ${toErrorMessage(error)}`,
				"validation",
				false,
				{ code: "youtube_ytdlp_invalid_account_json" },
			);
		}
	});
}

function feedVideos(
	stdout: string,
	extractorVersion: string,
	label: string,
	timestampPrecision: YtDlpFeedVideo["timestampPrecision"] = "exact",
): YtDlpFeedVideo[] {
	return parseJsonLines(stdout, label).flatMap((row) => {
		const videoId = stringValue(row.id);
		if (!videoId) return [];
		return [{
			videoId,
			title: stringValue(row.title) ?? videoId,
			url: stringValue(row.webpage_url) ?? videoUrl(videoId),
			...optionalProperty("channel", stringValue(row.channel) ?? stringValue(row.uploader)),
			...optionalProperty("channelId", stringValue(row.channel_id) ?? stringValue(row.uploader_id)),
			...optionalProperty("description", stringValue(row.description)),
			...optionalProperty("durationSeconds", numberValue(row.duration)),
			...optionalProperty("timestamp", numberValue(row.timestamp) ?? numberValue(row.release_timestamp)),
			timestampPrecision,
			...optionalProperty("viewCount", numberValue(row.view_count)),
			...optionalProperty("likeCount", numberValue(row.like_count)),
			...optionalProperty("commentCount", numberValue(row.comment_count)),
			...optionalProperty("liveStatus", stringValue(row.live_status)),
			...optionalProperty("thumbnailUrl", stringValue(row.thumbnail)),
			extractorVersion,
		}];
	});
}

function ytDlpDateBoundary(publishedAfter: string | undefined): string[] {
	if (!publishedAfter) return [];
	const timestamp = Date.parse(publishedAfter);
	if (!Number.isFinite(timestamp)) return [];
	const overlap = new Date(timestamp - 24 * 60 * 60 * 1_000)
		.toISOString()
		.slice(0, 10)
		.replaceAll("-", "");
	return ["--dateafter", overlap, "--break-on-reject"];
}

function videoUrl(videoId: string): string {
	return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalProperty<K extends string, V>(
	key: K,
	value: V | undefined,
): { [P in K]?: V } {
	return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}
