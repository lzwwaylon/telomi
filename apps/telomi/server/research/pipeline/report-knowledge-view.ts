import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { sha256 } from "../../lib/hash.js";
import type { CornellNoteRecord, CornellNotesSnapshot } from "../../cornell/contracts.js";
import { createAgentEvidenceHandles, requireAgentEvidenceHandle } from "./evidence-handles.js";
import type {
	PublishedArtifactDirectoryRef,
	PublishedArtifactRef,
	RunArtifactStore,
} from "../../agent-runtime/artifact-store.js";
import { validateSourceBundleDirectory } from "./source-bundle.js";
import { listFilesRecursive } from "../../lib/fs.js";

interface KnowledgeSource {
	sourceId: string;
	providerId: string;
	title: string;
	url: string;
	bundleRef: string;
	originalRef: string;
	files: Array<{ relativePath: string; absolutePath: string; sha256: string; byteLength: number }>;
}

export interface ReportKnowledgeManifest {
	schema_version: 1;
	input: { wiki_sha256: string; cornell_notes_sha256: string; base_sha256?: string };
	counts: { wiki_files: number; evidence_notes: number; sources: number };
	evidence_aliases: Record<string, string>;
	wiki_refs: { evidence: number; sources: number; raw_sources: number; dangling: string[] };
	cornell_notes_refs: { sources: number; dangling: string[] };
	files: string[];
}

export function materializeFindOutReportView(input: {
	targetStore: RunArtifactStore;
	evidence: CornellNotesSnapshot;
	cornellNotesArtifact: PublishedArtifactRef;
	targetRelativePath: string;
}): PublishedArtifactDirectoryRef {
	if (existsSync(join(input.targetStore.root, input.targetRelativePath))) {
		const existing = input.targetStore.describeDirectory(input.targetRelativePath);
		const index = JSON.parse(readFileSync(join(existing.absolutePath, "index.json"), "utf-8")) as {
			cornell_notes_sha256?: unknown;
		};
		if (index.cornell_notes_sha256 !== input.cornellNotesArtifact.sha256) {
			throw new Error("Existing Find Out snapshot has different immutable Evidence");
		}
		return existing;
	}
	const handles = createAgentEvidenceHandles([input.evidence]);
	const temporary = mkdtempSync(join(tmpdir(), "telomi-find-out-report-"));
	try {
		const notes = input.evidence.notes.filter((record) => record.note.sections.length > 0).map((record, index) => {
			const members = record.members.map((member) => ({ title: member.title, url: member.canonical_locator }));
			const handle = requireAgentEvidenceHandle(handles, record.note.source_id);
			const stem = `${String(index + 1).padStart(4, "0")}-${handle.slice(1)}`;
			mkdirSync(join(temporary, "notes"), { recursive: true });
			writeFileSync(join(temporary, "notes", `${stem}.json`), `${JSON.stringify(record.note, null, 2)}\n`);
			return {
				handle,
				source_id: record.note.source_id,
				title: record.title,
				metadata_path: `notes/${stem}.json`,
				source_urls: members.length ? members.map((member) => member.url) : [record.canonical_locator],
			};
		});
		writeFileSync(join(temporary, "index.json"), `${JSON.stringify({
				schema_version: 1,
				cornell_notes_sha256: input.cornellNotesArtifact.sha256,
				notes,
		}, null, 2)}\n`);
		return input.targetStore.publishDirectory(temporary, input.targetRelativePath);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export function materializeReportKnowledgeView(input: {
	targetStore: RunArtifactStore;
	sourceStore: RunArtifactStore;
	wiki: PublishedArtifactDirectoryRef;
	evidence: CornellNotesSnapshot;
	cornellNotesArtifact: PublishedArtifactRef;
	targetRelativePath: string;
	baseView?: PublishedArtifactDirectoryRef;
}): PublishedArtifactDirectoryRef {
	if (existsSync(join(input.targetStore.root, input.targetRelativePath))) {
		const existing = input.targetStore.describeDirectory(input.targetRelativePath);
		const manifest = JSON.parse(readFileSync(join(existing.absolutePath, "manifest.json"), "utf-8")) as ReportKnowledgeManifest;
		if (manifest.input.wiki_sha256 !== input.wiki.sha256
			|| manifest.input.cornell_notes_sha256 !== input.cornellNotesArtifact.sha256
			|| manifest.input.base_sha256 !== input.baseView?.sha256) {
			throw new Error("Existing layered knowledge snapshot has different immutable inputs");
		}
		return existing;
	}
	const notesByEvidence = new Map(input.evidence.notes.map((record) => [record.note.source_id, record] as const));
	const evidenceTargets = loadProjectedEvidenceTargets(input.baseView);
	for (const evidenceId of notesByEvidence.keys()) {
		setEvidenceTarget(evidenceTargets, evidenceId, evidenceId);
		setEvidenceTarget(evidenceTargets, `evidence:${idSegment(evidenceId, "source")}`, evidenceId);
	}
	const sources = loadSources(input.sourceStore, input.evidence.source_bundle_refs);
	const sourceById = new Map(loadProjectedSources(input.baseView).map((source) => [source.sourceId, source]));
	for (const source of sources) sourceById.set(source.sourceId, source);
	const allSources = [...sourceById.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
	const temporary = mkdtempSync(join(tmpdir(), "telomi-report-knowledge-"));
	try {
		copyBaseProjection(input.baseView, temporary);
		for (const file of input.wiki.files) {
			const target = join(temporary, "wiki", file.relativePath);
			mkdirSync(dirname(target), { recursive: true });
			if (!file.relativePath.endsWith(".md")) {
				copyFileSync(join(input.wiki.absolutePath, file.relativePath), target);
				continue;
			}
			const original = readFileSync(join(input.wiki.absolutePath, file.relativePath), "utf-8");
			writeFileSync(target, projectWikiMarkdown(original, file.relativePath, evidenceTargets, sourceById, allSources));
		}

		const evidenceDangling: string[] = [];
		for (const [evidenceId, record] of notesByEvidence) {
			const source = sourceById.get(record.note.source_id);
			if (!source) {
				evidenceDangling.push(`${evidenceId}->${record.note.source_id}`);
				continue;
			}
			for (const anchor of record.note.sections.flatMap((section) =>
				section.cue_notes.flatMap((item) => item.evidence))) {
				const sourceFile = source.files.find((file) => file.relativePath === anchor.source_path);
				if (!sourceFile || sourceRangeSha256(sourceFile.absolutePath, anchor.start_line, anchor.end_line) !== anchor.content_sha256) {
					throw new Error(`Cornell Note '${evidenceId}' has unresolved Source evidence '${anchor.source_path}'`);
				}
			}
			const root = join(temporary, "evidence", idSegment(evidenceId, "source"));
			rmSync(root, { recursive: true, force: true });
			mkdirSync(root, { recursive: true });
			writeFileSync(join(root, "note.json"), `${JSON.stringify(record.note, null, 2)}\n`);
			writeFileSync(join(root, "note.md"), renderNote(record, source));
		}
		if (evidenceDangling.length > 0) throw new Error(`Layered knowledge has dangling Evidence Source refs: ${evidenceDangling.join(", ")}`);

		for (const source of sources.filter((item) => notesByEvidence.has(item.sourceId))) {
			const root = join(temporary, "sources", idSegment(source.sourceId, "source"));
			rmSync(root, { recursive: true, force: true });
			mkdirSync(root, { recursive: true });
			for (const file of source.files) {
				const target = join(root, file.relativePath);
				mkdirSync(dirname(target), { recursive: true });
				copyFileSync(file.absolutePath, target);
			}
			writeFileSync(join(root, "source.json"), `${JSON.stringify({
				schema_version: 1,
				source_id: source.sourceId,
				provider_id: source.providerId,
				title: source.title,
				canonical_locator: source.url,
				source_bundle_ref: source.bundleRef,
				original_ref: source.originalRef,
				files: source.files.map((file) => ({
					path: file.relativePath, sha256: file.sha256, byte_length: file.byteLength,
				})),
			}, null, 2)}\n`);
		}

		const manifest = validateProjectedView({
			root: temporary,
			wikiFiles: input.wiki.files.map((file) => file.relativePath),
			evidenceTargets,
			sourceById,
			wikiSha256: input.wiki.sha256,
			cornellNotesSha256: input.cornellNotesArtifact.sha256,
			baseSha256: input.baseView?.sha256,
		});
		writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		writeFileSync(join(temporary, "index.md"), renderIndex(manifest));
		return input.targetStore.publishDirectory(temporary, input.targetRelativePath);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function copyBaseProjection(base: PublishedArtifactDirectoryRef | undefined, target: string): void {
	if (!base) return;
	for (const directory of ["evidence", "sources"]) {
		const source = join(base.absolutePath, directory);
		if (existsSync(source)) cpSync(source, join(target, directory), { recursive: true });
	}
}

function loadProjectedEvidenceTargets(base: PublishedArtifactDirectoryRef | undefined): Map<string, string> {
	const targets = new Map<string, string>();
	if (!base) return targets;
	const manifest = JSON.parse(readFileSync(join(base.absolutePath, "manifest.json"), "utf-8")) as Partial<ReportKnowledgeManifest>;
	for (const [alias, canonical] of Object.entries(manifest.evidence_aliases ?? {})) {
		if (typeof canonical === "string") setEvidenceTarget(targets, alias, canonical);
	}
	return targets;
}

function setEvidenceTarget(targets: Map<string, string>, alias: string, canonical: string): void {
	const previous = targets.get(alias);
	if (previous && previous !== canonical) throw new Error(`Evidence alias '${alias}' has conflicting targets`);
	targets.set(alias, canonical);
}

function loadProjectedSources(base: PublishedArtifactDirectoryRef | undefined): KnowledgeSource[] {
	if (!base) return [];
	const root = join(base.absolutePath, "sources");
	if (!existsSync(root)) return [];
	const files = new Map(base.files.map((file) => [file.relativePath, file]));
	return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
		const raw = JSON.parse(readFileSync(join(root, entry.name, "source.json"), "utf-8")) as {
			source_id?: unknown; provider_id?: unknown; title?: unknown; canonical_locator?: unknown;
			source_bundle_ref?: unknown; original_ref?: unknown;
			files?: Array<{ path?: unknown; sha256?: unknown; byte_length?: unknown }>;
		};
		if (typeof raw.source_id !== "string" || typeof raw.provider_id !== "string"
			|| typeof raw.title !== "string" || typeof raw.canonical_locator !== "string"
			|| typeof raw.source_bundle_ref !== "string" || typeof raw.original_ref !== "string") {
			throw new Error(`Projected Source '${entry.name}' has invalid metadata`);
		}
		return {
			sourceId: raw.source_id,
			providerId: raw.provider_id,
			title: raw.title,
			url: raw.canonical_locator,
			bundleRef: raw.source_bundle_ref,
			originalRef: raw.original_ref,
			files: (raw.files ?? []).flatMap((file) => {
				if (typeof file.path !== "string" || typeof file.sha256 !== "string" || typeof file.byte_length !== "number") return [];
				const projected = files.get(`sources/${entry.name}/${file.path}`);
				return projected ? [{ relativePath: file.path, absolutePath: join(root, entry.name, file.path),
					sha256: projected.sha256, byteLength: projected.byteLength }] : [];
			}),
		};
	}).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function loadSources(store: RunArtifactStore, refs: readonly string[]): KnowledgeSource[] {
	const values = new Map<string, KnowledgeSource>();
	for (const bundleRef of refs) {
		const artifact = store.describeDirectory(bundleRef);
		const raw = JSON.parse(readFileSync(join(artifact.absolutePath, "source-index.json"), "utf-8")) as { provider_id?: unknown };
		if (typeof raw.provider_id !== "string" || !raw.provider_id) throw new Error(`Source Bundle '${bundleRef}' has no provider_id`);
		const bundle = validateSourceBundleDirectory(artifact.absolutePath, { provider_id: raw.provider_id });
		for (const source of bundle.sources) {
			const value: KnowledgeSource = {
				sourceId: source.source_id,
				providerId: raw.provider_id,
				title: source.title,
				url: source.url,
				bundleRef,
				originalRef: `${bundleRef}/${source.path}`,
				files: source.files,
			};
			const previous = values.get(value.sourceId);
			if (previous && JSON.stringify(previous.files.map((file) => file.sha256)) !== JSON.stringify(value.files.map((file) => file.sha256))) {
				throw new Error(`Source '${value.sourceId}' has conflicting immutable revisions`);
			}
			values.set(value.sourceId, previous ?? value);
		}
	}
	return [...values.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function projectWikiMarkdown(
	markdown: string,
	wikiPath: string,
	evidenceTargets: ReadonlyMap<string, string>,
	sources: ReadonlyMap<string, KnowledgeSource>,
	allSources: readonly KnowledgeSource[],
): string {
	const from = posix.dirname(`wiki/${wikiPath}`);
	const link = (target: string) => relativeMarkdownPath(from, target);
	const rawByRef = [...allSources]
		.sort((left, right) => right.originalRef.length - left.originalRef.length);
	return markdown.replace(/`?(evidence|source):([A-Za-z0-9_-]+)`?|`?(artifacts\/source-bundles\/[A-Za-z0-9._/-]+)`?/gu,
		(match, kind: string | undefined, id: string | undefined, rawRef: string | undefined) => {
			if (rawRef) {
				const source = rawByRef.find((item) => rawRef === item.originalRef || rawRef === `${item.originalRef}/document.md`);
				return source ? `[raw source](${link(sourceProjectionPath(source))})` : match;
			}
			const full = `${kind}:${id}`;
			if (kind === "evidence" && evidenceTargets.has(full)) {
				const canonical = evidenceTargets.get(full)!;
				return `[${full}](${link(`evidence/${idSegment(canonical, "source")}/note.md`)})`;
			}
			if (kind === "source" && sources.has(full)) {
				return `[${full}](${link(sourceProjectionPath(sources.get(full)!))})`;
			}
			return match;
		});
}

function renderNote(
	record: CornellNoteRecord,
	source: KnowledgeSource,
): string {
	const sourcePath = `../../${sourceProjectionPath(source)}`;
	const anchors = record.note.sections.flatMap((section) => section.cue_notes.flatMap((note) =>
		note.evidence.map((evidence) => ({ cue: note.cue, ...evidence }))));
	return `# ${record.title}

- Source ID: \`${record.note.source_id}\`
- Source: [${source.sourceId}](${sourcePath})
- Canonical locator: <${record.canonical_locator}>
- Immutable metadata: [note.json](note.json)

## Cornell Note

${record.note.sections.map((section) => [
	`### ${section.section_title}`,
	section.summary,
	...section.cue_notes.map((note) => `- ${note.cue}: ${note.note}`),
].join("\n")).join("\n\n")}

## Source anchors

${anchors.length > 0 ? anchors.map((anchor) =>
		`- ${anchor.cue}: [${anchor.source_path} lines ${anchor.start_line}-${anchor.end_line}](../../sources/${idSegment(source.sourceId, "source")}/${anchor.source_path}#L${anchor.start_line}-L${anchor.end_line}) - SHA-256 \`${anchor.content_sha256}\``).join("\n") : "No Source evidence is available."}
`;
}

function sourceRangeSha256(path: string, startLine: number, endLine: number): string {
	const lines = readFileSync(path, "utf-8").replace(/\r\n?/gu, "\n").split("\n");
	return sha256(`${lines.slice(startLine - 1, endLine).join("\n")}\n`);
}

function sourceProjectionPath(source: KnowledgeSource): string {
	const preferred = ["README.md", "readme.md", "index.md", "document.md"]
		.map((path) => source.files.find((file) => file.relativePath === path))
		.find(Boolean);
	return `sources/${idSegment(source.sourceId, "source")}/${preferred?.relativePath ?? source.files[0]?.relativePath ?? "source.json"}`;
}

function validateProjectedView(input: {
	root: string;
	wikiFiles: readonly string[];
	evidenceTargets: ReadonlyMap<string, string>;
	sourceById: ReadonlyMap<string, KnowledgeSource>;
	wikiSha256: string;
	cornellNotesSha256: string;
	baseSha256?: string;
}): ReportKnowledgeManifest {
	let evidenceRefs = 0;
	let sourceRefs = 0;
	let rawRefs = 0;
	const dangling: string[] = [];
	for (const file of input.wikiFiles.filter((path) => path.endsWith(".md"))) {
		const content = readFileSync(join(input.root, "wiki", file), "utf-8");
		for (const match of content.matchAll(/\[(evidence|source):([A-Za-z0-9_-]+)\]\(([^)]+)\)/gu)) {
			if (match[1] === "evidence") evidenceRefs += 1;
			else sourceRefs += 1;
			if (!resolvesInside(input.root, `wiki/${file}`, match[3]!)) dangling.push(`${file}:${match[0]}`);
		}
		for (const match of content.matchAll(/\[raw source\]\(([^)]+)\)/gu)) {
			rawRefs += 1;
			if (!resolvesInside(input.root, `wiki/${file}`, match[1]!)) dangling.push(`${file}:${match[0]}`);
		}
		for (const match of content.matchAll(/artifacts\/source-bundles\/[A-Za-z0-9._/-]+/gu)) {
			dangling.push(`${file}:${match[0]}`);
		}
		for (const match of content.matchAll(/`?(evidence|source):([A-Za-z0-9_-]+)`?/gu)) {
			const full = `${match[1]}:${match[2]}`;
			if ((match[1] === "evidence" && !input.evidenceTargets.has(full))
				|| (match[1] === "source" && !input.sourceById.has(full))) dangling.push(`${file}:${full}`);
		}
	}
	if (dangling.length > 0) throw new Error(`Layered knowledge has dangling Wiki refs: ${[...new Set(dangling)].join(", ")}`);
	const files = [...listFilesRecursive(input.root), "index.md", "manifest.json"].sort();
	return {
		schema_version: 1,
		input: { wiki_sha256: input.wikiSha256, cornell_notes_sha256: input.cornellNotesSha256,
			...(input.baseSha256 ? { base_sha256: input.baseSha256 } : {}) },
		counts: {
			wiki_files: input.wikiFiles.length,
			evidence_notes: countDirectories(join(input.root, "evidence")),
			sources: countDirectories(join(input.root, "sources")),
		},
		evidence_aliases: Object.fromEntries([...input.evidenceTargets]
			.filter(([alias, canonical]) => alias !== canonical)
			.sort(([left], [right]) => left.localeCompare(right))),
		wiki_refs: { evidence: evidenceRefs, sources: sourceRefs, raw_sources: rawRefs, dangling: [] },
		cornell_notes_refs: { sources: countDirectories(join(input.root, "evidence")), dangling: [] },
		files,
	};
}

function countDirectories(root: string): number {
	return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length : 0;
}

function resolvesInside(root: string, from: string, target: string): boolean {
	if (target.startsWith("/") || target.includes("\\")) return false;
	const resolved = posix.normalize(posix.join(posix.dirname(from), target.split("#", 1)[0]!));
	return resolved !== ".." && !resolved.startsWith("../") && readFileSafe(join(root, resolved));
}

function readFileSafe(path: string): boolean {
	try { readFileSync(path); return true; } catch { return false; }
}

function renderIndex(manifest: ReportKnowledgeManifest): string {
	return `# Layered report knowledge

Use the dedicated Wiki Tools to discover and read Wiki pages. Follow links into Evidence Notes when a claim needs verification, then follow Source links and line anchors to inspect raw evidence.

- Wiki files: ${manifest.counts.wiki_files}
- Accepted Evidence Notes: ${manifest.counts.evidence_notes}
- Sources: ${manifest.counts.sources}
- Projection metadata: [manifest.json](manifest.json)
`;
}

function relativeMarkdownPath(from: string, target: string): string {
	const value = posix.relative(from, target);
	if (!value || value === ".." || value.startsWith("../") && posix.normalize(posix.join(from, value)).startsWith("../")) {
		throw new Error(`Knowledge link escapes root: ${from} -> ${target}`);
	}
	return value.startsWith(".") ? value : `./${value}`;
}

function idSegment(value: string, prefix: "evidence" | "source"): string {
	const match = new RegExp(`^${prefix}:([A-Za-z0-9_-]+)$`, "u").exec(value);
	if (!match) throw new Error(`Invalid ${prefix} ID '${value}'`);
	return match[1]!;
}
