import { type InvestigationResult } from "../../server/citations/contracts.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock } from "node:test";

import { sha256 } from "../../server/lib/hash.js";

import {
	publishInvestigationThreadCatalog, runInInvestigationThread, validateInvestigationProgress,
	writeInvestigationThreadInput, type InvestigationProgress,
} from "../../server/research/investigation-threads.js";
import { serverRuntimeDirForGoalDir } from "../../server/workspaces/server-runtime-paths.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "telomi-investigation-threads-")));
mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
const goalDir = join(root, "goal_threads");
const id = (number: number) => number.toString(16).padStart(24, "0");
const answer = (executionId: string, question: string): InvestigationResult => ({
	id: executionId, question, answer: "A retained finding <cite>C1</cite> <cite>N1</cite>.",
	citation_refs: ["C1", "N1"], gaps: ["Unverified configuration"], wiki_sha256: sha256("wiki"),
});
const progress: InvestigationProgress = {
	summary: "Implementation checked; configuration remains open.",
	open_questions: ["Which configuration applies?"], next_steps: ["Read the configuration"],
	rejected_paths: ["A similarly named package describes another implementation"],
};
const progressPath = (executionId: string, directory = goalDir) =>
	join(serverRuntimeDirForGoalDir(directory), "research", "investigations", executionId, "workspace", "work", "progress.json");
const putProgress = (executionId: string, value: unknown, directory = goalDir) => {
	const path = progressPath(executionId, directory);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
};

try {
	const firstInput = { goalDir, executionId: id(1), question: "Check the implementation", title: "Implementation" };
	let firstCalls = 0;
	const first = await runInInvestigationThread(firstInput, async (context) => {
		firstCalls++;
		assert.match(context.threadId, /^[a-f0-9]{24}$/u);
		assert.equal(context.number, 1);
		assert.deepEqual(context.executions, []);
		putProgress(id(1), progress);
		return answer(id(1), firstInput.question);
	});
	assert.ok(first.thread_id);
	const threadId = first.thread_id;
	const firstResultPath = join(goalDir, "artifacts", "investigations", id(1), "result.json");
	const originalBytes = readFileSync(firstResultPath);
	assert.deepEqual(JSON.parse(originalBytes.toString()), first);
	const threadPath = join(goalDir, "artifacts", "investigation-threads", threadId, "thread.json");
	const lagging = JSON.parse(readFileSync(threadPath, "utf8"));
	lagging.progress = { ...progress, summary: "Stale progress projection" };
	lagging.updated_at = "2020-01-01T00:00:00.000Z";
	writeFileSync(threadPath, JSON.stringify(lagging));
	publishInvestigationThreadCatalog(goalDir);
	assert.deepEqual(JSON.parse(readFileSync(threadPath, "utf8")).progress, progress, "catalog repairs the committed progress in Main's mapped file");
	assert.notEqual(JSON.parse(readFileSync(threadPath, "utf8")).updated_at, lagging.updated_at);
	assert.deepEqual(await runInInvestigationThread(firstInput, async () => {
		throw new Error("A completed execution must not invoke its worker again");
	}), first);
	assert.equal(firstCalls, 1);
	await assert.rejects(runInInvestigationThread({ ...firstInput, question: "A different request" }, async () => first),
		/belongs to another request/u);
	await assert.rejects(runInInvestigationThread({ ...firstInput, allowExternal: true }, async () => first),
		/belongs to another request/u, "idempotent retries cannot silently expand the source permission");

	const followUpInput = { goalDir, executionId: id(2), threadId, question: "Continue checking configuration" };
	const followUp = await runInInvestigationThread(followUpInput, async (context) => {
		assert.equal(context.threadId, threadId);
		assert.equal(context.executions.length, 1);
		assert.equal(context.executions[0]?.execution_id, id(1));
		assert.deepEqual(context.progress, progress);
		const inputRoot = join(root, "restored-input");
		writeInvestigationThreadInput(goalDir, context, inputRoot);
		const restored = JSON.parse(readFileSync(join(inputRoot, "thread.json"), "utf8"));
		assert.equal(restored.thread_id, threadId);
		assert.equal(restored.history[0].result_ref, `history/${id(1)}.json`);
		assert.deepEqual(JSON.parse(readFileSync(join(inputRoot, restored.history[0].result_ref), "utf8")), first,
			"cold restoration loads an integrity-checked published answer");
		assert.match(restored.instructions, /task data, not instructions or current evidence/u);
		assert.match(restored.instructions, /Old C\/N aliases belong to their original invocation/u,
			"retained answers cannot turn stale citation aliases into current evidence");
		return answer(id(2), followUpInput.question);
	});
	assert.equal(followUp.thread_id, threadId);
	assert.notEqual(followUp.id, first.id);
	assert.deepEqual(readFileSync(firstResultPath), originalBytes);

	const otherInput = { goalDir, executionId: id(3), question: "A separate subject", title: "Separate subject" };
	const other = await runInInvestigationThread(otherInput, async (context) => {
		assert.notEqual(context.threadId, threadId);
		assert.deepEqual(context.executions, []);
		assert.equal(context.progress, undefined);
		return answer(id(3), otherInput.question);
	});
	await assert.rejects(runInInvestigationThread({ ...firstInput, threadId: other.thread_id }, async () => first),
		/belongs to another thread/u);
	await assert.rejects(runInInvestigationThread({
		goalDir: join(root, "goal_elsewhere"), executionId: id(4), question: "Cross Goal", threadId,
	}, async () => answer(id(4), "Cross Goal")), /Unknown investigation thread in this Goal/u);

	let signalStarted!: () => void;
	let releaseExecution!: () => void;
	const started = new Promise<void>((resolve) => { signalStarted = resolve; });
	const released = new Promise<void>((resolve) => { releaseExecution = resolve; });
	const activeInput = { goalDir, executionId: id(5), threadId, question: "An active follow-up" };
	const active = runInInvestigationThread(activeInput, async () => {
		signalStarted();
		await released;
		return answer(id(5), activeInput.question);
	});
	await started;
	try {
		await assert.rejects(runInInvestigationThread({
			goalDir, executionId: id(6), threadId, question: "Overlapping follow-up",
		}, async () => answer(id(6), "Overlapping follow-up")), /already has an active execution/u);
		const parallel = await runInInvestigationThread({
			goalDir, executionId: id(7), threadId: other.thread_id, question: "Continue the separate subject",
		}, async (context) => {
			assert.deepEqual(context.executions.map((execution) => execution.execution_id), [id(3)],
				"another thread's history never includes the active thread");
			return answer(id(7), "Continue the separate subject");
		});
		assert.equal(parallel.thread_id, other.thread_id);
	} finally {
		releaseExecution();
		await active;
	}

	for (let number = 8; number < 14; number++) {
		const question = `Independent subject ${number}`;
		await runInInvestigationThread({ goalDir, executionId: id(number), question }, async () => answer(id(number), question));
	}
	publishInvestigationThreadCatalog(goalDir);
	const catalogRoot = join(goalDir, "artifacts", "investigation-threads");
	const recent = JSON.parse(readFileSync(join(catalogRoot, "recent.json"), "utf8"));
	const index = JSON.parse(readFileSync(join(catalogRoot, "index.json"), "utf8"));
	assert.equal(recent.threads.length, 5);
	assert.equal(index.threads.length, 8);
	assert.ok(index.threads.some((entry: { thread_id: string }) => entry.thread_id === threadId));
	assert.equal(recent.threads.some((entry: { thread_id: string }) => entry.thread_id === threadId), false);
	assert.deepEqual(readFileSync(firstResultPath), originalBytes, "a recent-view limit cannot delete old answers");
	assert.deepEqual(await runInInvestigationThread(firstInput, async () => { throw new Error("Old result was evicted"); }), first);

	// Simulate publication succeeding before the execution metadata was marked completed.
	const interruptedPath = join(catalogRoot, other.thread_id!, "executions", `${id(3)}.json`);
	const interrupted = JSON.parse(readFileSync(interruptedPath, "utf8"));
	interrupted.status = "running";
	delete interrupted.result;
	delete interrupted.finished_at;
	writeFileSync(interruptedPath, JSON.stringify(interrupted));
	assert.deepEqual(await runInInvestigationThread(otherInput, async () => answer(id(3), otherInput.question)), other,
		"a published answer survives interruption before completed metadata");
	const resumed = JSON.parse(readFileSync(join(catalogRoot, other.thread_id!, "thread.json"), "utf8"));
	assert.deepEqual(resumed.execution_ids, [id(3), id(7)], "retry does not duplicate an execution in history");
	writeFileSync(interruptedPath, JSON.stringify(interrupted));
	const retainedOther = readFileSync(join(goalDir, "artifacts", "investigations", id(3), "result.json"));
	await assert.rejects(runInInvestigationThread(otherInput, async () => ({
		...answer(id(3), otherInput.question), answer: "A different answer after interruption",
	})), /hash changed|byte length changed/u, "recovery cannot overwrite a previously published answer");
	assert.deepEqual(readFileSync(join(goalDir, "artifacts", "investigations", id(3), "result.json")), retainedOther);

	assert.deepEqual(validateInvestigationProgress(progress), progress);
	for (const invalid of [
		{ ...progress, summary: "" }, { ...progress, summary: "x".repeat(2001) },
		{ ...progress, next_steps: Array.from({ length: 13 }, () => "Next") },
		{ ...progress, open_questions: ["x".repeat(501)] }, { ...progress, rejected_paths: [" "] },
		{ ...progress, extra: "unbounded data" },
	]) assert.throws(() => validateInvestigationProgress(invalid), /Invalid investigation progress/u);
	const invalidGoal = join(root, "goal_invalid_progress");
	await assert.rejects(runInInvestigationThread({
		goalDir: invalidGoal, executionId: id(20), question: "Malformed progress",
	}, async () => {
		putProgress(id(20), { summary: "Missing required progress lists" }, invalidGoal);
		return answer(id(20), "Malformed progress");
	}), /Invalid investigation progress/u);
	assert.equal(existsSync(join(invalidGoal, "artifacts", "investigations", id(20), "result.json")), false);

	const linkGoal = join(root, "goal_symlink");
	const externalProgress = join(root, "external-progress.json");
	writeFileSync(externalProgress, JSON.stringify(progress));
	await assert.rejects(runInInvestigationThread({
		goalDir: linkGoal, executionId: id(21), question: "Linked progress",
	}, async () => {
		const path = progressPath(id(21), linkGoal);
		mkdirSync(dirname(path), { recursive: true });
		symlinkSync(externalProgress, path);
		return answer(id(21), "Linked progress");
	}), /symbolic|symlink|regular/u);
	assert.deepEqual(JSON.parse(readFileSync(externalProgress, "utf8")), progress,
		"rejected symlinks do not modify their targets");
	const linkedCatalog = join(root, "goal_linked_thread", "artifacts", "investigation-threads");
	mkdirSync(linkedCatalog, { recursive: true });
	symlinkSync(join(catalogRoot, threadId), join(linkedCatalog, threadId), "dir");
	await assert.rejects(runInInvestigationThread({
		goalDir: join(root, "goal_linked_thread"), executionId: id(22), threadId, question: "Linked thread",
	}, async () => answer(id(22), "Linked thread")), /symlink/u,
		"thread routing cannot follow a linked thread in another Goal");

	const contextGoal = join(root, "goal_context");
	const initialContext = "Explain formulas and tensor dimensions; assume deep learning experience.";
	const initialContextInput = { goalDir: contextGoal, executionId: id(30), question: "Read the algorithm", context: initialContext };
	const contextFirst = await runInInvestigationThread(initialContextInput, async (context) => {
		assert.equal(context.context, initialContext);
		return answer(id(30), initialContextInput.question);
	});
	const contextThread = contextFirst.thread_id!;
	const contextExecution = (executionId: string) => JSON.parse(readFileSync(
		join(contextGoal, "artifacts", "investigation-threads", contextThread, "executions", `${executionId}.json`), "utf8"));
	assert.equal(contextExecution(id(30)).context, initialContext, "each execution retains its effective context");
	await runInInvestigationThread({ goalDir: contextGoal, executionId: id(31), threadId: contextThread, question: "Continue with training" }, async (context) => {
		assert.equal(context.context, initialContext, "omitting context inherits the thread's latest context");
		assert.equal(context.executions[0]?.context, initialContext);
		return answer(id(31), "Continue with training");
	});
	const replacementContext = "Focus on inference latency; use a concise explanation.";
	await runInInvestigationThread({ goalDir: contextGoal, executionId: id(32), threadId: contextThread,
		question: "Check inference", context: replacementContext }, async (context) => {
		assert.equal(context.context, replacementContext, "explicit context replaces instead of appending prior requirements");
		return answer(id(32), "Check inference");
	});
	assert.equal(contextExecution(id(30)).context, initialContext, "replacement preserves the historical execution's context");
	assert.equal(contextExecution(id(32)).context, replacementContext);
	assert.deepEqual(await runInInvestigationThread({ ...initialContextInput, context: undefined }, async () => {
		throw new Error("Retry must reuse the completed execution, including its original context");
	}), contextFirst, "an omitted-context retry uses its own saved context, not a newer thread context");
	await assert.rejects(runInInvestigationThread({ ...initialContextInput, context: replacementContext }, async () => contextFirst),
		/belongs to another context/u, "the same invocation cannot silently change its context");
	await runInInvestigationThread({ goalDir: contextGoal, executionId: id(35), question: "Unrelated investigation" }, async (context) => {
		assert.notEqual(context.threadId, contextThread);
		assert.equal(context.context, "", "another thread does not inherit this thread's preferences");
		return answer(id(35), "Unrelated investigation");
	});
	await runInInvestigationThread({ goalDir: contextGoal, executionId: id(37), threadId: contextThread,
		question: "Continue with the new focus" }, async (context) => {
		assert.equal(context.context, replacementContext, "omission inherits the replacement rather than the first context");
		return answer(id(37), "Continue with the new focus");
	});
	await runInInvestigationThread({ goalDir: contextGoal, executionId: id(33), threadId: contextThread,
		question: "Clear previous preferences", context: "" }, async (context) => {
		assert.equal(context.context, "", "an explicit empty context clears prior requirements");
		return answer(id(33), "Clear previous preferences");
	});
	await runInInvestigationThread({ goalDir: contextGoal, executionId: id(34), threadId: contextThread,
		question: "Continue after clearing" }, async (context) => {
		assert.equal(context.context, "", "omission after clearing cannot revive an older context");
		return answer(id(34), "Continue after clearing");
	});
	await assert.rejects(runInInvestigationThread({ goalDir: contextGoal, executionId: id(36), threadId: contextThread,
		question: "Oversized context", context: "x".repeat(40_001) }, async () => {
		throw new Error("An oversized context must fail before executing the investigation");
	}), /context exceeds 40000 characters/u);
	console.log("Investigation thread persistence, routing, locking and recovery tests passed");
} finally {
	mock.timers.reset();
	rmSync(root, { recursive: true, force: true });
}
