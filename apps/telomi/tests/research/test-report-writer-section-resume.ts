// Report Writer 中断后按 Section 续跑：已完成的分节草稿必须保留，其余一律丢弃。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reuseCompletedSections } from "../../server/research/pipeline/index.js";

const root = mkdtempSync(join(tmpdir(), "telomi-writer-resume-"));
const workDirectory = join(root, "work-directory");

const writeFile = (path: string, content: string) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf-8");
};
const section = (id: string, files: Record<string, string>) => {
	for (const [name, content] of Object.entries(files)) {
		writeFile(join(workDirectory, "work", "sections", id, name), content);
	}
};

try {
	writeFile(join(workDirectory, "work", "report-outline.json"), `${JSON.stringify({
		sections: [{ section_id: "intro" }, { section_id: "findings" }, { section_id: "outlook" }],
	})}\n`);

	section("intro", { "draft.md": "# Intro\n", "ledger.md": "- source-1\n" });
	section("findings", { "draft.md": "# Findings\n", "ledger.md": "   \n" });      // ledger 为空 -> 未完成
	section("outlook", { "draft.md": "# Outlook\n" });                              // 缺 ledger -> 未完成
	section("stale", { "draft.md": "# Stale\n", "ledger.md": "- old\n" });          // 不在 Outline 里

	// Runtime 每次重铺的输入，其中包含以只读权限落盘的文件。
	writeFile(join(workDirectory, "runtime", "system-prompt.md"), "stale prompt\n");
	const stagedSkill = join(workDirectory, "runtime", "wiki-report", "SKILL.md");
	writeFile(stagedSkill, "stale skill\n");
	chmodSync(stagedSkill, 0o400);
	writeFile(join(workDirectory, "inputs", "stale-input.json"), "{}\n");
	// 还留在这里说明上一次没有发布成功，半截 manifest 会误导 Worker。
	writeFile(join(workDirectory, "writer-output", "manifest.json"), '{"schema_version":1}\n');
	writeFile(join(workDirectory, "work", "scratch.md"), "throwaway\n");

	const completed = reuseCompletedSections(workDirectory);

	assert.deepEqual(completed, ["intro"], "只有 draft.md 与 ledger.md 都非空、且在 Outline 内的 Section 算完成");
	assert.deepEqual(readdirSync(workDirectory), ["work"], "runtime/ inputs/ writer-output/ 必须全部清掉");
	assert.deepEqual(readdirSync(join(workDirectory, "work")), ["report-outline.json", "sections"]);
	assert.deepEqual(readdirSync(join(workDirectory, "work", "sections")), ["intro"]);
	assert.ok(existsSync(join(workDirectory, "work", "sections", "intro", "draft.md")));

	// 中断也可能发生在 Agent 建出 work/sections 之前：清扫仍然要执行，
	// 否则只读的 runtime/ 残留会让下一次重铺直接 EACCES。
	rmSync(workDirectory, { recursive: true, force: true });
	const earlyCrashSkill = join(workDirectory, "runtime", "wiki-report", "SKILL.md");
	writeFile(earlyCrashSkill, "stale skill\n");
	chmodSync(earlyCrashSkill, 0o400);
	assert.deepEqual(reuseCompletedSections(workDirectory), []);
	assert.deepEqual(readdirSync(workDirectory), [], "早期中断的残留同样必须清掉");

	// Writer 必须复用上一次由同一个 Root 写在 work/ 下的大纲。
	rmSync(workDirectory, { recursive: true, force: true });
	writeFile(join(workDirectory, "work", "report-outline.json"), `${JSON.stringify({
		sections: [{ section_id: "section-001" }, { section_id: "section-002" }],
	})}\n`);
	section("section-001", { "draft.md": "Done\n", "ledger.md": "N1\n" });
	section("section-002", { "draft.md": "Partial\n" });
	assert.deepEqual(reuseCompletedSections(workDirectory), ["section-001"]);
	assert.ok(existsSync(join(workDirectory, "work", "report-outline.json")),
		"Writer-authored outline must survive resume cleanup");
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("Report Writer section resume test passed");
