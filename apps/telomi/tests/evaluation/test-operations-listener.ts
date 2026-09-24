/**
 * Phase 2 运行模式与 Operations Listener 的确定性检查。
 *
 * 覆盖：默认产品进程开启 Capture；两种角色都安装 Case Capture Hook，close() 卸载；
 * Capture 模式只暴露只读 Case Interface；Eval Instance 模式暴露完整 Replay
 * Interface；Operations Listener 只绑定 127.0.0.1；Status 返回 protocolVersion
 * 和 schemaHash。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import { resolveOperationsMode, resolveOperationsPort } from "../../server/config/network.js";
import { caseCapture, caseCaptureHealth } from "../../server/observability/case-capture.js";
import { createOperationsRuntime, type OperationsRuntime } from "../../server/evaluation/operations-runtime.js";
import {
	OPERATIONS_BASE_PATH,
	OPERATIONS_PROTOCOL_VERSION,
	OPERATIONS_ROUTES,
	OPERATIONS_SCHEMA_HASH,
	routesForMode,
	validateOperations,
} from "../../server/evaluation/operations-contract.js";
import { resolveExchangeBundlePath, resolveOperationsExchangeRoot } from "../../server/evaluation/exchange-root.js";
import { createOperationsRouter } from "../../server/evaluation/api.js";

// --- Runtime mode is start-up only; full capture is opt-in. ---
assert.equal(resolveOperationsMode({}), "off");
assert.equal(resolveOperationsMode({ TELOMI_EVAL_CAPTURE: "1" }), "capture");
assert.equal(resolveOperationsMode({ TELOMI_EVAL_INSTANCE: "1" }), "eval");
assert.equal(resolveOperationsMode({ TELOMI_EVAL_CAPTURE: "1", TELOMI_EVAL_INSTANCE: "1" }), "eval");
assert.equal(resolveOperationsMode({ TELOMI_EVAL_CAPTURE: "0" }), "off");
assert.equal(resolveOperationsMode({ TELOMI_EVAL_INSTANCE: "0" }), "off");
assert.equal(resolveOperationsPort(8787, {}), 8788);
assert.equal(resolveOperationsPort(8787, { TELOMI_OPERATIONS_PORT: "9999" }), 9999);
assert.equal(resolveOperationsPort(8787, { TELOMI_OPERATIONS_PORT: "not a port" }), 8788);

const defaultImports = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
 import { registerHooks } from "node:module";
 registerHooks({ load(url, context, next) {
  if (/\\/recorded-stage-replay\\.(ts|js)$/.test(url) || /\\/evaluation\\//.test(url)) {
   throw new Error("Research module import loaded Replay implementation: " + url);
  }
  return next(url, context);
 } });
 await import(${JSON.stringify(new URL("../../server/research/runtime.ts", import.meta.url).href)});
`], { encoding: "utf-8", env: { ...process.env, TELOMI_EVAL_CAPTURE: "0", TELOMI_EVAL_INSTANCE: "0" } });
assert.equal(defaultImports.status, 0, defaultImports.stderr);

// --- The composition root owns Evaluation initialization, not Research module imports. ---
const appSource = readFileSync(new URL("../../server/app.ts", import.meta.url), "utf-8");
const gatedImports = [...appSource.matchAll(/^import[^;]*?from\s+"(\.\/(?:evaluation|evolution)\/[^"]+)";/gmu)]
	.map(([, specifier]) => specifier);
assert.deepEqual(gatedImports, [],
	"server/app.ts must not statically import Evaluation or Evolution; both initialize at the composition root");
assert.ok(!appSource.includes("/api/evaluation"), "the product HTTP app must not mount any Evaluation route");
const productOperationsGuard = appSource.indexOf('app.use("/operations"');
const spaFallback = appSource.indexOf('app.get("*"');
assert.ok(productOperationsGuard >= 0 && spaFallback > productOperationsGuard,
	"the product listener must reject /operations before the SPA fallback can turn it into a 200 HTML response");

// --- Both listeners serve the mode's route set and nothing else. ---
const root = mkdtempSync(join(tmpdir(), "telomi-operations-listener-"));
const goals = {
	listGoals: () => [],
	getGoal: () => undefined,
	ensureImportedGoal: () => undefined,
} as unknown as Parameters<typeof createOperationsRuntime>[0]["goals"];

/** `/goals/{goalId}/cases` -> `/goals/probe/cases`; unknown ids make every handler answer without side effects. */
function probeUrl(baseUrl: string, path: string, query?: readonly { readonly name: string }[]): string {
	const search = query?.length ? `?${query.map((item) => `${item.name}=probe`).join("&")}` : "";
	return `${baseUrl}${OPERATIONS_BASE_PATH}${path.replaceAll(/\{\w+\}/gu, "probe")}${search}`;
}

async function probe(runtime: OperationsRuntime, baseUrl: string): Promise<Map<string, string>> {
	const reasons = new Map<string, string>();
	for (const route of OPERATIONS_ROUTES) {
		const response = await fetch(probeUrl(baseUrl, route.path, route.query), {
			method: route.method.toUpperCase(),
			...(route.method === "post" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
		});
		const body = await response.text();
		reasons.set(route.operationId, response.status === 404 && body.includes("Operations route not found")
			? "absent" : `present:${response.status}`);
	}
	assert.equal(runtime.address()?.address, "127.0.0.1");
	return reasons;
}

async function importBundle(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
	const response = await fetch(`${baseUrl}${OPERATIONS_BASE_PATH}/bundles/import`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path }),
	});
	return { status: response.status, body: await response.text() };
}

async function withRuntime(mode: "capture" | "eval", body: (runtime: OperationsRuntime, baseUrl: string) => Promise<void>): Promise<void> {
	const workspaceDir = join(root, mode);
	const runtime = createOperationsRuntime({
		mode,
		port: 0,
		workspaceDir,
		goals,
	});
	await runtime.start();
	try {
		assert.deepEqual(Object.keys(caseCapture() ?? {}).sort(), FULL_CAPTURE_NODES,
			`${mode} mode must capture every instrumented node`);
		await body(runtime, `http://127.0.0.1:${runtime.address()!.port}`);
	} finally {
		runtime.close();
	}
}

const FULL_CAPTURE_NODES = [
	"cornellNote", "mainAgent", "podcastWriter", "primeSearchBatch", "researchStages", "scheduleReviewer", "wikiCurator", "wikiShard",
];

try {
	// --- Default role: only the Prime Search Cases Evolution consumes, and no Listener at all. ---
	{
		const runtime = createOperationsRuntime({ mode: "off", port: 0, workspaceDir: join(root, "off"), goals });
		await runtime.start();
		try {
			assert.deepEqual(Object.keys(caseCapture() ?? {}), ["primeSearchBatch"],
				"the default role must capture only what Browser Skill Evolution consumes");
			assert.equal(runtime.address(), undefined, "the default role must not bind an Operations Listener");
		} finally {
			runtime.close();
		}
		assert.equal(caseCaptureHealth().enabled, false);
	}

	await withRuntime("capture", async (runtime, baseUrl) => {
		const reasons = await probe(runtime, baseUrl);
		for (const route of OPERATIONS_ROUTES) {
			assert.equal(reasons.get(route.operationId)?.startsWith("present"), route.access === "read",
				`capture mode must expose only read routes; ${route.operationId} was ${reasons.get(route.operationId)}`);
		}

		const status = await (await fetch(`${baseUrl}${OPERATIONS_BASE_PATH}/status`)).json();
		validateOperations("OperationsStatus", status);
		assert.equal((status as { protocolVersion: number }).protocolVersion, OPERATIONS_PROTOCOL_VERSION);
		assert.equal((status as { schemaHash: string }).schemaHash, OPERATIONS_SCHEMA_HASH);
		assert.equal((status as { mode: string }).mode, "capture");
		assert.equal((status as { writable: boolean }).writable, false);

		// The Listener is bound to loopback, so no other local address can reach it.
		const external = Object.values(networkInterfaces()).flat()
			.find((info) => info?.family === "IPv4" && !info.internal)?.address;
		if (external) {
			await assert.rejects(
				fetch(`http://${external}:${runtime.address()!.port}${OPERATIONS_BASE_PATH}/status`, { signal: AbortSignal.timeout(2_000) }),
				`Operations Listener answered on non-loopback address ${external}`,
			);
		} else {
			console.log("[operations] no non-loopback IPv4 interface; bound-address assertion only");
		}
	});
	assert.equal(caseCaptureHealth().enabled, false, "closing Operations Runtime uninstalls its process-global Capture hooks");

	await withRuntime("eval", async (runtime, baseUrl) => {
		const reasons = await probe(runtime, baseUrl);
		for (const route of OPERATIONS_ROUTES) {
			assert.ok(reasons.get(route.operationId)?.startsWith("present"),
				`eval instance mode must expose ${route.operationId}; it was ${reasons.get(route.operationId)}`);
		}
		assert.equal(routesForMode("eval").length, OPERATIONS_ROUTES.length);
		assert.ok(routesForMode("capture").length < OPERATIONS_ROUTES.length);

		const status = await (await fetch(`${baseUrl}${OPERATIONS_BASE_PATH}/status`)).json();
		validateOperations("OperationsStatus", status);
		assert.equal((status as { mode: string }).mode, "eval");
		assert.equal((status as { writable: boolean }).writable, true);

		// Request bodies are validated before they reach the Replay queue.
		const invalid = await fetch(`${baseUrl}${OPERATIONS_BASE_PATH}/bundles/import`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: 42 }),
		});
		assert.equal(invalid.status, 400);
		assert.match(await invalid.text(), /BundleImportRequest is invalid/u);

		// Bundle Import only accepts paths inside the Exchange Root.
		const outside = await importBundle(baseUrl, join(root, "outside.tar"));
		assert.equal(outside.status, 400);
		assert.match(outside.body, /Exchange Root/u);
	});
	assert.equal(caseCaptureHealth().enabled, false);

	// --- Bundle Import is confined to the configured Exchange Root. ---
	assert.equal(resolveOperationsExchangeRoot("/data", {}), join("/data", "operations-exchange"));
	assert.equal(resolveOperationsExchangeRoot("/data", { TELOMI_OPERATIONS_EXCHANGE_ROOT: "/exchange/" }), "/exchange");

	const exchangeRoot = join(root, "exchange");
	mkdirSync(join(exchangeRoot, "nested"), { recursive: true });
	writeFileSync(join(exchangeRoot, "bundle.tar"), "tar");
	writeFileSync(join(exchangeRoot, "nested", "bundle.tar"), "tar");
	writeFileSync(join(root, "outside.tar"), "tar");
	symlinkSync(join(root, "outside.tar"), join(exchangeRoot, "link.tar"));
	symlinkSync(root, join(exchangeRoot, "escape"));

	// The resolver answers with the realpath, so the Exchange Root may be spelled through a
	// symlinked parent (macOS /var -> /private/var) without changing the decision.
	const exchangeReal = realpathSync(exchangeRoot);
	assert.equal(resolveExchangeBundlePath(exchangeRoot, join(exchangeRoot, "bundle.tar")), join(exchangeReal, "bundle.tar"));
	assert.equal(resolveExchangeBundlePath(exchangeRoot, "nested/bundle.tar"), join(exchangeReal, "nested", "bundle.tar"));
	assert.equal(resolveExchangeBundlePath(exchangeReal, join(exchangeRoot, "bundle.tar")), join(exchangeReal, "bundle.tar"));
	for (const [reason, path] of [
		["absolute path outside the root", join(root, "outside.tar")],
		["relative traversal", "../outside.tar"],
		["traversal that re-enters", join(exchangeRoot, "nested", "..", "..", "outside.tar")],
		["symlinked file", join(exchangeRoot, "link.tar")],
		["symlinked directory", join(exchangeRoot, "escape", "outside.tar")],
		["directory instead of a file", join(exchangeRoot, "nested")],
		["missing file", join(exchangeRoot, "absent.tar")],
	] as const) {
		assert.throws(() => resolveExchangeBundlePath(exchangeRoot, path), Error, `Exchange Root must reject ${reason}`);
	}

	// --- Fail closed: a success body that violates the contract never leaves the Listener. ---
	const broken = express();
	broken.use(createOperationsRouter(goals, {
		status: () => ({
			active: 0, queued: 0, concurrency: 0, recipes: [], runtimeBuild: "build",
			runtimeBuildMatchesDisk: true, agentBundleSha256: "bundle",
		}),
	} as unknown as Parameters<typeof createOperationsRouter>[1], "capture", exchangeRoot));
	const brokenServer = broken.listen(0, "127.0.0.1");
	await new Promise<void>((done) => brokenServer.once("listening", done));
	try {
		const port = (brokenServer.address() as { port: number }).port;
		const response = await fetch(`http://127.0.0.1:${port}${OPERATIONS_BASE_PATH}/status`);
		assert.equal(response.status, 500);
		assert.match((await response.json() as { error: string }).error,
			/Operations response for 'getStatus' violates the contract: .*\/concurrency: must be >= 1/u);
	} finally {
		brokenServer.close();
	}

	console.log("Operations Listener runtime modes, route sets, loopback binding, response contract and Exchange Root pass");
} finally {
	rmSync(root, { recursive: true, force: true });
}
