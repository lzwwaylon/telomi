import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isInsideRoot } from "../lib/paths.js";

export interface SessionSection { key: string; label: string; path: string }
interface SessionSource { path: string; label: string }

/** Resolve Runtime-owned references within this Goal, rejecting symlinks at every level. */
export function safeSessionPath(root: string, ref: string, boundary = root): string | undefined {
	if (!ref || isAbsolute(ref) || ref.includes("\0") || !existsSync(boundary)
		|| lstatSync(boundary).isSymbolicLink() || !lstatSync(boundary).isDirectory()) return undefined;
	const path = resolve(root, ref);
	if (!isInsideRoot(boundary, path, { allowRoot: false })) return undefined;
	let current = resolve(boundary);
	for (const segment of relative(boundary, path).split(sep)) {
		current = join(current, segment);
		if (!existsSync(current) || lstatSync(current).isSymbolicLink()) return undefined;
	}
	return path;
}

/** Missing directories are normal before the SDK creates its first session. */
function sessionSections(root: string, sources: SessionSource[], boundary = root): SessionSection[] {
	const sections: SessionSection[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		const first = sections.length;
		const visit = (ref: string) => {
			const path = safeSessionPath(root, ref, boundary);
			if (!path || seen.has(path)) return;
			seen.add(path);
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				for (const name of readdirSync(path).sort()) visit(join(ref, name));
			} else if (stat.isFile() && path.endsWith(".jsonl") && basename(path) !== "sdk-events.jsonl") {
				sections.push({ key: relative(boundary, path), label: source.label, path });
			}
		};
		visit(source.path);
		if (sections.length - first > 1) {
			for (let index = first; index < sections.length; index += 1) sections[index]!.label += ` ${index - first + 1}`;
		}
	}
	return sections;
}

export function manifestSessionSections(root: string, ref: string, boundary = root): SessionSection[] | undefined {
	const path = safeSessionPath(root, ref, boundary);
	if (!path || !lstatSync(path).isFile()) return undefined;
	const manifest = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; sessions?: unknown };
	if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.sessions)
		|| !manifest.sessions.every((source) => source && typeof source.path === "string" && typeof source.label === "string")) {
		throw new Error("Invalid Agent session trace manifest");
	}
	return sessionSections(root, manifest.sessions, boundary);
}

export function reporterSessionSections(root: string, sessionRef: string): SessionSection[] {
	return manifestSessionSections(root, `${sessionRef}.sessions.json`) ?? [];
}

/** Wiki output is readable only through its current session manifest. */
export function wikiSessionSections(control: string, ref: string, boundary = control): SessionSection[] {
	return ref.endsWith(".json") ? manifestSessionSections(control, ref, boundary) ?? [] : [];
}
