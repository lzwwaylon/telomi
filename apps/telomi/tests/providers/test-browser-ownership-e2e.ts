import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserSessionRegistry } from "../../server/providers/browser/session-registry.js";

/**
 * Real-browser E2E for Telomi browser ownership on native agent-browser 0.34.
 *
 * Launches a real headless Chrome (its own throwaway profile), runs the registry
 * inside a UNIQUE namespace, attaches multiple pinned sessions to the shared CDP
 * host, and proves:
 *   1. Two concurrent runs each keep their own pinned tab (no tab theft).
 *   2. A lost pinned tab yields `tab_gone`, never a silent fallback.
 *   3. Cleanup reads the native `.target` sidecar and closes EXACTLY the run's
 *      tab: run A's target is removed, run B's independent target survives, and a
 *      truly independent foreign pinned target (a different namespace) survives.
 *   4. Cleanup is proven at the OS process-table level: the daemon pid is gone
 *      from `ps`, not merely the sidecar file.
 *   5. Only this namespace is ever touched - global `~/.agent-browser` files and
 *      the foreign namespace are left intact.
 *
 * Requires agent-browser >= 0.34 (pin-tab / namespace / .target). Point
 * AGENT_BROWSER_BIN at it; otherwise the package wrapper is used, as the server does.
 */

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	process.env.CHROME_PATH ?? "",
].filter(Boolean);

const bin = resolveAgentBrowserBin();
assertPinTabCapable(bin);
const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
assert.ok(chrome, `No Chrome/Chromium found. Set CHROME_PATH.`);

const port = 9380 + Math.trunc(process.pid % 90);
const cdpBase = `http://127.0.0.1:${port}`;
const chromeDir = mkdtempSync(join(tmpdir(), "telomi-e2e-chrome-"));
const socketDir = mkdtempSync(join("/tmp", "telomi-e2e-sockets-"));
const namespace = `telomi-e2e-${process.pid}`;
const foreignNamespace = `e2e-foreign-${process.pid}`;

const chromeProc = spawn(
	chrome!,
	[
		"--headless=new",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${chromeDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"about:blank",
	],
	{ stdio: "ignore" },
);

const registry = new BrowserSessionRegistry({
	namespace,
	cdpUrl: String(port),
	daemonHome: socketDir,
	agentBrowserBin: bin,
});
const runDir = registry.config.runDir;

async function main(): Promise<void> {
	await waitForCdp(cdpBase);

	// --- 0. One global permit queues Browser work across different Goals --------
	const quotaRegistry = new BrowserSessionRegistry({
		namespace: `${namespace}-quota`,
		cdpUrl: String(port),
		daemonHome: socketDir,
		agentBrowserBin: bin,
		maxConcurrentWorkspaces: 1,
	});
	quotaRegistry.beginRun("quota-goal-a", `quotaA-${process.pid}`);
	quotaRegistry.beginRun("quota-goal-b", `quotaB-${process.pid}`);
	await quotaRegistry.execute("quota-goal-a", ["open", `${cdpBase}/json/version?owner=a`]);
	let quotaBResolved = false;
	const quotaB = quotaRegistry.execute("quota-goal-b", ["open", `${cdpBase}/json/version?owner=b`])
		.then(() => { quotaBResolved = true; });
	await delay(200);
	assert.equal(quotaBResolved, false, "Goal B waits while Goal A owns the global Browser permit");
	await quotaRegistry.endRun("quota-goal-a", `quotaA-${process.pid}`, "completed");
	await quotaB;
	await quotaRegistry.endRun("quota-goal-b", `quotaB-${process.pid}`, "completed");
	assert.equal(quotaRegistry.config.activeWorkspaces, 0);
	assert.equal(quotaRegistry.config.queuedWorkspaces, 0);
	await quotaRegistry.shutdownAll("shutdown");

	// --- 1. Concurrent runs keep their own pinned tabs -------------------------
	const envA = registry.beginRun("goal-a", `runA-${process.pid}`);
	const envB = registry.beginRun("goal-b", `runB-${process.pid}`);
	assert.equal(envA.AGENT_BROWSER_NAMESPACE, namespace);
	assert.equal(envA.AGENT_BROWSER_PIN_TAB, "1");
	assert.notEqual(envA.AGENT_BROWSER_SESSION, envB.AGENT_BROWSER_SESSION);

	await Promise.all([run(envA, ["open", page("AAA")]), run(envB, ["open", page("BBB")])]);
	assert.equal(await title(envA), "AAA", "run A sees its own tab");
	assert.equal(await title(envB), "BBB", "run B sees its own tab");

	await run(envA, ["open", page("AAA2")]);
	assert.equal(await title(envA), "AAA2");
	assert.equal(await title(envB), "BBB", "run B's tab is not stolen while run A navigates");

	// --- 2. Live Stream and user-control handoff use the real native daemon ----
	const streamPortA = registry.streamPort("goal-a", envA.AGENT_BROWSER_SESSION);
	assert.ok(streamPortA, "run A exposes its namespaced native Stream");
	await registry.setControl("goal-a", envA.AGENT_BROWSER_SESSION, "user");
	let agentCommandResumed = false;
	const heldCommand = registry.execute("goal-a", ["get", "title"]).then(() => { agentCommandResumed = true; });
	await delay(200);
	assert.equal(agentCommandResumed, false, "Agent Tool waits while the user owns the real Browser Session");
	await registry.setControl("goal-a", envA.AGENT_BROWSER_SESSION, "agent");
	await heldCommand;
	assert.equal(agentCommandResumed, true, "Agent Tool resumes after explicit handback");

	// --- 3. Native target sidecars are distinct --------------------------------
	const targetA = readTarget(envA.AGENT_BROWSER_SESSION);
	const targetB = readTarget(envB.AGENT_BROWSER_SESSION);
	assert.ok(targetA && targetB, "both runs wrote a native .target sidecar");
	assert.notEqual(targetA, targetB, "each run pins a distinct CDP target");
	assert.ok(await targetExists(targetA!) && await targetExists(targetB!), "both tabs are open");

	// --- 4. An independent foreign pinned target in another namespace ----------
	const foreignEnv = {
		AGENT_BROWSER_CDP: cdpBase,
		AGENT_BROWSER_SOCKET_DIR: socketDir,
		AGENT_BROWSER_NAMESPACE: foreignNamespace,
		AGENT_BROWSER_SESSION: "foreign-run",
		AGENT_BROWSER_PIN_TAB: "1",
	};
	await run(foreignEnv, ["open", page("FOREIGN")]);
	const foreignTarget = await findTargetIdByTitle("FOREIGN");
	assert.ok(foreignTarget, "foreign pinned tab is open");

	// Capture run A's daemon pid before cleanup (process-table proof later).
	const daemonPidA = readPid(envA.AGENT_BROWSER_SESSION);
	assert.ok(daemonPidA && psAlive(daemonPidA), "run A daemon is live before cleanup");
	await run(envA, ["open", pageWithBlankLink("AAA2", `${cdpBase}/json/version?child=a`)]);
	const targetsBeforePopup = await pageTargetIds();
	await run(envA, ["click", "a"]);
	const popupTarget = await waitForNewPage(targetsBeforePopup);
	assert.ok(popupTarget, "run A opened a target=_blank descendant tab");

	// --- 5. endRun closes run A's whole tab tree -------------------------------
	await registry.endRun("goal-a", `runA-${process.pid}`, "completed");
	assert.ok(!(await targetExists(targetA!)), "run A's pinned tab was closed");
	assert.ok(!(await targetExists(popupTarget!)), "run A's descendant tab was closed");
	assert.ok(await targetExists(targetB!), "run B's tab survives run A cleanup");
	assert.ok(await targetExists(foreignTarget!), "the independent foreign tab survives");
	// Process-table proof: A's daemon is gone from the OS process table.
	assert.ok(!psAlive(daemonPidA!), "run A's daemon left the OS process table");

	// --- 6. tab_gone, never a silent fallback ----------------------------------
	const envC = registry.beginRun("goal-c", `runC-${process.pid}`);
	await run(envC, ["open", page("CCC")]);
	const targetC = readTarget(envC.AGENT_BROWSER_SESSION);
	await fetch(`${cdpBase}/json/close/${encodeURIComponent(targetC!)}`);
	const gone = await run(envC, ["get", "title"]);
	assert.notEqual(gone.code, 0, "a command on a lost pinned tab fails");
	assert.match(`${gone.stdout}\n${gone.stderr}`, /tab_gone/u, "reports tab_gone");
	assert.doesNotMatch(`${gone.stdout}\n${gone.stderr}`, /BBB|FOREIGN/u, "never acts on another tab");
	await registry.endRun("goal-c", `runC-${process.pid}`, "completed");

	// --- 7. shutdown detaches only this namespace ------------------------------
	await registry.shutdownAll("shutdown");
	assert.equal(registry.liveSessions().length, 0, "no Telomi daemon remains in this namespace");
	assert.ok(await targetExists(foreignTarget!), "foreign namespace tab still survives shutdown");
	assert.ok((await fetch(`${cdpBase}/json/version`)).ok, "the shared host browser is untouched");
	// Foreign namespace sidecars are intact (we never touched another namespace).
	assert.ok(psAliveForeignDaemon(), "foreign daemon still runs after our shutdown");

	console.log("browser ownership E2E: all assertions passed");
}

main().then(() => cleanup(0)).catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	cleanup(1);
});

function cleanup(code: number): never {
	// Detach the deliberately-independent foreign session and drop both throwaway
	// namespaces so the machine is left clean.
	try {
		spawnSync(bin, ["--session", "foreign-run", "close"], {
			stdio: "ignore",
		env: {
			...process.env,
			AGENT_BROWSER_CDP: cdpBase,
			AGENT_BROWSER_SOCKET_DIR: socketDir,
			AGENT_BROWSER_NAMESPACE: foreignNamespace,
		},
		});
	} catch { /* ignore */ }
	try { chromeProc.kill("SIGKILL"); } catch { /* ignore */ }
	try { rmSync(chromeDir, { recursive: true, force: true }); } catch { /* ignore */ }
	try { rmSync(socketDir, { recursive: true, force: true }); } catch { /* ignore */ }
	process.exit(code);
}

function page(title: string): string {
	return `data:text/html,<title>${title}</title><h1>${title}</h1>`;
}

function pageWithBlankLink(title: string, href: string): string {
	return `data:text/html,${encodeURIComponent(`<title>${title}</title><a href="${href}" target="_blank">open child</a>`)}`;
}

function readTarget(sessionId: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(runDir, `${sessionId}.target`), "utf-8")) as { targetId?: string }).targetId;
	} catch {
		return undefined;
	}
}

function readPid(sessionId: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(join(runDir, `${sessionId}.pid`), "utf-8").trim(), 10);
		return Number.isInteger(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

function psAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

function psAliveForeignDaemon(): boolean {
	// The foreign namespace lives elsewhere; confirm we never swept it.
	const result = spawnSync(bin, ["session", "list", "--json"], {
		encoding: "utf-8",
		env: {
			...process.env,
			AGENT_BROWSER_SOCKET_DIR: socketDir,
			AGENT_BROWSER_NAMESPACE: foreignNamespace,
		},
	});
	try {
		return (JSON.parse(result.stdout) as { data?: { sessions?: string[] } }).data?.sessions?.includes("foreign-run") ?? false;
	} catch {
		return false;
	}
}

function run(env: Record<string, string>, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk) => out.push(chunk));
		child.stderr.on("data", (chunk) => err.push(chunk));
		child.on("error", () => resolve({ code: -1, stdout: "", stderr: "spawn failed" }));
		child.on("exit", (code) => resolve({
			code: code ?? -1,
			stdout: Buffer.concat(out).toString("utf-8"),
			stderr: Buffer.concat(err).toString("utf-8"),
		}));
	});
}

async function title(env: Record<string, string>): Promise<string> {
	let last = "";
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const result = await run(env, ["get", "title"]);
		last = result.stdout.trim();
		if (result.code === 0 && last) return last;
		await delay(200);
	}
	return last;
}

async function targetExists(targetId: string): Promise<boolean> {
	return Boolean(await findTarget((target) => target.id === targetId));
}

async function findTargetIdByTitle(pageTitle: string): Promise<string | undefined> {
	return (await findTarget((target) => target.title === pageTitle))?.id;
}

async function pageTargetIds(): Promise<Set<string>> {
	const targets = await (await fetch(`${cdpBase}/json/list`)).json() as Array<{ id?: string; type?: string }>;
	return new Set(targets.filter((target) => target.type === "page" && target.id).map((target) => target.id!));
}

async function waitForNewPage(existing: ReadonlySet<string>): Promise<string | undefined> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const created = [...await pageTargetIds()].find((targetId) => !existing.has(targetId));
		if (created) return created;
		await delay(100);
	}
	return undefined;
}

async function findTarget(match: (target: { id?: string; title?: string }) => boolean): Promise<{ id?: string; title?: string } | undefined> {
	try {
		const targets = await (await fetch(`${cdpBase}/json/list`)).json() as Array<{ id?: string; title?: string }>;
		return targets.find(match);
	} catch {
		return undefined;
	}
}

async function waitForCdp(base: string): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			if ((await fetch(`${base}/json/version`)).ok) return;
		} catch { /* not ready */ }
		await delay(300);
	}
	throw new Error(`Chrome CDP did not come up at ${base}`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function resolveAgentBrowserBin(): string {
	if (process.env.AGENT_BROWSER_BIN && existsSync(process.env.AGENT_BROWSER_BIN)) return process.env.AGENT_BROWSER_BIN;
	// The package wrapper, as the server uses it: it makes the native binary executable on first run.
	return fileURLToPath(import.meta.resolve("agent-browser/bin/agent-browser.js"));
}

function assertPinTabCapable(binPath: string): void {
	const help = spawnSync(binPath, ["--help"], { encoding: "utf-8" });
	assert.match(`${help.stdout ?? ""}${help.stderr ?? ""}`, /--pin-tab/u,
		`agent-browser at '${binPath}' lacks --pin-tab (need >= 0.34). Set AGENT_BROWSER_BIN.`);
}
