import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { browserExecutablePath, parseArgs, startChrome, stopChrome, syncFromDefaultBrowser } from "../../../scripts/chrome-debug.js";
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

function headedSetting(env: NodeJS.ProcessEnv): "true" | "false" {
	const headed = env.TELOMI_BROWSER_HEADED?.trim() || "false";
	if (headed !== "true" && headed !== "false") throw new Error("TELOMI_BROWSER_HEADED must be true or false");
	return headed;
}

function isManagedHost(endpoint: URL): boolean {
	return endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname)
		&& endpoint.pathname === "/" && !endpoint.search && !endpoint.username && !endpoint.password;
}

/** Whether the browser can serve a use: a managed local host can be started, a remote one must answer. */
export async function browserHostAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	if (!isManagedHost(browserHostEndpoint(env))) return probeBrowserHost(env);
	try {
		return Boolean(browserExecutablePath(parseArgs(["status", "--only-profile"]).options));
	} catch { return false; }
}

/** How long the managed browser keeps running after its last use ends. */
export const BROWSER_IDLE_STOP_MS = 10 * 60_000;

export interface BrowserHostOptions {
	env?: NodeJS.ProcessEnv;
	idleStopMs?: number;
	start?: () => Promise<void>;
	stop?: () => Promise<void>;
	/** Runs once a start has made the host ready, e.g. to re-read the logins it holds. */
	afterStart?: () => Promise<unknown>;
	/** Runs before an idle stop, while the host still answers. */
	beforeStop?: () => Promise<unknown>;
}

/**
 * The managed browser runs only while something uses it. Every use holds a lease from `acquire()`,
 * which starts the browser if needed (concurrent first uses share one start); when the last lease
 * is released and none follows within the idle time, the browser is stopped. A browser already
 * running when the server starts gets the same idle time. A remote host is used as configured and
 * never started or stopped here.
 */
export class BrowserHost {
	private leases = 0;
	private starting?: Promise<void>;
	private stopping?: Promise<void>;
	private timer?: ReturnType<typeof setTimeout>;
	private readonly env: NodeJS.ProcessEnv;
	private readonly idleStopMs: number;
	readonly managed: boolean;

	constructor(private readonly options: BrowserHostOptions = {}) {
		this.env = options.env ?? process.env;
		this.idleStopMs = options.idleStopMs ?? BROWSER_IDLE_STOP_MS;
		// A mistyped setting fails the server start rather than the first research run.
		headedSetting(this.env);
		this.managed = isManagedHost(browserHostEndpoint(this.env));
		this.scheduleStop();
	}

	/** Makes the browser ready and holds it until the returned release is called. */
	async acquire(): Promise<() => void> {
		this.leases += 1;
		clearTimeout(this.timer);
		try {
			await this.stopping;
			await (this.starting ??= this.start().finally(() => { this.starting = undefined; }));
		} catch (error) {
			this.release();
			throw error;
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.release();
		};
	}

	async withLease<T>(use: () => Promise<T>): Promise<T> {
		const release = await this.acquire();
		try {
			return await use();
		} finally {
			release();
		}
	}

	/** Server shutdown: nothing can use the browser any more, so a managed one stops with the server. */
	async shutdown(): Promise<void> {
		clearTimeout(this.timer);
		await this.stopping;
		if (!this.managed || !await probeBrowserHost(this.env)) return;
		await this.options.beforeStop?.().catch(() => undefined);
		await (this.options.stop ?? (() => stopManagedBrowserHost(this.env)))();
	}

	private async start(): Promise<void> {
		if (await probeBrowserHost(this.env)) return;
		await (this.options.start ?? (() => ensureBrowserReady(this.env)))();
		await this.options.afterStart?.().catch(() => undefined);
	}

	private release(): void {
		this.leases -= 1;
		if (this.leases === 0) this.scheduleStop();
	}

	private scheduleStop(): void {
		if (!this.managed) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.stopIfIdle(), this.idleStopMs);
		this.timer.unref?.();
	}

	private stopIfIdle(): Promise<void> | undefined {
		if (this.leases > 0 || this.starting) return undefined;
		return this.stopping ??= (async () => {
			if (!await probeBrowserHost(this.env)) return;
			await this.options.beforeStop?.().catch(() => undefined);
			if (this.leases > 0) return;
			await (this.options.stop ?? (() => stopManagedBrowserHost(this.env)))();
			console.log("[telomi][providers/browser] managed browser stopped after being idle");
		})().catch((error) => {
			console.warn(`[telomi][providers/browser] idle stop failed: ${error instanceof Error ? error.message : String(error)}`);
		}).finally(() => { this.stopping = undefined; });
	}
}

/** Stops the managed browser on the configured port; one this checkout does not own is left alone. */
export async function stopManagedBrowserHost(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const { options } = parseArgs(["stop", "--port", String(Number(browserHostEndpoint(env).port || "80")), "--only-profile"]);
	await stopChrome(options);
}

/** Starts the configured browser host if it is a managed local one; the start primitive behind `BrowserHost`. */
export async function ensureBrowserReady(
	env: NodeJS.ProcessEnv = process.env,
	start: typeof startChrome = startChrome,
): Promise<void> {
	const headed = headedSetting(env);
	const endpoint = browserHostEndpoint(env);
	const probe = () => probeBrowserHost(env);
	if (await probe()) return;
	if (!isManagedHost(endpoint)) throw new Error(`Browser CDP host is unavailable: ${endpoint.origin}; restore the configured host`);
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
