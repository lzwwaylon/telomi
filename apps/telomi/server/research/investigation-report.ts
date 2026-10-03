import { validateCanonicalMarkdown } from "../citations/contracts.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { assertSafeRelativePath } from "../lib/paths.js";
import { isRecord } from "../lib/values.js";
import { listPublishedReports, syncPublishedReportView } from "../media/report-view.js";
import { serverRuntimeDirForGoalDir } from "../workspaces/server-runtime-paths.js";
import type { resolveNoteReadingCue } from "./note-reading.js";
import { readInvestigationResult } from "./investigate.js";
import { compileStandaloneCitationMarkdown, type KnowledgeCitationRegistry } from "./pipeline/citation-compiler.js";
import type { ResolvedWikiReportCitation } from "./pipeline/wiki-report-references.js";
import type { resolveSavedNoteCue } from "./note-retrieval.js";

type FrozenCue = NonNullable<ReturnType<typeof resolveNoteReadingCue> | ReturnType<typeof resolveSavedNoteCue>>;
type FrozenCitation = { ref: string; wiki?: ResolvedWikiReportCitation; cue?: FrozenCue };

/** Publish the reviewed Writer answer using its frozen evidence, without another model call. */
export function publishInvestigationReport(goalDir: string, investigationId: string, title: string, signal?: AbortSignal): {
	runId: string; reportTitle: string; stableFinalReportPath: string;
} {
	signal?.throwIfAborted();
	const reportTitle = title.trim();
	if (!reportTitle || reportTitle.length > 120 || /[\u0000-\u001f\u007f]/u.test(reportTitle)) {
		throw new Error("Investigation report requires a single-line title of at most 120 characters");
	}
	const result = readInvestigationResult(goalDir, investigationId);
	const runDir = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", investigationId);
	const evidenceRef = `investigations/${investigationId}/citations.json`;
	const evidencePath = existsSync(join(goalDir, "artifacts", evidenceRef))
		? new RunArtifactStore(join(goalDir, "artifacts")).describeFile(evidenceRef).absolutePath
		: new RunArtifactStore(runDir).describeFile("citations.json").absolutePath;
	const frozen: unknown = JSON.parse(readFileSync(evidencePath, "utf-8"));
	if (!isRecord(frozen) || frozen.schema_version !== 1 || !Array.isArray(frozen.citations)) {
		throw new Error("Investigation report requires frozen citations");
	}
	const remaining = new Set(result.citation_refs);
	const entries: KnowledgeCitationRegistry["entries"] = [];
	const cues = new Map<string, FrozenCue>();
	for (const value of frozen.citations) {
		if (!isRecord(value) || typeof value.ref !== "string" || !remaining.delete(value.ref)
			|| (isRecord(value.wiki) === isRecord(value.cue))) {
			throw new Error("Investigation report citation identities disagree with its answer");
		}
		const citation = value as unknown as FrozenCitation;
		if (citation.wiki) {
			const wiki = citation.wiki;
			if (wiki.ref !== citation.ref || !wiki.entry?.source || typeof wiki.entry.source.url !== "string"
				|| typeof wiki.entry.source.title !== "string" || typeof wiki.entry.source.id !== "string"
				|| typeof wiki.page?.path !== "string") throw new Error("Investigation report Wiki citation is invalid");
			entries.push({ ref: citation.ref, url: webUrl(wiki.entry.source.url), title: wiki.entry.source.title,
				provenance: wiki.entry.source.id, evidenceId: wiki.entry.source.id, fileRefs: [wiki.page.path], wiki });
		} else {
			const cue = citation.cue!;
			if (cue.ref !== citation.ref || typeof cue.cue !== "string" || typeof cue.note !== "string"
				|| !Array.isArray(cue.evidence) || !cue.evidence.length) {
				throw new Error("Investigation report Cue citation is invalid");
			}
			for (const anchor of cue.evidence) {
				if (!isRecord(anchor) || typeof anchor.source_run_id !== "string"
					|| !/^[A-Za-z0-9._-]{1,200}$/u.test(anchor.source_run_id)
					|| typeof anchor.source_id !== "string" || !/^source:[a-z0-9_-]+$/iu.test(anchor.source_id)
					|| typeof anchor.source_revision_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(anchor.source_revision_sha256)
					|| typeof anchor.content_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(anchor.content_sha256)
					|| typeof anchor.source_path !== "string" || typeof anchor.excerpt !== "string"
					|| !Number.isSafeInteger(anchor.start_line) || anchor.start_line < 1
					|| !Number.isSafeInteger(anchor.end_line) || anchor.end_line < anchor.start_line) {
					throw new Error("Investigation report Source anchor is invalid");
				}
				assertSafeRelativePath(anchor.source_path, "Investigation report Source path");
			}
			const url = "canonical_locator" in cue ? cue.canonical_locator : cue.evidence[0]!.url;
			entries.push({ ref: citation.ref, url: webUrl(url), title: cue.cue,
				provenance: citation.ref, numberKey: citation.ref, fileRefs: cue.evidence.map((anchor) => anchor.source_path) });
			cues.set(citation.ref, cue);
		}
	}
	if (remaining.size) throw new Error("Investigation report is missing frozen citation evidence");
	const body = result.answer.replace(/^\s*(#{1,6})[\t ]+([^\r\n]*)(?:\r?\n|$)/u,
		(heading, level: string, text: string) => {
			if (!heading.includes("<cite>") && (level === "#" || text.trim() === reportTitle)) return "\n";
			return level === "#" ? heading.replace(/^\s*#/u, "##") : heading;
		});
	const compiled = compileStandaloneCitationMarkdown({ markdown: `# ${reportTitle}\n\n${body}`,
		citationRegistry: { schemaVersion: 1, knowledgeSha256: result.wiki_sha256, entries } });
	validateCanonicalMarkdown(compiled.markdown);
	const runId = `investigation-${investigationId}`;
	const store = new RunArtifactStore(join(goalDir, "wiki", "runs", runId));
	const previous: unknown = existsSync(join(store.root, "report/final.json"))
		? store.readJson(store.describeFile("report/final.json")) : undefined;
	let publishedAt: string;
	if (previous !== undefined) {
		if (!isRecord(previous) || typeof previous.publishedAt !== "string" || !Number.isFinite(Date.parse(previous.publishedAt))
			|| new Date(previous.publishedAt).toISOString() !== previous.publishedAt) {
			throw new Error("Published investigation report has an invalid publication timestamp");
		}
		publishedAt = previous.publishedAt;
	} else {
		// A later report cannot take an older same-title directory even if the clock repeats a millisecond.
		const latest = Math.max(0, ...listPublishedReports(goalDir).map((report) => report.publishedAt ? Date.parse(report.publishedAt) : 0));
		publishedAt = new Date(Math.max(Date.now(), latest + 1)).toISOString();
	}
	const structured = `${JSON.stringify({ publishedAt, markdown: compiled.markdown,
		citations: compiled.citations.map((citation) => {
			const cue = citation.refs?.length === 1 ? cues.get(citation.refs[0]!) : undefined;
			return { ...citation, ...(cue ? { cue } : {}) };
		}),
		investigation: result,
	}, null, 2)}\n`;
	const artifacts = [["report/final.json", structured], ["report/final.md", compiled.markdown]] as const;
	// Check both existing products before writing either; retries never overwrite another report.
	for (const [path, content] of artifacts) {
		if (existsSync(join(store.root, path)) && readFileSync(store.describeFile(path).absolutePath, "utf-8") !== content) {
			throw new Error("Published investigation report differs from the requested title or frozen answer");
		}
	}
	signal?.throwIfAborted();
	// final.md is the existing report-card visibility marker and is always published last.
	for (const [path, content] of artifacts) if (!existsSync(join(store.root, path))) store.publishText(content, path);
	syncPublishedReportView(goalDir);
	return { runId, reportTitle, stableFinalReportPath: `/workspace/wiki/runs/${runId}/report/final.md` };
}

function webUrl(value: string | undefined): string {
	try {
		const url = new URL(value ?? "");
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
	} catch { return ""; }
}
