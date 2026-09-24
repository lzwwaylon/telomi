import { Type, type Static } from "@sinclair/typebox";

import { sha256, createSha256 } from "../lib/hash.js";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { cloneDirectoryContents } from "../lib/cow.js";
import { isInsideRoot } from "../lib/paths.js";
import { writeFileAtomic } from "../lib/fs.js";
import { comparePaths } from "../lib/paths.js";

/** The persisted reference to one published artifact, as stored in Run checkpoints and job files. */
export const ArtifactRefSchema = Type.Object({
	relative_path: Type.String({ minLength: 1 }),
	sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	byte_length: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export type RunArtifactRef = Static<typeof ArtifactRefSchema>;

export interface PublishedArtifactRef {
	relativePath: string;
	absolutePath: string;
	sha256: string;
	byteLength: number;
}

export interface PublishedArtifactDirectoryRef {
	relativePath: string;
	absolutePath: string;
	sha256: string;
	byteLength: number;
	files: Array<{
		relativePath: string;
		sha256: string;
		byteLength: number;
	}>;
}

export class RunArtifactStore {
	private readonly rootReal: string;

	constructor(readonly root: string) {
		mkdirSync(root, { recursive: true });
		this.rootReal = realpathSync(root);
	}

	publishFile(sourcePath: string, targetRelativePath: string): PublishedArtifactRef {
		const source = safeRegularFile(sourcePath, "Stage output");
		const target = this.resolveTarget(targetRelativePath);
		if (existsSync(target)) throw new Error(`Published Artifact already exists: ${targetRelativePath}`);
		mkdirSync(dirname(target), { recursive: true });
		const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
		try {
			copyFileSync(source, temporary);
			const temporaryStat = lstatSync(temporary);
			if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() || temporaryStat.nlink !== 1) {
				throw new Error("Temporary Published Artifact must be one regular file");
			}
			closeSync(openSync(temporary, "r"));
			renameSync(temporary, target);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
		return this.describe(targetRelativePath, target);
	}

	publishFileFromRoot(
		sourceRoot: string,
		sourcePath: string,
		targetRelativePath: string,
	): PublishedArtifactRef {
		assertPathInsideRoot(sourceRoot, sourcePath, "Stage output");
		return this.publishFile(sourcePath, targetRelativePath);
	}

	publishDirectory(
		sourceDirectory: string,
		targetRelativePath: string,
		sourceRoot = sourceDirectory,
	): PublishedArtifactDirectoryRef {
		const source = safeDirectoryInsideRoot(sourceRoot, sourceDirectory, "Stage output directory");
		const target = this.resolveTarget(targetRelativePath);
		if (existsSync(target)) throw new Error(`Published Artifact already exists: ${targetRelativePath}`);
		mkdirSync(dirname(target), { recursive: true });
		const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
		try {
			mkdirSync(temporary);
			copySafeDirectory(source, temporary);
			renameSync(temporary, target);
		} finally {
			if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
		}
		return this.describeDirectoryInternal(targetRelativePath, target);
	}

	publishText(content: string, targetRelativePath: string): PublishedArtifactRef {
		const target = this.resolveTarget(targetRelativePath);
		if (existsSync(target)) throw new Error(`Published Artifact already exists: ${targetRelativePath}`);
		writeFileAtomic(target, content);
		return this.describe(targetRelativePath, target);
	}

	readJson<T>(artifact: PublishedArtifactRef): T {
		const current = this.describe(artifact.relativePath, this.resolveTarget(artifact.relativePath));
		if (current.sha256 !== artifact.sha256) throw new Error(`Published Artifact hash changed: ${artifact.relativePath}`);
		return JSON.parse(readFileSync(current.absolutePath, "utf-8")) as T;
	}

	openFile(expected: {
		relative_path: string;
		sha256: string;
		byte_length: number;
	}): PublishedArtifactRef {
		const current = this.describe(expected.relative_path, this.resolveTarget(expected.relative_path));
		assertExpectedArtifact(current, expected);
		return current;
	}

	describeFile(relativePath: string): PublishedArtifactRef {
		return this.describe(relativePath, this.resolveTarget(relativePath));
	}

	openDirectory(expected: {
		relative_path: string;
		sha256: string;
		byte_length: number;
	}): PublishedArtifactDirectoryRef {
		const current = this.describeDirectoryInternal(
			expected.relative_path,
			this.resolveTarget(expected.relative_path),
		);
		assertExpectedArtifact(current, expected);
		return current;
	}

	describeDirectory(relativePath: string): PublishedArtifactDirectoryRef {
		return this.describeDirectoryInternal(relativePath, this.resolveTarget(relativePath));
	}

	private resolveTarget(targetRelativePath: string): string {
		if (!targetRelativePath || isAbsolute(targetRelativePath) || targetRelativePath.includes("\0")) {
			throw new Error("Published Artifact target must be a safe relative path");
		}
		const target = resolve(this.rootReal, targetRelativePath);
		if (target === this.rootReal || !isInsideRoot(this.rootReal, target)) {
			throw new Error(`Published Artifact target escapes its store: ${targetRelativePath}`);
		}
		return target;
	}

	private describe(relativePath: string, absolutePath: string): PublishedArtifactRef {
		const safe = safeRegularFile(absolutePath, "Published Artifact");
		const content = readFileSync(safe);
		return {
			relativePath,
			absolutePath: safe,
			sha256: sha256(content),
			byteLength: content.byteLength,
		};
	}

	private describeDirectoryInternal(relativePath: string, absolutePath: string): PublishedArtifactDirectoryRef {
		const root = safeDirectoryInsideRoot(absolutePath, absolutePath, "Published Artifact directory");
		const files = collectSafeFiles(root).map((file) => {
			const content = readFileSync(file.absolutePath);
			return {
				relativePath: file.relativePath,
				sha256: sha256(content),
				byteLength: content.byteLength,
			};
		});
		const byteLength = files.reduce((total, file) => total + file.byteLength, 0);
		return {
			relativePath,
			absolutePath: root,
			sha256: directoryDigest(files),
			byteLength,
			files,
		};
	}
}

function directoryDigest(files: PublishedArtifactDirectoryRef["files"]): string {
	const hash = createSha256();
	for (const file of files) {
		hash.update(file.relativePath);
		hash.update("\0");
		hash.update(file.sha256);
		hash.update("\0");
		hash.update(String(file.byteLength));
		hash.update("\n");
	}
	return hash.digest("hex");
}

function assertExpectedArtifact(
	current: PublishedArtifactRef | PublishedArtifactDirectoryRef,
	expected: {
		relative_path: string;
		sha256: string;
		byte_length: number;
	},
): void {
	if (current.sha256 !== expected.sha256) {
		throw new Error(`Published Artifact hash changed: ${expected.relative_path}`);
	}
	if (current.byteLength !== expected.byte_length) {
		throw new Error(`Published Artifact byte length changed: ${expected.relative_path}`);
	}
}

export function safeRegularFile(path: string, label: string): string {
	if (!existsSync(path)) throw new Error(`${label} does not exist`);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
	if (stat.nlink !== 1) throw new Error(`${label} must not be a hardlink`);
	const real = realpathSync(path);
	if (!statSync(real).isFile()) throw new Error(`${label} must resolve to a regular file`);
	return real;
}

export function assertPathInsideRoot(root: string, path: string, label: string): string {
	const rootReal = realpathSync(root);
	const pathReal = realpathSync(path);
	if (!isInsideRoot(rootReal, pathReal)) throw new Error(`${label} escapes its allowed root`);
	return pathReal;
}

function safeDirectoryInsideRoot(root: string, path: string, label: string): string {
	if (!existsSync(path)) throw new Error(`${label} does not exist`);
	const before = lstatSync(path);
	if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
	const real = assertPathInsideRoot(root, path, label);
	if (!statSync(real).isDirectory()) throw new Error(`${label} must resolve to a directory`);
	return real;
}

function copySafeDirectory(sourceRoot: string, targetRoot: string): void {
	// collectSafeFiles 已经拒绝 symlink 与非普通文件，整棵树等价于它的结果，
	// 因此可以先尝试一次 clonefile，失败再退回逐文件拷贝。
	const items = collectSafeFiles(sourceRoot);
	if (cloneDirectoryContents(sourceRoot, targetRoot) === "clone") return;
	for (const item of items) {
		const target = join(targetRoot, item.relativePath);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(item.absolutePath, target);
	}
}

function collectSafeFiles(root: string): Array<{ relativePath: string; absolutePath: string }> {
	const files: Array<{ relativePath: string; absolutePath: string }> = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
			const absolutePath = join(directory, entry.name);
			const stat = lstatSync(absolutePath);
			if (stat.isSymbolicLink()) throw new Error(`Artifact directory contains symlink '${relative(root, absolutePath)}'`);
			if (stat.isDirectory()) {
				visit(absolutePath);
				continue;
			}
			if (!stat.isFile()) throw new Error(`Artifact directory contains non-file '${relative(root, absolutePath)}'`);
			if (stat.nlink !== 1) throw new Error(`Artifact directory contains hardlink '${relative(root, absolutePath)}'`);
			const relativePath = relative(root, absolutePath);
			assertPathInsideRoot(root, absolutePath, "Artifact file");
			files.push({ relativePath, absolutePath });
		}
	};
	visit(root);
	return files.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
}
