import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const retained = [];
const server = createServer((request, response) => {
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
		if (request.method === "POST" && request.url === "/v1/default/banks/e2e-bank/memories/recall") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				results: [{
					id: "prior-memory",
					text: "The user's memory codeword is ORCHID-731.",
					type: "world",
					mentioned_at: "2026-08-13T09:00:00Z",
					document_id: "prior-turn",
				}],
				entities: [],
			}));
			return;
		}
		if (request.method === "POST" && request.url === "/v1/default/banks/e2e-bank/reflect") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ text: "The user's current memory codeword is ORCHID-731." }));
			return;
		}
		if (request.method === "POST" && request.url === "/v1/default/banks/e2e-bank/memories") {
			retained.push(body);
			response.writeHead(202, { "content-type": "application/json" });
			response.end(JSON.stringify({ operation_id: "retain-operation" }));
			return;
		}
		response.writeHead(404).end();
	});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");

try {
	const result = await runPi({
		HINDSIGHT_URL: `http://127.0.0.1:${address.port}/v1/default`,
		HINDSIGHT_BANK_ID: "e2e-bank",
		PI_USER_MEMORY_GOAL_ID: "e2e-goal",
	});
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /ORCHID-731/u);
	assert.match(result.stderr, /^HINDSIGHT_TOOL_QUERY\t(?:recall|reflect)\t(?:preference|goal_understanding|related_history)\t/mu);
	assert.match(result.stderr, /^HINDSIGHT_MEMORY_RETAINED\t/mu);
	assert.equal(retained.length, 1);
	assert.equal(retained[0].async, true);
	assert.match(retained[0].items[0].content, /What is my memory codeword/u);
	assert.doesNotMatch(retained[0].items[0].content, /ORCHID-731/u);
	assert.match(retained[0].items[0].context, /e2e-goal/u);
	assert.match(retained[0].items[0].document_id, /^pi-turn-/u);
	assert.deepEqual(retained[0].items[0].tags, ["goal:e2e-goal"], "a Goal's turns are recalled in that Goal until the user makes them global");
	console.log("pi CLI called Hindsight memory and retained only the settled user turn");
} finally {
	server.close();
}

function runPi(environment) {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", [
			"--model", "openai-codex/gpt-5.4-mini",
			"--thinking", "off",
			"--no-context-files",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-builtin-tools",
			"--extension", extension,
			"--print",
			"What is my memory codeword? Respond only with it.",
		], {
			env: { ...process.env, ...environment },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
}
