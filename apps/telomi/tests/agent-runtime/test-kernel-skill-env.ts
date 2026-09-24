/**
 * Agent Skill 读的环境变量必须是 IPython Kernel 真的会继承的那些。
 *
 * Kernel 由 telomi-srt 用白名单起进程：名字不在白名单里的变量在 Worker 进程里明明存在，
 * 到 Kernel 就没了，Skill 于是在运行时才发现自己"没有配置"。这条检查把该失败提前到提交前，
 * 并且对以后每一个新的 bridged Skill 同样成立。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const KERNEL_LAUNCHER = fileURLToPath(new URL("../../../extensions/telomi-srt/srt-python.mjs", import.meta.url));
const AGENT_SKILL_SOURCES = "agents/**/src/**/*.py";

const launcher = readFileSync(KERNEL_LAUNCHER, "utf-8");
const filter = /function kernelEnv\(env\) \{[\s\S]*?\n\}/u.exec(launcher);
assert.ok(filter, "srt-python.mjs must define the kernelEnv filter this test reads");
const exactNames = new Set([...filter[0].matchAll(/"([A-Z_][A-Z0-9_]*)"/gu)].map((match) => match[1]!));
const prefixes = [...filter[0].matchAll(/startsWith\("([A-Z_]+)"\)/gu)].map((match) => match[1]!);
assert.ok(prefixes.length > 0, "the kernel env filter must forward at least one prefix");

const sources = globSync(AGENT_SKILL_SOURCES);
assert.ok(sources.length > 0, `no Agent Skill Python sources matched ${AGENT_SKILL_SOURCES}`);
let checked = 0;
for (const source of sources) {
	const content = readFileSync(source, "utf-8");
	for (const match of content.matchAll(/os\.environ(?:\.get\(|\[)"([A-Z_][A-Z0-9_]*)"/gu)) {
		const name = match[1]!;
		checked += 1;
		assert.ok(
			exactNames.has(name) || prefixes.some((prefix) => name.startsWith(prefix)),
			`${source} reads '${name}', which the IPython Kernel does not inherit; `
			+ `use one of the forwarded prefixes (${prefixes.join(", ")})`,
		);
	}
}

console.log(`Agent Skill Kernel environment reads are forwarded by telomi-srt (${checked} 个变量, ${sources.length} 个文件)`);
