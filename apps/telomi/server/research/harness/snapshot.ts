import { join } from "node:path";

import { hashJson, sha256 } from "../../lib/hash.js";
import { RESEARCH_AGENT_IDS, agentSkillRoot, type ResearchWorkspaceAgentId } from "../../workspaces/agent-layout.js";
import { snapshotSkills, type SkillSnapshot } from "../../agent-runtime/skill-registry.js";
import {
	defaultPrimeSearchHarnessYaml,
	parsePrimeSearchHarnessAsset,
	type PrimeSearchHarnessSnapshot,
} from "./prime-search.js";
import { defaultResearchRunPolicyYaml, parseResearchRunPolicy, type ResearchRunPolicy } from "./run-policy.js";

export const RESEARCH_HARNESS_CONTRACT_VERSION = 2;

export interface ResearchHarnessSnapshot {
	schemaVersion: 2;
	contractVersion: typeof RESEARCH_HARNESS_CONTRACT_VERSION;
	workspaceDir: string;
	snapshotHash: string;
	source: "builtin";
	runPolicy: ResearchRunPolicy;
	runPolicyHash: string;
	primeSearch: PrimeSearchHarnessSnapshot;
	agentSkills: Record<ResearchWorkspaceAgentId, ResearchAgentSkillSnapshot>;
}

export interface ResearchAgentSkillSnapshot {
	skills: SkillSnapshot[];
}

/** Server-owned Harness plus Goal-scoped Skill content. No Goal Git identity participates. */
export function loadResearchHarnessSnapshot(goalDir: string): ResearchHarnessSnapshot {
	const runPolicyText = defaultResearchRunPolicyYaml();
	const runPolicy = parseResearchRunPolicy(runPolicyText, "builtin:research-run-policy");
	const primeSearchText = defaultPrimeSearchHarnessYaml();
	const primeSearchPolicy = parsePrimeSearchHarnessAsset(primeSearchText, "builtin:prime-search-policy");
	const primeSearch: PrimeSearchHarnessSnapshot = {
		schemaVersion: 1,
		source: "builtin",
		policyHash: sha256(primeSearchText),
		policy: primeSearchPolicy,
		snapshotHash: hashJson({ contractVersion: RESEARCH_HARNESS_CONTRACT_VERSION, policy: primeSearchPolicy }),
	};
	const agentSkills = Object.fromEntries(RESEARCH_AGENT_IDS.map((agentId) => [agentId, {
		skills: snapshotSkills([join(goalDir, agentSkillRoot(agentId))]).skills,
	}])) as Record<ResearchWorkspaceAgentId, ResearchAgentSkillSnapshot>;
	const runPolicyHash = sha256(runPolicyText);
	return {
		schemaVersion: 2,
		contractVersion: RESEARCH_HARNESS_CONTRACT_VERSION,
		workspaceDir: goalDir,
		source: "builtin",
		runPolicy,
		runPolicyHash,
		primeSearch,
		agentSkills,
		snapshotHash: hashJson({
			contractVersion: RESEARCH_HARNESS_CONTRACT_VERSION,
			runPolicyHash,
			primeSearchHash: primeSearch.snapshotHash,
			agentSkills: Object.fromEntries(RESEARCH_AGENT_IDS.map((agentId) => [agentId,
				agentSkills[agentId].skills.map((skill) => skill.sha256)])),
		}),
	};
}
