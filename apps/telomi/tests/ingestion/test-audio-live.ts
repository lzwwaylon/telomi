import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FileIngestService } from "../../server/ingestion/service.js";
import { loadProjectEnvironment } from "../../server/config/environment.js";
import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";
import { getAudioLocalRuntimeManager } from "../../server/audio/local-runtime.js";
import { defaultSttConnection } from "../../server/audio/providers/stt.js";

import { requireAudioFixture } from "../voice/audio-fixture.js";

const fixture = resolve(import.meta.dirname, "../../voice-evals/generated/v1/librispeech-weak-onset-v1.wav");
await requireAudioFixture(fixture);
loadProjectEnvironment(resolve(import.meta.dirname, "../.."));
const root = mkdtempSync(join(tmpdir(), "telomi-file-audio-live-"));
const goalId = "goal-audio-live";
mkdirSync(join(root, goalId), { recursive: true });
const audioVenvLink = resolve(import.meta.dirname, "../../../telomi-audio-local/.venv");
const hadAudioVenvLink = existsSync(audioVenvLink);
const expectedConnection = defaultSttConnection();
const service = new FileIngestService({ workspaceDir: root, listGoalIds: () => [goalId] });

try {
	service.start();
	const queued = await service.enqueue(goalId, { inputPath: fixture, title: "Browser audio material" });
	const job = await waitDone(service, goalId, queued.id);
	assert.equal(job.status, "done", job.error);
	assert.equal(job.result?.contentType, "application/vnd.pi.timed-transcript+json");
	assert.ok(job.result?.markdownPath && existsSync(job.result.markdownPath));
	const markdown = readFileSync(job.result.markdownPath, "utf-8").trim();
	assert.ok(markdown.length > 20, "real audio transcript Markdown is unexpectedly short");
	assert.equal(job.result.parseMetadata.transcriptionProvider, expectedConnection);
	console.log(JSON.stringify({
		event: "file_ingest_audio_succeeded",
		parser: job.result.parser,
		provider: job.result.parseMetadata.transcriptionProvider,
		model: job.result.parseMetadata.transcriptionModel,
		markdown,
	}, null, 2));
} finally {
	service.stop();
	await getAudioLocalRuntimeManager().close();
	await getResearchSourceServiceManager().close();
	if (!hadAudioVenvLink) rmSync(audioVenvLink, { force: true });
	rmSync(root, { recursive: true, force: true });
}

async function waitDone(service: FileIngestService, goal: string, jobId: string) {
	const current = service.readJob(goal, jobId);
	if (!current || current.status === "done" || current.status === "error") return current!;
	return new Promise<NonNullable<typeof current>>((resolveDone) => {
		const unsubscribe = service.subscribe((event) => {
			if (event.goalId !== goal || event.jobId !== jobId
				|| (event.type !== "finished" && event.type !== "failed")) return;
			unsubscribe();
			resolveDone(service.readJob(goal, jobId)!);
		});
		const latest = service.readJob(goal, jobId);
		if (latest?.status === "done" || latest?.status === "error") {
			unsubscribe();
			resolveDone(latest);
		}
	});
}
