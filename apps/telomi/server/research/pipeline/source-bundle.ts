import { createSha256, sha256 } from "../../lib/hash.js";

import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { cloneDirectoryContents } from "../../lib/cow.js";

import {
	derivePrimeSearchSourceId,
	type ProviderExecution,
	type PrimeSearchOutput,
	validatePrimeSearchOutput,
} from "../../providers/search-contracts.js";
import { isInsideRoot } from "../../lib/paths.js";
import { writeFileAtomic } from "../../lib/fs.js";
import { comparePaths } from "../../lib/paths.js";

const MAX_SOURCE_FILES = 20_000;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const SOURCE_INDEX_NAME = "source-index.json";

export interface SourceFileRecord {
	relativePath: string;
	absolutePath: string;
	sha256: string;
	byteLength: number;
}

interface SourceIndexEntry {
	path: string;
	candidate_id: string;
	source_id: string;
	url: string;
	title: string;
	files: Array<{
		path: string;
		sha256: string;
		byte_length: number;
	}>;
}

interface SourceBundleIndex {
	schema_version: 1;
	provider_id: string;
	sources: SourceIndexEntry[];
}

export interface ValidatedSourceBundle {
	output: PrimeSearchOutput;
	bundleDirectory: string;
	bundleSha256: string;
	byteLength: number;
	sources: Array<PrimeSearchOutput["sources"][number] & {
		candidate_id: string;
		source_id: string;
		url: string;
		title: string;
		sourceDirectoryPath: string;
		files: SourceFileRecord[];
	}>;
	quality: {
		sourceUnit: "provider_record";
		exactContentDuplicateCount: number;
		genericTitleCount: number;
	};
}

/**
 * Every regular file under a material directory, within the Source limits. The Candidate Ledger
 * applies this at submission so a child Agent learns about an empty or oversized material while
 * it can still narrow it, instead of the whole batch failing at materialization.
 */
export function listSourceFiles(sourceDirectory: string): SourceFileRecord[] {
	const root = safeDirectory(sourceDirectory, "Source directory");
	const files = listSafeFiles(root);
	if (files.length === 0) throw new Error("Source directory must not be empty");
	if (files.length > MAX_SOURCE_FILES) {
		throw new Error(`Source directory exceeds ${MAX_SOURCE_FILES} files`);
	}
	const totalBytes = files.reduce((total, file) => total + file.byteLength, 0);
	if (totalBytes > MAX_SOURCE_BYTES) {
		throw new Error(`Source directory exceeds ${MAX_SOURCE_BYTES} bytes`);
	}
	return files;
}

export function inspectSourceDirectory(sourceDirectory: string): SourceFileRecord[] {
	const files = listSourceFiles(sourceDirectory);
	const reservedManifest = files.find((file) => file.relativePath === "source.json" || file.relativePath === "manifest.json");
	if (reservedManifest) {
		throw new Error(`Source directory contains Runtime-owned provenance file '${reservedManifest.relativePath}'`);
	}
	return files;
}

export function snapshotSourceDirectory(inputDirectory: string, outputDirectory: string): void {
	const records = inspectSourceDirectory(inputDirectory);
	rmSync(outputDirectory, { recursive: true, force: true });
	mkdirSync(outputDirectory, { recursive: true });
	// inspectSourceDirectory 已经拒绝了 symlink、硬链接和非普通文件，所以整棵树等价于
	// records，可以用一次 clonefile 代替逐文件拷贝。
	if (cloneDirectoryContents(inputDirectory, outputDirectory) === "clone") return;
	for (const record of records) {
		const target = join(outputDirectory, record.relativePath);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(record.absolutePath, target);
	}
}

export function writeSourceBundleIndex(
	bundleDirectory: string,
	providerId: string,
	sources: Array<{
		path: string;
		candidate_id: string;
		url: string;
		title: string;
	}>,
): void {
	const root = safeDirectory(bundleDirectory, "Source Bundle");
	const index: SourceBundleIndex = {
		schema_version: 1,
		provider_id: providerId,
		sources: sources.map((source) => {
			assertSourcePath(source.path);
			const sourceRoot = safeDirectoryInside(
				root,
				resolve(root, source.path),
				`Source directory '${source.path}'`,
			);
			return {
				...source,
				source_id: derivePrimeSearchSourceId(providerId, source.url),
				files: inspectSourceDirectory(sourceRoot).map((file) => ({
					path: file.relativePath,
					sha256: file.sha256,
					byte_length: file.byteLength,
				})),
			};
		}),
	};
	writeFileAtomic(join(root, SOURCE_INDEX_NAME), `${JSON.stringify(index, null, 2)}\n`);
}

export function validateSourceBundleDirectory(
	bundleDirectory: string,
	execution: Pick<ProviderExecution, "provider_id">,
): ValidatedSourceBundle {
	const root = safeDirectory(bundleDirectory, "Source Bundle");
	const resultPath = safeFileInside(root, join(root, "result.json"), "PrimeSearch output");
	const output = validatePrimeSearchOutput(JSON.parse(readFileSync(resultPath, "utf-8")) as unknown);
	const indexPath = safeFileInside(root, join(root, SOURCE_INDEX_NAME), "Source Bundle index");
	const index = validateSourceBundleIndex(
		JSON.parse(readFileSync(indexPath, "utf-8")) as unknown,
		execution.provider_id,
	);
	if (JSON.stringify(output.sources.map((source) => source.path))
		!== JSON.stringify(index.sources.map((source) => source.path))) {
		throw new Error("Source Bundle index does not match PrimeSearch output");
	}

	const sourceRoots = output.sources.map((source) => {
		assertSourcePath(source.path);
		return safeDirectoryInside(root, resolve(root, source.path), `Source directory '${source.path}'`);
	});
	for (const [indexA, sourceRoot] of sourceRoots.entries()) {
		for (const [indexB, otherRoot] of sourceRoots.entries()) {
			if (indexA !== indexB && isInsideRoot(sourceRoot, otherRoot)) {
				throw new Error(`Source directory '${output.sources[indexB]!.path}' overlaps another Source`);
			}
		}
	}

	const urls = new Set<string>();
	const candidateIds = new Set<string>();
	const sources = index.sources.map((source, sourceIndex) => {
		if (urls.has(source.url)) throw new Error(`PrimeSearch output URL contains duplicate '${source.url}'`);
		if (candidateIds.has(source.candidate_id)) {
			throw new Error(`PrimeSearch output candidate contains duplicate '${source.candidate_id}'`);
		}
		urls.add(source.url);
		candidateIds.add(source.candidate_id);
		const expectedSourceId = derivePrimeSearchSourceId(execution.provider_id, source.url);
		if (source.source_id !== expectedSourceId) {
			throw new Error(`Source Bundle index source_id does not match '${source.url}'`);
		}
		const sourceRoot = sourceRoots[sourceIndex]!;
		const files = inspectSourceDirectory(sourceRoot);
		const actualFiles = files.map((file) => ({
			path: file.relativePath,
			sha256: file.sha256,
			byte_length: file.byteLength,
		}));
		if (JSON.stringify(actualFiles) !== JSON.stringify(source.files)) {
			throw new Error(`Source Bundle index does not match Source '${source.path}'`);
		}
		return {
			path: source.path,
			candidate_id: source.candidate_id,
			source_id: source.source_id,
			url: source.url,
			title: source.title,
			sourceDirectoryPath: sourceRoot,
			files,
		};
	});
	const expectedFiles = new Set([
		"result.json",
		SOURCE_INDEX_NAME,
		...sources.flatMap((source) =>
			source.files.map((file) => `${source.path}/${file.relativePath}`)),
	]);
	const bundleFiles = listSafeFiles(root);
	for (const file of bundleFiles) {
		if (!expectedFiles.has(file.relativePath)) {
			throw new Error(`Source Bundle contains undeclared file '${file.relativePath}'`);
		}
	}
	const hash = createSha256();
	let byteLength = 0;
	for (const file of bundleFiles) {
		byteLength += file.byteLength;
		hash.update(file.relativePath);
		hash.update("\0");
		hash.update(file.sha256);
		hash.update("\n");
	}
	return {
		output,
		bundleDirectory: root,
		bundleSha256: hash.digest("hex"),
		byteLength,
		sources,
		quality: {
			sourceUnit: "provider_record",
			exactContentDuplicateCount: duplicateCount(sources.flatMap((source) =>
				[...new Set(source.files.map((file) => file.sha256))])),
			genericTitleCount: sources.filter((source) => /^(?:readme(?:\.[a-z0-9]+)?|[^/]+\.[a-z0-9]+)$/iu.test(source.title)).length,
		},
	};
}

function duplicateCount(values: readonly string[]): number {
	return values.length - new Set(values).size;
}

function validateSourceBundleIndex(value: unknown, providerId: string): SourceBundleIndex {
	const record = requireRecord(value, "Source Bundle index");
	assertExactKeys(record, ["schema_version", "provider_id", "sources"], "Source Bundle index");
	if (record.schema_version !== 1) throw new Error("Source Bundle index schema_version must be 1");
	if (record.provider_id !== providerId) {
		throw new Error("Source Bundle index provider_id does not match the Provider execution");
	}
	if (!Array.isArray(record.sources)) throw new Error("Source Bundle index sources must be an array");
	const sources = record.sources.map((rawSource, sourceIndex): SourceIndexEntry => {
		const source = requireRecord(rawSource, `Source Bundle index source ${sourceIndex}`);
		assertExactKeys(
			source,
			["path", "candidate_id", "source_id", "url", "title", "files"],
			`Source Bundle index source ${sourceIndex}`,
		);
		const path = requireString(source.path, `Source Bundle index source ${sourceIndex} path`);
		const candidateId = requireString(
			source.candidate_id,
			`Source Bundle index source ${sourceIndex} candidate_id`,
		);
		const sourceId = requireString(source.source_id, `Source Bundle index source ${sourceIndex} source_id`);
		const url = requireString(source.url, `Source Bundle index source ${sourceIndex} url`);
		const title = requireString(source.title, `Source Bundle index source ${sourceIndex} title`);
		if (!Array.isArray(source.files) || source.files.length === 0) {
			throw new Error(`Source Bundle index source ${sourceIndex} files must not be empty`);
		}
		const files = source.files.map((rawFile, fileIndex) => {
			const file = requireRecord(
				rawFile,
				`Source Bundle index source ${sourceIndex} file ${fileIndex}`,
			);
			assertExactKeys(
				file,
				["path", "sha256", "byte_length"],
				`Source Bundle index source ${sourceIndex} file ${fileIndex}`,
			);
			const filePath = requireString(
				file.path,
				`Source Bundle index source ${sourceIndex} file ${fileIndex} path`,
			);
			if (!/^[a-f0-9]{64}$/u.test(String(file.sha256))) {
				throw new Error(`Source Bundle index source ${sourceIndex} file ${fileIndex} sha256 is invalid`);
			}
			if (!Number.isInteger(file.byte_length) || (file.byte_length as number) < 0) {
				throw new Error(`Source Bundle index source ${sourceIndex} file ${fileIndex} byte_length is invalid`);
			}
			return {
				path: filePath,
				sha256: String(file.sha256),
				byte_length: file.byte_length as number,
			};
		});
		return {
			path,
			candidate_id: candidateId,
			source_id: sourceId,
			url,
			title,
			files,
		};
	});
	return {
		schema_version: 1,
		provider_id: providerId,
		sources,
	};
}

function assertSourcePath(path: string): void {
	if (isAbsolute(path) || path.includes("\0") || !path.startsWith("sources/")) {
		throw new Error(`PrimeSearch Source path '${path}' must be a relative directory under sources/`);
	}
	const parts = path.split(/[\\/]/u);
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error(`PrimeSearch Source path '${path}' must be safe`);
	}
}

function safeDirectory(path: string, label: string): string {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
	const real = realpathSync(path);
	if (!statSync(real).isDirectory()) throw new Error(`${label} must resolve to a directory`);
	return real;
}

function safeDirectoryInside(root: string, path: string, label: string): string {
	const safe = safeDirectory(path, label);
	if (!isInsideRoot(root, safe)) throw new Error(`${label} escapes its root directory`);
	return safe;
}

function safeFileInside(root: string, path: string, label: string): string {
	if (!isInsideRoot(root, path)) throw new Error(`${label} escapes its root directory`);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
	if (stat.nlink !== 1) throw new Error(`${label} must not be a hardlink`);
	const real = realpathSync(path);
	if (!isInsideRoot(root, real)) throw new Error(`${label} escapes its root directory`);
	return real;
}

function listSafeFiles(root: string): SourceFileRecord[] {
	const files: SourceFileRecord[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })
			.sort((left, right) => comparePaths(left.name, right.name))) {
			const absolutePath = join(directory, entry.name);
			const stat = lstatSync(absolutePath);
			const relativePath = normalizeRelative(root, absolutePath);
			if (stat.isSymbolicLink()) throw new Error(`Source directory contains symlink '${relativePath}'`);
			if (stat.isDirectory()) {
				visit(absolutePath);
				continue;
			}
			if (!stat.isFile()) throw new Error(`Source directory contains non-file '${relativePath}'`);
			if (stat.nlink !== 1) throw new Error(`Source directory contains hardlink '${relativePath}'`);
			const content = readFileSync(absolutePath);
			files.push({
				relativePath,
				absolutePath,
				sha256: sha256(content),
				byteLength: content.byteLength,
			});
		}
	};
	visit(root);
	return files.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be one JSON object`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function assertExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
	if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
		throw new Error(`${label} must contain exactly ${keys.join(", ")}`);
	}
}

function normalizeRelative(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}
