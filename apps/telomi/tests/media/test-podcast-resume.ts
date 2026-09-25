import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPodcastGenerator } from "../../server/media/products-api.js";
import { MediaProductJobs, type MediaProductJob } from "../../server/media/product-jobs.js";

const root = mkdtempSync(join(tmpdir(), "telomi-podcast-resume-"));
const goalId = "goal_resume";
const cardId = "report";
const goalDir = join(root, goalId);
const report = (text: string) => writeFileSync(join(goalDir, "artifacts", `${cardId}.md`), text);
const runDir = (runId: string) => join(goalDir, ".pi", "runtime", "runs", "podcast-ai", runId);

try {
	mkdirSync(join(goalDir, "artifacts"), { recursive: true });
	const source = "# Report\n\nBody\n";
	report(source);
	// An attempt that finished its Podcast Script and then failed in speech synthesis.
	const failedRun = "20260925000000_abc123";
	mkdirSync(runDir(failedRun), { recursive: true });
	writeFileSync(join(runDir(failedRun), "podcast-generation-brief.json"), JSON.stringify({
		schemaVersion: 1, goalId, resolvedAt: "2026-09-25T00:00:00Z", resolution: "resolved",
		durablePreference: "Concise.", generationInstruction: "Keep it short.", evidenceRefs: [],
	}));
	writeFileSync(join(runDir(failedRun), "written-script.json"), JSON.stringify({
		sourceSha256: createHash("sha256").update(source).digest("hex"),
		written: {
			title: "Report", language: "en", writingMode: "prime-multi-agent", scriptModel: "root/model",
			sourceSections: [{ sectionId: "a", title: "A" }], script: { sections: [{ sectionId: "a", text: "Spoken text." }] },
		},
	}));
	const failedJob: MediaProductJob = {
		jobId: "job_failed", goalId, cardId, status: "failed", startedAt: 1, updatedAt: 1, error: "HTTP 429", runId: failedRun,
	};

	let briefResolutions = 0;
	// Each attempt starts from the persisted failure, as the report card retry after a restart does.
	const attempt = async (generationInstruction?: string) => {
		new MediaProductJobs(root).save({ ...failedJob, updatedAt: Date.now() });
		const generator = createPodcastGenerator(root, {
			resolveGenerationBrief: async () => { briefResolutions++; throw new Error("fresh brief requested"); },
		});
		const job = generator.start({ goalId, cardId, generationInstruction });
		for (let wait = 0; generator.status(goalId, cardId).status === "running" && wait < 500; wait++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return { job, error: generator.status(goalId, cardId).error ?? "" };
	};

	let result = await attempt();
	assert.equal(result.job.runId, failedRun, "a plain retry continues the failed attempt");
	assert.equal(briefResolutions, 0, "the resumed attempt keeps its frozen Brief instead of resolving a new one");
	assert.doesNotMatch(result.error, /fresh brief|Prime|writer/iu, "the finished script is reused, so the failure comes from speech synthesis");

	result = await attempt("Keep it short.");
	assert.equal(result.job.runId, failedRun, "repeating the attempt's own instruction still continues it");

	result = await attempt("Now make it longer.");
	assert.notEqual(result.job.runId, failedRun, "a new instruction needs a new script");
	assert.equal(briefResolutions, 1);

	report("# Report\n\nRevised body\n");
	result = await attempt();
	assert.notEqual(result.job.runId, failedRun, "a changed report needs a new script");
	assert.equal(briefResolutions, 2);
	console.log("podcast resume test passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
