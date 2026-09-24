import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { materializePrimeSources, reuseInterruptedStage } from "../../server/research/pipeline/index.js";

const request = { availableProviderIds: ["browser", "github"], sequence: 1 };

/** One Provider child that committed its Candidate Ledger inside its own execution workspace. */
function writeProviderExecution(root: string, providerId: string) {
	const childId = `sub-${providerId}`;
	const workspacePath = `provider-executions/${childId}`;
	const work = join(root, workspacePath, "work");
	mkdirSync(join(work, "materials", providerId, "page"), { recursive: true });
	writeFileSync(join(work, "materials", providerId, "page", "document.md"), `# ${providerId}\n`);
	writeFileSync(join(work, ".provider-assignment"), `${providerId}\n`);
	writeFileSync(join(work, `${providerId}_candidates.json`), JSON.stringify({ candidates: [{
		title: `${providerId} page`,
		url: `https://example.com/${providerId}`,
		query: providerId,
		summary: `Evidence from ${providerId}.`,
		metadata: {},
		material_paths: [`work/materials/${providerId}/page`],
	}] }));
	return { execution_id: `provider-execution:1:${providerId}:${childId}`, provider_id: providerId, workspace_path: workspacePath };
}

function withStage(name: string, run: (stageRoot: string, root: string) => void): void {
	const parent = mkdtempSync(join(tmpdir(), `pi-prime-stage-${name}-`));
	const stageRoot = join(parent, "search-batch-1");
	const root = join(stageRoot, "agent");
	mkdirSync(join(root, "work"), { recursive: true });
	try {
		run(stageRoot, root);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}

// Acquisition finished before the Run stopped: resume reuses the sources instead of searching again.
withStage("completed", (stageRoot, root) => {
	materializePrimeSources(root, [writeProviderExecution(root, "browser"), writeProviderExecution(root, "github")]);
	writeFileSync(join(root, "draft.py"), "print('scratch')\n");
	const reuse = reuseInterruptedStage(stageRoot, root, request);
	assert.equal(reuse.archivedPath, undefined, "a completed acquisition must not be archived");
	assert.deepEqual(reuse.sources?.map((source) => source.provider_id).sort(), ["browser", "github"]);
	assert.ok(existsSync(join(root, "provider-executions", "sub-github", "work", "github_candidates.json")),
		"committed Provider ledgers are part of the stage contract");
	assert.equal(existsSync(join(root, "draft.py")), false, "Agent drafts outside the contract are still cleared");
});

// Ledgers were committed but the Run stopped before sources were materialized: resume materializes them.
withStage("ledgers-only", (stageRoot, root) => {
	writeProviderExecution(root, "browser");
	writeProviderExecution(root, "github");
	const reuse = reuseInterruptedStage(stageRoot, root, request);
	assert.equal(reuse.archivedPath, undefined);
	assert.equal(reuse.sources?.length, 2);
	assert.ok(existsSync(join(root, "source", ".complete")));
});

// Nothing was committed: the scene is archived and acquisition starts over.
withStage("uncommitted", (stageRoot, root) => {
	writeFileSync(join(root, "draft.py"), "print('scratch')\n");
	const reuse = reuseInterruptedStage(stageRoot, root, request);
	assert.equal(reuse.sources, undefined);
	assert.equal(reuse.archivedPath, `${stageRoot}.interrupted`);
	assert.ok(existsSync(`${stageRoot}.interrupted`));
	assert.equal(existsSync(stageRoot), false);
});
