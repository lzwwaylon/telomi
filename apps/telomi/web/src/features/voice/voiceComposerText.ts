// Close TypeScript adaptation of OpenWhispr smartSpacing prepend rules.
const OPENING_CHARS = new Set([
	" ",
	"\t",
	"\n",
	"\r",
	"(",
	"[",
	"{",
	"<",
	'"',
	"'",
	"`",
	"“",
	"‘",
]);

const LEADING_PUNCTUATION = new Set([
	",",
	".",
	"!",
	"?",
	";",
	":",
	")",
	"]",
	"}",
	"%",
	"”",
	"’",
]);

// Telomi-only right-boundary rules. OpenWhispr's helper observes only the
// preceding character because OS paste owns selection replacement.
const INSERTION_SUFFIX_PUNCTUATION = new Set([
	...LEADING_PUNCTUATION,
	'"',
	"'",
	"`",
]);

export interface VoiceTextSelection {
	start: number;
	end: number;
}

export interface VoiceTranscriptInsertion {
	text: string;
	selection: VoiceTextSelection;
}

function clampSelectionOffset(offset: number, length: number): number {
	if (!Number.isFinite(offset)) return length;
	return Math.max(0, Math.min(length, Math.trunc(offset)));
}

function mergeVoiceInsertionSuffix(prefix: string, suffix: string): string {
	if (!suffix) return prefix;
	if (!prefix || /\s$/u.test(prefix) || /^\s/u.test(suffix)) {
		return prefix + suffix;
	}
	if (OPENING_CHARS.has(prefix.at(-1) ?? "")) {
		return prefix + suffix;
	}
	if (INSERTION_SUFFIX_PUNCTUATION.has(suffix[0] ?? "")) {
		return prefix + suffix;
	}
	return `${prefix} ${suffix}`;
}

/**
 * Insert an authoritative voice transcript at the composer's text selection.
 * Textarea offsets and String.slice both use UTF-16 code units.
 */
export function insertVoiceTranscript(
	currentDraft: string,
	transcript: string,
	selection: VoiceTextSelection,
): VoiceTranscriptInsertion {
	const first = clampSelectionOffset(selection.start, currentDraft.length);
	const second = clampSelectionOffset(selection.end, currentDraft.length);
	const normalizedSelection = {
		start: Math.min(first, second),
		end: Math.max(first, second),
	};
	if (!transcript) {
		return { text: currentDraft, selection: normalizedSelection };
	}
	const before = currentDraft.slice(0, normalizedSelection.start);
	const after = currentDraft.slice(normalizedSelection.end);
	const throughTranscript = mergeVoiceTranscript(before, transcript);
	const caret = throughTranscript.length;
	return {
		text: mergeVoiceInsertionSuffix(throughTranscript, after),
		selection: { start: caret, end: caret },
	};
}

/**
 * Merge one authoritative voice transcript into the current composer draft.
 * The composer already owns preceding text, so prepend spacing has no
 * Accessibility lookup cost and does not leave a synthetic trailing space.
 */
export function mergeVoiceTranscript(
	currentDraft: string,
	transcript: string,
): string {
	if (!transcript) return currentDraft;
	if (!currentDraft || /\s$/u.test(currentDraft) || /^\s/u.test(transcript)) {
		return currentDraft + transcript;
	}
	if (OPENING_CHARS.has(currentDraft.at(-1) ?? "")) {
		return currentDraft + transcript;
	}
	if (LEADING_PUNCTUATION.has(transcript[0] ?? "")) {
		return currentDraft + transcript;
	}
	return `${currentDraft} ${transcript}`;
}
