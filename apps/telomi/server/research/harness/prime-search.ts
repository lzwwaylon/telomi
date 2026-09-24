import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { toErrorMessage } from "../../lib/values.js";

export const PRIME_SEARCH_POLICY_KIND = "pi_prime_search_harness";
export const GENERAL_WEB_BACKENDS = ["firecrawl", "tavily", "exa"] as const;
export type GeneralWebBackend = typeof GENERAL_WEB_BACKENDS[number];

export interface PrimeSearchHarnessAsset {
	kind: typeof PRIME_SEARCH_POLICY_KIND;
	contractVersion: 1;
	id: string;
	version: number;
	allowedSources: string[];
	generalWebBackend: GeneralWebBackend;
}

export interface PrimeSearchHarnessSnapshot {
	schemaVersion: 1;
	source: "builtin" | "goal_branch";
	policyPath?: string;
	policyHash: string;
	policy: PrimeSearchHarnessAsset;
	snapshotHash: string;
}

export const DEFAULT_PRIME_SEARCH_ASSET: PrimeSearchHarnessAsset = {
	kind: PRIME_SEARCH_POLICY_KIND,
	contractVersion: 1,
	id: "default-prime-search",
	version: 16,
	allowedSources: ["*"],
	generalWebBackend: "firecrawl",
};

export function defaultPrimeSearchHarnessYaml(): string {
	return stringifyYaml({
		kind: DEFAULT_PRIME_SEARCH_ASSET.kind,
		contract_version: DEFAULT_PRIME_SEARCH_ASSET.contractVersion,
		id: DEFAULT_PRIME_SEARCH_ASSET.id,
		version: DEFAULT_PRIME_SEARCH_ASSET.version,
		sources: {
			allowed: DEFAULT_PRIME_SEARCH_ASSET.allowedSources,
			general_web_backend: DEFAULT_PRIME_SEARCH_ASSET.generalWebBackend,
		},
	}, { lineWidth: 0 });
}

export function parsePrimeSearchHarnessAsset(text: string, source = "prime-search.yaml"): PrimeSearchHarnessAsset {
	let value: unknown;
	try { value = parseYaml(text); } catch (error) {
		throw new Error(`${source} is not valid YAML: ${toErrorMessage(error)}`);
	}
	const record = requireRecord(value, source);
	if (record.kind !== PRIME_SEARCH_POLICY_KIND) throw new Error(`${source}.kind must be '${PRIME_SEARCH_POLICY_KIND}'`);
	if (record.contract_version !== 1) throw new Error(`${source}.contract_version must be 1`);
	const id = requireIdentifier(record.id, `${source}.id`);
	const version = requireInteger(record.version, `${source}.version`, 1, 1_000_000);
	for (const key of Object.keys(record)) {
		if (!["kind", "contract_version", "id", "version", "sources"].includes(key)) {
			throw new Error(`${source} contains unknown field '${key}'`);
		}
	}
	const sources = requireRecord(record.sources, `${source}.sources`);
	for (const key of Object.keys(sources)) {
		if (!["allowed", "general_web_backend"].includes(key)) {
			throw new Error(`${source}.sources contains unknown field '${key}'`);
		}
	}
	const allowedSources = requireStringArray(sources.allowed, `${source}.sources.allowed`, 1, 128)
		.map((item) => item === "*" ? item : requireIdentifier(item, `${source}.sources.allowed`));
	const generalWebBackend = parseGeneralWebBackend(sources.general_web_backend,
		`${source}.sources.general_web_backend`);
	return {
		kind: PRIME_SEARCH_POLICY_KIND,
		contractVersion: 1,
		id,
		version,
		allowedSources: [...new Set(allowedSources)],
		generalWebBackend,
	};
}

function parseGeneralWebBackend(value: unknown, path: string): GeneralWebBackend {
	if (typeof value !== "string" || !GENERAL_WEB_BACKENDS.includes(value as GeneralWebBackend)) {
		throw new Error(`${path} must be one of ${GENERAL_WEB_BACKENDS.join(", ")}`);
	}
	return value as GeneralWebBackend;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function requireStringArray(value: unknown, path: string, min: number, max: number): string[] {
	if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${path} must contain ${min} to ${max} strings`);
	return value.map((item, index) => {
		if (typeof item !== "string" || !item.trim() || item.length > 2_000) throw new Error(`${path}[${index}] must be a non-empty string`);
		return item.trim();
	});
}

function requireIdentifier(value: unknown, path: string): string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error(`${path} is invalid`);
	return value;
}

function requireInteger(value: unknown, path: string, min: number, max: number): number {
	if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${path} must be an integer from ${min} to ${max}`);
	return Number(value);
}
