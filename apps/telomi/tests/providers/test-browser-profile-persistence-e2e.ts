import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

/**
 * Real-browser E2E for the DEDICATED PERSISTENT Telomi browser profile.
 *
 * Proves the login-semantics claim in start.sh: a dedicated profile, imported or
 * logged into once, retains its state. We use a throwaway persistent user-data
 * dir (never the human's Chrome, no real credentials), set a persistent cookie
 * and a localStorage value, close Chrome and AWAIT its exit, then relaunch the
 * SAME profile and confirm both survived the restart.
 *
 * Requires agent-browser >= 0.34 (AGENT_BROWSER_BIN or the package wrapper).
 */

const COOKIE = "telomi_e2e_cookie=persisted-cookie";
const LS_KEY = "telomi_e2e_ls";
const LS_VALUE = "persisted-localstorage";

const bin = resolveAgentBrowserBin();
const chrome = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	process.env.CHROME_PATH ?? "",
].find((path) => path && existsSync(path));
assert.ok(chrome, "No Chrome/Chromium found. Set CHROME_PATH.");

const profileDir = mkdtempSync(join(tmpdir(), "telomi-e2e-profile-"));
const namespace = `telomi-e2e-profile-${process.pid}`;
const port = 9470 + Math.trunc(process.pid % 80);
let httpServer: Server | undefined;
let origin = "";
let chromeProc: ChildProcess | undefined;
let lastRead = "";

async function main(): Promise<void> {
	origin = await startSite();

	// --- Session 1: seed persistent cookie + localStorage ----------------------
	await launchChrome();
	await run(["--cdp", String(port), "--session", "seed", "open", `${origin}/set`]);
	await run(["--cdp", String(port), "--session", "seed", "wait", "500"]);
	const seededLs = (await run(["--cdp", String(port), "--session", "seed", "eval", `localStorage.getItem('${LS_KEY}')`])).stdout;
	assert.match(seededLs, /persisted-localstorage/u, "localStorage was seeded in session 1");

	// Close Chrome and AWAIT its exit so the profile flushes to disk.
	await closeChromeAndAwaitExit();

	// --- Session 2: same profile, prove both persisted -------------------------
	await launchChrome();
	await run(["--cdp", String(port), "--session", "verify", "open", `${origin}/read`]);
	await run(["--cdp", String(port), "--session", "verify", "wait", "500"]);

	assert.match(lastRead, /persisted-cookie/u, "the persistent cookie survived the Chrome restart");
	const persistedLs = (await run(["--cdp", String(port), "--session", "verify", "eval", `localStorage.getItem('${LS_KEY}')`])).stdout;
	assert.match(persistedLs, /persisted-localstorage/u, "localStorage survived the Chrome restart");

	console.log("browser profile persistence E2E: all assertions passed");
}

main().then(() => cleanup(0)).catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	cleanup(1);
});

function startSite(): Promise<string> {
	return new Promise((resolve) => {
		httpServer = createServer((req, res) => {
			const path = (req.url ?? "/").split("?", 1)[0];
			if (path === "/set") {
				res.setHeader("Set-Cookie", `${COOKIE}; Max-Age=3600; Path=/`);
				res.setHeader("Content-Type", "text/html");
				res.end(`<title>seed</title><script>localStorage.setItem('${LS_KEY}','${LS_VALUE}')</script>ok`);
				return;
			}
			if (path === "/read") {
				lastRead = req.headers.cookie ?? "";
				res.setHeader("Content-Type", "text/html");
				res.end(`<title>read</title>cookie:${lastRead}`);
				return;
			}
			res.statusCode = 404;
			res.end("no");
		});
		httpServer.listen(0, "127.0.0.1", () => {
			resolve(`http://127.0.0.1:${(httpServer!.address() as AddressInfo).port}`);
		});
	});
}

async function launchChrome(): Promise<void> {
	chromeProc = spawn(
		chrome!,
		[
			"--headless=new",
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	await waitForCdp();
}

async function closeChromeAndAwaitExit(): Promise<void> {
	const proc = chromeProc;
	if (!proc) return;
	const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
	// Graceful CDP shutdown so the profile is flushed, then SIGTERM as a fallback.
	try {
		const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl?: string };
		if (version.webSocketDebuggerUrl) await browserClose(version.webSocketDebuggerUrl);
	} catch { /* fall through to signal */ }
	proc.kill("SIGTERM");
	await Promise.race([exited, delay(10_000).then(() => proc.kill("SIGKILL"))]);
	await exited;
	chromeProc = undefined;
}

function browserClose(wsUrl: string): Promise<void> {
	return new Promise((resolve) => {
		import("ws").then(({ default: WebSocket }) => {
			const socket = new WebSocket(wsUrl);
			socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
			socket.on("close", () => resolve());
			socket.on("error", () => resolve());
			setTimeout(() => { try { socket.close(); } catch { /* ignore */ } resolve(); }, 2_000);
		}).catch(() => resolve());
	});
}

function cleanup(code: number): never {
	for (const session of ["seed", "verify"]) {
		try {
			spawnSync(bin, ["--session", session, "close"], {
				stdio: "ignore",
				env: { ...process.env, AGENT_BROWSER_CDP: `http://127.0.0.1:${port}`, AGENT_BROWSER_NAMESPACE: namespace },
			});
		} catch { /* ignore */ }
	}
	try { chromeProc?.kill("SIGKILL"); } catch { /* ignore */ }
	try { httpServer?.close(); } catch { /* ignore */ }
	try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
	try { rmSync(join(homedir(), ".agent-browser", "namespaces", namespace), { recursive: true, force: true }); } catch { /* ignore */ }
	process.exit(code);
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		// Keep agent-browser daemon sidecars inside a throwaway namespace, never
		// in the global ~/.agent-browser root.
		const child = spawn(bin, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, AGENT_BROWSER_NAMESPACE: namespace },
		});
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

async function waitForCdp(): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
		} catch { /* not ready */ }
		await delay(300);
	}
	throw new Error(`Chrome CDP did not come up on ${port}`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function resolveAgentBrowserBin(): string {
	if (process.env.AGENT_BROWSER_BIN && existsSync(process.env.AGENT_BROWSER_BIN)) return process.env.AGENT_BROWSER_BIN;
	// The package wrapper, as the server uses it: it makes the native binary executable on first run.
	return fileURLToPath(import.meta.resolve("agent-browser/bin/agent-browser.js"));
}
