import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	browserSessionOwns,
	browserSessionRecorded,
	discoverLocalProviderEnvironment,
	refreshBrowserSessions,
	xCookieHeader,
	youtubeCookieFile,
} from "../../server/config/local-credentials.js";

const root = mkdtempSync(join(tmpdir(), "telomi-local-credentials-"));
	const appRoot = join(root, "app");
	const homeDir = join(root, "home");
	const dataDir = join(appRoot, "data");

try {
	mkdirSync(join(dataDir, ".pi", "agent"), { recursive: true });
	writeFileSync(join(dataDir, ".pi", "agent", "auth.json"), JSON.stringify({
		huggingface: { type: "api_key", key: "hf-from-auth-json" },
	}));

	const env: NodeJS.ProcessEnv = { TELOMI_DATA_DIR: dataDir };
	const browserCookies = [
		{ domain: ".twitter.com", name: "auth_token", value: "stale" },
		{ domain: ".x.com", name: "auth_token", value: "x-auth" },
		{ domain: ".x.com", name: "ct0", value: "x-csrf" },
		{ domain: ".x.com", name: "twid", value: "u=42" },
		{ domain: ".evilx.com", name: "ct0", value: "evil" },
		{ domain: ".youtube.com", name: "LOGIN_INFO", value: "yt-login", path: "/", secure: true, httpOnly: true, expires: 1800000000.5 },
		{ domain: ".google.com", name: "SID", value: "g-sid", path: "/", secure: false, httpOnly: false, expires: -1 },
		{ domain: ".notyoutube.com", name: "LOGIN_INFO", value: "other" },
		{ domain: ".youtube.com", name: "bad\tname", value: "x" },
	];
	const discovered = await discoverLocalProviderEnvironment(appRoot, env, {
		homeDir,
		readBrowserCookies: async () => browserCookies,
	});
	assert.deepEqual(discovered, ["huggingface-token", "twitter-browser-session", "youtube-browser-session"]);
	assert.equal(env.SOURCE_SERVICE_HUGGINGFACE_TOKEN, "hf-from-auth-json");
	assert.equal(env.SOURCE_SERVICE_TWITTER_COOKIE, "auth_token=x-auth; ct0=x-csrf; twid=u=42");
	assert.equal(browserSessionOwns("SOURCE_SERVICE_TWITTER_COOKIE"), true);
	assert.equal(browserSessionOwns("SOURCE_SERVICE_HUGGINGFACE_TOKEN"), false);
	// The YouTube login is a yt-dlp cookie file the Provider reads, private to this user.
	const cookieFile = env.PI_YOUTUBE_YTDLP_COOKIE_FILE!;
	assert.equal(cookieFile, join(dataDir, ".pi", "runtime", "browser-session", "youtube-cookies.txt"));
	assert.equal(statSync(cookieFile).mode & 0o777, 0o600);
	assert.equal(readFileSync(cookieFile, "utf8"), [
		"# Netscape HTTP Cookie File",
		"#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1800000000\tLOGIN_INFO\tyt-login",
		".google.com\tTRUE\t/\tFALSE\t0\tSID\tg-sid",
		"",
	].join("\n"));
	assert.equal(youtubeCookieFile([{ domain: ".youtube.com", name: "PREF", value: "x" }]), undefined, "no login, no cookie file");

	// A later refresh follows the browser: a new login replaces the header, a logout withdraws it.
	browserCookies[1] = { domain: ".x.com", name: "auth_token", value: "x-auth-2" };
	assert.deepEqual(await refreshBrowserSessions(env, { readBrowserCookies: async () => browserCookies }), ["twitter-browser-session", "youtube-browser-session"]);
	assert.equal(env.SOURCE_SERVICE_TWITTER_COOKIE, "auth_token=x-auth-2; ct0=x-csrf; twid=u=42");

	// The browser runs on demand. While it is stopped (no answer), the saved session stands, including
	// in a new process that never read the browser; the same session read again rewrites no file.
	const sessionDir = join(dataDir, ".pi", "runtime", "browser-session");
	assert.equal(browserSessionRecorded(env), true);
	const saved = statSync(join(sessionDir, "x-cookie-header.txt")).mtimeMs;
	assert.deepEqual(await refreshBrowserSessions(env, { readBrowserCookies: async () => browserCookies }), ["twitter-browser-session", "youtube-browser-session"]);
	assert.equal(statSync(join(sessionDir, "x-cookie-header.txt")).mtimeMs, saved, "an unchanged session is not rewritten");
	const restarted: NodeJS.ProcessEnv = { TELOMI_DATA_DIR: dataDir };
	assert.deepEqual(await refreshBrowserSessions(restarted, { readBrowserCookies: async () => undefined }), ["twitter-browser-session", "youtube-browser-session"]);
	assert.equal(restarted.SOURCE_SERVICE_TWITTER_COOKIE, "auth_token=x-auth-2; ct0=x-csrf; twid=u=42");
	assert.equal(restarted.PI_YOUTUBE_YTDLP_COOKIE_FILE, join(sessionDir, "youtube-cookies.txt"));
	assert.equal(browserSessionRecorded({ TELOMI_DATA_DIR: join(root, "fresh-data") }), false, "a new installation has never read its browser");

	assert.deepEqual(await refreshBrowserSessions(env, { readBrowserCookies: async () => [] }), []);
	assert.equal(env.SOURCE_SERVICE_TWITTER_COOKIE, undefined);
	assert.equal(env.PI_YOUTUBE_YTDLP_COOKIE_FILE, undefined);
	assert.equal(browserSessionOwns("SOURCE_SERVICE_TWITTER_COOKIE"), false);
	// A logout the browser shows is saved too: the next process does not bring the old session back.
	const afterLogout: NodeJS.ProcessEnv = { TELOMI_DATA_DIR: dataDir };
	assert.deepEqual(await refreshBrowserSessions(afterLogout, { readBrowserCookies: async () => undefined }), []);

	let browserRead = false;
	const explicit: NodeJS.ProcessEnv = {
		PI_YOUTUBE_YTDLP_COOKIE_FILE: "/private/youtube.txt",
		HF_TOKEN: "hf-explicit",
		X_COOKIE_FILE: "/private/x.txt",
	};
	assert.deepEqual(await discoverLocalProviderEnvironment(appRoot, explicit, {
		homeDir,
		readBrowserCookies: async () => {
			browserRead = true;
			return [];
		},
	}), []);
	assert.equal(browserRead, false);
	assert.equal(xCookieHeader([
		{ domain: ".x.com", name: "auth_token", value: "auth" },
		{ domain: ".x.com", name: "ct0", value: "bad;injection" },
	]), undefined);

	console.log("local credential discovery: all assertions passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
