import { normalizeCitationSource, type KnowledgeCitationRegistry } from "../research/pipeline/citation-compiler.js";

interface CitationCue {
	ref: string;
	cue: string;
	source_title?: string;
	canonical_locator?: string;
	evidence: readonly { source_path: string; title?: string; url?: string }[];
}

/** A Cue can support several Sources; each URL shares its number with other cited Cues. */
export function cueCitationEntries(cue: CitationCue): KnowledgeCitationRegistry["entries"] {
	const entries = new Map<string, KnowledgeCitationRegistry["entries"][number]>();
	for (const anchor of cue.evidence) {
		const url = citationSourceUrl(anchor.url ?? cue.canonical_locator);
		const key = url || cue.ref;
		let entry = entries.get(key);
		if (!entry) {
			entry = { ref: cue.ref, url, title: anchor.title || cue.source_title || cue.cue,
				provenance: cue.ref, fileRefs: [], ...(!url ? { numberKey: cue.ref } : {}) };
			entries.set(key, entry);
		}
		if (!entry.fileRefs.includes(anchor.source_path)) entry.fileRefs.push(anchor.source_path);
	}
	return [...entries.values()];
}

/** HTTP Source identity ignores fragment navigation; local locators remain number-only. */
export function citationSourceUrl(value: string | undefined): string {
	try { return normalizeCitationSource(value ?? ""); } catch { return ""; }
}
