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
import { buildCornellNoteAgentSystemPrompt, buildCornellNoteAgentUserPrompt } from "../../server/research/pipeline/index.js";

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
assert.deepEqual(loadAgentPromptConfig("main", "router").skills,
	["wiki-knowledge", "report-products", "research-monitoring", "topic-plan", "user-memory"]);
const routerSkillPaths = bundledAgentSkillPaths("main", "router");
const routerSkillBodies = new Map(routerSkillPaths.map((path) => [
	path.split("/").at(-1)!,
	readFileSync(join(path, "SKILL.md"), "utf-8"),
]));
for (const [tool, owner] of Object.entries({
	wiki_search: "wiki-knowledge",
	wiki_read_page: "wiki-knowledge",
	wiki_graph_search: "wiki-knowledge",
	wiki_update: "wiki-knowledge",
	generate_report: "report-products",
	generate_podcast: "report-products",
	research: "research-monitoring",
	research_schedule: "research-monitoring",
})) {
	const marker = `\`${tool}\``;
	assert.deepEqual([...routerSkillBodies].filter(([, body]) => body.includes(marker)).map(([name]) => name), [owner],
		`${tool} instructions must have exactly one owning Skill`);
}
assert.deepEqual(bundledAgentSkillPaths("research", "report-writer").map((path) => path.split("/").at(-1)),
	["wiki-report", "writing-skill"]);
assert.deepEqual(bundledAgentSkillPaths("research", "find-out-report-writer")
	.map((path) => relative(agentRoot, path)), [
	"research/find-out-report-writer/skills/find-out-report",
	"research/report-writer/skills/writing-skill",
]);
assert.deepEqual(loadAgentPromptConfig("wiki", "wiki-curator").skills, ["wiki-curator"]);
for (const task of ["entity", "concept"] as const) {
	const prompt = renderAgentPrompt("wiki", "wiki-shard-builder", "user", {
		goal: "RESEARCH_QUESTION_MUST_NOT_BE_INJECTED", goal_title: "Study battery recycling", goal_description: "Long-term interests",
		batch_number: 1, batch_total: 2, batch_id: "batch-test", topics: "Recycling methods", reading_material: "Original Notes",
		source_count: 3, child_model: "provider/child", language: "en",
	}, task).content;
	assert.match(prompt, /Study battery recycling/u);
	assert.match(prompt, /Long-term interests/u);
	assert.doesNotMatch(prompt, /RESEARCH_QUESTION_MUST_NOT_BE_INJECTED/u);
	assert.doesNotMatch(prompt, /batch-test|batch 1 of 2|same language as the Goal/u);
	assert.ok(prompt.includes(`submit_wiki_${task}_result()`));
}
assert.deepEqual(loadAgentPromptConfig("main", "podcast-writer").skills, ["podcast-writing"]);
assert.deepEqual(loadAgentPromptConfig("evolution", "browser-skill-evolution").sandbox, {
	role: "evolution.candidate_author",
	executionProfile: "pi_builtin",
	network: "deny",
	tools: ["read", "write", "edit", "bash", "ls", "find", "grep", "run_browser_replay", "submit_stage_output"],
});
assert.deepEqual(loadAgentPromptConfig("main", "router").sandbox?.tools, [
	"research",
	"generate_report",
	"generate_podcast",
	"wiki_search",
	"wiki_read_page",
	"wiki_graph_search",
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
const mainRouterPrompt = renderAgentPrompt("main", "router", "system", {
	goal: "Become a speech generation expert",
	output_language: "auto",
	topic_ready: true,
	topic_active: false,
	previous_searches: "[]",
}).content;
assert.doesNotMatch(mainRouterPrompt, /Goal Harness|capability snapshot|historical Run/iu);
assert.doesNotMatch(mainRouterPrompt, /rebuild=true|research\.schedule|recurring monitoring/iu);
assert.doesNotMatch(mainRouterPrompt, /topic_plan_activate/u);
assert.equal(loadAgentPromptConfig("research", "cornell-note").sandbox?.network, "deny");
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
const cornellPrompt = `${buildCornellNoteAgentSystemPrompt()}\n${buildCornellNoteAgentUserPrompt({
	question: "Track speech generation.",
	goal: { title: "Become a TTS expert", description: "Understand speech generation" },
	discoveryEnabled: true,
	topicPlan,
})}`;
assert.match(cornellPrompt, /Discovery is enabled only for this Cornell Note stage/u);
assert.match(cornellPrompt, /"discovery":\{"finding"/u);
assert.match(cornellPrompt, /T1 \| Multilingual/u);
assert.match(cornellPrompt, /"topic_refs":\["T1"\]/u);
assert.doesNotMatch(cornellPrompt, /- multilingual \| Multilingual/u);
const cornellWithoutDiscovery = buildCornellNoteAgentUserPrompt({
	question: "Track speech generation.",
	goal: { title: "Become a TTS expert", description: "" },
	discoveryEnabled: false,
	topicPlan,
});
assert.doesNotMatch(cornellWithoutDiscovery, /Discovery|discovery|finding/u);
assert.doesNotMatch(cornellWithoutDiscovery, /Source update|New member paths|Changed member paths/u);
const cornellWithSourceUpdate = buildCornellNoteAgentUserPrompt({
	question: "Track speech generation.",
	goal: { title: "Become a TTS expert", description: "" },
	discoveryEnabled: false,
	topicPlan,
	sourceUpdate: { newMemberPaths: ["members/github/repo"], changedMemberPaths: [] },
});
assert.match(cornellWithSourceUpdate, /Source update[\s\S]+New member paths: members\/github\/repo/u);
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
