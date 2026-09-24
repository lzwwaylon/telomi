import { dirname, extname, join } from "node:path";

import { getAudioLocalRuntimeManager } from "../../audio/local-runtime.js";
import { defaultSttConnection, transcribe } from "../../audio/providers/stt.js";
import type { TranscriptResult } from "../../audio/types.js";
import { AUDIO_EXTENSIONS } from "../../ingestion/attachment-kind.js";
import { writeFileAtomic } from "../../lib/fs.js";
import { renderCanonicalDocumentMarkdown } from "./canonical-document.js";
import {
	HttpFastApiDocumentParser,
	type FastApiDocumentParser,
	type FastApiDocumentParseResult,
} from "./fastapi-parser.js";

const TIMED_TRANSCRIPT_CONTENT_TYPE = "application/vnd.pi.timed-transcript+json";

/** Injectable conversion backends; production uses the Source Service parser and the managed STT runtime. */
export interface LocalDocumentConverters {
	documentParser?: FastApiDocumentParser;
	transcribeAudio?: typeof transcribe;
	prepareAudio?: (connection: string, signal: AbortSignal) => Promise<unknown>;
}

export interface ConvertedLocalDocument {
	parsed: FastApiDocumentParseResult;
	markdown: string;
	contentType: string | null;
	transcriptionMetadata: Record<string, unknown>;
}

/**
 * Convert one local file into a CanonicalDocument and its Markdown. Audio is transcribed first, into a
 * timed transcript beside the input. Nothing else is written: each caller decides where the results
 * live, so Research material stays in its Provider workspace and attachment parses stay in the Goal cache.
 */
export async function convertLocalDocument(
	request: { inputPath: string; sourceName: string; title?: string; signal: AbortSignal },
	converters: LocalDocumentConverters = {},
): Promise<ConvertedLocalDocument> {
	const inputRoot = dirname(request.inputPath);
	let parserInputPath = request.inputPath;
	let contentType: string | null = null;
	let transcriptionMetadata: Record<string, unknown> = {};
	if (AUDIO_EXTENSIONS.has(extname(request.inputPath).toLowerCase())) {
		const prepareAudio = converters.prepareAudio
			?? ((connection, signal) => getAudioLocalRuntimeManager().prepare(connection, signal));
		await prepareAudio(defaultSttConnection(), request.signal);
		const transcription = await (converters.transcribeAudio ?? transcribe)({
			filePath: request.inputPath,
			mode: "job",
			signal: request.signal,
		});
		if (!transcription.ok) throw new Error(`audio transcription failed through ${transcription.provider}: ${transcription.reason}`);
		parserInputPath = join(inputRoot, "transcript.timed.json");
		writeFileAtomic(parserInputPath, `${JSON.stringify(timedTranscript(transcription, request.title ?? request.sourceName), null, 2)}\n`);
		contentType = TIMED_TRANSCRIPT_CONTENT_TYPE;
		transcriptionMetadata = {
			transcriptionProvider: transcription.provider,
			transcriptionModel: transcription.model,
			transcriptionLanguage: transcription.language,
			transcriptionDurationSec: transcription.durationSec,
		};
	}
	const parsed = await (converters.documentParser ?? new HttpFastApiDocumentParser()).parse({
		inputPath: parserInputPath,
		inputRoot,
		...(contentType ? { contentType } : {}),
		sourceName: request.sourceName,
		title: request.title,
		signal: request.signal,
	});
	const markdown = renderCanonicalDocumentMarkdown(parsed.document);
	if (!markdown.trim()) throw new Error(`parser ${parsed.manifest.parser} returned an empty canonical document`);
	return { parsed, markdown, contentType, transcriptionMetadata };
}

function timedTranscript(transcript: TranscriptResult, title: string): Record<string, unknown> {
	const segments = transcript.segments.length > 0
		? transcript.segments
		: transcript.text.trim()
			? [{ start: 0, end: transcript.durationSec ?? 0, text: transcript.text.trim() }]
			: [];
	if (segments.length === 0) throw new Error("audio transcription returned no text");
	return {
		schema_name: "TimedTranscript",
		version: 1,
		source: {
			title,
			...(transcript.durationSec !== undefined ? { duration_ms: Math.max(0, Math.round(transcript.durationSec * 1_000)) } : {}),
		},
		chapters: [],
		segments: segments.map((segment, index) => ({
			id: `segment:${index + 1}`,
			start_ms: Math.max(0, Math.round(segment.start * 1_000)),
			end_ms: Math.max(0, Math.round(Math.max(segment.start, segment.end) * 1_000)),
			text: segment.text.trim(),
		})).filter((segment) => segment.text),
	};
}
