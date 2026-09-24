export const PRIME_SEARCH_AGENT_ID = "prime-search";
export const RESEARCH_AGENT_IDS = [
	PRIME_SEARCH_AGENT_ID,
	"cornell-note",
	"report-writer",
] as const;
export type ResearchWorkspaceAgentId = (typeof RESEARCH_AGENT_IDS)[number];
export const WIKI_AGENT_IDS = ["wiki-shard-builder", "wiki-curator"] as const;
export type WikiWorkspaceAgentId = (typeof WIKI_AGENT_IDS)[number];
export const WORKSPACE_AGENT_IDS = [
	"main-agent",
	"podcast-writer",
	...RESEARCH_AGENT_IDS,
	...WIKI_AGENT_IDS,
] as const;
export type WorkspaceAgentId = (typeof WORKSPACE_AGENT_IDS)[number];

export function agentSkillRoot(agentId: string): string {
	return `skills/${agentId}`;
}
