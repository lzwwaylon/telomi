import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reviewAuditHasPool, reviewAuditPath, submitProviderCandidateLedger, validatePrimeSearchCandidateLedger } from "../../server/research/pipeline/prime-search-contract.js";

// A Ledger records the discovery pools its child was served; Runtime checks their shape and holds the child to no retained set.
const root = mkdtempSync(join(tmpdir(), "prime-ledger-discovery-"));
try {
	const child = "sub-discovery";
	const workspace = join(root, "provider-executions", child);
	mkdirSync(join(workspace, "work"), { recursive: true });
	mkdirSync(join(workspace, "artifacts", "github"), { recursive: true });
	writeFileSync(join(workspace, "artifacts", "github", "a.json"), "{}\n");
	const ledgerPath = join(workspace, "work", "github_candidates.json");
	const url = (name: string) => `https://github.com/org/${name}`;
	const candidate = { title: "org/a", url: url("a"), query: "discover_repositories(topics=['topic'])", summary: "A speech model.", metadata: {}, material_paths: ["artifacts/github/a.json"] };
	const pool = { provider: "github", key: "k", size: 3, served: 2, urls: [url("a"), url("b"), url("c")] };
	const write = (discovery?: unknown) => writeFileSync(ledgerPath, `${JSON.stringify({ candidates: [candidate], ...(discovery === undefined ? {} : { discovery }) })}\n`);
	const validate = () => validatePrimeSearchCandidateLedger(workspace, "github", ledgerPath, child);

	write();
	validate(); // a task without discovery records no pool
	for (const [discovery, message] of [
		[{ pools: [pool], reviewed: { attempt: "a1" } }, /discovery must contain exactly pools/u],
		[{ pools: [{ ...pool, served: 4 }] }, /size, served and urls disagree/u],
		[{ pools: [{ ...pool, urls: ["org/a", url("b"), url("c")] }] }, /urls\[0\] must be HTTP\(S\)/u],
	] as const) {
		write(discovery);
		assert.throws(validate, message);
	}

	// What the child retains from a pool is its own judgment: one record of three, with a page left unread.
	write({ pools: [pool] });
	await submitProviderCandidateLedger(root, child, "github");
	const frozen = JSON.parse(readFileSync(ledgerPath, "utf8")) as { discovery: unknown; candidates: Array<{ candidate_ref: string }> };
	assert.deepEqual(frozen.discovery, { pools: [pool] });
	assert.equal(frozen.candidates[0]!.candidate_ref, "C-github-sub-discovery-001");

	// Each discovery call names a new attempt; window lines of an attempt are not a pool.
	const audit = reviewAuditPath(root, child);
	writeFileSync(audit, `${JSON.stringify({ attempt: "a1", pool: { records: [] } })}\n${JSON.stringify({ attempt: "a2", window_id: "w1", verdicts: [] })}\n`);
	assert.deepEqual(["a1", "a2", "a3"].map((attempt) => reviewAuditHasPool(audit, attempt)), [true, false, false]);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("Prime Candidate Ledger discovery pool validation passed");
