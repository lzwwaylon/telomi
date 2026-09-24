import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { parseArgs, startChrome, stopChrome, syncFromDefaultBrowser } from "../../../scripts/chrome-debug.js";
import { waitForBrowserCookies } from "../../config/local-credentials.js";

/**
 * Whether the managed profile has to be copied from the user's browser again. A Chrome profile
 * always carries its cookie database; one without it is missing, was cleared, or was deleted
 * under a running browser (which then regrows everything except its open databases), and none of
 * those hold the user's logins. Replacing it costs one copy; keeping it loses every login.
 */
export function profileNeedsSync(profileDir: string, profileDirectory: string): boolean {
	if (!existsSync(profileDir) || readdirSync(profileDir).length === 0) return true;
	return !existsSync(join(profileDir, profileDirectory, "Cookies"));
}

export function browserHostEndpoint(env: NodeJS.ProcessEnv = process.env): URL {
	const endpoint = new URL(env.TELOMI_BROWSER_HOST_CDP_URL?.trim() || "http://127.0.0.1:9222");
	if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("Browser CDP host must use HTTP or HTTPS");
	return endpoint;
}

/** Whether the CDP host answers with a usable debugger endpoint. */
export async function probeBrowserHost(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	try {
		const endpoint = browserHostEndpoint(env);
		const response = await fetch(`${endpoint.href.replace(/\/$/u, "")}/json/version`, { signal: AbortSignal.timeout(1500) });
		if (!response.ok) return false;
		const version = await response.json() as { webSocketDebuggerUrl?: unknown };
		return typeof version.webSocketDebuggerUrl === "string" && /^wss?:\/\//u.test(version.webSocketDebuggerUrl);
	} catch { return false; }
}

/** All server entrypoints require a real CDP host; Eval changes ownership, not capability. */
export async function ensureBrowserReady(
	env: NodeJS.ProcessEnv = process.env,
	start: typeof startChrome = startChrome,
): Promise<void> {
	const headed = env.TELOMI_BROWSER_HEADED?.trim() || "false";
	if (headed !== "true" && headed !== "false") throw new Error("TELOMI_BROWSER_HEADED must be true or false");
	const endpoint = browserHostEndpoint(env);
	const probe = () => probeBrowserHost(env);
	if (await probe()) return;
	const local = endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname)
		&& endpoint.pathname === "/" && !endpoint.search && !endpoint.username && !endpoint.password;
	if (!local) throw new Error(`Browser CDP host is unavailable: ${endpoint.origin}; restore the configured host before starting Telomi`);
	const port = Number(endpoint.port || "80");
	// Worktrees share a host. Serialize first launch so profile copying cannot race another server.
	const release = await lock(join(tmpdir(), `telomi-browser-${process.getuid?.() ?? "user"}-${port}`), {
		realpath: false, retries: { retries: 60, minTimeout: 500, maxTimeout: 500 },
	});
	try {
		if (await probe()) return;
		const { options } = parseArgs(["start", "--port", String(port), headed === "true" ? "--headed" : "--headless", "--only-profile"]);
		options.syncOnStart = profileNeedsSync(options.profileDir, options.profileDirectory)
			&& existsSync(join(options.sourceDir, options.profileDirectory));
		await start(options);
		if (!await probe()) throw new Error(`Browser CDP host did not become ready: ${endpoint.origin}`);
	} finally { await release(); }
}

/**
 * Copy the user's own browser profile into the managed one again, so a login made in their
 * browser reaches Telomi's. The managed host is stopped for the copy and started again; the caller
 * makes sure no browser session is using it.
 */
export async function resyncBrowserProfile(
	env: NodeJS.ProcessEnv = process.env,
	start: typeof startChrome = startChrome,
): Promise<void> {
	const endpoint = browserHostEndpoint(env);
	const local = endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname);
	if (!local) throw new Error(`Browser CDP host ${endpoint.origin} is not managed here; log in there directly`);
	const { options } = parseArgs(["stop", "--port", String(Number(endpoint.port || "80")), "--only-profile"]);
	if (!existsSync(join(options.sourceDir, options.profileDirectory))) {
		throw new Error(`no browser profile to copy at ${join(options.sourceDir, options.profileDirectory)}`);
	}
	if (await probeBrowserHost(env)) await stopChrome(options);
	syncFromDefaultBrowser(options);
	await ensureBrowserReady(env, start);
	await waitForBrowserCookies(endpoint.href);
}
