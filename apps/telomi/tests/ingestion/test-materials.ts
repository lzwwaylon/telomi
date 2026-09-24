import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileIngestJobsDir } from "../../server/workspaces/goal-runtime-paths.js";
import { FileIngestService } from "../../server/ingestion/service.js";
import type { FastApiDocumentParser } from "../../server/research/documents/fastapi-parser.js";
import { canonicalDocumentResponse } from "./canonical-document-stub.js";

const root = mkdtempSync(join(tmpdir(), "telomi-file-materials-"));
const previousIngestFlag = process.env.TELOMI_FILE_INGEST_ENABLED;
process.env.TELOMI_FILE_INGEST_ENABLED = "0";
const goalId = "goal-materials";
mkdirSync(join(root, goalId), { recursive: true });
const htmlPath = join(root, "page.html");
const audioPath = join(root, "speech.wav");
writeFileSync(htmlPath, "<h1>Captured page</h1><p>Browser evidence.</p>");
writeFileSync(audioPath, "RIFF-fake-audio");

const parserInputs: Array<{ inputPath: string; contentType?: string; sourceName?: string }> = [];
const parser: FastApiDocumentParser = {
	async parse(request) {
		parserInputs.push({ inputPath: request.inputPath, contentType: request.contentType, sourceName: request.sourceName });
		if ((request.sourceName?.length ?? 0) > 512) throw new Error("source_name exceeds the document API's 512 character limit");
		const text = request.contentType === "application/vnd.pi.timed-transcript+json"
			? "Transcribed browser audio"
			: "Captured page Browser evidence.";
		return canonicalDocumentResponse(request, text);
	},
};

// Shared env parsing retains ingestion's positive-number and flooring policy.
for (const [name, property, fallback] of [
	["TELOMI_FILE_INGEST_CONCURRENCY", "concurrency", 2],
	["TELOMI_FILE_INGEST_MAX_BYTES", "maxBytes", 50 * 1024 * 1024],
	["TELOMI_FILE_INGEST_TIMEOUT_MS", "requestTimeoutMs", 90_000],
] as const) {
	const previous = process.env[name];
	try {
		for (const [raw, expected] of [["", fallback], ["  ", fallback], ["0", fallback], ["-1", fallback], ["Infinity", fallback], ["4.9", 4], ["0.5", 0]] as const) {
			process.env[name] = raw;
			const configured = new FileIngestService({ workspaceDir: root, listGoalIds: () => [], documentParser: parser });
			assert.equal(configured.config[property], expected, `${name}=${JSON.stringify(raw)}`);
		}
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

let audioReady = false;
const service = new FileIngestService({
	workspaceDir: root,
	listGoalIds: () => [goalId],
	documentParser: parser,
	prepareAudio: async () => { audioReady = true; },
	transcribeAudio: async () => ({
		ok: true,
		provider: "telomi-audio",
		model: "test-asr",
		text: "Transcribed browser audio",
		language: "en",
		durationSec: 2,
		segments: [{ start: 0, end: 2, text: "Transcribed browser audio" }],
		words: [],
	}),
});

try {
	const previousService = new FileIngestService({ workspaceDir: root, listGoalIds: () => [goalId], documentParser: parser });
	const pending = await previousService.enqueue(goalId, {
		inputPath: htmlPath,
		key: "material-key",
		source: "attachment",
		title: "Pending attachment",
		requestedBy: "user",
	});
	assert.equal(pending.status, "queued");
	assert.equal(service.readJob(goalId, "missing"), null);
	const jobsDir = fileIngestJobsDir(join(root, goalId));
	for (const [id, raw] of [["broken", "{"], ["invalid", '{"version":1,"id":"invalid"}'], ["null", "null"]] as const) {
		writeFileSync(join(jobsDir, `${id}.json`), raw);
		assert.equal(service.readJob(goalId, id), null);
	}
	assert.deepEqual(service.listJobs(goalId).map((job) => job.id), [pending.id], "bad jobs must not hide a valid queued job");
	for (const field of ["kind", "absInputPath", "cacheKey", "createdAt", "updatedAt", "attempts", "maxAttempts"] as const) {
		const incomplete = { ...pending, id: `missing-${field}`, [field]: undefined };
		writeFileSync(join(jobsDir, `${incomplete.id}.json`), JSON.stringify(incomplete));
		assert.equal(service.readJob(goalId, incomplete.id), null, `missing ${field} must not be fabricated`);
	}
	assert.deepEqual(service.listJobs(goalId).map((job) => job.id), [pending.id]);
	const roundtrip = service.readJob(goalId, pending.id);
	assert.deepEqual(roundtrip, { ...pending, startedAt: undefined, finishedAt: undefined, error: undefined });

	service.start({ resumeQueued: false });
	const html = await service.enqueue(goalId, { inputPath: htmlPath });
	const htmlDone = await waitDone(service, goalId, html.id);
	assert.equal(htmlDone.status, "done");
	assert.ok(htmlDone.result?.markdownPath && existsSync(htmlDone.result.markdownPath));
	assert.match(readFileSync(htmlDone.result!.markdownPath!, "utf-8"), /Captured page Browser evidence/u);
	assert.equal(service.readJob(goalId, pending.id)?.status, "queued",
		"Eval startup must not resume disk jobs, but explicit material conversion must work");
	assert.equal(parserInputs.length, 1);

	const audio = await service.enqueue(goalId, { inputPath: audioPath, title: "Speech attachment" });
	const audioDone = await waitDone(service, goalId, audio.id);
	assert.equal(audioDone.status, "done");
	assert.equal(audioReady, true);
	assert.match(readFileSync(audioDone.result!.markdownPath!, "utf-8"), /Transcribed browser audio/u);
	assert.equal(parserInputs.at(-1)?.contentType, "application/vnd.pi.timed-transcript+json");
	const timed = JSON.parse(readFileSync(parserInputs.at(-1)!.inputPath, "utf-8")) as { schema_name?: string; segments?: unknown[] };
	assert.equal(timed.schema_name, "TimedTranscript");
	assert.equal(timed.segments?.length, 1);

	// Outer Evolution + inner Replay creates paths beyond 512 characters.
	const nested = join(root, ...Array.from({ length: 6 }, () => `nested-${"a".repeat(80)}`));
	mkdirSync(nested, { recursive: true });
	const nestedHtml = join(nested, "retained-page.html");
	assert.ok(nestedHtml.length > 512);
	writeFileSync(nestedHtml, "<h1>Real retained page</h1>");
	const nestedJob = await service.enqueue(goalId, { inputPath: nestedHtml });
	const nestedDone = await waitDone(service, goalId, nestedJob.id);
	assert.equal(nestedDone.status, "done", nestedDone.error);
	assert.equal(parserInputs.at(-1)?.sourceName, "retained-page.html");
	assert.equal(nestedDone.absInputPath, nestedHtml, "retain the original path in job provenance");
	service.stop();
	const restarted = new FileIngestService({ workspaceDir: root, listGoalIds: () => [goalId], documentParser: parser });
	try {
		restarted.start();
		assert.equal((await waitDone(restarted, goalId, pending.id)).status, "done", "restart resumes persisted jobs despite corrupt siblings");
	} finally {
		restarted.stop();
	}
	console.log("file ingest HTML and audio material tests passed");
} finally {
	if (previousIngestFlag === undefined) delete process.env.TELOMI_FILE_INGEST_ENABLED;
	else process.env.TELOMI_FILE_INGEST_ENABLED = previousIngestFlag;
	service.stop();
	rmSync(root, { recursive: true, force: true });
}

async function waitDone(service: FileIngestService, goal: string, jobId: string) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const job = service.readJob(goal, jobId);
		if (job?.status === "done" || job?.status === "error") return job;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("File ingest did not settle");
}
