import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDER_LIVE_MANIFEST, type ProviderLiveId } from "./provider-live-manifest.js";

const target = option("--provider");
const providerIds = Object.keys(PROVIDER_LIVE_MANIFEST) as ProviderLiveId[];
if (!target) throw new Error(`--provider is required (${[...providerIds, "all"].join(", ")})`);
if (target !== "all" && !providerIds.includes(target as ProviderLiveId)) {
	throw new Error(`Unknown Provider '${target}'`);
}

const selected = target === "all" ? providerIds : [target as ProviderLiveId];
const scripts = [...new Set(selected.flatMap((providerId) =>
	PROVIDER_LIVE_MANIFEST[providerId].tests.map((test) => test.script)))];
const plan = {
	schemaVersion: 1,
	kind: "provider-live-coverage",
	providers: selected,
	requirements: Object.fromEntries(selected.map((providerId) => [
		providerId, PROVIDER_LIVE_MANIFEST[providerId].requirements,
	])),
	scripts,
	operations: Object.fromEntries(selected.map((providerId) => [
		providerId,
		PROVIDER_LIVE_MANIFEST[providerId].tests.flatMap((test) => test.operations),
	])),
	skips: Object.fromEntries(selected.map((providerId) => [providerId, PROVIDER_LIVE_MANIFEST[providerId].skips])),
};

if (process.argv.includes("--list")) {
	console.log(JSON.stringify(plan, null, 2));
} else {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const results = scripts.map((script) => {
		console.log(`\nPROVIDER LIVE ${script}`);
		const result = spawnSync("npm", ["run", script], { cwd: root, env: process.env, stdio: "inherit" });
		return { script, status: result.status === 0 ? "passed" as const : "failed" as const, exitCode: result.status ?? 1 };
	});
	const failed = results.filter((result) => result.status === "failed");
	console.log(JSON.stringify({ ...plan, status: failed.length === 0 ? "passed" : "failed", results }, null, 2));
	if (failed.length) process.exitCode = 1;
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}
