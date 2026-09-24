import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { ResearchRuntimeConfig } from "../research-types.js";
import { toErrorMessage } from "../../lib/values.js";

export const RESEARCH_RUN_POLICY_KIND = "pi_research_run_policy";

const CONFIG_KEYS = [
	"documentConcurrency",
] as const satisfies readonly (keyof ResearchRuntimeConfig)[];

export interface ResearchRunPolicy {
	kind: typeof RESEARCH_RUN_POLICY_KIND;
	contract_version: 1;
	id: string;
	version: number;
	configOverrides: Partial<ResearchRuntimeConfig>;
}

export const DEFAULT_RESEARCH_RUN_POLICY: ResearchRunPolicy = {
	kind: RESEARCH_RUN_POLICY_KIND,
	contract_version: 1,
	id: "default-research-run-policy",
	version: 1,
	configOverrides: {},
};

export function defaultResearchRunPolicyYaml(): string {
	return stringifyYaml({
		kind: RESEARCH_RUN_POLICY_KIND,
		contract_version: 1,
		id: DEFAULT_RESEARCH_RUN_POLICY.id,
		version: 1,
		config: {},
	}, { lineWidth: 0 });
}

export function parseResearchRunPolicy(text: string, source = "run-policy.yaml"): ResearchRunPolicy {
	let value: unknown;
	try { value = parseYaml(text); } catch (error) {
		throw new Error(`${source} is not valid YAML: ${toErrorMessage(error)}`);
	}
	const record = requireRecord(value, source);
	if (record.kind !== RESEARCH_RUN_POLICY_KIND) throw new Error(`${source}.kind must be '${RESEARCH_RUN_POLICY_KIND}'`);
	if (record.contract_version !== 1) throw new Error(`${source}.contract_version must be 1`);
	const id = requireIdentifier(record.id, `${source}.id`);
	if (!Number.isInteger(record.version) || Number(record.version) < 1) throw new Error(`${source}.version must be a positive integer`);
	const configRecord = requireRecord(record.config, `${source}.config`);
	const allowedConfig = new Set<string>(CONFIG_KEYS);
	for (const key of Object.keys(configRecord)) {
		if (!allowedConfig.has(key)) {
			throw new Error(`${source}.config.${key} is not an evolvable Runtime setting`);
		}
	}
	const configOverrides: Partial<ResearchRuntimeConfig> = {};
	for (const key of CONFIG_KEYS) {
		if (!(key in configRecord)) continue;
		const raw = configRecord[key];
		if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 32) {
			throw new Error(`${source}.config.${key} must be an integer from 1 to 32`);
		}
		(configOverrides as Record<string, unknown>)[key] = raw;
	}
	return { kind: RESEARCH_RUN_POLICY_KIND, contract_version: 1, id, version: Number(record.version), configOverrides };
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function requireIdentifier(value: unknown, path: string): string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error(`${path} is invalid`);
	return value;
}
