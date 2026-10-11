export interface InlineCitation {
	raw: string;
	start: number;
	end: number;
	refs: string[];
}

/** One citation syntax for validation, compilation and durable ref mapping. */
export function parseInlineCitations(markdown: string): InlineCitation[] {
	const citations: InlineCitation[] = [];
	let cursor = 0;
	const malformed = (text: string): never => {
		throw new Error(`Malformed inline citation ${JSON.stringify(text.slice(0, 160))}. Use <cite>N1</cite> or comma-separated complete refs such as <cite>N1,N2</cite>; empty refs and tag attributes are invalid.`);
	};
	const checkRemainder = (text: string) => {
		const match = /<\/?cite\b/iu.exec(text);
		if (match) malformed(text.slice(match.index));
	};
	for (const match of markdown.matchAll(/<cite>([^<>]*)<\/cite>/gu)) {
		checkRemainder(markdown.slice(cursor, match.index));
		const value = match[1]!.trim();
		// Historical URL citations may contain commas as part of their path or query.
		const refs = /^https?:\/\//iu.test(value) ? [value] : value.split(",").map(ref => ref.trim());
		if (refs.some(ref => !ref || /[\s<>]/u.test(ref))) malformed(match[0]);
		cursor = match.index + match[0].length;
		citations.push({ raw: match[0], start: match.index, end: cursor, refs: [...new Set(refs)] });
	}
	checkRemainder(markdown.slice(cursor));
	return citations;
}

export function replaceInlineCitations(markdown: string, render: (refs: readonly string[]) => string): string {
	const citations = parseInlineCitations(markdown);
	let cursor = 0;
	let result = "";
	for (const citation of citations) {
		result += markdown.slice(cursor, citation.start) + render(citation.refs);
		cursor = citation.end;
	}
	return result + markdown.slice(cursor);
}
