import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROVIDER_CHILD_TASK_FILE, preserveProviderChildTasks } from "../../server/research/pipeline/provider-execution-workspace.js";

const root = mkdtempSync(join(tmpdir(), "provider-child-task-"));
try {
	const sessionArtifacts = join(root, "runtime", "acquisition-session", "session-artifacts");
	const child = join(sessionArtifacts, "sub-2e2d11ad");
	mkdirSync(child, { recursive: true });
	writeFileSync(join(child, "01a07347.jsonl"), [
		JSON.stringify({ type: "session", version: 3, id: "01a07347" }),
		JSON.stringify({ type: "custom_message", customType: "agent_message", content: "[task from parent]\n\n原始问题：调研 TTS。\n\nProvider ID: github。" }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [] } }),
	].join("\n") + "\n");
	// A child that never produced a Ledger workspace is skipped; also a non-child dir is ignored.
	mkdirSync(join(sessionArtifacts, "not-a-child"), { recursive: true });

	// No work dir yet: nothing written.
	preserveProviderChildTasks(root, sessionArtifacts);
	const target = join(root, "provider-executions", "sub-2e2d11ad", "work", PROVIDER_CHILD_TASK_FILE);
	assert.throws(() => readFileSync(target, "utf-8"), "no Ledger workspace, no task file");

	mkdirSync(join(root, "provider-executions", "sub-2e2d11ad", "work"), { recursive: true });
	preserveProviderChildTasks(root, sessionArtifacts);
	assert.equal(readFileSync(target, "utf-8"), "原始问题：调研 TTS。\n\nProvider ID: github。\n");

	writeFileSync(target, "edited\n");
	preserveProviderChildTasks(root, sessionArtifacts);
	assert.equal(readFileSync(target, "utf-8"), "edited\n", "written once, never overwritten");

	preserveProviderChildTasks(root, join(root, "missing"));
	console.log("Provider child tasks are copied beside each Ledger at Case capture");
} finally {
	rmSync(root, { recursive: true, force: true });
}
