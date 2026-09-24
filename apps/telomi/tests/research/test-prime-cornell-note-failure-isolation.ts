import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../../server/lib/hash.js";
import { RuntimeCornellNoteAgentProcessor } from "../../server/research/cornell-note-agent.js";
import type { AgentStageRunner } from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { PrimeCornellNoteStageRunner } from "../../server/research/pipeline/prime-cornell-note.js";

// A provider failure inside one Prime Cornell Note must stay that Source's failure, not end the Research Run.
const root = realpathSync(mkdtempSync(join(tmpdir(), "prime-cornell-failure-isolation-")));
try {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), "{}");
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
		"openai-codex": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "test-model" }] },
	} }));

	const overloaded = 'Codex error: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded"}}';
	const fakePrime = join(root, "fake-prime.mjs");
	writeFileSync(fakePrime, `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export { AuthStorage, ModelRegistry } from ${JSON.stringify(import.meta.resolve("prime-agent"))};
export const SettingsManager = { create: () => ({ getAutoRefineSettings: () => ({ enabled: false }) }) };
export class DefaultResourceLoader { async reload() {} }
export const SessionManager = { create: () => ({}) };
export async function createAgentSession(options) {
	let subscriber = () => undefined;
	const messages = [];
	return { session: {
		messages,
		subscribe(listener) { subscriber = listener; },
		async prompt() {
			if (readFileSync(join(options.cwd, "source", "paper.md"), "utf-8").includes("overloaded")) {
				const failed = {
					role: "assistant", stopReason: "error", errorMessage: ${JSON.stringify(overloaded)},
					usage: { input: 1, output: 0, cost: { total: 0 } },
				};
				subscriber({ type: "message_end", message: failed });
				messages.push(failed);
				return;
			}
			writeFileSync(join(options.cwd, "cornell-note.json"), JSON.stringify({ sections: [{
				section_title: "Stable evidence", summary: "The Source was read.",
				cue_notes: [{ cue: "Evidence", note: "The first line is the title.", evidence: [
					{ source_path: "paper.md", start_line: 1, end_line: 1 },
				] }],
			}] }));
			const answered = { role: "assistant", stopReason: "stop", usage: { input: 1, output: 1, cost: { total: 0 } } };
			subscriber({ type: "message_end", message: answered });
			messages.push(answered);
		},
		async abort() {},
		dispose() {},
	} };
}
`);

	const sources = [
		{ id: "source:stable", body: "# Stable evidence\n" },
		{ id: "source:overloaded", body: "# Read while the upstream model is overloaded\n" },
	].map(({ id, body }) => {
		const directoryPath = join(root, "sources", id.slice("source:".length));
		mkdirSync(directoryPath, { recursive: true });
		writeFileSync(join(directoryPath, "paper.md"), body);
		return {
			id,
			title: id,
			url: `https://example.com/${id.slice("source:".length)}`,
			providerId: "arxiv",
			sourceIdentity: id,
			revisionSha256: sha256(body),
			directoryPath,
			organizationKind: "ungrouped" as const,
			members: [],
		};
	});
	const primeRunner = new PrimeCornellNoteStageRunner({
		async runStage(): Promise<never> {
			throw new Error("Cornell Notes must run through Prime");
		},
	}, { env: {
		...process.env,
		TELOMI_PRIME_AGENT_MODULE_PATH: fakePrime,
		PRIME_AGENT_CODING_AGENT_DIR: agentDir,
	} });
	// Evaluation records run the same Prime Stage without the Research workspace snapshot, which needs the
	// Source Service; how a Worker failure is reported does not depend on the record kind.
	const evaluationRecords: AgentStageRunner = {
		runStage: (request) => primeRunner.runStage({ ...request, recordKind: "evaluation" }),
	};
	const runRoot = join(root, "run");
	const produced = await new RuntimeCornellNoteAgentProcessor({
		outputLanguage: "en",
		documentConcurrency: 2,
		cornellNoteModel: "openai-codex/test-model",
		cornellNoteThinkingLevel: "medium",
	}, evaluationRecords).process({
		runId: "run:prime-cornell-failure-isolation",
		sequence: 1,
		question: "Continue after one Source hits an upstream failure.",
		goal: { title: "Isolate Cornell Note failures", description: "" },
		discoveryEnabled: false,
		sources,
		signal: new AbortController().signal,
		workspaceDir: runRoot,
		controlDir: join(root, "control"),
		artifactStore: new RunArtifactStore(runRoot),
	});
	assert.deepEqual(produced.notes.map((item) => item.source.id), ["source:stable"]);
	assert.deepEqual(produced.failures.map((item) => item.source.id), ["source:overloaded"]);
	assert.match(produced.failures[0]!.message, /server_is_overloaded/u);
} finally {
	rmSync(root, { recursive: true, force: true });
}
