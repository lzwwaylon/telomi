/**
 * 沙箱 × 跨卷 × CoW 物化 的兼容性验证。
 *
 * 回答两个问题：
 *   1) 真实文件放在另一块物理盘时，Agent 的逻辑路径还成立吗
 *   2) CoW 物化出来的目录与现有 SrtWorkspace 的映射机制冲突吗
 *
 * 用的是生产的 store/cow.ts，所以这个脚本同时也是它的回归测试：
 *   npm run test:sandbox-crossvolume
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSandboxExecutionSpec } from "../../../extensions/telomi-srt/sandbox-spec.js";
import { SrtWorkspace } from "../../../extensions/telomi-srt/tool-operations.js";
import { execSrt } from "../../../extensions/telomi-srt/runtime.js";
import { cloneDirectoryContents } from "../../server/lib/cow.js";

const externalVolume = process.env.TELOMI_TEST_CROSS_VOLUME_ROOT;
if (!externalVolume) {
	console.log("SKIP: set TELOMI_TEST_CROSS_VOLUME_ROOT to an external volume");
	process.exit(0);
}
const ROOT = join(externalVolume, "pi-sandbox-experiment");
const results: Array<[string, boolean, string]> = [];
function check(label: string, passed: boolean, detail = ""): void {
	results.push([label, passed, detail]);
	console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, "seed", "docs"), { recursive: true });
writeFileSync(join(ROOT, "seed", "README.md"), "magpie tts multilingual\n");
writeFileSync(join(ROOT, "seed", "docs", "note.txt"), "second file\n");

const agentRoot = join(ROOT, "agent");
const sourceMount = join(agentRoot, "artifacts", "github", "repo");
const workMount = join(agentRoot, "work");
mkdirSync(workMount, { recursive: true });
mkdirSync(sourceMount, { recursive: true });
const materialized = cloneDirectoryContents(join(ROOT, "seed"), sourceMount);

console.log("== 卷与物化 ==");
const volAgent = statSync(agentRoot).dev;
const volTmp = statSync(tmpdir()).dev;
check("Agent 工作区与素材源同卷", statSync(join(ROOT, "seed")).dev === volAgent);
check("Agent 工作区与系统 tmpdir 不同卷", volTmp !== volAgent, `tmp dev=${volTmp} agent dev=${volAgent}`);
check("物化走的是 clonefile", materialized === "clone", materialized);
const cloned = execFileSync("/usr/bin/stat", ["-f", "%l", join(sourceMount, "README.md")], { encoding: "utf-8" }).trim();
check("物化产物是普通文件（不是 symlink，links=1）", cloned === "1", `links=${cloned}`);

console.log("\n== SrtWorkspace 逻辑路径映射 ==");
const spec = parseSandboxExecutionSpec({
	version: 1,
	id: "crossvolume-probe",
	role: "main.goal_agent",
	sessionLabel: "crossvolume-probe",
	hostCwd: workMount,
	guestCwd: "/work",
	mounts: [
		{ hostPath: workMount, guestPath: "/work", access: "read-write" },
		{ hostPath: sourceMount, guestPath: "/source", access: "read-only" },
	],
	activeTools: ["read", "ls", "grep", "bash"],
	env: { HOME: "/tmp" },
	network: { mode: "deny" },
	writablePaths: [{ guestPath: "/work", kind: "tree" }],
});
const workspace = new SrtWorkspace(spec);
try {
	check("别名根落在 tmpdir（另一卷）", statSync(workspace.aliasesRoot).dev === volTmp);
	const host = workspace.hostPath("/source/README.md");
	check("guest -> host 翻译正确", host === join(sourceMount, "README.md"), host);
	check("跨卷 realpath 校验未误杀", readFileSync(host, "utf-8").startsWith("magpie"));
	let readOnlyRejected = false;
	try { workspace.hostPath("/source/README.md", "write"); } catch { readOnlyRejected = true; }
	check("只读挂载拒绝写入翻译", readOnlyRejected);
	const rewritten = workspace.command("cat /source/docs/note.txt");
	check("命令里的 guest 路径被改写成别名", rewritten.includes(workspace.aliasesRoot), rewritten);

	console.log("\n== 真实沙箱进程（seatbelt 策略生效）==");
	const run = async (label: string, script: string): Promise<number> => {
		let output = "";
		const { exitCode } = await execSrt({
			command: `/usr/bin/env python3 -c ${JSON.stringify(script)}`,
			cwd: workMount,
			env: workspace.env(),
			policy: workspace.policy,
			timeoutSeconds: 30,
			onData: (chunk) => { output += chunk.toString(); },
		});
		console.log(`     [${label}] exit=${exitCode} ${output.trim().slice(0, 120)}`);
		return exitCode;
	};
	const runRaw = async (label: string, command: string): Promise<number> => {
		let output = "";
		const { exitCode } = await execSrt({
			command, cwd: workMount, env: workspace.env(), policy: workspace.policy,
			timeoutSeconds: 30, onData: (chunk) => { output += chunk.toString(); },
		});
		console.log(`     [${label}] exit=${exitCode} ${output.trim().slice(0, 120)}`);
		return exitCode;
	};
	const alias = (guest: string) => workspace.command(guest);
	const readCode = await run("读 /source", `print(open(${JSON.stringify(alias("/source/README.md"))}).read().strip())`);
	check("沙箱内可读跨卷物化文件", readCode === 0);
	const writeWork = await run("写 /work", `open(${JSON.stringify(alias("/work/out.txt"))},"w").write("ok"); print("wrote")`);
	check("沙箱内可写 /work", writeWork === 0 && existsSync(join(workMount, "out.txt")));
	const writeSource = await runRaw("写 /source（应被拒）",
		`/bin/sh -c ${JSON.stringify(`echo tampered > ${alias("/source/README.md")}`)}`);
	check("沙箱拒绝写只读挂载", writeSource !== 0, `exit=${writeSource}`);
	const before = readFileSync(join(ROOT, "seed", "README.md"), "utf-8");
	check("seed 未被污染", before.startsWith("magpie"));
} finally {
	workspace.close();
}

console.log(`\n== 汇总: ${results.filter((r) => r[1]).length}/${results.length} 通过 ==`);
if (results.some((r) => !r[1])) process.exitCode = 1;
