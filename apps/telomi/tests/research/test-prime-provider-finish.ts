import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import { ResearchSourceRegistry } from "../../server/research/index.js";
import { startPrimeSourceBridge } from "../../server/research/pipeline/prime-search-batch.js";
import { primeProviderSubmission } from "../../server/research/pipeline/prime-search-contract.js";

// Exercise the HTTP boundary used from IPython, including impersonation and immutable delivery.
const root = mkdtempSync(join(tmpdir(), "prime-provider-finish-"));
const childId = "sub-finish";
const otherId = "sub-other";
const work = join(root, "provider-executions", childId, "work");
mkdirSync(work, { recursive: true });
const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(), new Set(["github", "arxiv"]), {
	workspaceDirectory: root,
	temporalContext: { schemaVersion: 1, currentDate: "2026-10-04", timeZone: "UTC" },
	signal: new AbortController().signal,
}, root, { runDir: join(root, "run"), nodeId: "search", attemptId: "1" });
async function call(body: Record<string, unknown>, authenticatedId = childId, route = "/v1/finish") {
	const response = await fetch(`${bridge.baseUrl}${route}`, {
		method: "POST", headers: { authorization: `Bearer ${primeExecutionToken(bridge.token, authenticatedId)}` },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json() as Record<string, unknown> };
}
try {
	const body = { agent_session_id: childId, provider_id: "github" };
	writeFileSync(join(work, ".execution-id"), `${otherId}\n`);
	assert.equal((await call({ ...body, agent_session_id: otherId })).status, 401,
		"a mutable workspace marker cannot authenticate a different child");
	assert.equal((await call({ ...body, agent_session_id: "root" })).status, 401,
		"a child credential cannot impersonate Root");
	assert.equal((await call(body, "root")).status, 401, "Root cannot impersonate a child");
	assert.equal((await call({ ...body, agent_session_id: "root" }, "root")).status, 422,
		"an authenticated Root cannot submit a Provider Ledger");
	assert.equal((await call({ ...body, child_id: otherId })).status, 422);
	assert.equal((await call({ ...body, workspace_dir: root })).status, 422);
	assert.equal(primeProviderSubmission(root, childId), undefined);
	assert.equal(primeProviderSubmission(root, otherId), undefined);
	const missing = await call(body);
	assert.equal(missing.status, 422);
	assert.equal((missing.body.error as { code: string }).code, "candidate_ledger_missing");
	assert.equal(primeProviderSubmission(root, childId), undefined);
	writeFileSync(join(work, "github_candidates.json"), '{"candidates":[]}\n');
	const submitted = await call(body);
	assert.deepEqual(submitted, { status: 200, body: {
		provider_id: "github", ledger_path: "work/github_candidates.json", submitted: true,
	} });
	assert.deepEqual(await call(body), submitted, "an unchanged final Ledger can be resubmitted");
	const receipt = primeProviderSubmission(root, childId)!;
	const frozen = readFileSync(receipt.ledger_path);
	writeFileSync(join(work, "arxiv_candidates.json"), '{"candidates":[]}\n');
	const mismatch = await call({ ...body, provider_id: "arxiv" });
	assert.equal((mismatch.body.error as { code: string }).code, "provider_scope_mismatch");
	const search = await call({ agent_session_id: childId }, childId, "/v1/search");
	assert.equal((search.body.error as { code: string }).code, "provider_task_completed");
	writeFileSync(join(work, "github_candidates.json"), '{"candidates":[]}\n');
	assert.throws(() => primeProviderSubmission(root, childId), /changed or removed/u);
	assert.deepEqual(readFileSync(receipt.ledger_path), frozen);
} finally {
	await bridge.close();
	rmSync(root, { recursive: true, force: true });
}
console.log("Provider Python finish uses authenticated child scope and preserves final Ledger authority");
