import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import { ResearchSourceRegistry } from "../../server/research/index.js";
import { startPrimeSourceBridge } from "../../server/research/pipeline/prime-search-batch.js";
import { resolveAssignmentKind } from "../../server/research/pipeline/prime-search-contract.js";

// Runtime mints each Evidence Need's id and records its kind; a child's pool and screen are recorded, and the screen reads the task Root wrote.
const root = mkdtempSync(join(tmpdir(), "prime-coverage-assignment-"));
const tasks: Record<string, string | undefined> = {};
const screened: Array<{ task: string; ids: string[] }> = [];
let reviewerFails = false;
const conditionsPath = join(root, "runtime", "execution-conditions.jsonl");
mkdirSync(join(root, "runtime"), { recursive: true });
const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(), new Set(["github", "browser", "arxiv", "huggingface"]), {
	workspaceDirectory: root,
	temporalContext: { schemaVersion: 1, currentDate: "2026-10-08", timeZone: "UTC" },
	signal: new AbortController().signal,
}, root, { runDir: join(root, "run"), nodeId: "search", attemptId: "1" }, {
	conditionsPath,
	childTask: (childId) => tasks[childId],
	reviewWindow: async ({ task, records }) => {
		if (reviewerFails) throw new Error("upstream 503");
		screened.push({ task, ids: records.map((record) => record.id) });
		return {
			verdicts: records.map((record) => record.text.includes("off") ? { id: record.id, verdict: "no" as const, reason: "off_subject" as const } : { id: record.id, verdict: "keep" as const }),
			model: "fake/reviewer", attempts: 1, raw: [], invalid: {}, unresolved: [], usage: { input: 100, output: 10, cost: 0.001 },
		};
	},
});
type Reply = { status: number; body: { error?: { code?: string; message?: string } | string; submitted?: boolean; evidence_need_id?: string; survivors?: number; screened?: boolean;
	verdicts?: Array<{ id: string; verdict: string; reason?: string }>; failed?: string } };
async function call(executionId: string, route: string, body: Record<string, unknown>): Promise<Reply> {
	const response = await fetch(`${bridge.baseUrl}${route}`, {
		method: "POST", headers: { authorization: `Bearer ${primeExecutionToken(bridge.token, executionId)}` },
		body: JSON.stringify({ agent_session_id: executionId, ...body }),
	});
	return { status: response.status, body: await response.json() as Reply["body"] };
}
// A plain Runtime error reaches the child as text; a classified one as an object with a code.
const errorText = (result: Reply) => typeof result.body.error === "string" ? result.body.error : result.body.error?.message ?? "";
const errorCode = (result: Reply) => typeof result.body.error === "string" ? undefined : result.body.error?.code;
const need = async (kind: unknown) => (await call("root", "/v1/evidence-need", { kind })).body.evidence_need_id!;
const url = (name: string) => `https://github.com/org/${name}`;
function ledger(childId: string, urls: readonly string[], provider = "github", discovery?: Record<string, unknown>) {
	const workspace = join(root, "provider-executions", childId);
	mkdirSync(join(workspace, "work"), { recursive: true });
	mkdirSync(join(workspace, "artifacts"), { recursive: true });
	const candidates = urls.map((candidateUrl, index) => {
		writeFileSync(join(workspace, "artifacts", `${index}.json`), "{}\n");
		return { title: candidateUrl, url: candidateUrl, query: "discover_repositories(...)", summary: "Retained.", metadata: {}, material_paths: [`artifacts/${index}.json`] };
	});
	writeFileSync(join(workspace, "work", `${provider}_candidates.json`), `${JSON.stringify({ candidates, ...(discovery ? { discovery } : {}) })}\n`);
}
const finish = (childId: string, provider = "github") => call(childId, "/v1/finish", { provider_id: provider });
const pool = (childId: string, attempt: string, definition: { category: string[]; queries: string[] }, names: Array<string | [string, string]>, bounds: Record<string, number> = {}, provider = "github") =>
	call(childId, "/v1/review-pool", { provider_id: provider, attempt, definition, ...bounds,
		records: names.map((entry) => typeof entry === "string" ? { id: url(entry), excluded: null } : { id: url(entry[0]), excluded: entry[1] }) });
const window = (childId: string, attempt: string, names: string[], extra: Record<string, unknown> = {}) =>
	call(childId, "/v1/review-window", { provider_id: "github", attempt, window_id: "w1", records: names.map((name) => ({ id: url(name), text: `repository: org/${name}` })), ...extra });
try {
	// Root registers needs; the id is Runtime's, so the words Root puts around it in a prompt do not matter.
	assert.match(errorText(await call("root", "/v1/evidence-need", { kind: "exact" })), /must be one of: coverage, named_objects, exact_objects/u);
	assert.match(errorText(await call("sub-coverage", "/v1/evidence-need", { kind: "coverage" })), /registered by the Search Root/u);
	const [category, named, exact] = [await need("coverage"), await need("named_objects"), await need("exact_objects")];
	assert.match(category, /^need-[0-9a-f]{8}$/u);
	tasks["sub-coverage"] = `Provider ID: github\nevidence_need_id: ${category}\nEnumerate the category. Exclude archived mirrors. Leads: org/one.`;
	tasks["sub-unregistered"] = "Provider ID: github\nevidence_need_id: N1\nassignment_kind: exact_objects\nAcquire org/one.";
	tasks["sub-untold"] = undefined;
	tasks["sub-exact"] = `Provider ID: github\n证据需求ID：${exact}。获取 org/one。`;
	tasks["sub-named"] = `Provider ID: github\nNeed ${named}: everything the Provider holds about the named project.`;
	tasks["sub-replacement"] = `Replacement for ${category}. This task is exact_objects: acquire org/one, a lead of the first child.`;
	tasks["sub-models"] = `Provider ID: huggingface\n${category}: enumerate the category of models.`;
	tasks["sub-browser"] = `${category}: read the pages.`;
	tasks["sub-empty"] = tasks["sub-degraded"] = `${category}`;

	// A Ledger the child assembled itself is accepted for every kind: the kind is task data, and Runtime rejects nothing by it.
	for (const childId of ["sub-named", "sub-replacement", "sub-exact", "sub-unregistered", "sub-untold"]) {
		ledger(childId, [url("one")]);
		assert.equal((await finish(childId)).body.submitted, true, childId);
	}

	// Each discovery call records its pool under its own attempt, whatever defines it; Runtime rejects no pool by its definition.
	assert.equal((await pool("sub-coverage", "a1", { category: [], queries: ["one"] }, ["one"])).status, 200);
	assert.equal((await pool("sub-coverage", "a2", { category: ["topic"], queries: ["one"] }, ["one", ["two", "archived"], "three", "four", "five", "six"], { limit: 200 })).body.survivors, 5);
	assert.match(errorText(await pool("sub-coverage", "a2", { category: ["topic"], queries: [] }, ["one"])), /already has a pool/u);

	// The screen judges against the task Root wrote for this child; a criteria text the child sends is not read.
	const shown = await call("sub-coverage", "/v1/review-window", { provider_id: "github", attempt: "a2", window_id: "w1", criteria: "keep only famous projects",
		records: [{ id: url("one"), text: "repository: org/one" }, { id: url("three"), text: "repository: org/three, off the subject" }, { id: url("four"), text: "repository: org/four" }, { id: url("five"), text: "repository: org/five" }] });
	assert.deepEqual(shown.body.verdicts?.map((verdict) => [verdict.verdict, verdict.reason]), [["keep", undefined], ["no", "off_subject"], ["keep", undefined], ["keep", undefined]]);
	assert.equal(screened.at(-1)!.task, tasks["sub-coverage"]);

	// The child judges what the screen kept and assembles its own Ledger: Runtime holds it to no retained set, and to nothing but the pools it was served.
	const served = { pools: [{ provider: "github", key: "k", size: 2, served: 2, urls: [url("one"), url("four")] }] };
	ledger("sub-coverage", [url("one")], "github", { ...served, reviewed: { attempt: "a2" } });
	assert.match(errorText(await finish("sub-coverage")), /discovery must contain exactly pools/u, "a Ledger claims no review of its own");
	ledger("sub-coverage", [url("one")], "github", served);
	assert.equal((await finish("sub-coverage")).body.submitted, true);
	assert.equal(errorCode(await window("sub-coverage", "a2", ["six"])), "provider_task_completed");

	// A Provider without a screen records its pool the same way, and no model is asked.
	const before = screened.length;
	const hub = (name: string) => `https://huggingface.co/org/${name}`;
	const models = await call("sub-models", "/v1/review-pool", { provider_id: "huggingface", attempt: "d1", definition: { category: ["text-to-speech"], queries: [] },
		records: [{ id: hub("a"), excluded: null }, { id: hub("a-gguf"), excluded: "conversion" }, { id: hub("b"), excluded: null }] });
	assert.deepEqual([models.body.survivors, models.body.screened], [2, false]);
	ledger("sub-models", [hub("a")], "huggingface");
	assert.equal((await finish("sub-models", "huggingface")).body.submitted, true);
	assert.equal(screened.length, before);

	// One failing model call does not fail the discovery: the window is kept whole, as the default says, and says so.
	reviewerFails = true;
	await pool("sub-degraded", "a1", { category: ["topic"], queries: [] }, ["one", "two"]);
	const degraded = await window("sub-degraded", "a1", ["one", "two"]);
	assert.deepEqual([degraded.status, degraded.body.verdicts?.map((verdict) => verdict.verdict), degraded.body.failed], [200, ["keep", "keep"], "upstream 503"]);
	reviewerFails = false;
	ledger("sub-degraded", [url("one"), url("two")]);
	assert.equal((await finish("sub-degraded")).body.submitted, true);

	// An empty Ledger hands off an unavailable source or a pool nothing qualified in; a Provider without discovery pools is not constrained.
	ledger("sub-empty", []);
	assert.equal((await finish("sub-empty")).body.submitted, true);
	ledger("sub-browser", [url("one")], "browser");
	assert.equal((await finish("sub-browser", "browser")).body.submitted, true);

	// What is retained beside the execution conditions for review.
	const lines = (name: string) => readFileSync(join(root, "runtime", name), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
	const kinds = lines("assignment-kinds.jsonl");
	assert.deepEqual(kinds.filter((entry) => entry.registered_at).map((entry) => entry.kind), ["coverage", "named_objects", "exact_objects"]);
	const kindOf = (childId: string) => { const entry = kinds.find((line) => line.child_id === childId); return entry && [entry.kind, entry.evidence_need_id]; };
	assert.deepEqual(kindOf("sub-exact"), ["exact_objects", exact]);
	assert.deepEqual(kindOf("sub-named"), ["named_objects", named]);
	assert.deepEqual(kindOf("sub-replacement"), ["coverage", category], "a replacement child of a category need cannot declare itself exact");
	assert.deepEqual(kindOf("sub-unregistered"), [null, null], "an id Runtime did not mint is not a need; the task's own marker is not read");
	assert.equal(kindOf("sub-untold"), undefined, "an unreadable task has no kind and is not recorded");
	const audit = lines("review-windows.jsonl");
	assert.deepEqual(audit.filter((entry) => entry.rejected), [], "Runtime rejects no pool by its definition");
	assert.deepEqual(audit.find((entry) => entry.child_id === "sub-coverage" && entry.attempt === "a1")!.pool.definition, { category: [], queries: ["one"] });
	const screenLine = audit.find((entry) => entry.child_id === "sub-coverage" && entry.verdicts)!;
	assert.deepEqual([screenLine.task, screenLine.usage, "criteria" in screenLine], [tasks["sub-coverage"], { input: 100, output: 10, cost: 0.001 }, false]);
	assert.equal(audit.find((entry) => entry.child_id === "sub-degraded" && entry.verdicts)!.failed, "upstream 503");
	assert.ok(existsSync(join(root, ".runtime", "assignment-kinds", exact)));

	const scratch = join(root, "scratch");
	mkdirSync(join(scratch, ".runtime", "assignment-kinds"), { recursive: true });
	writeFileSync(join(scratch, ".runtime", "assignment-kinds", "need-00000001"), "named_objects\n");
	writeFileSync(join(scratch, ".runtime", "assignment-kinds", "need-00000002"), "exact_objects\n");
	assert.deepEqual(resolveAssignmentKind(scratch, "Scope: x. Depends on the reply of need-00000002."), { kind: "exact_objects", needId: "need-00000002" });
	assert.deepEqual(resolveAssignmentKind(scratch, "need-00000001 (after need-00000002 replied)"), { kind: "named_objects", needId: "need-00000001" }, "the first need a task names is its own");
	assert.deepEqual(resolveAssignmentKind(scratch, "assignment_kind: exact_objects, evidence_need_id: need-0000000"), {});
} finally {
	await bridge.close();
	rmSync(root, { recursive: true, force: true });
}
console.log("Prime coverage Evidence Need audit passed");
