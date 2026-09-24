import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileIngestService } from "../../server/ingestion/service.js";
import { parsedDocumentsEntryDir } from "../../server/workspaces/goal-runtime-paths.js";
import { PARSED_DOCUMENT_FILES } from "../../server/ingestion/parsed-documents.js";

const parsedArtifacts = Object.values(PARSED_DOCUMENT_FILES).slice().sort();
import type { FastApiDocumentParser } from "../../server/research/documents/fastapi-parser.js";
import { canonicalDocumentResponse } from "./canonical-document-stub.js";

const root = mkdtempSync(join(tmpdir(), "telomi-file-ingest-wait-"));
const goalId = "goal-wait";
mkdirSync(join(root, goalId), { recursive: true });

function inputFile(name: string, body: string): string {
	const path = join(root, name);
	writeFileSync(path, body);
	return path;
}

type ParserBehaviour = "ok" | "fail" | "hang";
let behaviour: ParserBehaviour = "ok";
let releaseHang: (() => void) | null = null;
let announceHang: (() => void) | null = null;
const hangEntered = new Promise<void>((resolve) => { announceHang = resolve; });
const parser: FastApiDocumentParser = {
	async parse(request) {
		if (behaviour === "fail") throw new Error("parser refused the document");
		if (behaviour === "hang") {
			announceHang?.();
			await new Promise<void>((resolve) => { releaseHang = resolve; });
		}
		return canonicalDocumentResponse(request, "Parsed attachment body", "doc-wait");
	},
};

const service = new FileIngestService({
	workspaceDir: root,
	listGoalIds: () => [goalId],
	concurrency: 2,
	requestTimeoutMs: 5_000,
	documentParser: parser,
});

try {
	service.start({ resumeQueued: false });

	assert.equal(await service.waitForJob(goalId, "missing", 5), null, "an unknown job resolves as not found");

	// Success: the waiter observes the terminal job the queue produced.
	const okPath = inputFile("ok.html", "<h1>Parsed attachment body</h1>");
	const ok = await service.enqueue(goalId, { inputPath: okPath });
	assert.equal(ok.status, "queued");
	const okDone = await service.waitForJob(goalId, ok.id);
	assert.equal(okDone?.status, "done");
	assert.ok(okDone?.result?.markdownPath, "a done job carries its parsed result");

	// The mounted mirror holds the parsed artifacts only: the raw original never reaches the sandbox.
	const mirrorDir = parsedDocumentsEntryDir(join(root, goalId), ok.cacheKey);
	assert.deepEqual(readdirSync(mirrorDir).sort(), parsedArtifacts);

	// Cache hit: the job is already terminal at enqueue time, so waiting returns without a queue round trip.
	const cached = await service.enqueue(goalId, { inputPath: okPath });
	assert.equal(cached.status, "done");
	const cachedDone = await service.waitForJob(goalId, cached.id, 0);
	assert.equal(cachedDone?.status, "done", "a cache hit resolves even with no time budget");
	rmSync(mirrorDir, { recursive: true, force: true });
	await service.enqueue(goalId, { inputPath: okPath });
	assert.deepEqual(readdirSync(mirrorDir).sort(), parsedArtifacts,
		"a cache hit republishes the mirror without re-parsing");

	// Failure: attempts are exhausted and the waiter sees the error terminal state, not an exception.
	behaviour = "fail";
	const failing = await service.enqueue(goalId, { inputPath: inputFile("fail.html", "<h1>fail</h1>") });
	const failed = await service.waitForJob(goalId, failing.id);
	assert.equal(failed?.status, "error");
	assert.match(failed?.error ?? "", /parser refused the document/u);

	// Timeout: a non-terminal job is returned as-is and the queue keeps the job.
	behaviour = "hang";
	const hangJob = await service.enqueue(goalId, { inputPath: inputFile("hang.html", "<h1>hang</h1>") });
	await hangEntered;
	const timedOut = await service.waitForJob(goalId, hangJob.id, 20);
	assert.ok(timedOut && timedOut.status !== "done" && timedOut.status !== "error", "a timeout returns the non-terminal job");
	assert.equal(timedOut?.id, hangJob.id);

	// Later work still runs while the earlier job hangs.
	behaviour = "ok";
	const parallel = await service.enqueue(goalId, { inputPath: inputFile("parallel.html", "<h1>parallel</h1>") });
	assert.equal((await service.waitForJob(goalId, parallel.id))?.status, "done", "one hanging job must not block the queue");

	// Stop releases waiters instead of hanging them until the timeout.
	const stopWait = service.waitForJob(goalId, hangJob.id, 60_000);
	service.stop();
	const released = await stopWait;
	assert.equal(released?.id, hangJob.id, "stop releases pending waiters");
	assert.ok(released && !["done", "error"].includes(released.status), "a released waiter reports the job as unfinished");

	// A service that has not started yet still waits: only stop() releases early.
	const unstarted = new FileIngestService({ workspaceDir: root, listGoalIds: () => [goalId], documentParser: parser });
	const beforeStart = await unstarted.enqueue(goalId, { inputPath: inputFile("unstarted.html", "<h1>unstarted</h1>") });
	const startedAt = Date.now();
	assert.equal((await unstarted.waitForJob(goalId, beforeStart.id, 30))?.status, "queued");
	assert.ok(Date.now() - startedAt >= 25, "a queued job waits for its timeout instead of returning at once");

	console.log("file ingest terminal-state wait tests passed");
} finally {
	releaseHang?.();
	service.stop();
	rmSync(root, { recursive: true, force: true });
}
