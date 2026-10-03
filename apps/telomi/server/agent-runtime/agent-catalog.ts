import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PromptRegistry, type PromptDomain } from "./prompt-registry.js";

/** Output/view contracts, independent of Agent names and identities. */
export const AGENT_PRESENTATION_KINDS = [
	"source-search", "provider-child", "note", "investigation", "report", "wiki", "evolution", "chat", "generic",
] as const;
export const REPLAY_PROMPT_MODES = ["candidate", "observed", "override"] as const;
export const PROMPT_OVERRIDE_FIELDS = ["systemPrompt", "userPrompt"] as const;

export interface AgentDescriptor {
	id: string;
	displayName: string;
	/** Repository-relative owning Bundle directory, or null for a non-Bundle boundary. */
	sourcePath: string | null;
	presentationKind: typeof AGENT_PRESENTATION_KINDS[number];
	/** Runtime dependency prefixes used by downstream change-impact analysis. */
	impactPaths?: string[];
	replayPromptModes?: Array<typeof REPLAY_PROMPT_MODES[number]>;
	promptOverrideFields?: Array<typeof PROMPT_OVERRIDE_FIELDS[number]>;
}

interface AgentRegistration {
	domain?: PromptDomain;
	bundle?: string;
	presentationKind: AgentDescriptor["presentationKind"];
	/** Only orchestration boundaries without their own Bundle have a separate name. */
	displayName?: string;
	impactPaths?: string[];
	replayPromptModes?: AgentDescriptor["replayPromptModes"];
	promptOverrideFields?: AgentDescriptor["promptOverrideFields"];
}

// The product owns Replay identities and their output contracts. OPS consumes this
// catalog rather than maintaining a second Agent name, source path or renderer map.
const AGENTS: Record<string, AgentRegistration> = {
	"main-agent": { domain: "main", bundle: "main-agent", presentationKind: "chat", replayPromptModes: [...REPLAY_PROMPT_MODES], promptOverrideFields: [...PROMPT_OVERRIDE_FIELDS], impactPaths: ["apps/telomi/server/main-agent/"] },
	"prime-search": { domain: "research", bundle: "prime-search", presentationKind: "source-search", replayPromptModes: ["candidate", "override"], promptOverrideFields: ["userPrompt"], impactPaths: ["apps/telomi/server/research/prime/", "apps/telomi/server/research/external-search.ts"] },
	"prime-investigation": { domain: "research", bundle: "prime-search", displayName: "Investigate Root", presentationKind: "investigation", replayPromptModes: [...REPLAY_PROMPT_MODES], promptOverrideFields: ["userPrompt"], impactPaths: ["apps/telomi/server/research/investigate.ts", "apps/telomi/server/research/investigation-"] },
	"provider-child": { displayName: "Source Agent", presentationKind: "provider-child", impactPaths: ["apps/telomi/server/providers/", "apps/telomi/services/research-source-service/", "apps/telomi/server/research/python-tools/", "apps/telomi/server/research/prime/", "apps/telomi/agents/research/prime-search/"] },
	"note-agent": { domain: "research", bundle: "note-agent", presentationKind: "note", replayPromptModes: [...REPLAY_PROMPT_MODES], promptOverrideFields: [...PROMPT_OVERRIDE_FIELDS], impactPaths: ["apps/telomi/server/research/note-", "apps/telomi/server/research/pipeline/note-", "apps/telomi/server/research/pipeline/prime-note-agent"] },
	"report-writer": { domain: "research", bundle: "report-writer", presentationKind: "report", replayPromptModes: [...REPLAY_PROMPT_MODES], promptOverrideFields: [...PROMPT_OVERRIDE_FIELDS], impactPaths: ["apps/telomi/server/research/pipeline/report-", "apps/telomi/server/research/pipeline/prime-report-writer.ts", "apps/telomi/server/research/investigation-answer.ts"] },
	"podcast-writer": { domain: "main", bundle: "podcast-writer", presentationKind: "generic", impactPaths: ["apps/telomi/server/media/podcast/"] },
	"schedule-reviewer": { domain: "research", bundle: "schedule-reviewer", presentationKind: "generic", impactPaths: ["apps/telomi/server/research/schedules/"] },
	"wiki-compilation": { domain: "wiki", bundle: "wiki-compilation", presentationKind: "wiki", impactPaths: ["apps/telomi/server/wiki/"] },
	"wiki-shard-builder": { domain: "wiki", bundle: "wiki-shard-builder", presentationKind: "wiki", impactPaths: ["apps/telomi/server/wiki/"] },
	"wiki-curator": { domain: "wiki", bundle: "wiki-curator", presentationKind: "wiki", impactPaths: ["apps/telomi/server/wiki/"] },
	"evolution": { domain: "evolution", bundle: "browser-skill-evolution", presentationKind: "evolution", impactPaths: ["apps/telomi/server/evolution/"] },
};

const APPLICATION_DIR = fileURLToPath(new URL("../../", import.meta.url));

export function describeEvaluationAgent(id: string, applicationDir = APPLICATION_DIR): AgentDescriptor {
	const registration = AGENTS[id];
	const sourcePath = registration?.domain && registration.bundle
		? `apps/telomi/agents/${registration.domain}/${registration.bundle}` : null;
	const configPath = registration?.domain && registration.bundle
		? join(applicationDir, "agents", registration.domain, registration.bundle, "agent.yaml") : undefined;
	const bundleName = configPath && existsSync(configPath)
		? new PromptRegistry({ agentRoot: join(applicationDir, "agents") })
			.loadConfig(registration!.domain!, registration!.bundle!).displayName : undefined;
	return { id, displayName: registration?.displayName ?? bundleName ?? id, sourcePath,
		presentationKind: registration?.presentationKind ?? "generic",
		...agentReplayCapabilities(id),
		...(registration ? { impactPaths: [...new Set([...(sourcePath ? [`${sourcePath}/`] : []), ...(registration.impactPaths ?? []),
			...(registration.domain === "research" ? ["apps/telomi/server/research/"] : []),
			"apps/telomi/server/agent-runtime/", "apps/telomi/server/evaluation/", "apps/telomi/server/providers/", "apps/telomi/services/research-source-service/",
			"apps/telomi/server/cornell/", "apps/telomi/server/citations/", "apps/telomi/server/embedding/",
			"apps/telomi/server/media/product-"])] } : {}) };
}

export function registeredEvaluationAgentIds(): string[] {
	return Object.keys(AGENTS).sort();
}

/** Shared with Replay admission; the UI catalog and executable capabilities cannot diverge. */
export function agentReplayCapabilities(id: string): Required<Pick<AgentDescriptor, "replayPromptModes" | "promptOverrideFields">> {
	return { replayPromptModes: [...(AGENTS[id]?.replayPromptModes ?? ["candidate"])],
		promptOverrideFields: [...(AGENTS[id]?.promptOverrideFields ?? [])] };
}

export function evaluationAgentCatalog(ids: readonly string[], applicationDir = APPLICATION_DIR): AgentDescriptor[] {
	return [...new Set(ids)].sort().map((id) => describeEvaluationAgent(id, applicationDir));
}

/** Validate captured/imported metadata without consulting the current Bundle. */
export function assertAgentDescriptor(value: unknown, expectedId: string): asserts value is AgentDescriptor {
	const agent = value as Partial<AgentDescriptor> | null;
	if (!agent || agent.id !== expectedId || typeof agent.displayName !== "string" || !agent.displayName.trim()
		|| !AGENT_PRESENTATION_KINDS.includes(agent.presentationKind!)
		|| (agent.sourcePath !== null && (typeof agent.sourcePath !== "string"
			|| !/^apps\/telomi\/agents\/[a-z0-9-]+\/[a-z0-9-]+$/u.test(agent.sourcePath)))
		|| (agent.impactPaths !== undefined && (!Array.isArray(agent.impactPaths)
			|| !agent.impactPaths.every((path) => typeof path === "string" && path.startsWith("apps/telomi/")
				&& !path.includes("..") && !path.includes("\\"))))
		|| (agent.replayPromptModes !== undefined && (!Array.isArray(agent.replayPromptModes)
			|| !agent.replayPromptModes.every((mode) => REPLAY_PROMPT_MODES.includes(mode))))
		|| (agent.promptOverrideFields !== undefined && (!Array.isArray(agent.promptOverrideFields)
			|| !agent.promptOverrideFields.every((field) => PROMPT_OVERRIDE_FIELDS.includes(field))))) {
		throw new Error(`Invalid Agent descriptor for '${expectedId}'`);
	}
}
