import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
	loadAgentPromptConfig,
	PROMPT_KINDS,
	renderAgentPrompt,
	type PromptDomain,
} from "../../server/agent-runtime/prompt-registry.js";
import { bundledAgentSkillPaths } from "../../server/agent-runtime/skill-registry.js";
import { composeAgentSystemPrompt } from "../../server/agent-runtime/global-system-prompt.js";
import { buildNoteAgentSystemPrompt, buildNoteAgentUserPrompt, renderNoteAgentSystemPrompt } from "../../server/research/pipeline/index.js";

const agentRoot = fileURLToPath(new URL("../../agents", import.meta.url));
const domains: PromptDomain[] = ["main", "research", "wiki", "evolution"];
let rendered = 0;

for (const domain of domains) {
	for (const entry of readdirSync(new URL(`../../agents/${domain}/`, import.meta.url), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!existsSync(new URL(`../../agents/${domain}/${entry.name}/agent.yaml`, import.meta.url))) continue;
		const config = loadAgentPromptConfig(domain, entry.name);
		assert.equal(bundledAgentSkillPaths(domain, entry.name).length, config.skills?.length ?? 0,
			`${domain}/${entry.name} must resolve every declared Skill`);
		for (const kind of PROMPT_KINDS) {
			for (const [variant, template] of Object.entries(config.prompts[kind] ?? {})) {
				renderAgentPrompt(
					domain,
					entry.name,
					kind,
					templateVariables(`${agentRoot}/${domain}/${entry.name}/prompts/${template}`),
					variant,
				);
				rendered += 1;
			}
		}
	}
}

assert.ok(rendered > 0, "expected Prompt templates");
assert.deepEqual(loadAgentPromptConfig("main", "main-agent").skills,
	["report-products", "research-monitoring", "topic-plan", "user-memory"]);
const mainSkillPaths = bundledAgentSkillPaths("main", "main-agent");
const mainSkillBodies = new Map(mainSkillPaths.map((path) => [
	path.split("/").at(-1)!,
	readFileSync(join(path, "SKILL.md"), "utf-8"),
]));
for (const [tool, owner] of Object.entries({
	wiki_update: "research-monitoring",
	investigate: "report-products",
	deliver_investigation: "report-products",
	generate_podcast: "report-products",
	research_history: "research-monitoring",
	research_schedule: "research-monitoring",
})) {
	const marker = `\`${tool}\``;
	assert.deepEqual([...mainSkillBodies].filter(([, body]) => body.includes(marker)).map(([name]) => name), [owner],
		`${tool} instructions must have exactly one owning Skill`);
}
for (const [name, body] of mainSkillBodies) {
	assert.doesNotMatch(body, /`research`|generate_report|report_context|note_focus/u,
		`${name} must use the current investigation contract`);
}
assert.deepEqual(bundledAgentSkillPaths("research", "report-writer").map((path) => path.split("/").at(-1)),
	["wiki-report", "notes-report", "writing-skill"]);
assert.deepEqual(loadAgentPromptConfig("wiki", "wiki-compilation").skills, ["wiki"]);
assert.deepEqual(loadAgentPromptConfig("main", "podcast-writer").skills, ["podcast-writing"]);
assert.deepEqual(loadAgentPromptConfig("evolution", "browser-skill-evolution").sandbox, {
	role: "evolution.candidate_author",
	executionProfile: "pi_builtin",
	network: "deny",
	tools: ["read", "write", "edit", "bash", "ls", "find", "grep", "run_browser_replay", "submit_stage_output"],
});
assert.deepEqual(loadAgentPromptConfig("main", "main-agent").sandbox?.tools, [
	"research_history",
	"investigate",
	"deliver_investigation",
	"generate_podcast",
	"wiki_update",
	"research_schedule",
	"read",
	"write",
	"edit",
	"bash",
	"ls",
	"find",
	"grep",
]);
const mainAgentPrompt = renderAgentPrompt("main", "main-agent", "system", {
	goal: "Become a speech generation expert",
	output_language: "auto",
	topic_ready: true,
	topic_active: false,
	previous_searches: "[]",
}).content;
assert.doesNotMatch(mainAgentPrompt, /Goal Harness|capability snapshot|historical Run/iu);
assert.doesNotMatch(mainAgentPrompt, /rebuild=true|research\.schedule|recurring monitoring/iu);
assert.doesNotMatch(mainAgentPrompt, /topic_plan_activate/u);
assert.equal(loadAgentPromptConfig("research", "note-agent").sandbox?.network, "deny");
const noteWriting = renderAgentPrompt("research", "note-agent", "reference", {}, "note-writing").content;
const readingQuality = renderAgentPrompt("research", "note-agent", "reference", {}, "evidence-reading-quality").content;
for (const variant of ["default", "question-reading"] as const) {
	const scope = renderAgentPrompt("research", "note-agent", "system-append", {}, variant);
	const composed = renderNoteAgentSystemPrompt(undefined, variant);
	assert.equal(composed.content, `${scope.content}\n\n${noteWriting}\n\n${readingQuality}`,
		`${variant} Reader must include the registered writing and quality rules exactly once`);
	assert.deepEqual(composed.revision, scope.revision, "Reader scope retains its registered variant identity");
}
assert.match(buildNoteAgentSystemPrompt(), /one supplied Source/u);
assert.match(buildNoteAgentSystemPrompt(), /same language as the original Source/u);
assert.match(renderNoteAgentSystemPrompt(undefined, "question-reading").content, /question's language/u);
assert.throws(() => loadAgentPromptConfig("research", "../escape"), /Invalid Prompt identity/u);
assert.equal(existsSync(new URL("../../prompts", import.meta.url)), false, "legacy Prompt root must not exist");
assert.equal(existsSync(new URL("../../skills", import.meta.url)), false, "legacy Skill root must not exist");
const topicPlan = {
	schema_version: 1 as const,
	goal_id: "goal-prompt",
	revision: "topic-plan-v2",
	status: "active" as const,
	topics: [
		{ id: "multilingual", title: "Multilingual", intent: "Track Chinese and multilingual quality", questions: [], include: ["Chinese"], exclude: [] },
	],
};
const notePrompt = `${buildNoteAgentSystemPrompt()}\n${buildNoteAgentUserPrompt({
	question: "Track speech generation.",
	goal: { title: "Become a TTS expert", description: "Understand speech generation" },
	discoveryEnabled: true,
	topicPlan,
})}`;
assert.match(notePrompt, /Discovery is enabled only for this Note Agent stage/u);
assert.match(notePrompt, /"discovery":\{"finding"/u);
assert.match(notePrompt, /- Multilingual\n {2}Intent: Track Chinese and multilingual quality/u);
assert.doesNotMatch(notePrompt, /topic_refs/u);
assert.doesNotMatch(notePrompt, /## Note focus/u);
const noteWithFocus = buildNoteAgentUserPrompt({
	question: "Track speech generation.",
	goal: { title: "Become a TTS expert", description: "" },
	discoveryEnabled: false,
	noteFocus: "Loss definitions and data pipelines, at the level of PyTorch modules.",
});
assert.match(noteWithFocus, /inputs\/context\.md/u);
assert.doesNotMatch(noteWithFocus, /Loss definitions and data pipelines/u, "task content stays in the input file instead of being duplicated in the Prompt");
assert.match(noteWithFocus, /emphasis does not replace the assigned scope/u);
const noteWithoutDiscovery = buildNoteAgentUserPrompt({
	question: "Track speech generation.",
	goal: { title: "Become a TTS expert", description: "" },
	discoveryEnabled: false,
	topicPlan,
});
assert.doesNotMatch(noteWithoutDiscovery, /Discovery|discovery|finding/u);
assert.doesNotMatch(noteWithoutDiscovery, /Source update|New member paths|Changed member paths/u);
const noteWithSourceUpdate = buildNoteAgentUserPrompt({
	question: "Track speech generation.",
	goal: { title: "Become a TTS expert", description: "" },
	discoveryEnabled: false,
	topicPlan,
	sourceUpdate: { newMemberPaths: ["members/github/repo"], changedMemberPaths: [] },
});
assert.match(noteWithSourceUpdate, /Source update[\s\S]+New member paths: members\/github\/repo/u);
assert.doesNotMatch(
	composeAgentSystemPrompt("", { tools: [{ name: "bash" }] }),
	/other runtime tools may be available/iu,
);
assert.doesNotMatch(
	composeAgentSystemPrompt("Write a complete long-form artifact.", { conciseResponses: false }),
	/Be concise in your responses/iu,
);

console.log(`Prompt registry tests passed (${rendered} templates)`);

function templateVariables(path: string): Record<string, string> {
	const source = readFileSync(path, "utf-8");
	const names = new Set<string>();
	for (const match of source.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu)) names.add(match[1]!);
	for (const match of source.matchAll(/\{%\s*if\s+([A-Za-z_][A-Za-z0-9_]*)\s*%\}/gu)) names.add(match[1]!);
	return Object.fromEntries([...names].map((name) => [name, `TEST_${name}`]));
}
