import { createSha256 } from "../lib/hash.js";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export function hashWikiDirectory(root: string): string {
	const hash = createSha256();
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(directory, entry.name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error(`Wiki Knowledge contains symlink '${relative(root, path)}'`);
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile()) {
				hash.update(relative(root, path).replaceAll("\\", "/"));
				hash.update("\0");
				hash.update(readFileSync(path));
				hash.update("\0");
			}
		}
	};
	if (existsSync(root)) visit(root);
	return hash.digest("hex");
}
