import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	DEFAULT_RESEARCH_CONFIG,
	researchConfigFromEnv,
} from "../../server/research/config.js";
import {
	DEFAULT_PRIME_SEARCH_ASSET,
	defaultPrimeSearchHarnessYaml,
} from "../../server/research/harness/prime-search.js";
import { parseResearchRunPolicy } from "../../server/research/harness/run-policy.js";

const appRoot = join(import.meta.dirname, "../..");
const source = (relativePath: string) => readFileSync(join(appRoot, relativePath), "utf-8");

for (const removedKey of [
	"topK",
	"enforceDocumentLimits",
	"maxOutlineTurns",
	"enforceOutlineTurnLimit",
	"maxEvidencePerDocument",
	"maxEvidenceCharacters",
	"maxSummaryCharacters",
	"maxDocumentCharacters",
]) {
	assert.equal(removedKey in DEFAULT_RESEARCH_CONFIG, false, `${removedKey} must not remain a production task limit`);
}

assert.equal(DEFAULT_RESEARCH_CONFIG.documentConcurrency, 4);
assert.equal(researchConfigFromEnv({ TELOMI_RESEARCH_CORNELL_NOTE_MODEL: "test/model" }).documentConcurrency, 4);
assert.equal(researchConfigFromEnv({ TELOMI_RESEARCH_CORNELL_NOTE_MODEL: "test/model", TELOMI_RESEARCH_DOCUMENT_CONCURRENCY: "32" }).documentConcurrency, 32);
assert.throws(() => researchConfigFromEnv({ TELOMI_RESEARCH_CORNELL_NOTE_MODEL: "test/model", TELOMI_RESEARCH_DOCUMENT_CONCURRENCY: "33" }),
	/TELOMI_RESEARCH_DOCUMENT_CONCURRENCY must be an integer from 1 to 32/u);
const policyYaml = (documentConcurrency: number) => `kind: pi_research_run_policy
contract_version: 1
id: concurrency-test
version: 1
config:
  documentConcurrency: ${documentConcurrency}
`;
assert.equal(parseResearchRunPolicy(policyYaml(32)).configOverrides.documentConcurrency, 32);
assert.throws(() => parseResearchRunPolicy(policyYaml(33)), /from 1 to 32/u);

assert.equal("budgets" in DEFAULT_PRIME_SEARCH_ASSET, false, "Prime Search task budgets must not remain configurable");
assert.doesNotMatch(defaultPrimeSearchHarnessYaml(), /\bbudgets:/u);

assert.doesNotMatch(source("server/research/workspace-adapter.ts"), /timeoutMs:\s*5\s*\*\s*60/u);
assert.doesNotMatch(
	source("server/agent-runtime/srt-agent-sandbox.ts"),
	/\btimeout\s*:/u,
	"Report Agent bash execution must inherit cancellation only and must not impose a wall-clock timeout",
);
for (const runtimePath of [
	"server/agent-runtime/agent-stage-runtime.ts",
	"server/agent-runtime/models/model-policy.ts",
	"server/agent-runtime/models/model-gateway.ts",
	"server/providers/source-service-client.ts",
]) {
	const runtimeSource = source(runtimePath);
	assert.doesNotMatch(runtimeSource, /\btimeoutMs\b/u, `${runtimePath} must not expose a wall-clock timeout parameter`);
	assert.doesNotMatch(runtimeSource, /AbortSignal\.timeout/u, `${runtimePath} must not synthesize a wall-clock deadline`);
}
assert.doesNotMatch(source("server/research/provider-sdk-assets.ts"), /PROCESS_TIMEOUT_SECONDS/u);
assert.doesNotMatch(source("server/research/python-tools/research_runtime.py"), /urlopen\(request,\s*timeout=/u);
for (const servicePath of [
	"services/research-source-service/src/research_source_service/config.py",
	"services/research-source-service/src/research_source_service/app.py",
	"services/research-source-service/src/research_source_service/http_client.py",
	"services/research-source-service/src/research_source_service/sources/arxiv.py",
]) {
	assert.doesNotMatch(source(servicePath), /timeout_seconds|request_timeout_seconds|connect_timeout_seconds/u,
		`${servicePath} must not expose a Provider wall-clock timeout parameter`);
}
assert.doesNotMatch(
	source("services/research-source-service/src/research_source_service/sources/general_web.py"),
	/["']timeout["']\s*:/u,
	"General Web Provider requests must not pass an upstream wall-clock timeout",
);
for (const providerPath of [
	"server/research/sources/providers/youtube/ytdlp-runner.ts",
	"server/research/sources/providers/youtube/media-extractor.ts",
]) {
	const providerSource = source(providerPath);
	assert.doesNotMatch(providerSource, /\btimeoutMs\b|AbortSignal\.timeout|REQUEST_TIMEOUT_MS|DEFAULT_TIMEOUT_MS/u,
		`${providerPath} must not impose a Provider wall-clock timeout`);
}
assert.match(source("server/app.ts"), /httpServer\.requestTimeout\s*=\s*0/u);
assert.match(source("server/app.ts"), /httpServer\.headersTimeout\s*=\s*0/u);

console.log("Research Runtime unbounded task-complexity regression tests passed");
