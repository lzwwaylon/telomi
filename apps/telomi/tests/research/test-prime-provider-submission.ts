import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as contracts from "../../server/research/pipeline/prime-search-contract.js";

// Execute the production Runtime submission, without a model or an upstream request.
const root = mkdtempSync(join(tmpdir(), "prime-provider-submission-"));
try {
	const child = "sub-submission";
	const work = join(root, "provider-executions", child, "work");
	mkdirSync(work, { recursive: true });
	const submit = () => contracts.submitProviderCandidateLedger(root, child, "github");
	await assert.rejects(contracts.submitProviderCandidateLedger(root, "root", "github"), /Only a Prime Search Provider child/u);
	await assert.rejects(contracts.submitProviderCandidateLedger(root, child, "../github"), /Invalid Provider submission identity/u);
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
	await assert.rejects(contracts.submitProviderCandidateLedger(root, child, "arxiv"),
		(error: unknown) => (error as { code?: string }).code === "provider_scope_mismatch");
	assert.equal(readFileSync(join(root, ".runtime/provider-bindings", child), "utf8"), "github\n");
	// A child that rewrites its Ledger file and calls finish again after submitting changes nothing: Runtime restores the submitted contents.
	const frozen = readFileSync(receipt.ledger_path);
	writeFileSync(join(work, "github_candidates.json"), "{}");
	await assert.rejects(submit(), (error: unknown) => {
		const failure = error as { code?: string; message?: string };
		return failure.code === "provider_task_completed" && /already submitted and final; Runtime restored the submitted file/u.test(failure.message ?? "");
	});
	assert.deepEqual(readFileSync(join(work, "github_candidates.json")), frozen, "finish after a rewrite restores the submitted file");
	await submit();
	// A change nobody resubmitted is still detected where the stage reads its submissions.
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
	await assert.rejects(contracts.submitProviderCandidateLedger(root, "sub-write-failure", "github"));
	assert.equal(contracts.primeProviderSubmission(root, "sub-write-failure"), undefined,
		"An auxiliary file failure cannot leave a committed submission behind a failed Runtime response");
	writeFileSync(receipt.ledger_path, "corrupted frozen bytes\n");
	assert.throws(() => contracts.primeProviderSubmission(root, child), (error: unknown) =>
		(error as { code?: string }).code === "provider_submission_corrupt");
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("Prime Provider submission path diagnostics and final receipt passed");
