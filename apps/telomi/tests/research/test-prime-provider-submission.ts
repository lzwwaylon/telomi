import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as contracts from "../../server/research/pipeline/prime-search-contract.js";

// Execute the production submission Tool, without a model or an upstream request.
const root = mkdtempSync(join(tmpdir(), "prime-provider-submission-"));
try {
	const child = "sub-submission";
	const work = join(root, "provider-executions", child, "work");
	mkdirSync(work, { recursive: true });
	const tool = contracts.createPrimeSearchContractTools(root)[0]!;
	const context = { sessionManager: { getSessionDir: () => join(root, "sessions", child) } } as never;
	const submit = () => tool.execute("submit", { provider_id: "github" }, undefined, undefined, context);
	writeFileSync(join(work, "github-candidates.json"), '{"candidates":[]}\n');
	await assert.rejects(submit(), (error: unknown) => {
		const failure = error as { code?: string; details?: { expected_path?: string } };
		assert.equal(failure.code, "candidate_ledger_missing");
		assert.equal(failure.details?.expected_path, "work/github_candidates.json");
		return true;
	});
	assert.equal(existsSync(join(work, ".provider-assignment")), false);
	writeFileSync(join(work, "github_candidates.json"), '{"candidates":[]}\n');
	await submit();
	assert.equal(readFileSync(join(work, ".provider-assignment"), "utf8"), "github\n");
	const receipt = contracts.primeProviderSubmission(root, child)!;
	assert.equal(receipt.provider_id, "github");
	assert.equal(contracts.primeProviderSubmission(root, child, "arxiv"), undefined);
	assert.deepEqual(contracts.primeProviderAssignments(root).map((entry) => entry.childId), [child]);
	await submit(); // An unchanged final submission is idempotent.
	assert.deepEqual(contracts.primeProviderSubmission(root, child), receipt);
	writeFileSync(join(work, "arxiv_candidates.json"), '{"candidates":[]}\n');
	await assert.rejects(tool.execute("wrong-provider", { provider_id: "arxiv" }, undefined, undefined, context),
		(error: unknown) => (error as { code?: string }).code === "provider_scope_mismatch");
	assert.equal(readFileSync(join(root, ".runtime/provider-bindings", child), "utf8"), "github\n");
	const frozen = readFileSync(receipt.ledger_path);
	writeFileSync(join(work, "github_candidates.json"), '{"candidates":[]}\n');
	assert.throws(() => contracts.primeProviderSubmission(root, child), (error: unknown) =>
		(error as { code?: string }).code === "candidate_ledger_modified_after_submission");
	assert.deepEqual(readFileSync(receipt.ledger_path), frozen, "A mutable draft cannot change final evidence");
	writeFileSync(join(work, "github_candidates.json"), frozen);
	const counterfeit = join(root, "provider-executions", "sub-counterfeit", "work");
	mkdirSync(counterfeit, { recursive: true });
	writeFileSync(join(counterfeit, ".provider-assignment"), "github\n");
	writeFileSync(join(counterfeit, "github_candidates.json"), '{"candidates":[]}\n');
	assert.deepEqual(contracts.primeProviderAssignments(root).map((entry) => entry.childId), [child]);
	const interrupted = join(root, "provider-executions", "sub-write-failure", "work");
	mkdirSync(join(interrupted, ".provider-assignment"), { recursive: true });
	writeFileSync(join(interrupted, "github_candidates.json"), '{"candidates":[]}\n');
	await assert.rejects(tool.execute("write-failure", { provider_id: "github" }, undefined, undefined,
		{ sessionManager: { getSessionDir: () => join(root, "sessions", "sub-write-failure") } } as never));
	assert.equal(contracts.primeProviderSubmission(root, "sub-write-failure"), undefined,
		"An auxiliary file failure cannot leave a committed submission behind a failed Tool result");
	writeFileSync(receipt.ledger_path, "corrupted frozen bytes\n");
	assert.throws(() => contracts.primeProviderSubmission(root, child), (error: unknown) =>
		(error as { code?: string }).code === "provider_submission_corrupt");
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("Prime Provider submission path diagnostics and final receipt passed");
