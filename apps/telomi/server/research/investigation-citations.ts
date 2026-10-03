export interface InvestigationCitationCue {
	ref: string;
	cue: string;
	note: string;
	section_title: string;
	evidence: Array<{ source_path: string; start_line: number; end_line: number; excerpt?: string; title?: string; url?: string }>;
	source_title?: string;
	canonical_locator?: string;
	topic_refs?: string[];
	kind?: string;
	question?: string;
	summary?: string;
}

/** Short, invocation-local handles for Cues shown to Prime. Durable identities stay in Runtime. */
export function createInvestigationCitationScope() {
	const shortByDurable = new Map<string, string>();
	const durableByShort = new Map<string, string>();
	const wikiRefs = new Set<string>();
	const resolve = (ref: string): string => {
		if (wikiRefs.has(ref)) return ref;
		const durable = durableByShort.get(ref);
		if (!durable) throw new Error(`Prime cited unknown evidence '${ref}'`);
		return durable;
	};

	return {
		allowWikiRef(ref: string): void {
			if (!/^C[1-9]\d*$/u.test(ref)) throw new Error(`Invalid Wiki citation '${ref}'`);
			wikiRefs.add(ref);
		},
		projectCues(cues: readonly InvestigationCitationCue[]) {
			return cues.map((cue) => {
				let ref = shortByDurable.get(cue.ref);
				if (!ref) {
					ref = `N${shortByDurable.size + 1}`;
					shortByDurable.set(cue.ref, ref);
					durableByShort.set(ref, cue.ref);
				}
				return {
					ref, section_title: cue.section_title, cue: cue.cue, note: cue.note,
					...(cue.kind ? { kind: cue.kind } : {}),
					...(cue.question ? { question: cue.question } : {}),
					...(cue.summary ? { summary: cue.summary } : {}),
					...(cue.source_title ? { source_title: cue.source_title } : {}),
					...(cue.canonical_locator ? { canonical_locator: cue.canonical_locator } : {}),
					evidence: cue.evidence.map((item) => ({
					source_path: item.source_path, start_line: item.start_line, end_line: item.end_line,
					...(item.excerpt ? { excerpt: item.excerpt } : {}),
					...(item.title ? { title: item.title } : {}),
					...(item.url ? { url: item.url } : {}),
					})),
				};
			});
		},
		resolve,
		project(ref: string): string {
			if (wikiRefs.has(ref)) return ref;
			const short = shortByDurable.get(ref);
			if (!short) throw new Error(`Prime read unknown evidence '${ref}'`);
			return short;
		},
		restore<T extends { answer: string; citation_refs: string[] }>(result: T): T {
			return { ...result,
				answer: result.answer.replace(/<cite>([^<>\s]+)<\/cite>/gu,
					(_tag, ref: string) => `<cite>${resolve(ref)}</cite>`),
				citation_refs: result.citation_refs.map(resolve),
			};
		},
	};
}
