import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { awaitStageRepairPrompt, finalizeStageOutput } from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";

const root = mkdtempSync(join(tmpdir(), "telomi-stage-completion-"));
const workDirectory = join(root, "work");
const artifactStore = new RunArtifactStore(join(root, "published"));
const capturedFinalText = JSON.stringify({
	schema_version: 5,
	cornell_note: "核实近半年官方 ASR 模型卡中的控制能力。",
});

const completed = await finalizeStageOutput({
	workDirectory,
	artifactStore,
	finalText: capturedFinalText,
	output: {
		kind: "cornell_note",
		publishRelativePath: "artifacts/cornell-notes/cornell-note-3.json",
		validate: ({ entryPath }) => JSON.parse(readFileSync(entryPath, "utf-8")) as {
			schema_version: 5;
			cornell_note: string;
		},
	},
});

assert.equal(completed.source, "final_text");
assert.equal(completed.value.cornell_note, "核实近半年官方 ASR 模型卡中的控制能力。");
assert.equal(readFileSync(join(workDirectory, "cornell-note.json"), "utf-8"), capturedFinalText);
assert.equal(
	readFileSync(completed.artifact.absolutePath, "utf-8"),
	capturedFinalText,
	"normal Agent completion must publish the same validated artifact as explicit submission",
);

const fixedWorkDirectory = join(root, "fixed-work");
mkdirSync(fixedWorkDirectory, { recursive: true });
writeFileSync(join(fixedWorkDirectory, "chapter.md"), "# 已完成章节\n", "utf-8");
const fixedOutput = await finalizeStageOutput({
	workDirectory: fixedWorkDirectory,
	artifactStore,
	finalText: "这段普通结束语不能覆盖固定产物。",
	output: {
		kind: "chapter",
		publishRelativePath: "artifacts/chapters/section-1.md",
		validate: ({ entryPath }) => readFileSync(entryPath, "utf-8"),
	},
});

assert.equal(fixedOutput.source, "fixed_output");
assert.equal(fixedOutput.value, "# 已完成章节\n");
assert.equal(readFileSync(fixedOutput.artifact.absolutePath, "utf-8"), "# 已完成章节\n");

const repairedWorkDirectory = join(root, "repaired-work");
mkdirSync(repairedWorkDirectory, { recursive: true });
writeFileSync(join(repairedWorkDirectory, "cornell-note.json"), "unfinished", "utf-8");
const repairedOutput = await finalizeStageOutput({
	workDirectory: repairedWorkDirectory,
	artifactStore,
	finalText: capturedFinalText,
	output: {
		kind: "cornell_note",
		publishRelativePath: "artifacts/cornell-notes/repaired.json",
		validate: ({ entryPath }) => JSON.parse(readFileSync(entryPath, "utf-8")),
	},
});
assert.equal(repairedOutput.source, "final_text");
assert.deepEqual(repairedOutput.value, JSON.parse(capturedFinalText));
assert.equal(readFileSync(join(repairedWorkDirectory, "cornell-note.json"), "utf-8"), capturedFinalText);

const invalidWorkDirectory = join(root, "invalid-work");
await assert.rejects(
	() => finalizeStageOutput({
		workDirectory: invalidWorkDirectory,
		artifactStore,
		finalText: "任务完成了。",
		output: {
			kind: "cornell_note",
			publishRelativePath: "artifacts/cornell-notes/invalid.json",
			validate: ({ entryPath }) => JSON.parse(readFileSync(entryPath, "utf-8")),
		},
	}),
	/SyntaxError|Unexpected token/u,
	"a normal stop without a valid artifact must remain a Stage failure",
);
assert.equal(existsSync(join(root, "published", "artifacts/cornell-notes/invalid.json")), false);

/**
 * A Stage Agent that is still streaming when Runtime rejects its output, with the
 * SDK semantics that matter here: a prompt without `streamingBehavior` is refused,
 * and a queued follow-up resolves immediately, long before its turn runs.
 */
class StreamingStageSession {
	readonly queued: { text: string; streamingBehavior?: string }[] = [];
	repairTurnFinished = false;
	private streaming = true;
	private resolveIdle!: () => void;
	private readonly idle = new Promise<void>((resolve) => { this.resolveIdle = resolve; });

	async prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void> {
		if (!this.streaming) return;
		if (!options?.streamingBehavior) {
			throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
		}
		this.queued.push({ text, streamingBehavior: options.streamingBehavior });
	}

	async waitForIdle(): Promise<void> {
		if (!this.streaming) return;
		await this.idle;
	}

	finishQueuedRepairTurn(): void {
		this.repairTurnFinished = true;
		this.streaming = false;
		this.resolveIdle();
	}
}

const busySession = new StreamingStageSession();
const neverAccepted = new Promise<void>(() => undefined);
const busyRepair = awaitStageRepairPrompt(busySession, "Repair cornell-note.json", neverAccepted, () => {
	throw new Error("a queued repair turn must not abort the Agent");
});
const beforeRepairTurn = await Promise.race([
	busyRepair.then(() => "settled" as const),
	new Promise<"pending">((resolve) => { setImmediate(() => resolve("pending")); }),
]);
assert.deepEqual(
	busySession.queued,
	[{ text: "Repair cornell-note.json", streamingBehavior: "followUp" }],
	"a repair prompt must queue on a still-processing Agent instead of failing the Stage",
);
assert.equal(beforeRepairTurn, "pending",
	"a queued repair must not count as the Agent's answer before its turn has run");
busySession.finishQueuedRepairTurn();
assert.equal(await busyRepair, "agent_stop");
assert.equal(busySession.repairTurnFinished, true,
	"Stage output is validated again only after the queued repair turn finished");

const stuckSession = new StreamingStageSession();
let abortedAcceptedRepair = false;
let resolveAccepted!: () => void;
const acceptedDuringRepair = new Promise<void>((resolve) => { resolveAccepted = resolve; });
const acceptedRepair = awaitStageRepairPrompt(stuckSession, "Repair cornell-note.json", acceptedDuringRepair, () => {
	abortedAcceptedRepair = true;
});
resolveAccepted();
assert.equal(await acceptedRepair, "accepted");
assert.equal(abortedAcceptedRepair, true,
	"an accepted Stage output must still abort an Agent that is running a queued repair turn");

console.log("Agent stage completion tests passed");
