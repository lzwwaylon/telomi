import { hashJson } from "../lib/hash.js";
import { isRecord } from "../lib/values.js";
import type { GoalTopicPlan } from "./contracts.js";

export type ObjectFirstStage = "draft" | "objects" | "concepts" | "topics";
export interface ObjectFirstPage {
	id: string;
	kind: "entity" | "concept";
	title: string;
	description: string;
	body: string;
}
export interface ObjectFirstMember { ref: string; page: ObjectFirstPage; previous: boolean }
export interface ObjectFirstSection { ref: string; pageId: string; heading: string; startLine: number; endLine: number; contentSha256: string; anchor: string }
export interface ObjectFirstInput {
	stage: ObjectFirstStage;
	language: string;
	goal: { title: string; description: string };
	entryIds: string[];
	/** Notes not yet represented by objects; Concept reads these as an explicit exception. */
	notes: unknown[];
	members: ObjectFirstMember[];
	objects: ObjectFirstPage[];
	objectCatalog?: Array<Pick<ObjectFirstPage, "id" | "title" | "description">>;
	requiredEntries: string[];
	topics?: GoalTopicPlan;
	sections?: ObjectFirstSection[];
	knowledgeHash?: string;
	previousRelations?: Array<{ from: string; to: string; label: string }>;
}
export interface ObjectFirstPagesResult {
	pages: Array<ObjectFirstPage & { member_refs: string[] }>;
	retained_refs: string[];
	discarded_refs: Array<{ ref: string; reason: string }>;
	deferred_entries: Array<{ entry_ref: string; reason: string }>;
	relations: Array<{ from: string; to: string; label: string }>;
}
export interface ObjectFirstTopicResult {
	knowledgeHash: string;
	topicPlanRevision: string;
	topics: Array<{ topicId: string; sections: string[]; gaps: string[]; status?: 'succeeded' | 'failed'; error?: string }>;
}
export function objectFirstEntries(body: string): string[] {
	return [...new Set([...body.matchAll(/\[\[(entry:[a-f0-9]{24})\]\]/gu)].map(match => match[1]!))];
}
function fail(message: string): never { throw new Error(`Object-first output: ${message}`); }
function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) fail(`${field} must be non-empty text`);
	return value as string;
}
function strings(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string") || new Set(value).size !== value.length) fail(`${field} must contain unique strings`);
	return value as string[];
}
function shape(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
	if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${field} has invalid fields; expected ${keys.join(", ")}`);
}
export function validateObjectFirstResult(input: ObjectFirstInput, value: unknown): ObjectFirstPagesResult | ObjectFirstTopicResult {
	if (input.stage === "topics") {
		shape(value, ["knowledgeHash", "topicPlanRevision", "topics"], "index");
		if (value.knowledgeHash !== input.knowledgeHash || value.topicPlanRevision !== input.topics?.revision) fail("index belongs to a different knowledge/Topic revision");
		if (!Array.isArray(value.topics)) fail("topics must be an array");
		const known = new Set(input.sections?.map(section => section.ref));
		const covered: string[] = [];
		for (const row of value.topics) {
			shape(row, ["topicId", "sections", "gaps"], "topic association");
			covered.push(text(row.topicId, "topicId"));
			if (strings(row.sections, "sections").some(ref => !known.has(ref))) fail("index contains an unknown or stale Section ref");
			strings(row.gaps, "gaps").forEach(gap => text(gap, "gap"));
		}
		const expected = input.topics!.topics.map(topic => topic.id).sort();
		if (JSON.stringify(covered.sort()) !== JSON.stringify(expected)) fail("index must account for every Topic exactly once");
		return value as unknown as ObjectFirstTopicResult;
	}
	shape(value, ["pages", "retained_refs", "discarded_refs", "deferred_entries", "relations"], "result");
	if (![value.pages, value.discarded_refs, value.deferred_entries, value.relations].every(Array.isArray)) fail("pages, dispositions and relations must be arrays");
	const result = value as unknown as ObjectFirstPagesResult;
	const members = new Map(input.members.map(member => [member.ref, member]));
	const knownEntries = new Set(input.entryIds);
	const consumed: string[] = [];
	const retained = strings(result.retained_refs, "retained_refs");
	for (const ref of retained) {
		if (!members.get(ref)?.previous) fail(`only previous Pages can be retained: ${ref}`);
		consumed.push(ref);
	}
	const ids = new Set<string>();
	const cited = new Set<string>();
	const titles = new Set<string>();
	for (const page of result.pages) {
		shape(page, ["id", "kind", "title", "description", "body", "member_refs"], "page");
		const kind = input.stage === "concepts" ? "concept" : "entity";
		if (page.kind !== kind || !new RegExp(`^${kind}:[A-Za-z0-9][A-Za-z0-9_-]{0,100}$`, "u").test(page.id)) fail("Page id/kind is invalid");
		if (ids.has(page.id)) fail(`duplicate Page id ${page.id}`);
		ids.add(page.id);
		const identity = text(page.title, "title").normalize("NFKC").trim().toLocaleLowerCase();
		if (titles.has(identity)) fail(`duplicate Page title ${page.title}`);
		titles.add(identity);
		text(page.description, "description");
		text(page.body, "body");
		if (!/^##\s+\S/mu.test(page.body) || /^#\s|^---\s*$|^## (?:Related|Evidence)\s*$/mu.test(page.body)
			|| /https?:\/\/|\]\(/u.test(page.body)) fail("body requires H2 sections, Entry markers, and no frontmatter, raw URLs or hand-written links");
		const refs = objectFirstEntries(page.body);
		if (!refs.length || refs.some(ref => !knownEntries.has(ref))) fail(`Page ${page.id} cites missing/unknown Evidence`);
		const allMarkers = [...page.body.matchAll(/\[\[([^\]]+)\]\]/gu)].map(match => match[1]!);
		if (allMarkers.some(ref => !knownEntries.has(ref))) fail(`Page ${page.id} has unsupported markers`);
		refs.forEach(ref => cited.add(ref));
		const pageMembers = strings(page.member_refs, "member_refs");
		consumed.push(...pageMembers);
		const oldIdentity = input.members.find(member => member.previous && member.page.id === page.id);
		if (oldIdentity && !pageMembers.includes(oldIdentity.ref)) fail(`replacing ${page.id} must consume its previous Page`);
	}
	for (const ref of retained) {
		const page = members.get(ref)!.page;
		if (ids.has(page.id)) fail(`retained identity rewritten: ${page.id}`);
		ids.add(page.id);
		const identity = page.title.normalize("NFKC").trim().toLocaleLowerCase();
		if (titles.has(identity)) fail(`retained title duplicated: ${page.title}`);
		titles.add(identity);
		objectFirstEntries(page.body).forEach(ref => cited.add(ref));
	}
	// Published knowledge cannot turn into a deferral during a merge. This protects
	// provenance coverage; semantic fact preservation still requires independent review.
	for (const member of input.members.filter(member => member.previous)) {
		const destination = retained.includes(member.ref) ? member.page
			: result.pages.find(page => page.member_refs.includes(member.ref));
		if (!destination || objectFirstEntries(member.page.body).some(ref => !objectFirstEntries(destination.body).includes(ref))) {
			fail(`previous Page ${member.ref} must carry every existing citation into its destination`);
		}
	}
	for (const row of result.discarded_refs) {
		shape(row, ["ref", "reason"], "discard");
		text(row.reason, "discard reason");
		if (members.get(row.ref)?.previous) fail("previous knowledge cannot be discarded");
		consumed.push(row.ref);
	}
	if (new Set(consumed).size !== consumed.length || consumed.length !== members.size || consumed.some(ref => !members.has(ref))) fail("every input Page must be consumed, retained or explicitly discarded exactly once");
	const deferred = new Set<string>();
	for (const row of result.deferred_entries) {
		shape(row, ["entry_ref", "reason"], "deferral");
		text(row.reason, "deferral reason");
		if (!knownEntries.has(row.entry_ref) || cited.has(row.entry_ref) || deferred.has(row.entry_ref)) fail("invalid, cited or duplicate deferred Entry");
		deferred.add(row.entry_ref);
	}
	if (input.requiredEntries.some(ref => !cited.has(ref) && !deferred.has(ref))) fail("input Evidence was silently dropped");
	const relationIds = new Set([...ids, ...input.objects.map(page => page.id)]);
	const relations = new Set<string>();
	for (const row of result.relations) {
		shape(row, ["from", "to", "label"], "relation");
		text(row.label, "relation label");
		const key = `${row.from}\0${row.to}\0${row.label}`;
		if (!relationIds.has(row.from) || !relationIds.has(row.to) || row.from === row.to || relations.has(key)) fail("relation references a missing Page, itself or duplicates an edge");
		relations.add(key);
	}
	if (input.stage === "draft" && result.relations.length) fail("drafts do not own cross-Page relations");
	return result;
}
export function materializeObjectFirstPages(input: ObjectFirstInput, result: ObjectFirstPagesResult): ObjectFirstPage[] {
	return [...result.pages.map(({ member_refs: _members, ...page }) => page),
		...result.retained_refs.map(ref => input.members.find(member => member.ref === ref)!.page)];
}
/** Version-local refs: changed headings cannot accidentally resolve against an older view. */
export function objectFirstSections(pages: readonly ObjectFirstPage[]): ObjectFirstSection[] {
	return pages.flatMap(page => {
		const lines = page.body.split("\n");
		let fence: { character: string; length: number } | undefined;
		const seen = new Map<string, number>();
		const anchor = (text: string) => {
			const base = text.replace(/`([^`]+)`/gu, "$1").replace(/\*\*([^*]+)\*\*/gu, "$1").replace(/\*([^*]+)\*/gu, "$1").replace(/_([^_]+)_/gu, "$1").trim().toLowerCase().replace(/[\s　]+/gu, "-").replace(/[!-/:-@[-`{-~]/gu, "").replace(/-+/gu, "-").replace(/^-|-$/gu, "") || "h";
			const n = (seen.get(base) ?? 0) + 1; seen.set(base, n); return n > 1 ? `${base}-${n}` : base;
		};
		anchor(page.title);
		const headings = lines.flatMap((line, index) => {
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
			if (marker) {
				if (!fence) fence = { character: marker[1]![0]!, length: marker[1]!.length };
				else if (marker[1]![0] === fence.character && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
				return [];
			}
			if (fence) return [];
			const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/u.exec(line);
			if (!heading) return [];
			const id = anchor(heading[2]!);
			return heading[1] === "##" ? [{ title: heading[2]!, index, anchor: id }] : [];
		});
		return headings.map((heading, index) => {
			const end = headings[index + 1]?.index ?? lines.length;
			const contentSha256 = hashJson(lines.slice(heading.index, end));
			return { ref: `section:${hashJson({ page: page.id, body: page.body, index }).slice(0, 24)}`,
				pageId: page.id, heading: heading.title, startLine: heading.index + 1, endLine: end, contentSha256, anchor: heading.anchor };
		});
	});
}
