import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import {
	ResearchSourceServiceManager,
	resolveAutostartArxivSqlitePath,
	resolveAutostartHuggingFaceHome,
	resolveAutostartMaterialCacheRoot,
	resolveAutostartWorkspaceRoots,
} from "../../server/providers/source-service-client.js";

const serviceRoot = resolve("services/research-source-service");
const externalDataRoot = resolve("../../tmp/external-pi-data");

assert.deepEqual(
	resolveAutostartWorkspaceRoots(serviceRoot, {
		TELOMI_DATA_DIR: externalDataRoot,
	}).split(delimiter),
	[
		externalDataRoot,
		resolve(serviceRoot, "../.."),
		resolve(tmpdir()),
	],
);

const explicitRoots = [resolve("custom-a"), resolve("custom-b")].join(delimiter);
assert.equal(
	resolveAutostartWorkspaceRoots(serviceRoot, {
		TELOMI_DATA_DIR: externalDataRoot,
		SOURCE_SERVICE_WORKSPACE_ROOTS: explicitRoots,
	}),
	explicitRoots,
);

assert.equal(
	resolveAutostartArxivSqlitePath(serviceRoot, { TELOMI_DATA_DIR: externalDataRoot }),
	join(homedir(), ".telomi", "runtime", "research-sources", "arxiv-runtime.sqlite3"),
);
assert.equal(
	resolveAutostartArxivSqlitePath(serviceRoot, { TELOMI_DATA_DIR: resolve("another-checkout-data") }),
	resolveAutostartArxivSqlitePath(serviceRoot, { TELOMI_DATA_DIR: externalDataRoot }),
	"arXiv scheduling must be shared across checkouts on the same host",
);
assert.equal(
	resolveAutostartHuggingFaceHome(serviceRoot, { TELOMI_DATA_DIR: externalDataRoot }),
	join(externalDataRoot, ".pi", "runtime", "research-source-service", "huggingface"),
);
assert.equal(
	resolveAutostartMaterialCacheRoot(serviceRoot, { TELOMI_DATA_DIR: externalDataRoot }),
	join(externalDataRoot, ".pi", "runtime", "research-source-service", "material-cache"),
);
assert.equal(
	resolveAutostartMaterialCacheRoot(serviceRoot, {
		SOURCE_SERVICE_MATERIAL_CACHE_ROOT: join(externalDataRoot, "material-cache"),
	}),
	join(externalDataRoot, "material-cache"),
);
assert.equal(
	resolveAutostartHuggingFaceHome(serviceRoot, { SOURCE_SERVICE_HF_HOME: join(externalDataRoot, "hf-cache") }),
	join(externalDataRoot, "hf-cache"),
);

const explicitArxivDatabase = resolve("custom-arxiv.sqlite3");
assert.equal(
	resolveAutostartArxivSqlitePath(serviceRoot, {
		TELOMI_DATA_DIR: externalDataRoot,
		SOURCE_SERVICE_ARXIV_SQLITE_PATH: explicitArxivDatabase,
	}),
	explicitArxivDatabase,
);

console.log(JSON.stringify({
	passed: true,
	externalDataRoot,
	defaultRoots: resolveAutostartWorkspaceRoots(serviceRoot, {
		TELOMI_DATA_DIR: externalDataRoot,
	}).split(delimiter),
}));

// Exercise the real child-process/readiness path with local stand-ins only.
const startupRoot = mkdtempSync(join(tmpdir(), "telomi-source-startup-"));
const bin = join(startupRoot, "bin");
const localService = join(startupRoot, "service");
mkdirSync(bin);
mkdirSync(localService);
const calls = join(startupRoot, "uv-calls.jsonl");
const fakePython = `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
fs.writeFileSync(process.env.STARTUP_ENV, JSON.stringify({roots:process.env.SOURCE_SERVICE_WORKSPACE_ROOTS,cache:process.env.SOURCE_SERVICE_MATERIAL_CACHE_ROOT}));
http.createServer((req,res) => {res.end("{}");}).listen(Number(process.env.SOURCE_SERVICE_PORT), "127.0.0.1");
`;
writeFileSync(join(bin, "uv"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.UV_CALLS, JSON.stringify(process.argv.slice(2))+"\\n");
if (process.env.UV_PARTIAL && !fs.existsSync(process.env.UV_PARTIAL)) {
const python = path.join(process.cwd(), ".venv/bin/python");
fs.mkdirSync(path.dirname(python), {recursive:true});
fs.writeFileSync(python, ${JSON.stringify(`#!${process.execPath}
process.exit(1);
`)}, {mode:0o755});
fs.writeFileSync(process.env.UV_PARTIAL, "failed once");
console.error("fixture partial environment"); process.exit(1);
}
if (process.env.UV_FAIL) {console.error("fixture install failure"); process.exit(1);}
if (process.env.UV_HOLD) {setInterval(() => {}, 1000);} else {
const python = path.join(process.cwd(), ".venv/bin/python");
fs.mkdirSync(path.dirname(python), {recursive:true});
fs.writeFileSync(python, ${JSON.stringify(fakePython)}, {mode:0o755});
}
`, {mode: 0o755});
const startupEnv: NodeJS.ProcessEnv = {
	...process.env,
	PATH: bin,
	TELOMI_RESEARCH_SOURCE_BASE_URL: "",
	TELOMI_RESEARCH_SOURCE_PYTHON: "",
	TELOMI_RESEARCH_SOURCE_PORT: "",
	TELOMI_RESEARCH_SOURCE_SERVICE_DIR: localService,
	TELOMI_DATA_DIR: join(startupRoot, "isolated-data"),
	SOURCE_SERVICE_WORKSPACE_ROOTS: "",
	SOURCE_SERVICE_MATERIAL_CACHE_ROOT: "",
	UV_CALLS: calls,
	STARTUP_ENV: join(startupRoot, "service-env.json"),
};
const manager = new ResearchSourceServiceManager(startupEnv);
try {
	const first = manager.ensureReady();
	assert.equal(manager.ensureReady(), first, "concurrent startup shares dependency preparation");
	const ready = await first;
	assert.deepEqual(JSON.parse(readFileSync(calls, "utf8").trim()), ["sync", "--project", localService, "--frozen", "--extra", "dev", "--python", "3.11"]);
	const observed = JSON.parse(readFileSync(startupEnv.STARTUP_ENV!, "utf8"));
	assert.equal(observed.cache, join(startupEnv.TELOMI_DATA_DIR!, ".pi/runtime/research-source-service/material-cache"));
	assert.ok(observed.roots.split(delimiter).includes(startupEnv.TELOMI_DATA_DIR));
	const external = new ResearchSourceServiceManager({...startupEnv, TELOMI_RESEARCH_SOURCE_BASE_URL: ready.baseUrl});
	await external.ensureReady();
	await external.close();
	assert.equal((await fetch(ready.baseUrl + "/v1/health")).status, 200, "closing an external connection does not stop its owner");
} finally {
	await manager.close();
}
rmSync(join(localService, ".venv"), {recursive:true});
const customPython = join(startupRoot, "custom-python");
writeFileSync(customPython, fakePython, {mode:0o755});
const explicitPython = new ResearchSourceServiceManager({...startupEnv, TELOMI_RESEARCH_SOURCE_PYTHON: customPython});
try { await explicitPython.ensureReady(); } finally { await explicitPython.close(); }
assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1, "explicit Python bypasses installation");
const missingPython = new ResearchSourceServiceManager({...startupEnv, TELOMI_RESEARCH_SOURCE_PYTHON: join(startupRoot, "missing-python")});
try { await assert.rejects(missingPython.ensureReady(), /failed to start/); } finally { await missingPython.close(); }
const missingUv = new ResearchSourceServiceManager({...startupEnv, PATH: localService});
try { await assert.rejects(missingUv.ensureReady(), /spawn uv ENOENT/); } finally { await missingUv.close(); }
const failed = new ResearchSourceServiceManager({...startupEnv, UV_FAIL:"1"});
try {
	await assert.rejects(failed.ensureReady(), /fixture install failure/);
	await assert.rejects(failed.ensureReady(), /fixture install failure/);
} finally { await failed.close(); }
const held = new ResearchSourceServiceManager({...startupEnv, UV_HOLD:"1"});
const holding = held.ensureReady();
const rejected = assert.rejects(holding, /could not be prepared/);
await held.close();
await rejected;
await assert.rejects(held.ensureReady(), /closed/);
assert.equal(existsSync(join(localService, "artifacts", "python-install-pending")), true, "closing during installation retains retry state");
assert.equal(readFileSync(calls, "utf8").trim().split("\n").length >= 3, true, "failed installs are retried");
const partialEnv = {...startupEnv, UV_PARTIAL:join(startupRoot, "partial-attempt")};
const partial = new ResearchSourceServiceManager(partialEnv);
try {
	await assert.rejects(partial.ensureReady(), /fixture partial environment/);
	await partial.ensureReady();
	assert.equal(existsSync(join(localService, "artifacts", "python-install-pending")), false, "successful retry removes incomplete-install marker");
} finally { await partial.close(); }
rmSync(startupRoot, {recursive:true, force:true});
console.log("Source startup preparation, readiness, isolation, failure retry and shutdown passed");
