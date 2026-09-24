import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

import { ensureBrowserReady, profileNeedsSync } from "../../server/providers/browser/startup.js";
import { detachBrowserAccount, headlessUserAgent, parseArgs, syncFromDefaultBrowser } from "../../scripts/chrome-debug.js";
import { DatabaseSync } from "node:sqlite";

// Exercise the real startup entrypoints with a local CDP fixture and an npm
// recorder. Deterministic: no browser, Provider, model, or personal profile.
const exec = promisify(execFile);
const app = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = mkdtempSync(join(tmpdir(), "telomi-browser-startup-"));
let userAgent: string | undefined = "Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36";
let available = true;
let cdpEndpoint = "";
let closeRequests = 0;
let ownedProcess: ChildProcess | undefined;
const server = createServer((_req, res) => {
	if (!available) { res.writeHead(503).end(); return; }
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify({ Browser: "Chrome/152.0.0.0", "User-Agent": userAgent, webSocketDebuggerUrl: cdpEndpoint }));
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => socket.on("message", (data) => {
	if (JSON.parse(data.toString()).method === "Browser.close") { closeRequests++; available = false; }
	socket.send(JSON.stringify({ id: 1, result: {} }));
}));

try {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address !== "string");
	cdpEndpoint = `ws://127.0.0.1:${address.port}/devtools/browser/fixture`;
	const chrome = (command: string, ...args: string[]) => exec(process.execPath, [
		"--import", "tsx", "scripts/chrome-debug.ts", command, "--port", String(address.port),
		"--state-dir", join(fixture, "state"), "--profile-dir", join(fixture, "profile"),
		"--source-dir", join(fixture, "source"), ...args,
	], { cwd: app });
	await assert.rejects(chrome("stop"), /not owned/u);
	assert.equal(closeRequests, 0, "never close another Worktree's CDP endpoint");
	const isolatedApp = join(fixture, "isolated");
	mkdirSync(join(isolatedApp, "scripts"), { recursive: true });
	mkdirSync(join(isolatedApp, "server/config"), { recursive: true });
	mkdirSync(join(isolatedApp, "server/workspaces"), { recursive: true });
	mkdirSync(join(isolatedApp, "node_modules"));
	symlinkSync(dirname(fileURLToPath(import.meta.resolve("ws/package.json"))), join(isolatedApp, "node_modules/ws"), "dir");
	copyFileSync(join(app, "scripts/chrome-debug.ts"), join(isolatedApp, "scripts/chrome-debug.ts"));
	for (const module of ["config/environment.ts", "config/data-dir.ts", "workspaces/server-runtime-paths.ts", "workspaces/goal-runtime-paths.ts"]) {
		copyFileSync(join(app, "server", module), join(isolatedApp, "server", module));
	}
	writeFileSync(join(isolatedApp, "package.json"), '{"type":"module"}');
	writeFileSync(join(isolatedApp, ".env.worktree"), `TELOMI_BROWSER_HOST_CDP_URL=http://127.0.0.1:${address.port}\n`);
	const status = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), "scripts/chrome-debug.ts", "status"], {
		cwd: isolatedApp, env: { ...process.env, TELOMI_BROWSER_HOST_CDP_URL: "http://127.0.0.1:1" },
	});
	assert.equal(JSON.parse(status.stdout).port, address.port, "CLI uses this Worktree's endpoint over its parent's");
	assert.equal(JSON.parse(status.stdout).status, "running");
	assert.equal(JSON.parse((await chrome("status", "--headless")).stdout).headless, false);
	await assert.rejects(chrome("start", "--headless"), /already running in headed mode; requested headless/u);
	const headed = JSON.parse((await chrome("start", "--headed")).stdout);
	assert.equal(headed.headless, false);
	assert.equal(headed.profileDir, null, "do not invent a profile for an unowned CDP endpoint");
	userAgent = "Mozilla/5.0 HeadlessChrome/152.0.0.0 Safari/537.36";
	assert.equal(JSON.parse((await chrome("start", "--headless")).stdout).headless, true);
	assert.equal(JSON.parse((await chrome("status", "--headed")).stdout).headless, true);
	await assert.rejects(chrome("start", "--headed"), /already running in headless mode; requested headed/u);
	userAgent = undefined;
	assert.equal(JSON.parse((await chrome("status")).stdout).headless, null);
	await assert.rejects(chrome("start"), /already running in unknown mode/u);

	const boot = join(fixture, "app");
	const bin = join(fixture, "bin");
	const calls = join(fixture, "npm-calls.jsonl");
	mkdirSync(join(boot, "node_modules"), { recursive: true });
	mkdirSync(join(boot, ".chrome-debug-profile"));
	writeFileSync(join(boot, ".chrome-debug-profile", "Local State"), "{}");
	mkdirSync(bin);
	copyFileSync(join(app, "start.sh"), join(boot, "start.sh"));
	writeFileSync(join(bin, "npm"), `#!${process.execPath}\n` +
		`require('node:fs').appendFileSync(process.env.STARTUP_CALLS, JSON.stringify({args:process.argv.slice(2),port:process.env.PORT,apiPort:process.env.API_PORT})+'\\n');\n`, { mode: 0o755 });
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STARTUP_CALLS: calls };
	for (const key of ["PORT", "API_PORT", "TELOMI_DATA_DIR", "TELOMI_START_BROWSER", "TELOMI_BROWSER_HEADED", "TELOMI_EVAL_INSTANCE"]) delete (env as NodeJS.ProcessEnv)[key];
	writeFileSync(join(boot, ".env"), "TELOMI_BROWSER_HEADED=true\nPORT=8910\n");
	const launch = async (local: string, overrides: NodeJS.ProcessEnv = {}) => {
		writeFileSync(join(boot, ".env.local"), local);
		writeFileSync(calls, "");
		await exec("bash", [join(boot, "start.sh"), "dev"], { env: { ...env, ...overrides } });
		return readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	};
	const entries = await launch("PORT=8911\n");
	assert.deepEqual(entries.map((entry) => entry.args), [["run", "dev"]]);
	assert.equal(entries[0].port, "8911");
	assert.equal(entries[0].apiPort, "8911");
	// start.sh delegates to the same application initializer as direct npm start/dev:server.
	assert.ok(/await ensureBrowserReady\(/u.test(readFileSync(join(app, "server/app.ts"), "utf8")), "all server entrypoints must await Browser readiness");
	for (const overrides of [{}, { TELOMI_EVAL_INSTANCE: "1", TELOMI_START_BROWSER: "false" }]) {
		const config = { ...overrides, TELOMI_BROWSER_HOST_CDP_URL: `http://127.0.0.1:${address.port}`, TELOMI_BROWSER_HEADED: "true" };
		await ensureBrowserReady(config, async () => { assert.fail("existing CDP must not launch or sync a profile"); });
		available = false;
		let starts = 0;
		await ensureBrowserReady(config, async (options) => {
			starts++;
			assert.equal(options.port, address.port);
			assert.equal(options.headless, false);
			assert.equal(options.onlyProfile, true);
			available = true;
		});
		assert.equal(starts, 1, "missing local Browser starts regardless of old feature switches");
	}
	available = false;
	await assert.rejects(ensureBrowserReady({ TELOMI_BROWSER_HOST_CDP_URL: `http://127.0.0.1:${address.port}/remote` }, async () => {
		assert.fail("configured remote host must never launch a local substitute");
	}), /Browser CDP host is unavailable/u);
	await assert.rejects(ensureBrowserReady({ TELOMI_BROWSER_HOST_CDP_URL: `http://127.0.0.1:${address.port}` }, async () => {}), /did not become ready/u);
	await assert.rejects(ensureBrowserReady({ TELOMI_BROWSER_HEADED: "typo" }), /must be true or false/u);

	// A profile without its cookie database holds no logins: missing, emptied, or deleted under a
	// running browser (which regrows everything but its open databases). Each case is re-synced.
	const profile = join(fixture, "health");
	assert.equal(profileNeedsSync(profile, "Default"), true, "missing profile");
	mkdirSync(profile);
	assert.equal(profileNeedsSync(profile, "Default"), true, "empty profile");
	mkdirSync(join(profile, "Default"), { recursive: true });
	writeFileSync(join(profile, "Local State"), "{}");
	writeFileSync(join(profile, "Default", "Preferences"), "{}");
	assert.equal(profileNeedsSync(profile, "Default"), true, "profile regrown without its cookie database");
	writeFileSync(join(profile, "Default", "Cookies"), "");
	assert.equal(profileNeedsSync(profile, "Default"), false, "complete profile is kept");
	assert.equal(profileNeedsSync(profile, "Profile 7"), true, "the selected profile is the one checked");

	// A copied profile keeps its website cookies but loses the Chrome-level Google sign-in, so it
	// cannot rotate the user's refresh token as "the same device" and sign their own Chrome out.
	const copied = join(fixture, "copied");
	mkdirSync(copied);
	const webData = new DatabaseSync(join(copied, "Web Data"));
	webData.exec("CREATE TABLE token_service (service VARCHAR PRIMARY KEY NOT NULL, encrypted_token BLOB, binding_key BLOB, mtls_token_binding INTEGER)");
	webData.exec("INSERT INTO token_service (service, encrypted_token) VALUES ('AccountId-1', x'00')");
	webData.exec("CREATE TABLE autofill (name VARCHAR)");
	webData.exec("INSERT INTO autofill (name) VALUES ('kept')");
	webData.close();
	writeFileSync(join(copied, "Preferences"), JSON.stringify({
		account_info: [{ email: "user@example.com" }],
		google: { services: { consented_to_sync: true, last_gaia_id: "1" }, other: "kept" },
		signin: { allowed: true, accounts_metadata_dict: {} },
		sync: { has_setup_completed: true },
		profile: { name: "kept" },
	}));
	detachBrowserAccount(copied);
	const stripped = new DatabaseSync(join(copied, "Web Data"), { readOnly: true });
	assert.equal(stripped.prepare("SELECT count(*) AS n FROM token_service").get()?.n, 0, "refresh tokens are removed");
	assert.equal(stripped.prepare("SELECT name FROM autofill").get()?.name, "kept", "other tables are kept");
	stripped.close();
	assert.deepEqual(JSON.parse(readFileSync(join(copied, "Preferences"), "utf8")), {
		google: { other: "kept" },
		signin: { allowed: false, allowed_on_next_startup: false },
		profile: { name: "kept" },
	});
	detachBrowserAccount(join(fixture, "absent"));

	// A copy never carries the user's Google session (it and the original would invalidate each
	// other), and the login Telomi's browser made itself survives a re-copy. Other logins are copied.
	const cookieSchema = "CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT, encrypted_value BLOB, path TEXT NOT NULL DEFAULT '/', PRIMARY KEY (host_key, name, path))";
	const cookieRows = (dir: string, rows: Array<[string, string, string]>) => {
		mkdirSync(join(dir, "Default"), { recursive: true });
		writeFileSync(join(dir, "Local State"), JSON.stringify({ profile: { info_cache: { Default: {} } } }));
		const db = new DatabaseSync(join(dir, "Default", "Cookies"));
		db.exec(cookieSchema);
		for (const row of rows) db.prepare("INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, x'01')").run(...row);
		db.close();
	};
	const source = join(fixture, "sync-source");
	const managed = join(fixture, "sync-managed");
	cookieRows(source, [[".google.com", "SID", "theirs"], [".youtube.com", "LOGIN_INFO", "theirs"], ["accounts.google.com", "x", "theirs"], [".x.com", "auth_token", "theirs"], ["notgoogle.com", "k", "theirs"]]);
	cookieRows(managed, [[".google.com", "SID", "own"], [".youtube.com", "LOGIN_INFO", "own"], [".x.com", "auth_token", "stale"]]);
	const syncOptions = parseArgs(["sync-default", "--source-dir", source, "--profile-dir", managed, "--only-profile"]).options;
	syncFromDefaultBrowser(syncOptions);
	const synced = new DatabaseSync(join(managed, "Default", "Cookies"), { readOnly: true });
	const cookieValues = () => Object.fromEntries((synced.prepare("SELECT host_key, name, value FROM cookies ORDER BY host_key, name").all() as Array<{ host_key: string; name: string; value: string }>).map((row) => [`${row.host_key} ${row.name}`, row.value]));
	assert.deepEqual(cookieValues(), {
		".google.com SID": "own",
		".youtube.com LOGIN_INFO": "own",
		".x.com auth_token": "theirs",
		"notgoogle.com k": "theirs",
	});
	synced.close();
	rmSync(join(managed, "Default", "Cookies"));
	syncFromDefaultBrowser(syncOptions);
	const fresh = new DatabaseSync(join(managed, "Default", "Cookies"), { readOnly: true });
	assert.deepEqual((fresh.prepare("SELECT host_key FROM cookies ORDER BY host_key").all() as Array<{ host_key: string }>).map((row) => row.host_key), [".x.com", "notgoogle.com"], "a first copy holds no Google session at all");
	fresh.close();

	// Headless Chrome presents the reduced User-Agent of a headed Chrome of the same build.
	const fakeChrome = join(fixture, "chrome");
	writeFileSync(fakeChrome, "#!/bin/sh\necho 'Google Chrome 152.0.7977.83'\n", { mode: 0o755 });
	assert.equal(headlessUserAgent(fakeChrome, "darwin"), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36");
	assert.match(headlessUserAgent(fakeChrome, "linux"), /^Mozilla\/5\.0 \(X11; Linux x86_64\) .*Chrome\/152\.0\.0\.0 Safari\/537\.36$/u);

	available = true;
	mkdirSync(join(fixture, "state"), { recursive: true });
	const state = { pid: process.pid, port: address.port, profileDir: join(fixture, "profile") };
	const stateFile = join(fixture, "state", "chrome-debug.json");
	writeFileSync(stateFile, JSON.stringify(state));
	await assert.rejects(chrome("stop"), /not owned/u);
	assert.equal(closeRequests, 0, "a reused PID does not authorize closing the endpoint");
	ownedProcess = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)", "--",
		`--remote-debugging-port=${address.port}`, `--user-data-dir=${state.profileDir}`], { stdio: "ignore" });
	await once(ownedProcess, "spawn");
	writeFileSync(stateFile, JSON.stringify({ ...state, pid: ownedProcess.pid }));
	assert.equal(JSON.parse((await chrome("stop")).stdout).stopped, true);
	assert.equal(closeRequests, 1, "the owned browser remains stoppable");

	console.log("browser startup checks actual CDP mode, env precedence, ports, profile health, and fail-fast behavior");
} finally {
	if (ownedProcess && ownedProcess.exitCode === null && ownedProcess.signalCode === null) {
		ownedProcess.kill();
		await once(ownedProcess, "exit");
	}
	for (const socket of sockets.clients) socket.terminate();
	sockets.close();
	server.closeAllConnections();
	await new Promise<void>((done) => server.close(() => done()));
	rmSync(fixture, { recursive: true, force: true });
}
