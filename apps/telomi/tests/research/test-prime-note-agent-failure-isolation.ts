import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { sha256 } from "../../server/lib/hash.js";
import { RuntimeNoteAgentProcessor } from "../../server/research/note-agent.js";
import type { AgentStageRunner } from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { PrimeNoteAgentStageRunner } from "../../server/research/pipeline/prime-note-agent.js";
import { agentSessionPath } from "../../server/observability/run-records.js";
import { ObservabilityActivityProjection } from "../../server/observability/activity-projection.js";

// A provider failure inside one Note Agent must stay that Source's failure, not end the Research Run.
const root = realpathSync(mkdtempSync(join(tmpdir(), "prime-note-agent-failure-isolation-")));
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
			if (readFileSync(join(options.cwd, "inputs", "context.md"), "utf8") !== "Record loss definitions and tensor dimensions.") throw new Error("Note Agent did not receive its reading priorities file");
			if (readFileSync(join(options.cwd, "source", "paper.md"), "utf-8").includes("overloaded")) {
				const failed = {
					role: "assistant", stopReason: "error", errorMessage: ${JSON.stringify(overloaded)},
					usage: { input: 1, output: 0, cost: { total: 0 } },
				};
				subscriber({ type: "message_end", message: failed });
				messages.push(failed);
				return;
			}
			writeFileSync(join(options.cwd, "note.json"), JSON.stringify({ sections: [{
				section_title: "Stable evidence", summary: "The Source was read.",
				cue_notes: [{ cue: "Evidence", note: "The first line is the title.", evidence: [
					{ source_path: "paper.md", start_line: 1, end_line: 1 },
				] }],
			}] }));
			const answered = { role: "assistant", content: [{ type: "text", text: "Finished reading the stable evidence." }], stopReason: "stop", usage: { input: 1, output: 1, cost: { total: 0 } } };
			subscriber({ type: "message_end", message: answered });
			messages.push(answered);
		},
		async abort() {},
		async disposeAsync() {},
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
	const primeRunner = new PrimeNoteAgentStageRunner({
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
	let liveRead = false;
	const evaluationRecords: AgentStageRunner = {
		runStage: async (request) => {
			const executionId = `${request.session.key}-${request.attemptId}`;
			const session = agentSessionPath(request.controlDirectory, request.role, executionId);
			const result = await primeRunner.runStage({ ...request, recordKind: "evaluation", onActivity: (activity) => {
				const manifest = JSON.parse(readFileSync(`${session}.sessions.json`, "utf8"));
				assert.equal(manifest.sessions.length, 1, "the running Reader indexes exactly one trace");
				if (activity.status !== "succeeded") return;
				const projection = new ObservabilityActivityProjection();
				const ref = projection.registerOutput({ kind: "recorded-agent", goalId: "goal-reader", runId: request.runId,
					runDirectory: request.controlDirectory, agent: "note_agent", executionId,
					sessionFile: basename(session), lifecycle: "running" });
				const live = projection.readOutput("goal-reader", ref)!;
				assert.equal(live.lines.filter((line) => line.text.includes("Finished reading the stable evidence.")).length, 1,
					"Reader output is visible before its workspace is removed, without duplicate native and merged messages");
				liveRead = true;
			} });
			assert.deepEqual(JSON.parse(readFileSync(`${session}.sessions.json`, "utf8")).sessions,
				[{ path: basename(session), label: "Note Agent" }], "the finished Reader points at its retained trace");
			return result;
		},
	};
	const runRoot = join(root, "control", "run");
	const produced = await new RuntimeNoteAgentProcessor({
		outputLanguage: "en",
		documentConcurrency: 2,
		noteAgentModel: "openai-codex/test-model",
		noteAgentThinkingLevel: "medium",
	}, evaluationRecords).process({
		runId: "run:prime-note-agent-failure-isolation",
		sequence: 1,
		question: "Continue after one Source hits an upstream failure.",
		noteFocus: "Record loss definitions and tensor dimensions.",
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
	assert.equal(liveRead, true);
} finally {
	rmSync(root, { recursive: true, force: true });
}
