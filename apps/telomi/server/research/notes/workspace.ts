import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CornellNote } from "../cornell-note.js";

export interface NoteWorkspaceItem {
	ref: string;
	source_ref: string;
	source_id: string;
	source_title: string;
	source_urls: string[];
	section_title: string;
	section_summary: string;
	cue: string;
	note: string;
	topic_refs?: string[];
	topic_plan_revision?: string;
	evidence: Array<{
		source_path: string;
		start_line: number;
		end_line: number;
		content_sha256: string;
	}>;
}

export interface NoteWorkspaceQuery {
	operation: "summary" | "catalog" | "search" | "get";
	offset?: number;
	limit?: number;
	/** 一个或多个 Source 句柄（@N）。省略表示全部。 */
	source?: string | string[];
	/** summary 中控制 Section 详情；get=false 时省略 Runtime 自己持有的 URL 与 Evidence anchors。 */
	detail?: boolean;
	query?: string;
	refs?: string[];
}

const MAX_OUTPUT_CHARS = 12_000;
// Input protection only; fitPage decides the number of Notes actually returned.
const MAX_GET_REFS = 256;
const MAX_LIST = 20;
const MAX_CATALOG = 100;

/**
 * Pages are filled by character budget, not by record count. `limit` only caps how many records a
 * page may consider; the budget decides how many it actually carries, so a caller never has to guess
 * a count that happens to fit. Records are measured as indented JSON because that is the widest form
 * any consumer renders.
 */
function renderedLength(value: unknown): number {
	return JSON.stringify(value, null, 2).length;
}

function fitPage<T>(records: readonly T[], build: (page: readonly T[]) => Record<string, unknown>): {
	page: readonly T[];
	body: Record<string, unknown>;
} {
	let page: readonly T[] = [];
	let body = build(page);
	for (const record of records) {
		const candidate = [...page, record];
		const next = build(candidate);
		// The first record always ships: a page that fits nothing leaves the caller no way forward.
		if (page.length > 0 && renderedLength(next) > MAX_OUTPUT_CHARS) break;
		page = candidate;
		body = next;
	}
	return { page, body };
}

export class NoteWorkspace {
	readonly inspectedRefs = new Set<string>();
	private readonly notes: NoteWorkspaceItem[];
	private readonly byRef: ReadonlyMap<string, NoteWorkspaceItem>;

	constructor(notes: readonly NoteWorkspaceItem[]) {
		this.notes = [...notes].sort((left, right) => left.ref.localeCompare(right.ref, undefined, { numeric: true }));
		this.byRef = new Map(this.notes.map((note) => [note.ref, note]));
		if (this.byRef.size !== this.notes.length) throw new Error("Note Workspace contains duplicate refs");
	}

	get size(): number {
		return this.notes.length;
	}

	citation(ref: string): NoteWorkspaceItem | undefined {
		return this.byRef.get(ref);
	}

	/**
	 * Note ref 对应的引用 URL：该 Source 的第一个 source_url（分组 Source 即 canonical locator）。
	 * 引用走 ref 而不是手抄 URL，Runtime 才能确定性地解析归属——URL 可以抄错，ref 抄错直接查无此人。
	 */
	citationUrl(ref: string): string | undefined {
		return this.byRef.get(ref)?.source_urls[0];
	}

	query(params: NoteWorkspaceQuery): unknown {
		return this.execute(params);
	}

	private execute(params: NoteWorkspaceQuery): unknown {
		if (params.operation === "summary") return this.summary(params);
		if (params.operation === "catalog") return this.catalog(params);
		if (params.operation === "search") return this.search(params);
		if (params.operation === "get") return this.get(params);
		throw new Error("Unsupported Note Workspace operation");
	}

	/**
	 * 两级。默认是紧凑花名册：每个 Source 一行，只带标题、来源站点、cue 数与各 Section 标题——
	 * 108 个 Source 装得进两三页，调用者能一次看清全景再决定看谁。`detail` 或指定 source 时才
	 * 展开 Section 摘要正文；那份全量约 29 万字符、25 页以上，读完全景就已经被淹没了，
	 * 于是只能退回让检索排序替自己做选择。
	 */
	private summary(params: NoteWorkspaceQuery): unknown {
		const selected = this.filtered(params.source);
		const grouped = new Map<string, NoteWorkspaceItem[]>();
		for (const note of selected) grouped.set(note.source_ref, [...(grouped.get(note.source_ref) ?? []), note]);
		const offset = nonNegativeInteger(params.offset, 0, "offset");
		const detail = params.detail === true || params.source !== undefined;
		const limit = boundedInteger(params.limit, detail ? MAX_LIST : MAX_CATALOG, 1, MAX_CATALOG, "limit");
		const candidates = [...grouped].slice(offset, offset + limit).map(([sourceRef, notes]) => {
			// 花名册只承载"这是什么、来自哪、里面有哪几块"，够用来挑人就行。完整 URL、source_id
			// 与逐 Section 计数都是详情级的负担：它们把全景撑到几十页，而全景一旦读不完就不会被用。
			if (!detail) {
				return {
					source_ref: sourceRef,
					title: notes[0]!.source_title,
					origins: [...new Set(notes[0]!.source_urls.map(originHost))],
					note_count: notes.length,
					// 两级用同一种形状，详情级只是多几个字段：调用者一套解析代码就够。
					sections: [...new Set(notes.map((note) => note.section_title))].map((title) => ({ title })),
				};
			}
			return {
				source_ref: sourceRef,
				source_id: notes[0]!.source_id,
				title: notes[0]!.source_title,
				source_urls: notes[0]!.source_urls,
				note_count: notes.length,
				sections: [...new Map(notes.map((note) => [note.section_title, {
					title: note.section_title,
					summary: note.section_summary,
					cue_count: notes.filter((item) => item.section_title === note.section_title).length,
				}])).values()],
			};
		});
		return fitPage(candidates, (sources) => ({
			total_notes: selected.length,
			total_sources: grouped.size,
			detail,
			offset,
			next_offset: offset + sources.length < grouped.size ? offset + sources.length : null,
			...(detail ? {} : {
				next_step: "Pick the Source handles worth reading, then call summary with source=[...] for their Section summaries.",
			}),
			sources,
		})).body;
	}

	private catalog(params: NoteWorkspaceQuery): unknown {
		const values = this.filtered(params.source);
		const offset = nonNegativeInteger(params.offset, 0, "offset");
		const limit = boundedInteger(params.limit, MAX_CATALOG, 1, MAX_CATALOG, "limit");
		const lines = values.slice(offset, offset + limit).map((note) =>
			[note.ref, note.source_ref, note.section_title, note.cue].map((value) => value.replaceAll("|", "/")).join("|"));
		return fitPage(lines, (page) => ({
			format: "note_ref|source_ref|section|cue",
			total: values.length,
			offset,
			next_offset: offset + page.length < values.length ? offset + page.length : null,
			catalog: page.join("\n"),
		})).body;
	}

	private search(params: NoteWorkspaceQuery): unknown {
		if (!params.query?.trim()) throw new Error("search requires query");
		const terms = params.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
		const values = this.filtered(params.source).map((note) => ({
			note,
			score: terms.reduce((score, term) => score
				+ occurrences(`${note.source_title} ${note.section_title} ${note.section_summary} ${note.cue} ${note.note}`, term), 0),
		})).filter((item) => item.score > 0)
			.sort((left, right) => right.score - left.score
				|| left.note.ref.localeCompare(right.note.ref, undefined, { numeric: true }));
		const offset = nonNegativeInteger(params.offset, 0, "offset");
		const limit = boundedInteger(params.limit, MAX_LIST, 1, MAX_LIST, "limit");
		const candidates = values.slice(offset, offset + limit).map(({ note, score }) => ({
			ref: note.ref,
			source_ref: note.source_ref,
			source_title: note.source_title,
			section_title: note.section_title,
			cue: note.cue,
			score,
		}));
		return fitPage(candidates, (notes) => ({
			total: values.length,
			offset,
			next_offset: offset + notes.length < values.length ? offset + notes.length : null,
			notes,
		})).body;
	}

	private get(params: NoteWorkspaceQuery): unknown {
		if (!params.refs?.length) throw new Error("get requires refs");
		if (params.refs.length > MAX_GET_REFS) throw new Error(`get accepts at most ${MAX_GET_REFS} refs per request`);
		const unknown = params.refs.filter((ref) => !this.byRef.has(ref));
		if (unknown.length) throw new Error(`Unknown Note refs: ${unknown.join(", ")}`);
		const requestedNotes = params.refs.map((ref) => this.byRef.get(ref)!);
		const requested = params.detail === false ? requestedNotes.map((note) => ({
			ref: note.ref,
			source_ref: note.source_ref,
			source_title: note.source_title,
			section_title: note.section_title,
			section_summary: note.section_summary,
			cue: note.cue,
			note: note.note,
		})) : requestedNotes;
		const { page, body } = fitPage(requested, (notes) => ({
			notes,
			// Refs that did not fit are named so the caller re-requests them instead of losing them silently.
			...(notes.length < requested.length
				? { omitted_refs: requested.slice(notes.length).map((note) => note.ref) }
				: {}),
		}));
		// Only Notes actually returned count as inspected; an omitted ref was never shown to the caller.
		for (const note of requestedNotes.slice(0, page.length)) this.inspectedRefs.add(note.ref);
		return body;
	}

	private filtered(source: NoteWorkspaceQuery["source"]): NoteWorkspaceItem[] {
		if (source === undefined) return this.notes;
		const wanted = new Set(Array.isArray(source) ? source : [source]);
		if (wanted.size === 0) throw new Error("source must name at least one Source handle");
		const known = new Set(this.notes.map((note) => note.source_ref));
		const missing = [...wanted].filter((ref) => !known.has(ref));
		if (missing.length) throw new Error(`Unknown Source handles: ${missing.join(", ")}`);
		return this.notes.filter((note) => wanted.has(note.source_ref));
	}
}

export function loadReportNoteWorkspace(root: string): NoteWorkspace {
	const index = JSON.parse(readFileSync(join(root, "index.json"), "utf-8")) as {
		notes?: Array<{
			handle?: unknown;
			source_id?: unknown;
			title?: unknown;
			metadata_path?: unknown;
			source_urls?: unknown;
		}>;
	};
	if (!Array.isArray(index.notes)) throw new Error("Find Out Note index is invalid");
	const items: NoteWorkspaceItem[] = [];
	for (const [sourceIndex, record] of index.notes.entries()) {
		if (typeof record.handle !== "string" || typeof record.source_id !== "string"
			|| typeof record.title !== "string" || typeof record.metadata_path !== "string"
			|| !Array.isArray(record.source_urls)
			|| record.source_urls.some((url) => typeof url !== "string" || !url.trim())) {
			throw new Error(`Find Out Note index entry ${sourceIndex} is invalid`);
		}
		if (record.metadata_path.startsWith("/") || record.metadata_path.split(/[\\/]/u).includes("..")) {
			throw new Error(`Find Out Note index entry ${sourceIndex} has an unsafe metadata_path`);
		}
		const note = JSON.parse(readFileSync(join(root, record.metadata_path), "utf-8")) as CornellNote;
		if (note.schema_version !== 1 || note.source_id !== record.source_id || !Array.isArray(note.sections)) {
			throw new Error(`Find Out Cornell Note '${record.source_id}' is invalid`);
		}
		for (const section of note.sections) {
			for (const cue of section.cue_notes) {
				items.push({
					ref: `N${items.length + 1}`,
					source_ref: record.handle,
					source_id: note.source_id,
					source_title: record.title,
					source_urls: record.source_urls as string[],
					section_title: section.section_title,
					section_summary: section.summary,
					cue: cue.cue,
					note: cue.note,
					evidence: cue.evidence,
				});
			}
		}
	}
	return new NoteWorkspace(items);
}

function originHost(url: string): string {
	try {
		return new URL(url).host.replace(/^www\./u, "");
	} catch {
		return url.slice(0, 40);
	}
}

function occurrences(value: string, term: string): number {
	return value.toLocaleLowerCase().split(term).length - 1;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || result < 0) throw new Error(`${label} must be a non-negative integer`);
	return result;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || result < minimum || result > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
	}
	return result;
}
