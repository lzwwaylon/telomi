import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Load project-local environment files for the server process. Existing
 * process variables always win; .env.worktree overrides .env.local and .env for keys that were
 * not supplied by the parent process. Values are never logged.
 */
export function loadProjectEnvironment(
	rootDir: string,
	env: Record<string, string | undefined> = process.env,
): string[] {
	const parentKeys = new Set(Object.keys(env));
	const loaded: string[] = [];
	for (const filename of [".env", ".env.local", ".env.worktree"]) {
		const path = join(rootDir, filename);
		if (!existsSync(path)) continue;
		const text = readFileSync(path, "utf-8");
		if (Buffer.byteLength(text, "utf-8") > 1024 * 1024) throw new Error(`${filename} exceeds the 1 MiB safety limit`);
		for (const [key, value] of parseEnvironmentFile(text, filename)) {
			if (parentKeys.has(key)) continue;
			env[key] = value;
			loaded.push(key);
		}
	}
	return [...new Set(loaded)];
}

function parseEnvironmentFile(text: string, filename: string): Array<[string, string]> {
	const values: Array<[string, string]> = [];
	for (const [index, rawLine] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match) throw new Error(`${filename}:${index + 1} is not a valid environment assignment`);
		values.push([match[1]!, parseEnvironmentValue(match[2] ?? "")]);
	}
	return values;
}

function parseEnvironmentValue(raw: string): string {
	const value = raw.trim();
	if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
	if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
		return value.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\\"/g, "\"")
			.replace(/\\\\/g, "\\");
	}
	return value.replace(/\s+#.*$/, "").trim();
}
