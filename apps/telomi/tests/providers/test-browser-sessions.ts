import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";

import { WebSocketServer } from "ws";

import { BrowserSessionRegistry } from "../../server/providers/browser/session-registry.js";

/**
 * Unit coverage for the namespace + per-run BrowserSessionRegistry. A fake
 * agent-browser binary and a fake namespace run directory let us assert fresh
 * sessions per run, the exact run env, namespace determinism, and - critically -
 * the kill-safety rule: a stale pid pointing at a live unrelated process is
 * never signalled.
 */

const root = mkdtempSync(join(tmpdir(), "telomi-browser-ns-"));
const daemonHome = join(root, "home");
const namespace = "telomi-unit";
const runDir = join(daemonHome, "namespaces", namespace, "run");
mkdirSync(runDir, { recursive: true });
const closeLog = join(root, "close.log");
const screenshotLog = join(root, "screenshot.log");
const viewportLog = join(root, "viewport.log");

// Fake agent-browser: logs `--session X close`, and removes `<X>.pid` (a graceful
// daemon exit) UNLESS the session id contains "stale" (a daemon `close` cannot
// reach - e.g. because the pid was recycled by an unrelated process).
const fakeBin = join(root, "fake-agent-browser");
writeFileSync(
	fakeBin,
	`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const i = args.indexOf("--session");
if (i >= 0 && args[i + 2] === "close") {
	const session = args[i + 1];
	fs.appendFileSync(${JSON.stringify(closeLog)}, session + "\\n");
	if (!session.includes("stale") && !fs.existsSync(path.join(${JSON.stringify(runDir)}, "keep-alive"))) {
		try { fs.unlinkSync(path.join(${JSON.stringify(runDir)}, session + ".pid")); } catch {}
	}
}
if (i >= 0 && args[i + 2] === "screenshot") {
	const file = args[i + 3];
	fs.appendFileSync(${JSON.stringify(screenshotLog)}, file + "\\n");
	fs.writeFileSync(file, "png");
}
// Commands arrive as "--session <id> <command> ..." or, with the session in the env, "<command> ...".
const at = i >= 0 ? i + 2 : 0;
const command = args[at];
const first = args[at + 1] || "";
if (command === "set") fs.appendFileSync(${JSON.stringify(viewportLog)}, args.slice(at).join(" ") + "\\n");
const counter = (name) => { const f = path.join(${JSON.stringify(runDir)}, name + ".count"); const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1; fs.writeFileSync(f, String(n)); return n; };
// A site verification interstitial: "clears" clears after the first look, "blocked" never does.
if (command === "open" && /clears|blocked/.test(first)) {
	const cleared = /clears/.test(first) && counter("open-clears") > 1;
	fs.writeSync(1, (cleared ? "✓ Real Article" : "✓ Just a moment...") + "\\n  " + first + "\\n");
	process.exit(0);
}
if (command === "get" && first === "title") {
	counter("get-title");
	fs.writeSync(1, (fs.existsSync(path.join(${JSON.stringify(runDir)}, "open-clears.count")) ? "Real Article" : "Just a moment...") + "\\n");
	process.exit(0);
}
if (command === "wait") setTimeout(() => process.exit(0), Number(first) < 1000 ? Number(first) || 0 : 0);
else process.exit(0);
`,
	{ mode: 0o755 },
);
chmodSync(fakeBin, 0o755);

function closed(): string[] {
	if (!existsSync(closeLog)) return [];
	return readFileSync(closeLog, "utf-8").split("\n").map((s) => s.trim()).filter(Boolean);
}
function writePid(sessionId: string, pid: number): void {
	writeFileSync(join(runDir, `${sessionId}.pid`), `${pid}\n`);
}

const registry = new BrowserSessionRegistry({
	namespace,
	daemonHome,
	cdpUrl: "9222",
	agentBrowserBin: fakeBin,
	idleTimeoutMs: 3_600_000,
});

// 1. Fresh session per run; exact, namespaced, pin-tabbed env.
const envA = registry.beginRun("goal-1", "main-run-A");
assert.equal(registry.observe("goal-1")?.state, "queued");
assert.equal(envA.AGENT_BROWSER_NAMESPACE, namespace);
assert.equal(envA.AGENT_BROWSER_SOCKET_DIR, registry.config.daemonHome);
assert.match(envA.AGENT_BROWSER_SESSION, /^r-[A-Za-z0-9_-]{10}$/u);
assert.equal(envA.AGENT_BROWSER_PIN_TAB, "1");
assert.equal(envA.AGENT_BROWSER_CDP, "http://127.0.0.1:9222");
assert.equal(envA.AGENT_BROWSER_IDLE_TIMEOUT_MS, "3600000");

// 2. Sequential same-goal runs get distinct sessions.
await registry.endRun("goal-1", "main-run-A", "completed");
const envB = registry.beginRun("goal-1", "main-run-B");
assert.notEqual(envA.AGENT_BROWSER_SESSION, envB.AGENT_BROWSER_SESSION, "a later run of the same goal differs");
assert.match(registry.envForActiveRun("goal-1")?.AGENT_BROWSER_SESSION ?? "", /^r-[A-Za-z0-9_-]{10}$/u);

// 3. One owner cannot replace an active workspace before Runtime releases it.
assert.throws(() => registry.beginRun("goal-1", "main-run-C"), /already has an active workspace/u);
await registry.endRun("goal-1", "main-run-B", "completed");
registry.beginRun("goal-1", "main-run-C");
await registry.endRun("goal-1", "main-run-C", "completed");
assert.equal(registry.envForActiveRun("goal-1"), undefined);

// 4. Namespace: deterministic per data root, overridable.
const nsX = new BrowserSessionRegistry({ dataRoot: "/data/x", daemonHome, agentBrowserBin: fakeBin }).config.namespace;
const nsX2 = new BrowserSessionRegistry({ dataRoot: "/data/x", daemonHome, agentBrowserBin: fakeBin }).config.namespace;
const nsY = new BrowserSessionRegistry({ dataRoot: "/data/y", daemonHome, agentBrowserBin: fakeBin }).config.namespace;
assert.equal(nsX, nsX2, "same data root -> same namespace");
assert.notEqual(nsX, nsY, "different data roots -> different namespaces");
assert.ok(nsX.startsWith("telomi-"));
assert.equal(new BrowserSessionRegistry({ namespace: "telomi-override", daemonHome }).config.namespace, "telomi-override");

// 5. Kill-safety: a stale pid that now belongs to a LIVE unrelated process must
//    never be signalled. Park a real child process, point a stale sidecar at it,
//    and confirm cleanup leaves it alive and only drops our own sidecars.
const bystander = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)", "agent-browser"], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 100));
const bystanderPid = bystander.pid!;
assert.ok(isAlive(bystanderPid), "bystander should be running");
writePid("run-stale-session", bystanderPid); // a live, non-agent-browser pid
const before = closed().length;
const reclaimed = await registry.sweep("crash-backstop");
assert.ok(reclaimed >= 1, "sweep reclaims the stale namespace session");
assert.ok(closed().slice(before).includes("run-stale-session"), "sweep attempts a graceful close first");
assert.ok(isAlive(bystanderPid), "the unrelated live process was NOT signalled");
assert.ok(!existsSync(join(runDir, "run-stale-session.pid")), "our own stale sidecar was dropped");
bystander.kill("SIGKILL");

// 6. Graceful path: a live 'agent-browser' session whose close removes its pid is
//    reclaimed with no signalling needed.
writePid("run-graceful-session", process.pid); // alive; close() removes the pid file
writeFileSync(join(runDir, "run-graceful-session.config"), "config");
writeFileSync(join(runDir, "run-graceful-session.target"), "{}");
const before2 = closed().length;
await registry.sweep("crash-backstop");
assert.ok(closed().slice(before2).includes("run-graceful-session"));
assert.ok(!existsSync(join(runDir, "run-graceful-session.pid")), "graceful close removed the daemon sidecar");
assert.ok(!existsSync(join(runDir, "run-graceful-session.config")), "cleanup removes the session config sidecar");
assert.ok(!existsSync(join(runDir, "run-graceful-session.target")), "cleanup removes the session target sidecar");
assert.ok(isAlive(process.pid), "our own process is obviously untouched");

// 7. The observation seed screenshot reads the task tab over CDP, never through the daemon
//    command channel (which would broadcast a `screenshot` command to every observer).
let cdpPort = 0;
const cdpHttp = createServer((_request, response) => {
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify([{ id: "target-shot", type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/target-shot` }]));
});
const cdpSockets = new WebSocketServer({ server: cdpHttp });
cdpSockets.on("connection", (socket) => socket.on("message", (data) => {
	const message = JSON.parse(data.toString()) as { id: number; method: string };
	if (message.method === "Page.captureScreenshot") socket.send(JSON.stringify({ id: message.id, result: { data: Buffer.from("png").toString("base64") } }));
}));
await new Promise<void>((resolve) => cdpHttp.listen(0, "127.0.0.1", resolve));
cdpPort = (cdpHttp.address() as { port: number }).port;
const shotRegistry = new BrowserSessionRegistry({ namespace, daemonHome, cdpUrl: String(cdpPort), agentBrowserBin: fakeBin });
const shotEnv = shotRegistry.beginRun("goal-shot", "main-run-shot");
writePid(shotEnv.AGENT_BROWSER_SESSION, process.pid);
assert.equal(await shotRegistry.screenshot("goal-shot"), undefined, "no task tab yet: nothing to seed");
writeFileSync(join(runDir, `${shotEnv.AGENT_BROWSER_SESSION}.target`), JSON.stringify({ targetId: "target-shot", pinned: true }));
const shots = await Promise.all([shotRegistry.screenshot("goal-shot"), shotRegistry.screenshot("goal-shot")]);
assert.deepEqual(shots.map((shot) => shot?.toString()), ["png", "png"]);
assert.ok(!existsSync(screenshotLog), "the seed screenshot never runs a daemon screenshot command");
await shotRegistry.endRun("goal-shot", "main-run-shot", "completed");
cdpSockets.close();
cdpHttp.close();

// 8. Host execution accepts a normal command but rejects ownership overrides.
registry.beginRun("goal-exec", "main-run-exec");
await assert.doesNotReject(() => registry.execute("goal-exec", ["open", "https://example.com"]));
assert.equal(registry.observe("goal-exec")?.state, "starting");
await assert.doesNotReject(() => registry.execute("goal-exec", ["scroll", "down", "300"]));
assert.deepEqual(readFileSync(viewportLog, "utf-8").trim().split("\n"), ["set viewport 1280 720"],
	"the task tab gets its CSS viewport pinned once, before the first Agent command");
// Interaction is allowed: the Runtime blocks only what can leak data or take over the browser.
await assert.doesNotReject(() => registry.execute("goal-exec", ["fill", "#status", "close"]));
await assert.doesNotReject(() => registry.execute("goal-exec", ["click", "@e1", "--new-tab"]));
await assert.doesNotReject(() => registry.execute("goal-exec", ["find", "text", "Next", "click"]));
await assert.doesNotReject(() => registry.execute("goal-exec", ["read"]));
// A verification interstitial that clears is waited out and the page is re-read; one that never
// clears is a blocked page with guidance, not page text.
const cleared: Buffer[] = [];
assert.equal((await registry.execute("goal-exec", ["open", "https://example.com/clears"], { onData: (chunk) => cleared.push(chunk) })).exitCode, 0);
assert.match(Buffer.concat(cleared).toString(), /Real Article/u);
assert.doesNotMatch(Buffer.concat(cleared).toString(), /Just a moment/u);
const blockedPage: Buffer[] = [];
assert.equal((await registry.execute("goal-exec", ["open", "https://example.com/blocked"], { onData: (chunk) => blockedPage.push(chunk) })).exitCode, 1);
assert.match(Buffer.concat(blockedPage).toString(), /page_blocked: https:\/\/example\.com\/blocked .*did not clear/u);
await assert.rejects(() => registry.execute("goal-exec", ["eval", "fetch('/write')"]), /blocked: arbitrary JavaScript/u);
await assert.rejects(() => registry.execute("goal-exec", ["upload", "#file", "/etc/passwd"]), /blocked: sending local files/u);
await assert.rejects(() => registry.execute("goal-exec", ["get", "cdp-url"]), /cdp-url is blocked/u);
await assert.rejects(
	() => registry.execute("goal-exec", ["wait", "--fn", "fetch('/write')"]),
	/scripts/u,
);
await assert.rejects(
	() => registry.execute("goal-exec", ["open", "https://example.com", "--init-script", "/tmp/write.js"]),
	/startup configuration|scripts/u,
);
await assert.rejects(
	() => registry.execute("goal-exec", ["wait", "--download", "/tmp/out.pdf"]),
	/downloads/u,
);
// A malformed command comes back with the usage of that command, an unknown one with the list.
await assert.rejects(
	() => registry.execute("goal-exec", ["open", "https://example.com", "--unknown-option"]),
	/takes 1 argument.*Usage: open <http\(s\) url>/u,
);
await assert.rejects(() => registry.execute("goal-exec", ["get", "links"]), /Unsupported Browser get arguments: links\. Usage: get title \| get url/u);
await assert.rejects(() => registry.execute("goal-exec", ["frobnicate"]), /Unknown Browser command 'frobnicate'\. Browser commands: open/u);
let help = "";
await assert.doesNotReject(() => registry.execute("goal-exec", ["help"], { onData: (chunk) => { help += chunk.toString(); } }));
assert.match(help, /Browser commands: open <http\(s\) url>.*Blocked: eval/u);
await assert.rejects(
	() => registry.execute("goal-exec", ["--session", "foreign", "open", "https://example.com"]),
	/Runtime owns the agent-browser session/u,
);
await assert.rejects(() => registry.execute("goal-exec", ["close"]), /blocked: Runtime owns the session lifecycle/u);
await registry.endRun("goal-exec", "main-run-exec", "completed");

// 9. User takeover waits for the current Tool command, blocks new Agent work,
//    and resumes it only after the user explicitly returns control.
const controlEnv = registry.beginRun("goal-control", "main-run-control");
writePid(controlEnv.AGENT_BROWSER_SESSION, process.pid);
const running = registry.execute("goal-control", ["wait", "150"]);
await new Promise((resolve) => setTimeout(resolve, 30));
const handoff = registry.setControl("goal-control", controlEnv.AGENT_BROWSER_SESSION, "user");
assert.equal(registry.observe("goal-control")?.control, "delegating");
await running;
await handoff;
assert.equal(registry.canAcceptUserInput("goal-control", controlEnv.AGENT_BROWSER_SESSION), true);
let resumed = false;
const blocked = registry.execute("goal-control", ["get", "title"]).then(() => { resumed = true; });
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(resumed, false, "Agent Tool waits while the user owns the Browser Session");
await registry.setControl("goal-control", controlEnv.AGENT_BROWSER_SESSION, "agent");
await blocked;
assert.equal(resumed, true);
await registry.setControl("goal-control", controlEnv.AGENT_BROWSER_SESSION, "user");
const cancelled = new AbortController();
const cancelledCommand = registry.execute("goal-control", ["get", "title"], { signal: cancelled.signal });
cancelled.abort();
await assert.rejects(cancelledCommand, /cancel|abort/u);
await registry.setControl("goal-control", controlEnv.AGENT_BROWSER_SESSION, "agent");
await registry.endRun("goal-control", "main-run-control", "completed");

// A dead daemon cannot retain capacity forever. Reopening goes through admission and
// viewport setup again; startup, in-flight commands and user control remain protected.
const recovery = new BrowserSessionRegistry({ namespace, daemonHome, agentBrowserBin: fakeBin, maxConcurrentWorkspaces: 1 });
const dead = recovery.beginRun("dead-owner", "recovery-run");
const starting = recovery.execute("dead-owner", ["wait", "150"]);
assert.equal(await recovery.sweep(), 0, "admission before daemon startup is protected");
await starting;
writePid(dead.AGENT_BROWSER_SESSION, 2_147_483_647);
recovery.beginRun("queued-owner", "queued-run");
const queued = recovery.execute("queued-owner", ["scroll", "down", "1"]);
assert.equal(recovery.config.queuedWorkspaces, 1);
assert.equal(await recovery.sweep(), 1, "finished command with a missing daemon is reclaimed");
await queued;
assert.equal(recovery.envForActiveRun("dead-owner"), undefined);
assert.equal(existsSync(join(runDir, `${dead.AGENT_BROWSER_SESSION}.pid`)), false, "dead daemon sidecars are removed");
assert.equal(recovery.config.activeWorkspaces, 1);
assert.equal(recovery.config.queuedWorkspaces, 0);
const viewportCount = () => readFileSync(viewportLog, "utf8").trim().split("\n").length;
const beforeReopen = viewportCount();
assert.equal(recovery.beginRun("dead-owner", "recovery-run").AGENT_BROWSER_SESSION, dead.AGENT_BROWSER_SESSION);
const reopened = recovery.execute("dead-owner", ["scroll", "down", "1"]);
assert.equal(recovery.config.queuedWorkspaces, 1, "reopened session must reacquire a permit");
assert.equal(viewportCount(), beforeReopen, "queued reopening cannot spawn a daemon");
await recovery.endRun("queued-owner", "queued-run", "completed");
await reopened;
assert.equal(viewportCount(), beforeReopen + 1, "reopened session reapplies the viewport");
await recovery.setControl("dead-owner", dead.AGENT_BROWSER_SESSION, "user");
assert.equal(await recovery.sweep(), 0, "user-controlled tab is preserved even if its daemon died");
await recovery.setControl("dead-owner", dead.AGENT_BROWSER_SESSION, "agent");
const inflight = recovery.execute("dead-owner", ["wait", "900"]);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(await recovery.sweep(), 0, "in-flight command is protected");
const closing = recovery.endTask("dead-owner", "completed");
const duplicateClosing = recovery.endTask("dead-owner", "completed");
const scopeClosing = recovery.endScope("goal:dead-owner", "completed");
assert.throws(() => recovery.beginRun("dead-owner", "recovery-run"), /still closing/u);
assert.equal(recovery.config.activeWorkspaces, 1, "cleanup retains capacity until the command has drained");
const [interrupted] = await Promise.all([inflight, closing, duplicateClosing, scopeClosing]);
assert.equal(interrupted.exitCode, 1, "release cancels a running command before waiting for daemon cleanup");
assert.equal(recovery.config.activeWorkspaces, 0, "duplicate release returns a permit only once");
assert.equal(await recovery.sweep(), 0);

// A daemon that survives teardown remains tracked with its permit, and sweep retries it.
let daemonAlive = true;
const stubborn = new BrowserSessionRegistry({
	namespace, daemonHome, agentBrowserBin: fakeBin, maxConcurrentWorkspaces: 1,
	isProcessAlive: () => daemonAlive, isAgentBrowserProcess: () => true,
});
const stubbornEnv = stubborn.beginRun("stubborn-owner", "stubborn-run");
await stubborn.execute("stubborn-owner", ["scroll", "down", "1"]);
writePid(stubbornEnv.AGENT_BROWSER_SESSION, 2_147_483_647);
writeFileSync(join(runDir, "keep-alive"), "");
await assert.rejects(stubborn.endTask("stubborn-owner", "completed"), /still alive after teardown/u);
assert.equal(existsSync(join(runDir, `${stubbornEnv.AGENT_BROWSER_SESSION}.pid`)), true);
assert.equal(stubborn.config.activeWorkspaces, 1, "failed teardown retains capacity");
assert.throws(() => stubborn.beginRun("stubborn-owner", "stubborn-run"), /awaiting cleanup/u);
stubborn.beginRun("after-stubborn", "after-stubborn-run");
const afterStubborn = stubborn.execute("after-stubborn", ["scroll", "down", "1"]);
assert.equal(stubborn.config.queuedWorkspaces, 1);
daemonAlive = false;
rmSync(join(runDir, "keep-alive"));
assert.equal(await stubborn.sweep(), 1, "sweep retries the failed owner");
await afterStubborn;
assert.equal(existsSync(join(runDir, `${stubbornEnv.AGENT_BROWSER_SESSION}.pid`)), false);
assert.equal(stubborn.config.activeWorkspaces, 1);
await stubborn.endTask("after-stubborn", "completed");
assert.equal(stubborn.config.activeWorkspaces, 0);

console.log("browser-sessions registry: all assertions passed");

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
