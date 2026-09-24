import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolveDataDir } from "./data-dir.js";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import WebSocket from "ws";
import { resolveAgentDir } from "./agent-directory.js";

type BrowserCookie = {
	domain?: unknown;
	name?: unknown;
	value?: unknown;
	path?: unknown;
	secure?: unknown;
	httpOnly?: unknown;
	expires?: unknown;
};

export interface LocalCredentialDiscoveryOptions {
	homeDir?: string;
	readBrowserCookies?: (cdpUrl: string) => Promise<BrowserCookie[] | undefined>;
}

/**
 * Environment names whose value is the user's live browser session rather than a configured
 * credential. They are refreshed from the Browser host and never written to the credential store.
 */
const browserOwned = new Set<string>();

/** Whether this environment variable currently carries the user's browser session. */
export function browserSessionOwns(envName: string): boolean {
	return browserOwned.has(envName);
}

/** Discover existing local credentials without persisting or logging secrets. */
export async function discoverLocalProviderEnvironment(
	appRoot: string,
	env: NodeJS.ProcessEnv = process.env,
	options: LocalCredentialDiscoveryOptions = {},
): Promise<string[]> {
	const discovered: string[] = [];
	const home = options.homeDir ?? homedir();

	if (!env.SOURCE_SERVICE_HUGGINGFACE_TOKEN && !env.HF_TOKEN) {
		const token = huggingFaceToken(env, home, resolveAgentDir(resolveDataDir(env, appRoot)));
		if (token) {
			env.SOURCE_SERVICE_HUGGINGFACE_TOKEN = token;
			discovered.push("huggingface-token");
		}
	}

	discovered.push(...await refreshBrowserSessions(env, options, appRoot));
	return discovered;
}

/**
 * Re-read the user's browser session from the Browser host: the X login as the Twitter cookie
 * header, the YouTube/Google login as a yt-dlp cookie file. Called at startup, before each
 * research run and around each start and idle stop of the managed browser, so a session that was
 * refreshed or expired in the browser is what the next run uses. Both are kept in the runtime
 * directory: the browser runs only while something uses it, and while it is stopped the last
 * session it held is still the user's. A value the user set explicitly is never touched.
 */
export async function refreshBrowserSessions(
	env: NodeJS.ProcessEnv = process.env,
	options: LocalCredentialDiscoveryOptions = {},
	appRoot?: string,
): Promise<string[]> {
	const wantsTwitter = browserOwned.has("SOURCE_SERVICE_TWITTER_COOKIE")
		|| (!env.SOURCE_SERVICE_TWITTER_COOKIE && !env.TWITTER_COOKIE && !env.X_COOKIE
			&& !env.SOURCE_SERVICE_TWITTER_COOKIE_FILE && !env.TWITTER_COOKIE_FILE && !env.X_COOKIE_FILE);
	const wantsYouTube = browserOwned.has("PI_YOUTUBE_YTDLP_COOKIE_FILE")
		|| (!env.PI_YOUTUBE_YTDLP_COOKIE_FILE && !env.PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER);
	if (!wantsTwitter && !wantsYouTube) return [];

	const cdpUrl = env.TELOMI_BROWSER_HOST_CDP_URL?.trim() || "http://127.0.0.1:9222";
	// Undefined while the host is not running: the saved session stands until the browser says otherwise.
	const cookies = await (options.readBrowserCookies ?? readBrowserCookies)(cdpUrl);
	const sessionDir = browserSessionDir(env, appRoot);
	const discovered: string[] = [];
	if (cookies && !browserSessionRecorded(env, appRoot)) {
		// Written once and never rewritten, so a later read that finds the same session changes no file.
		mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(sessionDir, SESSION_READ_MARKER), "");
	}

	if (wantsTwitter) {
		const path = join(sessionDir, "x-cookie-header.txt");
		const header = cookies ? xCookieHeader(cookies) : readBrowserSessionFile(path);
		if (cookies) saveBrowserSessionFile(path, header);
		if (header) {
			env.SOURCE_SERVICE_TWITTER_COOKIE = header;
			browserOwned.add("SOURCE_SERVICE_TWITTER_COOKIE");
			discovered.push("twitter-browser-session");
		} else if (browserOwned.delete("SOURCE_SERVICE_TWITTER_COOKIE")) {
			delete env.SOURCE_SERVICE_TWITTER_COOKIE;
		}
	}

	if (wantsYouTube) {
		const path = join(sessionDir, "youtube-cookies.txt");
		const file = cookies ? youtubeCookieFile(cookies) : readBrowserSessionFile(path);
		if (cookies) saveBrowserSessionFile(path, file);
		if (file) {
			env.PI_YOUTUBE_YTDLP_COOKIE_FILE = path;
			browserOwned.add("PI_YOUTUBE_YTDLP_COOKIE_FILE");
			discovered.push("youtube-browser-session");
		} else if (browserOwned.delete("PI_YOUTUBE_YTDLP_COOKIE_FILE")) {
			delete env.PI_YOUTUBE_YTDLP_COOKIE_FILE;
		}
	}

	return discovered;
}

const SESSION_READ_MARKER = "read";

function browserSessionDir(env: NodeJS.ProcessEnv, appRoot?: string): string {
	return join(resolveDataDir(env, appRoot), ".pi", "runtime", "browser-session");
}

/**
 * Whether the saved browser session reflects a read of the browser. Until one has happened (a new
 * installation, or one from before the session was saved), a missing file means "not known" rather
 * than "logged out", and the browser has to be read once.
 */
export function browserSessionRecorded(env: NodeJS.ProcessEnv = process.env, appRoot?: string): boolean {
	return existsSync(join(browserSessionDir(env, appRoot), SESSION_READ_MARKER));
}

function readBrowserSessionFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8") || undefined;
	} catch {
		return undefined;
	}
}

/**
 * The browser's current session, or its absence once the browser shows it logged out. An unchanged
 * session is not rewritten, so reading the browser alone never looks like new user data.
 */
function saveBrowserSessionFile(path: string, content: string | undefined): void {
	if (!content) {
		rmSync(path, { force: true });
		return;
	}
	if (readBrowserSessionFile(path) === content) return;
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(path, content, { mode: 0o600 });
}

/**
 * A freshly launched browser host answers with a partial cookie set while its profile loads. Wait
 * until two consecutive reads agree, so a login is not judged on half of its cookies.
 */
export async function waitForBrowserCookies(cdpUrl: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let previous = -1;
	while (Date.now() < deadline) {
		const count = (await readBrowserCookies(cdpUrl))?.length ?? 0;
		if (count > 0 && count === previous) return;
		previous = count;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

/**
 * The YouTube and Google cookies as a Netscape cookie file for yt-dlp, or nothing when the
 * browser holds no YouTube login. Reading the Browser host's cookie database directly would tie
 * this to that host's profile directory and to the OS keychain; the session over CDP is the same
 * data without either.
 */
export function youtubeCookieFile(cookies: BrowserCookie[]): string | undefined {
	const lines: string[] = [];
	let loggedIn = false;
	for (const cookie of cookies) {
		if (typeof cookie.domain !== "string" || typeof cookie.name !== "string" || typeof cookie.value !== "string") continue;
		const domain = cookie.domain.toLowerCase();
		const host = domain.replace(/^\./u, "");
		if (!(host === "youtube.com" || host.endsWith(".youtube.com") || host === "google.com" || host.endsWith(".google.com"))) continue;
		if (/[\t\r\n]/u.test(cookie.name) || /[\t\r\n]/u.test(cookie.value)) continue;
		if (cookie.name === "LOGIN_INFO" || cookie.name === "SID" || cookie.name === "__Secure-1PSID") loggedIn = true;
		const expires = typeof cookie.expires === "number" && cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
		const path = typeof cookie.path === "string" && cookie.path.startsWith("/") && !/[\t\r\n]/u.test(cookie.path) ? cookie.path : "/";
		lines.push([
			`${cookie.httpOnly === true ? "#HttpOnly_" : ""}${domain}`,
			domain.startsWith(".") ? "TRUE" : "FALSE",
			path,
			cookie.secure === true ? "TRUE" : "FALSE",
			String(expires),
			cookie.name,
			cookie.value,
		].join("\t"));
	}
	if (!loggedIn) return undefined;
	return `# Netscape HTTP Cookie File\n${lines.join("\n")}\n`;
}

export function xCookieHeader(cookies: BrowserCookie[]): string | undefined {
	const selected = new Map<string, string>();
	const ordered = [...cookies].sort((left, right) => cookieDomainRank(left.domain) - cookieDomainRank(right.domain));
	for (const cookie of ordered) {
		if (!isXDomain(cookie.domain) || typeof cookie.name !== "string" || typeof cookie.value !== "string") continue;
		if (!["auth_token", "ct0", "twid"].includes(cookie.name) || /[;\r\n]/u.test(cookie.value)) continue;
		if (!selected.has(cookie.name)) selected.set(cookie.name, cookie.value);
	}
	if (!selected.get("auth_token") || !selected.get("ct0")) return undefined;
	return ["auth_token", "ct0", "twid"]
		.flatMap((name) => selected.has(name) ? [`${name}=${selected.get(name)}`] : [])
		.join("; ");
}

function huggingFaceToken(env: NodeJS.ProcessEnv, home: string, agentDir: string): string | undefined {
	const legacyEnv = env.HUGGING_FACE_HUB_TOKEN?.trim();
	if (legacyEnv) return legacyEnv;
	const authToken = huggingFaceAuthToken(join(agentDir, "auth.json"));
	if (authToken) return authToken;
	const candidates = [
		env.HF_TOKEN_PATH,
		env.HF_HOME ? join(env.HF_HOME, "token") : undefined,
		env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, "huggingface", "token") : undefined,
		join(home, ".cache", "huggingface", "token"),
		join(home, ".huggingface", "token"),
	];
	for (const path of candidates) {
		if (!path || (!isAbsolute(path) && path !== env.HF_TOKEN_PATH)) continue;
		const token = readSmallSecret(path);
		if (token) return token;
	}
	return undefined;
}

function huggingFaceAuthToken(path: string): string | undefined {
	const text = readSmallSecret(path);
	if (!text) return undefined;
	try {
		const entry = (JSON.parse(text) as Record<string, unknown>).huggingface;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
		const credential = entry as Record<string, unknown>;
		return credential.type === "api_key" && typeof credential.key === "string"
			? credential.key.trim() || undefined
			: undefined;
	} catch {
		return undefined;
	}
}

function readSmallSecret(path: string): string | undefined {
	try {
		const stats = statSync(path);
		if (!stats.isFile() || stats.size > 1024 * 1024) return undefined;
		return readFileSync(path, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/** The browser's cookies, or undefined when the host is not running or did not answer. */
export async function readBrowserCookies(cdpUrl: string): Promise<BrowserCookie[] | undefined> {
	try {
		const base = new URL(cdpUrl);
		if (base.protocol !== "http:" && base.protocol !== "https:") return undefined;
		const response = await fetch(new URL("/json/version", base), { signal: AbortSignal.timeout(2_000) });
		if (!response.ok) return undefined;
		const version = await response.json() as { webSocketDebuggerUrl?: unknown };
		if (typeof version.webSocketDebuggerUrl !== "string") return undefined;
		return await browserCookiesFromSocket(version.webSocketDebuggerUrl);
	} catch {
		return undefined;
	}
}

function browserCookiesFromSocket(endpoint: string): Promise<BrowserCookie[] | undefined> {
	return new Promise((resolve) => {
		const socket = new WebSocket(endpoint);
		let settled = false;
		const finish = (cookies?: BrowserCookie[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try { socket.close(); } catch { /* already unavailable */ }
			resolve(cookies);
		};
		const timer = setTimeout(() => finish(), 2_000);
		socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "Storage.getCookies" })));
		socket.once("error", () => finish());
		socket.once("close", () => finish());
		socket.on("message", (data) => {
			try {
				const message = JSON.parse(data.toString()) as { id?: unknown; result?: { cookies?: unknown } };
				if (message.id === 1) finish(Array.isArray(message.result?.cookies) ? message.result.cookies : undefined);
			} catch {
				finish();
			}
		});
	});
}

function isXDomain(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const domain = value.toLowerCase().replace(/^\./u, "");
	return domain === "x.com" || domain.endsWith(".x.com")
		|| domain === "twitter.com" || domain.endsWith(".twitter.com");
}

function cookieDomainRank(value: unknown): number {
	if (typeof value !== "string") return 2;
	const domain = value.toLowerCase().replace(/^\./u, "");
	return domain === "x.com" || domain.endsWith(".x.com") ? 0 : 1;
}
