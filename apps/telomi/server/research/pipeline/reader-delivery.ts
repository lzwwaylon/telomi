import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../lib/hash.js";
import { inferOutputLanguage, OUTPUT_LANGUAGES, type ResolvedOutputLanguage } from "../../../shared/languages.js";

export interface ReaderFileAcceptanceOptions {
	root: string;
	runtimeRoot: string;
	workspace: string;
	identity: { child_id: string; session_id: string; revision: number; task: string; follow_up?: string };
	submission: number;
	language: ResolvedOutputLanguage;
	signal?: AbortSignal;
}

export function readReaderFile(path: string): string {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error(`${path} must be a private regular file under 16 MB, not a link`);
		return readFileSync(descriptor, "utf8");
	} finally { closeSync(descriptor); }
}

export async function validateReaderFile(options: ReaderFileAcceptanceOptions) {
	options.signal?.throwIfAborted();
	if (!/^sub-[A-Za-z0-9-]+$/u.test(options.identity.child_id)) throw new Error("Invalid Reader child identity");
	if (!Number.isSafeInteger(options.identity.revision) || options.identity.revision < 1) throw new Error("Invalid Reader file revision");
	if (!Number.isSafeInteger(options.submission) || options.submission < 1 || options.submission > 3) throw new Error("Invalid Reader file submission");
	const bytes = readReaderFile(join(options.workspace, "note.json"));
	if (!OUTPUT_LANGUAGES.some((language) => language !== "auto" && language === options.language)) throw new Error("Reader file delivery requires a resolved output language");
	const { validateNoteReadingDraftFromCorpus } = await import("../note-reading.js");
	const value = validateNoteReadingDraftFromCorpus(JSON.parse(bytes), options.identity.task, options.identity.child_id, join(options.root, "source"));
	const prose = [{ field: "summary and gaps", text: [value.summary, ...value.gaps].join("\n") },
		...value.cues.map((cue, index) => ({ field: `Cue ${index + 1} text (cue + note)`, text: `${cue.cue}\n${cue.note}` }))];
	for (const { field, text } of prose) {
		if (inferOutputLanguage(text) !== options.language) throw new Error(`${field} must use output language ${options.language}; revise the complete note.json while preserving Source citations and original quoted evidence`);
	}
	options.signal?.throwIfAborted();
	return { bytes, value };
}

export function publishReaderFile(options: ReaderFileAcceptanceOptions, { bytes, value }: Awaited<ReturnType<typeof validateReaderFile>>) {
	options.signal?.throwIfAborted();
	const { child_id: childId, revision } = options.identity;
	const relativePath = `inputs/reader-results/${childId}/${revision}`;
	const receipt = { schema_version: 1, ...options.identity, submission: options.submission, language: options.language,
		status: value.status, summary: value.summary, gaps: value.gaps,
		note_path: `${relativePath}/note.json`,
		note_sha256: sha256(bytes), validated_path: `${relativePath}/validated.json` };
	const staging = mkdtempSync(join(options.runtimeRoot, `${childId}-delivery-${revision}-`));
	try {
		writeFileSync(join(staging, "note.json"), bytes);
		writeFileSync(join(staging, "validated.json"), `${JSON.stringify(value, null, 2)}\n`);
		writeFileSync(join(staging, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
		mkdirSync(join(options.root, "inputs", "reader-results", childId), { recursive: true });
		options.signal?.throwIfAborted();
		renameSync(staging, join(options.root, relativePath));
	} finally { rmSync(staging, { recursive: true, force: true }); }
	return receipt;
}

/** Accept one submission; the caller owns Session repair, failure handling and delivery logs. */
export async function acceptReaderFile(options: ReaderFileAcceptanceOptions) {
	return publishReaderFile(options, await validateReaderFile(options));
}
