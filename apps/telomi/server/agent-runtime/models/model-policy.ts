import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface ResearchModelPolicy {
	preferred: readonly string[];
	fallback?: readonly string[];
	reasoning?: ModelThinkingLevel;
	/** Optional output ceiling. Omit it to use the selected model's native maximum. */
	maxTokens?: number;
	/** Model calls inherit caller cancellation. Do not add wall-clock timeout policy here. */
	maxRetries?: number;
	maxRetryDelayMs?: number;
}

export function parseResearchModelRef(value: string): { provider: string; modelId: string } {
	const normalized = value.trim();
	const slash = normalized.indexOf("/");
	if (slash <= 0 || slash === normalized.length - 1) {
		throw new Error(`research model reference must be '<provider>/<model>': ${value}`);
	}
	return { provider: normalized.slice(0, slash), modelId: normalized.slice(slash + 1) };
}

export function researchModelCandidates(policy: ResearchModelPolicy): string[] {
	const values = [...policy.preferred, ...(policy.fallback ?? [])].map((value) => value.trim()).filter(Boolean);
	const unique = [...new Set(values)];
	if (unique.length === 0) throw new Error("research model policy requires at least one preferred model");
	for (const value of unique) parseResearchModelRef(value);
	return unique;
}
