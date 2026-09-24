import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, formatSkillsForPrompt, getPythonSkillRuntimeInfo } from "prime-agent";
import { agentPythonVenv } from "../../server/agent-runtime/agent-python.js";
import { createRlmChildLogicalWorkspaceSnapshotter } from "../../server/agent-runtime/logical-workspace-snapshot.js";
import { primeKernelEnv } from "../../server/agent-runtime/prime-agent-srt.js";
import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import {
	providerChildLogicalWorkspace,
	providerExecutionWorkspace,
	workspaceRelativeSkill,
} from "../../server/research/pipeline/provider-execution-workspace.js";

// Deterministic process integration only: no model or Provider calls.
const fixture = realpathSync(mkdtempSync(join(process.env.TELOMI_TEST_WORKSPACE_PARENT ?? tmpdir(), "prime-workspace-")));
// Deliberately outside the fixture and configured data directory. On macOS this
// also sits outside os.tmpdir(), exposing the old host-directory denylist gap.
const external = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "prime-external-")));
const previousCwd = process.cwd();
try {
	const externalFile = join(external, "canary.txt");
	writeFileSync(externalFile, "external canary\n");
	const root = join(fixture, "agent");
	const skill = join(root, "skills", "demo-skill");
	const runtime = join(fixture, "runtime");
	const sdk = join(runtime, "sdk");
	for (const path of [join(root, "work"), join(skill, "references"), join(skill, "src", "demo_skill"), sdk]) mkdirSync(path, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), "---\nname: demo-skill\ndescription: Workspace test.\n---\nRead references/example.txt.\n");
	writeFileSync(join(skill, "references", "example.txt"), "skill reference\n");
	writeFileSync(join(skill, "pyproject.toml"), '[project]\nname = "demo-skill"\nversion = "0.1.0"\n');
	writeFileSync(join(skill, "src", "demo_skill", "__init__.py"), 'VALUE = "imported skill"\n');
	writeFileSync(join(sdk, "runtime_sdk.py"), 'VALUE = "sdk"\n');
	const parentFile = join(root, "work", "parent.txt");
	const privateFile = join(runtime, "private.txt");
	const otherGoalFile = join(fixture, "other-goal.txt");
	for (const path of [parentFile, privateFile, otherGoalFile]) writeFileSync(path, "private\n");
	const sibling = providerExecutionWorkspace(root, "sub-sibling");
	const siblingFile = join(sibling.absolutePath, "work", "private.txt");
	writeFileSync(siblingFile, "sibling\n");
	const child = providerExecutionWorkspace(root, "sub-browser");
	const escape = join(child.absolutePath, "work", "escape");
	symlinkSync(siblingFile, escape);
	for (const workspace of [root, child.absolutePath]) symlinkSync(external, join(workspace, "work", "external-link"), "dir");
	const venvLink = join(fixture, "python-venv");
	symlinkSync(agentPythonVenv(), venvLink, "dir");
	const env = primeKernelEnv({ cwd: root, readonlyRoots: [join(root, "skills"), sdk], writableRoots: [root],
		privateRoots: [runtime], env: { ...process.env, TELOMI_DATA_DIR: fixture, PRIME_AGENT_KERNEL_VENV: venvLink,
			PRIME_AGENT_KERNEL_PYTHON: join(venvLink, "bin", "python") } });
	assert.equal(env.VIRTUAL_ENV, realpathSync(venvLink), "SRT and Python agree on a linked venv's path");
	const inspectRunner = join(fixture, "inspect-runner.mjs");
	writeFileSync(inspectRunner, `
import assert from "node:assert/strict";
assert.equal(process.env.PRIME_AGENT_SOURCE_TOKEN, undefined);
const target = JSON.parse(Buffer.from(process.env.TELOMI_SRT_TARGET_B64, "base64url").toString("utf8"));
assert.equal(target.env.PRIME_AGENT_SOURCE_TOKEN, ${JSON.stringify(primeExecutionToken("host-bridge-secret", "root"))});
assert.ok(!JSON.stringify(process.env).includes("host-bridge-secret"));
`);
	execFileSync(env.PRIME_AGENT_KERNEL_PYTHON!, ["-c", "pass"], {
		env: { ...env, TELOMI_SRT_KERNEL_RUNNER: inspectRunner, RLM_DEPTH: "0", PRIME_AGENT_SOURCE_TOKEN: "host-bridge-secret" },
	});
	const parentScratchFile = join(root, ".prime-kernel", "private.txt");
	writeFileSync(parentScratchFile, "parent scratch");
	const run = (code: string, childId?: string) => execFileSync(env.PRIME_AGENT_KERNEL_PYTHON!, ["-c", code], {
		encoding: "utf-8",
		env: { ...env, PYTHONPATH: [sdk, join(skill, "src")].join(":"), TELOMI_PROVIDER_EXECUTION_WORKSPACES: "1",
			PRIME_AGENT_SOURCE_TOKEN: "host-bridge-secret",
			RLM_DEPTH: childId ? "1" : "0", ...(childId ? { RLM_SESSION_DIR: join(runtime, "sessions", childId) } : {}) },
	});
	const deny = `
def denied(path, mode="r"):
    try:
        with open(path, mode) as f:
            if mode == "r": f.read()
    except OSError as error:
        import errno
        if error.errno in (errno.EPERM, errno.EACCES, errno.ENOENT) or (mode != "r" and error.errno == errno.EROFS):
            return
        raise
    raise AssertionError("sandbox allowed " + mode + ": " + path)
`;
	const boundaryCheck = `
from pathlib import Path
import os, subprocess, sys, ssl, sqlite3, rlm
${deny}
ssl.create_default_context()
with sqlite3.connect("work/check.sqlite") as db:
    db.execute("create table if not exists probe (value integer)")
    db.execute("insert into probe values (1)")
    assert db.execute("select value from probe").fetchone() == (1,)
for path in [${JSON.stringify(externalFile)}, "work/external-link/canary.txt"]:
    denied(path)
for directory in [${JSON.stringify(external)}, "work/external-link"]:
    try:
        assert "canary.txt" not in os.listdir(directory), "sandbox listed external canary"
    except (PermissionError, FileNotFoundError):
        pass
    assert not any("canary.txt" in files for _, _, files in os.walk(directory)), "sandbox traversed external canary"
`;
	const verifyBoundary = `${boundaryCheck}
subprocess.run([sys.executable, "-c", ${JSON.stringify(boundaryCheck)}], check=True)
`;
	assert.match(run(`
from pathlib import Path
import os, subprocess, sys, runtime_sdk, demo_skill
${verifyBoundary}
assert runtime_sdk.VALUE == "sdk"
assert demo_skill.VALUE == "imported skill"
assert os.environ["PRIME_AGENT_SOURCE_TOKEN"] == ${JSON.stringify(primeExecutionToken("host-bridge-secret", "sub-browser"))}
assert "host-bridge-secret" not in os.environ.values()
assert Path.cwd() == Path(${JSON.stringify(child.absolutePath)})
assert Path(os.environ["TMPDIR"]) == Path.cwd() / ".prime-kernel"
assert Path(os.environ["HOME"]) == Path(os.environ["TMPDIR"])
assert (Path("skills") / "demo-skill" / "references" / "example.txt").read_text() == "skill reference\\n"
Path("work/result.json").write_text("{}")
subprocess.run([sys.executable, "-c", "from pathlib import Path; assert Path('work/result.json').read_text() == '{}'"], check=True)
for path in ${JSON.stringify([parentFile, parentScratchFile, siblingFile, privateFile, otherGoalFile, escape])}:
    denied(path)
denied("skills/demo-skill/SKILL.md", "w")
denied(${JSON.stringify(siblingFile)}, "w")
print("child workspace verified")
`, "sub-browser"), /child workspace verified/);
	assert.equal(readFileSync(join(child.absolutePath, "work", "result.json"), "utf-8"), "{}");
	assert.match(run(`
from pathlib import Path
import os
${verifyBoundary}
assert os.environ["PRIME_AGENT_SOURCE_TOKEN"] == ${JSON.stringify(primeExecutionToken("host-bridge-secret", "root"))}
assert "host-bridge-secret" not in os.environ.values()
assert Path("provider-executions/sub-browser/work/result.json").read_text() == "{}"
denied("skills/demo-skill/SKILL.md", "w")
denied(${JSON.stringify(privateFile)})
denied(${JSON.stringify(otherGoalFile)})
print("root shared result verified")
`), /root shared result verified/);
	assert.notEqual(primeExecutionToken("host-bridge-secret", "root"), primeExecutionToken("host-bridge-secret", "sub-browser"));
	assert.notEqual(primeExecutionToken("host-bridge-secret", "sub-browser"), primeExecutionToken("another-run-secret", "sub-browser"));

	// Exercise the installed native Loader and its Python metadata, not a mock.
	process.chdir(root);
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(runtime, "agent"), additionalSkillPaths: [skill],
		noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		skillsOverride: (current) => ({ ...current, skills: current.skills.map((item) => workspaceRelativeSkill(root, item)) }) });
	await loader.reload();
	const skills = loader.getSkills().skills;
	assert.equal(skills.length, 1);
	assert.equal(skills[0]!.filePath, "skills/demo-skill/SKILL.md");
	assert.match(readFileSync(skills[0]!.filePath, "utf-8"), /references\/example.txt/);
	assert.ok(!formatSkillsForPrompt(skills).includes(fixture));
	assert.equal(getPythonSkillRuntimeInfo(skills)[0]!.packagePath, skill,
		"The host retains the installation path for native Python Skill preparation");
	process.chdir(previousCwd);
	assert.throws(() => workspaceRelativeSkill(root, { filePath: privateFile, baseDir: runtime }), /must be staged/);

	const captures = join(fixture, "captures");
	const capture = createRlmChildLogicalWorkspaceSnapshotter((id) => providerChildLogicalWorkspace(root, id), captures);
	capture({ type: "rlm_child_update", child: { id: "sub-fresh", status: "running" } });
	const captured = join(captures, "provider", "sub-fresh", "workspace");
	assert.equal(readFileSync(join(captured, "skills", "demo-skill", "references", "example.txt"), "utf-8"), "skill reference\n");
	assert.ok(!existsSync(join(captured, "work", "parent.txt")));
	assert.ok(!existsSync(join(captured, "provider-executions")));
	assert.ok(!existsSync(join(captured, ".prime-kernel")));
	writeFileSync(join(root, "provider-executions", "sub-fresh", "work", "later.txt"), "later");
	capture({ type: "rlm_child_update", child: { id: "sub-fresh", status: "running" } });
	assert.ok(!existsSync(join(captured, "work", "later.txt")), "Capture stays fixed at Child entry");
	symlinkSync(runtime, join(root, "provider-executions", "sub-escape"));
	assert.throws(() => providerExecutionWorkspace(root, "sub-escape"), /real directories/);
	assert.ok(!existsSync(join(runtime, "work")), "Reject the workspace link before provisioning its children");
	const policy = JSON.parse(Buffer.from(env.TELOMI_SRT_KERNEL_POLICY_B64!, "base64url").toString("utf8"));
	assert.ok(policy.filesystem.denyRead.includes("/"), "Kernel denies host reads by default on every platform");
	console.log("Prime workspace: native Python, subprocess, external read/traversal isolation, readonly Skills, sibling isolation, Loader and Case capture passed");
} finally {
	process.chdir(previousCwd);
	rmSync(fixture, { recursive: true, force: true });
	rmSync(external, { recursive: true, force: true });
}
