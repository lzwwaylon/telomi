import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderCapturedCandidatePrompts } from "../../server/evaluation/candidate-prompts.js";
import { renderMainAgentPrompt } from "../../server/main-agent/system-prompts.js";
import { buildNoteReadingTaskPrompt } from "../../server/research/note-reading.js";
import { renderAgentPrompt } from "../../server/agent-runtime/prompt-registry.js";
import { renderNoteAgentSystemPrompt } from "../../server/research/pipeline/note-agent-prompt.js";
import { wikiSelfDirectedWriterUserPrompt, findOutSelfDirectedWriterUserPrompt } from "../../server/research/pipeline/report-prompts.js";

const root = mkdtempSync(join(tmpdir(), "telomi-candidate-prompts-"));
const input = join(root, "input");
mkdirSync(input);
type PromptCase = Parameters<typeof renderCapturedCandidatePrompts>[0];
function promptCase(agentId: string, recipeInput: unknown, guestPath = "/inputs", userVariant?: string): PromptCase {
	return { agentId, recipeInput, request: { promptConfig: { ...(userVariant ? { userVariant } : {}) } },
		mounts: [{ kind: "run", guestPath, access: "read-only", directory: {
			ref: "input", sha256: "a".repeat(64), byteLength: 0, fileCount: 0,
		} }] };
}

try {
	const mainContext = { title: "Original user Goal", description: "Verify original materials",
		outputLanguage: "zh-CN" as const, topicReady: true, topicActive: true,
		previousSearches: [{ run_id: "original-run", search_question: "Frozen prior research", completed_at: "2025-01-03" }],
		globalPreferences: "Keep the user's frozen citation preference" };
	const main = renderCapturedCandidatePrompts(promptCase("main-agent", { promptContext: mainContext, question: "Continue the original Goal" }), root);
	assert.equal(main.systemPrompt, renderMainAgentPrompt(mainContext));
	assert.equal(main.userPrompt, "Continue the original Goal");
	assert.match(main.systemPrompt, /Original user Goal/u);
	assert.match(main.systemPrompt, /Verify original materials/u);
	assert.match(main.systemPrompt, /Frozen prior research/u);
	assert.match(main.systemPrompt, /Reply in zh-CN/u);
	assert.match(main.systemPrompt, /Topic Plan: confirmed/u);
	assert.match(main.systemPrompt, /investigate/u);
	assert.doesNotMatch(main.systemPrompt, /Main Agent Backtest|generate_report/u);
	assert.throws(() => renderCapturedCandidatePrompts(promptCase("main-agent", { question: "Old question" }), root), /use observed or override for older Cases/u);
	assert.throws(() => renderCapturedCandidatePrompts(promptCase("main-agent", { promptContext: { ...mainContext, globalPreferences: undefined }, question: "Old question" }), root), /preference context/u);
	writeFileSync(join(input, "catalog.json"), JSON.stringify({ sources: [{ ref: "S1" }, { ref: "S2" }] }));
	const reader = renderCapturedCandidatePrompts(promptCase("cornell-note", {
		mode: "deep-search", question: "Verify the streaming transport", invocationId: "historical-reader",
	}, "/source", "deep-search"), root);
	assert.equal(reader.systemPrompt, renderNoteAgentSystemPrompt(undefined, "deep-search").content);
	assert.equal(reader.userPrompt, buildNoteReadingTaskPrompt("Verify the streaming transport", 2));
	const ordinary = renderCapturedCandidatePrompts(promptCase("cornell-note", {
		question: "What changed?", goal: { title: "Transport", description: "Original evidence" },
		discoveryEnabled: false, noteFocus: "Protocol fields",
	}), root);
	assert.match(ordinary.userPrompt, /What changed\?/u);
	assert.match(ordinary.userPrompt, /inputs\/context\.md/u);
	assert.doesNotMatch(ordinary.userPrompt, /Protocol fields/u);
	assert.equal(ordinary.systemPrompt, renderNoteAgentSystemPrompt().content);
	assert.throws(() => renderCapturedCandidatePrompts(promptCase("cornell-note", {}), root), /frozen request context/u);

	const answer = renderCapturedCandidatePrompts(promptCase("report-writer", { mode: "investigation-answer" }, "/inputs", "answer"), root);
	assert.equal(answer.userPrompt, renderAgentPrompt("research", "report-writer", "user", {}, "answer").content);
	assert.equal(answer.systemPrompt, renderAgentPrompt("research", "report-writer", "system-append", {}, "answer").content);
	assert.throws(() => renderCapturedCandidatePrompts(promptCase("report-writer", { mode: "investigation-answer" }), root), /frozen answer variant/u);

	writeFileSync(join(input, "request.json"), JSON.stringify({ language: "zh-CN" }));
	assert.throws(() => renderCapturedCandidatePrompts(promptCase("report-writer", {}), root), /temporal_context; use observed or override/u);
	const variables = { language: "zh-CN", currentDate: "2025-01-03", timeZone: "Asia/Shanghai", priorReports: "Historical report index" };
	writeFileSync(join(input, "request.json"), JSON.stringify({ language: variables.language,
		temporal_context: { currentDate: variables.currentDate, timeZone: variables.timeZone } }));
	mkdirSync(join(input, "prior-reports"));
	writeFileSync(join(input, "prior-reports", "index.md"), variables.priorReports);
	for (const [kind, render] of [["wiki", wikiSelfDirectedWriterUserPrompt], ["findout", findOutSelfDirectedWriterUserPrompt]] as const) {
		writeFileSync(join(input, "materials.json"), JSON.stringify({ kind }));
		const report = renderCapturedCandidatePrompts(promptCase("report-writer", {}), root);
		assert.equal(report.userPrompt, render(variables));
		assert.match(report.userPrompt, /2025-01-03/u, "Candidate must retain historical date rather than the current date");
	}
	const investigation = renderCapturedCandidatePrompts(promptCase("prime-investigation", {}), root);
	assert.equal(investigation.systemPrompt, "");
	assert.ok(investigation.userPrompt.startsWith(renderAgentPrompt("research", "prime-search", "user", {
		run_input_json: JSON.stringify({ request_ref: "inputs/request.json" }),
	}, "investigate").content));
	assert.ok(investigation.userPrompt.includes("inputs/replay-plan.json"));
	console.log("✓ Candidate project Prompts render from frozen Reader/Writer/Root inputs; legacy full reports fail closed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
