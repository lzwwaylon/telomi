import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SANDBOX_TOOL_NAMES } from "../../../extensions/telomi-srt/sandbox-spec.js";
import { createSrtAgentSandbox } from "../../server/agent-runtime/srt-agent-sandbox.js";
import { awaitAuthoritativeStagePrompt, sandboxSkillPath } from "../../server/agent-runtime/agent-stage-runtime.js";

let abortedAcceptedPrompt = false;
let resolveAccepted!: () => void;
const acceptedSignal = new Promise<void>((resolve) => { resolveAccepted = resolve; });
const neverSettles = new Promise<void>(() => undefined);
resolveAccepted();
assert.equal(await awaitAuthoritativeStagePrompt(neverSettles, acceptedSignal, () => {
	abortedAcceptedPrompt = true;
}), "accepted");
assert.equal(abortedAcceptedPrompt, true,
	"An accepted Stage must become authoritative even when the Agent prompt never settles");

const root = mkdtempSync(join(tmpdir(), "pi-agent-stage-tools-"));
	assert.equal(sandboxSkillPath(
		join(root, "goal-skills", "example", "SKILL.md"),
		[{ hostPath: join(root, "goal-skills"), guestPath: "/workspace/skills", access: "read-only" }],
	), "/workspace/skills/example/SKILL.md");
	assert.equal(sandboxSkillPath(join(root, "outside", "SKILL.md"), [{
		hostPath: join(root, "goal-skills"), guestPath: "/workspace/skills", access: "read-only",
	}]), undefined);
	const sandbox = createSrtAgentSandbox({
	id: "pi-builtin-contract",
	role: "report.report_writer",
	workDirectory: join(root, "work"),
	readonlyMounts: [],
	activeTools: SANDBOX_TOOL_NAMES,
});

assert.deepEqual(sandbox.tools.map((tool) => tool.name), SANDBOX_TOOL_NAMES);
assert.deepEqual(sandbox.toolDefinitions.map((tool) => tool.name), SANDBOX_TOOL_NAMES);
const bashDefinition = sandbox.toolDefinitions.find((tool) => tool.name === "bash");
assert.ok(bashDefinition);
assert.deepEqual(Object.keys(bashDefinition.parameters.properties), ["command"],
	"Report Agent bash must not expose a wall-clock timeout parameter");
assert.match(
	sandbox.toolDefinitions.find((tool) => tool.name === "read")?.promptSnippet ?? "",
	/Read file contents/,
);

await sandbox.close();

const evidenceSource = join(root, "evidence-source");
const evidenceWork = join(root, "evidence-work");
mkdirSync(join(evidenceSource, "src"), { recursive: true });
writeFileSync(join(evidenceSource, "src", "runtime.md"), "EVIDENCE_TOOL_MARKER\n", "utf-8");
const evidenceSandbox = createSrtAgentSandbox({
	id: "evidence-screening-full-tools",
	role: "report.cornell_note",
	workDirectory: evidenceWork,
	readonlyMounts: [{ hostPath: evidenceSource, guestPath: "/source", access: "read-only" }],
	activeTools: SANDBOX_TOOL_NAMES,
	network: "deny",
});
const evidenceTools = Object.fromEntries(evidenceSandbox.tools.map((tool) => [tool.name, tool]));
await assert.doesNotReject(() => evidenceTools.find!.execute("find-source", { path: "/source", pattern: "*.md" },
	new AbortController().signal, () => undefined));
await assert.doesNotReject(() => evidenceTools.grep!.execute("grep-source", { pattern: "EVIDENCE_TOOL_MARKER", path: "/source" },
	new AbortController().signal, () => undefined));
await assert.doesNotReject(() => evidenceTools.bash!.execute("bash-source", { command: "rg EVIDENCE_TOOL_MARKER /source" },
	new AbortController().signal, () => undefined));
await evidenceTools.write!.execute("write-work", { path: "/work/evidence-working-notes.md", content: "scratch\n" },
	new AbortController().signal, () => undefined);
assert.equal(readFileSync(join(evidenceWork, "evidence-working-notes.md"), "utf-8"), "scratch\n");
await assert.rejects(() => evidenceTools.write!.execute("write-source", { path: "/source/forbidden.md", content: "blocked\n" },
	new AbortController().signal, () => undefined), /sandbox policy blocks|read-only|outside writable paths/u);
assert.equal(existsSync(join(evidenceSource, "forbidden.md")), false);
await evidenceSandbox.close();

const taskScopeInputs = join(root, "task-scope-inputs");
const taskScopeView = join(taskScopeInputs, "view");
const taskScopeWiki = join(taskScopeInputs, "wiki");
const taskScopeSkills = join(taskScopeInputs, "skills");
mkdirSync(join(taskScopeView, "wiki"), { recursive: true });
mkdirSync(join(taskScopeView, "skills"), { recursive: true });
mkdirSync(taskScopeWiki, { recursive: true });
mkdirSync(join(taskScopeSkills, "example"), { recursive: true });
const taskScopeContext = join(taskScopeView, "context.jsonl");
writeFileSync(taskScopeContext, "{\"role\":\"user\"}\n", "utf-8");
writeFileSync(join(taskScopeWiki, "index.md"), "# Wiki\n", "utf-8");
writeFileSync(join(taskScopeSkills, "example", "SKILL.md"), "---\nname: example\ndescription: Example Skill.\n---\n", "utf-8");
const taskScopeSandbox = createSrtAgentSandbox({
	id: "pi-builtin-task-scope-mounts",
	role: "report.report_writer",
	workDirectory: join(root, "task-scope-work"),
	readonlyMounts: [
		{ hostPath: taskScopeView, guestPath: "/workspace", access: "read-only" },
		{ hostPath: taskScopeWiki, guestPath: "/workspace/wiki", access: "read-only" },
		{ hostPath: taskScopeSkills, guestPath: "/workspace/skills", access: "read-only" },
	],
	activeTools: SANDBOX_TOOL_NAMES,
});
const taskScopeRead = taskScopeSandbox.tools.find((tool) => tool.name === "read");
const taskScopeLs = taskScopeSandbox.tools.find((tool) => tool.name === "ls");
const taskScopeBash = taskScopeSandbox.tools.find((tool) => tool.name === "bash");
assert.ok(taskScopeRead && taskScopeLs && taskScopeBash);
await assert.doesNotReject(() => taskScopeRead.execute(
	"read-task-scope-context",
	{ path: "/workspace/context.jsonl", offset: 1, limit: 20 },
	new AbortController().signal,
	() => undefined,
));
await assert.doesNotReject(() => taskScopeLs.execute(
	"list-task-scope-wiki",
	{ path: "/workspace/wiki" },
	new AbortController().signal,
	() => undefined,
));
await assert.doesNotReject(() => taskScopeBash.execute(
	"bash-task-scope-mounts",
	{ command: "test -f /workspace/context.jsonl && test -f /workspace/wiki/index.md && test -f /workspace/skills/example/SKILL.md" },
	new AbortController().signal,
	() => undefined,
));
await taskScopeSandbox.close();

const writableWiki = join(root, "writable-wiki");
mkdirSync(writableWiki, { recursive: true });
const writableMountSandbox = createSrtAgentSandbox({
	id: "pi-builtin-writable-mount",
	role: "report.cornell_note",
	workDirectory: join(root, "writable-mount-work"),
	readonlyMounts: [],
	writableMounts: [{
		hostPath: writableWiki,
		guestPath: "/wiki",
		access: "read-write",
	}],
	network: "deny",
	activeTools: SANDBOX_TOOL_NAMES,
});
const writableMountLs = writableMountSandbox.tools.find((tool) => tool.name === "ls");
const writableMountRead = writableMountSandbox.tools.find((tool) => tool.name === "read");
const writableMountWrite = writableMountSandbox.tools.find((tool) => tool.name === "write");
const writableMountEdit = writableMountSandbox.tools.find((tool) => tool.name === "edit");
const writableMountBash = writableMountSandbox.tools.find((tool) => tool.name === "bash");
assert.ok(writableMountLs && writableMountRead && writableMountWrite && writableMountEdit && writableMountBash);
await writableMountWrite.execute(
	"create-wiki/source",
	{ path: "/wiki/sources/github.md", content: "# GitHub\n" },
	new AbortController().signal,
	() => undefined,
);
await writableMountLs.execute(
	"list-wiki/source",
	{ path: "/wiki/sources" },
	new AbortController().signal,
	() => undefined,
);
await writableMountRead.execute(
	"read-wiki/source",
	{ path: "/wiki/sources/github.md", offset: 1, limit: 20 },
	new AbortController().signal,
	() => undefined,
);
await writableMountEdit.execute(
	"edit-wiki/source",
	{ path: "/wiki/sources/github.md", edits: [{ oldText: "# GitHub", newText: "# GitHub Evidence" }] },
	new AbortController().signal,
	() => undefined,
);
assert.equal(readFileSync(join(writableWiki, "sources/github.md"), "utf-8"), "# GitHub Evidence\n");
await writableMountBash.execute(
	"delete-wiki/source",
	{ command: "rm /wiki/sources/github.md" },
	new AbortController().signal,
	() => undefined,
);
await assert.rejects(
	() => writableMountWrite.execute(
		"escape-wiki",
		{ path: "/wiki/../outside.md", content: "escape\n" },
		new AbortController().signal,
		() => undefined,
	),
	/sandbox policy blocks|outside the Agent workspace|outside writable paths|escapes/u,
);
await writableMountSandbox.close();
assert.equal(existsSync(join(writableWiki, "sources/github.md")), false, "delete must remove the Wiki file");

const guardedInputs = join(root, "guarded-inputs");
mkdirSync(guardedInputs, { recursive: true });
writeFileSync(join(guardedInputs, "request.json"), "{}\n", "utf-8");
writeFileSync(join(guardedInputs, "document.readable.json"), "{\"blocks\":[]}\n", "utf-8");
const guardedSandbox = createSrtAgentSandbox({
	id: "pi-builtin-read-policy",
	role: "report.report_writer",
	workDirectory: join(root, "guarded-work"),
	readonlyMounts: [{
		hostPath: guardedInputs,
		guestPath: "/inputs",
		access: "read-only",
	}],
	activeTools: SANDBOX_TOOL_NAMES,
	fileToolPolicy: {
		deniedReadPaths: ["/inputs/document.readable.json"],
		deniedReadPrefixes: ["/work/wiki"],
		deniedReadMessage: "Use bounded jq queries through bash.",
		bashPathGuards: [{
			path: "/inputs/document.readable.json",
			requiredExecutable: "jq",
			deniedPatterns: [
				"(?:^|[;&|]\\s*)jq\\s+(?:-[A-Za-z]+\\s+)*(?:['\"]?\\.['\"]?)\\s+[^;&|]*document\\.readable\\.json",
			],
			message: "Use a compact bounded jq projection.",
		}],
	},
});
const guardedRead = guardedSandbox.tools.find((tool) => tool.name === "read");
assert.ok(guardedRead);
await assert.doesNotReject(() => guardedRead.execute(
	"allowed-read",
	{ path: "/inputs/request.json", offset: 1, limit: 20 },
	new AbortController().signal,
	() => undefined,
));
await assert.rejects(
	() => guardedRead.execute(
		"denied-read",
		{ path: "/inputs/document.readable.json", offset: 1, limit: 20 },
		new AbortController().signal,
		() => undefined,
	),
	/Use bounded jq queries through bash/,
);
await assert.rejects(
	() => guardedRead.execute(
		"denied-prefix-read",
		{ path: "wiki/concept.md", offset: 1, limit: 20 },
		new AbortController().signal,
		() => undefined,
	),
	/Use bounded jq queries through bash/,
);
const guardedBash = guardedSandbox.tools.find((tool) => tool.name === "bash");
assert.ok(guardedBash);
await assert.doesNotReject(() => guardedBash.execute(
	"allowed-jq",
	{ command: "jq '.blocks | length' /inputs/document.readable.json" },
	new AbortController().signal,
	() => undefined,
));
await assert.rejects(
	() => guardedBash.execute(
		"denied-cat",
		{ command: "cat /inputs/document.readable.json" },
		new AbortController().signal,
		() => undefined,
	),
	/compact bounded jq projection/,
);
await assert.rejects(
	() => guardedBash.execute(
		"denied-unbounded-jq",
		{ command: "jq '.' /inputs/document.readable.json" },
		new AbortController().signal,
		() => undefined,
	),
	/compact bounded jq projection/,
);
await guardedSandbox.close();

console.log("Pi built-in Agent stage Tool contract passed");
