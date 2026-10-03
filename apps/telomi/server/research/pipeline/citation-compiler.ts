import { validateCanonicalMarkdown } from "../../citations/contracts.js";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";

import type { CornellNoteRecord, CornellNotesSnapshot } from "../../cornell/contracts.js";
import type { ExecutableReportPlan, ExecutableReportSection } from "./report-plan.js";
import type { PublishedArtifactDirectoryRef } from "../../agent-runtime/artifact-store.js";
import type { ResolvedWikiReportCitation } from "./wiki-report-references.js";
import { normalizeGfmTables } from "./gfm-tables.js";

const INLINE_CITE = /<cite>([^<>\s]+)<\/cite>/gu;
const ANY_CITE = /<\/?cite\b/iu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`，。；：！？、]+/giu;
const AUTHORED_CITATION = /\[(?:\d+(?:\s*,\s*\d+)*)\](?:\([^)]*\))?/u;

export interface CompiledCitationReport {
	markdown: string;
	citationCount: number;
	/** One record per Source URL, in citation-number order. */
	citations: Array<{
		number: number;
		title: string;
		url?: string;
		provenance?: string;
		evidenceId?: string;
		/** Every Evidence ref cited under this number, in first-citation order. */
		refs?: string[];
		wiki?: ResolvedWikiReportCitation[];
	}>;
}

export interface KnowledgeCitationRegistry {
	schemaVersion: 1;
	knowledgeSha256: string;
	entries: Array<{
		ref?: string;
		/** Distinct Cue citations can share a Source URL without sharing one displayed number. */
		numberKey?: string;
		url: string;
		title: string;
		provenance: string;
		fileRefs: string[];
		evidenceId?: string;
		wiki?: ResolvedWikiReportCitation;
	}>;
}

export interface ChapterInput {
	sectionId: string;
	markdown: string;
}

type RegistryEntry = KnowledgeCitationRegistry["entries"][number];

/** Citation numbers keyed by Source URL, or by a Cue ref when exact Cue identity matters. */
type NumberedSources = Map<string, { number: number; entries: RegistryEntry[] }>;

/** Compile one Main Agent answer with the same citation format as Canonical Reports. */
export function compileStandaloneCitationMarkdown(args: {
	markdown: string;
	citationRegistry: KnowledgeCitationRegistry;
}): CompiledCitationReport {
	const sources: NumberedSources = new Map();
	let citationCount = 0;
	const body = normalizeGfmTables(args.markdown.trim()).replace(INLINE_CITE, (_citation, value: string) => {
		const source = resolveRegisteredCitation(args.citationRegistry, value);
		if (!source) throw new Error(`Citation '${value}' is not present in the frozen Knowledge Snapshot`);
		citationCount += 1;
		return renderInlineCitation(numberSource(sources, source), source.url);
	});
	if (ANY_CITE.test(body)) throw new Error("Main Agent answer contains a malformed Wiki citation");
	const markdown = [
		collapseAdjacentCitations(body),
		...referencesSection(sources),
	].join("\n").trim() + "\n";
	return { markdown, citationCount, citations: citationRecords(sources) };
}

export function compileCanonicalMarkdown(args: {
	plan: ExecutableReportPlan;
	cornellNotes: CornellNotesSnapshot;
	chapters: readonly ChapterInput[];
	citationRegistry: KnowledgeCitationRegistry;
	/** Outline 全部 Section 认领的 Evidence，用于把引用限制在大纲认领范围内。 */
	outlineEvidenceIds?: ReadonlySet<string>;
}): CompiledCitationReport {
	const expectedSections = args.plan.sections.map((section) => section.section_id);
	const actualSections = args.chapters.map((chapter) => chapter.sectionId);
	if (JSON.stringify(expectedSections) !== JSON.stringify(actualSections)) {
		throw new Error(`Chapter order must match Selected Plan: expected ${expectedSections.join(", ")}, got ${actualSections.join(", ")}`);
	}
	const sources: NumberedSources = new Map();
	let citationCount = 0;
	const compiled = args.plan.sections.map((section, index) => compileChapter({
		section,
		chapter: args.chapters[index]!,
		cornellNotes: args.cornellNotes,
		sources,
		citationRegistry: args.citationRegistry,
		...(args.outlineEvidenceIds ? { outlineEvidenceIds: args.outlineEvidenceIds } : {}),
		onCitation: () => { citationCount += 1; },
	}));
	const markdown = [
		`# ${args.plan.title}`,
		"",
		...compiled.flatMap((chapter, index) => index === compiled.length - 1 ? [chapter] : [chapter, ""]),
		...referencesSection(sources),
	].join("\n").trim() + "\n";
	validateCanonicalMarkdown(markdown);
	return { markdown, citationCount, citations: citationRecords(sources) };
}

export function validateChapterCandidate(
	section: ExecutableReportSection,
	markdown: string,
	cornellNotes: CornellNotesSnapshot,
	citationRegistry?: KnowledgeCitationRegistry,
	/** Outline 全部 Section 认领的 Evidence。省略或为空表示 Outline 未认领，则不做这层限制。 */
	outlineEvidenceIds?: ReadonlySet<string>,
): void {
	if (!markdown.trim()) throw new Error(`Chapter '${section.section_id}' is empty`);
	const headings = markdown.split(/\r?\n/gu).filter((line) => /^#{1,2}\s/u.test(line.trim()));
	if (headings[0]?.trim() !== `## ${section.title}` || headings.length !== 1) {
		throw new Error(`Chapter '${section.section_id}' must contain exactly its own Section heading '## ${section.title}'`);
	}
	if (AUTHORED_CITATION.test(markdown)) throw new Error(`Chapter '${section.section_id}' contains an Agent-authored citation number`);
	const matches = [...markdown.matchAll(INLINE_CITE)];
	const markdownWithoutCitations = markdown.replace(INLINE_CITE, "");
	if (ANY_CITE.test(markdownWithoutCitations)) {
		throw new Error(`Chapter '${section.section_id}' contains a malformed inline Evidence citation`);
	}
	if (extractExternalUrls(markdownWithoutCitations).length > 0) {
		throw new Error(`Chapter '${section.section_id}' contains an external URL outside an inline Evidence citation`);
	}
	const evidenceById = new Map(cornellNotes.notes.map((item) => [item.note.source_id, item]));
	const assignedEvidenceBySource = new Map<string, CornellNoteRecord>();
	for (const evidenceId of section.claims.flatMap((claim) => claim.cornell_notes_refs)) {
		const evidence = requireEvidence(evidenceById, evidenceId);
		for (const locator of sourceLocators(evidence)) assignedEvidenceBySource.set(normalizeCitationSource(locator), evidence);
	}
	for (const match of matches) {
		const source = match[1]!;
		const registered = citationRegistry ? resolveRegisteredCitation(citationRegistry, source) : undefined;
		const normalized = registered?.url
			?? normalizedCitationOrThrow(source, `Chapter '${section.section_id}' contains a malformed inline Evidence citation`);
		if (citationRegistry && !registered) {
			throw new Error(`Citation URL '${source}' is not present in the frozen Knowledge Snapshot`);
		}
		// 归属只查到 Outline 这一层，不查到具体某一节：编辑纪律（重复对象归一节）由 Root 的编辑
		// 计划来管，它看得到全局，也能处理"先给结论"那种开篇引用后文证据的正当情形。Runtime 这层
		// 守的是"不能引用冻结知识快照之外的 URL"，也就是上面那条 registered 检查。
		if (registered?.evidenceId && outlineEvidenceIds && outlineEvidenceIds.size > 0
			&& !outlineEvidenceIds.has(registered.evidenceId)) {
			throw new Error(`Citation URL '${source}' is not claimed by the report Outline`);
		}
		if (!citationRegistry && !assignedEvidenceBySource.has(normalized)) {
			throw new Error(`Evidence source '${source}' is not assigned to Section '${section.section_id}'`);
		}
	}
}

export function buildKnowledgeCitationRegistry(input: {
	knowledgeSnapshot: PublishedArtifactDirectoryRef;
	cornellNotes: CornellNotesSnapshot;
}): KnowledgeCitationRegistry {
	const filesByUrl = new Map<string, Set<string>>();
	const metadataByUrl = new Map<string, { title?: string; provenance?: string; evidenceId?: string }>();
	for (const file of input.knowledgeSnapshot.files) {
		if (![".json", ".md", ".txt", ".yaml", ".yml"].includes(extname(file.relativePath).toLowerCase())) continue;
		const content = readFileSync(join(input.knowledgeSnapshot.absolutePath, file.relativePath), "utf-8");
		for (const value of extractExternalUrls(content)) {
			const normalized = tryNormalizeCitationSource(value);
			if (!normalized) continue;
			const refs = filesByUrl.get(normalized) ?? new Set<string>();
			refs.add(file.relativePath);
			filesByUrl.set(normalized, refs);
		}
		if (extname(file.relativePath).toLowerCase() === ".json") {
			try {
				collectStructuredUrlMetadata(JSON.parse(content), file.relativePath, filesByUrl, metadataByUrl);
			} catch {
				// Invalid structured files remain visible as text but cannot provide trusted metadata.
			}
		}
	}
	const evidenceByUrl = new Map(input.cornellNotes.notes.flatMap((evidence) => sourceLocators(evidence).map((locator) => [
		normalizedCitationOrThrow(locator, `Cornell Note '${evidence.note.source_id}' has malformed canonical locator`),
		evidence,
	] as const)));
	const entries = [...filesByUrl.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([url, refs]) => {
		const fileRefs = [...refs].sort();
		const evidence = evidenceByUrl.get(url);
		const metadata = metadataByUrl.get(url);
		return evidence ? {
			url,
			title: evidence.title,
			provenance: evidence.provenance_ref,
			fileRefs,
			evidenceId: evidence.note.source_id,
		} : {
			url,
			title: metadata?.title ?? fallbackUrlTitle(url),
			provenance: metadata?.provenance
				?? `knowledge_snapshot:${input.knowledgeSnapshot.relativePath}/${fileRefs[0]}`,
			fileRefs,
			...(metadata?.evidenceId ? { evidenceId: metadata.evidenceId } : {}),
		};
	});
	return { schemaVersion: 1, knowledgeSha256: input.knowledgeSnapshot.sha256, entries };
}

function collectStructuredUrlMetadata(
	value: unknown,
	fileRef: string,
	filesByUrl: Map<string, Set<string>>,
	metadataByUrl: Map<string, { title?: string; provenance?: string; evidenceId?: string }>,
): void {
	if (typeof value === "string") {
		for (const candidate of extractExternalUrls(value)) {
			const url = tryNormalizeCitationSource(candidate);
			if (!url) continue;
			const refs = filesByUrl.get(url) ?? new Set<string>();
			refs.add(fileRef);
			filesByUrl.set(url, refs);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStructuredUrlMetadata(item, fileRef, filesByUrl, metadataByUrl);
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (typeof record.canonical_locator === "string") {
		const url = tryNormalizeCitationSource(record.canonical_locator);
		if (url) {
			const refs = filesByUrl.get(url) ?? new Set<string>();
			refs.add(fileRef);
			filesByUrl.set(url, refs);
			metadataByUrl.set(url, {
				...(typeof record.title === "string" && record.title.trim() ? { title: record.title.trim() } : {}),
				...(typeof record.provenance_ref === "string" ? { provenance: record.provenance_ref }
					: typeof record.source_id === "string" ? { provenance: record.source_id } : {}),
				...(typeof record.evidence_id === "string" ? { evidenceId: record.evidence_id } : {}),
			});
		}
	}
	for (const child of Object.values(record)) {
		collectStructuredUrlMetadata(child, fileRef, filesByUrl, metadataByUrl);
	}
}

export function extractExternalUrls(markdown: string): string[] {
	return [...new Set([...markdown.matchAll(URL_PATTERN)].map((match) => trimMarkdownUrl(match[0])))];
}


function compileChapter(args: {
	section: ExecutableReportSection;
	chapter: ChapterInput;
	cornellNotes: CornellNotesSnapshot;
	sources: NumberedSources;
	citationRegistry: KnowledgeCitationRegistry;
	outlineEvidenceIds?: ReadonlySet<string>;
	onCitation(): void;
}): string {
	if (args.chapter.sectionId !== args.section.section_id) {
		throw new Error(`Chapter '${args.chapter.sectionId}' does not match Section '${args.section.section_id}'`);
	}
	validateChapterCandidate(args.section, args.chapter.markdown, args.cornellNotes, args.citationRegistry,
		args.outlineEvidenceIds);
	const body = normalizeGfmTables(args.chapter.markdown.trim()).replace(INLINE_CITE, (_citation, source: string) => {
		const citation = resolveRegisteredCitation(args.citationRegistry, source);
		if (!citation) throw new Error(`Citation URL '${source}' is not present in the frozen Knowledge Snapshot`);
		args.onCitation();
		return renderInlineCitation(numberSource(args.sources, citation), citation.url);
	});
	return collapseAdjacentCitations(body);
}

function resolveRegisteredCitation(
	registry: KnowledgeCitationRegistry,
	value: string,
): KnowledgeCitationRegistry["entries"][number] | undefined {
	const byRef = registry.entries.find((entry) => entry.ref === value);
	if (byRef) return byRef;
	const normalized = tryNormalizeCitationSource(value);
	return normalized ? registry.entries.find((entry) => !entry.ref && entry.url === normalized) : undefined;
}

/** Source URLs normally share one number; a Cue with `numberKey` retains its own number. */
function numberSource(sources: NumberedSources, entry: RegistryEntry): number {
	const key = entry.numberKey ?? entry.url;
	let source = sources.get(key);
	if (!source) {
		source = { number: sources.size + 1, entries: [] };
		sources.set(key, source);
	}
	if (!source.entries.includes(entry)) source.entries.push(entry);
	return source.number;
}

/** 相邻的完全相同引用只保留一个；隔着正文的重复引用保留。 */
function collapseAdjacentCitations(markdown: string): string {
	return markdown.replace(/(\[\[\d+\]\](?:\([^)\s]*\))?)(?:\s*\1)+/gu, "$1");
}

function requireEvidence(evidenceById: Map<string, CornellNoteRecord>, evidenceId: string): CornellNoteRecord {
	const evidence = evidenceById.get(evidenceId);
	if (!evidence) throw new Error(`Unknown Evidence Reference '${evidenceId}'`);
	return evidence;
}

function renderInlineCitation(number: number, url: string): string {
	const target = safeMarkdownTarget(url);
	return target ? `[[${number}]](${target})` : `[[${number}]]`;
}

function referencesSection(sources: NumberedSources): string[] {
	const references = [...sources.values()].map(({ number, entries: [source] }) => {
		const title = escapeMarkdownText(source!.title);
		const target = safeMarkdownTarget(source!.url);
		return target ? `${number}. [${title}](${target})` : `${number}. ${title}`;
	});
	return references.length > 0 ? ["", "## References", "", ...references] : [];
}

function citationRecords(sources: NumberedSources): CompiledCitationReport["citations"] {
	return [...sources.values()].map(({ number, entries }) => {
		const source = entries[0]!;
		const url = safeMarkdownTarget(source.url);
		const refs = entries.flatMap((entry) => entry.ref ? [entry.ref] : []);
		const wiki = entries.flatMap((entry) => entry.wiki ? [entry.wiki] : []);
		return {
			number,
			title: source.title,
			...(url ? { url } : {}),
			provenance: source.provenance,
			...(source.evidenceId ? { evidenceId: source.evidenceId } : {}),
			...(refs.length > 0 ? { refs } : {}),
			...(wiki.length > 0 ? { wiki } : {}),
		};
	});
}

function safeMarkdownTarget(value: string): string | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function escapeMarkdownText(value: string): string {
	return value.replace(/[\\[\]]/gu, "\\$&").replace(/\s+/gu, " ").trim();
}

function trimMarkdownUrl(value: string): string {
	let url = value.replace(/[.,;:!?]+$/gu, "");
	for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
		while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
	}
	return url;
}

export function normalizeCitationSource(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Evidence citation source must use http:// or https://: '${value}'`);
	}
	url.hash = "";
	return url.href;
}

function normalizedCitationOrThrow(value: string, message: string): string {
	try {
		return normalizeCitationSource(value);
	} catch {
		throw new Error(message);
	}
}

function tryNormalizeCitationSource(value: string): string | undefined {
	try {
		return normalizeCitationSource(value);
	} catch {
		return undefined;
	}
}

function sourceLocators(evidence: CornellNoteRecord): string[] {
	return [...new Set([evidence.canonical_locator, ...evidence.members.map((member) => member.canonical_locator)])];
}

function fallbackUrlTitle(value: string): string {
	const url = new URL(value);
	return `${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
}
