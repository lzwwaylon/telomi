/**
 * Correction extraction is adapted from OpenWhispr:
 * https://github.com/OpenWhispr/openwhispr/blob/e1cb8301d898881e28372e61ba15a8fd57f4f25b/src/utils/correctionLearner.js
 * OpenWhispr is MIT licensed. See THIRD_PARTY_NOTICES.md.
 */

import {
	existsSync,
	readFileSync,
	} from "node:fs";
import { join } from "node:path";
import { voiceDataRoot } from "../workspaces/server-runtime-paths.js";
import { writeJsonAtomic } from "../lib/fs.js";

const SETTINGS_SCHEMA_VERSION = 1;
const MAX_OBSERVATION_CHARS = 20_000;
const MAX_OBSERVATION_WORDS = 1_000;
const MAX_WORD_CHARS = 120;
// Learning is English-only: the character-level filters below assume Latin
// words. Han runs are split into their own tokens so a Latin word embedded in
// Chinese text ("测试一下TDS的效果") is still visible as a candidate, while the
// Han tokens themselves never pass LATIN_WORD.
const LATIN_WORD = /^[\p{Script=Latin}\p{N}'\u2019.-]+$/u;
const HAN_RUN = /(\p{Script=Han}+)/u;

export interface VoiceCorrectionLearningSettings {
	enabled: boolean;
	updatedAt: string | null;
}

interface StoredCorrectionLearningSettings {
	schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
	enabled: boolean;
	updatedAt: string;
}

export class VoiceCorrectionLearningStore {
	private readonly path: string;

	constructor(workspaceDir: string) {
		this.path = join(
			voiceDataRoot(workspaceDir),
			"correction-learning.json",
		);
	}

	getSettings(): VoiceCorrectionLearningSettings {
		if (!existsSync(this.path)) return { enabled: true, updatedAt: null };
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { enabled: true, updatedAt: null };
			}
			const record = parsed as Record<string, unknown>;
			if (
				record.schemaVersion !== SETTINGS_SCHEMA_VERSION ||
				typeof record.enabled !== "boolean" ||
				typeof record.updatedAt !== "string"
			) {
				return { enabled: true, updatedAt: null };
			}
			return { enabled: record.enabled, updatedAt: record.updatedAt };
		} catch {
			return { enabled: true, updatedAt: null };
		}
	}

	setEnabled(enabled: boolean): VoiceCorrectionLearningSettings {
		const stored: StoredCorrectionLearningSettings = {
			schemaVersion: SETTINGS_SCHEMA_VERSION,
			enabled,
			updatedAt: new Date().toISOString(),
		};
		writeJsonAtomic(this.path, stored);
		return { enabled: stored.enabled, updatedAt: stored.updatedAt };
	}
}

export function extractVoiceCorrections(
	originalText: string,
	editedText: string,
	existingDictionary: string[],
): string[] {
	if (!originalText || !editedText || originalText === editedText) return [];
	if (
		originalText.length > MAX_OBSERVATION_CHARS ||
		editedText.length > MAX_OBSERVATION_CHARS
	) {
		return [];
	}

	const editedRegion = findEditedRegion(originalText, editedText);
	if (editedRegion === originalText) return [];

	const originalWords = tokenize(originalText);
	const editedWords = tokenize(editedRegion);
	if (
		originalWords.length === 0 ||
		editedWords.length === 0 ||
		originalWords.length > MAX_OBSERVATION_WORDS ||
		editedWords.length > MAX_OBSERVATION_WORDS
	) {
		return [];
	}

	const substitutions = findSubstitutions(originalWords, editedWords);
	if (substitutions.length > originalWords.length * 0.5) return [];

	const dictionary = new Set(
		(Array.isArray(existingDictionary) ? existingDictionary : []).map((word) =>
			word.toLocaleLowerCase(),
		),
	);
	const seen = new Set<string>();
	const corrections: string[] = [];
	for (const [originalWord, correctedWord] of substitutions) {
		const normalized = correctedWord.toLocaleLowerCase();
		if (
			dictionary.has(normalized) ||
			seen.has(normalized) ||
			originalWord.toLocaleLowerCase() === normalized ||
			!LATIN_WORD.test(originalWord) ||
			!LATIN_WORD.test(correctedWord) ||
			correctedWord.length < 3 ||
			originalWord.length > MAX_WORD_CHARS ||
			correctedWord.length > MAX_WORD_CHARS
		) {
			continue;
		}
		const distance = editDistance(
			originalWord.toLocaleLowerCase(),
			normalized,
		);
		const maxLength = Math.max(originalWord.length, correctedWord.length);
		if (distance / maxLength > 0.65) continue;
		corrections.push(correctedWord);
		seen.add(normalized);
	}
	return corrections;
}

function editDistance(left: string, right: string): number {
	const rows = Array.from({ length: left.length + 1 }, () =>
		Array<number>(right.length + 1).fill(0),
	);
	for (let index = 0; index <= left.length; index += 1) rows[index]![0] = index;
	for (let index = 0; index <= right.length; index += 1) {
		rows[0]![index] = index;
	}
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			rows[leftIndex]![rightIndex] =
				left[leftIndex - 1] === right[rightIndex - 1]
					? rows[leftIndex - 1]![rightIndex - 1]!
					: 1 +
						Math.min(
							rows[leftIndex - 1]![rightIndex]!,
							rows[leftIndex]![rightIndex - 1]!,
							rows[leftIndex - 1]![rightIndex - 1]!,
						);
		}
	}
	return rows[left.length]![right.length]!;
}

function tokenize(text: string): string[] {
	return text
		.split(/\s+/)
		.flatMap((word) => word.split(HAN_RUN))
		.map((word) =>
			word.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, ""),
		)
		.filter(Boolean);
}

function findEditedRegion(originalText: string, fieldValue: string): string {
	if (fieldValue.length <= originalText.length * 1.5) return fieldValue;
	if (fieldValue.includes(originalText)) return originalText;

	const originalWords = tokenize(originalText);
	const fieldWords = tokenize(fieldValue);
	const windowSize = originalWords.length;
	if (fieldWords.length <= windowSize) return fieldValue;

	let bestStart = 0;
	let bestScore = -1;
	for (
		let start = 0;
		start <= fieldWords.length - windowSize;
		start += 1
	) {
		let matches = 0;
		for (let offset = 0; offset < windowSize; offset += 1) {
			if (
				fieldWords[start + offset]?.toLocaleLowerCase() ===
				originalWords[offset]?.toLocaleLowerCase()
			) {
				matches += 1;
			}
		}
		if (matches > bestScore) {
			bestScore = matches;
			bestStart = start;
		}
	}
	if (bestScore < windowSize * 0.3) return fieldValue;
	return fieldWords.slice(bestStart, bestStart + windowSize).join(" ");
}

function findSubstitutions(
	originalWords: string[],
	editedWords: string[],
): Array<[string, string]> {
	const rows = Array.from({ length: originalWords.length + 1 }, () =>
		Array<number>(editedWords.length + 1).fill(0),
	);
	for (
		let originalIndex = 1;
		originalIndex <= originalWords.length;
		originalIndex += 1
	) {
		for (
			let editedIndex = 1;
			editedIndex <= editedWords.length;
			editedIndex += 1
		) {
			rows[originalIndex]![editedIndex] =
				originalWords[originalIndex - 1]!.toLocaleLowerCase() ===
				editedWords[editedIndex - 1]!.toLocaleLowerCase()
					? rows[originalIndex - 1]![editedIndex - 1]! + 1
					: Math.max(
							rows[originalIndex - 1]![editedIndex]!,
							rows[originalIndex]![editedIndex - 1]!,
						);
		}
	}

	const aligned: Array<[string | null, string | null]> = [];
	let originalIndex = originalWords.length;
	let editedIndex = editedWords.length;
	while (originalIndex > 0 || editedIndex > 0) {
		if (
			originalIndex > 0 &&
			editedIndex > 0 &&
			originalWords[originalIndex - 1]!.toLocaleLowerCase() ===
				editedWords[editedIndex - 1]!.toLocaleLowerCase()
		) {
			aligned.unshift([
				originalWords[originalIndex - 1]!,
				editedWords[editedIndex - 1]!,
			]);
			originalIndex -= 1;
			editedIndex -= 1;
		} else if (
			editedIndex > 0 &&
			(originalIndex === 0 ||
				rows[originalIndex]![editedIndex - 1]! >=
					rows[originalIndex - 1]![editedIndex]!)
		) {
			aligned.unshift([null, editedWords[editedIndex - 1]!]);
			editedIndex -= 1;
		} else {
			aligned.unshift([originalWords[originalIndex - 1]!, null]);
			originalIndex -= 1;
		}
	}

	const substitutions: Array<[string, string]> = [];
	for (let index = 0; index < aligned.length - 1; index += 1) {
		const [originalWord, editedWord] = aligned[index]!;
		const [nextOriginalWord, nextEditedWord] = aligned[index + 1]!;
		if (
			originalWord !== null &&
			editedWord === null &&
			nextOriginalWord === null &&
			nextEditedWord !== null
		) {
			substitutions.push([originalWord, nextEditedWord]);
		}
	}
	return substitutions;
}
