import { listFilesRecursive } from "../../lib/fs.js";
import { createSha256, sha256 } from "../../lib/hash.js";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { SandboxMountSpec } from "../../../../extensions/telomi-srt/sandbox-spec.js";
import { assertSafeRelativePath } from "../../lib/paths.js";
import { isInsideRoot } from "../../lib/paths.js";

export class StageInputView {
	readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
		if (existsSync(this.root)) rmSync(this.root, { recursive: true, force: true });
		mkdirSync(this.root, { recursive: true });
	}

	writeJson(relativePath: string, value: unknown): string {
		return this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
	}

	writeText(relativePath: string, value: string): string {
		const path = this.resolve(relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, value, { encoding: "utf-8", flag: "wx" });
		return path;
	}

	mkdir(relativePath: string): string {
		const path = this.resolve(relativePath);
		mkdirSync(path, { recursive: true });
		return path;
	}

	copyFile(relativePath: string, sourcePath: string): string {
		const source = secureRegularFile(sourcePath);
		const target = this.resolve(relativePath);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
		return target;
	}

	mount(guestPath = "/inputs"): SandboxMountSpec {
		return {
			hostPath: this.root,
			guestPath,
			access: "read-only",
		};
	}

	hash(): string {
		const files = listFilesRecursive(this.root, { strict: true, rejectNonRegular: true });
		const hash = createSha256();
		for (const file of files) {
			const content = readFileSync(join(this.root, file));
			hash.update(file);
			hash.update("\0");
			hash.update(sha256(content));
			hash.update("\n");
		}
		return hash.digest("hex");
	}

	private resolve(relativePath: string): string {
		assertSafeRelativePath(relativePath, "Stage input path");
		const path = resolve(this.root, relativePath);
		if (path === resolve(this.root) || !isInsideRoot(this.root, path)) {
			throw new Error(`Stage input path escapes its view: ${relativePath}`);
		}
		return path;
	}
}

function secureRegularFile(path: string): string {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
		throw new Error(`Stage input source must be one regular file: ${path}`);
	}
	return realpathSync(path);
}
