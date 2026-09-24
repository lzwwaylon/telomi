import { existsSync, promises as fsp, statSync } from "node:fs";
import { basename, join } from "node:path";

import { fileBytes, probeDurationSec, spliceClips } from "../../audio/ffmpeg.js";
import { speakMany, captureAudioGeneration } from "../../audio/providers/tts.js";
import { writePrimePodcast } from "./writer.js";
import { caseCapture } from "../../observability/case-capture.js";
import type { PodcastGenerationBrief } from "./preferences.js";
import { inferOutputLanguage, type ResolvedOutputLanguage } from "../../../shared/languages.js";
import { toErrorMessage } from "../../lib/values.js";

const PODCAST_TTS_BLOCK_CHARS = 900;

export interface PodcastSourceSection {
	sectionId: string;
	title: string;
}

export interface PodcastScriptSection {
	sectionId: string;
	text: string;
}

export interface PodcastScript {
	sections: PodcastScriptSection[];
}

export interface PodcastGenerationResult {
	stagingDir: string;
	title: string;
	writingMode: PodcastWritingMode;
	durationSec?: number;
	bytes: number;
	sectionCount: number;
	blockCount: number;
	provider: string;
	model?: string;
	voice?: string;
	/** The Prime Root model that wrote the script; the Prime writer never switches models. */
	scriptModel: string;
}

export type PodcastWritingMode = "prime-multi-agent";

export interface PodcastWritingResult {
	title: string;
	language: string;
	writingMode: PodcastWritingMode;
	scriptModel: string;
	sourceSections: PodcastSourceSection[];
	script: PodcastScript;
}

export function splitPodcastTtsBlocks(text: string, maxChars = PODCAST_TTS_BLOCK_CHARS): string[] {
	return splitBoundedText(text, maxChars);
}

function splitBoundedText(text: string, maxChars: number): string[] {
	if (!Number.isFinite(maxChars) || maxChars < 1) throw new Error("maxChars must be positive");
	const paragraphs = text.split(/\n\s*\n/gu).map((value) => value.trim()).filter(Boolean);
	const units = paragraphs.flatMap((paragraph) => podcastCharacterCount(paragraph) <= maxChars
		? [paragraph]
		: splitLongParagraph(paragraph, maxChars));
	const chunks: string[] = [];
	let current = "";
	for (const unit of units) {
		const candidate = current ? `${current}\n\n${unit}` : unit;
		if (podcastCharacterCount(candidate) <= maxChars) {
			current = candidate;
			continue;
		}
		if (current) chunks.push(current);
		current = unit;
	}
	if (current) chunks.push(current);
	return chunks;
}

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
	const sentences = paragraph.match(/[^。！？.!?]+[。！？.!?]?/gu)?.map((value) => value.trim()).filter(Boolean)
		?? [paragraph];
	const chunks: string[] = [];
	let current = "";
	for (const sentence of sentences) {
		if (podcastCharacterCount(sentence) > maxChars) {
			if (current) {
				chunks.push(current);
				current = "";
			}
			const characters = Array.from(sentence);
			for (let start = 0; start < characters.length; start += maxChars) {
				chunks.push(characters.slice(start, start + maxChars).join(""));
			}
			continue;
		}
		const candidate = `${current}${sentence}`;
		if (podcastCharacterCount(candidate) <= maxChars) current = candidate;
		else {
			if (current) chunks.push(current);
			current = sentence;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function podcastCharacterCount(value: string): number {
	return Array.from(value).length;
}

/** The title the report writes for itself, or nothing. A caller that shows it to a user picks its
 * own fallback: an internal identifier is never a title. */
export function extractMarkdownTitle(source: string): string | undefined {
	return source.match(/^#\s+(.+)$/mu)?.[1]?.trim() || undefined;
}

export async function renderPodcastBundle(input: {
	stagingDir: string;
	script: PodcastScript;
	sourceSections: PodcastSourceSection[];
	slug: string;
	cardId: string;
	title: string;
	language: string;
	writingMode: PodcastWritingMode;
	emitProgress?: (next: string) => void;
}): Promise<Omit<PodcastGenerationResult, "stagingDir" | "scriptModel">> {
	const audio = captureAudioGeneration("podcast");
	const tts = audio;
	const segmentsDir = join(input.stagingDir, "segments");
	await fsp.mkdir(segmentsDir, { recursive: true });
	const blocks = input.script.sections.flatMap((section) =>
		splitPodcastTtsBlocks(section.text).map((text) => ({ sectionId: section.sectionId, text })));
	if (blocks.length === 0) throw new Error("Podcast Script contains no TTS blocks");
	const audioSegments = blocks.map((block, index) => {
		const id = `block-${String(index + 1).padStart(4, "0")}`;
		return {
			id,
			text: block.text,
			outPath: join(segmentsDir, `${id}.mp3`),
		};
	});
	const spoken = await speakMany({
		audio,
		consumer: "podcast",
		segments: audioSegments,
		onSegment: (done, total) => input.emitProgress?.(`合成语音 ${done}/${total}`),
	});
	if (!spoken.ok) throw new Error(`Podcast TTS failed (${spoken.provider}): ${spoken.reason}`);
	if (spoken.errors.length > 0) {
		throw new Error(`Podcast TTS failed (${spoken.provider}): ${spoken.errors.map((entry) => `${entry.id}: ${entry.error}`).join("; ")}`);
	}
	for (const segment of audioSegments) {
		if (!existsSync(segment.outPath) || statSync(segment.outPath).size <= 0) {
			throw new Error(`Podcast TTS produced no audio for ${segment.id}`);
		}
	}

	const episodePath = join(input.stagingDir, "episode.mp3");
	const spliced = await spliceClips(
		audioSegments.map((segment) => ({ src: segment.outPath, fadeInMs: 40, fadeOutMs: 40 })),
		episodePath,
	);
	if (!spliced.ok) throw new Error(`Podcast splice failed: ${spliced.stderr.split("\n").slice(-5).join("\n")}`);

	let cursorSec = 0;
	const transcriptBlocks = blocks.map((block, index) => {
		const duration = Math.max(0, probeDurationSec(audioSegments[index]!.outPath) ?? 0);
		const startSec = cursorSec;
		cursorSec += duration;
		return {
			id: audioSegments[index]!.id,
			sectionId: block.sectionId,
			text: block.text,
			startSec,
			endSec: cursorSec,
		};
	});
	const transcriptSections = input.sourceSections.map((section) => {
		const sectionBlocks = transcriptBlocks.filter((block) => block.sectionId === section.sectionId);
		return {
			id: section.sectionId,
			title: section.title,
			startSec: sectionBlocks[0]?.startSec ?? 0,
			endSec: sectionBlocks.at(-1)?.endSec ?? sectionBlocks[0]?.startSec ?? 0,
		};
	});
	const durationSec = probeDurationSec(episodePath) ?? cursorSec;
	const generatedAt = new Date().toISOString();
	const transcript = {
		version: 1,
		slug: input.slug,
		title: input.title,
		language: input.language,
		durationSec,
		sections: transcriptSections,
		blocks: transcriptBlocks,
	};
	const transcriptLines = [
		"---",
		`slug: ${JSON.stringify(input.slug)}`,
		`title: ${JSON.stringify(input.title)}`,
		"kind: synthesized",
		`language: ${JSON.stringify(input.language)}`,
		`generatedAt: ${JSON.stringify(generatedAt)}`,
		`sectionCount: ${input.script.sections.length}`,
		"---",
		"",
		`# ${input.title}`,
		"",
	];
	for (const section of input.sourceSections) {
		transcriptLines.push(`## ${section.title}`, "");
		const scriptSection = input.script.sections.find((candidate) => candidate.sectionId === section.sectionId);
		if (scriptSection) transcriptLines.push(scriptSection.text, "");
	}
	const actualVoice = spoken.results.find((entry) => entry.voice)?.voice ?? tts.voice;
	const manifest = {
		slug: input.slug,
		cardId: input.cardId,
		title: input.title,
		kind: "synthesized",
		writingMode: input.writingMode,
		createdAt: generatedAt,
		durationSec,
		bytes: fileBytes(episodePath),
		sectionCount: input.script.sections.length,
		segmentCount: transcriptBlocks.length,
		blockCount: transcriptBlocks.length,
		language: input.language,
		voice: actualVoice ?? null,
		provider: spoken.provider,
		model: spoken.model ?? tts.model ?? null,
		sourceRef: { type: "media-card", ref: input.cardId },
		sections: transcriptSections,
	};
	await Promise.all([
		fsp.writeFile(join(input.stagingDir, "script.json"), `${JSON.stringify(input.script, null, 2)}\n`, "utf-8"),
		fsp.writeFile(join(input.stagingDir, "transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`, "utf-8"),
		fsp.writeFile(join(input.stagingDir, "transcript.md"), transcriptLines.join("\n"), "utf-8"),
		fsp.writeFile(join(input.stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8"),
	]);
	return {
		title: input.title,
		writingMode: input.writingMode,
		durationSec,
		bytes: fileBytes(episodePath),
		sectionCount: input.script.sections.length,
		blockCount: transcriptBlocks.length,
		provider: spoken.provider,
		model: spoken.model ?? tts.model,
		voice: actualVoice,
	};
}

export async function generateSingleNarratorPodcastScript(input: {
	cardId: string;
	sourceText: string;
	sessionDir: string;
	generationBrief: PodcastGenerationBrief;
	language?: ResolvedOutputLanguage;
	emitProgress: (next: string) => void;
	observe: (line: string) => void;
	signal: AbortSignal;
	skillWorkspaceDirectory?: string;
}): Promise<PodcastWritingResult> {
	const title = extractMarkdownTitle(input.sourceText) ?? input.cardId;
	const language = input.language ?? inferOutputLanguage(input.sourceText);
	const capture = caseCapture();
	const podcastInput = {
		sourceText: input.sourceText,
		sessionDir: input.sessionDir,
		title,
		language,
		audience: language === "zh-CN"
			? "不共享报告上下文的中文技术与产品决策者"
			: "English-speaking technical and product decision-makers who do not share the report context",
		generationBrief: {
			durablePreference: input.generationBrief.durablePreference,
			generationInstruction: input.generationBrief.generationInstruction,
		},
		emitProgress: input.emitProgress,
		observe: input.observe,
		signal: input.signal,
		...(input.skillWorkspaceDirectory ? { skillWorkspaceDirectory: input.skillWorkspaceDirectory } : {}),
	};
	// Capture 关闭时直接跑产品 Podcast Writer，不写 Evaluation Case。
	const prime = capture?.podcastWriter
		? await capture.podcastWriter(podcastInput, {
			recordDirectory: input.sessionDir,
			runId: basename(input.sessionDir),
			execute: writePrimePodcast,
		})
		: await writePrimePodcast(podcastInput);
	return {
		title: prime.title,
		language,
		writingMode: "prime-multi-agent",
		scriptModel: prime.rootModel,
		sourceSections: prime.sections.map((section) => ({
			sectionId: section.sectionId,
			title: section.title,
		})),
		script: {
			sections: prime.sections.map(({ sectionId, text }) => ({ sectionId, text })),
		},
	};
}

export async function generateSingleNarratorPodcast(input: {
	cardId: string;
	slug: string;
	sourceText: string;
	sessionDir: string;
	generationBrief: PodcastGenerationBrief;
	language?: ResolvedOutputLanguage;
	emitProgress: (next: string) => void;
	observe: (line: string) => void;
	signal: AbortSignal;
	skillWorkspaceDirectory?: string;
}): Promise<PodcastGenerationResult> {
	const stagingDir = join(input.sessionDir, "publish");
	await fsp.rm(stagingDir, { recursive: true, force: true });
	await fsp.mkdir(stagingDir, { recursive: true });
	const written = await generateSingleNarratorPodcastScript(input);
	input.emitProgress("合成语音");
	const rendered = await renderPodcastBundle({
		stagingDir,
		script: written.script,
		sourceSections: written.sourceSections,
		slug: input.slug,
		cardId: input.cardId,
		title: written.title,
		language: written.language,
		writingMode: written.writingMode,
		emitProgress: input.emitProgress,
	});
	return { stagingDir, scriptModel: written.scriptModel, ...rendered };
}

export async function publishPodcastBundle(stagingDir: string, podcastDir: string, publishId: string): Promise<void> {
	const names = ["script.json", "transcript.md", "transcript.json", "manifest.json", "episode.mp3"] as const;
	for (const name of names) {
		const source = join(stagingDir, name);
		if (!existsSync(source) || statSync(source).size <= 0) throw new Error(`Podcast bundle is missing ${name}`);
	}
	await fsp.mkdir(podcastDir, { recursive: true });
	const temporary = names.map((name) => ({
		name,
		source: join(stagingDir, name),
		target: join(podcastDir, name),
		temporary: join(podcastDir, `.${name}.${publishId}.next`),
		backup: join(podcastDir, `.${name}.${publishId}.previous`),
	}));
	const backedUp: typeof temporary = [];
	const installed: typeof temporary = [];
	let committed = false;
	try {
		for (const file of temporary) await fsp.copyFile(file.source, file.temporary);
		for (const file of temporary) {
			if (!existsSync(file.target)) continue;
			await fsp.rename(file.target, file.backup);
			backedUp.push(file);
		}
		for (const file of temporary) {
			await fsp.rename(file.temporary, file.target);
			installed.push(file);
		}
		committed = true;
		await Promise.all([
			fsp.rm(join(podcastDir, ".chain"), { recursive: true, force: true }),
			fsp.rm(join(podcastDir, "segments"), { recursive: true, force: true }),
			...[
				"episode_plan.json",
				"outline.json",
				"episode-decision.json",
			].map((name) => fsp.rm(join(podcastDir, name), { force: true })),
		]);
	} catch (error) {
		await Promise.all(installed.map((file) => fsp.rm(file.target, { force: true })));
		const rollbackErrors: string[] = [];
		for (const file of backedUp.reverse()) {
			try {
				await fsp.rename(file.backup, file.target);
			} catch (rollbackError) {
				rollbackErrors.push(`${file.name}: ${toErrorMessage(rollbackError)}`);
			}
		}
		if (rollbackErrors.length > 0) {
			throw new Error(`Podcast publication failed and rollback was incomplete: ${rollbackErrors.join("; ")}`, { cause: error });
		}
		throw error;
	} finally {
		await Promise.all(temporary.map((file) => fsp.rm(file.temporary, { force: true }).catch(() => undefined)));
		if (committed) {
			await Promise.all(temporary.map((file) => fsp.rm(file.backup, { force: true }).catch(() => undefined)));
		}
	}
}
