import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptAgentOutput, AgentOutputValidationError } from "../../server/agent-runtime/accept-agent-output.js";

const root = mkdtempSync(join(tmpdir(), "agent-output-acceptance-"));
try {
	const path = join(root, "output.json");
	const turns: Array<{ text: string; repair: boolean }> = [];
	const rejected: Array<{ attempt: number; error: string }> = [];
	const result = await acceptAgentOutput({
		initialPrompt: "Write the output file.",
		promptTurn: async (text, repair) => {
			turns.push({ text, repair });
			if (turns.length === 2) writeFileSync(path, JSON.stringify({ count: "invalid" }));
			if (turns.length === 3) writeFileSync(path, JSON.stringify({ count: 2 }));
		},
		validate: () => {
			const value = JSON.parse(readFileSync(path, "utf8"));
			if (!Number.isInteger(value.count)) throw new Error("output.count must be an integer");
			return value;
		},
		onRejected: (attempt, error) => rejected.push({ attempt, error }),
	});
	assert.deepEqual(result, { count: 2 });
	assert.deepEqual(turns.map(t => t.repair), [false, true, true]);
	assert.match(turns[1]!.text, /ENOENT/u);
	assert.match(turns[2]!.text, /output\.count must be an integer/u);
	assert.deepEqual(rejected.map(r => r.attempt), [1, 2]);

	let attempts = 0;
	await assert.rejects(acceptAgentOutput({ initialPrompt: "Write output.",
		promptTurn: async () => { attempts++; }, validate: () => { throw new Error("Missing required evidence"); },
	}), error => error instanceof AgentOutputValidationError && /after 3 attempts: Missing required evidence/u.test(error.message));
	assert.equal(attempts, 3, "invalid output has a bounded repair loop");
	for (const error of [new Error("model refused: insufficient balance"), new DOMException("Cancelled", "AbortError")]) {
		attempts = 0;
		await assert.rejects(acceptAgentOutput({ initialPrompt: "Write output.",
			promptTurn: async () => { attempts++; throw error; },
			validate: () => assert.fail("transport failure or cancellation must not reach validation"),
		}), actual => actual === error);
		assert.equal(attempts, 1, "provider errors and cancellation do not spend repair turns");
	}
	console.log("Agent file acceptance repairs precise output errors and preserves model/cancellation failures");
} finally { rmSync(root, { recursive: true, force: true }); }
