import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PROVIDER_LIVE_MANIFEST } from "../../scripts/provider-live-manifest.js";
import { ARXIV_OPERATIONS } from "../../server/research/sources/contracts/arxiv.js";
import { GITHUB_OPERATIONS } from "../../server/research/sources/contracts/github.js";
import { HUGGINGFACE_OPERATIONS } from "../../server/research/sources/contracts/huggingface.js";
import { TWITTER_OPERATIONS } from "../../server/research/sources/contracts/twitter.js";
import { YOUTUBE_OPERATIONS } from "../../server/research/sources/contracts/youtube.js";

const expected = {
	arxiv: ARXIV_OPERATIONS,
	github: GITHUB_OPERATIONS,
	huggingface: HUGGINGFACE_OPERATIONS,
	twitter: TWITTER_OPERATIONS,
	user_documents: ["search"],
	youtube: YOUTUBE_OPERATIONS,
};
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
	scripts: Record<string, string>;
};

assert.deepEqual(Object.keys(PROVIDER_LIVE_MANIFEST).sort(), Object.keys(expected).sort());
for (const [providerId, operations] of Object.entries(expected)) {
	const entry = PROVIDER_LIVE_MANIFEST[providerId as keyof typeof PROVIDER_LIVE_MANIFEST];
	const covered = entry.tests.flatMap((test) => test.operations);
	const skipped = entry.skips.map((skip) => skip.operation);
	assert.deepEqual([...new Set([...covered, ...skipped])].sort(), [...operations].sort(), providerId);
	assert.equal(new Set([...covered, ...skipped]).size, covered.length + skipped.length, `${providerId} duplicates coverage`);
	for (const test of entry.tests) assert.ok(packageJson.scripts[test.script], `${providerId} unknown script ${test.script}`);
	for (const skip of entry.skips) assert.ok(skip.reason.trim(), `${providerId} skip reason is required`);
}

const plan = JSON.parse(execFileSync(process.execPath, [
	"--import", "tsx",
	fileURLToPath(new URL("../../scripts/run-provider-live-coverage.ts", import.meta.url)),
	"--provider", "youtube",
	"--list",
], { encoding: "utf-8" })) as {
	providers: string[];
	scripts: string[];
	operations: Record<string, string[]>;
};
assert.deepEqual(plan.providers, ["youtube"]);
assert.deepEqual(plan.scripts, ["test:youtube-public-functions-live", "test:youtube-account-functions-live"]);
assert.deepEqual(plan.operations.youtube.sort(), [...YOUTUBE_OPERATIONS].sort());

console.log("Provider live coverage manifest covers every Python Provider operation");
