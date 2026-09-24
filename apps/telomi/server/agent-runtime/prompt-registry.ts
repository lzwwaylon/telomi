import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import nunjucks from "nunjucks";
import { parse as parseYaml } from "yaml";
import { runtimeControlRoot } from "../workspaces/server-runtime-paths.js";
import { resolveDataDir } from "../config/data-dir.js";
import { sha256 } from "../lib/hash.js";
import { writeFileAtomic } from "../lib/fs.js";
import { toErrorMessage } from "../lib/values.js";

export type PromptDomain = "main" | "research" | "wiki" | "evolution";
export const PROMPT_KINDS = [
	"system",
	"system-append",
	"instructions",
	"user",
	"reference",
	"tool",
] as const;
export type PromptKind = typeof PROMPT_KINDS[number];
export type PromptExecutionProfile = "bash_only" | "pi_builtin" | "prime_ipython";
export type PromptNetworkMode = "deny" | "allow";
export type PromptRevisionSource = "source_default" | "managed_revision";

export interface PromptIdentity {
	domain: PromptDomain;
	id: string;
	kind: PromptKind;
	variant: string;
}

export interface PromptRevisionIdentity extends PromptIdentity {
	revisionId: string;
	templateSha256: string;
	source: PromptRevisionSource;
}

export interface PromptRevision extends PromptRevisionIdentity {
	schemaVersion: 1;
	template: string;
	baseRevisionId: string;
	createdAt: string;
	description?: string;
}

export interface PromptDetail {
	identity: PromptIdentity;
	defaultRevision: PromptRevision;
	activeRevisionId: string;
	activeRevision: PromptRevision;
	revisions: PromptRevision[];
}

export interface AgentPromptSandboxConfig {
	role: string;
	executionProfile?: PromptExecutionProfile;
	network: PromptNetworkMode;
	tools: string[];
}

export interface AgentPromptConfig {
	schemaVersion: 2;
	id: string;
	skills?: string[];
	prompts: Partial<Record<PromptKind, Record<string, string>>>;
	sandbox?: AgentPromptSandboxConfig;
}

export interface RenderedAgentPrompt {
	content: string;
	templatePath: string;
	templateSha256: string;
	configSha256: string;
	revision: PromptRevisionIdentity;
}

interface PromptSelectionContext {
	registry: PromptRegistry;
	revision?: PromptRevision;
	used: boolean;
	rendered: PromptRevisionIdentity[];
}

const SOURCE_AGENT_ROOT = fileURLToPath(new URL("../../agents/", import.meta.url));
const REGISTRY_RELATIVE_ROOT = "agent-runtime/prompt-registry/v1";
const PROMPT_DOMAINS = new Set<PromptDomain>(["main", "research", "wiki", "evolution"]);
const PROMPT_KIND_SET = new Set<PromptKind>(PROMPT_KINDS);
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/u;
const SAFE_SKILL_REF = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/u;
const SAFE_TEMPLATE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.njk$/u;
const SAFE_REVISION = /^pr_[a-f0-9]{32}$/u;
const MAX_TEMPLATE_CHARACTERS = 200_000;
const MAX_DESCRIPTION_CHARACTERS = 2_000;
const EXECUTION_PROFILES = new Set<PromptExecutionProfile>(["bash_only", "pi_builtin", "prime_ipython"]);
const NETWORK_MODES = new Set<PromptNetworkMode>(["deny", "allow"]);
const selectionStorage = new AsyncLocalStorage<PromptSelectionContext>();
const nunjucksParser = (nunjucks as unknown as { parser: { parse(source: string): unknown } }).parser;
const templateEnvironment = new nunjucks.Environment(undefined, {
	autoescape: false,
	throwOnUndefined: true,
	trimBlocks: true,
	lstripBlocks: true,
});

export class PromptRegistryConflictError extends Error {}
export class PromptRegistryNotFoundError extends Error {}

export class PromptRegistry {
	private readonly dataRoot: string;
	private readonly agentRoot: string;

	constructor(options: { dataRoot?: string; agentRoot?: string } = {}) {
		this.dataRoot = resolve(options.dataRoot ?? resolveDataDir());
		this.agentRoot = resolve(options.agentRoot ?? SOURCE_AGENT_ROOT);
	}

	loadConfig(domain: PromptDomain, id: string): AgentPromptConfig {
		const { config } = this.definition(domain, id);
		return config;
	}

	list(): PromptDetail[] {
		return [...PROMPT_DOMAINS].flatMap((domain) => {
			const root = resolveInside(this.agentRoot, domain);
			if (!existsSync(root)) return [];
			return readdirSync(root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && SAFE_SEGMENT.test(entry.name))
				.flatMap((entry) => {
					const config = this.loadConfig(domain, entry.name);
					return PROMPT_KINDS.flatMap((kind) =>
						Object.keys(config.prompts[kind] ?? {}).sort().map((variant) =>
							this.get({ domain, id: entry.name, kind, variant })));
				});
		}).sort((left, right) => identityKey(left.identity).localeCompare(identityKey(right.identity)));
	}

	get(identity: PromptIdentity): PromptDetail {
		const normalized = this.validateIdentity(identity);
		const source = this.sourceRevision(normalized);
		const revisions = this.listRevisions(normalized);
		const activeRevisionId = this.readActiveRevisionId(normalized);
		const activeRevision = activeRevisionId === "default"
			? source
			: revisions.find((revision) => revision.revisionId === activeRevisionId);
		if (!activeRevision) {
			throw new PromptRegistryNotFoundError(
				`Active Prompt revision '${activeRevisionId}' does not exist for '${identityKey(normalized)}'`,
			);
		}
		return { identity: normalized, defaultRevision: source, activeRevisionId, activeRevision, revisions };
	}

	createRevision(identity: PromptIdentity, input: {
		template: string;
		expectedActiveRevisionId: string;
		description?: string;
	}): PromptRevision {
		const normalized = this.validateIdentity(identity);
		assertExactKeys(input as unknown as Record<string, unknown>,
			["template", "expectedActiveRevisionId", "description"], "Prompt revision request");
		const template = validateTemplate(input.template);
		const expected = validateRevisionId(input.expectedActiveRevisionId, true);
		const description = input.description === undefined
			? undefined
			: requireBoundedString(input.description, "description", MAX_DESCRIPTION_CHARACTERS);
		const current = this.readActiveRevisionId(normalized);
		if (current !== expected) throw new PromptRegistryConflictError(`Active Prompt revision is '${current}', not '${expected}'`);
		const revision: PromptRevision = {
			schemaVersion: 1,
			...normalized,
			revisionId: `pr_${randomUUID().replaceAll("-", "")}`,
			template,
			templateSha256: sha256(template),
			source: "managed_revision",
			baseRevisionId: current,
			createdAt: new Date().toISOString(),
			...(description ? { description } : {}),
		};
		const path = this.revisionPath(revision.revisionId);
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileSync(path, `${JSON.stringify(revision, null, 2)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
		return revision;
	}

	activate(identity: PromptIdentity, input: {
		revisionId: string;
		expectedActiveRevisionId: string;
	}): PromptDetail {
		const normalized = this.validateIdentity(identity);
		assertExactKeys(input as unknown as Record<string, unknown>,
			["revisionId", "expectedActiveRevisionId"], "Prompt activation request");
		const revisionId = validateRevisionId(input.revisionId, true);
		const expected = validateRevisionId(input.expectedActiveRevisionId, true);
		const current = this.readActiveRevisionId(normalized);
		if (current !== expected) throw new PromptRegistryConflictError(`Active Prompt revision is '${current}', not '${expected}'`);
		if (revisionId !== "default") this.requireRevision(revisionId, normalized);
		const path = this.activePath(normalized);
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileAtomic(path, `${JSON.stringify({ schemaVersion: 1, ...normalized, revisionId,
			updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
		return this.get(normalized);
	}

	render(
		domain: PromptDomain,
		id: string,
		kind: PromptKind,
		variables: Record<string, unknown> = {},
		variant = "default",
	): RenderedAgentPrompt {
		const identity = this.validateIdentity({ domain, id, kind, variant });
		const context = selectionStorage.getStore();
		const selected = context?.registry === this && context.revision && sameIdentity(context.revision, identity)
			? context.revision
			: undefined;
		const detail = selected ? undefined : this.get(identity);
		const revision = selected ?? detail!.activeRevision;
		const definition = this.definition(domain, id);
		let content: string;
		try {
			content = templateEnvironment.renderString(revision.template, variables).trim();
		} catch (error) {
			throw new Error(`Failed to render Prompt '${identityKey(identity)}': ${toErrorMessage(error)}`);
		}
		if (!content) throw new Error(`Rendered Prompt '${identityKey(identity)}' is empty`);
		const revisionIdentity = toRevisionIdentity(revision);
		if (context?.registry === this) {
			context.rendered.push(revisionIdentity);
			if (selected) context.used = true;
		}
		return {
			content,
			templatePath: revision.source === "source_default"
				? definition.templatePaths.get(`${kind}:${variant}`)!
				: this.revisionPath(revision.revisionId),
			templateSha256: revision.templateSha256,
			configSha256: definition.configSha256,
			revision: revisionIdentity,
		};
	}

	revision(revisionId: string): PromptRevisionIdentity {
		const revision = this.requireRevision(validateRevisionId(revisionId, false));
		this.validateIdentity(revision);
		return toRevisionIdentity(revision);
	}

	async runWithRevision<T>(revisionId: string, callback: () => Promise<T>): Promise<{
		value: T;
		revision: PromptRevisionIdentity;
		rendered: PromptRevisionIdentity[];
	}> {
		const revision = this.requireRevision(validateRevisionId(revisionId, false));
		const context: PromptSelectionContext = { registry: this, revision, used: false, rendered: [] };
		const value = await selectionStorage.run(context, callback);
		if (!context.used) {
			throw new Error(`Prompt revision '${revisionId}' was not used by this execution`);
		}
		return { value, revision: toRevisionIdentity(revision), rendered: deduplicateIdentities(context.rendered) };
	}

	async captureRenders<T>(callback: () => Promise<T>): Promise<{ value: T; rendered: PromptRevisionIdentity[] }> {
		const context: PromptSelectionContext = { registry: this, used: false, rendered: [] };
		const value = await selectionStorage.run(context, callback);
		return { value, rendered: deduplicateIdentities(context.rendered) };
	}

	private validateIdentity(identity: PromptIdentity): PromptIdentity {
		if (!PROMPT_DOMAINS.has(identity.domain) || !SAFE_SEGMENT.test(identity.id)
			|| !PROMPT_KIND_SET.has(identity.kind) || !SAFE_SEGMENT.test(identity.variant)) {
			throw new Error(`Invalid Prompt identity '${identity.domain}/${identity.id}/${identity.kind}:${identity.variant}'`);
		}
		const { config } = this.definition(identity.domain, identity.id);
		const templateName = config.prompts[identity.kind]?.[identity.variant];
		if (!templateName) throw new PromptRegistryNotFoundError(`Unknown Prompt '${identityKey(identity)}'`);
		return { ...identity };
	}

	private definition(domain: PromptDomain, id: string): {
		config: AgentPromptConfig;
		configSha256: string;
		templatePaths: Map<string, string>;
	} {
		if (!PROMPT_DOMAINS.has(domain) || !SAFE_SEGMENT.test(id)) throw new Error(`Invalid Prompt identity '${domain}/${id}'`);
		const directory = resolveInside(this.agentRoot, `${domain}/${id}`);
		const configPath = resolveInside(directory, "agent.yaml");
		if (!existsSync(configPath)) throw new PromptRegistryNotFoundError(`Unknown Prompt '${domain}/${id}'`);
		const configSource = readFileSync(configPath, "utf-8");
		let parsed: unknown;
		try {
			parsed = parseYaml(configSource);
		} catch (error) {
			throw new Error(`Invalid Prompt config '${configPath}': ${toErrorMessage(error)}`);
		}
		const config = parseAgentPromptConfig(parsed, id, configPath);
		const promptRoot = resolveInside(directory, "prompts");
		const templatePaths = new Map<string, string>();
		for (const kind of PROMPT_KINDS) {
			for (const [variant, name] of Object.entries(config.prompts[kind] ?? {})) {
				templatePaths.set(`${kind}:${variant}`, resolveInside(promptRoot, name));
			}
		}
		return { config, configSha256: sha256(configSource), templatePaths };
	}

	private sourceRevision(identity: PromptIdentity): PromptRevision {
		const definition = this.definition(identity.domain, identity.id);
		const templatePath = definition.templatePaths.get(`${identity.kind}:${identity.variant}`)!;
		const template = readFileSync(templatePath, "utf-8");
		return { schemaVersion: 1, ...identity, revisionId: "default", template,
			templateSha256: sha256(template), source: "source_default", baseRevisionId: "default", createdAt: "source-controlled" };
	}

	private listRevisions(identity: PromptIdentity): PromptRevision[] {
		const root = this.revisionsRoot();
		if (!existsSync(root)) return [];
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isFile() && SAFE_REVISION.test(entry.name.replace(/\.json$/u, "")))
			.map((entry) => this.readRevision(resolveInside(root, entry.name)))
			.filter((revision) => sameIdentity(revision, identity))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	private requireRevision(revisionId: string, identity?: PromptIdentity): PromptRevision {
		const path = this.revisionPath(revisionId);
		if (!existsSync(path)) throw new PromptRegistryNotFoundError(`Unknown Prompt revision '${revisionId}'`);
		const revision = this.readRevision(path);
		if (identity && !sameIdentity(revision, identity)) {
			throw new PromptRegistryNotFoundError(`Prompt revision '${revisionId}' does not belong to '${identityKey(identity)}'`);
		}
		return revision;
	}

	private readRevision(path: string): PromptRevision {
		const value = JSON.parse(readFileSync(path, "utf-8")) as PromptRevision;
		if (value.schemaVersion !== 1 || !SAFE_REVISION.test(value.revisionId)
			|| basename(path) !== `${value.revisionId}.json`
			|| value.source !== "managed_revision" || value.templateSha256 !== sha256(value.template)
			|| !PROMPT_DOMAINS.has(value.domain) || !SAFE_SEGMENT.test(value.id)
			|| !PROMPT_KIND_SET.has(value.kind) || !SAFE_SEGMENT.test(value.variant)) {
			throw new Error(`Invalid immutable Prompt revision '${path}'`);
		}
		validateTemplate(value.template);
		return value;
	}

	private readActiveRevisionId(identity: PromptIdentity): string {
		const path = this.activePath(identity);
		if (!existsSync(path)) return "default";
		const value = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		if (value.schemaVersion !== 1 || !sameIdentity(value as unknown as PromptIdentity, identity)) {
			throw new Error(`Invalid Prompt activation pointer '${path}'`);
		}
		return validateRevisionId(value.revisionId, true);
	}

	private registryRoot(): string { return resolveInside(runtimeControlRoot(this.dataRoot), REGISTRY_RELATIVE_ROOT); }
	private revisionsRoot(): string { return resolveInside(this.registryRoot(), "revisions"); }
	private revisionPath(revisionId: string): string {
		return resolveInside(this.revisionsRoot(), `${validateRevisionId(revisionId, false)}.json`);
	}
	private activePath(identity: PromptIdentity): string {
		return resolveInside(this.registryRoot(), `active/${identity.domain}/${identity.id}/${identity.kind}/${identity.variant}.json`);
	}
}

export function loadAgentPromptConfig(domain: PromptDomain, id: string): AgentPromptConfig {
	return currentRegistry().loadConfig(domain, id);
}

export function renderAgentPrompt(
	domain: PromptDomain,
	id: string,
	kind: PromptKind,
	variables: Record<string, unknown> = {},
	variant = "default",
): RenderedAgentPrompt {
	return currentRegistry().render(domain, id, kind, variables, variant);
}

function currentRegistry(): PromptRegistry {
	return selectionStorage.getStore()?.registry ?? new PromptRegistry();
}

function toRevisionIdentity(revision: PromptRevision): PromptRevisionIdentity {
	const { domain, id, kind, variant, revisionId, templateSha256, source } = revision;
	return { domain, id, kind, variant, revisionId, templateSha256, source };
}

function identityKey(identity: PromptIdentity): string {
	return `${identity.domain}/${identity.id}/${identity.kind}/${identity.variant}`;
}

function sameIdentity(left: PromptIdentity, right: PromptIdentity): boolean {
	return left.domain === right.domain && left.id === right.id && left.kind === right.kind && left.variant === right.variant;
}

function deduplicateIdentities(values: PromptRevisionIdentity[]): PromptRevisionIdentity[] {
	return [...new Map(values.map((value) => [`${identityKey(value)}:${value.revisionId}`, value])).values()];
}

function validateRevisionId(value: unknown, allowDefault: boolean): string {
	if (allowDefault && value === "default") return value;
	if (typeof value !== "string" || !SAFE_REVISION.test(value)) throw new Error("Invalid Prompt revision id");
	return value;
}

function validateTemplate(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("template must be non-empty text");
	if (value.length > MAX_TEMPLATE_CHARACTERS) throw new Error(`template exceeds ${MAX_TEMPLATE_CHARACTERS} characters`);
	if (value.includes("\0")) throw new Error("template contains a NUL byte");
	try {
		nunjucksParser.parse(value);
	} catch (error) {
		throw new Error(`Invalid Nunjucks template: ${toErrorMessage(error)}`);
	}
	return value;
}


function resolveInside(root: string, value: string): string {
	const path = resolve(root, value);
	const rel = relative(root, path);
	if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return path;
	throw new Error(`Prompt path escapes '${root}': ${value}`);
}

function parseAgentPromptConfig(value: unknown, expectedId: string, source: string): AgentPromptConfig {
	const record = requireRecord(value, source);
	assertExactKeys(record, ["schema_version", "id", "skills", "prompts", "sandbox"], source);
	if (record.schema_version !== 2) throw new Error(`${source} schema_version must be 2`);
	if (record.id !== expectedId) throw new Error(`${source} id must be '${expectedId}'`);
	const prompts = requireRecord(record.prompts, `${source} prompts`);
	assertExactKeys(prompts, [...PROMPT_KINDS], `${source} prompts`);
	const parsedPrompts = Object.fromEntries(PROMPT_KINDS.flatMap((kind) => {
		const variants = parsePromptVariants(prompts[kind], source, kind);
		return variants ? [[kind, variants]] : [];
	})) as AgentPromptConfig["prompts"];
	if (Object.keys(parsedPrompts).length === 0) throw new Error(`${source} must declare at least one Prompt template`);
	const skills = record.skills === undefined ? undefined : parseSkills(record.skills, source);
	const sandbox = record.sandbox === undefined ? undefined : parseSandbox(record.sandbox, source);
	return { schemaVersion: 2, id: expectedId,
		...(skills ? { skills } : {}),
		prompts: parsedPrompts,
		...(sandbox ? { sandbox } : {}) };
}

function parsePromptVariants(
	value: unknown,
	source: string,
	field: PromptKind,
): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	const variants = requireRecord(value, `${source} prompts.${field}`);
	const parsed = Object.fromEntries(Object.entries(variants).map(([variant, template]) => {
		if (!SAFE_SEGMENT.test(variant)) throw new Error(`${source} has invalid ${field} Prompt variant '${variant}'`);
		return [variant, requireTemplateName(template, `${source} prompts.${field}.${variant}`)];
	}));
	if (Object.keys(parsed).length === 0) throw new Error(`${source} prompts.${field} cannot be empty`);
	return parsed;
}

function parseSkills(value: unknown, source: string): string[] {
	if (!Array.isArray(value) || value.length === 0
		|| !value.every((skill) => typeof skill === "string" && SAFE_SKILL_REF.test(skill))) {
		throw new Error(`${source} skills must be a non-empty array of local or agent-qualified Skill names`);
	}
	const skills = value as string[];
	if (new Set(skills).size !== skills.length) throw new Error(`${source} skills must not contain duplicates`);
	return skills;
}

function parseSandbox(value: unknown, source: string): AgentPromptSandboxConfig {
	const record = requireRecord(value, `${source} sandbox`);
	assertExactKeys(record, ["role", "execution_profile", "network", "tools"], `${source} sandbox`);
	const role = requireString(record.role, `${source} sandbox.role`);
	const network = requireString(record.network, `${source} sandbox.network`) as PromptNetworkMode;
	if (!NETWORK_MODES.has(network)) throw new Error(`${source} sandbox.network must be deny or allow`);
	const executionProfile = record.execution_profile === undefined ? undefined
		: requireString(record.execution_profile, `${source} sandbox.execution_profile`) as PromptExecutionProfile;
	if (executionProfile && !EXECUTION_PROFILES.has(executionProfile)) {
		throw new Error(`${source} sandbox.execution_profile must be bash_only, pi_builtin, or prime_ipython`);
	}
	if (!Array.isArray(record.tools) || !record.tools.every((tool) => typeof tool === "string" && tool.trim())) {
		throw new Error(`${source} sandbox.tools must be a string array`);
	}
	const tools = [...new Set(record.tools as string[])];
	return { role, network, tools, ...(executionProfile ? { executionProfile } : {}) };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function requireBoundedString(value: unknown, label: string, maximum: number): string {
	const text = requireString(value, label);
	if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
	return text;
}

function requireTemplateName(value: unknown, label: string): string {
	const name = requireString(value, label);
	if (basename(name) !== name || !SAFE_TEMPLATE.test(name)) throw new Error(`${label} must name one local .njk file`);
	return name;
}

function assertExactKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

