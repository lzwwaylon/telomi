import { isRecord } from "../lib/values.js";

export interface InvestigationResult {
	thread_id?: string;
	id: string;
	question: string;
	answer: string;
	citation_refs: string[];
	gaps: string[];
	wiki_sha256: string;
}

export function validateInvestigationResult(value: unknown, id: string, question: string): InvestigationResult {
	if (!isRecord(value) || value.id !== id || value.question !== question || typeof value.answer !== "string"
		|| !value.answer.trim() || value.answer.length > 32_000 || !Array.isArray(value.citation_refs)
		|| !Array.isArray(value.gaps) || typeof value.wiki_sha256 !== "string"
		|| (value.thread_id !== undefined && (typeof value.thread_id !== "string" || !/^[a-f0-9]{24}$/u.test(value.thread_id)))) {
		throw new Error("Invalid Prime investigation result");
	}
	const refs = value.citation_refs;
	const gaps = value.gaps;
	if (refs.some((ref: unknown) => typeof ref !== "string") || gaps.some((gap: unknown) => typeof gap !== "string")) {
		throw new Error("Prime investigation refs and gaps must be strings");
	}
	const cited = [...value.answer.matchAll(/<cite>([^<>\s]+)<\/cite>/gu)].map((match) => match[1]!);
	if (JSON.stringify([...new Set(cited)].sort()) !== JSON.stringify([...new Set(refs)].sort())
		|| refs.length !== new Set(refs).size) throw new Error("Prime investigation answer and citation refs disagree");
	return value as unknown as InvestigationResult;
}

export function validateCanonicalMarkdown(markdown: string): void {
	if (!markdown.trim()) throw new Error("Canonical Markdown is empty");
	if (/<\/?cite\b/iu.test(markdown)) throw new Error("Canonical Markdown contains unresolved inline Evidence citations");
	const lines = markdown.split(/\r?\n/gu);
	const referencesIndexes = lines
		.map((line, index) => line.trim() === "## References" ? index : -1)
		.filter((index) => index >= 0);
	const referencesIndex = referencesIndexes[0] ?? -1;
	if (
		referencesIndexes.length === 0
		|| !lines.slice(referencesIndex + 1).some((line) => /^\d+\.\s+\S/u.test(line.trim()))
	) {
		throw new Error("Canonical Markdown requires at least one Evidence Reference");
	}
	if (referencesIndexes.length !== 1) {
		throw new Error("Canonical Markdown requires exactly one Runtime-owned References Section");
	}
	if (!markdown.endsWith("\n")) throw new Error("Canonical Markdown must end with a newline");
}
