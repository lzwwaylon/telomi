import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChildCaseFile } from "../../server/evaluation/provider-child-case.js";

/** Captured child prerequisites for deterministic trigger fixtures. */
export function replayableChildFiles(root: string, resultPath: string): ChildCaseFile[] {
	const files: ChildCaseFile[] = [{ ref: "output:result.json", kind: "observed_output", absolutePath: resultPath, sha256: "", byteLength: 0 }];
	const write = (ref: string, kind: string, content: string) => {
		const path = join(root, ref.replace(":", "/"));
		mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
		files.push({ ref, kind, absolutePath: path, sha256: "", byteLength: Buffer.byteLength(content) });
	};
	write("input:request.json", "input", JSON.stringify({ temporal_context: { schemaVersion: 1, currentDate: "2026-09-01", timeZone: "UTC" } }));
	const conditions = [];
	const result = JSON.parse(readFileSync(resultPath, "utf-8"));
	for (const record of result.execution_records ?? []) {
		const childId = record.execution_id.split(":").at(-1);
		write(`output:logical-workspaces/provider/${childId}/workspace/work/.execution-id`, "observed_output", childId);
		write(`output:logical-workspaces/provider/${childId}/workspace/skills/provider-workers/${record.provider_id}/test-provider-skill/SKILL.md`, "observed_output", "---\nname: test-provider-skill\ndescription: Test provider\n---\n");
		write(`run:prime-search-traces/1/acquisition-session/session-artifacts/${childId}/session.jsonl`, "child_trace", [
			{ type: "session", rlmDepth: 1 },
			{ type: "model_change", provider: "test", modelId: "child" },
			{ type: "thinking_level_change", thinkingLevel: "medium" },
			{ type: "custom_message", customType: "agent_message", details: { fromRelationship: "parent" }, content: "Read the assigned evidence." },
		].map((r) => JSON.stringify(r)).join("\n"));
		conditions.push({ agent_session_id: childId, tools: ["ipython", "submit_candidate_ledger"], custom_tools: ["submit_candidate_ledger"], skills: { items: [{ name: "prime-browser-provider-skill", sha256: "abc" }] } });
	}
	write("run:prime-search-traces/1/execution-conditions.jsonl", "execution_conditions", conditions.map((r) => JSON.stringify(r)).join("\n"));
	return files;
}
