import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { primeKernelEnv } from '../../server/agent-runtime/prime-agent-srt.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kernel-owner-')));
const work = join(root, 'work'), runtime = join(root, 'runtime');
mkdirSync(work); mkdirSync(runtime);
const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const env = primeKernelEnv({ cwd: work, readonlyRoots: [], writableRoots: [work], privateRoots: [runtime], env: process.env });
const kernel = spawn(env.PRIME_AGENT_KERNEL_PYTHON!, ['-m', 'rlm.repl'], { cwd: work, env: { ...env, PRIME_AGENT_KERNEL_OWNER_PID: String(owner.pid) }, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
kernel.stderr.on('data', data => stderr += data);
const exited = new Promise(resolve => {
 kernel.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); });
 kernel.once('error', error => { stderr += error.message; exit = { code: 1, signal: null }; resolve(exit); });
});
const lines = createInterface({ input: kernel.stdout });
const events: Array<{ event?: string }> = [];
lines.on('line', line => { try { events.push(JSON.parse(line)); } catch {} });
async function until(condition: () => boolean, label: string) {
 const deadline = Date.now() + 15000;
 while (!condition()) {
  if (exit) throw new Error(`${label}: kernel exited ${JSON.stringify(exit)} ${stderr}`);
  if (Date.now() > deadline) throw new Error(`${label}: timed out ${stderr}`);
  await delay(20);
 }
}
try {
 await until(() => events.some(event => event.event === 'ready'), 'native Kernel ready');
 kernel.stdin.write(JSON.stringify({ type: 'execute', id: 'busy', code: "from pathlib import Path\nimport time\nn=0\nwhile True:\n n+=1\n Path('heartbeat.txt').write_text(str(n))\n time.sleep(0.02)" }) + '\n');
 const heartbeat = join(work, 'heartbeat.txt');
 await until(() => existsSync(heartbeat), 'synchronous code is running');
 assert.equal(owner.kill('SIGKILL'), true, 'Terminate the actual live owner process');
 // Unlike normal EOF handling, parent liveness must stop a synchronous busy cell.
 const deadline = Date.now() + 15000;
 while (!exit && Date.now() < deadline) await delay(20);
 assert.ok(exit, `Kernel survived owner death: ${stderr}`);
 const stopped = readFileSync(heartbeat, 'utf8');
 await delay(150);
 assert.equal(readFileSync(heartbeat, 'utf8'), stopped, 'Kernel code must stop writing after its owner dies');
 console.log(JSON.stringify({ passed: true, ready: true, busyCellStarted: true, ownerKilled: true, heartbeatStopped: true, exit, modelCalls: 0 }));
} finally {
 owner.kill('SIGKILL');
 kernel.kill('SIGTERM');
 if (!exit) await Promise.race([exited, delay(2000)]);
 lines.close();
 rmSync(root, { recursive: true, force: true });
}
