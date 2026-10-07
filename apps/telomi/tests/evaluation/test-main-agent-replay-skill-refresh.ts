import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { refreshSkillReadsInHistory } from "../../server/evaluation/main-agent-replay.js";
import { captureMainAgentNodeEvaluation } from "../../server/evaluation/main-agent-evaluation.js";
import { readNodeEvaluationCase, readNodeEvaluationFile } from "../../server/agent-runtime/node-evaluation.js";
import { snapshotSkills } from "../../server/agent-runtime/skill-registry.js";
import { sha256 } from "../../server/lib/hash.js";

const root = mkdtempSync(join(tmpdir(), "telomi-replay-skill-refresh-"));
try {
	// The Candidate's Skills, laid out as the Runtime resolves them: a bundled root and a Goal override root.
	const bundled = join(root, "bundled");
	const skill = (dir: string, name: string, body: string, extra?: Record<string, string>) => {
		mkdirSync(join(dir, name), { recursive: true });
		writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} Skill\n---\n\n${body}`);
		for (const [file, text] of Object.entries(extra ?? {})) {
			mkdirSync(dirname(join(dir, name, file)), { recursive: true });
			writeFileSync(join(dir, name, file), text);
		}
	};
	skill(bundled, "topic-plan", "Candidate topic plan guidance.\n", { "references/notes.md": "Candidate notes.\n" });
	skill(bundled, "user-memory", "Bundled user memory guidance.\n");
	const goalOverride = join(root, "goal-override");
	skill(goalOverride, "user-memory", "Goal override user memory guidance.\n");
	const skills = snapshotSkills([join(bundled, "topic-plan"), join(bundled, "user-memory"), goalOverride], { allowOverrides: true });
	const candidateTopicPlan = readFileSync(join(bundled, "topic-plan", "SKILL.md"), "utf-8");
	const candidateNotes = readFileSync(join(bundled, "topic-plan", "references", "notes.md"), "utf-8");
	const candidateUserMemory = readFileSync(join(goalOverride, "user-memory", "SKILL.md"), "utf-8");

	// A continued Pi session as capture froze it: earlier turns read Skills and the work document.
	const frozenTopicPlan = "---\nname: topic-plan\ndescription: old\n---\n\nObserved topic plan guidance.\n";
	const entry = (id: string, message: unknown) => JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-07T00:00:00.000Z", message });
	const toolCall = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
	const toolResult = (toolCallId: string, toolName: string, text: string, isError = false) =>
		({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 1 });
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "session-1" }),
		entry("u1", { role: "user", content: "Plan the Goal", timestamp: 1 }),
		entry("a1", { role: "assistant", content: [
			toolCall("call_skill|fc_1", "read", { path: "/capabilities/skills/topic-plan/SKILL.md" }),
			toolCall("call_notes|fc_2", "read", { path: "/capabilities/skills/topic-plan/references/notes.md" }),
			toolCall("call_memory|fc_3", "read", { path: "/capabilities/skills/user-memory/SKILL.md" }),
			toolCall("call_work|fc_4", "read", { path: "/work/topic-plan.json" }),
			toolCall("call_missing|fc_5", "read", { path: "/capabilities/skills/topic-plan/missing.md" }),
			toolCall("call_bash|fc_6", "bash", { command: "cat /capabilities/skills/topic-plan/SKILL.md" }),
		], timestamp: 1 }),
		entry("t1", toolResult("call_skill|fc_1", "read", frozenTopicPlan)),
		entry("t2", toolResult("call_notes|fc_2", "read", "Observed notes.\n")),
		entry("t3", toolResult("call_memory|fc_3", "read", "Observed user memory guidance.\n")),
		entry("t4", toolResult("call_work|fc_4", "read", "{\n  \"topics\": []\n}\n")),
		entry("t5", toolResult("call_missing|fc_5", "read", "File not found", true)),
		entry("t6", toolResult("call_bash|fc_6", "bash", frozenTopicPlan)),
		entry("a2", { role: "assistant", content: [{ type: "text", text: "[SILENT]" }], timestamp: 1 }),
		"",
	];
	const history = Buffer.from(lines.join("\n"), "utf-8");

	const refreshed = refreshSkillReadsInHistory(history, skills);
	const parsed = refreshed.history.toString("utf-8").split("\n");
	assert.equal(parsed.length, lines.length, "line structure is preserved");
	const message = (index: number) => JSON.parse(parsed[index]!).message as { content: Array<{ text: string }> };
	assert.equal(message(3).content[0]!.text, candidateTopicPlan, "a bundled Skill read carries the Candidate text");
	assert.equal(message(4).content[0]!.text, candidateNotes, "a Skill reference file read is refreshed too");
	assert.equal(message(5).content[0]!.text, candidateUserMemory, "a Goal-scoped override wins as it does in the Runtime");
	assert.equal(parsed[6], lines[6], "a read outside /capabilities/skills stays verbatim");
	assert.equal(parsed[7], lines[7], "a failed read stays verbatim");
	assert.equal(parsed[8], lines[8], "a bash result is not a Skill read and stays verbatim");
	for (const index of [0, 1, 2, 9, 10]) assert.equal(parsed[index], lines[index], `line ${index} keeps its exact bytes`);
	assert.deepEqual(JSON.parse(parsed[3]!), { ...JSON.parse(lines[3]!), message: { ...JSON.parse(lines[3]!).message,
		content: [{ type: "text", text: candidateTopicPlan }] } }, "only the result content changes");
	assert.deepEqual(refreshed.skillReads, {
		"/capabilities/skills/topic-plan/SKILL.md": sha256(candidateTopicPlan),
		"/capabilities/skills/topic-plan/references/notes.md": sha256(candidateNotes),
		"/capabilities/skills/user-memory/SKILL.md": sha256(candidateUserMemory),
	}, "the Case learns the sha256 of each refreshed Skill file by guest path");
	assert.equal(sha256(history), sha256(Buffer.from(lines.join("\n"), "utf-8")), "the frozen input is unchanged");

	// A Skill the Candidate no longer provides, or a partial read Replay cannot reproduce, fails closed.
	const removed = Buffer.from([lines[0], entry("a1", { role: "assistant", content: [toolCall("c|f", "read",
		{ path: "/capabilities/skills/report-products/SKILL.md" })], timestamp: 1 }), entry("t1", toolResult("c|f", "read", "x")), ""].join("\n"));
	assert.throws(() => refreshSkillReadsInHistory(removed, skills), /Candidate's Skills do not provide/u);
	const traversal = Buffer.from([lines[0], entry("a1", { role: "assistant", content: [toolCall("c|f", "read",
		{ path: "/capabilities/skills/topic-plan/../../../etc/passwd" })], timestamp: 1 }), entry("t1", toolResult("c|f", "read", "x")), ""].join("\n"));
	assert.throws(() => refreshSkillReadsInHistory(traversal, skills), /Candidate's Skills do not provide/u);
	const partial = Buffer.from([lines[0], entry("a1", { role: "assistant", content: [toolCall("c|f", "read",
		{ path: "/capabilities/skills/topic-plan/SKILL.md", offset: 2 })], timestamp: 1 }), entry("t1", toolResult("c|f", "read", "x")), ""].join("\n"));
	assert.throws(() => refreshSkillReadsInHistory(partial, skills), /partial Skill read/u);
	const noReads = Buffer.from([lines[0], lines[1], lines[9], ""].join("\n"));
	assert.deepEqual(refreshSkillReadsInHistory(noReads, skills), { history: noReads, skillReads: {} });

	// The Candidate Case records the refreshed history and its Skill versions where Attestation reads them.
	const capture = (record: string, historyRefresh?: { skillReads: Record<string, string> }, contextBefore?: Buffer) => {
		mkdirSync(record, { recursive: true });
		writeFileSync(join(record, "main-agent.jsonl"), "{}\n");
		const logicalWorkspacePath = join(record, "main-agent-logical-workspace");
		mkdirSync(join(logicalWorkspacePath, "work"), { recursive: true });
		writeFileSync(join(logicalWorkspacePath, "work", "topic-plan.json"), "{}\n");
		writeFileSync(`${logicalWorkspacePath}.json`, JSON.stringify({ schemaVersion: 1, guestCwd: "/work", mounts: [{ guestPath: "/work", access: "read-write" }] }));
		captureMainAgentNodeEvaluation({
			runId: "nodebt_fixture::executions::candidate_1",
			runDirectory: record,
			question: "Revise the plan",
			systemPrompt: "Candidate system prompt",
			actualModel: "openai-codex/gpt-5.6-terra",
			thinkingLevel: "medium",
			...(contextBefore ? { contextBefore } : {}),
			...(historyRefresh ? { historyRefresh } : {}),
			sessionPath: join(record, "main-agent.jsonl"),
			terminal: { terminal: true, action: "assistant_reply", userResponse: "Done.", trace: { coarseAction: "assistant_reply", reasonCode: "assistant_reply" } },
			toolCounts: {},
			logicalWorkspacePath,
		});
		return join(record, "node-evaluation", "cases");
	};
	const casesDirectory = capture(join(root, "candidate-record"), { skillReads: refreshed.skillReads }, refreshed.history);
	const [caseId] = readdirSync(casesDirectory);
	const casePath = join(casesDirectory, caseId!, "manifest.json");
	const candidateCase = readNodeEvaluationCase(casePath, join(root, "candidate-record"));
	assert.deepEqual((candidateCase.recipeInput as { historyRefresh: unknown }).historyRefresh, { skillReads: refreshed.skillReads });
	assert.ok(candidateCase.request.session.contextBefore, "the Candidate Case freezes the history the Candidate actually saw");
	assert.equal(readNodeEvaluationFile(casePath, candidateCase.request.session.contextBefore!), refreshed.history.toString("utf-8"));

	// Observed and override modes pass the history verbatim and record no refresh.
	const verbatimRecord = join(root, "observed-record");
	const verbatimCases = capture(verbatimRecord, undefined, history);
	const [verbatimId] = readdirSync(verbatimCases);
	const verbatimCase = readNodeEvaluationCase(join(verbatimCases, verbatimId!, "manifest.json"), verbatimRecord);
	assert.equal("historyRefresh" in (verbatimCase.recipeInput as object), false);
	assert.equal(readNodeEvaluationFile(join(verbatimCases, verbatimId!, "manifest.json"), verbatimCase.request.session.contextBefore!), history.toString("utf-8"));

	console.log("Candidate Main Agent Replay refreshes frozen Skill reads and records their versions");
} finally {
	rmSync(root, { recursive: true, force: true });
}
