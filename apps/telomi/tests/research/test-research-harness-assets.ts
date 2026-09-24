import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { RESEARCH_AGENT_IDS, WORKSPACE_AGENT_IDS } from "../../server/workspaces/agent-layout.js";
import { loadResearchHarnessSnapshot, RESEARCH_HARNESS_CONTRACT_VERSION } from "../../server/research/harness/snapshot.js";
import { snapshotSkills } from "../../server/agent-runtime/skill-registry.js";

const root = mkdtempSync(join(tmpdir(), "telomi-research-harness-assets-"));
try {
	const goalDir = join(root, "goal");
	const created = ensureGoalWorkspace({ goalDir, goalId: "goal-test", title: "Test" });
	assert.equal(created.filesCreated.includes("wiki/manifest.yaml"), true);
	assert.equal(existsSync(join(goalDir, ".git")), false, "Goal Workspace must not initialize Git");
	assert.equal(existsSync(join(goalDir, "contracts", "research")), false,
		"server-owned Harness contracts must not be copied into the Goal");
	for (const agentId of WORKSPACE_AGENT_IDS) assert.equal(existsSync(join(goalDir, "skills", agentId)), true);

	const first = loadResearchHarnessSnapshot(goalDir);
	assert.equal(first.schemaVersion, 2);
	assert.equal(first.contractVersion, RESEARCH_HARNESS_CONTRACT_VERSION);
	assert.equal(first.source, "builtin");
	assert.equal(first.runPolicy.id, "default-research-run-policy");
	assert.equal(first.primeSearch.policy.id, "default-prime-search");
	assert.deepEqual(Object.keys(first.agentSkills), [...RESEARCH_AGENT_IDS]);

	const skillRoot = join(goalDir, "skills", "prime-search", "lab-coverage");
	mkdirSync(join(skillRoot, "references"), { recursive: true });
	writeFileSync(join(skillRoot, "SKILL.md"),
		"---\nname: lab-coverage\ndescription: Prefer official laboratory coverage.\n---\n");
	writeFileSync(join(skillRoot, "references", "policy.md"), "version one\n");
	const specialized = loadResearchHarnessSnapshot(goalDir);
	assert.notEqual(specialized.snapshotHash, first.snapshotHash);
	const skillHash = specialized.agentSkills["prime-search"].skills[0]!.sha256;
	writeFileSync(join(skillRoot, "references", "policy.md"), "version two\n");
	const changed = loadResearchHarnessSnapshot(goalDir);
	assert.notEqual(changed.agentSkills["prime-search"].skills[0]!.sha256, skillHash,
		"every Skill support file must participate in content identity");

	const invalid = join(goalDir, "skills", "prime-search", "missing-description");
	mkdirSync(invalid, { recursive: true });
	writeFileSync(join(invalid, "SKILL.md"), "---\nname: missing-description\n---\n");
	assert.throws(() => snapshotSkills([join(goalDir, "skills", "prime-search")]),
		/requires valid name and description frontmatter/u);

	console.log("Research Harness builtin content snapshot tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
