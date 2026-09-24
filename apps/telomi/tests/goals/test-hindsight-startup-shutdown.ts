import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

/** A port nothing listens on now, so the product never collides with a running Telomi. */
async function freePort(): Promise<number> {
	const probe = createServer().listen(0, "127.0.0.1");
	await once(probe, "listening");
	const { port } = probe.address() as { port: number };
	probe.close();
	await once(probe, "close");
	return port;
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

// Real product entrypoint and OS signals, with a deterministic slow local service.
// No Provider or LLM calls: startup cannot advance past its unhealthy memory service.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	test(`startup ${signal} reaps Hindsight and its descendants`, { timeout: 60_000, skip: process.platform === "win32" }, async (context) => {
		const root = mkdtempSync(join(tmpdir(), "telomi-hindsight-startup-"));
		const marker = join(root, "pids.json");
		const executable = join(root, "hindsight-api");
		writeFileSync(executable, `#!${process.execPath}\n` +
			`const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);\n` +
			`require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]));\n` +
			// A graceful stop keeps the server's shutdown open while a repeated signal arrives.
			`process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1000));\n` +
			`setInterval(() => {}, 1000);\n`, { mode: 0o755 });
		// Startup also requires Source readiness; the browser starts on first use, never at startup.
		// Keep both endpoints local and deterministic instead of inheriting a worktree's live services.
		const readyRequests = new Set<string>();
		const health = createServer((req, res) => {
			if (req.url === "/json/version" || req.url === "/v1/health") {
				readyRequests.add(req.url);
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/fixture" }));
			} else { res.writeHead(503); res.end(); }
		});
		health.listen(0, "127.0.0.1");
		await once(health, "listening");
		const address = health.address();
		assert(address && typeof address !== "string");
		const agentDir = join(root, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { local: {
			api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "fixture" }],
		} } }));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "fixture",
			memoryModels: { llm: {}, retain: {}, reflect: {}, consolidation: {} },
			embedding: { memory: { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" } },
		}));
		const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
			cwd: new URL("../../", import.meta.url),
			env: {
				...process.env,
				TELOMI_DATA_DIR: root,
				PORT: String(await freePort()),
				TELOMI_OPERATIONS_PORT: String(await freePort()),
				PI_CODING_AGENT_DIR: join(root, ".pi", "agent"),
				PRIME_AGENT_CODING_AGENT_DIR: join(root, ".pi", "agent"),
				TELOMI_BROWSER_HOST_CDP_URL: `http://127.0.0.1:${address.port}`,
				TELOMI_RESEARCH_SOURCE_BASE_URL: `http://127.0.0.1:${address.port}`,
				TELOMI_RESEARCH_SOURCE_SERVICE_TOKEN: "fixture",
				SOURCE_SERVICE_TWITTER_COOKIE: "fixture",
				SOURCE_SERVICE_HUGGINGFACE_TOKEN: "fixture",
				PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER: "fixture",
				HINDSIGHT_BANK_ID: "startup-shutdown-fixture",
				TELOMI_EVAL_CAPTURE: "0",
				TELOMI_EVAL_INSTANCE: "0",
				TELOMI_HINDSIGHT_AUTOSTART: "1",
				TELOMI_HINDSIGHT_EXECUTABLE: executable,
				HINDSIGHT_URL: `http://127.0.0.1:${address.port}/v1/default`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		server.stdout.on("data", (chunk) => { output += chunk; });
		server.stderr.on("data", (chunk) => { output += chunk; });
		const exited = once(server, "exit", { signal: context.signal });
		void exited.catch(() => undefined);
		let pids: number[] = [];
		try {
			while (!existsSync(marker)) {
				assert(server.exitCode === null && server.signalCode === null, output);
				await delay(25, undefined, { signal: context.signal });
			}
			assert.deepEqual([...readyRequests].sort(), ["/v1/health"], "startup does not contact the browser");
			pids = JSON.parse(readFileSync(marker, "utf8"));
			server.kill(signal);
			// node --watch and the process-group signal deliver it again during shutdown.
			while (!output.includes(`received ${signal}, shutting down`)) await delay(25, undefined, { signal: context.signal });
			server.kill(signal);
			await exited;
			for (let i = 0; i < 40 && pids.some(alive); i++) await delay(25);
			assert.deepEqual(pids.filter(alive), [], `orphaned Hindsight processes after ${signal}: ${output}`);
		} finally {
			server.kill("SIGKILL");
			if (!pids.length && existsSync(marker)) pids = JSON.parse(readFileSync(marker, "utf8"));
			for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
			health.closeAllConnections();
			await new Promise<void>((resolve) => health.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	});
}
