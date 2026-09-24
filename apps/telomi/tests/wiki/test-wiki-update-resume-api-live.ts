// 用户触发续跑的真实端到端验证：启真后端，读活动流里出现的"继续 Wiki 更新"，
// POST 它给出的 href，再等这次 Wiki 更新真的跑完并发布。全程烧真实 token。
//
//   npm run test:wiki-update-resume-api-live
//
// 使用自包含的 Cornell Note，因此只有一个批次，续跑就是把它跑完。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ActivityProjection } from "../../shared/events/activity-projection.js";
import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { WikiUpdateJobStore } from "../../server/wiki/wiki-update-job.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { validateCornellNotesSnapshot } from "../../server/cornell/contracts.js";
import type { CornellNotesSnapshot } from "../../server/cornell/contracts.js";
import { wikiUpdateArtifactDir, wikiUpdateRecordDir } from "../../server/wiki/update-runner.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOAL_ID = "goal_wiki_resume_api_live";
const RUN_ID = "wiki-resume-api-live";
const GOAL_TEXT = "调研多语言语音生成模型、架构、训练方法与中英文能力。每个资料审核只贡献其能够支持的部分。";
const PORT = Number(process.env.WIKI_RESUME_API_LIVE_PORT ?? 8893);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const output = resolve(process.env.WIKI_RESUME_API_LIVE_OUTPUT?.trim()
	|| join(appRoot, "output", "wiki-update-resume-api-live", new Date().toISOString().replaceAll(":", "-")));
if (existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
const workspaceDir = join(output, "data");
const goalDir = join(workspaceDir, GOAL_ID);
const runDirectory = wikiUpdateArtifactDir(goalDir, RUN_ID);
const controlDirectory = wikiUpdateRecordDir(workspaceDir, GOAL_ID, RUN_ID);
mkdirSync(workspaceDir, { recursive: true });
ensureGoalWorkspace({ goalDir, goalId: GOAL_ID, title: "Wiki Resume API Live" });
mkdirSync(runDirectory, { recursive: true });
mkdirSync(controlDirectory, { recursive: true });
writeFileSync(join(workspaceDir, "goals.json"), `${JSON.stringify([{
	id: GOAL_ID,
	title: "Wiki Resume API Live",
	description: GOAL_TEXT,
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	preview: "",
	messageCount: 0,
	avatar: { head: "tufts", eye: "round", color: "sky" },
	discoveryEnabled: true,
	outputLanguage: "auto",
}], null, 2)}\n`);

// 一次崩掉的 Wiki 更新：任务记录停在 running，没有任何批次凭据。
const cornellNotesArtifact = new RunArtifactStore(runDirectory)
	.publishText(`${JSON.stringify(buildEvidence(), null, 2)}\n`, "artifacts/cornell-notes/evidence.json");
new WikiUpdateJobStore(controlDirectory).start({
	goalId: GOAL_ID,
	runId: RUN_ID,
	goal: GOAL_TEXT,
	goalContext: { title: "Wiki Resume API Live", description: GOAL_TEXT },
	cornellNotes: {
		relative_path: cornellNotesArtifact.relativePath,
		sha256: cornellNotesArtifact.sha256,
		byte_length: cornellNotesArtifact.byteLength,
	},
});
const server = spawn(process.execPath, ["--import", "tsx", join(appRoot, "server", "index.ts")], {
	cwd: appRoot,
	detached: true,
	stdio: ["ignore", "inherit", "inherit"],
	env: {
		...process.env,
		PORT: String(PORT),
		TELOMI_DATA_DIR: workspaceDir,
		TELOMI_START_BROWSER: "false",
		TELOMI_START_AUDIO: "false",
	},
});
try {
	await waitForHealth();
	// 后端启动时应当已经把崩掉的任务收敛成可续跑。
	const job = new WikiUpdateJobStore(controlDirectory).load();
	assert.equal(job?.status, "interrupted", "the backend must recover a crashed Wiki update on boot");

	const projection = await getJson<ActivityProjection>(`/api/goals/${GOAL_ID}/events/activity-projection`);
	const item = [...projection.liveActivities, ...projection.history.items]
		.find((activity) => activity.activityId === `research:${RUN_ID}`);
	assert.ok(item, "the Run must be visible in the Activity projection");
	const action = item.attention?.actions.find((entry) => entry.actionId === `resume-wiki:${RUN_ID}`);
	assert.ok(action, `no Wiki resume action: ${JSON.stringify(item.attention)}`);
	assert.equal(action.enabled, true);
	assert.equal(action.label, "继续 Wiki 更新");
	console.log(JSON.stringify({ phase: "action-visible", href: action.href }, null, 2));

	const accepted = await post(action.href!);
	assert.equal(accepted.status, 202, `resume must be accepted: ${accepted.status}`);
	const duplicate = await post(action.href!);
	assert.equal(duplicate.status, 409, "a running Wiki update must not accept a second trigger");

	const settled = await waitForSettledJob();
	assert.equal(settled.status, "succeeded", settled.message ?? "");
	assert.equal(settled.attempts, 2, "the user-triggered resume counts as another attempt");
	const result = JSON.parse(readFileSync(join(runDirectory, "artifacts", "wiki-update", "result.json"), "utf-8")) as {
		status: string;
		page_count: number;
		usage: { costUsd: number; calls: number };
	};
	assert.equal(result.status, "succeeded");
	const knowledgeRoot = join(goalDir, "wiki", "knowledge");
	const pages = ["concepts", "entities"].flatMap((directory) => existsSync(join(knowledgeRoot, directory))
		? readdirSync(join(knowledgeRoot, directory)).filter((file) => file.endsWith(".md"))
		: []);
	assert.equal(pages.length, result.page_count);
	assert.ok(pages.length > 0, "the resumed Wiki update must publish pages");

	const after = await getJson<ActivityProjection>(`/api/goals/${GOAL_ID}/events/activity-projection`);
	const settledItem = [...after.liveActivities, ...after.history.items]
		.find((activity) => activity.activityId === `research:${RUN_ID}`);
	assert.equal(
		settledItem?.attention?.actions.some((entry) => entry.actionId === `resume-wiki:${RUN_ID}`) ?? false,
		false,
		"a settled Wiki update must stop offering the continue action",
	);
	console.log(JSON.stringify({
		status: "passed",
		output,
		pages: pages.length,
		usage: result.usage,
	}, null, 2));
} finally {
	try {
		process.kill(-server.pid!, "SIGTERM");
	} catch {
		server.kill("SIGTERM");
	}
}

async function waitForHealth(): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			const health = await fetch(`${BASE_URL}/api/health`);
			if (health.ok) return;
		} catch {
			// 后端还没监听，继续等。
		}
		assert.ok(attempt < 120, "the backend never became healthy");
		await delay(1_000);
	}
}

async function waitForSettledJob(): Promise<{ status: string; attempts: number; message?: string }> {
	const jobs = new WikiUpdateJobStore(controlDirectory);
	for (;;) {
		const job = jobs.load();
		assert.ok(job, "the Wiki update job record disappeared");
		if (job.status !== "running") return job;
		await delay(5_000);
	}
}

async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(`${BASE_URL}${path}`);
	assert.ok(response.ok, `GET ${path} failed with ${response.status}`);
	return await response.json() as T;
}

async function post(path: string): Promise<{ status: number }> {
	const response = await fetch(`${BASE_URL}${path}`, { method: "POST" });
	await response.text();
	return { status: response.status };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** 一个稳定、自包含的 Cornell Note，避免测试依赖未跟踪的历史 output。 */
function buildEvidence(): CornellNotesSnapshot {
	return validateCornellNotesSnapshot({
		schema_version: 1,
		snapshot_id: "snapshot:wiki-resume-api-live",
		run_id: RUN_ID,
		pipeline: { id: "pipeline:wiki-resume-api-live", version: "1", sha256: "0".repeat(64) },
		source_bundle_refs: [],
		notes: [{
			note: {
				schema_version: 1,
				source_id: "source:wiki-resume-api-live",
				sections: [{
					section_title: "Multilingual speech generation",
					summary: "The source describes a multilingual speech generation system.",
					cue_notes: [{
						cue: "Language coverage",
						note: "The system supports multilingual speech generation and cross-language synthesis.",
						evidence: [{
							source_path: "document.md",
							content_sha256: "1".repeat(64),
							start_line: 1,
							end_line: 3,
						}],
					}],
				}],
			},
			title: "Multilingual speech generation source",
			canonical_locator: "https://example.test/multilingual-speech-generation",
			provider_id: "test",
			provenance_ref: "fixture:wiki-resume-api-live",
			source_revision_sha256: "0".repeat(64),
			members: [],
		}],
	});
}
