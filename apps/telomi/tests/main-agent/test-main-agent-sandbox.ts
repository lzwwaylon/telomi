import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { parsedDocumentsDir } from "../../server/workspaces/goal-runtime-paths.js";
import { createMainAgentSandboxExecutionSpec } from "../../server/agent-runtime/sandbox.js";
import { createMainAgentSandbox, snapshotMainAgentLogicalWorkspace } from "../../server/main-agent/main-agent-sandbox.js";
import { MainWorkspaceRuntime } from "../../server/main-agent/main-workspace-runtime.js";
import { loadMainAgentSkillsForSandbox } from "../../server/main-agent/runner.js";
import { buildMainAgentPrompt } from "../../server/main-agent/system-prompts.js";
import {
	goalTopicDocumentFromPlan,
	GoalTopicPlanStore,
	parseGoalTopicDocument,
	TOPIC_PLAN_DOCUMENT_PATH,
} from "../../server/goals/topic-plan/index.js";

const root = mkdtempSync(join(tmpdir(), "telomi-main-agent-sandbox-"));
const goalId = "main-agent-sandbox-test";
const goalDir = join(root, goalId);
const dataDir = root;
let sandbox: ReturnType<typeof createMainAgentSandbox> | undefined;

try {
	ensureGoalWorkspace({ goalDir, goalId, title: "Main Agent Sandbox" });
	mkdirSync(join(goalDir, "attachments"), { recursive: true });
	writeFileSync(join(goalDir, "attachments", "input.txt"), "attachment\n", "utf-8");
	mkdirSync(join(goalDir, "artifacts"), { recursive: true });
	writeFileSync(join(goalDir, "artifacts", "research.txt"), "research artifact\n", "utf-8");
	mkdirSync(join(goalDir, "wiki", "runs", "report-1", "report"), { recursive: true });
	writeFileSync(join(goalDir, "wiki", "runs", "report-1", "report", "final.md"), "# Published report\n", "utf-8");
	mkdirSync(join(goalDir, "skills", "main-agent", "note-organizer"), { recursive: true });
	writeFileSync(
		join(goalDir, "skills", "main-agent", "note-organizer", "SKILL.md"),
		"---\nname: note-organizer\ndescription: Organize a note into a stable topic path.\n---\n\nOrganize notes into stable topic paths.\n",
		"utf-8",
	);
	const skills = loadMainAgentSkillsForSandbox(goalDir);
	assert.equal(skills.skills.length, 1);
	assert.equal(skills.skills[0]?.name, "note-organizer");
	assert.equal(
		skills.skills[0]?.filePath,
		"/capabilities/skills/note-organizer/SKILL.md",
	);
	assert.equal(skills.diagnostics.length, 0);
	const prompt = buildMainAgentPrompt("/workspace", goalId, "Sandbox Goal", "test");
	assert.doesNotMatch(prompt, /Goal Harness|capability snapshot|Skill files listed/u);
	assert.doesNotMatch(prompt, /Capability Revision|sha256:/u);

	const runtime = new MainWorkspaceRuntime(goalDir, goalId, dataDir);
	const session = runtime.prepare({ conversationId: "sandbox-conversation" });
	assert.deepEqual(
		loadMainAgentSkillsForSandbox(session.sandboxDir).skills.map((skill) => skill.name).sort(),
		["note-organizer", "report-products", "research-monitoring", "topic-plan", "user-memory", "wiki-knowledge"],
		"product workflow Skills must be present without modifying the Goal Harness",
	);
	assert.match(session.capabilityRevision, /^[a-f0-9]{64}$/u,
		"Runtime must retain the capability revision outside the semantic Prompt");
	const snapshotPrompt = buildMainAgentPrompt("/workspace", goalId, "Sandbox Goal", "test");
	assert.doesNotMatch(snapshotPrompt, new RegExp(session.capabilityRevision, "u"));

	assert.equal(existsSync(parsedDocumentsDir(goalDir)), false,
		"the parsed document mirror must be absent before the sandbox specification is built");

	const spec = createMainAgentSandboxExecutionSpec({
		id: session.id,
		goalDir,
		sandboxDir: session.sandboxDir,
		historyDirectory: session.historyDirectory,
	});
	assert.equal(spec.role, "main.goal_agent");
	assert.equal(spec.guestCwd, "/work");
	assert.deepEqual(spec.network, { mode: "deny" });
	assert.deepEqual(spec.writablePaths, [{ guestPath: "/work", kind: "tree" }]);
	assert.deepEqual(spec.mounts.map((mount) => [mount.guestPath, mount.access]), [
		["/work", "read-write"],
		["/artifacts", "read-only"],
		["/attachments", "read-only"],
		["/documents", "read-only"],
		["/reports", "read-only"],
		["/capabilities/skills", "read-only"],
		["/history", "read-only"],
	]);
	assert.deepEqual(spec.mounts.find((mount) => mount.guestPath === "/artifacts")?.shadowPaths, ["/main"]);
	const parsedDocumentsMount = spec.mounts.find((mount) => mount.guestPath === "/documents");
	assert.equal(parsedDocumentsMount?.hostPath, realpathSync(parsedDocumentsDir(goalDir)),
		"parsed documents must mount the Goal's own parsed artifacts inside its Runtime Control Store");
	const escapedGoalDir = join(root, "escaped-goal");
	const escapeTarget = join(root, "another-goal-ingestion");
	cpSync(goalDir, escapedGoalDir, { recursive: true });
	mkdirSync(escapeTarget, { recursive: true });
	rmSync(join(escapedGoalDir, ".pi", "runtime", "cache"), { recursive: true, force: true });
	symlinkSync(escapeTarget, join(escapedGoalDir, ".pi", "runtime", "cache"));
	assert.throws(() => createMainAgentSandboxExecutionSpec({
		id: session.id,
		goalDir: escapedGoalDir,
		sandboxDir: session.sandboxDir,
		historyDirectory: session.historyDirectory,
	}), /Main Agent parsed documents escapes/u,
		"a symlinked Runtime cache must not mount another Goal's parsed documents");
	assert.equal(existsSync(join(escapeTarget, "documents")), false,
		"the guard must reject before creating anything outside the Goal");

	const parsedDir = join(parsedDocumentsDir(goalDir), "cache-key-1");
	mkdirSync(parsedDir, { recursive: true });
	writeFileSync(join(parsedDir, "document.md"), "# Parsed attachment\n", "utf-8");
	const logicalWorkspace = join(root, "logical-workspace");
	snapshotMainAgentLogicalWorkspace(goalDir, session, logicalWorkspace);
	assert.deepEqual(JSON.parse(readFileSync(`${logicalWorkspace}.json`, "utf-8")), {
		schemaVersion: 1,
		guestCwd: "/work",
		mounts: [
			{ guestPath: "/work", access: "read-write" },
			{ guestPath: "/artifacts", access: "read-only" },
			{ guestPath: "/attachments", access: "read-only" },
			{ guestPath: "/documents", access: "read-only" },
			{ guestPath: "/reports", access: "read-only" },
			{ guestPath: "/capabilities/skills", access: "read-only" },
			{ guestPath: "/history", access: "read-only" },
		],
	});
	assert.equal(readFileSync(join(logicalWorkspace, "work", "topic-plan.json"), "utf-8"), "{\n  \"topics\": []\n}\n");
	assert.equal(readFileSync(join(logicalWorkspace, "artifacts", "research.txt"), "utf-8"), "research artifact\n");
	assert.equal(existsSync(join(logicalWorkspace, "artifacts", "main")), false, "shadowed /artifacts/main must stay hidden");
	assert.equal(readFileSync(join(logicalWorkspace, "attachments", "input.txt"), "utf-8"), "attachment\n");
	assert.equal(readFileSync(join(logicalWorkspace, "reports", "Published report", "report.md"), "utf-8"), "# Published report\n");
	assert.equal(
		readFileSync(join(logicalWorkspace, "documents", "cache-key-1", "document.md"), "utf-8"),
		"# Parsed attachment\n",
	);
	assert.ok(existsSync(join(logicalWorkspace, "capabilities", "skills", "topic-plan", "SKILL.md")));
	assert.ok(existsSync(join(logicalWorkspace, "history", "topic-plan.jsonl")));

	sandbox = createMainAgentSandbox(goalDir, session);
	const tool = (name: string) => {
		const found = sandbox!.tools.find((candidate) => candidate.name === name);
		assert.ok(found, `missing ${name} tool`);
		return found;
	};
	const signal = new AbortController().signal;
	const update = () => undefined;
	await assert.doesNotReject(() => tool("bash").execute(
		"nested-writable-workspace",
		{ command: `set -eu
cat > heredoc.txt <<'WORKSPACE_TEXT'
heredoc works
WORKSPACE_TEXT
python - <<'WORKSPACE_PYTHON'
import errno, os
from pathlib import Path
assert Path(os.getcwd()).is_dir()
assert Path("heredoc.txt").read_text() == "heredoc works\\n"
Path("python.txt").write_text("python works\\n")
assert Path("python.txt").read_text() == "python works\\n"
artifact = Path("/artifacts/research.txt")
assert artifact.read_text() == "research artifact\\n"
try:
    artifact.write_text("forbidden")
except OSError as error:
    assert error.errno in (errno.EPERM, errno.EACCES, errno.EROFS)
else:
    raise AssertionError("published sibling must remain read-only")
WORKSPACE_PYTHON` },
		signal,
		update,
	), "the /work mount remains readable and writable inside the read-only /artifacts tree");
	assert.equal(readFileSync(join(session.workDirectory, "python.txt"), "utf8"), "python works\n");
	await assert.rejects(() => tool("read").execute(
		"read-knowledge",
		{ path: "/knowledge/index.md", offset: 1, limit: 20 },
		signal,
		update,
	));
	await assert.rejects(() => tool("read").execute(
		"read-user",
		{ path: "/user/USER.md", offset: 1, limit: 20 },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("read").execute(
		"read-artifact",
		{ path: "/artifacts/research.txt", offset: 1, limit: 20 },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("read").execute(
		"read-attachment",
		{ path: "/attachments/input.txt", offset: 1, limit: 20 },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("read").execute(
		"read-parsed-document",
		{ path: "/documents/cache-key-1/document.md", offset: 1, limit: 20 },
		signal,
		update,
	));
	await assert.rejects(() => tool("write").execute(
		"write-parsed-document",
		{ path: "/documents/cache-key-1/document.md", content: "forbidden\n" },
		signal,
		update,
	));
	const listedReports = await tool("ls").execute("list-reports", { path: "/reports" }, signal, update);
	assert.match(JSON.stringify(listedReports.content), /Published report/u,
		"one ls of /reports names every published report by its title");
	await assert.doesNotReject(() => tool("read").execute(
		"read-report",
		{ path: "/reports/Published report/report.md", offset: 1, limit: 20 },
		signal,
		update,
	));
	await assert.rejects(() => tool("write").execute(
		"write-report",
		{ path: "/reports/Published report/report.md", content: "forbidden\n" },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("ls").execute(
		"list-capability-skills",
		{ path: "/capabilities/skills" },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("read").execute(
		"read-capability-skill",
		{ path: "/capabilities/skills/note-organizer/SKILL.md", offset: 1, limit: 40 },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("read").execute(
		"read-topic-plan-skill",
		{ path: "/capabilities/skills/topic-plan/SKILL.md", offset: 1, limit: 80 },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("read").execute(
		"read-wiki-knowledge-skill",
		{ path: "/capabilities/skills/wiki-knowledge/SKILL.md", offset: 1, limit: 80 },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("read").execute(
		"read-report-products-skill",
		{ path: "/capabilities/skills/report-products/SKILL.md", offset: 1, limit: 80 },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("read").execute(
		"read-research-monitoring-skill",
		{ path: "/capabilities/skills/research-monitoring/SKILL.md", offset: 1, limit: 80 },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("read").execute(
		"read-user-memory-skill",
		{ path: "/capabilities/skills/user-memory/SKILL.md", offset: 1, limit: 80 },
		signal,
		update,
	));
	await assert.rejects(() => tool("read").execute(
		"read-shadowed-main",
		{ path: "/artifacts/main", offset: 1, limit: 20 },
		signal,
		update,
	));
	await assert.rejects(() => tool("read").execute(
		"read-unmounted-harness",
		{ path: "/skills/main-agent/note-organizer/SKILL.md", offset: 1, limit: 20 },
		signal,
		update,
	));
	await assert.rejects(() => tool("write").execute(
		"write-knowledge",
		{ path: "/knowledge/forbidden.md", content: "forbidden\n" },
		signal,
		update,
	));
	await assert.rejects(() => tool("write").execute(
		"write-capability",
		{ path: "/capabilities/skills/forbidden.md", content: "forbidden\n" },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("write").execute(
		"write-work",
		{ path: "/work/notes/sandbox.md", content: "# Sandboxed\n" },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("read").execute(
		"read-topic-document",
		{ path: "/work/topic-plan.json", offset: 1, limit: 80 },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("bash").execute(
		"list-reports-in-shell",
		{ command: "ls /reports | grep -qx 'Published report' && grep -q 'Published report' '/reports/Published report/report.md'" },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("bash").execute(
		"topic-history",
		{ command: "test -f /history/topic-plan.jsonl" },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("write").execute(
		"write-topic-document",
		{ path: "/work/topic-plan.json", content: `${JSON.stringify({
			topics: [{ title: "语音生成", intent: "关注语音生成算法。" }],
		}, null, 2)}\n` },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("bash").execute(
		"mount-boundary",
		{ command: "test ! -e /.git && test ! -e /skills && test ! -e /wiki && test -r /attachments/input.txt" },
		signal,
		update,
	));
	await assert.doesNotReject(() => tool("bash").execute(
		"project-python",
		{
			command: "python -c 'import os, site, sys; assert sys.prefix == os.environ[\"VIRTUAL_ENV\"]; assert not site.ENABLE_USER_SITE'"
				+ " && python3 -c 'import os, sys; assert sys.prefix == os.environ[\"VIRTUAL_ENV\"]'",
		},
		signal,
		update,
	));
	await assert.rejects(() => tool("bash").execute(
		"network-denied",
		{
			command: "if command -v wget >/dev/null; then wget -qO- -T 2 http://blocked.test; else curl -fsS --max-time 2 http://blocked.test; fi",
		},
		signal,
		update,
	));

	await sandbox.close();
	sandbox = undefined;
	const result = await runtime.publish(session.id);
	assert.equal(result.status, "published");
	assert.equal(
		readFileSync(join(goalDir, "artifacts", "main", "notes", "sandbox.md"), "utf-8"),
		"# Sandboxed\n",
	);
	assert.equal(existsSync(join(goalDir, TOPIC_PLAN_DOCUMENT_PATH)), false,
		"publishing a draft must not replace the confirmed Topic Plan");
	assert.ok(result.topicPlanDraft);
	const topicStore = new GoalTopicPlanStore(goalId, dataDir);
	const proposal = topicStore.syncDocument({
		document: result.topicPlanDraft,
		source: "main_agent",
		summary: "建立语音生成 Topic",
	}).proposal!;
	const pendingSession = runtime.prepare({ conversationId: "pending-topic-revision" });
	const pendingDocument = parseGoalTopicDocument(readFileSync(
		join(pendingSession.workDirectory, "topic-plan.json"),
		"utf-8",
	));
	assert.deepEqual(
		pendingDocument.topics.map((topic) => topic.id),
		[undefined],
		"unconfirmed Topics exposed draft IDs that cannot be published",
	);
	assert.doesNotThrow(() => topicStore.syncDocument({
		document: pendingDocument,
		source: "main_agent",
		summary: "继续修改未确认 Topic",
	}));
	await runtime.abort(pendingSession.id);
	const activeTopicPlan = topicStore.activate(proposal.proposal_id);
	assert.deepEqual(
		parseGoalTopicDocument(readFileSync(join(goalDir, TOPIC_PLAN_DOCUMENT_PATH), "utf-8")),
		goalTopicDocumentFromPlan(activeTopicPlan),
	);
	assert.equal(topicStore.readHistory().length, 1);
	const historySession = runtime.prepare({ conversationId: "history-view" });
	const historyView = readFileSync(join(historySession.historyDirectory, "topic-plan.jsonl"), "utf-8").trim();
	const historyEntry = JSON.parse(historyView) as Record<string, unknown>;
	assert.deepEqual(Object.keys(historyEntry).sort(), ["confirmed_at", "plan", "version"],
		"Agent history view exposed Runtime-only confirmation metadata");
	assert.deepEqual(
		parseGoalTopicDocument(readFileSync(join(historySession.workDirectory, "topic-plan.json"), "utf-8")),
		goalTopicDocumentFromPlan(activeTopicPlan),
	);
	await runtime.abort(historySession.id);
	assert.equal(existsSync(join(goalDir, ".git")), false, "publishing a draft must not initialize Goal Git");
	console.log("Main Agent SRT sandbox and filesystem publication tests passed");
} finally {
	await sandbox?.close();
	rmSync(root, { recursive: true, force: true });
}
