import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import express from "express";
import type { GoalService } from "../../server/goals/service.js";
import { createMediaProductsRouter, createPodcastGenerator } from "../../server/media/products-api.js";
import { MediaProductJobs } from "../../server/media/product-jobs.js";

const goalId = "goal_restart";
const cardId = "report";
if (process.argv[2] === "start") {
	const generator = createPodcastGenerator(process.argv[3]!, {
		// Stop before any model or paid audio call. Pending promises do not keep Node alive.
		resolveGenerationBrief: () => new Promise(() => {}),
	});
	const job = generator.start({ goalId, cardId });
	assert.equal(generator.start({ goalId, cardId }).jobId, job.jobId);
	assert.equal(generator.status(goalId, cardId).status, "running");
	console.log(JSON.stringify(job));
} else {
	const root = mkdtempSync(join(tmpdir(), "telomi-media-restart-"));
	let server: Server | undefined;
	try {
		mkdirSync(join(root, goalId, "artifacts"), { recursive: true });
		writeFileSync(join(root, goalId, "artifacts", `${cardId}.md`), "# Podcast source\n");
		const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "start", root], { encoding: "utf8" });
		assert.equal(child.status, 0, child.stderr);
		const job = JSON.parse(child.stdout.trim());
		const jobPath = join(root, goalId, ".pi/runtime/state/media-products/jobs", `${job.jobId}.json`);
		assert.equal(JSON.parse(readFileSync(jobPath, "utf8")).status, "running");
		// As with Ingestion, one corrupt document must not hide valid tasks.
		writeFileSync(join(dirname(jobPath), "broken.json"), "{");
		writeFileSync(join(dirname(jobPath), "invalid.json"), JSON.stringify({ ...job, jobId: "../escape" }));
		let generationCalls = 0;
		const generator = createPodcastGenerator(root, {
			resolveGenerationBrief: async () => { generationCalls++; throw new Error("Preference resolution failed"); },
		});
		const app = express();
		app.use(createMediaProductsRouter(root, {
			getGoal: (id: string) => id === goalId ? { id } : undefined,
		} as GoalService, generator));
		server = app.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const response = await fetch(`http://127.0.0.1:${address.port}/api/goals/${goalId}/media-products/${cardId}/status`);
		assert.equal(response.status, 200);
		const { podcast } = await response.json();
		assert.equal(podcast.status, "failed");
		assert.equal(podcast.jobId, job.jobId);
		const status = generator.status(goalId, cardId);
		assert.equal(status.status, "failed");
		assert.equal(status.jobId, job.jobId);
		assert.match(status.error!, /重启.*未自动重试/u);
		assert.equal(generationCalls, 0, "restart must not replay generation");
		assert.equal(JSON.parse(readFileSync(jobPath, "utf8")).status, "failed");
		assert.deepEqual(createPodcastGenerator(root).status(goalId, cardId), status);

		// An old episode must not mask an interrupted regeneration.
		const publishOldPodcast = () => {
			mkdirSync(join(root, goalId, ".media-products", cardId), { recursive: true });
			mkdirSync(join(root, goalId, "podcasts", cardId), { recursive: true });
			writeFileSync(join(root, goalId, "podcasts", cardId, "episode.mp3"), "existing audio");
			writeFileSync(join(root, goalId, ".media-products", cardId, "podcast-ai.meta.json"), JSON.stringify({
				bytes: 14, durationSec: 1, generatedAt: "2026-01-01T00:00:00Z", extra: { slug: cardId },
			}));
		};
		publishOldPodcast();
		assert.equal(generator.status(goalId, cardId).status, "failed");
		const retry = generator.start({ goalId, cardId });
		assert.notEqual(retry.jobId, job.jobId);
		assert.equal(existsSync(join(root, goalId, "podcasts", cardId)), false,
			"a regeneration replaces the old Podcast from the moment it starts");
		assert.equal(existsSync(join(root, goalId, ".media-products", cardId, "podcast-ai.meta.json")), false);
		for (let attempt = 0; generator.status(goalId, cardId).status === "running" && attempt < 100; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(generator.status(goalId, cardId).error, "Preference resolution failed");
		assert.equal(generationCalls, 1);
		assert.equal(createPodcastGenerator(root).status(goalId, cardId).error, "Preference resolution failed");
		assert.equal(existsSync(join(root, goalId, "podcasts", cardId)), false, "a failed regeneration leaves no Podcast");
		const jobs = new MediaProductJobs(root);
		publishOldPodcast();
		jobs.save({ ...retry, status: "done" });
		assert.equal(new MediaProductJobs(root).get(goalId, cardId)?.status, "done");
		assert.equal(createPodcastGenerator(root).status(goalId, cardId).status, "done");
		assert.equal(createPodcastGenerator(join(root, "other")).status(goalId, cardId).status, "idle");
		console.log("media product restart persistence passed");
	} finally {
		if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
		rmSync(root, { recursive: true, force: true });
	}
}
