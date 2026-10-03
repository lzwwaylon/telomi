import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../lib/fs.js";

/** A read-only task brief, independent of evidence and Source navigation. */
export function writeTaskContext(inputRoot: string, context = ""): string {
	mkdirSync(inputRoot, { recursive: true });
	const path = join(inputRoot, "context.md");
	if (existsSync(path)) {
		if (readFileSync(path, "utf8") !== context) throw new Error("Task context changed within the same execution");
	} else writeFileAtomic(path, context);
	return path;
}

export function copyTaskContext(inputRoot: string, contextFile?: string): string {
	return writeTaskContext(inputRoot, contextFile ? readFileSync(contextFile, "utf8") : "");
}
