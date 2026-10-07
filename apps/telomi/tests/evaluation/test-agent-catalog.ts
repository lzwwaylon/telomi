import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentReplayCapabilities, assertAgentDescriptor, describeEvaluationAgent, evaluationAgentCatalog, registeredEvaluationAgentIds } from "../../server/agent-runtime/agent-catalog.js";
import { OPERATIONS_SCHEMA_HASH, validateOperations } from "../../server/evaluation/operations-contract.js";

const root = mkdtempSync(join(tmpdir(), "telomi-agent-catalog-"));
const bundle = join(root, "agents", "research", "note-agent");
mkdirSync(bundle, { recursive: true });
function config(displayName: string): void {
	writeFileSync(join(bundle, "agent.yaml"), `schema_version: 2\nid: note-agent\ndisplay_name: ${displayName}\nprompts:\n  system:\n    default: system.md.njk\n`);
}
try {
	config("Note Agent");
	const before = describeEvaluationAgent("note-agent", root);
	assert.equal(before.displayName, "Note Agent");
	assert.equal(before.sourcePath, "apps/telomi/agents/research/note-agent");
	assert.equal(before.presentationKind, "note");
	assert.deepEqual(before.replayPromptModes, ["candidate", "observed", "override"]);
	assert.deepEqual(agentReplayCapabilities("prime-search"), { replayPromptModes: ["candidate", "override"], promptOverrideFields: ["userPrompt"] });
	assert.deepEqual(agentReplayCapabilities("new-product-agent"), { replayPromptModes: ["candidate"], promptOverrideFields: [] });
	assert.ok(before.impactPaths?.includes(`${before.sourcePath}/`));
	// Agents whose runs call the Wiki read Tools, plus the compiler that owns the directory.
	const wikiReaders = ["main-agent", "prime-investigation", "report-writer", "schedule-reviewer", "wiki-compilation"];
	for (const id of registeredEvaluationAgentIds()) {
		assert.equal(describeEvaluationAgent(id, root).impactPaths?.includes("apps/telomi/server/wiki/"), wikiReaders.includes(id), id);
	}
	const hash = OPERATIONS_SCHEMA_HASH;
	config("Source Reader");
	const catalog = evaluationAgentCatalog(["note-agent", "note-agent", "new-product-agent"], root);
	assert.equal(catalog.length, 2);
	assert.equal(catalog.find((agent) => agent.id === "note-agent")?.displayName, "Source Reader");
	assert.equal(before.displayName, "Note Agent", "A captured descriptor is a factual snapshot, not a mutable name lookup");
	validateOperations("AgentCatalogResponse", { ok: true, agents: catalog });
	assert.equal(OPERATIONS_SCHEMA_HASH, hash, "Changing product names/IDs must not change the Operations DTO schema");
	assert.equal(catalog.find((agent) => agent.id === "new-product-agent")?.presentationKind, "generic");
	assertAgentDescriptor(before, "note-agent");
	assert.throws(() => assertAgentDescriptor(before, "another-agent"), /Invalid Agent descriptor/u);
	assert.throws(() => assertAgentDescriptor({ ...before, sourcePath: "../../outside" }, "note-agent"), /Invalid Agent descriptor/u);
	assert.throws(() => assertAgentDescriptor({ ...before, impactPaths: ["apps/telomi/../../outside"] }, "note-agent"), /Invalid Agent descriptor/u);
	assert.throws(() => validateOperations("AgentCatalogResponse", { ok: true, agents: [{ ...before, presentationKind: "note-agent" }] }), /AgentCatalogResponse is invalid/u);
	config("");
	assert.throws(() => describeEvaluationAgent("note-agent", root), /display_name/u);
} finally {
	rmSync(root, { recursive: true, force: true });
}
