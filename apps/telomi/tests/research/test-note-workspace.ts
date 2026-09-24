import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReportNoteWorkspace, NoteWorkspace } from "../../server/research/notes/workspace.js";

const workspace = new NoteWorkspace([
	note("N1", "S1", "Architecture", "Autoregressive design.", "Delay pattern", "Parallel RVQ heads."),
	note("N2", "S1", "Multilingual", "Chinese and English support.", "Language coverage", "Supports Chinese and English."),
	note("N3", "S2", "Evaluation", "Benchmark results.", "Seed-TTS", "Reports bilingual benchmark scores."),
]);

type SummaryPage = {
	total_notes: number; total_sources: number; next_offset: number | null; detail: boolean;
	next_step?: string;
	sources: Array<{ source_ref: string; sections: Array<{ title: string; summary?: string; cue_count: number }> }>;
};

const summary = workspace.query({ operation: "summary", limit: 1 }) as SummaryPage;
assert.equal(summary.total_notes, 3);
assert.equal(summary.total_sources, 2);
assert.equal(summary.next_offset, 1);
assert.deepEqual(summary.sources[0]?.sections.map((section) => section.title), ["Architecture", "Multilingual"]);

// 默认花名册：只给 Section 标题，不展开摘要正文。全景要装得进一两页，读者才可能拿它做决定，
// 而不是读完几十页之后退回去让检索排序替自己选。
assert.equal(summary.detail, false);
assert.equal(summary.sources[0]?.sections[0]?.summary, undefined,
	"the roster must not carry Section summary bodies");
assert.equal(summary.sources[0]?.sections[0]?.title, "Architecture",
	"both levels expose Sections in the same shape, so one parser handles either");
assert.ok(summary.next_step?.includes("source="), "the roster must point at the drill-down step");

// 指定 Source 即进入详情级，并且只回这些 Source。
const detail = workspace.query({ operation: "summary", source: ["S2"] }) as SummaryPage;
assert.equal(detail.detail, true);
assert.equal(detail.total_sources, 1);
assert.deepEqual(detail.sources.map((source) => source.source_ref), ["S2"]);
assert.equal(detail.sources[0]?.sections[0]?.summary, "Benchmark results.");
assert.equal(detail.next_step, undefined);
assert.equal(
	(workspace.query({ operation: "summary", detail: true, limit: 1 }) as SummaryPage).sources[0]?.sections[0]?.summary,
	"Autoregressive design.",
	"detail:true expands summaries without narrowing the set",
);

// 多选：一次要来一批候选，而不是一个一个问。
const pair = workspace.query({ operation: "summary", source: ["S1", "S2"] }) as SummaryPage;
assert.deepEqual(pair.sources.map((source) => source.source_ref), ["S1", "S2"]);
assert.deepEqual(
	(workspace.query({ operation: "catalog", source: ["S1", "S2"] }) as { catalog: string }).catalog.split("\n").length,
	3,
	"catalog accepts the same multi-Source filter",
);
assert.deepEqual(
	(workspace.query({ operation: "search", query: "Chinese", source: ["S2"] }) as { notes: Array<{ ref: string }> })
		.notes.map((note) => note.ref),
	[],
	"search stays inside the chosen Sources",
);
assert.throws(() => workspace.query({ operation: "summary", source: ["S9"] }), /Unknown Source handles: S9/u);

// 引用 URL 的确定性映射：ref -> 该 Source 的第一个 source_url；未知 ref 返回 undefined。
assert.equal(workspace.citationUrl("N1"), "https://example.test/S1");
assert.equal(workspace.citationUrl("N999"), undefined);
assert.equal(workspace.citation("N1")?.cue, "Delay pattern");
assert.equal(workspace.citation("N999"), undefined);

const catalog = workspace.query({ operation: "catalog", source: "S1" }) as { catalog: string };
assert.match(catalog.catalog, /^N1\|S1\|Architecture\|Delay pattern/mu);
assert.doesNotMatch(catalog.catalog, /Parallel RVQ heads/u);

const search = workspace.query({ operation: "search", query: "Chinese English" }) as {
	notes: Array<{ ref: string }>;
};
assert.deepEqual(search.notes.map((note) => note.ref), ["N2"]);

const selected = workspace.query({ operation: "get", refs: ["N2"] }) as {
	notes: Array<{ note: string; source_urls: string[] }>;
};
assert.equal(selected.notes[0]?.note, "Supports Chinese and English.");
assert.deepEqual(selected.notes[0]?.source_urls, ["https://example.test/S1"]);
assert.deepEqual([...workspace.inspectedRefs], ["N2"]);
assert.throws(() => workspace.query({ operation: "get", refs: ["N9"] }), /Unknown Note refs/u);
assert.throws(() => workspace.query({ operation: "get", refs: [] }), /get requires refs/u);

// The query path accepts more than five short Notes while enforcing the request limit.
const small = new NoteWorkspace(Array.from({ length: 12 }, (_, index) =>
	note(`N${index + 1}`, "S1", "Section", "Summary", "Cue", "Short body.")));
const smallRefs = Array.from({ length: 12 }, (_, index) => `N${index + 1}`);
const smallResult = small.query({ operation: "get", refs: smallRefs });
assert.deepEqual((smallResult as { notes: Array<{ ref: string }> }).notes.map(item => item.ref), smallRefs);
const oversizedRequest = { operation: "get" as const, refs: Array.from({ length: 257 }, () => "N1") };
assert.throws(() => small.query(oversizedRequest), /at most 256/u);
assert.throws(() => small.query({ operation: "get", refs: [...smallRefs, "N999"] }), /Unknown Note refs/u);

// Pages are filled to a character budget, so a Source too fat to share a page still ships on its own
// and paging always advances. Before this, a fixed record count could build a page nobody could read.
const wide = new NoteWorkspace(Array.from({ length: 12 }, (_, index) =>
	note(`N${index + 1}`, `S${index + 1}`, "Architecture", "x".repeat(3000), "Cue", "Body.")));

function pageThrough(query: Record<string, unknown>): { visited: string[]; pages: number } {
	const visited: string[] = [];
	let cursor: number | null = 0;
	let pages = 0;
	while (cursor !== null) {
		const page = wide.query({ ...query, operation: "summary", offset: cursor } as never) as {
			next_offset: number | null;
			sources: Array<{ source_ref: string }>;
		};
		assert.ok(page.sources.length > 0, "a summary page must carry at least one Source");
		assert.ok(JSON.stringify(page, null, 2).length <= 12_000 || page.sources.length === 1,
			"only a lone oversized Source may exceed the budget");
		visited.push(...page.sources.map((source) => source.source_ref));
		cursor = page.next_offset;
		assert.ok((pages += 1) <= 12, "summary paging must terminate");
	}
	assert.equal(visited.length, 12);
	assert.equal(new Set(visited).size, 12);
	return { visited, pages };
}

// 详情级仍然按预算分页：摘要正文才是把页面撑爆的东西。
assert.ok(pageThrough({ detail: true }).pages > 1, "12 fat Sources must not collapse into one detail page");
// 花名册级不受摘要长度影响——这正是它存在的理由：全景要一眼看得完。
assert.equal(pageThrough({}).pages, 1, "the roster stays compact no matter how fat the summaries are");

// get returns what fits and names the rest, instead of failing the whole call.
const fat = new NoteWorkspace(Array.from({ length: 20 }, (_, index) =>
	note(`N${index + 1}`, "S1", "Architecture", "s".repeat(2000), "Cue", "b".repeat(2000))));
const partial = fat.query({ operation: "get", refs: ["N1", "N2", "N3", "N4", "N5"] }) as {
	notes: Array<{ ref: string }>;
	omitted_refs?: string[];
};
assert.ok(partial.notes.length >= 1 && partial.notes.length < 5);
assert.deepEqual(partial.omitted_refs, ["N1", "N2", "N3", "N4", "N5"].slice(partial.notes.length));
// An omitted ref was never shown, so it must not count as inspected for citation gating.
assert.deepEqual([...fat.inspectedRefs], partial.notes.map((item) => item.ref));

// Re-request only omissions, preserving order and making progress without silently marking them read.
const allRefs = Array.from({ length: 20 }, (_, index) => `N${index + 1}`);
const seen: string[] = [];
let remaining = allRefs;
while (remaining.length) {
	const page = fat.query({ operation: "get", refs: remaining }) as {
		notes: Array<{ ref: string }>; omitted_refs?: string[];
	};
	assert.ok(page.notes.length > 0);
	assert.ok(JSON.stringify(page, null, 2).length <= 12_000);
	const returned = page.notes.map(item => item.ref);
	assert.deepEqual(returned, remaining.slice(0, returned.length));
	assert.deepEqual(page.omitted_refs ?? [], remaining.slice(returned.length));
	seen.push(...returned);
	assert.deepEqual([...fat.inspectedRefs], seen);
	remaining = page.omitted_refs ?? [];
}
assert.deepEqual(seen, allRefs);

// Retain the existing oversized-single-Note escape hatch: it must not be omitted forever.
const huge = new NoteWorkspace([
	note("N1", "S1", "Section", "Summary", "Cue", "x".repeat(13_000)),
	note("N2", "S1", "Section", "Summary", "Cue", "Short body."),
]);
const hugePage = huge.query({ operation: "get", refs: ["N1", "N2"] }) as {
	notes: Array<{ ref: string; note: string }>; omitted_refs: string[];
};
assert.equal(hugePage.notes.length, 1);
assert.equal(hugePage.notes[0]?.note.length, 13_000);
assert.deepEqual(hugePage.omitted_refs, ["N2"]);
assert.deepEqual([...huge.inspectedRefs], ["N1"]);

const root = mkdtempSync(join(tmpdir(), "report-note-workspace-"));
try {
	mkdirSync(join(root, "notes"));
	writeFileSync(join(root, "notes", "0001.json"), `${JSON.stringify({
		schema_version: 1,
		source_id: "source:one",
		sections: [{ section_title: "Architecture", summary: "Architecture summary.", cue_notes: [{
			cue: "Delay + RVQ",
			note: "Parallel RVQ heads.",
			evidence: [{ source_path: "README.md", start_line: 1, end_line: 2, content_sha256: "b".repeat(64) }],
		}] }],
	}, null, 2)}\n`);
	writeFileSync(join(root, "index.json"), `${JSON.stringify({
		schema_version: 1,
		notes: [{ handle: "@1", source_id: "source:one", title: "Source One",
			metadata_path: "notes/0001.json", source_urls: ["https://example.test/one"] }],
	}, null, 2)}\n`);
	const reportWorkspace = loadReportNoteWorkspace(root);
	assert.equal(reportWorkspace.size, 1);
	const reportNote = (reportWorkspace.query({ operation: "get", refs: ["N1"] }) as {
		notes: Array<{ source_ref: string; section_summary: string }>;
	}).notes[0];
	assert.equal(reportNote?.source_ref, "@1");
	assert.equal(reportNote?.section_summary, "Architecture summary.");
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("bounded Note Workspace tests passed");

function note(ref: string, sourceRef: string, section: string, summary: string, cue: string, value: string) {
	return {
		ref,
		source_ref: sourceRef,
		source_id: `source:${sourceRef}`,
		source_title: `Source ${sourceRef}`,
		source_urls: [`https://example.test/${sourceRef}`],
		section_title: section,
		section_summary: summary,
		cue,
		note: value,
		evidence: [{ source_path: "document.md", start_line: 1, end_line: 1, content_sha256: "a".repeat(64) }],
	};
}
