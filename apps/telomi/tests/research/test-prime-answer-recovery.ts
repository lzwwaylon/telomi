import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentStageRequest } from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { primeKernelPython } from "../../server/agent-runtime/prime-agent-paths.js";
import { bundledAgentSkillPaths, materializeSkills, snapshotSkills } from "../../server/agent-runtime/skill-registry.js";
import { hashDirectory, sha256 } from "../../server/lib/hash.js";
import { runtimeControlRoot } from "../../server/workspaces/server-runtime-paths.js";
import { runtimeContextPath } from "../../server/observability/run-records.js";
import { validateInvestigationAnswerFromInput, type InvestigationAnswer } from "../../server/research/investigation-answer.js";
import { PrimeReportWriterStageRunner } from "../../server/research/pipeline/prime-report-writer.js";
import { findNodeEvaluationCases, readNodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";

// Real Prime SDK, Worker IPC and IPython, with deterministic localhost model responses.
const root = realpathSync(mkdtempSync(join(tmpdir(), "answer-recovery-")));
const credentials = join(root, "credentials"), inputs = join(root, "inputs"), records = join(root, "records");
for (const path of [credentials, inputs, records]) mkdirSync(path, { recursive: true });
const assignment = { schema_version: 1, question: "Keep every assigned part.", context: "", language: "en",
	requirements: [{ id: "Q1", question: "Explain both facts." }], evidence_refs: ["N1", "N2"] };
writeFileSync(join(inputs, "request.json"), JSON.stringify(assignment));
const answer: InvestigationAnswer = { answer: "Both facts. <cite>N1,N2</cite>", citation_refs: ["N1", "N2"],
	coverage: [{ requirement_id: "Q1", citation_refs: ["N1", "N2"], gap: "" }], gaps: [] };
let calls = 0;
let snapshotRequests = 0;
let mode: "repair" | "exhaust" | "model-error" | "infrastructure" = "repair";
const seen: Array<Array<{ role: string; content?: unknown }>> = [];
const server = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += String(chunk);
	if (req.url === "/v1/health") { res.writeHead(200).end("{}"); return; }
	if (req.url === "/v1/trees") {
		snapshotRequests += 1;
		// The optional tree cache is not this fixture's subject; Capture still freezes actual files and native Traces.
		res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Fixture tree cache unavailable" } }));
		return;
	}
	const messages = JSON.parse(body).messages as Array<{ role: string; content?: unknown }>;
	seen.push(messages);
	calls += 1;
	const turn = Math.ceil(calls / 2);
	if (mode === "model-error") { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "fixture model refused" } })); return; }
	const code = turn === 1 ? `from pathlib import Path\nimport json\noriginal_assignment = json.loads(Path('inputs/request.json').read_text())\nsaved_answer = ${JSON.stringify(JSON.stringify(answer))}\nvalue = json.loads(saved_answer)\nvalue['answer'] = 'Both facts. <cite>N1,N999</cite>'\nPath('work/answer.json').write_text(json.dumps(value))\nprint('first file written')`
	: `assert original_assignment['evidence_refs'] == ['N1', 'N2']\nassert original_assignment['requirements'][0]['id'] == 'Q1'\nvalue = json.loads(saved_answer)\n${mode === "exhaust" ? "value['answer'] = 'Both facts. <cite>N1,N999</cite>'\n" : ""}Path('work/answer.json').write_text(json.dumps(value))\nprint('same kernel repaired file')`;
	const action = calls % 2 === 1;
	const delta = action ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: "ipython", arguments: JSON.stringify({ code }) } }] }
	: { role: "assistant", content: "File written." };
	const chunk = (delta: unknown, finish: string | null, usage?: unknown) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "writer", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(chunk(delta, null) + chunk({}, action ? "tool_calls" : "stop", { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }) + "data: [DONE]\n\n");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const previousSourceBaseUrl = process.env.TELOMI_RESEARCH_SOURCE_BASE_URL;
process.env.TELOMI_RESEARCH_SOURCE_BASE_URL = `http://127.0.0.1:${address.port}`;
writeFileSync(join(credentials, "auth.json"), "{}");
writeFileSync(join(credentials, "models.json"), JSON.stringify({ providers: { "writer-fixture": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture-key", models: [{ id: "writer", name: "Writer", reasoning: false, contextWindow: 128000, maxTokens: 4096 }] } } }));
const env = { ...process.env, TELOMI_DATA_DIR: join(root, "data"), PRIME_AGENT_CODING_AGENT_DIR: credentials };
const writingSkill = bundledAgentSkillPaths("research", "report-writer").find(path => basename(path) === "writing-skill"); assert.ok(writingSkill);
const [skill] = [...materializeSkills(snapshotSkills([writingSkill]), join(root, "seed-skills")).values()]; assert.ok(skill);
const environmentHash = sha256(JSON.stringify({ schemaVersion: 1, python: primeKernelPython(env), skill: hashDirectory(skill) }));
const cache = join(runtimeControlRoot(env.TELOMI_DATA_DIR), "skill-envs", environmentHash);
mkdirSync(join(cache, "site-packages"), { recursive: true });
writeFileSync(join(cache, "requirements.lock"), "");
writeFileSync(join(cache, "ready.json"), JSON.stringify({ environmentHash, lockSha256: sha256("") }));
const request = (): AgentStageRequest<InvestigationAnswer> => ({ runId: "answer-recovery", stageId: "writer-answer", attemptId: mode, role: "report_writer",
	promptConfig: { domain: "research", id: "report-writer", sandboxRole: "report.report_writer", userVariant: "answer" },
	evaluation: { agentId: "report-writer", recipe: { id: "report-writer", version: 2 }, recipeInput: { mode: "investigation-answer" }, inputGuestPath: "/inputs", harnessMounts: [], liveExternalState: false },
	session: { key: "answer", policy: "fresh" }, modelPolicy: { preferred: ["writer-fixture/writer"], reasoning: "off" },
	systemPrompt: "Write work/answer.json using the assigned evidence.", userPrompt: "Keep every assigned requirement and evidence ref.",
	workDirectory: join(records, mode), controlDirectory: records, recordDirectory: records,
	readonlyMounts: [{ hostPath: inputs, guestPath: "/inputs", access: "read-only" }], artifactStore: new RunArtifactStore(records), signal: new AbortController().signal,
	output: { kind: "json_candidate", entryRelativePath: "work/answer.json", publishRelativePath: `artifacts/${mode}.json`, validate: ({ entryPath }) => validateInvestigationAnswerFromInput(JSON.parse(readFileSync(entryPath, "utf8")), inputs) } });
const runner = new PrimeReportWriterStageRunner({ runStage: async () => { throw new Error("unexpected delegated Stage"); } }, { env });
try {
	const result = await runner.runStage(request());
	assert.deepEqual(result.value, answer);
	assert.equal(calls, 4);
	assert.equal(result.submissionCount, 2);
	assert.equal(result.validationErrors.length, 1);
	assert.match(result.validationErrors[0]!, /<cite>N1,N999<\/cite>/u);
	assert.equal(result.usage.calls, 4);
	assert.equal(result.toolCalls, 2);
	assert.ok(seen[2]!.some(message => message.role === "user" && JSON.stringify(message.content).includes("Runtime rejected")), "host rejection reaches the same native conversation");
	assert.match(readFileSync(result.sessionPath!, "utf8"), /same kernel repaired file/u, "repair retains the live IPython variables");
	assert.equal(existsSync(request().workDirectory), false, "successful Capture cleans the live workspace after retaining the Trace");
	assert.equal(result.evaluationCapture?.status, "captured");
	if (result.evaluationCapture?.status === "captured") {
		const captured = readNodeEvaluationCase(result.evaluationCapture.casePath, records);
		assert.deepEqual(captured.observed.validationErrors, result.validationErrors);
		assert.equal(captured.observed.metrics?.calls, 4);
		assert.equal(captured.workspace?.input_tree_sha, null);
		assert.ok(captured.workspace?.warnings?.every(warning => warning.includes("Fixture tree cache unavailable")),
			"an unavailable optional tree cache cannot prevent actual file and Trace Capture");
	}
	for (mode of ["exhaust", "model-error", "infrastructure"] as const) {
		calls = 0;
		if (mode === "model-error") {
			// Disable upstream's own transport retry for this fixture, isolating Runtime structural repair.
			const settings = join(request().workDirectory, "agent", ".prime", "agent");
			mkdirSync(settings, { recursive: true });
			writeFileSync(join(settings, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
		}
		if (mode === "infrastructure") {
			mkdirSync(request().workDirectory, { recursive: true });
			writeFileSync(join(request().workDirectory, "work"), "host output directory is unavailable");
		}
		await assert.rejects(runner.runStage(request()), mode === "exhaust" ? /invalid after 3 attempts/u : mode === "model-error" ? /fixture model refused/u : /EEXIST/u);
		assert.equal(calls, mode === "exhaust" ? 6 : mode === "model-error" ? 1 : 2, "only structural violations spend repair turns");
		assert.equal(existsSync(join(records, "artifacts", `${mode}.json`)), false);
		const entry = readFileSync(runtimeContextPath(records, "research"), "utf8").trim().split("\n").map(line => JSON.parse(line)).at(-1)!;
		assert.equal(entry.status, "failed");
		assert.equal(entry.output.metrics.model_calls, mode === "exhaust" ? 6 : mode === "model-error" ? 1 : 2, "failed sessions retain all model usage");
		assert.equal(entry.output.validation_errors.length, mode === "exhaust" ? 3 : 0);
		const failedCase = findNodeEvaluationCases(records).find(item => item.value.attemptId === mode);
		assert.ok(failedCase, "failure Capture is retained");
		assert.deepEqual(failedCase.value.observed.validationErrors, entry.output.validation_errors);
		assert.ok(failedCase.value.observed.trace, "failed native Session remains inspectable");
	}
	assert.equal(snapshotRequests, 8, "all input/output snapshots use the local fixture instead of starting a Source process");
} finally {
	if (previousSourceBaseUrl === undefined) delete process.env.TELOMI_RESEARCH_SOURCE_BASE_URL;
	else process.env.TELOMI_RESEARCH_SOURCE_BASE_URL = previousSourceBaseUrl;
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	rmSync(root, { recursive: true, force: true });
}
