import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";

import { inspectSourceDirectory, type SourceFileRecord } from "./source-bundle.js";

const CONTROL_FILES = new Set(["parser-manifest.json", "provider-record.json", "record.json", "source-manifest.json"]);
const PDF_SIGNATURE = Buffer.from("%PDF-");

export interface AgentSourceManifestInput {
	id: string;
	title: string;
	url: string;
	providerId: string;
	organizationKind: "cross_provider" | "ungrouped";
	updateContext?: {
		newMemberPaths: string[];
		changedMemberPaths: string[];
	};
	members: Array<{
		sourceId: string;
		providerId: string;
		title: string;
		canonicalLocator: string;
		path?: string;
	}>;
}

export interface AgentSourceView {
	directoryPath: string;
	contentFiles: SourceFileRecord[];
	assetFiles: SourceFileRecord[];
}

/** Select only Agent-readable text and conversion-declared display assets. */
export function inspectAgentSourceView(sourceDirectory: string): Omit<AgentSourceView, "directoryPath"> {
	const sourceFiles = inspectSourceDirectory(sourceDirectory);
	const byPath = new Map(sourceFiles.map((file) => [file.relativePath, file]));
	const assetPaths = declaredAssetPaths(sourceFiles, byPath);
	const textFiles = sourceFiles.filter((file) => !assetPaths.has(file.relativePath) && isAgentReadableText(file));
	const substantiveText = textFiles.filter((file) => !CONTROL_FILES.has(basename(file.relativePath)));
	const contentFiles = substantiveText.length > 0
		? substantiveText
		: textFiles.filter((file) => basename(file.relativePath) !== "parser-manifest.json");
	if (contentFiles.length === 0) {
		throw new Error("Agent Source has no readable text; the upstream document conversion is missing");
	}
	return {
		contentFiles,
		assetFiles: [...assetPaths].map((path) => byPath.get(path)!),
	};
}

/** Materialize an immutable Source as the bounded view exposed to an Agent. */
export function materializeAgentSourceView(
	sourceDirectory: string,
	outputDirectory: string,
	manifest?: AgentSourceManifestInput,
): AgentSourceView {
	const selected = inspectAgentSourceView(sourceDirectory);
	const files = [...selected.contentFiles, ...selected.assetFiles]
		.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	rmSync(outputDirectory, { recursive: true, force: true });
	mkdirSync(outputDirectory, { recursive: true });
	for (const file of files) {
		const target = join(outputDirectory, file.relativePath);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(file.absolutePath, target);
	}
	if (manifest) writeFileSync(join(outputDirectory, "source-manifest.json"), `${JSON.stringify({
		schema_version: 1,
		source: {
			source_id: manifest.id,
			title: manifest.title,
			canonical_locator: manifest.url,
			provider_id: manifest.providerId,
			organization_kind: manifest.organizationKind,
			members: manifest.members.map((member) => ({
				source_id: member.sourceId,
				provider_id: member.providerId,
				title: member.title,
				canonical_locator: member.canonicalLocator,
				...(member.path ? { path: member.path } : {}),
			})),
			...(manifest.updateContext ? { source_update: {
				new_member_paths: manifest.updateContext.newMemberPaths,
				changed_member_paths: manifest.updateContext.changedMemberPaths,
			} } : {}),
		},
		content_files: selected.contentFiles.map((file) => ({
			path: file.relativePath,
			byte_length: file.byteLength,
			line_count: readFileSync(file.absolutePath, "utf-8").replace(/\r\n?/gu, "\n").split("\n").length,
			sha256: file.sha256,
		})),
		display_assets: selected.assetFiles.map((file) => ({
			path: file.relativePath,
			byte_length: file.byteLength,
			sha256: file.sha256,
		})),
	}, null, 2)}\n`);
	const projected = new Map(inspectSourceDirectory(outputDirectory).map((file) => [file.relativePath, file]));
	return {
		directoryPath: outputDirectory,
		contentFiles: selected.contentFiles.map((file) => projected.get(file.relativePath)!),
		assetFiles: selected.assetFiles.map((file) => projected.get(file.relativePath)!),
	};
}

function declaredAssetPaths(
	files: readonly SourceFileRecord[],
	byPath: ReadonlyMap<string, SourceFileRecord>,
): Set<string> {
	const paths = new Set<string>();
	for (const manifestFile of files.filter((file) => basename(file.relativePath) === "parser-manifest.json")) {
		const value = JSON.parse(readFileSync(manifestFile.absolutePath, "utf-8")) as { assets?: unknown };
		if (value.assets === undefined) continue;
		if (!Array.isArray(value.assets)) throw new Error(`Parser manifest '${manifestFile.relativePath}' assets must be an array`);
		for (const [index, raw] of value.assets.entries()) {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				throw new Error(`Parser manifest '${manifestFile.relativePath}' asset ${index} is invalid`);
			}
			const asset = raw as Record<string, unknown>;
			if (typeof asset.markdown_path !== "string" || !asset.markdown_path
				|| asset.media_type !== "image/png"
				|| typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256)
				|| !Number.isInteger(asset.byte_length) || (asset.byte_length as number) < 1) {
				throw new Error(`Parser manifest '${manifestFile.relativePath}' asset ${index} is invalid`);
			}
			const path = resolveAssetPath(manifestFile.relativePath, asset.markdown_path);
			const file = byPath.get(path);
			if (!file) throw new Error(`Parser manifest '${manifestFile.relativePath}' asset '${path}' is missing`);
			if (file.sha256 !== asset.sha256 || file.byteLength !== asset.byte_length) {
				throw new Error(`Parser manifest '${manifestFile.relativePath}' asset '${path}' does not match its hash`);
			}
			paths.add(path);
		}
	}
	return paths;
}

function resolveAssetPath(manifestPath: string, markdownPath: string): string {
	if (markdownPath.includes("\0") || markdownPath.includes("\\") || posix.isAbsolute(markdownPath)
		|| /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(markdownPath)) {
		throw new Error(`Parser manifest '${manifestPath}' has an unsafe asset path '${markdownPath}'`);
	}
	const path = posix.normalize(posix.join(posix.dirname(manifestPath), markdownPath));
	if (path === ".." || path.startsWith("../")) {
		throw new Error(`Parser manifest '${manifestPath}' asset escapes its Source`);
	}
	return path;
}

/**
 * Binary material never decodes as strict UTF-8, so that is the test. PDF converters do leave the
 * odd NUL or control byte inside otherwise valid Markdown (docling emits one per dropped figure);
 * only a file that is mostly control bytes is treated as not text.
 */
const MAX_CONTROL_BYTE_RATIO = 0.01;

function isAgentReadableText(file: SourceFileRecord): boolean {
	return isReadableTextContent(readFileSync(file.absolutePath));
}

/** The one text-versus-binary rule for Source material; Cornell Note evidence citations use it too. */
export function isReadableTextContent(content: Buffer): boolean {
	if (content.subarray(0, PDF_SIGNATURE.byteLength).equals(PDF_SIGNATURE)) return false;
	let control = 0;
	for (const byte of content) {
		if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) control += 1;
	}
	if (control > 0 && control / content.byteLength > MAX_CONTROL_BYTE_RATIO) return false;
	try {
		return Boolean(new TextDecoder("utf-8", { fatal: true }).decode(content).trim());
	} catch {
		return false;
	}
}
