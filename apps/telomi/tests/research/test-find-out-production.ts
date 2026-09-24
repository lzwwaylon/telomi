import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadFindOutSources, materializeFindOutSources } from "../../server/research/pipeline/index.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";

const root = mkdtempSync(join(tmpdir(), "telomi-find-out-"));
const inputs = join(root, "inputs");
const store = new RunArtifactStore(join(root, "run"));
const members = [
	source("arxiv:paper", "source:paper", "arxiv", "Paper", "https://arxiv.org/abs/1", "unchanged"),
	source("github:repo", "source:repo", "github", "Repository", "https://github.com/example/repo", "new"),
	source("huggingface:model", "source:model", "huggingface", "Other model", "https://huggingface.co/example/model", "new"),
];
const result = materializeFindOutSources({
	artifactStore: store,
	sequence: 1,
	workingDirectory: root,
	organization: {
		groups: [{ id: "project", title: "Project", members: ["arxiv:paper", "github:repo"], evidence: "Same project." }],
		ungrouped: [{ candidate_id: "huggingface:model", reason: "No verified cross-provider match." }],
	},
	members,
});
assert.equal(result.sources.length, 2);
assert.equal(result.sources[0]?.providerId, "cross_provider");
assert.equal(result.sources[0]?.groupId, "project");
assert.equal(result.sources[0]?.members.length, 2);
assert.deepEqual(result.sources[0]?.updateContext, {
	newMemberPaths: ["members/github/github-repo"],
	changedMemberPaths: [],
});
assert.equal(result.sources[1]?.updateContext, undefined, "an entirely new Source needs no update hint");
assert.deepEqual(loadFindOutSources(result.artifact).map((source) => source.id), result.sources.map((source) => source.id));
assert.equal(loadFindOutSources(result.artifact)[0]?.groupId, "project");
const repeated = materializeFindOutSources({
	artifactStore: store,
	sequence: 2,
	workingDirectory: join(root, "second"),
	organization: {
		groups: [{ id: "project", title: "Project", members: ["github:repo", "arxiv:paper"], evidence: "Same project." }],
		ungrouped: [{ candidate_id: "huggingface:model", reason: "No verified cross-provider match." }],
	},
	members,
});
assert.equal(repeated.sources.find((source) => source.groupId === "project")?.id, result.sources[0]?.id);
const manifestPath = join(result.artifact.absolutePath, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
manifest.sources[0].members = [];
writeFileSync(manifestPath, JSON.stringify(manifest));
assert.throws(() => loadFindOutSources(result.artifact), /sources\[0\] is invalid/u);
console.log("cross-provider Find Out production checks passed");

function source(
	candidateId: string,
	sourceId: string,
	providerId: string,
	title: string,
	url: string,
	changeKind: "new" | "changed" | "unchanged",
) {
	const sourceDirectory = join(inputs, providerId);
	mkdirSync(sourceDirectory, { recursive: true });
	writeFileSync(join(sourceDirectory, "README.md"), `# ${title}\n\nEvidence.\n`);
	return {
		candidateId,
		sourceId,
		providerId,
		title,
		url,
		summary: `${title} summary`,
		sourceDirectory,
		changeKind,
	};
}
