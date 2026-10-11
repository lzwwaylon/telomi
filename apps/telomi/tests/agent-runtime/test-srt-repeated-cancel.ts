import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createSrtAgentSandbox } from "../../server/agent-runtime/srt-agent-sandbox.js";

const fixture = realpathSync(mkdtempSync(join(tmpdir(), "srt-repeated-cancel-")));
const preload = join(fixture, "signal-window.mjs");
// Enlarge the real handler-entry race without changing Runtime code or SDK signal handlers.
writeFileSync(preload, `
import { writeSync } from "node:fs";
const originalOnce = process.once, originalOn = process.on, originalOff = process.off;
const wrapped = new WeakMap();
let armed = true;
const wrap = listener => {
  const handler = function(...args) {
    if (armed) {
      armed = false;
      writeSync(2, "[srt-cancel-window] terminate entered\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
    return listener.apply(this, args);
  };
  wrapped.set(listener, handler);
  return handler;
};
process.once = function(event, listener) {
  return originalOnce.call(this, event, event === "SIGTERM" && listener.name === "terminate" ? wrap(listener) : listener);
};
process.on = function(event, listener) {
  return originalOn.call(this, event, event === "SIGTERM" && listener.name === "terminate" ? wrap(listener) : listener);
};
process.off = function(event, listener) {
  return originalOff.call(this, event, event === "SIGTERM" ? wrapped.get(listener) ?? listener : listener);
};
`);
const processes = () => childProcess.execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8" })
	.trim().split("\n").map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line)).filter(match => match !== null)
	.map(match => ({ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), state: match[4]!, command: match[5]! }));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) {
	if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
	throw error;
} };
const originalSpawn = childProcess.spawn;
let runner: ChildProcess | undefined;
const currentRunner = (): ChildProcess | undefined => runner;
let duplicate = false;
let entered = false;
let secondSent = false;
childProcess.spawn = new Proxy(originalSpawn, { apply(target, thisArg, args) {
	const [command, argv, options] = args;
	const isRunner = Array.isArray(argv) && typeof argv[0] === "string" && basename(argv[0]) === "srt-runner.mjs";
	const child: ChildProcess = Reflect.apply(target, thisArg, isRunner ? [command, ["--import", preload, ...argv], options] : args);
	if (isRunner) {
		runner = child;
		let stderr = "";
		child.stderr?.on("data", chunk => {
			stderr += String(chunk);
			if (!entered && stderr.includes("[srt-cancel-window] terminate entered")) {
				entered = true;
				if (duplicate) secondSent = child.kill("SIGTERM");
			}
		});
	}
	return child;
} });
syncBuiltinESMExports();
try {
	for (duplicate of [false, true]) {
		runner = undefined; entered = false; secondSent = false;
		const work = join(fixture, duplicate ? "double" : "single");
		mkdirSync(work);
		const sandbox = createSrtAgentSandbox({ id: "repeated-cancel", role: "report.note_agent", workDirectory: work,
			activeTools: ["bash"], network: "deny", readonlyMounts: [] });
		const bash = sandbox.tools.find(tool => tool.name === "bash")!;
		const signal = new AbortController().signal;
		const running = bash.execute("cancel-probe", { command: "printf ready > ready; sleep 120" }, signal).catch(error => error);
		let owned: number[] = [];
		try {
			const startDeadline = Date.now() + 10_000;
			while (!existsSync(join(work, "ready"))) {
				assert.ok(Date.now() < startDeadline, "real SRT shell must start before cancellation");
				await delay(10);
			}
			const active = currentRunner();
			assert.ok(active?.pid);
			const before = processes();
			const descendants = new Set([active.pid]);
			let size: number;
			do {
				size = descendants.size;
				for (const item of before) if (descendants.has(item.parent)) descendants.add(item.pid);
			} while (descendants.size !== size);
			owned = [...descendants];
			assert.ok(before.some(item => descendants.has(item.pid) && item.command.includes("srt-target.mjs")));
			assert.ok(before.some(item => descendants.has(item.pid) && item.command === "sleep 120"));
			const exited = new Promise<void>(done => active.once("exit", () => done()));
			assert.ok(active.kill("SIGTERM"));
			let deadline: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([exited, new Promise<never>((_resolve, reject) => {
					deadline = setTimeout(() => reject(new Error("SRT runner did not exit after cancellation")), 5_000);
					deadline.unref();
				})]);
			} finally { if (deadline) clearTimeout(deadline); }
			assert.ok(entered, "the test widened the actual Runtime terminate callback, not an SDK handler");
			assert.equal(secondSent, duplicate);
			const reapDeadline = Date.now() + 5_000;
			while (owned.some(alive) && Date.now() < reapDeadline) await delay(25);
			const remaining = owned.filter(alive);
			assert.deepEqual(remaining, [], `${duplicate ? "Repeated" : "Single"} SIGTERM must retain control until all SRT descendants exit: ${JSON.stringify(processes().filter(item => remaining.includes(item.pid)))}`);
			await running;
		} finally {
			// A failing regression must not leave its observed detached targets behind.
			const active = currentRunner();
			if (active?.pid) {
				const snapshot = processes(), descendants = new Set([...owned, active.pid]);
				let size: number;
				do {
					size = descendants.size;
					for (const item of snapshot) if (descendants.has(item.parent)) descendants.add(item.pid);
				} while (descendants.size !== size);
				owned = [...descendants];
			}
			for (const pid of owned) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } }
			await running;
			await sandbox.close();
		}
	}
	console.log("Real SRT single and repeated SIGTERM retain cleanup ownership and leave no descendant process");
} finally {
	childProcess.spawn = originalSpawn;
	syncBuiltinESMExports();
	rmSync(fixture, { recursive: true, force: true });
}
