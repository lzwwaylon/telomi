import { sha256 } from "../../../../lib/hash.js";

import {
	defaultSttConnection,
	transcribe,
} from "../../../../audio/providers/stt.js";
import type { TranscriptResult } from "../../../../audio/types.js";
import { getAudioLocalRuntimeManager } from "../../../../audio/local-runtime.js";
import type { YouTubeTranscriptParameters } from "../../contracts/youtube.js";
import { ResearchNodeError } from "../../../../agent-runtime/retry-policy.js";
import {
	parseWebVtt,
	transcriptText,
	type YouTubeTranscriptSegment,
} from "./caption-formats.js";
import {
	YouTubeMediaExtractor,
	type MaterializedYouTubeAudio,
	type YtDlpCaptionTrack,
	type YtDlpVideoInspection,
} from "./media-extractor.js";
import { toErrorMessage } from "../../../../lib/values.js";

export type YouTubeTranscriptKind = "manual" | "youtube_auto" | "local_asr";
export type YouTubeTranslationKind = "none" | "youtube" | "runtime" | "required";
export type YouTubeTranscriptStatus = "available" | "unavailable";

export interface YouTubeTranscriptChapter {
	id: string;
	title: string;
	startMs: number;
	endMs: number;
}

export interface YouTubeTranscriptAttempt {
	stage: "manual_caption" | "automatic_caption" | "local_asr" | "runtime_translation";
	outcome: "selected" | "unavailable" | "failed" | "skipped";
	language?: string;
	reason?: string;
}

export interface YouTubeTranscriptArtifact {
	schema_version: 1;
	status: YouTubeTranscriptStatus;
	video_id: string;
	source_url: string;
	title: string;
	description?: string;
	channel?: string;
	channel_id?: string;
	duration_ms?: number;
	text: string;
	chapters: YouTubeTranscriptChapter[];
	segments: YouTubeTranscriptSegment[];
	source_language?: string;
	output_language?: string;
	kind?: YouTubeTranscriptKind;
	translation: YouTubeTranslationKind;
	is_machine_generated: boolean;
	is_machine_translated: boolean;
	extractor: "yt-dlp" | "telomi-audio";
	extractor_version: string;
	stt_provider?: string;
	stt_model?: string;
	content_sha256: string;
	generated_at: string;
	attempts: YouTubeTranscriptAttempt[];
}

export interface YouTubeTranslatorPort {
	translate(input: {
		text: string;
		segments: YouTubeTranscriptSegment[];
		sourceLanguage?: string;
		targetLanguage: string;
		signal?: AbortSignal;
	}): Promise<{
		text: string;
		segments?: YouTubeTranscriptSegment[];
		provider: string;
		model?: string;
	}>;
}

export interface YouTubeSpeechToTextPort {
	transcribe(input: {
		filePath: string;
		language?: string;
		provider?: string;
		signal?: AbortSignal;
	}): Promise<TranscriptResult>;
}

export interface YouTubeMediaExtractorPort {
	inspectVideo(
		videoId: string,
		input?: { signal?: AbortSignal },
	): Promise<YtDlpVideoInspection>;
	materializeCaption(
		videoId: string,
		track: YtDlpCaptionTrack,
		input?: { signal?: AbortSignal },
	): Promise<{ content: string; bytes: number }>;
	materializeAudio(
		inspection: YtDlpVideoInspection,
		input: {
			maxDurationSeconds: number;
			signal?: AbortSignal;
		},
	): Promise<MaterializedYouTubeAudio>;
}

export class TelomiAudioSpeechToTextAdapter implements YouTubeSpeechToTextPort {
	constructor(
		private readonly prepareAudio: (connection: string, signal?: AbortSignal) => Promise<unknown> =
			(connection, signal) => getAudioLocalRuntimeManager().prepare(connection, signal),
	) {}

	async transcribe(input: {
		filePath: string;
		language?: string;
		provider?: string;
		signal?: AbortSignal;
	}): Promise<TranscriptResult> {
		const connection = input.provider ?? defaultSttConnection();
		let result;
		try {
			await this.prepareAudio(connection, input.signal);
			result = await transcribe({
				filePath: input.filePath,
				...(input.language ? { language: input.language } : {}),
				mode: "job",
				signal: input.signal,
			});
		} catch (error) {
			if (input.signal?.aborted) throw input.signal.reason ?? error;
			throw new ResearchNodeError(
				`YouTube ASR failed through ${connection}: ${toErrorMessage(error)}`,
				"provider",
				true,
				{
					code: "youtube_asr_failed",
					details: { circuit_scope: "request" },
					cause: error instanceof Error ? error : undefined,
				},
			);
		}
		if (!result.ok) throw new ResearchNodeError(
			`YouTube ASR failed through ${result.provider}: ${result.reason}`,
			"provider",
			true,
			{
				code: "youtube_asr_failed",
				details: { circuit_scope: "request" },
			},
		);
		return result;
	}
}

export class YouTubeTranscriptModule {
	constructor(
		private readonly extractor: YouTubeMediaExtractorPort = new YouTubeMediaExtractor(),
		private readonly speechToText: YouTubeSpeechToTextPort = new TelomiAudioSpeechToTextAdapter(),
		private readonly translator?: YouTubeTranslatorPort,
		private readonly now: () => number = Date.now,
	) {}

	async get(
		parameters: YouTubeTranscriptParameters,
		signal?: AbortSignal,
	): Promise<YouTubeTranscriptArtifact> {
		const inspection = await this.extractor.inspectVideo(parameters.video_id, {
			signal,
		});
		const attempts: YouTubeTranscriptAttempt[] = [];
		const candidates = captionCandidates(inspection, parameters);
		for (const selected of candidates) {
			const stage = selected.automatic ? "automatic_caption" : "manual_caption";
			try {
				const materialized = await this.extractor.materializeCaption(
					inspection.videoId,
					selected,
					{
						signal,
					},
				);
				const segments = parseWebVtt(materialized.content);
				if (segments.length === 0) {
					throw new ResearchNodeError(
						`YouTube caption '${selected.language}' did not contain timed text`,
						"validation",
						false,
						{ code: "youtube_caption_empty" },
					);
				}
				attempts.push({
					stage,
					outcome: "selected",
					language: selected.language,
				});
				return await this.finalizeCaption(
					inspection,
					parameters,
					selected,
					segments,
					attempts,
					signal,
				);
			} catch (error) {
				if (!canTryAnotherCaption(error)) throw error;
				attempts.push({
					stage,
					outcome: "failed",
					language: selected.language,
					reason: captionFailureReason(error),
				});
			}
		}
		if (!attempts.some((attempt) => attempt.stage === "manual_caption")) {
			attempts.push({ stage: "manual_caption", outcome: "unavailable" });
		}
		if (!attempts.some((attempt) => attempt.stage === "automatic_caption")) {
			attempts.push({ stage: "automatic_caption", outcome: "unavailable" });
		}
		const audio = await this.extractor.materializeAudio(inspection, {
			maxDurationSeconds: parameters.max_duration_seconds,
			signal,
		});
		try {
			const transcript = await this.speechToText.transcribe({
				filePath: audio.path,
				signal,
			});
			attempts.push({
				stage: "local_asr",
				outcome: "selected",
				...(transcript.language ? { language: transcript.language } : {}),
			});
			let segments = transcript.segments.map((segment) => ({
				startMs: Math.max(0, Math.round(segment.start * 1_000)),
				endMs: Math.max(0, Math.round(segment.end * 1_000)),
				text: segment.text.trim(),
			})).filter((segment) => segment.text);
			if (segments.length === 0 && transcript.text.trim()) {
				segments = [{
					startMs: 0,
					endMs: Math.max(0, Math.round((transcript.durationSec ?? 0) * 1_000)),
					text: transcript.text.trim(),
				}];
			}
			const translated = await this.translateIfNeeded({
				text: transcript.text.trim() || transcriptText(segments),
				segments,
				sourceLanguage: transcript.language,
				targetLanguage: parameters.target_language,
				attempts,
				signal,
			});
			return availableArtifact({
				inspection,
				text: translated.text,
				segments: translated.segments,
				sourceLanguage: transcript.language,
				outputLanguage: translated.outputLanguage ?? transcript.language,
				kind: "local_asr",
				translation: translated.translation,
				extractor: "telomi-audio",
				extractorVersion: inspection.extractorVersion,
				sttProvider: transcript.provider,
				sttModel: transcript.model,
				attempts,
				now: this.now(),
			});
		} finally {
			audio.cleanup();
		}
	}

	private async finalizeCaption(
		inspection: YtDlpVideoInspection,
		parameters: YouTubeTranscriptParameters,
		track: YtDlpCaptionTrack,
		segments: YouTubeTranscriptSegment[],
		attempts: YouTubeTranscriptAttempt[],
		signal?: AbortSignal,
	): Promise<YouTubeTranscriptArtifact> {
		const outputLanguage = normalizedCaptionLanguage(track.language);
		const targetMatches = parameters.target_language
			? languageMatches(track.language, parameters.target_language)
			: false;
		const looksTranslatedByYouTube = Boolean(
			track.automatic
			&& parameters.target_language
			&& targetMatches
			&& inspection.originalLanguage
			&& !languageMatches(inspection.originalLanguage, track.language),
		);
		const sourceLanguage = looksTranslatedByYouTube
			? normalizedCaptionLanguage(inspection.originalLanguage!)
			: outputLanguage;
		const translated = looksTranslatedByYouTube
			? {
				text: transcriptText(segments),
				segments,
				outputLanguage,
				translation: "youtube" as const,
			}
			: await this.translateIfNeeded({
				text: transcriptText(segments),
				segments,
				sourceLanguage,
				targetLanguage: parameters.target_language,
				attempts,
				signal,
			});
		return availableArtifact({
			inspection,
			text: translated.text,
			segments: translated.segments,
			sourceLanguage,
			outputLanguage: translated.outputLanguage ?? sourceLanguage,
			kind: track.automatic ? "youtube_auto" : "manual",
			translation: translated.translation,
			extractor: "yt-dlp",
			extractorVersion: inspection.extractorVersion,
			attempts,
			now: this.now(),
		});
	}

	private async translateIfNeeded(input: {
		text: string;
		segments: YouTubeTranscriptSegment[];
		sourceLanguage?: string;
		targetLanguage?: string;
		attempts: YouTubeTranscriptAttempt[];
		signal?: AbortSignal;
	}): Promise<{
		text: string;
		segments: YouTubeTranscriptSegment[];
		outputLanguage?: string;
		translation: YouTubeTranslationKind;
	}> {
		if (
			!input.targetLanguage
			|| (input.sourceLanguage && languageMatches(input.sourceLanguage, input.targetLanguage))
		) {
			return {
				text: input.text,
				segments: input.segments,
				outputLanguage: input.sourceLanguage,
				translation: "none",
			};
		}
		if (!this.translator) {
			input.attempts.push({
				stage: "runtime_translation",
				outcome: "skipped",
				reason: "No Runtime translation Provider is configured",
			});
			return {
				text: input.text,
				segments: input.segments,
				outputLanguage: input.sourceLanguage,
				translation: "required",
			};
		}
		const result = await this.translator.translate({
			text: input.text,
			segments: input.segments,
			sourceLanguage: input.sourceLanguage,
			targetLanguage: input.targetLanguage,
			signal: input.signal,
		});
		input.attempts.push({
			stage: "runtime_translation",
			outcome: "selected",
			language: input.targetLanguage,
		});
		return {
			text: result.text,
			segments: result.segments ?? input.segments,
			outputLanguage: input.targetLanguage,
			translation: "runtime",
		};
	}
}

function captionCandidates(
	inspection: YtDlpVideoInspection,
	parameters: YouTubeTranscriptParameters,
): YtDlpCaptionTrack[] {
	const target = parameters.target_language;
	const preferred = parameters.preferred_languages;
	const manual = inspection.manualCaptions;
	const automatic = inspection.automaticCaptions;
	const candidates = [
		...(target ? matchingTracks(manual, [target]) : []),
		...(target ? matchingTracks(automatic, [target]) : []),
		...matchingTracks(manual, preferred),
		...matchingTracks(automatic, preferred),
		...(inspection.originalLanguage
			? matchingTracks(manual, [inspection.originalLanguage]) : []),
		...(inspection.originalLanguage
			? matchingTracks(automatic, [inspection.originalLanguage]) : []),
		...manual,
		...fallbackAutomaticTracks(automatic, inspection.originalLanguage),
	];
	return candidates.filter((track, index) =>
		candidates.findIndex((candidate) =>
			candidate.automatic === track.automatic && candidate.language === track.language) === index);
}

function fallbackAutomaticTracks(
	tracks: YtDlpCaptionTrack[],
	originalLanguage: string | undefined,
): YtDlpCaptionTrack[] {
	const explicitOriginal = tracks.filter((track) => /-orig$/iu.test(track.language));
	if (explicitOriginal.length > 0) return explicitOriginal;
	if (originalLanguage) {
		const matching = matchingTracks(tracks, [originalLanguage]);
		if (matching.length > 0) return matching;
	}
	return tracks.slice(0, 1);
}

function matchingTracks(tracks: YtDlpCaptionTrack[], languages: string[]): YtDlpCaptionTrack[] {
	return languages.flatMap((language) => tracks.filter((track) =>
		languageMatches(track.language, language)));
}

function languageMatches(left: string, right: string): boolean {
	const a = normalizedCaptionLanguage(left).toLowerCase();
	const b = normalizedCaptionLanguage(right).toLowerCase();
	return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

function normalizedCaptionLanguage(value: string): string {
	return value.replace(/-orig$/iu, "");
}

function canTryAnotherCaption(error: unknown): boolean {
	if (!(error instanceof ResearchNodeError)) return true;
	return !["cancelled", "budget", "permanent"].includes(error.failureClass);
}

function captionFailureReason(error: unknown): string {
	if (error instanceof ResearchNodeError) {
		return [error.code, error.message].filter(Boolean).join(": ").slice(0, 500);
	}
	return (toErrorMessage(error)).slice(0, 500);
}

function availableArtifact(input: {
	inspection: YtDlpVideoInspection;
	text: string;
	segments: YouTubeTranscriptSegment[];
	sourceLanguage?: string;
	outputLanguage?: string;
	kind: YouTubeTranscriptKind;
	translation: YouTubeTranslationKind;
	extractor: "yt-dlp" | "telomi-audio";
	extractorVersion: string;
	sttProvider?: string;
	sttModel?: string;
	attempts: YouTubeTranscriptAttempt[];
	now: number;
}): YouTubeTranscriptArtifact {
	const text = input.text.trim();
	const nativeChapters = input.inspection.chapters.map((chapter, index) => ({
		id: `chapter:${index + 1}`,
		title: chapter.title,
		startMs: chapter.startMs,
		endMs: chapter.endMs,
	}));
	const { chapters, segments } = organizeTranscript(
		input.segments,
		nativeChapters,
		input.inspection.durationSeconds === undefined
			? undefined
			: Math.round(input.inspection.durationSeconds * 1_000),
	);
	return {
		schema_version: 1,
		status: "available",
		video_id: input.inspection.videoId,
		source_url: input.inspection.webpageUrl,
		title: input.inspection.title,
		...optional("description", input.inspection.description),
		...optional("channel", input.inspection.channel),
		...optional("channel_id", input.inspection.channelId),
		...optional(
			"duration_ms",
			input.inspection.durationSeconds === undefined
				? undefined
				: Math.round(input.inspection.durationSeconds * 1_000),
		),
		text,
		chapters,
		segments,
		...optional("source_language", input.sourceLanguage),
		...optional("output_language", input.outputLanguage),
		kind: input.kind,
		translation: input.translation,
		is_machine_generated: input.kind !== "manual",
		is_machine_translated: input.translation === "youtube" || input.translation === "runtime",
		extractor: input.extractor,
		extractor_version: input.extractorVersion,
		...optional("stt_provider", input.sttProvider),
		...optional("stt_model", input.sttModel),
		content_sha256: sha256(text),
		generated_at: new Date(input.now).toISOString(),
		attempts: input.attempts,
	};
}

const INFERRED_CHAPTER_TARGET_MS = 10 * 60_000;
const INFERRED_CHAPTER_MIN_MS = 5 * 60_000;
const INFERRED_CHAPTER_MAX_MS = 15 * 60_000;
const INFERRED_CHAPTER_SILENCE_MS = 2_000;

function organizeTranscript(
	inputSegments: YouTubeTranscriptSegment[],
	nativeChapters: YouTubeTranscriptChapter[],
	durationMs?: number,
): {
	chapters: YouTubeTranscriptChapter[];
	segments: YouTubeTranscriptSegment[];
} {
	if (inputSegments.length === 0) return { chapters: nativeChapters, segments: [] };
	const chapters = nativeChapters.length > 0
		? nativeChapters
		: inferTimeChapters(inputSegments, durationMs);
	const assigned = inputSegments.map((segment) => ({
		...segment,
		chapterId: matchingChapter(segment, chapters)?.id,
	}));
	const segments: YouTubeTranscriptSegment[] = chapters.flatMap((chapter) => {
		const text = transcriptText(
			assigned.filter((segment) => segment.chapterId === chapter.id),
		);
		return text
			? [{
				startMs: chapter.startMs,
				endMs: chapter.endMs,
				text,
				chapterId: chapter.id,
			}]
			: [];
	});
	const unchaptered = assigned.filter((segment) => !segment.chapterId);
	if (unchaptered.length > 0) {
		segments.push({
			startMs: unchaptered[0]!.startMs,
			endMs: unchaptered.at(-1)!.endMs,
			text: transcriptText(unchaptered),
		});
	}
	return { chapters, segments };
}

function inferTimeChapters(
	segments: YouTubeTranscriptSegment[],
	durationMs?: number,
): YouTubeTranscriptChapter[] {
	const videoEndMs = Math.max(durationMs ?? 0, segments.at(-1)!.endMs);
	const starts = [0];
	let rangeStartIndex = 0;

	while (rangeStartIndex < segments.length - 1) {
		const rangeStartMs = starts.at(-1)!;
		if (videoEndMs - rangeStartMs <= INFERRED_CHAPTER_TARGET_MS) break;
		const targetMs = rangeStartMs + INFERRED_CHAPTER_TARGET_MS;
		const candidates: number[] = [];
		let fallbackIndex: number | undefined;

		for (let index = rangeStartIndex + 1; index < segments.length; index += 1) {
			const segment = segments[index]!;
			if (segment.startMs > rangeStartMs + INFERRED_CHAPTER_MAX_MS) break;
			if (segment.startMs >= targetMs && fallbackIndex === undefined) fallbackIndex = index;
			const previous = segments[index - 1]!;
			if (
				segment.startMs >= rangeStartMs + INFERRED_CHAPTER_MIN_MS
				&& segment.startMs - previous.endMs >= INFERRED_CHAPTER_SILENCE_MS
			) {
				candidates.push(index);
			}
		}

		// ponytail: deterministic time/gap heuristic; add semantic chaptering only if these boundaries prove insufficient.
		const splitIndex = candidates.sort((left, right) =>
			Math.abs(segments[left]!.startMs - targetMs)
			- Math.abs(segments[right]!.startMs - targetMs))[0] ?? fallbackIndex;
		if (splitIndex === undefined || splitIndex <= rangeStartIndex) break;
		starts.push(segments[splitIndex]!.startMs);
		rangeStartIndex = splitIndex;
	}

	return starts.map((startMs, index) => ({
		id: `chapter:${index + 1}`,
		title: starts.length === 1 ? "Transcript" : `Part ${index + 1}`,
		startMs,
		endMs: starts[index + 1] ?? videoEndMs,
	}));
}

function matchingChapter(
	segment: YouTubeTranscriptSegment,
	chapters: YouTubeTranscriptChapter[],
): YouTubeTranscriptChapter | undefined {
	let selected: YouTubeTranscriptChapter | undefined;
	let selectedOverlap = 0;
	for (const chapter of chapters) {
		const overlap = Math.max(
			0,
			Math.min(segment.endMs, chapter.endMs) - Math.max(segment.startMs, chapter.startMs),
		);
		if (overlap > selectedOverlap) {
			selected = chapter;
			selectedOverlap = overlap;
		}
	}
	if (selected) return selected;
	return chapters.find((chapter) =>
		segment.startMs >= chapter.startMs && segment.startMs < chapter.endMs);
}

function optional<K extends string, V>(
	key: K,
	value: V | undefined,
): { [P in K]?: V } {
	return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}
