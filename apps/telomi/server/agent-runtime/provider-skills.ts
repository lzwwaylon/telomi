import { bundledAgentSkillPath, snapshotSkills } from "./skill-registry.js";

/** Goal Skills by name. A Goal Skill named after a bundled Provider worker Skill fully overrides it. */
export function goalPrimeSearchSkills(goalSkillRoot: string): Map<string, string> {
	return new Map(snapshotSkills([goalSkillRoot]).skills.map((skill) => [skill.name, skill.sourcePath]));
}

/** Effective Provider worker Skills: the bundled defaults, each replaced by a same-name Goal Skill when present. */
export function effectiveProviderWorkerSkills(
	sources: readonly { id: string; workerSkills?: readonly string[] }[],
	goalSkills: ReadonlyMap<string, string> = new Map(),
): Record<string, string[]> {
	return Object.fromEntries(sources.map((source) => {
		if (!source.workerSkills?.length) {
			throw new Error(`Provider '${source.id}' must declare at least one bundled worker Skill`);
		}
		return [source.id, source.workerSkills.map((skill) =>
			goalSkills.get(skill) ?? bundledAgentSkillPath("research", "prime-search", skill))];
	}));
}
