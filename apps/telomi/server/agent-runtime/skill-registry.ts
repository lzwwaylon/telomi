import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hashJson, sha256 } from "../lib/hash.js";
import { loadAgentPromptConfig, type PromptDomain } from "./prompt-registry.js";
import { comparePaths } from "../lib/paths.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_BYTES = 50 * 1024 * 1024;
const BUNDLED_AGENTS_ROOT = fileURLToPath(new URL("../../agents/", import.meta.url));
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/u;

export function bundledAgentSkillPath(domain: PromptDomain, agentId: string, name: string): string {
	if (!SAFE_SEGMENT.test(agentId) || !SAFE_SEGMENT.test(name)) {
		throw new Error(`Invalid bundled Agent Skill '${domain}/${agentId}/${name}'`);
	}
	return join(BUNDLED_AGENTS_ROOT, domain, agentId, "skills", name);
}

export function bundledAgentSkillPaths(domain: PromptDomain, agentId: string): string[] {
	return (loadAgentPromptConfig(domain, agentId).skills ?? []).map((reference) => {
		const segments = reference.split("/");
		const owner = segments.length === 2 ? segments[0]! : agentId;
		const name = segments.length === 2 ? segments[1]! : segments[0]!;
		const path = bundledAgentSkillPath(domain, owner, name);
		if (!existsSync(join(path, "SKILL.md"))) {
			throw new Error(`Agent '${domain}/${agentId}' declares missing bundled Skill '${reference}'`);
		}
		return path;
	});
}

export interface SkillFileSnapshot {
	relativePath: string;
	sha256: string;
	size: number;
	mode: number;
}

export interface SkillSnapshot {
	name: string;
	description: string;
	sourcePath: string;
	sha256: string;
	files: SkillFileSnapshot[];
}

export interface SkillSetSnapshot {
	schemaVersion: 1;
	sha256: string;
	skills: SkillSnapshot[];
}

/** Each input may be one Skill directory or a directory containing Skills. Later roots may override by name. */
export function snapshotSkills(
	paths: readonly string[],
	options: { allowOverrides?: boolean } = {},
): SkillSetSnapshot {
	const skills = new Map<string, SkillSnapshot>();
	for (const rawPath of paths) {
		const path = resolve(rawPath);
		if (!existsSync(path)) continue;
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Skill path must be a real directory: ${path}`);
		const direct = existsSync(join(path, "SKILL.md"));
		const directories = direct
			? [path]
			: readdirSync(path, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
					&& existsSync(join(path, entry.name, "SKILL.md")))
				.map((entry) => join(path, entry.name));
		for (const directory of directories) {
			const skill = snapshotSkill(directory, !direct);
			if (skills.has(skill.name) && !options.allowOverrides) {
				throw new Error(`Duplicate Skill name '${skill.name}'`);
			}
			skills.set(skill.name, skill);
		}
	}
	const ordered = [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
	return {
		schemaVersion: 1,
		sha256: hashJson(ordered.map((skill) => ({ name: skill.name, sha256: skill.sha256 }))),
		skills: ordered,
	};
}

/** Replaces targetRoot with a verified immutable copy and returns Skill name to directory mappings. */
export function materializeSkills(
	snapshot: SkillSetSnapshot | readonly SkillSnapshot[],
	targetRoot: string,
): Map<string, string> {
	const skills = "skills" in snapshot ? snapshot.skills : snapshot;
	const target = resolve(targetRoot);
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	const result = new Map<string, string>();
	for (const skill of skills) {
		const current = snapshotSkill(skill.sourcePath, false);
		if (current.sha256 !== skill.sha256) throw new Error(`Skill '${skill.name}' changed after snapshot`);
		const destination = join(target, skill.name);
		cpSync(skill.sourcePath, destination, { recursive: true, dereference: false });
		for (const file of skill.files) chmodSync(join(destination, file.relativePath), file.mode);
		const copied = snapshotSkill(destination, false);
		if (copied.sha256 !== skill.sha256) throw new Error(`Materialized Skill '${skill.name}' failed hash verification`);
		result.set(skill.name, destination);
	}
	writeFileSync(join(target, ".skill-snapshot.json"), `${JSON.stringify({
		schema_version: 1,
		sha256: "skills" in snapshot
			? snapshot.sha256
			: hashJson(skills.map((skill) => ({ name: skill.name, sha256: skill.sha256 }))),
		skills: skills.map((skill) => ({ name: skill.name, description: skill.description,
			sha256: skill.sha256, source_path: skill.sourcePath, files: skill.files })),
	}, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	return result;
}

/**
 * The source identity of a Skill that `materializeSkills` staged, or its own hash when it was not
 * staged. Runtime may add generated files to a staged Skill (a Provider's `references/API.md`), so
 * rehashing the staged directory never equals the Skill a Candidate or Goal override was hashed
 * as. Every other source file is still checked against the staging record before its identity is
 * used; `generated` names the paths Runtime overwrites, which a source may carry a stale copy of.
 */
export function materializedSkillIdentity(skill: SkillSnapshot, generated: readonly string[] = []): string {
	const recordPath = join(dirname(skill.sourcePath), ".skill-snapshot.json");
	if (!existsSync(recordPath)) return skill.sha256;
	const record = JSON.parse(readFileSync(recordPath, "utf-8")) as {
		skills?: Array<{ name: string; sha256: string; files: SkillFileSnapshot[] }>;
	};
	const source = record.skills?.find((item) => item.name === skill.name);
	if (!source) return skill.sha256;
	const staged = new Map(skill.files.map((file) => [file.relativePath, file.sha256]));
	const changed = source.files.find((file) => !generated.includes(file.relativePath)
		&& staged.get(file.relativePath) !== file.sha256);
	if (changed) throw new Error(`Materialized Skill '${skill.name}' changed after staging: ${changed.relativePath}`);
	return source.sha256;
}

function snapshotSkill(directory: string, requireDirectoryNameMatch: boolean): SkillSnapshot {
	const root = realpathSync(directory);
	const skillFile = join(root, "SKILL.md");
	if (!existsSync(skillFile)) throw new Error(`Skill is missing SKILL.md: ${root}`);
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(readFileSync(skillFile, "utf-8"))?.[1] ?? "";
	const name = /^name:\s*([^\s].*)$/mu.exec(frontmatter)?.[1]?.trim();
	const description = /^description:\s*([^\s].*)$/mu.exec(frontmatter)?.[1]?.trim();
	if (!name || !/^[a-z0-9][a-z0-9-]*$/u.test(name) || !description) {
		throw new Error(`Skill '${root}' requires valid name and description frontmatter`);
	}
	if (requireDirectoryNameMatch && name !== basename(root)) {
		throw new Error(`Skill directory '${basename(root)}' must match name '${name}'`);
	}
	const files: SkillFileSnapshot[] = [];
	let totalBytes = 0;
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error(`Skill '${name}' cannot contain symlink '${relative(root, path)}'`);
			if (stat.isDirectory()) {
				walk(path);
				continue;
			}
			if (!stat.isFile()) throw new Error(`Skill '${name}' contains unsupported entry '${relative(root, path)}'`);
			if (stat.size > MAX_FILE_BYTES) throw new Error(`Skill '${name}' file exceeds ${MAX_FILE_BYTES} bytes: ${entry.name}`);
			totalBytes += stat.size;
			if (totalBytes > MAX_SKILL_BYTES) throw new Error(`Skill '${name}' exceeds ${MAX_SKILL_BYTES} bytes`);
			const relativePath = relative(root, path).split("\\").join("/");
			if (!relativePath || relativePath.startsWith("../") || isAbsolute(relativePath)) {
				throw new Error(`Skill '${name}' contains an unsafe path`);
			}
			files.push({ relativePath, sha256: sha256(readFileSync(path)), size: stat.size, mode: stat.mode & 0o777 });
		}
	};
	walk(root);
	files.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
	return {
		name,
		description,
		sourcePath: root,
		sha256: hashJson(files),
		files,
	};
}
